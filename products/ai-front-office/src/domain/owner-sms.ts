import { createHmac, timingSafeEqual } from "node:crypto";
import type { CallRecord } from "./models.js";

/**
 * The owner's new-call text. It names the sender first ("Front Office: "), then short "- " lines that wrap well on a phone, a blank line before the link,
 * GSM-7 only (no ¢, no curly quotes, no "·") so it stays cheap and renders everywhere, the caller's first name
 * only, and never the caller's phone number (carrier rule): the link opens a page with a big Call button instead.
 *
 *   Front Office: New call: Maria
 *   - AC not cooling
 *   - 41 Palm Ave, Sarasota
 *   - Wants someone today
 *
 *   Call back: https://.../c/...
 *
 * When the AI booked a time, the last bullet is "- Booked tomorrow 10a" and the link reads "Confirmation:".
 * Urgent and emergency calls start with a "Front Office: URGENT: {reason}" line, then "New call: ..." and the same lines.
 * The STOP line is added at send time, only on the first owner text a number ever gets (see withOwnerSmsCompliance).
 */
export function ownerCallSms(input: { call: Pick<CallRecord, "fields" | "emergency">; urgentReason?: string | null; wants?: string | null; booked?: string | null; link: string }): string {
  const place = streetAndCity(input.call.fields.address);
  const next = input.booked ? `Booked ${gsm7(input.booked)}` : input.wants ? gsm7(input.wants) : null;
  const lines = [
    ...(input.urgentReason ? [`URGENT: ${clip(gsm7(input.urgentReason), 40)}`] : []),
    `New call: ${callerFirstName(input.call.fields.callerName)}`,
    `- ${clip(gsm7(input.call.fields.problemDescription) || "Problem not captured", 40)}`,
    ...(place ? [`- ${place}`] : []),
    ...(next ? [`- ${next}`] : []),
    "",
    `${input.booked ? "Confirmation" : "Call back"}: ${input.link}`,
  ];
  return `${OWNER_SMS_PREFIX}${lines.join("\n")}`;
}

/** Every owner text names the sender first. */
export const OWNER_SMS_PREFIX = "Front Office: ";
/** Added as the last line of the first owner text a number ever gets, and of the first one after it re-subscribes. */
export const OWNER_SMS_STOP_LINE = "Reply STOP to opt out";
/** Sent once when an owner opts in to texts. Matches the opt-in message registered with the carriers. */
export const OWNER_SMS_OPT_IN_CONFIRMATION = "Front Office by Dutchworks: You're subscribed to Front Office account notifications. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel.";

/** True when the text already tells the reader how to stop texts. */
export function hasStopLanguage(body: string): boolean {
  return /\bSTOP\b/.test(body);
}

/** "Front Office: " in front of any owner text that does not already start with the brand. */
export function brandOwnerSms(body: string): string {
  return /^Front Office\b/.test(body) ? body : `${OWNER_SMS_PREFIX}${body}`;
}

/** The text an owner actually receives: branded, with the STOP line when this text carries the number's opt-out notice. */
export function withOwnerSmsCompliance(body: string, stopNotice: boolean): string {
  const branded = brandOwnerSms(body);
  return stopNotice && !hasStopLanguage(branded) ? `${branded}\n${OWNER_SMS_STOP_LINE}` : branded;
}

/**
 * A time the way a text says it, in the shop's timezone: "today 3p", "tomorrow 10a", "tomorrow 10:30a",
 * "Wed 2p" within the week, "Dec 4 12p" after that.
 */
export function shortWhen(iso: string, now: Date, timeZone: string): string {
  const at = new Date(iso);
  const parts = (value: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hourCycle: "h23", weekday: "short" })
    .formatToParts(value).map((part) => [part.type, part.value])) as Record<string, string>;
  const when = parts(at);
  const today = parts(now);
  const dayNumber = (p: Record<string, string>) => Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86_400_000;
  const days = dayNumber(when) - dayNumber(today);
  const hour = Number(when.hour) % 24;
  const minute = Number(when.minute);
  const time = `${hour % 12 === 0 ? 12 : hour % 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${hour < 12 ? "a" : "p"}`;
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days > 1 && days < 7) return `${when.weekday} ${time}`;
  const month = new Intl.DateTimeFormat("en-US", { timeZone, month: "short" }).format(at);
  return `${month} ${Number(when.day)} ${time}`;
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

/** "Maria Gonzalez" → "Maria" (first name only); nothing → "Unknown caller". */
export function callerFirstName(name: string | null): string {
  const first = gsm7(name ?? "").split(/\s+/).filter(Boolean)[0];
  return first ? clip(first, 20) : "Unknown caller";
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
