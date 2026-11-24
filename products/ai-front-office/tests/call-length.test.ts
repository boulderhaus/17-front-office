import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { TelnyxAssistantMessenger } from "../src/adapters/telnyx.js";
import { CallLengthGuard, dueCallLengthStage, type AssistantMessenger } from "../src/application/call-length.js";
import { CallService } from "../src/application/call-service.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { Clock } from "../src/ports.js";
import {
  buildTelnyxAssistantUpdate,
  buildVoiceSystemPrompt,
  CALL_TIME_LIMIT_SECONDS,
  FINISH_NUDGE_AFTER_SECONDS,
  FORCED_WRAP_UP_AFTER_SECONDS,
  WRAP_UP_AFTER_SECONDS,
  WRAP_UP_LINE,
  WRAP_UP_NUDGE_AFTER_SECONDS,
} from "../src/voice/system-prompt.js";

class MutableClock implements Clock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value); }
  advance(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}

class RecordingMessenger implements AssistantMessenger {
  sent: Array<{ callControlId: string; content: string; commandId: string; triggerResponse: boolean }> = [];
  next: Array<"sent" | "call_ended" | "rejected" | Error> = [];
  async addSystemMessage(callControlId: string, content: string, commandId: string, options: { triggerResponse?: boolean } = {}): Promise<"sent" | "call_ended" | "rejected"> {
    const outcome = this.next.shift() ?? "sent";
    if (outcome instanceof Error) throw outcome;
    this.sent.push({ callControlId, content, commandId, triggerResponse: options.triggerResponse === true });
    return outcome;
  }
}

describe("call length timing", () => {
  it("aims to finish by six minutes with a backstop a minute later", () => {
    expect(FINISH_NUDGE_AFTER_SECONDS).toBe(270);
    expect(WRAP_UP_AFTER_SECONDS).toBe(300);
    expect(WRAP_UP_NUDGE_AFTER_SECONDS).toBe(330);
    expect(FORCED_WRAP_UP_AFTER_SECONDS).toBe(390);
    expect(CALL_TIME_LIMIT_SECONDS).toBe(420);
    const update = buildTelnyxAssistantUpdate(createDemoConfig(), "https://front-office.example");
    expect((update.telephony_settings as { time_limit_secs: number }).time_limit_secs).toBe(420);
  });

  it("picks the nudge due for the call's age", () => {
    expect(dueCallLengthStage(0)).toBeNull();
    expect(dueCallLengthStage(269.9)).toBeNull();
    expect(dueCallLengthStage(270)).toBe("finish");
    expect(dueCallLengthStage(329)).toBe("finish");
    expect(dueCallLengthStage(330)).toBe("wrap_up");
    expect(dueCallLengthStage(389)).toBe("wrap_up");
    expect(dueCallLengthStage(390)).toBe("forced_wrap_up");
    expect(dueCallLengthStage(419)).toBe("forced_wrap_up");
    expect(dueCallLengthStage(420)).toBeNull();
  });

  it("tells the assistant to follow a system wrap-up message", () => {
    expect(buildVoiceSystemPrompt(createDemoConfig())).toContain("A system message may tell you to finish the call or to wrap up now. Follow it right away; only the safety rules come first.");
  });
});

