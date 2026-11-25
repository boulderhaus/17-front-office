import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";
import { MICROSOFT_CONSUMER_TENANT, safeNext } from "../src/http/owner-sign-in.js";
import { hashOwnerPassword, PASSWORDLESS_HASH, verifyOwnerPassword } from "../src/security/owner-auth.js";

const GOOGLE_CLIENT = "synthetic-google-next-client";
const MICROSOFT_CLIENT = "synthetic-microsoft-client";
const BASE = "http://127.0.0.1:8787";
const WORK_TENANT = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const realFetch = globalThis.fetch;
const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

function idToken(claims: Record<string, unknown>, privateKey: KeyObject = signingKey.privateKey, kid = "synthetic-kid"): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${part({ alg: "RS256", kid, typ: "JWT" })}.${part(claims)}`;
  return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
}

interface Harness {
  baseUrl: string;
  store: InMemoryStore;
  advance(ms: number): void;
  now(): number;
  /** The claims the fake token endpoint signs next (the nonce is filled in from the request). */
  claims: Record<string, unknown>;
  tokenSigner: { key: KeyObject; kid: string };
  tokenRequests: URLSearchParams[];
}

let server: Server | null = null;
afterEach(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const store = new InMemoryStore();
  await store.saveConfig(createDemoConfig());
  let nowMs = Date.parse("2026-03-02T15:00:00.000Z");
  const h: Harness = {
    baseUrl: "", store, claims: {}, tokenRequests: [],
    tokenSigner: { key: signingKey.privateKey, kid: "synthetic-kid" },
    advance: (ms) => { nowMs += ms; },
    now: () => nowMs,
  };
  const jwk = { ...signingKey.publicKey.export({ format: "jwk" }), kid: "synthetic-kid", alg: "RS256", use: "sig" };
  // Every provider endpoint is faked; requests to the test server itself go through.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === "https://www.googleapis.com/oauth2/v3/certs" || url === "https://login.microsoftonline.com/common/discovery/v2.0/keys") return json({ keys: [jwk] });
    if (url === "https://oauth2.googleapis.com/token" || url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
      const body = new URLSearchParams(String(init?.body));
      h.tokenRequests.push(body);
      // Calendar connect redeems its own code for a refresh token, exactly as before.
      if (body.get("code") === "calendar-code") return json({ refresh_token: "synthetic-refresh", scope: "https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy" });
      return json({ access_token: "synthetic-access", id_token: idToken(h.claims, h.tokenSigner.key, h.tokenSigner.kid) });
    }
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    throw new Error(`Unexpected outbound request to ${url}`);
  }) as typeof fetch;
  server = createServer(createRequestHandler({
    env: demoEnvironment({
      ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz",
      TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz",
      PUBLIC_BASE_URL: BASE,
      GOOGLE_CLIENT_ID: "synthetic-google-legacy-client",
      GOOGLE_CLIENT_SECRET: "synthetic-google-legacy-secret",
      GOOGLE_CLIENT_ID_NEXT: GOOGLE_CLIENT,
      GOOGLE_CLIENT_SECRET_NEXT: "synthetic-google-next-secret",
      GOOGLE_OAUTH_NEW_CONNECTIONS: "next",
      RESEND_API_KEY: "re_synthetic_key",
      RESEND_FROM_EMAIL: "hello@callotto.example",
      ...env,
    }),
    store, calendar: new InMemoryCalendar(), clock: { now: () => new Date(nowMs) }, integrations: {}, logger: () => undefined,
  }));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  h.baseUrl = `http://127.0.0.1:${address.port}`;
  return h;
}

const cookieOf = (response: Response, name: string): string | null => {
  const found = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  return found ? found.split(";")[0]! : null;
};

/** An owner whose email is already proved (as every account made before this change is), unless emailVerified is false. */
async function ownerAccount(h: Harness, email: string, passwordHash?: string, emailVerified = true): Promise<{ id: string; tenantId: string }> {
  const tenantId = `shop_${randomUUID()}`;
  const now = new Date(h.now()).toISOString();
  const account = { id: randomUUID(), tenantId, email, displayName: "Synthetic Owner", passwordHash: passwordHash ?? await hashOwnerPassword("long-password-for-tests"), status: "active" as const, emailVerifiedAt: emailVerified ? now : null, createdAt: now, updatedAt: now };
  expect(await h.store.createOwnerWorkspace({ account, config: { ...createDemoConfig(tenantId), businessName: "Synthetic Air" }, ownerPhone: null })).toBe(true);
  return account;
}

