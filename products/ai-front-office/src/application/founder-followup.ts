import { randomUUID } from "node:crypto";
import type { Environment } from "../config/environment.js";
import { formatEmailBody } from "../adapters/resend.js";
import type { FounderCalendars } from "../adapters/founder-calendar.js";
import {
  FOUNDER_BUFFER_MINUTES,
  founderBookingToken,
  founderCallIcs,
  founderConfirmationEmail,
  founderFollowupEmail,
  founderSlotAllowed,
  founderSlots,
  ownerFirstName,
  parseBookingWindows,
  prettyPhone,
  slotFullLabel,
  type FounderFollowupReason,
  type FounderSlot,
} from "../domain/founder-booking.js";
import type { Clock, Store } from "../ports.js";

/** At most one founder email per shop in this long. */
export const FOUNDER_FOLLOWUP_GAP_MS = 24 * 60 * 60_000;
/** Forwarding still not confirmed this long after "Set it up with me": Brock emails. */
export const FOUNDER_FOLLOWUP_AFTER_MS = 20 * 60_000;
/** The loop only looks back this far, so an old request never gets a surprise email (after a deploy, say). */
export const FOUNDER_FOLLOWUP_MAX_AGE_MS = 6 * 60 * 60_000;
const PROVIDER = "founder";

export interface FounderBookingFacts {
  ownerName: string | null;
  email: string;
  businessName: string;
  timezone: string;
  callNumber: string | null;
  businessNumber: string | null;
  carrier: string | null;
  forwardingCode: string | null;
  ottoNumber: string | null;
}

export interface FounderEmailSent { sentAt: string; link: boolean }

export type BookResult =
  | { status: "booked"; slot: FounderSlot }
  | { status: "taken" }
  | { status: "invalid" }
  | { status: "no_calendar" };

/**
 * Brock's personal follow-up when the AI setup helper can't finish: one email per shop per 24 hours with a link to
 * book a 10-minute call in his open times, then the booking itself.
 */
export class FounderFollowup {
  readonly windows;

  constructor(private readonly deps: {
    store: Store;
    env: Environment;
    clock: Clock;
    calendars: FounderCalendars;
    log: (entry: Record<string, unknown>) => void;
  }) {
    this.windows = parseBookingWindows(deps.env.FOUNDER_BOOKING_WINDOWS);
  }

  private get emailReady(): boolean {
    return Boolean(this.deps.env.RESEND_API_KEY && this.deps.env.RESEND_FROM_EMAIL);
  }