describe("call length guard", () => {
  let store: InMemoryStore;
  let clock: MutableClock;
  let service: CallService;
  let messenger: RecordingMessenger;
  let logs: Array<Record<string, unknown>>;
  let guard: CallLengthGuard;
  const start = (id: string) => service.recordStarted({ eventId: `start:${id}`, tenantId: "demo", providerCallId: id, fromNumber: "+15555550177", startedAt: clock.now().toISOString() });

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    clock = new MutableClock(new Date("2026-11-24T15:00:00.000Z"));
    service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example");
    messenger = new RecordingMessenger();
    logs = [];
    guard = new CallLengthGuard(store, messenger, clock, (entry) => logs.push(entry));
  });

  it("sends the 4:30, 5:30 and 6:30 messages once each, then nothing", async () => {
    await start("v3:long");
    clock.advance(269_000);
    expect(await guard.runOnce()).toEqual({ sent: 0, ended: 0, failed: 0 });

    clock.advance(1_000);
    expect(await guard.runOnce()).toEqual({ sent: 1, ended: 0, failed: 0 });
    expect(messenger.sent[0]).toMatchObject({ callControlId: "v3:long", commandId: "front-office-call-length:finish", triggerResponse: false });
    expect(messenger.sent[0]!.content).toContain("Wrap it up within one minute");
    expect(messenger.sent[0]!.content).toContain(`say exactly "${WRAP_UP_LINE}"`);
    clock.advance(5_000);
    await guard.runOnce();
    expect(messenger.sent).toHaveLength(1);

    clock.advance(55_000);
    expect(await guard.runOnce()).toEqual({ sent: 1, ended: 0, failed: 0 });
    expect(messenger.sent[1]).toMatchObject({ callControlId: "v3:long", commandId: "front-office-call-length:wrap_up", triggerResponse: false });
    expect(messenger.sent[1]!.content).toBe(`Time is up. Save the intake if it changed, then say exactly "${WRAP_UP_LINE}" now and invoke the built-in hangup tool in the same turn. Do not ask anything else.`);

    clock.advance(55_000);
    await guard.runOnce();
    expect(messenger.sent).toHaveLength(2);
    // Still talking at 6:30: the same wrap-up message again, now starting a turn.
    clock.advance(5_000);
    expect(await guard.runOnce()).toEqual({ sent: 1, ended: 0, failed: 0 });
    expect(messenger.sent[2]).toMatchObject({ commandId: "front-office-call-length:forced_wrap_up", triggerResponse: true, content: messenger.sent[1]!.content });

    for (let step = 0; step < 20; step += 1) {
      clock.advance(5_000);
      await guard.runOnce();
    }
    expect(messenger.sent).toHaveLength(3);
  });

  it("sends each message once across replicas", async () => {
    await start("v3:shared");
    clock.advance(271_000);
    const other = new CallLengthGuard(store, messenger, clock, () => undefined);
    await Promise.all([guard.runOnce(), other.runOnce(), guard.runOnce()]);
    expect(messenger.sent).toHaveLength(1);
  });

  it("goes straight to the wrap-up message when the 4:30 window was missed", async () => {
    await start("v3:late");
    clock.advance(340_000);
    await guard.runOnce();
    expect(messenger.sent.map((entry) => entry.commandId)).toEqual(["front-office-call-length:wrap_up"]);
  });

  it("keeps the 911 line in an emergency's wrap-up", async () => {
    await start("v3:gas");
    const call = await store.getCallByProviderId("v3:gas");
    await store.saveCall({ ...call!, emergency: { emergency: true, severity: "life_safety", score: 1, evidence: ["gas"], immediateInstruction: null } });
    clock.advance(335_000);
    await guard.runOnce();
    expect(messenger.sent[0]!.content).toContain("tell them in one sentence to leave and call 911");
    expect(messenger.sent[0]!.content).toContain(`say exactly "${WRAP_UP_LINE}"`);
    await start("v3:gas-early");
    const early = await store.getCallByProviderId("v3:gas-early");
    await store.saveCall({ ...early!, emergency: { emergency: true, severity: "life_safety", score: 1, evidence: ["gas"], immediateInstruction: null } });
    clock.advance(275_000);
    await guard.runOnce();
    expect(messenger.sent.find((entry) => entry.callControlId === "v3:gas-early")!.content).toContain("remind them in one sentence to leave and call 911");
  });

  it("leaves finished calls and calls past the backstop alone", async () => {
    await start("v3:done");
    const done = await store.getCallByProviderId("v3:done");
    await store.saveCall({ ...done!, outcome: "handoff_queued" });
    await start("v3:old");
    clock.advance(421_000);
    await guard.runOnce();
    expect(messenger.sent).toEqual([]);
  });

  it("records a call that already ended and does not retry it", async () => {
    await start("v3:gone");
    clock.advance(280_000);
    messenger.next.push("call_ended");
    expect(await guard.runOnce()).toEqual({ sent: 0, ended: 1, failed: 0 });
    clock.advance(30_000);
    await guard.runOnce();
    expect(messenger.sent).toHaveLength(1);
  });

  it("does not retry a message Telnyx rejected", async () => {
    await start("v3:transferred");
    clock.advance(280_000);
    messenger.next.push("rejected");
    expect(await guard.runOnce()).toEqual({ sent: 0, ended: 0, failed: 1 });
    expect(logs.at(-1)).toMatchObject({ level: "warn", event: "call_length_nudge", result: "rejected" });
    clock.advance(30_000);
    await guard.runOnce();
    expect(messenger.sent).toHaveLength(1);
  });

  it("keeps nudging other calls when one call's ledger claim fails", async () => {
    await start("v3:first");
    await start("v3:second");
    clock.advance(280_000);
    const claim = store.claimToolResult.bind(store);
    store.claimToolResult = async (providerCallId, ...rest) => {
      if (providerCallId === "v3:first") throw new Error("ledger unavailable");
      return claim(providerCallId, ...rest);
    };
    expect(await guard.runOnce()).toEqual({ sent: 1, ended: 0, failed: 1 });
    expect(messenger.sent.map((entry) => entry.callControlId)).toEqual(["v3:second"]);
  });

  it("logs a failed send and retries it only after the claim goes stale", async () => {
    await start("v3:flaky");
    clock.advance(275_000);
    messenger.next.push(new Error("Telnyx add-messages failed with HTTP 503"));
    expect(await guard.runOnce()).toEqual({ sent: 0, ended: 0, failed: 1 });
    expect(logs.at(-1)).toMatchObject({ level: "warn", event: "call_length_nudge_failed", stage: "finish" });
    clock.advance(5_000);
    expect(await guard.runOnce()).toEqual({ sent: 0, ended: 0, failed: 0 });
    clock.advance(20_000);
    expect(await guard.runOnce()).toEqual({ sent: 1, ended: 0, failed: 0 });
    expect(messenger.sent).toHaveLength(1);
  });
});

