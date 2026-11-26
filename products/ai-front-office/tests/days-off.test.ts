import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { GoogleCalendarAdapter } from "../src/adapters/google-calendar.js";
import { CallService } from "../src/application/call-service.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig, normalizeBusinessConfig } from "../src/domain/config.js";
import { formatDaysOff, isDayOff, localDate, MAX_DAYS_OFF, parseDaysOff, slotTouchesDayOff, upcomingDaysOff } from "../src/domain/days-off.js";
import type { BusinessConfig, CallSummaryInput } from "../src/domain/models.js";
import { createRequestHandler } from "../src/http/app.js";
import type { Clock } from "../src/ports.js";

// Walk 3 (Nov 26), SET-11: no way to block single days off (a holiday, a trade show, a week away).

class MutableClock implements Clock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value); }
  set(value: string): void { this.value = new Date(value); }
}

describe("days off: the stored list", () => {
  const today = "2026-01-15";

  it("reads single days and stretches, sorted, and drops the ones already past", () => {
    expect(parseDaysOff("2026-02-01..2026-02-07\n2026-01-20\n2026-01-10\n2026-01-14..2026-01-15", today)).toEqual([
      { start: "2026-01-14", end: "2026-01-15" },
      { start: "2026-01-20", end: "2026-01-20" },
      { start: "2026-02-01", end: "2026-02-07" },
    ]);
    expect(parseDaysOff("", today)).toEqual([]);
    expect(parseDaysOff("2026-01-20\n2026-01-20", today)).toEqual([{ start: "2026-01-20", end: "2026-01-20" }]);
  });

  it("refuses dates that aren't real, run backwards, run too long, sit too far ahead, or are too many", () => {
    for (const bad of ["2026-02-30", "tomorrow", "2026-01-20..2026-01-19", "2026-01-20..2026-01-21..2026-01-22", "2026-01-20..2026-06-01", "2029-01-01"]) {
      expect(() => parseDaysOff(bad, today), bad).toThrow();
    }
    const many = Array.from({ length: MAX_DAYS_OFF + 1 }, (_, index) => `2026-03-${String(index + 1).padStart(2, "0")}`).join("\n");
    expect(() => parseDaysOff(many, today)).toThrow(`up to ${MAX_DAYS_OFF}`);
  });

  it("keeps only well-formed entries when a saved config is read", () => {
    const read = normalizeBusinessConfig({ ...createDemoConfig("shop"), daysOff: [{ start: "2026-01-20", end: "2026-01-21" }, { start: "2026-01-22", end: "2026-01-21" }, { start: "nope", end: "nope" }] });
    expect(read.daysOff).toEqual([{ start: "2026-01-20", end: "2026-01-21" }]);
    expect(normalizeBusinessConfig({ tenantId: "older" }).daysOff).toEqual([]);
  });

  it("drops past days from what the owner sees", () => {
    expect(upcomingDaysOff([{ start: "2026-01-10", end: "2026-01-14" }, { start: "2026-01-14", end: "2026-01-16" }], today)).toEqual([{ start: "2026-01-14", end: "2026-01-16" }]);
    expect(formatDaysOff([{ start: "2026-01-20", end: "2026-01-20" }, { start: "2026-02-01", end: "2026-02-07" }])).toBe("2026-01-20\n2026-02-01..2026-02-07");
  });

  it("reads the day in the shop's own time zone, not UTC", () => {
    // 03:00 UTC on Jan 16 is still 9 PM on Jan 15 in Chicago.
    const lateEvening = new Date("2026-01-16T03:00:00.000Z");
    expect(localDate(lateEvening, "America/Chicago")).toBe("2026-01-15");
    expect(isDayOff(lateEvening, "America/Chicago", [{ start: "2026-01-15", end: "2026-01-15" }])).toBe(true);
    expect(isDayOff(lateEvening, "America/Chicago", [{ start: "2026-01-16", end: "2026-01-16" }])).toBe(false);
    // A visit that runs past midnight into a day off touches it.
    expect(slotTouchesDayOff(new Date("2026-01-16T05:00:00.000Z"), new Date("2026-01-16T06:30:00.000Z"), "America/Chicago", [{ start: "2026-01-16", end: "2026-01-16" }])).toBe(true);
  });
});

