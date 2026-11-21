import { CapturingNotificationSender, InMemoryCalendar, InMemoryStore } from "../adapters/in-memory.js";
import { createDemoConfig } from "../domain/config.js";
import type { BusinessConfig, CallSummaryInput, CollectedCallFields } from "../domain/models.js";
import type { Clock } from "../ports.js";
import { buildVoiceSystemPrompt } from "../voice/system-prompt.js";
import { CallService } from "./call-service.js";
import { OutboxWorker } from "./outbox-worker.js";

export const SIMULATION_SCENARIOS = [
  ["routine", "Routine maintenance"],
  ["no_heat", "2 a.m. no heat"],
  ["burst_pipe", "Burst pipe"],
  ["gas_smell", "Gas smell"],
  ["human", "Asks for a human"],
  ["malformed_address", "Malformed/out-of-area address"],
  ["price_inquiry", "Unapproved price inquiry"],
  ["angry_confused", "Angry/confused caller"],
  ["no_availability", "No calendar availability"],
  ["transfer_failure", "Transfer unavailable"],
  ["double_book", "Double-book race"],
  ["calendar_failure", "Calendar API failure"],
  ["sms_failure", "SMS provider failure"],
  ["system_drop", "Provider/system drop"],
  ["spam", "Spam suppression"],
] as const;

export type SimulationScenarioId = typeof SIMULATION_SCENARIOS[number][0];

export interface SimulationResult {
  id: SimulationScenarioId;
  label: string;
  passed: boolean;
  expected: string;
  observed: string;
}

class MutableClock implements Clock {
  constructor(private value = new Date("2026-01-15T08:00:00.000Z")) {}
  now(): Date { return new Date(this.value); }
  advance(milliseconds: number): void { this.value = new Date(this.value.getTime() + milliseconds); }
}

interface Rig {
  store: InMemoryStore;
  calendar: InMemoryCalendar;
  sender: CapturingNotificationSender;
  clock: MutableClock;
  service: CallService;
}

export async function runAllSimulations(): Promise<SimulationResult[]> {
  const results: SimulationResult[] = [];
  for (const [id] of SIMULATION_SCENARIOS) results.push(await runSimulation(id));
  return results;
}

export async function runSimulation(id: SimulationScenarioId): Promise<SimulationResult> {
  const label = SIMULATION_SCENARIOS.find(([candidate]) => candidate === id)?.[1] ?? id;
  try {
    const result = await execute(id);
    return { id, label, ...result };
  } catch (error) {
    return { id, label, passed: false, expected: "Scenario completes safely", observed: error instanceof Error ? error.message : "Unknown simulator failure" };
  }
}

