import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendarAdapter, googleEventId } from "../src/adapters/google-calendar.js";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { TeamCalendar } from "../src/adapters/team-calendar.js";
import { BookingCoordinator } from "../src/application/booking-coordinator.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { AvailabilitySlot, BookingAttempt, OwnerAccount } from "../src/domain/models.js";
import type { CalendarPort, CallOptions, CreateEventOptions } from "../src/ports.js";

// Round-2 review of PR #20: once a calendar insert is dispatched, an abort must leave a truthful "unknown"
// booking that names the deterministic event id, and a retry must look for that event before inserting.

const now = "2026-01-15T08:00:00.000Z";
const clock = { now: () => new Date(now) };
const slotStart = "2026-01-15T15:00:00.000Z";

afterEach(() => { vi.restoreAllMocks(); });

/** Dispatches the insert (reports the id), then hangs until the deadline aborts it. */
class HangingCalendar implements CalendarPort {
  creates = 0;
  lookups = 0;
  found: string | null = null;
  async listAvailableSlots(): Promise<AvailabilitySlot[]> { return []; }
  async isFree(): Promise<boolean> { return true; }
  async createEvent(attempt: BookingAttempt, options?: CreateEventOptions): Promise<{ status: "confirmed" | "unknown"; providerEventId: string | null }> {
    this.creates += 1;
    options?.onDispatch?.(`evt-${attempt.idempotencyKey}`);
    return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal!.reason)));
  }
  async findEvent(_attempt: BookingAttempt, _options?: CallOptions): Promise<string | null> { this.lookups += 1; return this.found; }
  async verifyEvent(): Promise<boolean> { return true; }
  async deleteEvent(): Promise<void> {}
}

const bookInput = (callId: string) => ({
  tenantId: "demo", callId, providerCallId: `v3:${callId}`, requestedStart: slotStart, durationMinutes: 90,
  callerName: "Synthetic Caller", callbackNumber: "+15555550110", address: "100 Main St", problemDescription: "Furnace check",
});

describe("an aborted calendar insert", () => {
  it("returns and stores an unknown booking with the dispatched event id instead of throwing", async () => {
    const store = new InMemoryStore();
    const calendar = new HangingCalendar();
    const coordinator = new BookingCoordinator(store, calendar, clock);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("synthetic deadline")), 30);
    const callId = randomUUID();
    const booking = await coordinator.book(bookInput(callId), { signal: controller.signal });
    const expectedId = `evt-calendar:demo:${callId}:${slotStart}`;
    expect(booking).toMatchObject({ status: "unknown", providerEventId: expectedId });
    expect(await store.getBookingForCall(callId)).toMatchObject({ status: "unknown", providerEventId: expectedId });
  });

  it("looks for the event before inserting again, and confirms it when it landed", async () => {
    const store = new InMemoryStore();
    const calendar = new HangingCalendar();
    const coordinator = new BookingCoordinator(store, calendar, clock);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("synthetic deadline")), 30);
    const callId = randomUUID();
    const first = await coordinator.book(bookInput(callId), { signal: controller.signal });

    // Not visible yet: stay unknown, never insert a second time.
    expect((await coordinator.book(bookInput(callId))).status).toBe("unknown");
    expect(calendar.creates).toBe(1);

    calendar.found = first.providerEventId;
    const retried = await coordinator.book(bookInput(callId));
    expect(retried).toMatchObject({ status: "confirmed", providerEventId: first.providerEventId });
    expect(retried.writeVerifiedAt).not.toBeNull();
    expect(calendar.creates).toBe(1);
    expect(calendar.lookups).toBe(2);
  });

  it("finds an event an earlier attempt left behind before checking free/busy (no false conflict)", async () => {
    const store = new InMemoryStore();
    const calendar = new InMemoryCalendar();
    const coordinator = new BookingCoordinator(store, calendar, clock);
    const callId = randomUUID();
    // A crash right after dispatch: the row still says "checking", but the event exists.
    await store.saveBooking({
      id: randomUUID(), tenantId: "demo", callId, requestedStart: slotStart, requestedEnd: null, status: "checking", providerEventId: null,
      writeVerifiedAt: null, confirmationNotificationId: null, verificationFailures: [], failureReason: null, createdAt: now, updatedAt: now,
    });
    const created = await calendar.createEvent({ ...bookInput(callId), slot: { start: slotStart, end: "2026-01-15T16:30:00.000Z" }, idempotencyKey: `calendar:demo:${callId}:${slotStart}` });
    const booking = await coordinator.book(bookInput(callId));
    expect(booking).toMatchObject({ status: "confirmed", providerEventId: created.providerEventId });
    expect(calendar.events).toHaveLength(1);
  });
});