describe("days off: Otto offers and books nothing on them", () => {
  let store: InMemoryStore;
  let calendar: InMemoryCalendar;
  let clock: MutableClock;
  let service: CallService;
  // Late-evening hours, so a slot's UTC date differs from the shop's (Chicago) date.
  const lateHours: BusinessConfig["bookableHours"] = { weekdayStart: "06:00", weekdayEnd: "23:00", weekends: true };
  const lateSlot = "2026-01-16T03:00:00.000Z"; // Thu Jan 15, 9 PM Chicago
  const daySlot = "2026-01-16T15:00:00.000Z"; // Fri Jan 16, 9 AM Chicago

  const shop = (overrides: Partial<BusinessConfig> = {}): BusinessConfig => ({
    ...createDemoConfig(),
    priceSnippets: [{ label: "Diagnostic", text: "The diagnostic visit is $89." }],
    bookableHours: lateHours,
    minimumLeadTimeMinutes: 0,
    ...overrides,
  });

  beforeEach(async () => {
    store = new InMemoryStore();
    calendar = new InMemoryCalendar();
    clock = new MutableClock(new Date("2026-01-15T08:00:00.000Z"));
    await store.saveConfig(shop());
    service = new CallService(store, calendar, clock, "https://front-office.example");
  });

  async function start(providerCallId: string): Promise<void> {
    await service.recordStarted({ eventId: `start:${providerCallId}`, tenantId: "demo", providerCallId, fromNumber: "+15555550100", startedAt: clock.now().toISOString() });
  }
  const offer = (providerCallId: string, at: string) => service.checkAvailability({ tenantId: "demo", providerCallId, windowStart: at, windowEnd: new Date(Date.parse(at) + 3 * 60 * 60_000).toISOString() });
  const book = (providerCallId: string, at: string) => service.bookConfirmedSlot({
    tenantId: "demo", providerCallId, slotStart: at, callerName: "Test Caller", callbackNumber: "+15555550100",
    address: "100 Main St, Springfield, IL", serviceCategory: "HVAC repair", problemDescription: "Furnace makes a rattling noise",
    explicitConfirmation: true, diagnosticFeeAccepted: true,
  });
  const summary = (providerCallId: string, requestedStart: string): CallSummaryInput => ({
    webhookEventId: `end:${providerCallId}`, tenantId: "demo", providerCallId, fromNumber: "+15555550100",
    startedAt: "2026-01-15T08:00:00.000Z", endedAt: "2026-01-15T08:05:00.000Z", durationSeconds: 300, transcript: "Synthetic transcript", recordingUrl: null, consentState: "disclosed",
    fields: { callerName: "Test Caller", companyName: null, callbackNumber: "+15555550100", address: "100 Main St, Springfield, IL", serviceCategory: "HVAC repair", serviceCategoryConfidence: 0.95, problemDescription: "Furnace makes a rattling noise", equipmentDetails: null, accessNotes: null, requestedStart, explicitSlotConfirmation: true, diagnosticFeeAccepted: true, humanRequested: false, confidence: 0.95 },
  });

  it("the availability check returns no slots on a day off, by the shop's date across the UTC midnight", async () => {
    await start("late-open");
    expect((await offer("late-open", lateSlot)).slots).toHaveLength(1);
    await store.saveConfig(shop({ daysOff: [{ start: "2026-01-15", end: "2026-01-15" }] }));
    await start("late-off");
    const off = await offer("late-off", lateSlot);
    expect(off.slots).toEqual([]);
    expect(off.status).toBe("pending");
    // The next (shop) day is not off, though it shares the slot's UTC date.
    await start("next-day");
    expect((await offer("next-day", daySlot)).slots).toHaveLength(1);
    // And a day off on the slot's UTC date (Jan 16) leaves Jan 15 9 PM Chicago open.
    await store.saveConfig(shop({ daysOff: [{ start: "2026-01-16", end: "2026-01-20" }] }));
    await start("utc-date-off");
    expect((await offer("utc-date-off", lateSlot)).slots).toHaveLength(1);
    await start("in-stretch");
    expect((await offer("in-stretch", daySlot)).slots).toEqual([]);
  });

  it("the Google adapter skips a day off and still offers the next open day", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("oauth2")) return Response.json({ access_token: "access", expires_in: 3600 });
      return Response.json({ calendars: { primary: { busy: [] } } });
    });
    const adapter = new GoogleCalendarAdapter({ calendarId: "primary", getCredentials: async () => ({ refreshToken: "refresh", client: { id: "client", secret: "secret" } }) });
    const slots = await adapter.listAvailableSlots({
      tenantId: "demo", windowStart: "2026-01-15T12:00:00.000Z", windowEnd: "2026-01-17T05:00:00.000Z", durationMinutes: 90, timezone: "America/Chicago",
      bookableHours: lateHours, minimumLeadTimeMinutes: 0, now: "2026-01-15T08:00:00.000Z", daysOff: [{ start: "2026-01-15", end: "2026-01-15" }],
    });
    vi.restoreAllMocks();
    expect(slots).toHaveLength(3);
    for (const slot of slots) expect(localDate(new Date(slot.start), "America/Chicago")).toBe("2026-01-16");
  });

  it("book_slot refuses a time on a day off, like a time outside the hours, even one offered earlier", async () => {
    await start("offered-then-off");
    expect((await offer("offered-then-off", lateSlot)).slots).toHaveLength(1);
    await store.saveConfig(shop({ daysOff: [{ start: "2026-01-15", end: "2026-01-15" }] }));
    const result = await book("offered-then-off", lateSlot);
    expect(result.status).toBe("pending");
    expect(result.message).toContain("outside the shop's hours or notice");
    expect(calendar.events).toHaveLength(0);
  });

  it("in owner-confirm mode a day off is refused too: nothing is queued for that time", async () => {
    await store.saveConfig(shop({ bookingMode: "confirm" }));
    await start("confirm-off");
    await offer("confirm-off", lateSlot);
    await store.saveConfig(shop({ bookingMode: "confirm", daysOff: [{ start: "2026-01-15", end: "2026-01-15" }] }));
    const result = await book("confirm-off", lateSlot);
    expect(result.status).toBe("pending");
    expect(result.message).toContain("outside the shop's hours or notice");
    const call = await store.getCallByProviderId("confirm-off");
    expect(await store.getBookingForCall(call!.id)).toBeNull();
  });

  it("booking at call finalize never writes a day off to the calendar; the owner confirms instead", async () => {
    await start("finalize-off");
    expect((await offer("finalize-off", lateSlot)).slots).toHaveLength(1);
    await store.saveConfig(shop({ daysOff: [{ start: "2026-01-15", end: "2026-01-15" }] }));
    const call = await service.finalize(summary("finalize-off", lateSlot));
    expect(calendar.events).toHaveLength(0);
    const booking = await store.getBookingForCall(call.id);
    expect(booking?.status).toBe("pending");
    expect(booking?.failureReason).toContain("day off");
  });

  it("finalize still books an offered time on a working day", async () => {
    await store.saveConfig(shop({ daysOff: [{ start: "2026-01-15", end: "2026-01-15" }] }));
    await start("finalize-open");
    expect((await offer("finalize-open", daySlot)).slots).toHaveLength(1);
    const call = await service.finalize(summary("finalize-open", daySlot));
    expect((await store.getBookingForCall(call.id))?.status).toBe("confirmed");
    expect(calendar.events).toHaveLength(1);
  });

  it("an emergency on a day off still alerts the owner", async () => {
    await store.saveConfig(shop({ daysOff: [{ start: "2026-01-15", end: "2026-01-15" }] }));
    await start("urgent-off");
    const triage = await service.triageCall({ tenantId: "demo", providerCallId: "urgent-off", fromNumber: "+15555550100", problemDescription: "No heat and an infant is home" });
    expect(triage.emergency).toBe(true);
    const call = await service.finalize({ ...summary("urgent-off", lateSlot), fields: { ...summary("urgent-off", lateSlot).fields, requestedStart: null, explicitSlotConfirmation: false, problemDescription: "No heat and an infant is home" } });
    expect((await store.listNotifications(call.id)).some((item) => item.priority === "high")).toBe(true);
  });
});