async function start(h: Harness, provider: "google" | "microsoft", next?: string) {
  const response = await fetch(`${h.baseUrl}/auth/${provider}${next ? `?next=${encodeURIComponent(next)}` : ""}`, { redirect: "manual" });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location")!);
  return { location, state: location.searchParams.get("state")!, nonce: location.searchParams.get("nonce")!, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}

function googleClaims(nonce: string, now: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: "https://accounts.google.com", aud: GOOGLE_CLIENT, azp: GOOGLE_CLIENT, sub: "1029384756", email: "owner@synthetic.example", email_verified: true, name: "Sam Synthetic", nonce, iat: Math.floor(now / 1_000), exp: Math.floor(now / 1_000) + 3_600, ...extra };
}

function microsoftClaims(nonce: string, now: number, tid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: MICROSOFT_CLIENT, tid, sub: "ms-subject", email: "owner@synthetic.example", name: "Sam Synthetic", nonce, iat: Math.floor(now / 1_000), exp: Math.floor(now / 1_000) + 3_600, ...extra };
}

async function finishGoogle(h: Harness, attempt: { state: string; cookie: string }, cookie = attempt.cookie): Promise<Response> {
  const callback = new URL(`${h.baseUrl}/app/integrations/google/callback`);
  callback.searchParams.set("state", attempt.state);
  callback.searchParams.set("code", "synthetic-code");
  return fetch(callback, { redirect: "manual", headers: { cookie } });
}

async function finishMicrosoft(h: Harness, attempt: { state: string; cookie: string }): Promise<Response> {
  const callback = new URL(`${h.baseUrl}/auth/microsoft/callback`);
  callback.searchParams.set("state", attempt.state);
  callback.searchParams.set("code", "synthetic-code");
  return fetch(callback, { redirect: "manual", headers: { cookie: attempt.cookie } });
}

async function queuedLinks(h: Harness): Promise<Array<{ to: string; token: string; tenantId: string; url: string }>> {
  return [...h.store.notifications.values()]
    .filter((item) => item.idempotencyKey.startsWith("sign-in-link:"))
    .map((item) => ({ to: item.destinationRef.slice(6), token: /\/login\/link\?token=([A-Za-z0-9_-]+)/.exec(item.body)![1]!, tenantId: item.tenantId, url: /(http\S+\/login\/link\?\S+)/.exec(item.body)![1]! }));
}

