import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * When Otto's AI setup helper can't finish, Brock (the founder) emails the owner a link to book a 10-minute call.
 * Everything here is pure: signed links, Brock's booking windows, open times, and the words in the emails.
 */

export const FOUNDER_CALL_MINUTES = 10;
export const FOUNDER_LEAD_MINUTES = 60;
export const FOUNDER_BUFFER_MINUTES = 5;
export const FOUNDER_BOOKING_DAYS = 5;
export const FOUNDER_BOOKING_LINK_DAYS = 7;
export const FOUNDER_CONNECT_LINK_MAX_MS = 24 * 60 * 60_000;
const SLOT_STEP_MINUTES = 15;
const SLOTS_PER_DAY = 3;
const SCAN_DAYS = 21;

export type FounderTokenPurpose = "founder-booking" | "founder-connect" | "review-account";

/** A signed link payload: `base64url(json).hmac`. The purpose is part of the HMAC, so one kind never passes as another. */
export function signFounderToken(key: string, purpose: FounderTokenPurpose, data: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${mac(key, purpose, payload)}`;
}

export function readFounderToken(key: string, purpose: FounderTokenPurpose, token: string | null | undefined, now: Date): Record<string, unknown> | null {
  if (!token || token.length > 600) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(key, purpose, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof data.exp !== "number" || data.exp <= now.getTime()) return null;
    return data;
  } catch {
    return null;
  }
}

function mac(key: string, purpose: FounderTokenPurpose, payload: string): string {
  return createHmac("sha256", key).update(`${purpose}:${payload}`).digest("base64url");
}

/** The link in Brock's email: this shop, good for 7 days. */
export function founderBookingToken(key: string, tenantId: string, now: Date): string {
  return signFounderToken(key, "founder-booking", { t: tenantId, exp: now.getTime() + FOUNDER_BOOKING_LINK_DAYS * 24 * 60 * 60_000 });
}

export function readFounderBookingToken(key: string, token: string | null | undefined, now: Date): { tenantId: string } | null {
  const data = readFounderToken(key, "founder-booking", token, now);
  return data && typeof data.t === "string" && /^[\w-]{1,80}$/.test(data.t) ? { tenantId: data.t } : null;
}

/** Opens the founder-calendar connect flow without an admin session. Never longer than 24 hours. */
export function founderConnectToken(key: string, now: Date, ttlMs = FOUNDER_CONNECT_LINK_MAX_MS): string {
  return signFounderToken(key, "founder-connect", { exp: now.getTime() + Math.min(Math.max(ttlMs, 60_000), FOUNDER_CONNECT_LINK_MAX_MS) });
}

export function founderConnectTokenValid(key: string, token: string | null | undefined, now: Date): boolean {
  const data = readFounderToken(key, "founder-connect", token, now);
  return data !== null && (data.exp as number) <= now.getTime() + FOUNDER_CONNECT_LINK_MAX_MS + 60_000;
}

// ---- Brock's booking windows ----

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Weekday (0 = Sunday) → minute-of-day ranges, start inclusive, end exclusive. */
export type BookingWindows = Map<number, Array<[number, number]>>;

/** "Mon-Fri 10:00-12:00,14:00-17:00" (groups may be joined with ";", e.g. "...; Sat 10:00-11:00"). Throws when it can't be read. */
export function parseBookingWindows(spec: string): BookingWindows {
  const windows: BookingWindows = new Map();
  for (const group of spec.split(";").map((part) => part.trim()).filter(Boolean)) {
    const match = /^(\S+)\s+(\S+)$/.exec(group.replace(/\s*,\s*/g, ","));
    if (!match) throw new Error(`Booking window "${group}" must look like "Mon-Fri 10:00-12:00,14:00-17:00"`);
    const days = new Set<number>();
    for (const item of match[1]!.toLowerCase().split(",")) {
      const [from, to] = item.split("-");
      const start = DAY_NAMES.indexOf((from ?? "").slice(0, 3));
      const end = to === undefined ? start : DAY_NAMES.indexOf(to.slice(0, 3));
      if (start < 0 || end < 0) throw new Error(`Unknown day in booking window "${group}"`);
      for (let day = start; ; day = (day + 1) % 7) { days.add(day); if (day === end) break; }
    }
    const ranges: Array<[number, number]> = [];
    for (const item of match[2]!.split(",")) {
      const range = /^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-4]):([0-5]\d)$/.exec(item);
      if (!range) throw new Error(`Booking time "${item}" must look like 10:00-12:00`);
      const from = Number(range[1]) * 60 + Number(range[2]);
      const to = Number(range[3]) * 60 + Number(range[4]);
      if (to <= from || to > 24 * 60) throw new Error(`Booking time "${item}" must end after it starts`);
      ranges.push([from, to]);
    }
    for (const day of days) windows.set(day, [...(windows.get(day) ?? []), ...ranges].sort((a, b) => a[0] - b[0]));
  }
  if (windows.size === 0) throw new Error("Booking windows are empty");
  return windows;
}

// ---- Time zones ----

interface ZoneParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function zoneParts(ms: number, timeZone: string): ZoneParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour") % 24, minute: read("minute"), second: read("second") };
}

function offsetAt(ms: number, timeZone: string): number {
  const parts = zoneParts(ms, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(ms / 1_000) * 1_000;
}

/** The instant a wall-clock time happens in a zone (DST-aware). */
export function zonedTimeToUtc(year: number, month: number, day: number, minuteOfDay: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  return second;
}

export interface FounderSlot { start: string; end: string }
export interface BusyPeriod { start: string; end: string }

interface SlotInput {
  now: Date;
  windows: BookingWindows;
  timeZone: string;
  busy?: BusyPeriod[];
  days?: number;
  leadMinutes?: number;
  bufferMinutes?: number;
  durationMinutes?: number;
}

/**
 * Every 10-minute start inside Brock's windows (on the quarter hour) over the next `days` business days that still
 * have a start after the lead time, grouped by day. Business days are the window days, in Brock's own zone.
 */
function candidatesByDay(input: SlotInput): Array<Array<{ start: number; end: number }>> {
  const duration = (input.durationMinutes ?? FOUNDER_CALL_MINUTES) * 60_000;
  const earliest = input.now.getTime() + (input.leadMinutes ?? FOUNDER_LEAD_MINUTES) * 60_000;
  const today = zoneParts(input.now.getTime(), input.timeZone);
  const result: Array<Array<{ start: number; end: number }>> = [];
  for (let offset = 0; offset < SCAN_DAYS && result.length < (input.days ?? FOUNDER_BOOKING_DAYS); offset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const ranges = input.windows.get(date.getUTCDay());
    if (!ranges) continue;
    const day: Array<{ start: number; end: number }> = [];
    for (const [from, to] of ranges) {
      for (let minute = from; minute * 60_000 + duration <= to * 60_000; minute += SLOT_STEP_MINUTES) {
        const start = zonedTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), minute, input.timeZone);
        if (start >= earliest) day.push({ start, end: start + duration });
      }
    }
    if (day.length > 0) result.push(day);
  }
  return result;
}

export function overlapsBusy(slot: { start: number; end: number }, busy: BusyPeriod[], bufferMinutes = FOUNDER_BUFFER_MINUTES): boolean {
  const buffer = bufferMinutes * 60_000;
  return busy.some((period) => slot.start - buffer < Date.parse(period.end) && slot.end + buffer > Date.parse(period.start));
}

/** About three evenly spread open times per business day, each clear of every busy block by the buffer. */
export function founderSlots(input: SlotInput): FounderSlot[] {
  const busy = input.busy ?? [];
  const slots: FounderSlot[] = [];
  for (const day of candidatesByDay(input)) {
    const free = day.filter((slot) => !overlapsBusy(slot, busy, input.bufferMinutes));
    const picks = free.length <= SLOTS_PER_DAY
      ? free
      : [...new Set(Array.from({ length: SLOTS_PER_DAY }, (_, index) => Math.round(index * (free.length - 1) / (SLOTS_PER_DAY - 1))))].map((index) => free[index]!);
    for (const slot of picks) slots.push({ start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString() });
  }
  return slots;
}

/** A start the owner may pick: inside the windows, on the grid, after the lead time, within the booking days. */
export function founderSlotAllowed(start: string, input: Omit<SlotInput, "busy">): FounderSlot | null {
  const at = Date.parse(start);
  if (!Number.isFinite(at)) return null;
  for (const day of candidatesByDay(input)) {
    const found = day.find((slot) => slot.start === at);
    if (found) return { start: new Date(found.start).toISOString(), end: new Date(found.end).toISOString() };
  }
  return null;
}

/** "Tue, Dec 2" in the owner's zone. */
export function slotDayLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
}

/** "10:30 AM" in the owner's zone. */
export function slotTimeLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso)).replace(/ /g, " ");
}

/** "EST", "CDT", "MST": the short name of the owner's zone at that moment. */
export function zoneLabel(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(iso));
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

/** "Tue, Dec 2 at 10:30 AM EST". */
export function slotFullLabel(iso: string, timeZone: string): string {
  return `${slotDayLabel(iso, timeZone)} at ${slotTimeLabel(iso, timeZone)} ${zoneLabel(iso, timeZone)}`;
}

// ---- Words ----

export type FounderFollowupReason = "call_unavailable" | "helper_failed" | "no_answer" | "not_confirmed" | "limit";

/** "Mike" from "Mike Rivera"; nothing for the signup placeholder or a blank name. */
export function ownerFirstName(displayName: string | null | undefined): string | null {
  const name = (displayName ?? "").trim();
  if (!name || /^(shop owner|demo owner|owner)$/i.test(name)) return null;
  const first = name.split(/\s+/)[0]!.replace(/[^\p{L}'-]/gu, "");
  return first.length >= 2 && first.length <= 30 ? first : null;
}

function greeting(firstName: string | null): string {
  return firstName ? `Hi ${firstName},` : "Hi there,";
}

const SIGNATURE = "Brock\nFounder, Call Otto";

function whatHappened(reason: FounderFollowupReason, businessName: string): string {
  switch (reason) {
    case "call_unavailable": return `You asked for help turning on call forwarding for ${businessName}, and our setup helper couldn't call you.`;
    case "helper_failed": return "Our setup helper couldn't start on your call just now.";
    case "no_answer": return `Our setup helper called you about call forwarding for ${businessName} and didn't reach you.`;
    case "not_confirmed": return `I don't see call forwarding working for ${businessName} yet.`;
    case "limit": return `Otto has called you a few times today about call forwarding for ${businessName}.`;
  }
}

