import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { OwnerAccount } from "../domain/models.js";

const scrypt = promisify(scryptCallback);
const PASSWORD_BYTES = 32;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface OwnerSession {
  accountId: string;
  tenantId: string;
  csrf: string;
  expiresAt: number;
}

export async function hashOwnerPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, PASSWORD_BYTES) as Buffer;
  return `scrypt-v1:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export async function verifyOwnerPassword(password: string, encoded: string): Promise<boolean> {
  const [version, saltText, hashText] = encoded.split(":");
  if (version !== "scrypt-v1" || !saltText || !hashText) return false;
  try {
    const expected = Buffer.from(hashText, "base64url");
    const derived = await scrypt(password, Buffer.from(saltText, "base64url"), expected.length) as Buffer;
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

export function mintOwnerSession(account: Pick<OwnerAccount, "id" | "tenantId">, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({
    accountId: account.id,
    tenantId: account.tenantId,
    csrf: randomBytes(18).toString("base64url"),
    expiresAt: now + SESSION_TTL_SECONDS * 1_000,
  })).toString("base64url");
  return `v1.${payload}.${sign(secret, payload)}`;
}

export function verifyOwnerSession(value: string | undefined, secret: string, now = Date.now()): OwnerSession | null {
  if (!value) return null;
  const [version, payload, signature] = value.split(".");
  if (version !== "v1" || !payload || !signature || !constantTimeEqual(signature, sign(secret, payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<OwnerSession>;
    if (typeof parsed.accountId !== "string" || typeof parsed.tenantId !== "string" || typeof parsed.csrf !== "string") return null;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) return null;
    return parsed as OwnerSession;
  } catch {
    return null;
  }
}

export function ownerSessionCookie(session: string, secure: boolean): string {
  return `afo_owner=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearOwnerSessionCookie(secure: boolean): string {
  return `afo_owner=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function verifyOwnerCsrf(session: OwnerSession, supplied: string | null): boolean {
  return supplied !== null && constantTimeEqual(session.csrf, supplied);
}

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(`owner-session:${value}`).digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