describe("Telnyx add-messages client", () => {
  it("posts one system message with a command_id and no forced turn", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new TelnyxAssistantMessenger("test-key", (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ data: { result: "ok" } }), { status: 200 });
    }) as typeof fetch);
    expect(await client.addSystemMessage("v3:abc/def", "Wrap up.", "front-office-call-length:finish")).toBe("sent");
    expect(requests[0]!.url).toBe("https://api.telnyx.com/v2/calls/v3%3Aabc%2Fdef/actions/ai_assistant_add_messages");
    expect(requests[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      messages: [{ role: "system", content: "Wrap up." }],
      command_id: "front-office-call-length:finish",
      trigger_response: false,
    });
    await client.addSystemMessage("v3:abc", "Wrap up now.", "front-office-call-length:forced_wrap_up", { triggerResponse: true });
    expect(JSON.parse(String(requests[1]!.init.body)).trigger_response).toBe(true);
  });

  it("treats call-ended errors as ended and throws on the rest", async () => {
    const respond = (status: number, code: string) => new TelnyxAssistantMessenger("test-key", (async () =>
      new Response(JSON.stringify({ errors: [{ code, title: "x" }] }), { status })) as typeof fetch);
    expect(await respond(422, "90018").addSystemMessage("v3:a", "x", "c")).toBe("call_ended");
    expect(await respond(422, "90015").addSystemMessage("v3:a", "x", "c")).toBe("call_ended");
    expect(await respond(404, "10005").addSystemMessage("v3:a", "x", "c")).toBe("call_ended");
    expect(await respond(422, "90061").addSystemMessage("v3:a", "x", "c")).toBe("rejected");
    await expect(respond(429, "10011").addSystemMessage("v3:a", "x", "c")).rejects.toThrow("HTTP 429");
    await expect(respond(500, "10007").addSystemMessage("v3:a", "x", "c")).rejects.toThrow("HTTP 500 (code 10007)");
  });
});