/** Brock's note to the owner. With no founder calendar connected, it asks for a reply instead of sending a link. */
export function founderFollowupEmail(input: { firstName: string | null; businessName: string; reason: FounderFollowupReason; link: string | null }): { subject: string; text: string } {
  const ask = input.link
    ? `I'll walk you through it myself. Pick a time for a quick 10-minute call:\n\n${input.link}`
    : "I'll walk you through it myself. Just reply with a good time for a quick 10-minute call.";
  return {
    subject: "Quick call to finish your Call Otto setup",
    text: `${greeting(input.firstName)}\n\n${whatHappened(input.reason, input.businessName)}\n\n${ask}\n\n${SIGNATURE}`,
  };
}

export function founderConfirmationEmail(input: { firstName: string | null; businessName: string; when: string; callNumber: string | null }): { subject: string; text: string } {
  const call = input.callNumber ? `I'll call you at ${input.callNumber}` : "Reply with the best number to reach you and I'll call you";
  return {
    subject: `You're set: ${input.when}`,
    text: `${greeting(input.firstName)}\n\nYou're set for ${input.when}. ${call}, and we'll get call forwarding on for ${input.businessName}. It takes about 10 minutes.\n\nNeed a different time? Just reply.\n\n${SIGNATURE}`,
  };
}

/** A calendar file for the owner. No organizer or attendees, so it carries no one's email address. */
export function founderCallIcs(input: { uid: string; start: string; end: string; now: Date; summary: string; description: string }): string {
  const stamp = (iso: string): string => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const text = (value: string): string => value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Call Otto//Setup call//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${input.uid}@callotto`,
    `DTSTAMP:${stamp(input.now.toISOString())}`,
    `DTSTART:${stamp(new Date(input.start).toISOString())}`,
    `DTEND:${stamp(new Date(input.end).toISOString())}`,
    `SUMMARY:${text(input.summary)}`,
    `DESCRIPTION:${text(input.description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** "(941) 555-0199" for US numbers. */
export function prettyPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}

/** "b***@gmail.com": enough for Brock to tell his accounts apart, never the whole address on a page. */
export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  if (!domain) return "Google account";
  return `${user.slice(0, 1)}***@${domain}`;
}
