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
