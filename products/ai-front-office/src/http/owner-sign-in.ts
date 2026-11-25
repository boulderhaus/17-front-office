import { createHmac, createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { clientForNewConnections } from "../adapters/google-oauth-clients.js";
import { formatEmailBody } from "../adapters/resend.js";
import { renderOwnerLogin, renderSignInLinkConfirm, renderSignInLinkSent, type LoginPageOptions, type SignInProviders, type VerifiedSignupEmail } from "../admin/render.js";
import { withTimeout } from "../application/retry.js";
import type { Environment } from "../config/environment.js";
import type { OwnerAccount } from "../domain/models.js";
import type { Clock, Store } from "../ports.js";
import { createSignInLinkToken, hashSignInLinkToken, isPasswordless, mintOwnerSession, ownerSessionCookie, PASSWORDLESS_HASH, SIGN_IN_LINK_OUTBOX_TENANT } from "../security/owner-auth.js";
import { HttpError, isCrossSiteFormPost, parseForm, readBody, readCookie, redirect, sendHtml, type RateLimiter } from "./security.js";

/**
 * Owner sign-in without a password: "Continue with Google", "Continue with Microsoft" and "Email me a sign-in link".
 * Each ends the same way: a verified email with an account gets the normal owner session; a new email goes to
 * sign-up with that email locked (a short-lived signed cookie) and no password to make up.
 */

/** Google only knows this redirect URI (the calendar-connect callback), so sign-in shares it; its own state routes it. */
export const GOOGLE_SIGN_IN_CALLBACK = "/app/integrations/google/callback";
export const MICROSOFT_SIGN_IN_CALLBACK = "/auth/microsoft/callback";
/** Personal Microsoft accounts: Microsoft verifies the address, unlike a work tenant's admin-set email. */
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const STATE_PREFIX = "signin.";
const ATTEMPT_TTL_MS = 10 * 60_000;
const PENDING_TTL_MS = 30 * 60_000;
const LINK_TTL_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 2 * 60_000;
const PENDING_COOKIE = "afo_pending_identity";
/** Set when the emailed link is opened; the tap must come from that same browser. */
const LINK_COOKIE = "afo_sign_in_link";
const LINK_TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
const emailSchema = z.string().trim().toLowerCase().email().max(254);

export type IdentityProvider = "google" | "microsoft";
export interface VerifiedIdentity { provider: IdentityProvider | "email"; email: string; name: string | null }

interface ProviderConfig {
  name: IdentityProvider;
  label: string;
  cookie: string;
  cookiePath: string;
  callbackPath: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  client: { id: string; secret: string } | null;
}

export interface SignInDependencies {
  env: Environment;
  store: Store;
  clock: Clock;
  fetcher: typeof fetch;
  limiter: RateLimiter;
  log: (entry: Record<string, unknown>) => void;
}

class SignInError extends Error {
  constructor(readonly status: number, message: string, readonly reason: string) {
    super(message);
  }
}

/** A same-origin path inside the owner app, or null. Anything else (other hosts, //, backslashes) is dropped. */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || value.length > 300 || !value.startsWith("/app") || value.includes("//") || /[\\\s\u0000-\u001f]/.test(value)) return null;
  const parsed = new URL(value, "https://next.invalid");
  if (parsed.origin !== "https://next.invalid" || !/^\/app(?:\/|$)/.test(parsed.pathname)) return null;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Facebook, Instagram and TikTok open links in their own in-app browser, where Google refuses to sign anyone in
 * (disallowed_useragent) and never sends them back. The Google button is hidden there; the email link still works.
 */
export function isInAppBrowser(userAgent: string | undefined): boolean {
  return /\b(?:FBAN|FBAV|FB_IAB|Instagram|BytedanceWebview)\b|musical_ly|; wv\)/.test(userAgent ?? "");
}

/** A Google callback that belongs to sign-in (not calendar connect) carries a sign-in state. */
export function isSignInState(state: string | null): boolean {
  return state?.startsWith(STATE_PREFIX) === true;
}

