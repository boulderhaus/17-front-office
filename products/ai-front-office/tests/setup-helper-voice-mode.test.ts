import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { buildSetupAssistant, buildSetupHelper, inheritedModel, setupHelpTools, setupInstructions, TelnyxSetupCaller, type SetupCallFacts } from "../src/adapters/telnyx-setup-call.js";
import { PLATFORM_TENANT_ID } from "../src/ports.js";
import { S2S_INSTRUCTION_LIMIT_CHARS, type SpeechToSpeechSettings } from "../src/voice/voice-mode.js";
import { describeSetupHelper, planSetupHelper } from "../scripts/configure-telnyx.js";

// Synthetic ids only: no real model, voice, number or assistant appears in this file.
const BASE = "https://front-office.example";
const SPEECH_MODEL = "synthetic/speech-model";
const SPEECH_VOICE = "SyntheticVoice.One";
const TEXT_MODEL = "synthetic/text-model";
const TTS_VOICE = "Synthetic.Tts";
/** TELNYX_VOICE_MODE=speech_to_speech with the model and voice set. */
const DEFAULT_ON: SpeechToSpeechSettings = { tenantIds: [], model: SPEECH_MODEL, voice: SPEECH_VOICE, defaultMode: "speech_to_speech", standardTenantIds: [], demoTenantId: "demo" };
/** The mode turned back off (rollback), with the model and voice still set. */
const DEFAULT_OFF: SpeechToSpeechSettings = { ...DEFAULT_ON, defaultMode: "standard" };
/** Otto's (the demo) assistant, or the helper itself, as Telnyx reports it in each mode. */
const standardAssistant = { data: { model: TEXT_MODEL, delegation_settings: null, voice_settings: { voice: TTS_VOICE, voice_speed: 1 }, enabled_features: ["telephony"], telephony_settings: { default_texml_app_id: "texml_1" } } };
const s2sAssistant = { data: { model: SPEECH_MODEL, delegation_settings: { enabled: true, mode: "telnyx", model: TEXT_MODEL, speak_results: true }, voice_settings: { voice: SPEECH_VOICE }, enabled_features: ["telephony"], telephony_settings: { default_texml_app_id: "texml_1" } } };
const DELEGATION = { enabled: true, mode: "telnyx", model: TEXT_MODEL, speak_results: true };