/** Taps "Sign me in" with the given cookie (none, or the one opening a link sets). */
const postLink = (h: Harness, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${h.baseUrl}/login/link`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form) });
/** Opens the emailed link in this "browser" (which sets its cookie), then taps "Sign me in". */
async function useLink(h: Harness, token: string, next?: string): Promise<Response> {
  const bind = cookieOf(await fetch(`${h.baseUrl}/login/link?token=${token}`), "afo_sign_in_link");
  return postLink(h, { token, ...(next ? { next } : {}) }, bind ? { cookie: bind } : {});
}
const requestLink = (h: Harness, email: string, next?: string): Promise<Response> => fetch(`${h.baseUrl}/login/email`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, ...(next ? { next } : {}) }) });

describe("Continue with Google", () => {
  it("signs an existing owner in with the normal session, asking Google only for openid, email and profile", async () => {
    const h = await harness();
    await ownerAccount(h, "owner@synthetic.example");
    const attempt = await start(h, "google");
    expect(attempt.location.origin + attempt.location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(attempt.location.searchParams)).toMatchObject({
      client_id: GOOGLE_CLIENT, redirect_uri: `${BASE}/app/integrations/google/callback`, response_type: "code", scope: "openid email profile",
      prompt: "select_account", code_challenge_method: "S256",
    });
    expect(attempt.location.searchParams.get("access_type")).toBeNull();
    expect(attempt.cookie.startsWith("afo_google_signin=")).toBe(true);
    const setCookie = (await fetch(`${h.baseUrl}/auth/google`, { redirect: "manual" })).headers.get("set-cookie")!;
    expect(setCookie).toContain("Path=/app/integrations/google");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=600");

    h.claims = googleClaims(attempt.nonce, h.now(), { email: "Owner@Synthetic.example" });
    const done = await finishGoogle(h, attempt);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/app");
    const session = cookieOf(done, "afo_owner");
    expect(session).toBeTruthy();
    expect(done.headers.getSetCookie().some((cookie) => cookie.startsWith("afo_google_signin=;") && cookie.includes("Max-Age=0"))).toBe(true);
    // PKCE: the code was redeemed with the verifier behind the challenge, on the registered redirect URI.
    const exchange = h.tokenRequests.at(-1)!;
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(attempt.location.searchParams.get("code_challenge"));
    expect(exchange.get("redirect_uri")).toBe(`${BASE}/app/integrations/google/callback`);
    expect(exchange.get("client_id")).toBe(GOOGLE_CLIENT);
    expect((await fetch(`${h.baseUrl}/app`, { redirect: "manual", headers: { cookie: session! } })).status).toBe(200);
  });

  it("sends a new email to sign-up with the email locked, and creates the account with no password", async () => {
    const h = await harness();
    const attempt = await start(h, "google");
    h.claims = googleClaims(attempt.nonce, h.now(), { email: "new-owner@synthetic.example" });
    const done = await finishGoogle(h, attempt);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/signup");
    expect(cookieOf(done, "afo_owner")).toBeNull();
    const pending = cookieOf(done, "afo_pending_identity")!;
    expect(done.headers.getSetCookie().find((cookie) => cookie.startsWith("afo_pending_identity="))).toContain("Path=/signup");

    const page = await (await fetch(`${h.baseUrl}/signup`, { headers: { cookie: pending } })).text();
    expect(page).toContain('value="new-owner@synthetic.example" readonly');
    expect(page).toContain("Verified with Google.");
    expect(page).not.toContain('name="password"');
    expect(page).not.toContain("Continue with Google");
    // The text opt-in block is untouched.
    expect(page).toContain('<input name="ownerSmsConsent" type="checkbox" value="yes" >');

    // A tampered email in the form is ignored: the verified one is the account email.
    const created = await fetch(`${h.baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { cookie: pending, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Heating", email: "someone-else@synthetic.example", trade: "hvac" }) });
    expect(created.status).toBe(303);
    expect(cookieOf(created, "afo_owner")).toBeTruthy();
    expect(created.headers.getSetCookie().some((cookie) => cookie.startsWith("afo_pending_identity=;") && cookie.includes("Max-Age=0"))).toBe(true);
    expect(await h.store.getOwnerAccountByEmail("someone-else@synthetic.example")).toBeNull();
    const account = (await h.store.getOwnerAccountByEmail("new-owner@synthetic.example"))!;
    expect(account.passwordHash).toBe(PASSWORDLESS_HASH);
    expect(account.displayName).toBe("Sam Synthetic");
    expect((await h.store.getConfig(account.tenantId)).businessName).toBe("Synthetic Heating");
  });

  it("refuses an email Google hasn't verified", async () => {
    const h = await harness();
    await ownerAccount(h, "owner@synthetic.example");
    const attempt = await start(h, "google");
    h.claims = googleClaims(attempt.nonce, h.now(), { email_verified: false });
    const done = await finishGoogle(h, attempt);
    expect(done.status).toBe(403);
    expect(cookieOf(done, "afo_owner")).toBeNull();
    expect(cookieOf(done, "afo_pending_identity")).toBeNull();
    expect(await done.text()).toContain("Use the email link instead");
  });

  it("answers 400 for a tampered, expired or mismatched state, a wrong nonce, or a forged token", async () => {
    const h = await harness();
    await ownerAccount(h, "owner@synthetic.example");
    const expectRejected = async (response: Response) => {
      expect(response.status).toBe(400);
      expect(cookieOf(response, "afo_owner")).toBeNull();
    };

    const tampered = await start(h, "google");
    h.claims = googleClaims(tampered.nonce, h.now());
    await expectRejected(await finishGoogle(h, { ...tampered, state: `${tampered.state.slice(0, -2)}xx` }));

    const noCookie = await start(h, "google");
    await expectRejected(await finishGoogle(h, noCookie, ""));

    const other = await start(h, "google");
    const swapped = await start(h, "google");
    await expectRejected(await finishGoogle(h, other, swapped.cookie));

    const badNonce = await start(h, "google");
    h.claims = googleClaims("not-the-nonce", h.now());
    await expectRejected(await finishGoogle(h, badNonce));

    const forged = await start(h, "google");
    h.claims = googleClaims(forged.nonce, h.now());
    h.tokenSigner = { key: strangerKey.privateKey, kid: "synthetic-kid" };
    await expectRejected(await finishGoogle(h, forged));
    h.tokenSigner = { key: signingKey.privateKey, kid: "synthetic-kid" };

    const wrongAudience = await start(h, "google");
    h.claims = googleClaims(wrongAudience.nonce, h.now(), { aud: "someone-elses-client", azp: "someone-elses-client" });
    await expectRejected(await finishGoogle(h, wrongAudience));

    const expired = await start(h, "google");
    h.advance(11 * 60_000);
    h.claims = googleClaims(expired.nonce, h.now());
    await expectRejected(await finishGoogle(h, expired));
  });

  it("leaves calendar connect exactly as it was without a sign-in state, even with a leftover sign-in cookie", async () => {
    const h = await harness();
    const signup = await fetch(`${h.baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", email: "calendar@synthetic.example", password: "long-password-for-tests" }) });
    const owner = cookieOf(signup, "afo_owner")!;
    const tenantId = (await h.store.getOwnerAccountByEmail("calendar@synthetic.example"))!.tenantId;
    const leftover = await start(h, "google");
    const connect = await fetch(`${h.baseUrl}/app/integrations/google/start`, { redirect: "manual", headers: { cookie: owner } });
    const location = new URL(connect.headers.get("location")!);
    expect(location.searchParams.get("scope")).toContain("calendar");
    const pkce = connect.headers.get("set-cookie")!.split(";")[0]!;
    const callback = new URL(`${h.baseUrl}/app/integrations/google/callback`);
    callback.searchParams.set("state", location.searchParams.get("state")!);
    callback.searchParams.set("code", "calendar-code");
    const done = await fetch(callback, { redirect: "manual", headers: { cookie: `${owner}; ${pkce}; ${leftover.cookie}` } });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/app/settings");
    expect(await h.store.getIntegrationSecret(tenantId, "google", "refresh_token")).toContain("synthetic-refresh");
    // Signed out, the calendar callback still sends people to sign in.
    expect((await fetch(callback, { redirect: "manual" })).headers.get("location")).toBe("/login");
  });

  it("only lands on a same-origin page inside the app after signing in", async () => {
    for (const next of ["https://evil.example/app", "//evil.example/app", "/\\evil.example", "/apple", "/app//evil.example", "javascript:alert(1)", "/app\n/x"]) {
      expect(safeNext(next), next).toBeNull();
    }
    expect(safeNext("/app/settings/data")).toBe("/app/settings/data");
    expect(safeNext("/app?view=calendar")).toBe("/app?view=calendar");

    const h = await harness();
    await ownerAccount(h, "owner@synthetic.example");
    const evil = await start(h, "google", "https://evil.example/steal");
    h.claims = googleClaims(evil.nonce, h.now());
    expect((await finishGoogle(h, evil)).headers.get("location")).toBe("/app");
    const good = await start(h, "google", "/app/settings/data");
    h.claims = googleClaims(good.nonce, h.now());
    expect((await finishGoogle(h, good)).headers.get("location")).toBe("/app/settings/data");
    const password = await fetch(`${h.baseUrl}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@synthetic.example", password: "long-password-for-tests", next: "//evil.example" }) });
    expect(password.headers.get("location")).toBe("/app");
  });
});