export function createOwnerSignIn(deps: SignInDependencies) {
  const { env, store, clock, limiter, log } = deps;
  const key = env.SESSION_SIGNING_KEY!;
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const emailEnabled = Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL);
  const google = clientForNewConnections(env);
  const providers: Record<IdentityProvider, ProviderConfig> = {
    google: {
      name: "google", label: "Google", cookie: "afo_google_signin", cookiePath: "/app/integrations/google", callbackPath: GOOGLE_SIGN_IN_CALLBACK,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
      client: google ? { id: google.id, secret: google.secret } : null,
    },
    microsoft: {
      name: "microsoft", label: "Microsoft", cookie: "afo_microsoft_signin", cookiePath: "/auth/microsoft", callbackPath: MICROSOFT_SIGN_IN_CALLBACK,
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      jwksUrl: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
      client: env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET ? { id: env.MICROSOFT_CLIENT_ID, secret: env.MICROSOFT_CLIENT_SECRET } : null,
    },
  };
  const jwks = new JwksCache(deps.fetcher);
  const sign = (purpose: string, value: string): string => createHmac("sha256", key).update(`${purpose}:${value}`).digest("base64url");

  /** The buttons this browser can use: none for a provider without an app registration, no Google in an in-app browser. */
  const providersFor = (request: IncomingMessage): SignInProviders => ({
    google: Boolean(providers.google.client) && !isInAppBrowser(request.headers["user-agent"]),
    microsoft: Boolean(providers.microsoft.client),
  });
  const loginOptions = (request: IncomingMessage, extra: LoginPageOptions = {}): LoginPageOptions => ({ ...providersFor(request), emailLink: emailEnabled, ...extra });
  const loginPage = (request: IncomingMessage, response: ServerResponse, status: number, error: string, extra: LoginPageOptions = {}): void =>
    sendHtml(response, status, renderOwnerLogin(error, loginOptions(request, extra)));
  /** Only point at the email link when this server can send one. */
  const retryMessage = (label: string): string => `${label} sign-in didn’t work. ${emailEnabled ? "Try again, or use the email link." : "Try again."}`;
  const otherWayIn = emailEnabled ? "Use the email link instead." : "Try another way in.";
  const linkCookie = (value: string, maxAgeSeconds: number): string => `${LINK_COOKIE}=${value}; Path=/login/link; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;

  function startAttempt(provider: ProviderConfig, next: string | null): { state: string; nonce: string; challenge: string; cookie: string } {
    const payload = b64(JSON.stringify({ p: provider.name, r: randomBytes(18).toString("base64url"), x: clock.now().getTime() + ATTEMPT_TTL_MS }));
    const state = `${STATE_PREFIX}${payload}.${sign(`owner-sign-in:${provider.name}`, payload)}`;
    const verifier = randomBytes(32).toString("base64url");
    const nonce = randomBytes(18).toString("base64url");
    const value = b64(JSON.stringify({ s: state, v: verifier, n: nonce, next }));
    return {
      state, nonce,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      cookie: `${provider.cookie}=${value}; Path=${provider.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${ATTEMPT_TTL_MS / 1_000}${secure}`,
    };
  }

  /** The verifier, nonce and landing page of an attempt whose state and cookie both check out; null otherwise. */
  function readAttempt(provider: ProviderConfig, state: string | null, cookie: string | undefined): { verifier: string; nonce: string; next: string | null } | null {
    if (!state?.startsWith(STATE_PREFIX) || !cookie) return null;
    const [payload, signature, extra] = state.slice(STATE_PREFIX.length).split(".");
    if (!payload || !signature || extra !== undefined || !same(signature, sign(`owner-sign-in:${provider.name}`, payload))) return null;
    const stateData = parseJson(payload) as { p?: unknown; x?: unknown } | null;
    const cookieData = parseJson(cookie) as { s?: unknown; v?: unknown; n?: unknown; next?: unknown } | null;
    if (!stateData || stateData.p !== provider.name || typeof stateData.x !== "number" || stateData.x <= clock.now().getTime()) return null;
    if (!cookieData || typeof cookieData.s !== "string" || !same(cookieData.s, state) || typeof cookieData.v !== "string" || typeof cookieData.n !== "string") return null;
    return { verifier: cookieData.v, nonce: cookieData.n, next: safeNext(typeof cookieData.next === "string" ? cookieData.next : null) };
  }

  const clearAttempt = (provider: ProviderConfig): string => `${provider.cookie}=; Path=${provider.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;

  function pendingIdentityCookie(identity: VerifiedIdentity): string {
    const payload = b64(JSON.stringify({ p: identity.provider, e: identity.email, n: identity.name, x: clock.now().getTime() + PENDING_TTL_MS }));
    return `${PENDING_COOKIE}=${payload}.${sign("owner-pending-identity", payload)}; Path=/signup; HttpOnly; SameSite=Lax; Max-Age=${PENDING_TTL_MS / 1_000}${secure}`;
  }

  /** The verified email waiting for sign-up in this browser, if it is still fresh. */
  function pendingIdentity(request: IncomingMessage): VerifiedIdentity | null {
    const [payload, signature, extra] = (readCookie(request, PENDING_COOKIE) ?? "").split(".");
    if (!payload || !signature || extra !== undefined || !same(signature, sign("owner-pending-identity", payload))) return null;
    const data = parseJson(payload) as { p?: unknown; e?: unknown; n?: unknown; x?: unknown } | null;
    if (!data || (data.p !== "google" && data.p !== "microsoft" && data.p !== "email") || typeof data.x !== "number" || data.x <= clock.now().getTime()) return null;
    const email = emailSchema.safeParse(data.e);
    if (!email.success) return null;
    return { provider: data.p, email: email.data, name: typeof data.n === "string" ? data.n : null };
  }

  const clearPendingIdentity = (): string => `${PENDING_COOKIE}=; Path=/signup; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;

  async function start(provider: ProviderConfig, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!provider.client) return loginPage(request, response, 404, `${provider.label} sign-in isn’t available right now.`);
    const attempt = startAttempt(provider, safeNext(url.searchParams.get("next")));
    const authorization = new URL(provider.authorizeUrl);
    authorization.search = new URLSearchParams({
      client_id: provider.client.id,
      redirect_uri: `${base}${provider.callbackPath}`,
      response_type: "code",
      ...(provider.name === "microsoft" ? { response_mode: "query" } : {}),
      scope: "openid email profile",
      prompt: "select_account",
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge: attempt.challenge,
      code_challenge_method: "S256",
    }).toString();
    response.setHeader("set-cookie", attempt.cookie);
    return redirect(response, authorization.toString());
  }

  async function callback(provider: ProviderConfig, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const cookies = [clearAttempt(provider)];
    const fail = (status: number, message: string): void => {
      response.setHeader("set-cookie", cookies);
      loginPage(request, response, status, message);
    };
    if (!provider.client) return fail(404, `${provider.label} sign-in isn’t available right now.`);
    const attempt = readAttempt(provider, url.searchParams.get("state"), readCookie(request, provider.cookie));
    if (!attempt) return fail(400, "That sign-in expired. Try again.");
    if (url.searchParams.get("error")) return fail(200, `${provider.label} sign-in was cancelled. Try again, or use another way in.`);
    const code = url.searchParams.get("code");
    if (!code) return fail(400, "That sign-in expired. Try again.");
    try {
      const claims = await verifyIdToken(provider, provider.client, await exchangeCode(provider, provider.client, code, attempt.verifier), attempt.nonce);
      return await finish(request, response, trustedIdentity(provider, claims), attempt.next, cookies);
    } catch (error) {
      if (!(error instanceof SignInError)) throw error;
      log({ level: "warn", event: "owner_sign_in_rejected", provider: provider.name, reason: error.reason });
      return fail(error.status, error.message);
    }
  }

  async function exchangeCode(provider: ProviderConfig, client: { id: string; secret: string }, code: string, verifier: string): Promise<string> {
    const body = new URLSearchParams({ client_id: client.id, client_secret: client.secret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: `${base}${provider.callbackPath}` });
    if (provider.name === "microsoft") body.set("scope", "openid email profile");
    const retry = retryMessage(provider.label);
    let reply: Response;
    try {
      reply = await withTimeout(deps.fetcher(provider.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body }), 5_000);
    } catch {
      throw new SignInError(502, retry, "token_unreachable");
    }
    const payload = await reply.json().catch(() => ({})) as { id_token?: unknown };
    if (!reply.ok || typeof payload.id_token !== "string") throw new SignInError(502, retry, `token_http_${reply.status}`);
    return payload.id_token;
  }

  /** Signature (provider JWKS), audience, expiry, nonce and issuer. The token came straight from the provider over TLS too. */
  async function verifyIdToken(provider: ProviderConfig, client: { id: string }, idToken: string, nonce: string): Promise<Record<string, unknown>> {
    const invalid = (reason: string): SignInError => new SignInError(400, "That sign-in didn’t check out. Try again.", reason);
    const [headerText, claimsText, signatureText, extra] = idToken.split(".");
    if (!headerText || !claimsText || !signatureText || extra !== undefined) throw invalid("malformed");
    const header = parseJson(headerText) as { alg?: unknown; kid?: unknown } | null;
    const claims = parseJson(claimsText) as Record<string, unknown> | null;
    if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") throw invalid("header");
    let publicKey: KeyObject | null;
    try {
      publicKey = await jwks.key(provider.jwksUrl, header.kid);
    } catch {
      throw new SignInError(502, retryMessage(provider.label), "jwks_unreachable");
    }
    if (!publicKey || !verify("sha256", Buffer.from(`${headerText}.${claimsText}`), publicKey, Buffer.from(signatureText, "base64url"))) throw invalid("signature");
    const now = clock.now().getTime();
    const audience = claims.aud;
    if (!(audience === client.id || (Array.isArray(audience) && audience.includes(client.id) && claims.azp === client.id))) throw invalid("audience");
    if (typeof claims.exp !== "number" || claims.exp * 1_000 + CLOCK_SKEW_MS <= now) throw new SignInError(400, "That sign-in expired. Try again.", "expired");
    if ((typeof claims.iat === "number" && claims.iat * 1_000 - CLOCK_SKEW_MS > now) || (typeof claims.nbf === "number" && claims.nbf * 1_000 - CLOCK_SKEW_MS > now)) throw invalid("not_yet_valid");
    if (typeof claims.nonce !== "string" || !same(claims.nonce, nonce)) throw new SignInError(400, "That sign-in expired. Try again.", "nonce");
    if (provider.name === "google") {
      if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw invalid("issuer");
    } else if (typeof claims.tid !== "string" || !/^[0-9a-f-]{36}$/.test(claims.tid) || claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`) {
      throw invalid("issuer");
    }
    return claims;
  }

  /** The email only when the provider vouches for it; otherwise the email link is the safe way in. */
  function trustedIdentity(provider: ProviderConfig, claims: Record<string, unknown>): VerifiedIdentity {
    if (provider.name === "google" && claims.email_verified !== true) {
      throw new SignInError(403, `Google hasn’t verified that email. ${otherWayIn}`, "email_unverified");
    }
    // A work tenant's email is whatever its admin typed (nOAuth): trusted only for personal accounts or a domain-verified email.
    if (provider.name === "microsoft" && claims.tid !== MICROSOFT_CONSUMER_TENANT && ![true, "true", 1, "1"].includes(claims.xms_edov as never)) {
      throw new SignInError(403, `We can’t confirm that work email through Microsoft. ${otherWayIn}`, "email_unverified");
    }
    const email = emailSchema.safeParse(claims.email);
    if (!email.success) throw new SignInError(403, `${provider.label} didn’t share your email. ${otherWayIn}`, "no_email");
    const name = typeof claims.name === "string" && claims.name.trim().length >= 2 ? claims.name.trim().slice(0, 120) : null;
    return { provider: provider.name, email: email.data, name };
  }

  /** Same session as a password sign-in for an existing account; a new email goes to sign-up with it confirmed. */
  async function finish(request: IncomingMessage, response: ServerResponse, identity: VerifiedIdentity, next: string | null, cookies: string[]): Promise<void> {
    let account = await store.getOwnerAccountByEmail(identity.email);
    if (account && account.status !== "suspended" && !account.emailVerifiedAt) {
      // The first proof that this person controls the email. A password typed at sign-up (maybe by someone else
      // using their email) stops working and its sessions end. "Forgot your password?" sets a new one.
      const dropPassword = !isPasswordless(account.passwordHash);
      await store.markOwnerEmailVerified(account.id, clock.now().toISOString(), dropPassword ? PASSWORDLESS_HASH : null);
      if (dropPassword) log({ level: "info", event: "owner_unproven_password_dropped", method: identity.provider, accountId: account.id });
      account = await store.getOwnerAccountByEmail(identity.email);
    }
    if (account) {
      if (account.status === "suspended") {
        response.setHeader("set-cookie", cookies);
        return loginPage(request, response, 403, `This account is switched off.${env.SUPPORT_EMAIL ? ` Email ${env.SUPPORT_EMAIL} for help.` : ""}`);
      }
      cookies.push(ownerSessionCookie(mintOwnerSession(account, key, clock.now().getTime()), env.NODE_ENV === "production"));
      response.setHeader("set-cookie", cookies);
      log({ level: "info", event: "owner_signed_in", method: identity.provider, accountId: account.id });
      return redirect(response, next ?? "/app");
    }
    cookies.push(pendingIdentityCookie(identity));
    response.setHeader("set-cookie", cookies);
    log({ level: "info", event: "owner_sign_up_identity_verified", method: identity.provider });
    return redirect(response, "/signup");
  }

  async function requestLink(request: IncomingMessage, response: ServerResponse, ip: string): Promise<void> {
    if (!emailEnabled) throw new HttpError(404, "Not found");
    if (isCrossSiteFormPost(request, env.PUBLIC_BASE_URL)) throw new HttpError(403, "Forbidden");
    if (!limiter.allow(`${ip}:owner-login-link`, 10, 15 * 60_000)) throw new HttpError(429, "Too many sign-in attempts");
    const form = parseForm(await readBody(request, 4_000));
    const next = safeNext(form.get("next"));
    const typed = form.get("email") ?? "";
    const parsed = emailSchema.safeParse(typed);
    if (!parsed.success) return loginPage(request, response, 400, "Enter an email like you@yourshop.com.", { errorField: "link", next, email: typed.slice(0, 254) });
    const email = parsed.data;
    // Same answer either way; past the per-email limit nothing more is sent.
    if (limiter.allow(`owner-login-link-email:${email}`, 5, 60 * 60_000)) {
      const account = await store.getOwnerAccountByEmail(email);
      if (account?.status !== "suspended") await sendLink(email, account, next);
    }
    return sendHtml(response, 200, renderSignInLinkSent(email));
  }

  async function sendLink(email: string, account: OwnerAccount | null, next: string | null): Promise<void> {
    const { token, tokenHash } = createSignInLinkToken();
    const now = clock.now();
    await store.createSignInLink(tokenHash, email, new Date(now.getTime() + LINK_TTL_MS).toISOString(), now.toISOString());
    // The page they asked from (say, deleting the shop) opens after the tap.
    const link = `${base}/login/link?token=${encodeURIComponent(token)}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
    await store.enqueueNotification({
      id: randomUUID(), tenantId: account?.tenantId ?? SIGN_IN_LINK_OUTBOX_TENANT, callId: null, channel: "email", destinationRef: `email:${email}`,
      body: formatEmailBody("Your Call Otto sign-in link", `Tap this link to sign in to Call Otto. It works once, for 15 minutes:\n\n${link}\n\nIf you didn't ask for this, ignore this email.`),
      priority: "high", state: "pending", attempts: 0, nextAttemptAt: now.toISOString(),
      idempotencyKey: `sign-in-link:${tokenHash}`, providerReceipt: null, lastError: null, createdAt: now.toISOString(), sentAt: null,
    });
  }

  async function useLink(request: IncomingMessage, response: ServerResponse, ip: string): Promise<void> {
    if (isCrossSiteFormPost(request, env.PUBLIC_BASE_URL)) throw new HttpError(403, "Forbidden");
    if (!limiter.allow(`${ip}:owner-login-link-use`, 20, 15 * 60_000)) throw new HttpError(429, "Too many sign-in attempts");
    const form = parseForm(await readBody(request, 4_000));
    const token = form.get("token") ?? "";
    const expired = (): void => loginPage(request, response, 400, "That link expired or was already used. Send a new one.", { errorField: "linkToken" });
    if (!LINK_TOKEN.test(token)) return expired();
    // Only the browser that opened the link can use it, so another site can't post its own link here and sign
    // this browser into its shop. The link stays unused, so the owner can still open it again and tap.
    if (!same(readCookie(request, LINK_COOKIE) ?? "", sign("owner-sign-in-link", token))) {
      return loginPage(request, response, 400, "Open the link from your email again, then tap Sign me in.", { errorField: "linkToken" });
    }
    const email = await store.consumeSignInLink(hashSignInLinkToken(token), clock.now().toISOString());
    if (!email) return expired();
    return finish(request, response, { provider: "email", email, name: null }, safeNext(form.get("next")), [linkCookie("", 0)]);
  }

  /** Handles /auth/* and the email-link routes; false for anything else. */
  async function route(request: IncomingMessage, response: ServerResponse, url: URL, method: string, ip: string): Promise<boolean> {
    const path = url.pathname;
    if (method === "GET" && (path === "/auth/google" || path === "/auth/microsoft")) await start(path === "/auth/google" ? providers.google : providers.microsoft, request, response, url);
    else if (method === "GET" && path === MICROSOFT_SIGN_IN_CALLBACK) await callback(providers.microsoft, request, response, url);
    else if (method === "POST" && path === "/login/email") await requestLink(request, response, ip);
    else if (method === "GET" && path === "/login/link") {
      const token = url.searchParams.get("token") ?? "";
      if (LINK_TOKEN.test(token)) {
        // Opening the link only shows a button (mail scanners open links too); this cookie ties the tap to this browser.
        response.setHeader("set-cookie", linkCookie(sign("owner-sign-in-link", token), LINK_TTL_MS / 1_000));
        sendHtml(response, 200, renderSignInLinkConfirm(token, safeNext(url.searchParams.get("next"))));
      } else loginPage(request, response, 400, "That link doesn’t work. Send a new one.", { errorField: "linkToken" });
    } else if (method === "POST" && path === "/login/link") await useLink(request, response, ip);
    else return false;
    return true;
  }

  return {
    route,
    /** The Google callback for a sign-in attempt (app.ts sends it here before the owner session check). */
    googleCallback: (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => callback(providers.google, request, response, url),
    loginOptions,
    pendingIdentity,
    clearPendingIdentity,
    providersFor,
  };
}

