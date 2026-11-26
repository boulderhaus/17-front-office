import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { buildSetupAssistant, SETUP_HELP_INSTRUCTIONS, setupHelpVariables } from "../src/adapters/telnyx-setup-call.js";
import { PLATFORM_TENANT_ID } from "../src/ports.js";
import { DEFAULT_TELNYX_VOICE, ottoSpeechSettings } from "../src/voice/system-prompt.js";
import { applySetupHelper, planSetupHelper } from "../scripts/configure-telnyx.js";
import { labOwnerScript, labTargetAllowed, parseSetupSelftestArgs, setupVerdict } from "../scripts/selftest-setup-call.js";

describe("the setup helper assistant (configure-telnyx)", () => {
  it("uses Otto's voice, speech settings and model (copied, never named), a six-minute cap, and every variable the template names", async () => {
    const store = new InMemoryStore();
    const plan = await planSetupHelper({ store, ottoAssistant: { model: "provider/otto-model", voice_settings: { voice: "other" }, instructions: "shop prompt" }, publicBaseUrl: "https://callotto.example/", voice: "Telnyx.Voice.synthetic" });
    expect(plan.assistantId).toBeNull();
    expect(plan.body).toMatchObject({ name: "Call Otto · Setup helper", model: "provider/otto-model", voice_settings: { voice: "Telnyx.Voice.synthetic" }, telephony_settings: { time_limit_secs: 360 } });
    expect(plan.body.instructions).toBe(SETUP_HELP_INSTRUCTIONS);
    expect(plan.body.transcription).toEqual(ottoSpeechSettings().transcription);
    expect(plan.body.interruption_settings).toEqual(ottoSpeechSettings().interruption_settings);
    // Only Otto's model carries over: never the shop's prompt or voice.
    expect(JSON.stringify(plan.body)).not.toContain("shop prompt");
    const named = [...SETUP_HELP_INSTRUCTIONS.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]);
    const variables = Object.keys(setupHelpVariables({ businessName: "x", businessNumber: null, carrierName: null, family: null, code: null, offCode: null, confirm: null, ottoNumber: "+19415550123", device: "other" }));
    for (const name of named) expect(variables).toContain(name);
    expect(Object.keys(plan.body.dynamic_variables as Record<string, string>).sort()).toEqual([...variables].sort());
    expect(buildSetupAssistant({ publicBaseUrl: "https://x.example" }).voice_settings).toMatchObject({ voice: DEFAULT_TELNYX_VOICE });
    const tools = plan.body.tools as Array<{ webhook?: { url: string; preset_body_fields: Record<string, string> } }>;
    expect(tools[0]!.webhook!.url).toBe("https://callotto.example/setup-help/tools/start_forwarding_test");
    expect(tools[0]!.webhook!.preset_body_fields).toEqual({ provider_call_id: "{{call_control_id}}" });
  });

  it("creates the helper once (saving its id where the app reads it), then updates that one", async () => {
    const store = new InMemoryStore();
    const requests: Array<{ path: string; method: string | undefined }> = [];
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      requests.push({ path, method: init?.method });
      return { data: { id: "setup-assistant-1" } } as T;
    };
    const first = await applySetupHelper({ plan: await planSetupHelper({ store, ottoAssistant: {}, publicBaseUrl: "https://x.example" }), store, request });
    expect(first).toEqual({ assistantId: "setup-assistant-1", action: "created" });
    expect(await store.getIntegrationSecret(PLATFORM_TENANT_ID, "telnyx", "setup_assistant_id")).toBe("setup-assistant-1");
    const second = await applySetupHelper({ plan: await planSetupHelper({ store, ottoAssistant: {}, publicBaseUrl: "https://x.example" }), store, request });
    expect(second).toEqual({ assistantId: "setup-assistant-1", action: "updated" });
    expect(requests.map((item) => item.path)).toEqual(["/ai/assistants", "/ai/assistants/setup-assistant-1"]);
    // TELNYX_SETUP_ASSISTANT_ID wins.
    expect((await planSetupHelper({ store, setupAssistantId: "from-env", ottoAssistant: {}, publicBaseUrl: "https://x.example" })).assistantId).toBe("from-env");
  });
});

describe("the support call selftest", () => {
  it("only ever rings the lab number when it is the shop's saved owner mobile", () => {
    expect(parseSetupSelftestArgs(["--tenant", "shop_1", "--lab", "+15555550142", "--book"], {})).toEqual({ tenantId: "shop_1", lab: "+15555550142", book: true });
    expect(() => parseSetupSelftestArgs(["--tenant", "shop_1"], {})).toThrow(/lab/);
    expect(() => parseSetupSelftestArgs(["--tenant", "shop_1", "--lab", "+15555550142", "--to", "+15555550100"], {})).toThrow(/Unknown argument/);
    expect(labTargetAllowed({ lab: "+15555550142", ownerMobile: "+15555550142", ottoLine: "+15555550123", fromNumber: "+15555550199" })).toBe(true);
    expect(labTargetAllowed({ lab: "+15555550142", ownerMobile: "+15555550100", ottoLine: "+15555550123", fromNumber: "+15555550199" })).toBe(false);
    expect(labTargetAllowed({ lab: "+15555550123", ownerMobile: "+15555550123", ottoLine: "+15555550123", fromNumber: "+15555550199" })).toBe(false);
  });

  it("passes only when answered, every setup tool worked, it ended done (booked with --book) and under the cap", () => {
    const record = { answeredAt: "a", endedAt: "b", outcome: "done", bookedAt: "c" };
    const tools = [{ name: "email_steps", status: "sent", ok: true }, { name: "get_test_result", status: "idle", ok: true }];
    expect(setupVerdict({ tools, record, book: true, elapsedMs: 120_000 }).pass).toBe(true);
    expect(setupVerdict({ tools, record: { ...record, outcome: "voicemail" }, book: false, elapsedMs: 120_000 }).pass).toBe(false);
    expect(setupVerdict({ tools: [{ name: "email_steps", status: "failed", ok: false }], record, book: false, elapsedMs: 120_000 }).pass).toBe(false);
    expect(setupVerdict({ tools: [], record, book: false, elapsedMs: 120_000 }).pass).toBe(false);
    expect(setupVerdict({ tools, record: { answeredAt: "a", endedAt: "b", outcome: "done" }, book: true, elapsedMs: 120_000 }).pass).toBe(false);
    expect(setupVerdict({ tools, record, book: false, elapsedMs: 7 * 60_000 }).pass).toBe(false);
    expect(labOwnerScript(true)).toContain("talk to a person");
    expect(labOwnerScript(false)).not.toContain("talk to a person");
  });
});