describe("Google Calendar insert ids", () => {
  const credentials = async () => ({ refreshToken: "refresh", client: { id: "client", secret: "secret" } });
  const attempt: BookingAttempt = {
    tenantId: "demo", callId: "call", providerCallId: "v3:call", callerName: "Synthetic Caller", callbackNumber: "+15555550110",
    address: "100 Main St", problemDescription: "Routine", idempotencyKey: "calendar:demo:call:slot", slot: { start: slotStart, end: "2026-01-15T16:30:00.000Z" },
  };

  it("derives the event id from the idempotency key only and reports it before the insert is sent", async () => {
    expect(googleEventId(attempt.idempotencyKey)).toBe(createHash("sha256").update(attempt.idempotencyKey).digest("hex").slice(0, 32));
    const order: string[] = [];
    let insertedId: unknown;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("oauth2")) return Response.json({ access_token: "access", expires_in: 3600 });
      order.push("insert");
      insertedId = (JSON.parse(String(init?.body)) as { id: unknown }).id;
      return new Response("{}", { status: 409 });
    });
    const adapter = new GoogleCalendarAdapter({ calendarId: "primary", getCredentials: credentials });
    const created = await adapter.createEvent(attempt, { onDispatch: (id) => order.push(`dispatch:${id}`) });
    expect(insertedId).toBe(googleEventId(attempt.idempotencyKey));
    expect(order).toEqual([`dispatch:${googleEventId(attempt.idempotencyKey)}`, "insert"]);
    // 409 on our own deterministic id means an earlier attempt already created it.
    expect(created).toEqual({ status: "confirmed", providerEventId: googleEventId(attempt.idempotencyKey) });
  });

  it("finds an existing event by that id and reports none on 404", async () => {
    let exists = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("oauth2")) return Response.json({ access_token: "access", expires_in: 3600 });
      expect(String(input)).toContain(`/events/${googleEventId(attempt.idempotencyKey)}`);
      return exists ? Response.json({ id: googleEventId(attempt.idempotencyKey), status: "confirmed" }) : new Response("{}", { status: 404 });
    });
    const adapter = new GoogleCalendarAdapter({ calendarId: "primary", getCredentials: credentials });
    expect(await adapter.findEvent(attempt)).toBe(googleEventId(attempt.idempotencyKey));
    exists = false;
    expect(await adapter.findEvent(attempt)).toBeNull();
  });
});