describe("Continue with Microsoft", () => {
  const microsoftEnv = { MICROSOFT_CLIENT_ID: MICROSOFT_CLIENT, MICROSOFT_CLIENT_SECRET: "synthetic-microsoft-secret" };

  it("shows the button only when the app registration is configured", async () => {
    const without = await harness();
    const page = await (await fetch(`${without.baseUrl}/login`)).text();
    expect(page).toContain("Continue with Google");
    expect(page).not.toContain("Continue with Microsoft");
    expect((await fetch(`${without.baseUrl}/auth/microsoft`, { redirect: "manual" })).status).toBe(404);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const withIt = await harness(microsoftEnv);
    const login = await (await fetch(`${withIt.baseUrl}/login`)).text();
    expect(login.indexOf("Continue with Google")).toBeLessThan(login.indexOf("Continue with Microsoft"));
    expect(login.indexOf("Continue with Microsoft")).toBeLessThan(login.indexOf("Email me a sign-in link"));
    expect(login.indexOf("Email me a sign-in link")).toBeLessThan(login.indexOf("Use a password instead"));
    expect(await (await fetch(`${withIt.baseUrl}/signup`)).text()).toContain("Continue with Microsoft");
  });

  it("rejects a work-tenant email Microsoft hasn't verified, and accepts personal or domain-verified ones", async () => {
    const h = await harness(microsoftEnv);
    await ownerAccount(h, "owner@synthetic.example");
    const work = await start(h, "microsoft");
    expect(work.location.origin + work.location.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(work.location.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/microsoft/callback`);
    expect(work.location.searchParams.get("scope")).toBe("openid email profile");
    h.claims = microsoftClaims(work.nonce, h.now(), WORK_TENANT);
    const refused = await finishMicrosoft(h, work);
    expect(refused.status).toBe(403);
    expect(cookieOf(refused, "afo_owner")).toBeNull();
    expect(await refused.text()).toContain("Use the email link instead");

    const verifiedDomain = await start(h, "microsoft");
    h.claims = microsoftClaims(verifiedDomain.nonce, h.now(), WORK_TENANT, { xms_edov: true });
    const ok = await finishMicrosoft(h, verifiedDomain);
    expect(ok.status).toBe(303);
    expect(cookieOf(ok, "afo_owner")).toBeTruthy();

    const personal = await start(h, "microsoft");
    h.claims = microsoftClaims(personal.nonce, h.now(), MICROSOFT_CONSUMER_TENANT);
    expect(cookieOf(await finishMicrosoft(h, personal), "afo_owner")).toBeTruthy();

    const wrongIssuer = await start(h, "microsoft");
    h.claims = microsoftClaims(wrongIssuer.nonce, h.now(), MICROSOFT_CONSUMER_TENANT, { iss: `https://login.microsoftonline.com/${WORK_TENANT}/v2.0` });
    expect((await finishMicrosoft(h, wrongIssuer)).status).toBe(400);
  });
});

describe("Email me a sign-in link", () => {
  it("answers the same whether or not the email has an account", async () => {
    const h = await harness();
    await ownerAccount(h, "owner@synthetic.example");
    const known = await requestLink(h, "owner@synthetic.example");
    const unknown = await requestLink(h, "stranger@synthetic.example");
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    const knownBody = (await known.text()).replace("owner@synthetic.example", "EMAIL");
    expect((await unknown.text()).replace("stranger@synthetic.example", "EMAIL")).toBe(knownBody);
    expect(knownBody).toContain("Check your email");
    const links = await queuedLinks(h);
    expect(links.map((link) => link.to).sort()).toEqual(["owner@synthetic.example", "stranger@synthetic.example"]);
    // Only a hash of the token is stored.
    for (const link of links) expect(h.store.signInLinks.has(link.token)).toBe(false);
  });

  it("signs in once per link, after a tap, and not after 15 minutes", async () => {
    const h = await harness();
    await ownerAccount(h, "owner@synthetic.example");
    await requestLink(h, "owner@synthetic.example");
    const [link] = await queuedLinks(h);
    // Opening the link (or a mail scanner prefetching it) only shows the button.
    for (let open = 0; open < 2; open += 1) {
      const page = await (await fetch(`${h.baseUrl}/login/link?token=${link!.token}`)).text();
      expect(page).toContain('action="/login/link"');
      expect(page).toContain("Sign me in");
    }
    const first = await useLink(h, link!.token);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/app");
    expect(cookieOf(first, "afo_owner")).toBeTruthy();
    const again = await useLink(h, link!.token);
    expect(again.status).toBe(400);
    expect(cookieOf(again, "afo_owner")).toBeNull();

    h.store.notifications.clear();
    await requestLink(h, "owner@synthetic.example");
    const [late] = await queuedLinks(h);
    h.advance(15 * 60_000 + 1_000);
    expect((await useLink(h, late!.token)).status).toBe(400);
    expect((await useLink(h, "not-a-real-token-at-all-0000000000")).status).toBe(400);
  });

  it("takes a new email to sign-up with the email confirmed", async () => {
    const h = await harness();
    await requestLink(h, "fresh@synthetic.example");
    const [link] = await queuedLinks(h);
    const used = await useLink(h, link!.token);
    expect(used.headers.get("location")).toBe("/signup");
    const pending = cookieOf(used, "afo_pending_identity")!;
    const page = await (await fetch(`${h.baseUrl}/signup`, { headers: { cookie: pending } })).text();
    expect(page).toContain('value="fresh@synthetic.example" readonly');
    expect(page).toContain("Verified by your email link.");
    // "Use a different email" drops it.
    const fresh = await fetch(`${h.baseUrl}/signup?fresh=1`, { redirect: "manual", headers: { cookie: pending } });
    expect(fresh.headers.get("set-cookie")).toContain("afo_pending_identity=;");
  });

  it("stops sending to one address after a few requests, without saying so", async () => {
    const h = await harness();
    for (let attempt = 0; attempt < 7; attempt += 1) {
      expect((await fetch(`${h.baseUrl}/login/email`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `10.1.${attempt}.1` }, body: new URLSearchParams({ email: "target@synthetic.example" }) })).status).toBe(200);
    }
    expect((await queuedLinks(h)).length).toBe(5);
  });
});

