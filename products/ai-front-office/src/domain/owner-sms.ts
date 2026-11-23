import { createHmac, timingSafeEqual } from "node:crypto";
import type { CallRecord } from "./models.js";

/**
 * The owner's new-call text. Short lines that wrap well on a phone, a blank line before the link,
 * GSM-7 only (no ¢, no curly quotes, no "·") so it stays cheap and renders everywhere, and never the
 * caller's phone number (carrier rule): the link opens a page with a big Call button instead.
 *
 *   Front Office - Suncoast Heating
 *   New call: Maria G.
 *   AC not cooling
 *   41 Palm Ave, Sarasota
 *   Wants someone today
 *
 *   Call back: https://…/c/…
 *
 * Urgent and emergency calls start with "URGENT: {reason}".
 */
export function ownerCallSms(input: { shop: string; call: Pick<CallRecord, "fields" | "emergency">; urgentReason?: string | null; wants?: string | null; link: string }): string {
  const lines = [
    ...(input.urgentReason ? [`URGENT: ${clip(gsm7(input.urgentReason), 40)}`] : []),
    `Front Office - ${clip(gsm7(input.shop), 40)}`,
    `New call: ${callerShortName(input.call.fields.callerName)}`,
    clip(gsm7(input.call.fields.problemDescription) || "Problem not captured", 40),
    ...(streetAndCity(input.call.fields.address) ? [streetAndCity(input.call.fields.address)!] : []),
    ...(input.wants ? [gsm7(input.wants)] : []),
    "",
    `Call back: ${input.link}`,
  ];
  return lines.join("\n");
}

/** Why an urgent text is urgent, in a few words: the emergency evidence, or that the caller asked for the owner. */
export function urgentReason(call: Pick<CallRecord, "emergency" | "fields">, humanRequested: boolean): string | null {
  const emergency = call.emergency;
  if (emergency?.emergency) {
    const evidence = emergency.evidence.find((item) => item.trim());
    if (emergency.severity === "life_safety") return evidence ? `safety risk, ${evidence}` : "safety risk";
    return evidence ?? "emergency";
  }
  return humanRequested ? "caller asked for you" : null;
}

/** "Maria Gonzalez" → "Maria G."; one name stays as is; nothing → "Unknown caller". */
export function callerShortName(name: string | null): string {
  const parts = gsm7(name ?? "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Unknown caller";
  const first = clip(parts[0]!, 20);
  const last = parts.length > 1 ? parts.at(-1)!.replace(/[^A-Za-z]/g, "").charAt(0).toUpperCase() : "";
  return last ? `${first} ${last}.` : first;
}

/** "41 Palm Ave, Sarasota, FL 34236" → "41 Palm Ave, Sarasota". */
export function streetAndCity(address: string | null): string | null {
  const parts = gsm7(address ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return clip(parts.slice(0, 2).join(", "), 44);
}

const GSM7_SAFE = /[^A-Za-z0-9 !"#%&'()*+,\-./:;<=>?@$_\n]/g;
/** Plain GSM-7: accents dropped, smart quotes and dashes straightened, anything else removed. */
export function gsm7(value: string): string {
  return value
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—·•]/g, "-").replace(/…/g, "...")
    .replace(/[\r\t]+/g, " ").replace(/\n+/g, " ")
    .replace(GSM7_SAFE, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** At most `max` characters, cut at a word where possible, with "..." when cut. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[ ,.;:-]+$/, "")}...`;
}

const LINK_DAYS = 7;

/**
 * A call-back link that works from the text without signing in: the call id plus an expiry, signed with the
 * server key over the shop id too, so it only opens that shop's call and stops working after 7 days.
 */
export function callbackLinkToken(input: { tenantId: string; callId: string; now: Date; key: string }): string {
  const id = Buffer.from(input.callId.replace(/-/g, ""), "hex").toString("base64url");
  const expires = Math.floor(input.now.getTime() / 1_000 + LINK_DAYS * 86_400).toString(36);
  return `${id}.${expires}.${signature(input.key, input.tenantId, input.callId, expires)}`;
}

/** The call id a token names, if it is well formed and not expired. The caller must still check the signature against the call's shop. */
export function readCallbackLinkToken(token: string, now: Date): { callId: string; expires: string; signature: string } | null {
  const match = /^([A-Za-z0-9_-]{22})\.([0-9a-z]{1,10})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!match) return null;
  const hex = Buffer.from(match[1]!, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  if (parseInt(match[2]!, 36) * 1_000 < now.getTime()) return null;
  const callId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { callId, expires: match[2]!, signature: match[3]! };
}

/** True when the token was made for this call in this shop with this server's key. */
export function callbackLinkMatches(parsed: { callId: string; expires: string; signature: string }, tenantId: string, key: string): boolean {
  const expected = Buffer.from(signature(key, tenantId, parsed.callId, parsed.expires));
  const given = Buffer.from(parsed.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function signature(key: string, tenantId: string, callId: string, expires: string): string {
  return createHmac("sha256", key).update(`callback-link:${tenantId}:${callId}:${expires}`).digest().subarray(0, 16).toString("base64url");
}