  /**
   * Queue Brock's email now, unless this shop already got one in the last 24 hours. Locked per shop, and the outbox
   * key is tied to the help request, so replicas and repeat triggers (no answer, then the 20-minute loop) send one.
   */
  async queue(tenantId: string, reason: FounderFollowupReason): Promise<"queued" | "recent" | "duplicate" | "skipped"> {
    const { store, clock, env, log } = this.deps;
    if (!this.emailReady) {
      log({ level: "warn", event: "founder_followup_email_unconfigured", tenantId, reason });
      return "skipped";
    }
    return store.withLock(`founder-followup:${tenantId}`, async () => {
      const now = clock.now();
      const last = await store.getIntegrationSecret(tenantId, PROVIDER, "followup_sent_at");
      if (last && now.getTime() - Date.parse(last) < FOUNDER_FOLLOWUP_GAP_MS) return "recent";
      const account = await store.getOwnerAccountByTenant(tenantId);
      if (!account || account.status === "suspended") return "skipped";
      const [config, helpRequestedAt, connected] = await Promise.all([
        store.getConfig(tenantId),
        store.getIntegrationSecret(tenantId, "forwarding", "help_requested_at"),
        this.deps.calendars.connected().catch(() => false),
      ]);
      const link = connected && env.SESSION_SIGNING_KEY
        ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/book-setup?t=${encodeURIComponent(founderBookingToken(env.SESSION_SIGNING_KEY, tenantId, now))}`
        : null;
      if (!link) log({ level: "warn", event: "founder_calendar_not_connected", tenantId, reason });
      const email = founderFollowupEmail({ firstName: ownerFirstName(account.displayName), businessName: config.businessName, reason, link });
      const at = now.toISOString();
      const queued = await store.enqueueNotification({
        id: randomUUID(), tenantId, callId: null, channel: "email", senderRef: "founder", destinationRef: `email:${account.email}`,
        body: formatEmailBody(email.subject, email.text),
        priority: "high", state: "pending", attempts: 0, nextAttemptAt: at,
        // One per help request; with no request on file, one per 24-hour window.
        idempotencyKey: `founder-followup:${tenantId}:${helpRequestedAt ?? Math.floor(now.getTime() / FOUNDER_FOLLOWUP_GAP_MS)}`,
        providerReceipt: null, lastError: null, createdAt: at, sentAt: null,
      });
      if (!queued) return "duplicate";
      await store.saveIntegrationSecret(tenantId, PROVIDER, "followup_sent_at", at);
      // So the app, the 429 message and the spoken apology only mention a booking link when this email has one.
      await store.saveIntegrationSecret(tenantId, PROVIDER, "followup_link", link ? "yes" : "no");
      log({ level: "info", event: "founder_followup_queued", tenantId, reason, bookingLink: Boolean(link) });
      return "queued";
    });
  }

  /** Same as queue, but never throws: a follow-up must not break the request or webhook that triggered it. */
  async queueSafely(tenantId: string, reason: FounderFollowupReason): Promise<void> {
    await this.queue(tenantId, reason).catch((error: unknown) => {
      this.deps.log({ level: "error", event: "founder_followup_failed", tenantId, reason, error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
    });
  }

  /** Brock's latest follow-up to this shop, if one went in the last 24 hours, and whether it had a booking link. */
  async lastEmail(tenantId: string): Promise<FounderEmailSent | null> {
    const [sentAt, link] = await Promise.all([
      this.deps.store.getIntegrationSecret(tenantId, PROVIDER, "followup_sent_at"),
      this.deps.store.getIntegrationSecret(tenantId, PROVIDER, "followup_link"),
    ]);
    if (!sentAt || !(this.deps.clock.now().getTime() - Date.parse(sentAt) < FOUNDER_FOLLOWUP_GAP_MS)) return null;
    return { sentAt, link: link === "yes" };
  }

  /** The loop: forwarding still not confirmed 20 minutes after "Set it up with me". */
  async runOnce(): Promise<{ queued: number }> {
    const { store, clock } = this.deps;
    let queued = 0;
    const now = clock.now().getTime();
    for (const tenantId of await store.listTenantIds()) {
      try {
        const helpRequestedAt = await store.getIntegrationSecret(tenantId, "forwarding", "help_requested_at");
        if (!helpRequestedAt) continue;
        const age = now - Date.parse(helpRequestedAt);
        if (!(age >= FOUNDER_FOLLOWUP_AFTER_MS && age <= FOUNDER_FOLLOWUP_MAX_AGE_MS)) continue;
        const confirmedAt = await store.getIntegrationSecret(tenantId, "forwarding", "confirmed_at");
        if (confirmedAt && Date.parse(confirmedAt) >= Date.parse(helpRequestedAt)) continue;
        if (await this.queue(tenantId, "not_confirmed") === "queued") queued += 1;
      } catch (error) {
        this.deps.log({ level: "error", event: "founder_followup_failed", tenantId, reason: "not_confirmed", error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
      }
    }
    return { queued };
  }

  /** About three open times a day over the next five business days, clear of every connected calendar. */
  async openSlots(): Promise<FounderSlot[]> {
    const now = this.deps.clock.now();
    const busy = await this.deps.calendars.busy(now.toISOString(), new Date(now.getTime() + 21 * 24 * 60 * 60_000).toISOString());
    return founderSlots({ now, windows: this.windows, timeZone: this.deps.env.FOUNDER_TIMEZONE, busy });
  }

  /** Open times overall, and how many each account would leave open on its own (0 = that calendar blocks everything). */
  async openSlotsByAccount(): Promise<{ all: FounderSlot[]; perAccount: Record<string, number> }> {
    const now = this.deps.clock.now();
    const all = await this.openSlots();
    const perAccount = Object.fromEntries([...this.deps.calendars.lastBusyByAccount].map(([id, busy]) => [id, founderSlots({ now, windows: this.windows, timeZone: this.deps.env.FOUNDER_TIMEZONE, busy }).length]));
    return { all, perAccount };
  }

  /** The shop's booked call, if it's still ahead. */
  async existingBooking(tenantId: string): Promise<FounderSlot | null> {
    const raw = await this.deps.store.getIntegrationSecret(tenantId, PROVIDER, "booking");
    try {
      const booking = raw ? JSON.parse(raw) as FounderSlot : null;
      return booking && Date.parse(booking.end) > this.deps.clock.now().getTime() ? booking : null;
    } catch {
      return null;
    }
  }

  /**
   * The shop's booked call, if it's still ahead, with its confirmation email queued: a booking whose email didn't
   * get queued (the outbox failed, or the process stopped) sends it the next time the owner opens the link. Once.
   */
  async bookedCall(tenantId: string, facts: FounderBookingFacts): Promise<FounderSlot | null> {
    const existing = await this.existingBooking(tenantId);
    if (existing) await this.queueConfirmation(tenantId, existing, facts);
    return existing;
  }

  /**
   * Book the picked start: re-check it's open under one lock for all of Brock's calendars, put it on the
   * "book here" calendar, and email the owner a confirmation with a calendar file.
   */
  async book(tenantId: string, start: string, facts: FounderBookingFacts): Promise<BookResult> {
    const { store, env, clock, calendars, log } = this.deps;
    if (!await calendars.connected()) return { status: "no_calendar" };
    return store.withLock("founder-booking", async () => {
      // A second tap (another time, or the same one on a slow connection) finds the call already booked: show that,
      // never a second event or a second confirmation.
      const existing = await this.existingBooking(tenantId);
      if (existing) {
        await this.queueConfirmation(tenantId, existing, facts);
        return { status: "booked", slot: existing } as const;
      }
      const slot = founderSlotAllowed(start, { now: clock.now(), windows: this.windows, timeZone: env.FOUNDER_TIMEZONE });
      if (!slot) return { status: "invalid" } as const;
      // This shop's own hold never blocks it: a booking cut off before its record was saved left one behind.
      if (!await calendars.isFree(slot, FOUNDER_BUFFER_MINUTES, tenantId)) return { status: "taken" } as const;
      // The event id comes from this key, so a retry of a cut-off booking lands on the same event.
      await calendars.createEvent({
        key: bookingKey(tenantId, slot.start), start: slot.start, end: slot.end,
        summary: `Call Otto setup: ${facts.businessName} (10 min)`,
        description: [
          `Owner: ${facts.ownerName ?? "not given"}`,
          `Business: ${facts.businessName}`,
          `Call them at: ${prettyPhone(facts.callNumber) ?? "no number on file"}`,
          `Business number: ${prettyPhone(facts.businessNumber) ?? "not entered"}`,
          `Carrier: ${facts.carrier ?? "unknown"}`,
          `Forwarding code: ${facts.forwardingCode ?? "none yet (pick their carrier)"}`,
          `Call Otto number: ${prettyPhone(facts.ottoNumber) ?? "line not on yet"}`,
          `Account email: ${facts.email}`,
        ].join("\n"),
      });
      // The event is on Brock's calendar: the shop's record goes first, so anything that stops after this still
      // shows the owner their call (and the next open queues the email) instead of a time taken by its own event.
      await store.saveIntegrationSecret(tenantId, PROVIDER, "booking", JSON.stringify(slot));
      // Holds the time for other shops until Google's busy times show the event; the event itself already does.
      await calendars.rememberBooked(slot, tenantId).catch((error: unknown) => {
        log({ level: "error", event: "founder_booking_hold_failed", tenantId, error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
      });
      await this.queueConfirmation(tenantId, slot, facts);
      log({ level: "info", event: "founder_call_booked", tenantId, start: slot.start });
      return { status: "booked", slot } as const;
    });
  }

  /** The owner's confirmation with a calendar file, queued once per booking. Never throws: the call is booked either way. */
  private async queueConfirmation(tenantId: string, slot: FounderSlot, facts: FounderBookingFacts): Promise<void> {
    const { store, clock, log } = this.deps;
    try {
      const key = bookingKey(tenantId, slot.start);
      const when = slotFullLabel(slot.start, facts.timezone);
      const message = founderConfirmationEmail({ firstName: ownerFirstName(facts.ownerName), businessName: facts.businessName, when, callNumber: prettyPhone(facts.callNumber) });
      const ics = founderCallIcs({
        uid: key.replace(/[^\w-]/g, "-"), start: slot.start, end: slot.end, now: clock.now(),
        summary: "Call Otto setup call with Brock (10 min)",
        description: facts.callNumber ? `Brock will call you at ${prettyPhone(facts.callNumber)}.` : "Brock will call you.",
      });
      const at = clock.now().toISOString();
      await store.enqueueNotification({
        id: randomUUID(), tenantId, callId: null, channel: "email", senderRef: "founder", destinationRef: `email:${facts.email}`,
        body: formatEmailBody(message.subject, message.text, [{ filename: "call-otto-setup.ics", content: ics }]),
        priority: "high", state: "pending", attempts: 0, nextAttemptAt: at,
        idempotencyKey: `${key}:confirmation`, providerReceipt: null, lastError: null, createdAt: at, sentAt: null,
      });
    } catch (error) {
      log({ level: "error", event: "founder_confirmation_failed", tenantId, start: slot.start, error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
    }
  }
}

const bookingKey = (tenantId: string, start: string): string => `founder-booking:${tenantId}:${start}`;
