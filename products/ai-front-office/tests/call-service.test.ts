import { beforeEach, describe, expect, it } from "vitest";
import { CapturingNotificationSender, InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { DataDeletionService } from "../src/application/data-deletion.js";
import { CallService } from "../src/application/call-service.js";
import { OutboxWorker } from "../src/application/outbox-worker.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { CallSummaryInput, CollectedCallFields } from "../src/domain/models.js";
import type { Clock } from "../src/ports.js";

class MutableClock implements Clock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value); }
  advance(milliseconds: number): void { this.value = new Date(this.value.getTime() + milliseconds); }
}

const baseFields: CollectedCallFields = {
  callerName: "Test Caller",
  companyName: null,
  callbackNumber: "+15555550100",
  address: "100 Main St, Springfield, IL",
  serviceCategory: "HVAC maintenance",
  serviceCategoryConfidence: 0.95,
  problemDescription: "Routine maintenance",
  equipmentDetails: "Residential forced-air system",
  accessNotes: null,
  requestedStart: null,
  explicitSlotConfirmation: false,
  diagnosticFeeAccepted: true,
  humanRequested: false,
  confidence: 0.95,
};

describe("call outcomes", () => {
  let store: InMemoryStore;
  let calendar: InMemoryCalendar;
  let sender: CapturingNotificationSender;
  let clock: MutableClock;
  let service: CallService;

  beforeEach(async () => {
    store = new InMemoryStore();
    calendar = new InMemoryCalendar();
    sender = new CapturingNotificationSender();
    clock = new MutableClock(new Date("2026-01-15T08:00:00.000Z"));
    await store.saveConfig({ ...createDemoConfig(), ownerRealtimeSmsEnabled: true });
    service = new CallService(store, calendar, clock, "https://front-office.example");
  });

  it("keeps routine instant texts behind the add-on while safety alerts stay included", async () => {
    await store.saveConfig({ ...createDemoConfig(), ownerRealtimeSmsEnabled: false });
    await start("routine-no-addon");
    const routine = await service.finalize(summary("routine-no-addon"));
    expect(await store.listNotifications(routine.id)).toHaveLength(0);

    await start("urgent-no-addon");
    await service.triageCall({ tenantId: "demo", providerCallId: "urgent-no-addon", fromNumber: "+15555550100", problemDescription: "No heat and an infant is home" });
    const urgent = await service.finalize(summary("urgent-no-addon", { problemDescription: "No heat and an infant is home" }));
    expect((await store.listNotifications(urgent.id)).some((item) => item.priority === "high")).toBe(true);
  });

  it("routes a 2 a.m. no-heat emergency to the owner without booking", async () => {
    await start("emergency");
    const triage = await service.triageCall({ tenantId: "demo", providerCallId: "emergency", fromNumber: "+15555550100", callerName: "Test Caller", problemDescription: "No heat and an infant is in the house" });
    expect(triage.severity).toBe("urgent");
    const call = await service.finalize(summary("emergency", {
      problemDescription: "No heat and an infant is in the house",
      serviceCategory: "HVAC repair",
    }));
    expect(call.emergency?.severity).toBe("urgent");
    expect(call.outcome).toBe("handoff_queued");
    expect(calendar.events).toHaveLength(0);
    expect((await new OutboxWorker(store, sender, clock).runOnce()).sent).toBe(2);
    expect(sender.sent[0]?.priority).toBe("high");
    expect(sender.sent[0]?.body).toMatch(/^Otto: URGENT: /);
  });

  it("alerts on an emergency before confirmation or fee gates", async () => {
    await start("emergency-booking");
    const result = await service.bookConfirmedSlot({
      tenantId: "demo", providerCallId: "emergency-booking", slotStart: "2026-01-15T15:00:00Z",
      callerName: "Test Caller", callbackNumber: "+15555550100", address: "100 Main St, Springfield, IL",
      serviceCategory: "HVAC repair", problemDescription: "No heat and an infant is in the house",
      explicitConfirmation: false, diagnosticFeeAccepted: false,
    });
    expect(result.status).toBe("pending");
    expect(calendar.events).toHaveLength(0);
    await new OutboxWorker(store, sender, clock).runOnce();
    expect(sender.sent[0]?.body).toMatch(/^Otto: URGENT: /);
  });

  it("counts a direct booking only after read-back, complete evidence, and customer confirmation queue", async () => {
    await enableDirectBooking();
    await start("verified");
    const startedCall = await store.getCallByProviderId("verified");
    await store.saveCallbackTask({
      id: "88888888-8888-4888-8888-888888888888", tenantId: "demo", callId: startedCall!.id,
      ownerRef: "owner-primary", reason: "Confirm requested appointment", priority: "normal", status: "open",
      dueAt: "2026-01-15T08:30:00.000Z", completedAt: null, completionSource: null,
      createdAt: "2026-01-15T08:00:00.000Z", updatedAt: "2026-01-15T08:00:00.000Z",
    });
    const slot = "2026-01-15T15:00:00.000Z";
    expect((await book("verified", slot)).status).toBe("confirmed");
    expect(await store.getCallbackTaskForCall(startedCall!.id)).toMatchObject({ status: "completed", completionSource: "verified_booking" });
    const call = await service.finalize(summary("verified", { requestedStart: slot, explicitSlotConfirmation: true }));
    expect(call.outcome).toBe("booked");
    expect(call.qualityFlags).toEqual([]);
    const booking = await store.getBookingForCall(call.id);
    expect(booking?.writeVerifiedAt).not.toBeNull();
    expect(booking?.confirmationNotificationId).not.toBeNull();
  });

  it("keeps routine maintenance routine", async () => {
    await start("routine");
    const call = await service.finalize(summary("routine"));
    expect(call.emergency?.emergency).toBe(false);
    expect(call.outcome).toBe("pending_confirmation");
  });

  it("keeps owner-confirmation mode when the owner chose it, instead of promising an appointment", async () => {
    await configureApprovedFee();
    await store.saveConfig({ ...(await store.getConfig("demo")), bookingMode: "confirm" });
    await start("confirm-mode");
    const result = await book("confirm-mode", "2026-01-15T15:00:00Z");
    expect(result.status).toBe("pending");
    expect(calendar.events).toHaveLength(0);
    const call = await store.getCallByProviderId("confirm-mode");
    expect((await store.getCallbackTaskForCall(call!.id))?.reason).toContain("Confirm requested appointment");
  });

  it("rejects past availability windows and produces one concise same-day slot summary", async () => {
    await start("availability-language");
    const past = await service.checkAvailability({
      tenantId: "demo", providerCallId: "availability-language",
      windowStart: "2025-06-08T20:00:00.000Z", windowEnd: "2025-06-08T23:00:00.000Z",
    });
    expect(past.status).toBe("invalid_window");
    expect(past.message).toContain("starts in the past");
    calendar.listAvailableSlots = async () => [
      { start: "2026-01-15T15:00:00.000Z", end: "2026-01-15T16:30:00.000Z" },
      { start: "2026-01-15T15:30:00.000Z", end: "2026-01-15T17:00:00.000Z" },
      { start: "2026-01-15T16:00:00.000Z", end: "2026-01-15T17:30:00.000Z" },
    ];
    const future = await service.checkAvailability({
      tenantId: "demo", providerCallId: "availability-language",
      windowStart: "2026-01-15T15:00:00.000Z", windowEnd: "2026-01-15T18:00:00.000Z",
    });
    expect(future.status).toBe("available");
    expect(future.spokenSummary).toBe("Today, Thursday, January 15: 9:00 AM, 9:30 AM, or 10:00 AM CST");
    expect(future.spokenSummary?.match(/January 15/g)).toHaveLength(1);
  });

  it("rejects past or unoffered booking times without storing them", async () => {
    await configureApprovedFee();
    await start("slot-guard");
    const past = await service.bookConfirmedSlot({
      tenantId: "demo", providerCallId: "slot-guard", slotStart: "2025-06-09T00:00:00.000Z",
      callerName: "Caller", callbackNumber: "+15555550102", address: "100 Main St, Springfield, IL",
      serviceCategory: "HVAC repair", problemDescription: "Routine repair", explicitConfirmation: true, diagnosticFeeAccepted: true,
    });
    expect(past.message).toContain("in the past");
    expect((await store.getCallByProviderId("slot-guard"))?.fields.requestedStart).toBeNull();
    const unoffered = await service.bookConfirmedSlot({
      tenantId: "demo", providerCallId: "slot-guard", slotStart: "2026-01-15T20:00:00.000Z",
      callerName: "Caller", callbackNumber: "+15555550102", address: "100 Main St, Springfield, IL",
      serviceCategory: "HVAC repair", problemDescription: "Routine repair", explicitConfirmation: true, diagnosticFeeAccepted: true,
    });
    expect(unoffered.message).toContain("not in the latest verified availability");
    expect((await store.getCallByProviderId("slot-guard"))?.fields.requestedStart).toBeNull();
  });

  it("refuses fee-gated booking when no owner-approved price exists", async () => {
    await start("missing-fee");
    const result = await book("missing-fee", "2026-01-15T15:00:00Z");
    expect(result.status).toBe("pending");
    expect(result.message).toContain("No owner-approved diagnostic fee");
    expect(calendar.events).toHaveLength(0);
  });

  it("queues and alerts on an immediate human request", async () => {
    const result = await service.queueHumanHandoff({ tenantId: "demo", providerCallId: "human", fromNumber: "+15555550101", callerName: "Angry Caller", problemDescription: "I need a person now" });
    expect(result.transferAvailable).toBe(false);
    await new OutboxWorker(store, sender, clock).runOnce();
    expect(sender.sent[0]?.body).toMatch(/^Otto: URGENT: caller asked for you\nNew call: /);
  });

  it("delivers a later urgent alert before an earlier routine alert", async () => {
    await start("routine-priority");
    await service.finalize(summary("routine-priority"));
    await service.triageCall({ tenantId: "demo", providerCallId: "urgent-priority", fromNumber: "+15555550101", problemDescription: "No heat and an infant is in the house" });
    expect((await new OutboxWorker(store, sender, clock).runOnce(1)).sent).toBe(1);
    expect(sender.sent[0]?.priority).toBe("high");
    expect(sender.sent[0]?.body).toMatch(/^Otto: URGENT: /);
  });

  it("does not book an address outside the configured service area", async () => {
    await configureApprovedFee();
    await start("address");
    const result = await service.bookConfirmedSlot({ tenantId: "demo", providerCallId: "address", slotStart: "2026-01-15T15:00:00Z", callerName: "Caller", callbackNumber: "+15555550102", address: "Unknown rural route", serviceCategory: "HVAC repair", problemDescription: "Hard-to-parse location", explicitConfirmation: true, diagnosticFeeAccepted: true });
    expect(result.status).toBe("pending");
    expect(result.message).toContain("outside the service area");
    expect(calendar.events).toHaveLength(0);
  });

  it("checks service coverage before availability and fails closed when coverage is unconfigured", async () => {
    const covered = await service.checkServiceArea({ tenantId: "demo", providerCallId: "coverage", address: "100 Main St, Springfield, IL 62701" });
    expect(covered.status).toBe("covered");
    const outside = await service.checkServiceArea({ tenantId: "demo", providerCallId: "coverage", address: "100 Main St, Albany, NY 12207" });
    expect(outside.status).toBe("outside");
    await store.saveConfig({ ...createDemoConfig(), ownerRealtimeSmsEnabled: true, serviceAreaTerms: [] });
    const unconfigured = await service.checkServiceArea({ tenantId: "demo", providerCallId: "coverage", address: "100 Main St, Springfield, IL 62701" });
    expect(unconfigured.status).toBe("unconfigured");
    expect(unconfigured.message).toContain("Do not promise service or book");
  });

  it("serializes two callers competing for overlapping slots", async () => {
    await enableDirectBooking();
    await Promise.all([start("race-a"), start("race-b")]);
    const slot = "2026-01-15T15:00:00Z";
    const results = await Promise.all([book("race-a", slot), book("race-b", "2026-01-15T15:30:00Z")]);
    expect(results.map((result) => result.status).sort()).toEqual(["confirmed", "conflict"]);
    expect(calendar.events).toHaveLength(1);
  });

  it("still alerts the owner when the calendar fails mid-call", async () => {
    await enableDirectBooking();
    await start("failure");
    calendar.failAvailability = true;
    const booking = await book("failure", "2026-01-15T15:00:00Z");
    expect(booking.status).toBe("pending");
    await service.finalize(summary("failure", { requestedStart: "2026-01-15T15:00:00Z", explicitSlotConfirmation: true }));
    await new OutboxWorker(store, sender, clock).runOnce();
    expect(sender.sent).toHaveLength(1);
  });

  it("fails closed when a calendar write cannot be read back", async () => {
    await enableDirectBooking();
    await start("readback");
    calendar.failVerify = true;
    const slot = "2026-01-15T15:00:00Z";
    expect((await book("readback", slot)).status).toBe("unknown");
    const call = await service.finalize(summary("readback", { requestedStart: slot, explicitSlotConfirmation: true }));
    expect(call.outcome).toBe("pending_confirmation");
    expect(call.qualityFlags).toContain("system_write_not_verified");
  });

  it("deduplicates repeated call-end webhooks and owner alerts", async () => {
    await start("duplicate");
    const input = summary("duplicate");
    await service.finalize(input);
    await service.finalize(input);
    expect((await store.listNotifications((await store.getCallByProviderId("duplicate"))!.id))).toHaveLength(1);
  });

  it("creates one call record when provider events arrive concurrently", async () => {
    await Promise.all([
      service.recordStarted({ eventId: "start:concurrent:a", tenantId: "demo", providerCallId: "concurrent", fromNumber: "+15555550100", startedAt: clock.now().toISOString() }),
      service.recordStarted({ eventId: "start:concurrent:b", tenantId: "demo", providerCallId: "concurrent", fromNumber: "+15555550100", startedAt: clock.now().toISOString() }),
    ]);
    expect(await store.listCalls("demo", 10)).toHaveLength(1);
  });

  it("does not let a delayed sparse provider event erase richer call evidence", async () => {
    await start("out-of-order");
    await service.finalize(summary("out-of-order"));
    const sparse: CollectedCallFields = {
      callerName: null, companyName: null, callbackNumber: null, address: null, serviceCategory: null,
      serviceCategoryConfidence: 0, problemDescription: "", equipmentDetails: null, accessNotes: null,
      requestedStart: null, explicitSlotConfirmation: false, diagnosticFeeAccepted: false,
      humanRequested: false, confidence: 0,
    };
    const call = await service.finalize({
      ...summary("out-of-order"), webhookEventId: "ended:out-of-order:retry", fields: sparse,
      transcript: null, recordingUrl: null, consentState: "unknown",
    });
    expect(call.fields.callerName).toBe("Test Caller");
    expect(call.fields.serviceCategory).toBe("HVAC maintenance");
    expect(call.transcript).toBe("Synthetic transcript");
    expect(call.recordingUrl).toBe("https://example.invalid/recording");
    expect(call.consentState).toBe("disclosed");
  });

  it("does not let a sparse retry downgrade an earlier model-assisted emergency", async () => {
    await start("emergency-replay");
    await service.finalize({ ...summary("emergency-replay"), llmEmergencyScore: 0.9, llmEmergencyReason: "Caller reports immediate property danger" });
    const sparse: CollectedCallFields = {
      callerName: null, companyName: null, callbackNumber: null, address: null, serviceCategory: null,
      serviceCategoryConfidence: 0, problemDescription: "", equipmentDetails: null, accessNotes: null,
      requestedStart: null, explicitSlotConfirmation: false, diagnosticFeeAccepted: false,
      humanRequested: false, confidence: 0,
    };
    const call = await service.finalize({
      ...summary("emergency-replay"), webhookEventId: "ended:emergency-replay:retry", fields: sparse,
      transcript: null, recordingUrl: null, consentState: "unknown",
    });
    expect(call.emergency?.emergency).toBe(true);
    expect(call.emergency?.severity).toBe("urgent");
    expect(call.outcome).toBe("handoff_queued");
  });

  it("does not escalate a routine call because the assistant asked a safety screening question", async () => {
    await start("screening");
    const call = await service.finalize({ ...summary("screening", { problemDescription: "Annual AC tune-up" }), transcript: "AI assistant: Any smoke, gas smell, or burning odor?\nCaller: No, just a tune-up." });
    expect(call.emergency?.severity).toBe("routine");
    expect(call.outcome).not.toBe("handoff_queued");
  });

  it("reads Otto's lines (the transcript label since the Call Otto rename) as the assistant, not the caller", async () => {
    await start("screening-otto");
    const call = await service.finalize({ ...summary("screening-otto", { problemDescription: "Annual AC tune-up" }), transcript: "Caller: Hi, I need a tune-up.\nOtto: Any smoke, gas smell, or burning odor?\nCaller: No, just a tune-up." });
    expect(call.emergency?.severity).toBe("routine");
    expect(call.outcome).not.toBe("handoff_queued");
  });

  it("escalates at call end when the caller said something dangerous that the summary left out", async () => {
    await start("caller-gas");
    const call = await service.finalize({ ...summary("caller-gas", { problemDescription: "Furnace issue" }), transcript: "AI assistant: How can I help?\nCaller: I smelled gas by the furnace" });
    expect(call.emergency?.severity).toBe("life_safety");
  });

  it("never drops an emergency as spam", async () => {
    await start("spam-emergency");
    const call = await service.finalize({ ...summary("spam-emergency", { problemDescription: "Unknown" }), transcript: "Caller: I smell gas in the basement", isSpam: true });
    expect(call.outcome).toBe("handoff_queued");
    expect(call.emergency?.severity).toBe("life_safety");
  });

  it("deletes expired call data and dependent records", async () => {
    await start("retention");
    const call = await service.finalize(summary("retention"));
    expect(await new DataDeletionService(store, { deleteForCall: async () => undefined }).deleteExpired("demo", "2027-01-01T00:00:00.000Z", 100, "2027-01-01T00:00:00.000Z")).toEqual({ deleted: 1, failed: 0 });
    expect(await store.getCall(call.id)).toBeNull();
    expect(await store.listNotifications(call.id)).toEqual([]);
    expect(await store.getCallbackTaskForCall(call.id)).toBeNull();
  });

  it.each([
    { transcript: null, recordingUrl: "https://example.invalid/recording", flag: "transcript_missing" },
    { transcript: "Synthetic transcript", recordingUrl: null, flag: "recording_missing" },
  ])("does not count a booking when required evidence is incomplete", async ({ transcript, recordingUrl, flag }) => {
    await enableDirectBooking();
    await start("evidence");
    const slot = "2026-01-15T15:00:00Z";
    await book("evidence", slot);
    const call = await service.finalize({ ...summary("evidence", { requestedStart: slot, explicitSlotConfirmation: true }), transcript, recordingUrl });
    expect(call.outcome).toBe("pending_confirmation");
    expect(call.qualityFlags).toContain(flag);
  });

  it("excludes provider-classified spam from billing", async () => {
    await start("spam");
    const call = await service.finalize({ ...summary("spam"), isSpam: true });
    expect(call.billingDisposition).toBe("spam_excluded");
    expect(call.outcome).toBe("ignored_spam");
    expect(await store.listNotifications(call.id)).toHaveLength(0);
  });

  it("recovers a dropped call with an owner task and caller text", async () => {
    await store.saveConfig({ ...await store.getConfig("demo"), customerSmsEnabled: true });
    await start("dropped");
    clock.advance(35 * 60_000 + 1);
    expect(await service.recoverStaleCalls("demo")).toBe(1);
    const call = await store.getCallByProviderId("dropped");
    expect(call?.outcome).toBe("handoff_queued");
    expect((await store.getCallbackTaskForCall(call!.id))?.status).toBe("open");
    expect((await store.listNotifications(call!.id)).map((item) => item.idempotencyKey)).toContain(`missed-call-text:${call!.id}`);
  });

  it("turns a dead customer confirmation into an explicit owner failure alert", async () => {
    await enableDirectBooking();
    await start("sms-failure");
    const slot = "2026-01-15T15:00:00Z";
    await book("sms-failure", slot);
    const call = await service.finalize(summary("sms-failure", { requestedStart: slot, explicitSlotConfirmation: true }));
    sender.fail = true;
    const worker = new OutboxWorker(store, sender, clock);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await worker.runOnce();
      clock.advance(301_000);
    }
    const keys = (await store.listNotifications(call.id)).map((item) => item.idempotencyKey);
    expect(keys.some((key) => key.startsWith("customer-sms-failure:"))).toBe(true);
  });

  async function start(providerCallId: string): Promise<void> {
    await service.recordStarted({ eventId: `start:${providerCallId}`, tenantId: "demo", providerCallId, fromNumber: "+15555550100", startedAt: clock.now().toISOString() });
  }

  async function book(providerCallId: string, slotStart: string): Promise<{ status: "confirmed" | "pending" | "conflict" | "unknown"; message: string }> {
    const start = new Date(slotStart);
    await service.checkAvailability({
      tenantId: "demo",
      providerCallId,
      windowStart: start.toISOString(),
      windowEnd: new Date(start.getTime() + 3 * 60 * 60_000).toISOString(),
    });
    return service.bookConfirmedSlot({ tenantId: "demo", providerCallId, slotStart, callerName: "Test Caller", callbackNumber: "+15555550100", address: "100 Main St, Springfield, IL", serviceCategory: "HVAC maintenance", problemDescription: "Routine service needed", explicitConfirmation: true, diagnosticFeeAccepted: true });
  }

  async function enableDirectBooking(): Promise<void> {
    await store.saveConfig({
      ...createDemoConfig(),
      ownerRealtimeSmsEnabled: true,
      bookingMode: "direct",
      customerSmsEnabled: true,
      priceSnippets: [{ label: "Diagnostic", text: "The diagnostic visit is $89." }],
    });
  }

  async function configureApprovedFee(): Promise<void> {
    await store.saveConfig({
      ...createDemoConfig(),
      ownerRealtimeSmsEnabled: true,
      priceSnippets: [{ label: "Diagnostic", text: "The diagnostic visit is $89." }],
    });
  }

  function summary(providerCallId: string, fields: Partial<CollectedCallFields> = {}): CallSummaryInput {
    return {
      webhookEventId: `end:${providerCallId}`,
      tenantId: "demo",
      providerCallId,
      fromNumber: "+15555550100",
      startedAt: "2026-01-15T08:00:00.000Z",
      endedAt: clock.now().toISOString(),
      durationSeconds: 120,
      fields: { ...baseFields, ...fields },
      transcript: "Synthetic transcript",
      recordingUrl: "https://example.invalid/recording",
      consentState: "disclosed",
    };
  }
});
