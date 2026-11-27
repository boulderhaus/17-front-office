import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { CallService, INTAKE_EMERGENCY_INSTRUCTION } from "../src/application/call-service.js";
import { createDemoConfig } from "../src/domain/config.js";
import { BACKEND_TOOL_REMINDER, speechToSpeechPayload } from "../src/voice/voice-mode.js";

/** A speech-to-speech line skipped triage_call on a real call (2026-11-27). The server must not depend on it. */
describe("the server triages every intake, with or without triage_call", () => {
  let store: InMemoryStore;
  let service: CallService;
  const clock = { now: () => new Date("2026-01-15T08:00:00.000Z") };

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig({ ...createDemoConfig(), ownerRealtimeSmsEnabled: true });
    service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example");
  });

  const start = (providerCallId: string) => service.recordStarted({ eventId: `start:${providerCallId}`, tenantId: "demo", providerCallId, fromNumber: "+15555550100", startedAt: clock.now().toISOString() });
  const intake = (providerCallId: string, problemDescription: string) => service.saveIntake({ tenantId: "demo", providerCallId, fromNumber: "+15555550100", fields: { problemDescription, callerName: "Dana Miller" } });
  const events = async (providerCallId: string) => store.listToolEvents((await store.getCallByProviderId(providerCallId))!.id);

  it("an emergency first seen at save_intake alerts the owner, records the triage step and tells the model", async () => {
    await start("no-triage-call");
    const result = await intake("no-triage-call", "I smell gas in the kitchen and the stove is off.");
    expect(result.emergency).toBe(true);
    expect(result.instruction).toContain(INTAKE_EMERGENCY_INSTRUCTION);
    const call = (await store.getCallByProviderId("no-triage-call"))!;
    expect(call.emergency?.emergency).toBe(true);
    expect(call.outcome).toBe("handoff_queued");
    expect((await store.listNotifications(call.id)).length).toBeGreaterThan(0);
    const triage = (await events("no-triage-call")).filter((event) => event.tool === "call.triage");
    expect(triage).toHaveLength(1);
    expect(triage[0]!.metadata).toMatchObject({ emergency: true, source: "intake" });
  });

  it("a routine problem records the triage step once and adds nothing to the answer", async () => {
    await start("routine");
    const first = await intake("routine", "The kitchen faucet drips a little.");
    expect(first.emergency).toBeUndefined();
    expect(first.instruction).toBeUndefined();
    await intake("routine", "The kitchen faucet drips a little, cold side.");
    const triage = (await events("routine")).filter((event) => event.tool === "call.triage");
    expect(triage).toHaveLength(1);
    expect(triage[0]!.metadata).toMatchObject({ emergency: false, source: "intake" });
  });

  it("replays the emergency words when the same save_intake is retried after a lost answer", async () => {
    await start("retry");
    const first = await intake("retry", "I smell gas in the kitchen and the stove is off.");
    const again = await intake("retry", "I smell gas in the kitchen and the stove is off.");
    expect(again.emergency).toBe(true);
    expect(again.instruction).toBe(first.instruction);
    const call = (await store.getCallByProviderId("retry"))!;
    expect((await events("retry")).filter((event) => event.tool === "call.triage")).toHaveLength(1);
    expect(call.outcome).toBe("handoff_queued");
  });

  it("records the triage step exactly once whatever came first", async () => {
    await start("blank-first");
    await intake("blank-first", "   ");
    await intake("blank-first", "The kitchen faucet drips a little.");
    expect((await events("blank-first")).filter((event) => event.tool === "call.triage")).toHaveLength(1);
    await start("tool-first");
    await service.triageCall({ tenantId: "demo", providerCallId: "tool-first", fromNumber: "+15555550100", problemDescription: "The kitchen faucet drips a little." });
    await intake("tool-first", "The kitchen faucet drips a little.");
    const triage = (await events("tool-first")).filter((event) => event.tool === "call.triage");
    expect(triage).toHaveLength(1);
    expect(triage[0]!.metadata).not.toHaveProperty("source");
  });

  it("an intake with no problem yet records no triage step", async () => {
    await start("no-problem");
    await intake("no-problem", "");
    expect((await events("no-problem")).some((event) => event.tool === "call.triage")).toBe(false);
  });

  it("the delegation backend is told to call triage_call and save_intake every call", () => {
    const built = speechToSpeechPayload({ instructions: "You answer the phone.", voice_settings: {} }, { kind: "speech_to_speech", model: "speaker", voice: "Voice.A", backendModel: "text-model" });
    expect(built.payload.delegation_settings).toEqual({ enabled: true, mode: "telnyx", model: "text-model", speak_results: true, instructions: BACKEND_TOOL_REMINDER });
    expect(BACKEND_TOOL_REMINDER).toContain("triage_call");
    expect(BACKEND_TOOL_REMINDER).toContain("save_intake");
  });
});

