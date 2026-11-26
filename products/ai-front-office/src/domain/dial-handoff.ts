import { readFounderToken, signFounderToken } from "./founder-booking.js";

/**
 * The QR on the computer's forwarding screen: a short-lived signed link that shows this shop's forwarding code on
 * the phone that scans it, with no sign-in in the way. It shows the code and nothing else, and expires quickly.
 */
export const DIAL_HANDOFF_TTL_MS = 15 * 60_000;

export function dialHandoffToken(key: string, tenantId: string, now: Date): string {
  return signFounderToken(key, "dial-handoff", { t: tenantId, exp: now.getTime() + DIAL_HANDOFF_TTL_MS });
}

export function readDialHandoffToken(key: string, token: string | null | undefined, now: Date): { tenantId: string } | null {
  const data = readFounderToken(key, "dial-handoff", token, now);
  if (!data || typeof data.t !== "string" || !/^[\w-]{1,80}$/.test(data.t)) return null;
  // Never honour a token minted to last longer than the TTL (a key leak can't make a forever link through this path).
  return (data.exp as number) <= now.getTime() + DIAL_HANDOFF_TTL_MS + 60_000 ? { tenantId: data.t } : null;
}

/**
 * The short form the QR and the "Email me these steps" link carry: /d/<id>, 8 letters and digits (about 47 bits),
 * stored server side with the shop and an expiry. Short enough for a small, sparse QR a phone camera reads at once.
 */
export const SHORT_HANDOFF_PREFIX = "/d/";
/** An emailed link is opened later than a scanned QR: it lasts a day. It shows only the shop's forwarding code. */
export const EMAILED_HANDOFF_TTL_MS = 24 * 60 * 60_000;
export const HANDOFF_PROVIDER = "dial-handoff";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A fresh short id from `bytes` (random), letters and digits that never look alike (no 0/O, 1/l/I). */
export function shortHandoffId(bytes: Uint8Array): string {
  let id = "";
  for (let index = 0; index < 8; index += 1) id += ALPHABET[(bytes[index] ?? 0) % ALPHABET.length];
  return id;
}

export function isShortHandoffId(value: string): boolean {
  return /^[A-Za-z0-9]{8}$/.test(value);
}

export function shortHandoffRecord(tenantId: string, now: Date, ttlMs: number = DIAL_HANDOFF_TTL_MS): string {
  return JSON.stringify({ t: tenantId, exp: now.getTime() + ttlMs });
}

/** The shop a stored short id opens, while it's fresh. */
export function readShortHandoff(value: string | null, now: Date): { tenantId: string } | null {
  if (!value) return null;
  try {
    const data = JSON.parse(value) as { t?: unknown; exp?: unknown };
    if (typeof data.t !== "string" || !/^[\w-]{1,80}$/.test(data.t) || typeof data.exp !== "number") return null;
    return data.exp > now.getTime() ? { tenantId: data.t } : null;
  } catch {
    return null;
  }
}
