import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 1_000_000;

export async function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function parseForm(raw: string): URLSearchParams {
  return new URLSearchParams(raw);
}

export function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; base-uri 'none'; frame-ancestors 'none'");
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

export function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

export function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location });
  response.end();
}

export function bearerMatches(request: IncomingMessage, secret: string): boolean {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") === true && constantTimeEqual(header.slice(7), secret);
}

export function mintAdminSession(adminToken: string, now = Date.now(), ttlMs = 8 * 60 * 60_000): string {
  const expires = String(now + ttlMs);
  return `v1.${expires}.${sign(adminToken, `session:${expires}`)}`;
}

export function verifyAdminSession(value: string | undefined, adminToken: string, now = Date.now()): boolean {
  if (!value) return false;
  const [version, expires, signature] = value.split(".");
  if (version !== "v1" || !expires || !signature || Number(expires) <= now) return false;
  return constantTimeEqual(signature, sign(adminToken, `session:${expires}`));
}

export function csrfForSession(session: string, adminToken: string): string {
  return sign(adminToken, `csrf:${session}`);
}

export function verifyCsrf(session: string, supplied: string | null, adminToken: string): boolean {
  return supplied !== null && constantTimeEqual(supplied, csrfForSession(session, adminToken));
}

export function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const segment of header.split(";")) {
    const index = segment.indexOf("=");
    if (index < 0) continue;
    if (segment.slice(0, index).trim() === name) return decodeURIComponent(segment.slice(index + 1).trim());
  }
  return undefined;
}

export function adminCookie(session: string, secure: boolean): string {
  return `afo_admin=${encodeURIComponent(session)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? "; Secure" : ""}`;
}

export function createGoogleOAuthAttempt(adminToken: string, secure: boolean, now = Date.now(), cookiePath = "/admin/integrations/google"): {
  state: string;
  challenge: string;
  cookie: string;
} {
  const payload = Buffer.from(JSON.stringify({ nonce: randomBytes(18).toString("base64url"), expires: now + 10 * 60_000 })).toString("base64url");
  const state = `${payload}.${sign(adminToken, `google-oauth:${payload}`)}`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const cookieValue = Buffer.from(JSON.stringify({ state, verifier })).toString("base64url");
  const cookie = `afo_google_pkce=${cookieValue}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`;
  return { state, challenge, cookie };
}

export function verifyGoogleOAuthAttempt(state: string | null, cookieValue: string | undefined, adminToken: string, now = Date.now()): string | null {
  if (!state || !cookieValue) return null;
  const [payload, signature] = state.split(".");
  if (!payload || !signature || !constantTimeEqual(signature, sign(adminToken, `google-oauth:${payload}`))) return null;
  try {
    const stateData = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { expires?: number };
    const cookieData = JSON.parse(Buffer.from(cookieValue, "base64url").toString("utf8")) as { state?: string; verifier?: string };
    if (typeof stateData.expires !== "number" || stateData.expires <= now || typeof cookieData.verifier !== "string") return null;
    if (typeof cookieData.state !== "string" || !constantTimeEqual(cookieData.state, state)) return null;
    return cookieData.verifier;
  } catch {
    return null;
  }
}

export function clearGoogleOAuthCookie(secure: boolean, cookiePath = "/admin/integrations/google"): string {
  return `afo_google_pkce=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export class RateLimiter {
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maxBuckets = 10_000) {}

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    if (this.#buckets.size >= this.maxBuckets) {
      for (const [bucketKey, bucket] of this.#buckets) {
        if (bucket.resetAt <= now) this.#buckets.delete(bucketKey);
      }
      // Evict the oldest bucket instead of refusing every new client: a flood of
      // unique keys must not lock legitimate owners out.
      if (this.#buckets.size >= this.maxBuckets && !this.#buckets.has(key)) {
        const oldest = this.#buckets.keys().next().value;
        if (oldest !== undefined) this.#buckets.delete(oldest);
      }
    }
    const current = this.#buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.#buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }
}

/**
 * Railway's edge overwrites X-Forwarded-For/X-Real-IP (verified 2026-11-23: spoofed
 * values did not bypass the live login limit). Re-verify if a CDN is added in front.
 */
export function requestIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || request.socket.remoteAddress || "unknown";
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}