/** Sign-up's view of a pending identity. */
export function verifiedSignupEmail(identity: VerifiedIdentity | null): VerifiedSignupEmail | null {
  return identity ? { email: identity.email, provider: identity.provider } : null;
}

/** Provider signing keys by kid, refetched hourly or when a new kid shows up (at most once a minute). */
class JwksCache {
  readonly #byUrl = new Map<string, { keys: Map<string, KeyObject>; fetchedAt: number }>();

  constructor(private readonly fetcher: typeof fetch) {}

  async key(url: string, kid: string): Promise<KeyObject | null> {
    const cached = this.#byUrl.get(url);
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (cached && (cached.keys.has(kid) ? age < 60 * 60_000 : age < 60_000)) return cached.keys.get(kid) ?? null;
    const reply = await withTimeout(this.fetcher(url, { headers: { accept: "application/json" } }), 5_000);
    if (!reply.ok) throw new Error(`JWKS HTTP ${reply.status}`);
    const body = await reply.json() as { keys?: unknown };
    const keys = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(body.keys) ? body.keys as Array<Record<string, unknown>> : []) {
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
      try {
        keys.set(jwk.kid, createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }));
      } catch {
        // A key Node can't read is skipped; tokens signed with it fail closed.
      }
    }
    this.#byUrl.set(url, { keys, fetchedAt: Date.now() });
    return keys.get(kid) ?? null;
  }
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