describe("the \"Call me now\" setup helper in either voice mode", () => {
  const otto = { standard: standardAssistant.data, s2s: s2sAssistant.data };
  const build = (input: Partial<Parameters<typeof buildSetupHelper>[0]>) => buildSetupHelper({ publicBaseUrl: BASE, voice: TTS_VOICE, ...input });
  const standardBody = buildSetupAssistant({ publicBaseUrl: BASE, voice: TTS_VOICE, inherited: inheritedModel(otto.standard) });

  it("standard mode with a standard Otto is byte for byte what it was", () => {
    for (const speechToSpeech of [undefined, DEFAULT_OFF, { ...DEFAULT_OFF, tenantIds: [PLATFORM_TENANT_ID] }]) {
      const built = build({ ottoAssistant: otto.standard, speechToSpeech });
      expect(JSON.stringify(built.body)).toBe(JSON.stringify(standardBody));
      expect(built).toMatchObject({ mode: "standard", rollback: false, cut: [] });
      expect(built.fallback).toBeUndefined();
    }
    expect(standardBody).toMatchObject({ model: TEXT_MODEL, voice_settings: { voice: TTS_VOICE, voice_speed: 1 } });
    // Otto's assistant wrapped in Telnyx's { data } reads the same.
    expect(JSON.stringify(build({ ottoAssistant: standardAssistant }).body)).toBe(JSON.stringify(standardBody));
  });

  it("standard mode while Otto is still speech-to-speech: the backend text model and the text-to-speech voice, never the speaking model", () => {
    // A helper made now (nothing to roll back): Otto's delegation backend is its text model.
    const fresh = build({ ottoAssistant: otto.s2s, speechToSpeech: DEFAULT_OFF });
    expect(JSON.stringify(fresh.body)).toBe(JSON.stringify(standardBody));
    expect(fresh).toMatchObject({ mode: "standard", rollback: false });
    // The helper itself still in speech-to-speech mode: delegation is turned off too.
    const back = build({ ottoAssistant: otto.s2s, speechToSpeech: DEFAULT_OFF, existing: s2sAssistant });
    expect(back).toMatchObject({ mode: "standard", rollback: true });
    expect(back.body).toEqual({ ...standardBody, model: TEXT_MODEL, delegation_settings: { enabled: false } });
    expect(JSON.stringify(back.body)).not.toContain(SPEECH_MODEL);
    expect(JSON.stringify(back.body)).not.toContain(SPEECH_VOICE);
    // Otto already standard again but the helper not yet: it is still put back, on Otto's text model.
    expect(build({ ottoAssistant: otto.standard, speechToSpeech: DEFAULT_OFF, existing: s2sAssistant }).body).toEqual({ ...standardBody, model: TEXT_MODEL, delegation_settings: { enabled: false } });
  });

  it("default mode: the same speaking model and voice as Otto, delegating its own tools to the same backend text model", () => {
    for (const [ottoAssistant, existing] of [[otto.standard, null], [otto.s2s, null], [otto.s2s, s2sAssistant], [otto.standard, standardAssistant]] as const) {
      const built = build({ ottoAssistant, speechToSpeech: DEFAULT_ON, existing });
      expect(built).toMatchObject({ mode: "speech_to_speech", rollback: false, cut: [] });
      expect(built.fallback).toBeUndefined();
      expect(built.body).toMatchObject({ model: SPEECH_MODEL, delegation_settings: DELEGATION });
      expect(built.body.voice_settings).toEqual({ voice: SPEECH_VOICE, tool_call_audio: (standardBody.voice_settings as Record<string, unknown>).tool_call_audio });
      // Its own tools, prompt, variables, speech settings and six-minute cap are unchanged.
      for (const key of ["name", "instructions", "greeting", "tools", "dynamic_variables", "telephony_settings", "transcription", "interruption_settings", "enabled_features"]) expect(built.body[key], key).toEqual(standardBody[key]);
      expect(built.body.tools).toEqual(setupHelpTools(BASE));
    }
    // TELNYX_S2S_BACKEND_MODEL wins, as for shops.
    expect(build({ ottoAssistant: otto.s2s, speechToSpeech: { ...DEFAULT_ON, backendModel: "synthetic/other-text" } }).body.delegation_settings).toMatchObject({ model: "synthetic/other-text" });
  });

  it("default mode falls back to standard like a shop does, and \"platform\" on the opt-out list keeps it standard", () => {
    const noVoice = build({ ottoAssistant: otto.s2s, speechToSpeech: { ...DEFAULT_ON, voice: undefined }, existing: s2sAssistant });
    expect(noVoice).toMatchObject({ mode: "standard", fallback: "s2s_voice_not_set", rollback: true });
    expect(noVoice.body).toEqual({ ...standardBody, model: TEXT_MODEL, delegation_settings: { enabled: false } });
    // No assistant to read a text model from, and none configured: standard, and no model is invented.
    const unknown = build({ ottoAssistant: {}, speechToSpeech: DEFAULT_ON });
    expect(unknown).toMatchObject({ mode: "standard", fallback: "no_backend_model", rollback: false });
    expect(unknown.body.model).toBeUndefined();
    expect(unknown.body.delegation_settings).toBeUndefined();
    const optedOut = build({ ottoAssistant: otto.s2s, speechToSpeech: { ...DEFAULT_ON, standardTenantIds: [PLATFORM_TENANT_ID] }, existing: s2sAssistant });
    expect(optedOut).toMatchObject({ mode: "standard", rollback: true });
    expect(optedOut.fallback).toBeUndefined();
    expect(optedOut.body).toMatchObject({ model: TEXT_MODEL, voice_settings: { voice: TTS_VOICE }, delegation_settings: { enabled: false } });
  });

  it("what the helper reads on a call always fits the speech-to-speech limit", () => {
    const base: SetupCallFacts = { businessName: "Synthetic Plumbing and Heating Company", businessNumber: "+15555550123", carrierName: "Synthetic Mobile", family: "gsm", code: "**61*15555550142*11*20#", offCode: "##61#", confirm: "A gray box that says Setting Activation Succeeded.", ottoNumber: "+15555550142", device: "iphone", ringSeconds: 20, everyCallCode: "**21*15555550142#", ringFirstCode: "**61*15555550142*11*20#", ringFirstSeconds: 20, phoneAnswersTest: true, ringFirstExtras: ["**67*15555550142#", "**62*15555550142#"] };
    let longest = 0;
    for (const device of ["iphone", "android", "other"] as const) for (const family of ["gsm", "verizon", "office", "unknown"] as const) for (const forwardsAll of [true, false]) for (const ringFirstRetry of [null, "clear", "clear_again", "instead", "help"] as const) for (const everyCallOn of [true, false]) {
      longest = Math.max(longest, setupInstructions({ ...base, device, family, forwardsAll, ringFirstRetry, everyCallOn, code: family === "gsm" || family === "verizon" ? base.code : null }).length);
    }
    expect(longest).toBeGreaterThan(3_000);
    expect(longest).toBeLessThan(S2S_INSTRUCTION_LIMIT_CHARS);
  });

  it("configure plans it from Otto's assistant and the helper as Telnyx has them, and says the plan in the dry run", async () => {
    const store = new InMemoryStore();
    const reads: string[] = [];
    const readAssistant = async (assistantId: string) => { reads.push(assistantId); return s2sAssistant; };
    // Turning the mode on: Otto still standard, no helper yet.
    const created = await planSetupHelper({ store, ottoAssistant: otto.standard, publicBaseUrl: BASE, voice: TTS_VOICE, speechToSpeech: DEFAULT_ON, readAssistant });
    expect(created).toMatchObject({ assistantId: null, mode: "speech_to_speech", rollback: false, body: { model: SPEECH_MODEL, delegation_settings: DELEGATION } });
    expect(reads).toEqual([]);
    expect(describeSetupHelper(created)).toMatchObject({ action: "would_create", tenantId: PLATFORM_TENANT_ID, mode: "speech_to_speech", fallback: null, rollback: false, cut: [], model: SPEECH_MODEL, delegation_settings: DELEGATION, voice_settings: { voice: SPEECH_VOICE }, tools: ["start_forwarding_test", "get_test_result", "email_steps", "get_open_times", "book_time", "hangup"] });
    // Turning it off: Otto and the helper both still speech-to-speech.
    await store.saveIntegrationSecret(PLATFORM_TENANT_ID, "telnyx", "setup_assistant_id", "assistant_helper");
    const rolledBack = await planSetupHelper({ store, ottoAssistant: otto.s2s, publicBaseUrl: BASE, voice: TTS_VOICE, speechToSpeech: DEFAULT_OFF, readAssistant });
    expect(reads).toEqual(["assistant_helper"]);
    expect(describeSetupHelper(rolledBack)).toMatchObject({ action: "would_update", assistantId: "assistant_helper", mode: "standard", fallback: null, rollback: true, model: TEXT_MODEL, delegation_settings: { enabled: false }, voice_settings: { voice: TTS_VOICE } });
    // A helper that can't be read is never pushed blind.
    await expect(planSetupHelper({ store, ottoAssistant: otto.s2s, publicBaseUrl: BASE, speechToSpeech: DEFAULT_OFF, readAssistant: async () => { throw new Error("HTTP 503"); } })).rejects.toThrow("HTTP 503");
  });

  it("a helper the app has to make itself is built the same way, from a template in either mode", async () => {
    const made = async (template: Record<string, unknown>, speechToSpeech: SpeechToSpeechSettings | undefined) => {
      const bodies: Array<Record<string, unknown>> = [];
      const secrets = new Map<string, string>();
      const fetcher = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/ai/assistants/template")) return Response.json(template);
        if (url.endsWith("/ai/assistants")) { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json({ data: { id: "assistant_helper" } }); }
        return Response.json({});
      }) as typeof fetch;
      const caller = new TelnyxSetupCaller({ apiKey: "synthetic", templateAssistantId: "template", publicBaseUrl: BASE, voice: TTS_VOICE, speechToSpeech, getSecret: async (_tenant, _provider, key) => secrets.get(key) ?? null, saveSecret: async (_tenant, _provider, key, value) => { secrets.set(key, value); }, fetcher });
      await caller.start({ callControlId: "v3:synthetic", commandId: "command-1", clientState: "state", facts: { businessName: "Synthetic Plumbing", businessNumber: null, carrierName: null, family: null, code: null, offCode: null, confirm: null, ottoNumber: "+15555550142", device: "other" } });
      expect(secrets.get("setup_assistant_id")).toBe("assistant_helper");
      return bodies[0]!;
    };
    for (const template of [standardAssistant, s2sAssistant]) {
      expect(await made(template, DEFAULT_ON)).toMatchObject({ model: SPEECH_MODEL, voice_settings: { voice: SPEECH_VOICE }, delegation_settings: DELEGATION });
      const standard = await made(template, DEFAULT_OFF);
      expect(JSON.stringify(standard)).toBe(JSON.stringify(standardBody));
      expect(JSON.stringify(await made(template, undefined))).toBe(JSON.stringify(standardBody));
    }
  });
});