describe("the routine selftest caller", () => {
  it("expects the steps the shop has on, and its script names a covered place", async () => {
    const { parseSelftestArgs, routineCallerScript, routineExpectedEvents, verdict } = await import("../scripts/selftest-call.js");
    expect(routineExpectedEvents({ askAddress: true, checkServiceArea: true, offerTimes: true })).toEqual(["call.triage", "call.intake", "coverage.check", "calendar.availability"]);
    expect(routineExpectedEvents({ askAddress: false, checkServiceArea: true, offerTimes: false })).toEqual(["call.triage", "call.intake"]);
    expect(routineCallerScript("Springfield")).toContain("100 Main Street, Springfield");
    expect(parseSelftestArgs(["--line", "+15555550123", "--from", "+15555550177", "--routine"], {})).toMatchObject({ line: "+15555550123", from: "+15555550177" });
    const ok = (name: string) => ({ name, status: "success", ok: true });
    const base = { tools: [], finalized: true, finalizeMs: 1000, usageBefore: 1, usageAfter: 2, speechToSpeech: true };
    expect(verdict({ ...base, toolEvents: [ok("call.triage"), ok("call.intake")], expectedEvents: routineExpectedEvents({ askAddress: true, checkServiceArea: true, offerTimes: true }) }).pass).toBe(false);
    expect(verdict({ ...base, toolEvents: [ok("call.triage"), ok("call.intake"), ok("coverage.check"), ok("calendar.availability")], expectedEvents: routineExpectedEvents({ askAddress: true, checkServiceArea: true, offerTimes: true }) }).pass).toBe(true);
  });
});

describe("an availability window the call has outrun", () => {
  it("starts now when it began a few minutes ago, and is still refused when it is all in the past", async () => {
    const { startNoEarlierThanNow } = await import("../src/application/call-service.js");
    const now = new Date("2026-01-15T18:32:00.000Z");
    expect(startNoEarlierThanNow("2026-01-15T18:30:00.000Z", "2026-01-22T23:59:59.000Z", now)).toBe(now.toISOString());
    expect(startNoEarlierThanNow("2026-01-16T09:00:00.000Z", "2026-01-22T23:59:59.000Z", now)).toBe("2026-01-16T09:00:00.000Z");
    expect(startNoEarlierThanNow("2025-06-08T20:00:00.000Z", "2025-06-08T23:00:00.000Z", now)).toBe("2025-06-08T20:00:00.000Z");
    expect(startNoEarlierThanNow("not a date", "2026-01-22T23:59:59.000Z", now)).toBe("not a date");

    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    // A clock that moves on every reading, as a real one does.
    let ticks = 0;
    const clock = { now: () => new Date(now.getTime() + (ticks += 7)) };
    const service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example");
    await service.recordStarted({ eventId: "start:outrun", tenantId: "demo", providerCallId: "outrun", fromNumber: "+15555550100", startedAt: now.toISOString() });
    const result = await service.checkAvailability({ tenantId: "demo", providerCallId: "outrun", windowStart: "2026-01-15T18:30:00.000Z", windowEnd: "2026-01-22T23:59:59.000Z" });
    expect(result.status).not.toBe("invalid_window");
    const past = await service.checkAvailability({ tenantId: "demo", providerCallId: "outrun", windowStart: "2025-06-08T20:00:00.000Z", windowEnd: "2025-06-08T23:00:00.000Z" });
    expect(past.status).toBe("invalid_window");
  });
});