describe("days off: Settings round trip", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  const clock = new MutableClock(new Date("2026-01-15T08:00:00.000Z"));

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", PUBLIC_BASE_URL: "http://127.0.0.1:8787", TELNYX_API_KEY: "synthetic" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: { Demo: true }, logger: () => undefined, fetcher: (input, init) => globalThis.fetch(input, init) }));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    clock.set("2026-01-15T08:00:00.000Z");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function owner(): Promise<{ cookie: string; tenantId: string; csrf: string }> {
    const response = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", email: "days@synthetic.example", password: "long-password-for-tests", consent: "yes" }) });
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const account = await store.getOwnerAccountByEmail("days@synthetic.example");
    const dashboard = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { csrf: string };
    return { cookie, tenantId: account!.tenantId, csrf: dashboard.csrf };
  }
  const put = (who: { cookie: string; csrf: string }, body: unknown) => fetch(`${baseUrl}/api/app/settings`, { method: "PUT", headers: { cookie: who.cookie, "content-type": "application/json", "x-csrf-token": who.csrf }, body: JSON.stringify(body) });

  it("saves, shows, refuses bad lists and drops past days on its own", async () => {
    const who = await owner();
    const current = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie: who.cookie } })).json() as { values: Record<string, string | boolean> };
    expect(current.values.daysOff).toBe("");
    const saved = await put(who, { ...current.values, daysOff: "2026-02-01..2026-02-07\n2026-01-15" });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { values: Record<string, unknown> }).values.daysOff).toBe("2026-01-15\n2026-02-01..2026-02-07");
    expect((await store.getConfig(who.tenantId)).daysOff).toEqual([{ start: "2026-01-15", end: "2026-01-15" }, { start: "2026-02-01", end: "2026-02-07" }]);
    const dashboard = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie: who.cookie } })).json() as { shop: { daysOff: unknown } };
    expect(dashboard.shop.daysOff).toEqual([{ start: "2026-01-15", end: "2026-01-15" }, { start: "2026-02-01", end: "2026-02-07" }]);

    for (const bad of ["2026-02-30", "2026-01-25..2026-01-21", "2026-01-20..2026-12-31"]) {
      const response = await put(who, { ...current.values, daysOff: bad });
      expect(response.status, bad).toBe(400);
    }
    expect((await store.getConfig(who.tenantId)).daysOff).toHaveLength(2);

    // A new shop is on Eastern time: 4:30 UTC on Jan 16 is still Jan 15 there, so the day off stays. Once it has passed there, it drops off.
    expect((await store.getConfig(who.tenantId)).timezone).toBe("America/New_York");
    const read = async () => (await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie: who.cookie } })).json() as { values: Record<string, string | boolean> }).values.daysOff;
    clock.set("2026-01-16T04:30:00.000Z");
    expect(await read()).toBe("2026-01-15\n2026-02-01..2026-02-07");
    clock.set("2026-01-16T05:30:00.000Z");
    const later = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie: who.cookie } })).json() as { values: Record<string, string | boolean> };
    expect(later.values.daysOff).toBe("2026-02-01..2026-02-07");

    // Removing every day off clears the list.
    expect((await put(who, { ...later.values, daysOff: "" })).status).toBe(200);
    expect((await store.getConfig(who.tenantId)).daysOff).toEqual([]);
  });
});
