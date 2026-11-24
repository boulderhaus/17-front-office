import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { CallService } from "../src/application/call-service.js";
import { demoEnvironment } from "../src/config/environment.js";
import { buildCallPath } from "../src/domain/call-path.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { CollectedCallFields } from "../src/domain/models.js";
import { createRequestHandler } from "../src/http/app.js";
import type { Clock } from "../src/ports.js";

class MutableClock implements Clock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value); }
  advance(seconds: number): void { this.value = new Date(this.value.getTime() + seconds * 1000); }
}

const fields: CollectedCallFields = {
  callerName: "Test Caller",
  companyName: null,
  callbackNumber: "+15555550100",
  address: "100 Main St, Springfield, IL 62701",
  serviceCategory: "HVAC maintenance",
  serviceCategoryConfidence: 0.95,
  problemDescription: "AC blowing warm air",
  equipmentDetails: null,
  accessNotes: null,
  requestedStart: null,
  explicitSlotConfirmation: false,
  diagnosticFeeAccepted: true,
  humanRequested: false,
  confidence: 0.95,
};

describe("Otto's path through a call", () => {
  let store: InMemoryStore;
  let clock: MutableClock;
  let service: CallService;
  const id = "path-call";

  beforeEach(async () => {
    store = new InMemoryStore();
    clock = new MutableClock(new Date("2026-01-15T14:00:00.000Z"));
    await store.saveConfig({ ...createDemoConfig(), ownerRealtimeSmsEnabled: true, bookingMode: "direct", priceSnippets: [{ label: "Diagnostic", text: "The diagnostic visit is $89." }] });
    service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example");
    await service.recordStarted({ eventId: `start:${id}`, tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", startedAt: clock.now().toISOString() });
  });

  async function path() {
    const call = (await store.getCallByProviderId(id))!;
    return buildCallPath({ call, events: await store.listToolEvents(call.id), booking: await store.getBookingForCall(call.id), notifications: await store.listNotifications(call.id), now: clock.now() });
  }
  const states = async () => Object.fromEntries((await path()).steps.map((step) => [step.key, step.state]));

  it("checks off every checkpoint in order as a booking call happens, live", async () => {
    let current = await path();
    expect(current.live).toBe(true);
    expect(current.steps.map((step) => step.label)).toEqual(["Greeting", "Service check", "The problem", "Safety check", "Name & number", "Address & area", "Open times", "Booking", "Recap & owner text"]);
    expect(await states()).toMatchObject({ greeting: "done", service_check: "current", problem: "todo", wrap_up: "todo" });

    clock.advance(10);
    await service.saveIntake({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", fields: { problemDescription: fields.problemDescription } });
    clock.advance(3);
    await service.triageCall({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", problemDescription: fields.problemDescription });
    expect(await states()).toMatchObject({ service_check: "done", problem: "done", safety: "done", caller: "current" });

    clock.advance(20);
    await service.saveIntake({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", fields: { problemDescription: fields.problemDescription, callerName: "Test Caller", callbackNumber: "+15555550100" } });
    clock.advance(15);
    expect((await service.checkServiceArea({ tenantId: "demo", providerCallId: id, address: fields.address! })).status).toBe("covered");
    clock.advance(5);
    const slots = await service.checkAvailability({ tenantId: "demo", providerCallId: id, windowStart: "2026-01-15T15:00:00.000Z", windowEnd: "2026-01-15T18:00:00.000Z" });
    expect(await states()).toMatchObject({ caller: "done", address: "done", times: "done", booking: "current" });

    clock.advance(10);
    const booked = await service.bookConfirmedSlot({ tenantId: "demo", providerCallId: id, slotStart: slots.slots[0]!.start, callerName: "Test Caller", callbackNumber: "+15555550100", address: fields.address!, serviceCategory: "HVAC maintenance", problemDescription: fields.problemDescription, explicitConfirmation: true, diagnosticFeeAccepted: true });
    expect(booked.status).toBe("confirmed");
    current = await path();
    expect(current.steps.find((step) => step.key === "booking")).toMatchObject({ state: "done", note: "Booked on your calendar" });
    expect(current.steps.find((step) => step.key === "address")?.note).toBe("In your area");
    expect(current.done).toBe(8);

    clock.advance(20);
    await service.finalize({ webhookEventId: `end:${id}`, tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", startedAt: "2026-01-15T14:00:00.000Z", endedAt: clock.now().toISOString(), durationSeconds: 83, fields: { ...fields, requestedStart: slots.slots[0]!.start, explicitSlotConfirmation: true }, transcript: "Synthetic transcript", recordingUrl: null, consentState: "disclosed" });
    current = await path();
    expect(current.live).toBe(false);
    expect(current.done).toBe(9);
    expect(current.steps.every((step) => step.state === "done")).toBe(true);
    // Each checkpoint carries when it happened, in call order.
    const times = current.steps.map((step) => Date.parse(step.at!));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("checks off a price question and an ask for the owner wherever they come up", async () => {
    await service.recordAnswerLookup({ tenantId: "demo", providerCallId: id, kind: "price", approved: true });
    await service.queueHumanHandoff({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", problemDescription: "Wants to talk pricing" });
    const current = await path();
    expect(current.extras).toEqual([
      expect.objectContaining({ key: "price_question", state: "done", note: "Gave your approved price" }),
      // Queued, not yet sent: the path never claims a text went out before it did.
      expect.objectContaining({ key: "owner_request", state: "done", note: "callback alert sending" }),
    ]);
    // A request for the owner changes the outcome mid-call; the path stays live until the call ends,
    // and Otto isn't shown working on a booking that's no longer happening.
    expect(current.live).toBe(true);
    expect(current.steps.find((step) => step.key === "booking")).toMatchObject({ state: "skipped", note: "You're calling them back" });
    expect(current.steps.find((step) => step.key === "times")?.state).toBe("skipped");
    expect(current.steps.find((step) => step.state === "current")?.key).toBe("safety");
  });

  it("flags an emergency at the safety check", async () => {
    await service.triageCall({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", problemDescription: "I smell gas in the basement" });
    const safety = (await path()).steps.find((step) => step.key === "safety");
    expect(safety).toMatchObject({ state: "flagged", note: "Emergency: told to get safe, alert sending" });

    // Once the alert really went out, it says so; if it failed, it says that instead.
    const call = (await store.getCallByProviderId(id))!;
    const alerts = (await store.listNotifications(call.id)).filter((item) => item.idempotencyKey.startsWith("human-handoff:"));
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) await store.saveNotification({ ...alert, state: "delivered" });
    expect((await path()).steps.find((step) => step.key === "safety")?.note).toBe("Emergency: told to get safe, you were alerted");
    for (const alert of alerts) await store.saveNotification({ ...alert, state: "dead" });
    expect((await path()).steps.find((step) => step.key === "safety")?.note).toBe("Emergency: told to get safe, alert didn't go through");
  });

  it("stops at the service check for a robocall and marks the rest skipped once it ends", async () => {
    clock.advance(8);
    expect((await service.markSpam({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", category: "robocall", callerQuote: "Press one to lower your rates" })).status).toBe("marked");
    await service.finalize({ webhookEventId: `end:${id}`, tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", startedAt: "2026-01-15T14:00:00.000Z", endedAt: clock.now().toISOString(), durationSeconds: 8, fields: { ...fields, callerName: null, address: null, problemDescription: "" }, transcript: "Press one to lower your rates", recordingUrl: null, consentState: "disclosed" });
    expect(await states()).toEqual({ greeting: "done", service_check: "flagged", problem: "skipped", safety: "skipped", caller: "skipped", address: "skipped", times: "skipped", booking: "skipped", wrap_up: "skipped" });
  });

  it("shows a booking waiting on the owner as waiting, not done", async () => {
    await store.saveConfig({ ...createDemoConfig(), ownerRealtimeSmsEnabled: true, bookingMode: "confirm" });
    await service.saveIntake({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", fields });
    const slots = await service.checkAvailability({ tenantId: "demo", providerCallId: id, windowStart: "2026-01-15T15:00:00.000Z", windowEnd: "2026-01-15T18:00:00.000Z" });
    const result = await service.bookConfirmedSlot({ tenantId: "demo", providerCallId: id, slotStart: slots.slots[0]!.start, callerName: "Test Caller", callbackNumber: "+15555550100", address: fields.address!, serviceCategory: "HVAC maintenance", problemDescription: fields.problemDescription, explicitConfirmation: true, diagnosticFeeAccepted: true });
    expect(result.status).toBe("pending");
    expect((await path()).steps.find((step) => step.key === "booking")).toMatchObject({ state: "waiting", note: "Waiting on your OK" });
  });

  it("lists price questions and asks for the owner only when they happened", async () => {
    await service.saveIntake({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", fields });
    expect((await path()).extras).toEqual([]);
  });

  it("never lets a failed checkpoint write block an emergency alert", async () => {
    store.addToolEvent = async () => { throw new Error("tool_events unavailable"); };
    const result = await service.saveIntake({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", fields: { ...fields, problemDescription: "I smell gas in the kitchen" } });
    expect(result.status).toBe("saved");
    const triage = await service.triageCall({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", problemDescription: "I smell gas in the kitchen" });
    expect(triage.emergency).toBe(true);
    await service.recordAnswerLookup({ tenantId: "demo", providerCallId: id, kind: "price", approved: false });
    const call = (await store.getCallByProviderId(id))!;
    expect((await store.listNotifications(call.id)).some((item) => item.idempotencyKey.startsWith("human-handoff:") && item.priority === "high")).toBe(true);
  });

  it("never stores the caller's details on a checkpoint", async () => {
    await service.saveIntake({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", fields });
    const call = (await store.getCallByProviderId(id))!;
    const intake = (await store.listToolEvents(call.id)).find((event) => event.tool === "call.intake")!;
    expect(intake.metadata).toEqual({ problem: true, name: true, callback: true, address: true });
  });

  it("stops showing live once a call that never reported its end is old", async () => {
    clock.advance(16 * 60);
    expect((await path()).live).toBe(false);
  });
});

describe("live path on the owner's call page", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  const clock: Clock = { now: () => new Date("2026-01-15T14:01:00.000Z") };

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: { Demo: true }, logger: () => undefined }));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("shows the checklist and polls it while the call is on", async () => {
    const signup = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", email: "owner@synthetic.example", password: "long-password-for-tests", consent: "yes" }) });
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const account = (await store.getOwnerAccountByEmail("owner@synthetic.example"))!;
    const service = new CallService(store, new InMemoryCalendar(), clock, baseUrl);
    await service.recordStarted({ eventId: "start:live", tenantId: account.tenantId, providerCallId: "live", fromNumber: "+15555550100", startedAt: "2026-01-15T14:00:00.000Z" });
    await service.saveIntake({ tenantId: account.tenantId, providerCallId: "live", fromNumber: "+15555550100", fields: { problemDescription: "AC rattles when it starts" } });
    const call = (await store.getCallByProviderId("live"))!;

    const page = await (await fetch(`${baseUrl}/app/calls/${call.id}`, { headers: { cookie } })).text();
    expect(page).toContain("Otto’s path");
    expect(page).toContain(`data-live-path="/app/calls/${call.id}/path"`);
    expect(page).toContain('<script src="/app/call-path.js" defer></script>');

    const live = await fetch(`${baseUrl}/app/calls/${call.id}/path`, { headers: { cookie } });
    expect(live.headers.get("cache-control")).toBe("no-store");
    const body = await live.json() as { live: boolean; done: number; html: string };
    expect(body).toMatchObject({ live: true, done: 4 });
    expect(body.html).toContain('class="current"');

    const script = await fetch(`${baseUrl}/app/call-path.js`);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).toContain("data-live-path");

    // Signed out goes to sign-in; another shop's owner gets nothing.
    expect([302, 303]).toContain((await fetch(`${baseUrl}/app/calls/${call.id}/path`, { redirect: "manual" })).status);
    const other = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Other Plumbing", email: "other@synthetic.example", password: "long-password-for-tests", consent: "yes" }) });
    const otherCookie = other.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${baseUrl}/app/calls/${call.id}/path`, { headers: { cookie: otherCookie } })).status).toBe(404);
  });
});