describe("accounts without a password", () => {
  it("never match any password, and never throw", async () => {
    for (const guess of ["", "passwordless-v1", PASSWORDLESS_HASH, "long-password-for-tests", "scrypt-v1:x:y"]) {
      await expect(verifyOwnerPassword(guess, PASSWORDLESS_HASH)).resolves.toBe(false);
    }
    const h = await harness();
    await ownerAccount(h, "nopass@synthetic.example", PASSWORDLESS_HASH);
    for (const password of ["passwordless-v1", "long-password-for-tests", "x"]) {
      const response = await fetch(`${h.baseUrl}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "nopass@synthetic.example", password }) });
      expect(response.status).toBe(401);
      expect(cookieOf(response, "afo_owner")).toBeNull();
    }
  });

  it("delete the shop after a recent sign-in instead of a password", async () => {
    const h = await harness();
    await ownerAccount(h, "nopass@synthetic.example", PASSWORDLESS_HASH);
    await requestLink(h, "nopass@synthetic.example");
    const signedIn = cookieOf(await useLink(h, (await queuedLinks(h))[0]!.token), "afo_owner")!;
    const settings = await (await fetch(`${h.baseUrl}/app/settings`, { headers: { cookie: signedIn } })).text();
    expect(settings).not.toContain('name="password"');
    const csrf = /name="csrf" value="([^"]+)"/.exec(settings)![1]!;
    const api = await (await fetch(`${h.baseUrl}/api/app/settings`, { headers: { cookie: signedIn } })).json() as { signIn: { hasPassword: boolean; recent: boolean } };
    expect(api.signIn).toEqual({ hasPassword: false, recent: true });
    const remove = (cookie: string, token: string) => fetch(`${h.baseUrl}/app/account/delete`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: token, confirm: "DELETE" }) });

    h.advance(11 * 60_000);
    expect((await remove(signedIn, csrf)).status).toBe(403);
    expect(await (await fetch(`${h.baseUrl}/app/settings`, { headers: { cookie: signedIn } })).text()).toContain("sign in again");

    h.store.notifications.clear();
    await requestLink(h, "nopass@synthetic.example");
    const fresh = cookieOf(await useLink(h, (await queuedLinks(h))[0]!.token), "afo_owner")!;
    const freshCsrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${h.baseUrl}/app/settings`, { headers: { cookie: fresh } })).text())![1]!;
    const deleted = await remove(fresh, freshCsrf);
    expect(deleted.status).toBe(303);
    expect(await h.store.getOwnerAccountByEmail("nopass@synthetic.example")).toBeNull();
  });
});