async function execute(id: SimulationScenarioId): Promise<Omit<SimulationResult, "id" | "label">> {
  const rig = await createRig();
  if (id === "routine") {
    await start(rig, id);
    const call = await rig.service.finalize(summary(id));
    await new OutboxWorker(rig.store, rig.sender, rig.clock).runOnce();
    return verdict(call.outcome === "pending_confirmation" && rig.sender.sent.length === 1, "Pending owner confirmation and one owner alert", `${call.outcome}; ${rig.sender.sent.length} alert(s)`);
  }
  if (id === "no_heat" || id === "burst_pipe" || id === "gas_smell") {
    const problem = id === "no_heat" ? "No heat and an infant is in the house" : id === "burst_pipe" ? "A burst pipe is actively flooding the basement" : "The basement smells like gas";
    const decision = await rig.service.triageCall({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", problemDescription: problem });
    await new OutboxWorker(rig.store, rig.sender, rig.clock).runOnce();
    const expectedSeverity = id === "gas_smell" ? "life_safety" : "urgent";
    return verdict(decision.severity === expectedSeverity && rig.sender.sent[0]?.priority === "high" && rig.calendar.events.length === 0, `${expectedSeverity} bypass with high-priority alert and no booking`, `${decision.severity}; priority ${rig.sender.sent[0]?.priority ?? "none"}; ${rig.calendar.events.length} event(s)`);
  }
  if (id === "human" || id === "angry_confused") {
    const result = await rig.service.queueHumanHandoff({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", callerName: "Synthetic Caller", problemDescription: id === "angry_confused" ? "I am angry and confused; get me a person" : "I want a human now" });
    await new OutboxWorker(rig.store, rig.sender, rig.clock).runOnce();
    return verdict(result.status === "handoff_queued" && rig.sender.sent[0]?.priority === "high", "Human handoff queue and high-priority owner alert", `${result.status}; priority ${rig.sender.sent[0]?.priority ?? "none"}`);
  }
  if (id === "malformed_address") {
    await configure(rig, { priceSnippets: approvedFee() });
    await start(rig, id);
    const result = await book(rig, id, "Unknown rural route");
    return verdict(result.status === "pending" && result.message.includes("outside the service area") && rig.calendar.events.length === 0, "No booking; owner confirmation required", `${result.status}; ${result.message}`);
  }
  if (id === "price_inquiry") {
    const prompt = buildVoiceSystemPrompt(await rig.store.getConfig("demo"));
    return verdict(prompt.includes("Never estimate a price") && !prompt.includes("$89"), "No invented price; take a message", prompt.includes("Never estimate a price") ? "Price refusal policy present" : "Price refusal missing");
  }
  if (id === "no_availability") {
    rig.calendar.events.push({ slot: { start: "2026-01-15T15:00:00.000Z", end: "2026-01-15T16:30:00.000Z" }, eventId: "occupied" });
    await start(rig, id);
    const result = await rig.service.checkAvailability({ tenantId: "demo", providerCallId: id, windowStart: "2026-01-15T15:00:00.000Z", windowEnd: "2026-01-15T16:30:00.000Z" });
    return verdict(result.status === "pending" && result.slots.length === 0, "No promise; pending owner follow-up", `${result.status}; ${result.slots.length} slot(s)`);
  }
  if (id === "transfer_failure") {
    await configure(rig, { ownerTransferNumberRef: null });
    const result = await rig.service.queueHumanHandoff({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", problemDescription: "Transfer requested" });
    const call = await rig.store.getCallByProviderId(id);
    const task = call ? await rig.store.getCallbackTaskForCall(call.id) : null;
    return verdict(!result.transferAvailable && task?.status === "open", "Transfer unavailable; owned callback remains", `transfer=${result.transferAvailable}; callback=${task?.status ?? "missing"}`);
  }
  if (id === "double_book") {
    await configure(rig, { bookingMode: "direct", priceSnippets: approvedFee() });
    await Promise.all([start(rig, `${id}-a`), start(rig, `${id}-b`)]);
    const [left, right] = await Promise.all([book(rig, `${id}-a`, "100 Main St, Springfield"), book(rig, `${id}-b`, "100 Main St, Springfield")]);
    const statuses = [left.status, right.status].sort().join(",");
    return verdict(statuses === "confirmed,conflict" && rig.calendar.events.length === 1, "Exactly one confirmed event", `${statuses}; ${rig.calendar.events.length} event(s)`);
  }
  if (id === "calendar_failure") {
    await configure(rig, { bookingMode: "direct", priceSnippets: approvedFee() });
    await start(rig, id);
    rig.calendar.failAvailability = true;
    const booking = await book(rig, id, "100 Main St, Springfield");
    const call = await rig.service.finalize(summary(id, { requestedStart: "2026-01-15T15:00:00.000Z", explicitSlotConfirmation: true }));
    await new OutboxWorker(rig.store, rig.sender, rig.clock).runOnce();
    return verdict(booking.status === "pending" && call.outcome === "pending_confirmation" && rig.sender.sent.length === 1, "Pending outcome and owner alert despite calendar failure", `${booking.status}; ${call.outcome}; ${rig.sender.sent.length} alert(s)`);
  }
  if (id === "sms_failure") {
    await configure(rig, { bookingMode: "direct", priceSnippets: approvedFee() });
    await start(rig, id);
    await book(rig, id, "100 Main St, Springfield");
    const call = await rig.service.finalize(summary(id, { requestedStart: "2026-01-15T15:00:00.000Z", explicitSlotConfirmation: true }));
    rig.sender.fail = true;
    const worker = new OutboxWorker(rig.store, rig.sender, rig.clock);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await worker.runOnce();
      rig.clock.advance(301_000);
    }
    const notifications = await rig.store.listNotifications(call.id);
    return verdict(notifications.some((item) => item.state === "dead") && notifications.some((item) => item.idempotencyKey.startsWith("customer-sms-failure:")), "Visible dead-letter plus explicit owner follow-up alert", `${notifications.filter((item) => item.state === "dead").length} dead; failure alert=${notifications.some((item) => item.idempotencyKey.startsWith("customer-sms-failure:"))}`);
  }
  if (id === "system_drop") {
    await start(rig, id);
    rig.clock.advance(15 * 60_000 + 1);
    const recovered = await rig.service.recoverStaleCalls("demo");
    const call = await rig.store.getCallByProviderId(id);
    const task = call ? await rig.store.getCallbackTaskForCall(call.id) : null;
    return verdict(recovered === 1 && call?.outcome === "handoff_queued" && task?.status === "open", "Dropped call becomes an owned callback", `${recovered} recovered; ${call?.outcome ?? "missing"}; callback=${task?.status ?? "missing"}`);
  }
  const spam = await rig.service.finalize({ ...summary(id), isSpam: true });
  return verdict(spam.outcome === "ignored_spam" && (await rig.store.listNotifications(spam.id)).length === 0, "Spam excluded from billing and alerts", `${spam.outcome}; ${(await rig.store.listNotifications(spam.id)).length} alert(s)`);
}

async function createRig(): Promise<Rig> {
  const store = new InMemoryStore();
  const calendar = new InMemoryCalendar();
  const sender = new CapturingNotificationSender();
  const clock = new MutableClock();
  await store.saveConfig(createDemoConfig());
  return { store, calendar, sender, clock, service: new CallService(store, calendar, clock, "https://simulator.invalid") };
}

async function configure(rig: Rig, updates: Partial<BusinessConfig>): Promise<void> {
  await rig.store.saveConfig({ ...await rig.store.getConfig("demo"), ...updates });
}

async function start(rig: Rig, id: string): Promise<void> {
  await rig.service.recordStarted({ eventId: `start:${id}`, tenantId: "demo", providerCallId: id, fromNumber: "+15555550100", startedAt: rig.clock.now().toISOString() });
}

async function book(rig: Rig, id: string, address: string): Promise<{ status: "confirmed" | "pending" | "conflict" | "unknown"; message: string }> {
  await rig.service.checkAvailability({
    tenantId: "demo",
    providerCallId: id,
    windowStart: "2026-01-15T15:00:00.000Z",
    windowEnd: "2026-01-15T18:00:00.000Z",
  });
  return rig.service.bookConfirmedSlot({ tenantId: "demo", providerCallId: id, slotStart: "2026-01-15T15:00:00.000Z", callerName: "Synthetic Caller", callbackNumber: "+15555550100", address, serviceCategory: "HVAC maintenance", problemDescription: "Routine HVAC maintenance", explicitConfirmation: true, diagnosticFeeAccepted: true });
}

function summary(id: string, fields: Partial<CollectedCallFields> = {}): CallSummaryInput {
  return {
    webhookEventId: `end:${id}`, tenantId: "demo", providerCallId: id, fromNumber: "+15555550100",
    startedAt: "2026-01-15T08:00:00.000Z", endedAt: "2026-01-15T08:04:00.000Z", durationSeconds: 240,
    fields: {
      callerName: "Synthetic Caller", companyName: null, callbackNumber: "+15555550100", address: "100 Main St, Springfield",
      serviceCategory: "HVAC maintenance", serviceCategoryConfidence: 0.98, problemDescription: "Routine HVAC maintenance",
      equipmentDetails: "Synthetic system", accessNotes: null, requestedStart: null, explicitSlotConfirmation: false,
      diagnosticFeeAccepted: true, humanRequested: false, confidence: 0.96, ...fields,
    },
    transcript: "Synthetic simulator transcript", recordingUrl: "https://example.invalid/synthetic-recording", consentState: "disclosed",
  };
}

function approvedFee(): BusinessConfig["priceSnippets"] {
  return [{ label: "Diagnostic", text: "The diagnostic visit is $89." }];
}

function verdict(passed: boolean, expected: string, observed: string): Omit<SimulationResult, "id" | "label"> {
  return { passed, expected, observed };
}
