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