describe("team calendar assignment", () => {
  function owner(tenantId: string): OwnerAccount {
    return { id: randomUUID(), tenantId, email: "owner@synthetic.example", displayName: "Synthetic Owner", passwordHash: "synthetic", role: "owner", status: "active", createdAt: now, updatedAt: now };
  }

  async function team() {
    const store = new InMemoryStore();
    const tenantId = `shop_${randomUUID()}`;
    const account = owner(tenantId);
    const config = createDemoConfig(tenantId);
    await store.createOwnerWorkspace({ account, config, ownerPhone: null });
    const member = { ...account, id: randomUUID(), email: "member@synthetic.example", role: "member" as const };
    await store.createTeamAccount(member);
    await store.saveConfig({ ...config, schedulingCalendars: [account, member].map((person) => ({ accountId: person.id, enabled: true, hours: config.bookableHours })) });
    const calendars = new Map([[account.id, new InMemoryCalendar()], [member.id, new InMemoryCalendar()]]);
    const calendar = new TeamCalendar(store, new InMemoryCalendar(), (id) => calendars.get(id)!);
    const attempt = (key: string): BookingAttempt => ({
      tenantId, callId: randomUUID(), providerCallId: "v3:synthetic", callerName: "Synthetic Caller", callbackNumber: "+15555550100",
      address: "100 Main St", problemDescription: "Routine", idempotencyKey: key, slot: { start: slotStart, end: "2026-01-15T16:30:00.000Z" },
    });
    return { store, tenantId, calendars, calendar, attempt, ids: [account.id, member.id] };
  }

  it("picks the teammate from the idempotency key, never from the last assignment, and keeps the key unchanged", async () => {
    const { store, tenantId, calendars, calendar, attempt, ids } = await team();
    const holders = () => [...calendars.entries()].filter(([, entry]) => entry.events.length > 0).map(([id]) => id);
    const clear = () => { for (const entry of calendars.values()) entry.events.splice(0); };
    const used = new Set<string>();
    for (const key of Array.from({ length: 24 }, (_, index) => `calendar:key-${index}`)) {
      const picks: string[] = [];
      for (const last of ids) {
        await store.saveIntegrationSecret(tenantId, "scheduling", "last_assigned_account", last);
        const created = await calendar.createEvent(attempt(key));
        expect(created.providerEventId).toMatch(/^fo-team:/);
        // A retry finds that exact event before inserting again (the coordinator does this on every retry).
        expect(await calendar.findEvent(attempt(key))).toBe(created.providerEventId);
        expect(holders()).toHaveLength(1);
        const holder = calendars.get(holders()[0]!)!;
        expect(holder.events).toHaveLength(1);
        expect(holder.events[0]!.idempotencyKey).toBe(key);
        picks.push(holders()[0]!);
        clear();
      }
      expect(new Set(picks).size).toBe(1);
      used.add(picks[0]!);
    }
    expect(used.size).toBe(2);
  });

  it("still returns the event id when the assignment bookkeeping write fails", async () => {
    const { store, calendar, attempt } = await team();
    vi.spyOn(store, "saveIntegrationSecret").mockRejectedValue(new Error("Synthetic database outage"));
    const created = await calendar.createEvent(attempt("calendar:bookkeeping"));
    expect(created.status).toBe("confirmed");
    expect(created.providerEventId).toMatch(/^fo-team:/);
  });

  it("finds a created event across teammates", async () => {
    const { calendar, attempt } = await team();
    const booking = attempt("calendar:find-me");
    const created = await calendar.createEvent(booking);
    expect(await calendar.findEvent(booking)).toBe(created.providerEventId);
    expect(await calendar.findEvent(attempt("calendar:never-made"))).toBeNull();
  });

  it("rethrows the deadline instead of reporting a full calendar", async () => {
    const { calendar, attempt, tenantId } = await team();
    const controller = new AbortController();
    controller.abort(new Error("synthetic deadline"));
    const booking = attempt("calendar:aborted");
    await expect(calendar.isFree({ tenantId, slot: booking.slot }, { signal: controller.signal })).rejects.toThrow("synthetic deadline");
    await expect(calendar.listAvailableSlots({
      tenantId, windowStart: slotStart, windowEnd: "2026-01-15T18:00:00.000Z", durationMinutes: 90, timezone: "America/Chicago",
      bookableHours: createDemoConfig().bookableHours, minimumLeadTimeMinutes: 0, now,
    }, { signal: controller.signal })).rejects.toThrow("synthetic deadline");
    await expect(calendar.createEvent(booking, { signal: controller.signal })).rejects.toThrow("synthetic deadline");
  });
});