describe("sign-in page", () => {
  it("is readable and accessible: labelled fields, autocomplete, and an alert tied to the field", async () => {
    const h = await harness();
    const page = await (await fetch(`${h.baseUrl}/login`)).text();
    expect(page).toContain('<label for="link-email">');
    expect(page).toMatch(/id="link-email" name="email" type="email" autocomplete="email" inputmode="email"/);
    expect(page).toMatch(/id="password" name="password" type="password" autocomplete="current-password"/);
    expect(page).toContain('<a href="/forgot">Forgot your password?</a>');
    expect(page).toMatch(/\.publicform input,[^{]*\{[^}]*font:400 17px[^}]*ui-sans-serif/);
    expect(page).toContain("--field-ink:#0a2540");
    expect(page).toContain('fill="#4285F4"');
    const wrong = await (await fetch(`${h.baseUrl}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "nobody@synthetic.example", password: "wrong-password" }) })).text();
    expect(wrong).toContain('role="alert" id="login-error"');
    expect(wrong).toContain('<a href="#password-email">Email or password is incorrect.</a>');
    expect(wrong).toMatch(/id="password-email"[^>]*aria-invalid="true" aria-describedby="login-error"/);
    expect(wrong).toContain('<details class="pwd" open>');
  });
});

describe("login CSRF", () => {
  it("uses an emailed link only in the browser that opened it, and the link survives a forged tap", async () => {
    const h = await harness();
    await ownerAccount(h, "owner@synthetic.example");
    await requestLink(h, "owner@synthetic.example");
    const [link] = await queuedLinks(h);
    const opened = await fetch(`${h.baseUrl}/login/link?token=${link!.token}`);
    const setCookie = opened.headers.getSetCookie().find((cookie) => cookie.startsWith("afo_sign_in_link="))!;
    for (const part of ["Path=/login/link", "HttpOnly", "SameSite=Lax", "Max-Age=900"]) expect(setCookie).toContain(part);
    expect(setCookie).not.toContain(link!.token);
    expect(opened.headers.get("referrer-policy")).toBe("no-referrer");
    expect(opened.headers.get("cache-control")).toBe("no-store");

    // Another site posting the link: no cookie, or a cookie from opening a different link.
    const forged = await postLink(h, { token: link!.token });
    expect(forged.status).toBe(400);
    expect(cookieOf(forged, "afo_owner")).toBeNull();
    expect(await forged.text()).toContain("Open the link from your email again");
    h.store.notifications.clear();
    await requestLink(h, "owner@synthetic.example");
    const [other] = await queuedLinks(h);
    const otherCookie = cookieOf(await fetch(`${h.baseUrl}/login/link?token=${other!.token}`), "afo_sign_in_link")!;
    expect((await postLink(h, { token: link!.token }, { cookie: otherCookie })).status).toBe(400);
    expect((await postLink(h, { token: link!.token }, { cookie: cookieOf(opened, "afo_sign_in_link")!, "sec-fetch-site": "cross-site" })).status).toBe(403);

    // The owner's own tap still works, and clears the cookie.
    const mine = await postLink(h, { token: link!.token }, { cookie: cookieOf(opened, "afo_sign_in_link")!, "sec-fetch-site": "same-origin", origin: "null" });
    expect(mine.status).toBe(303);
    expect(cookieOf(mine, "afo_owner")).toBeTruthy();
    expect(mine.headers.getSetCookie().some((cookie) => cookie.startsWith("afo_sign_in_link=;") && cookie.includes("Max-Age=0"))).toBe(true);
  });

  it("refuses password and email-link posts another site sends", async () => {
    const h = await harness();
    await ownerAccount(h, "owner@synthetic.example");
    const login = (headers: Record<string, string>) => fetch(`${h.baseUrl}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ email: "owner@synthetic.example", password: "long-password-for-tests" }) });
    expect((await login({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await login({ origin: "https://evil.example" })).status).toBe(403);
    // Our own pages post with Origin: null (they're sent with Referrer-Policy: no-referrer).
    for (const headers of [{}, { "sec-fetch-site": "same-origin", origin: "null" }, { origin: BASE }]) {
      const ok = await login(headers);
      expect(ok.status, JSON.stringify(headers)).toBe(303);
    }
    const crossLink = await fetch(`${h.baseUrl}/login/email`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" }, body: new URLSearchParams({ email: "owner@synthetic.example" }) });
    expect(crossLink.status).toBe(403);
    expect(await queuedLinks(h)).toEqual([]);
  });
});

describe("a password sign-up with someone else's email", () => {
  it("loses its password and sessions when the real owner first proves the email", async () => {
    const h = await harness();
    // Someone signs up with the owner's email and a password; nothing proved the email.
    const squatter = await fetch(`${h.baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Squatter Air", email: "owner@synthetic.example", password: "squatter-password-123" }) });
    const squatterSession = cookieOf(squatter, "afo_owner")!;
    expect((await h.store.getOwnerAccountByEmail("owner@synthetic.example"))!.emailVerifiedAt).toBeNull();

    const attempt = await start(h, "google");
    h.claims = googleClaims(attempt.nonce, h.now());
    const owner = await finishGoogle(h, attempt);
    expect(owner.headers.get("location")).toBe("/app");
    const ownerSession = cookieOf(owner, "afo_owner")!;
    const account = (await h.store.getOwnerAccountByEmail("owner@synthetic.example"))!;
    expect(account.passwordHash).toBe(PASSWORDLESS_HASH);
    expect(account.emailVerifiedAt).toBeTruthy();

    const password = await fetch(`${h.baseUrl}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@synthetic.example", password: "squatter-password-123" }) });
    expect(password.status).toBe(401);
    expect((await fetch(`${h.baseUrl}/api/app/settings`, { headers: { cookie: squatterSession } })).status).toBe(401);
    expect((await fetch(`${h.baseUrl}/api/app/settings`, { headers: { cookie: ownerSession } })).status).toBe(200);
  });

  it("keeps a password set through a reset link, and an already-proved owner's password", async () => {
    const h = await harness();
    await ownerAccount(h, "proved@synthetic.example");
    const reset = await ownerAccount(h, "reset@synthetic.example", undefined, false);
    const { token, tokenHash } = (await import("../src/security/owner-auth.js")).createPasswordResetToken();
    await h.store.createPasswordReset(reset.id, tokenHash, new Date(h.now() + 30 * 60_000).toISOString());
    expect((await fetch(`${h.baseUrl}/reset`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token, password: "fresh-password-456", confirm: "fresh-password-456" }) })).status).toBe(303);
    expect((await h.store.getOwnerAccountByEmail("reset@synthetic.example"))!.emailVerifiedAt).toBeTruthy();

    for (const [email, password] of [["proved@synthetic.example", "long-password-for-tests"], ["reset@synthetic.example", "fresh-password-456"]] as const) {
      const attempt = await start(h, "google");
      h.claims = googleClaims(attempt.nonce, h.now(), { email });
      expect(cookieOf(await finishGoogle(h, attempt), "afo_owner")).toBeTruthy();
      const login = await fetch(`${h.baseUrl}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password }) });
      expect(login.status, email).toBe(303);
    }
  });
});

describe("email link details", () => {
  it("lands on the page the owner asked from, inside the app only", async () => {
    const h = await harness();
    await ownerAccount(h, "owner@synthetic.example");
    const login = await (await fetch(`${h.baseUrl}/login?next=/app/settings/data`)).text();
    expect(login).toMatch(/action="\/login\/email"><input type="hidden" name="next" value="\/app\/settings\/data">/);
    await requestLink(h, "owner@synthetic.example", "/app/settings/data");
    const [link] = await queuedLinks(h);
    expect(link!.url).toBe(`${BASE}/login/link?token=${link!.token}&next=%2Fapp%2Fsettings%2Fdata`);
    const page = await (await fetch(`${h.baseUrl}/login/link?token=${link!.token}&next=%2Fapp%2Fsettings%2Fdata`)).text();
    expect(page).toContain('<input type="hidden" name="next" value="/app/settings/data">');
    expect((await useLink(h, link!.token, "/app/settings/data")).headers.get("location")).toBe("/app/settings/data");

    h.store.notifications.clear();
    await requestLink(h, "owner@synthetic.example", "https://evil.example/app");
    const [evil] = await queuedLinks(h);
    expect(evil!.url).not.toContain("next=");
    expect((await useLink(h, evil!.token, "//evil.example/app")).headers.get("location")).toBe("/app");
  });

  it("purges day-old link emails to addresses with no shop, and leaves a shop's alone", async () => {
    const h = await harness();
    await ownerAccount(h, "owner@synthetic.example");
    await requestLink(h, "stranger@synthetic.example");
    await requestLink(h, "owner@synthetic.example");
    expect((await queuedLinks(h)).map((link) => link.tenantId).filter((tenant) => tenant === "owner-sign-in").length).toBe(1);
    h.advance(25 * 60 * 60_000);
    await requestLink(h, "someone@synthetic.example");
    const left = await queuedLinks(h);
    expect(left.map((link) => link.to).sort()).toEqual(["owner@synthetic.example", "someone@synthetic.example"]);
  });

  it("doesn't point at the email link when email isn't set up", async () => {
    const h = await harness({ RESEND_API_KEY: "", RESEND_FROM_EMAIL: "" });
    const attempt = await start(h, "google");
    h.claims = googleClaims(attempt.nonce, h.now(), { email_verified: false });
    const text = await (await finishGoogle(h, attempt)).text();
    expect(text).toContain("Google hasn’t verified that email. Try another way in.");
    expect(text).not.toContain("email link");
  });
});

describe("in-app browsers", () => {
  it("hide Continue with Google in the Instagram, Facebook and TikTok browsers, and keep the rest", async () => {
    const h = await harness({ MICROSOFT_CLIENT_ID: MICROSOFT_CLIENT, MICROSOFT_CLIENT_SECRET: "synthetic-microsoft-secret" });
    const inApp = [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101 (iPhone15,3; iOS 18_1; en_US)",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/488.0.0.40.103;FBBV/1]",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_37.5.0 JsSdk/2.0 NetType/WIFI Channel/App Store",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36",
    ];
    for (const ua of inApp) {
      for (const path of ["/login", "/signup"]) {
        const page = await (await fetch(`${h.baseUrl}${path}`, { headers: { "user-agent": ua } })).text();
        expect(page, `${path} ${ua}`).not.toContain("Continue with Google");
        expect(page).toContain("Continue with Microsoft");
      }
    }
    const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
    expect(await (await fetch(`${h.baseUrl}/signup`, { headers: { "user-agent": safari } })).text()).toContain("Continue with Google");
  });
});
