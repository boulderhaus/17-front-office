import { describe, expect, it } from "vitest";
import { saveAssistantConfig } from "../src/adapters/assistant-config.js";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { TelnyxProvisioner } from "../src/adapters/telnyx-provisioning.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { BusinessConfig } from "../src/domain/models.js";
import { buildTelnyxAssistantUpdate } from "../src/voice/system-prompt.js";
import { buildShopAssistantPayload, isSpeechToSpeechTenant, resolveVoiceMode, S2S_INSTRUCTION_LIMIT_CHARS, speechToSpeechSettings, voiceRequest, VoiceModeError, type SpeechToSpeechSettings } from "../src/voice/voice-mode.js";
import { describePush, planAssistantPushes } from "../scripts/configure-telnyx.js";
import { liveShop } from "./support/live-shop.js";

// Synthetic ids only: no real model, voice, number or assistant appears in this file.
const BASE = "https://front-office.example";
const SPEECH_MODEL = "synthetic/speech-model";
const SPEECH_VOICE = "SyntheticVoice.One";
const TEXT_MODEL = "synthetic/text-model";
const TTS_VOICE = "Synthetic.Tts";
/** TELNYX_VOICE_MODE=speech_to_speech with the model and voice set: the default for every tenant. */
const DEFAULT_ON: SpeechToSpeechSettings = { tenantIds: [], model: SPEECH_MODEL, voice: SPEECH_VOICE, defaultMode: "speech_to_speech", standardTenantIds: [], demoTenantId: "demo" };
/** The mode turned back off (rollback), with the model and voice still set. */
const DEFAULT_OFF: SpeechToSpeechSettings = { ...DEFAULT_ON, defaultMode: "standard" };
const standardAssistant = { data: { model: TEXT_MODEL, delegation_settings: null, voice_settings: { voice: TTS_VOICE, voice_speed: 1 }, enabled_features: ["telephony"], telephony_settings: { default_texml_app_id: "texml_1" } } };
const s2sAssistant = { data: { model: SPEECH_MODEL, delegation_settings: { enabled: true, mode: "telnyx", model: TEXT_MODEL, speak_results: true }, voice_settings: { voice: SPEECH_VOICE }, enabled_features: ["telephony"], telephony_settings: { default_texml_app_id: "texml_1" } } };
const DELEGATION = { enabled: true, mode: "telnyx", model: TEXT_MODEL, speak_results: true };
const shop = (tenantId: string): BusinessConfig => ({ ...createDemoConfig(tenantId), businessName: "Synthetic Plumbing" });
/** A shop whose approved answers push the prompt past the speech-to-speech limit even after the style section is cut. */
const longShop = (tenantId: string): BusinessConfig => ({ ...shop(tenantId), approvedKnowledge: Array.from({ length: 80 }, (_, index) => ({ topic: `t${index}`, text: "x".repeat(70) })) });
const toolNames = (payload: Record<string, unknown>) => (payload.tools as Array<{ type: string; webhook?: { name: string } }>).map((tool) => tool.webhook?.name ?? tool.type);
const route = (tenantId: string, externalId: string) => ({ provider: "telnyx" as const, externalId, tenantId, createdAt: "2026-11-27T00:00:00.000Z", updatedAt: "2026-11-27T00:00:00.000Z" });

describe("TELNYX_VOICE_MODE: which voice a tenant is asked to use", () => {
  it("is standard unless the env says otherwise, and parses the opt-out list like the opt-in list", () => {
    const off = demoEnvironment();
    expect(off.TELNYX_VOICE_MODE).toBe("standard");
    expect(off.TELNYX_STANDARD_TENANT_IDS).toEqual([]);
    expect(speechToSpeechSettings(off)).toMatchObject({ defaultMode: "standard", standardTenantIds: [], tenantIds: [], demoTenantId: off.DEFAULT_TENANT_ID });
    expect(demoEnvironment({ TELNYX_VOICE_MODE: "" }).TELNYX_VOICE_MODE).toBe("standard");
    const on = demoEnvironment({ TELNYX_VOICE_MODE: "speech_to_speech", TELNYX_STANDARD_TENANT_IDS: " shop_a, shop_b ,shop_a,", TELNYX_S2S_MODEL: SPEECH_MODEL, TELNYX_S2S_VOICE: SPEECH_VOICE });
    expect(on.TELNYX_STANDARD_TENANT_IDS).toEqual(["shop_a", "shop_b"]);
    expect(speechToSpeechSettings(on)).toMatchObject({ defaultMode: "speech_to_speech", standardTenantIds: ["shop_a", "shop_b"], model: SPEECH_MODEL, voice: SPEECH_VOICE });
    expect(() => demoEnvironment({ TELNYX_VOICE_MODE: "loud" })).toThrow();
  });

  it("default off: only tenants on the opt-in list, never the demo line", () => {
    const settings: SpeechToSpeechSettings = { ...DEFAULT_OFF, tenantIds: ["shop_lab", "demo"] };
    expect(voiceRequest(settings, "shop_regular")).toEqual({ want: "standard", strict: false });
    expect(voiceRequest(settings, "shop_lab")).toEqual({ want: "speech_to_speech", strict: true });
    expect(voiceRequest(settings, "demo")).toEqual({ want: "standard", strict: false });
    expect(voiceRequest(undefined, "shop_lab")).toEqual({ want: "standard", strict: false });
    // Settings built before the mode existed (no defaultMode) are standard.
    expect(isSpeechToSpeechTenant({ tenantIds: [], model: SPEECH_MODEL, voice: SPEECH_VOICE }, "shop_regular")).toBe(false);
  });

  it("default on: every tenant and the demo line, except the opt-out list (which always wins)", () => {
    expect(voiceRequest(DEFAULT_ON, "shop_regular")).toEqual({ want: "speech_to_speech", strict: false });
    expect(voiceRequest(DEFAULT_ON, "demo")).toEqual({ want: "speech_to_speech", strict: false });
    const settings: SpeechToSpeechSettings = { ...DEFAULT_ON, tenantIds: ["shop_lab", "shop_both"], standardTenantIds: ["shop_out", "shop_both"] };
    expect(voiceRequest(settings, "shop_out")).toEqual({ want: "standard", strict: false });
    expect(voiceRequest(settings, "shop_both")).toEqual({ want: "standard", strict: false });
    // Still explicitly listed, so still strict.
    expect(voiceRequest(settings, "shop_lab")).toEqual({ want: "speech_to_speech", strict: true });
    // The opt-out list also wins while the mode is standard.
    expect(voiceRequest({ ...settings, defaultMode: "standard" }, "shop_both")).toEqual({ want: "standard", strict: false });
  });

  it("default on builds the same speech-to-speech payload a listed shop gets", () => {
    const config = shop("shop_regular");
    const byDefault = buildShopAssistantPayload(config, BASE, { voice: TTS_VOICE, speechToSpeech: DEFAULT_ON, existing: standardAssistant });
    const listed = buildShopAssistantPayload(config, BASE, { voice: TTS_VOICE, speechToSpeech: { tenantIds: ["shop_regular"], model: SPEECH_MODEL, voice: SPEECH_VOICE }, existing: standardAssistant });
    expect(byDefault).toEqual(listed);
    expect(byDefault).toMatchObject({ mode: "speech_to_speech", rollback: false, cut: [] });
    expect(byDefault.fallback).toBeUndefined();
    expect(byDefault.payload).toMatchObject({ model: SPEECH_MODEL, delegation_settings: DELEGATION });
    expect((byDefault.payload.voice_settings as Record<string, unknown>).voice).toBe(SPEECH_VOICE);
    // The demo tenant goes through the same build.
    expect(buildShopAssistantPayload(shop("demo"), BASE, { speechToSpeech: DEFAULT_ON, existing: s2sAssistant })).toMatchObject({ mode: "speech_to_speech", payload: { model: SPEECH_MODEL, delegation_settings: DELEGATION } });
  });

  it("falls back to the standard payload, with the reason, when the instructions stay over the limit", () => {
    const config = longShop("shop_long");
    const today = buildTelnyxAssistantUpdate(config, BASE, { voice: TTS_VOICE });
    expect(String(today.instructions).length).toBeGreaterThan(S2S_INSTRUCTION_LIMIT_CHARS);
    const fresh = buildShopAssistantPayload(config, BASE, { voice: TTS_VOICE, speechToSpeech: DEFAULT_ON, existing: standardAssistant });
    expect(fresh).toMatchObject({ mode: "standard", fallback: "instructions_too_long", rollback: false, cut: [] });
    // A standard assistant gets exactly today's payload: the full instructions, nothing cut.
    expect(JSON.stringify(fresh.payload)).toBe(JSON.stringify(today));
    // An assistant already in speech-to-speech mode gets its text model back and delegation off.
    const back = buildShopAssistantPayload(config, BASE, { voice: TTS_VOICE, speechToSpeech: DEFAULT_ON, existing: s2sAssistant });
    expect(back).toMatchObject({ mode: "standard", fallback: "instructions_too_long", rollback: true });
    expect(back.payload).toEqual({ ...today, model: TEXT_MODEL, delegation_settings: { enabled: false } });
    expect((back.payload.voice_settings as Record<string, unknown>).voice).toBe(TTS_VOICE);
  });

  it("falls back, never throws, when the speech-to-speech env is incomplete", () => {
    const config = shop("shop_regular");
    const today = JSON.stringify(buildTelnyxAssistantUpdate(config, BASE));
    const cases: Array<[SpeechToSpeechSettings, Record<string, unknown> | null, string]> = [
      [{ ...DEFAULT_ON, model: undefined }, standardAssistant, "s2s_model_not_set"],
      [{ ...DEFAULT_ON, voice: undefined }, standardAssistant, "s2s_voice_not_set"],
      [DEFAULT_ON, null, "no_backend_model"],
      [DEFAULT_ON, { data: { model: SPEECH_MODEL, delegation_settings: null } }, "backend_model_is_s2s_model"],
    ];
    for (const [settings, existing, fallback] of cases) {
      const built = buildShopAssistantPayload(config, BASE, { speechToSpeech: settings, existing });
      expect(built, fallback).toMatchObject({ mode: "standard", fallback, rollback: false });
      expect(JSON.stringify(built.payload), fallback).toBe(today);
      expect(resolveVoiceMode(settings, config.tenantId, existing)).toEqual({ kind: "standard", fallback });
    }
    // Env incomplete while the assistant is still in speech-to-speech mode: standard, with its text model back.
    expect(buildShopAssistantPayload(config, BASE, { speechToSpeech: { ...DEFAULT_ON, voice: undefined }, existing: s2sAssistant })).toMatchObject({ mode: "standard", fallback: "s2s_voice_not_set", rollback: true, payload: { model: TEXT_MODEL, delegation_settings: { enabled: false } } });
    // TELNYX_S2S_BACKEND_MODEL stands in when nothing was read.
    expect(buildShopAssistantPayload(config, BASE, { speechToSpeech: { ...DEFAULT_ON, backendModel: "synthetic/other-text" }, existing: null })).toMatchObject({ mode: "speech_to_speech", payload: { delegation_settings: { model: "synthetic/other-text" } } });
  });

  it("keeps the strict errors for a tenant explicitly on the opt-in list, in either mode", () => {
    for (const defaultMode of ["standard", "speech_to_speech"] as const) {
      const listed: SpeechToSpeechSettings = { ...DEFAULT_ON, defaultMode, tenantIds: ["shop_lab"] };
      expect(() => buildShopAssistantPayload(shop("shop_lab"), BASE, { speechToSpeech: { ...listed, model: undefined }, existing: standardAssistant })).toThrow(/TELNYX_S2S_MODEL/);
      expect(() => buildShopAssistantPayload(shop("shop_lab"), BASE, { speechToSpeech: { ...listed, voice: undefined }, existing: standardAssistant })).toThrow(/TELNYX_S2S_VOICE/);
      expect(() => buildShopAssistantPayload(shop("shop_lab"), BASE, { speechToSpeech: listed, existing: null })).toThrow(VoiceModeError);
      expect(() => buildShopAssistantPayload(longShop("shop_lab"), BASE, { speechToSpeech: listed, existing: standardAssistant })).toThrow(/over the 10000/);
    }
  });

  it("opting a tenant out puts its speech-to-speech assistant back on its text model", () => {
    const config = shop("shop_out");
    const built = buildShopAssistantPayload(config, BASE, { voice: TTS_VOICE, speechToSpeech: { ...DEFAULT_ON, standardTenantIds: ["shop_out"] }, existing: s2sAssistant });
    expect(built).toMatchObject({ mode: "standard", rollback: true });
    expect(built.fallback).toBeUndefined();
    expect(built.payload).toEqual({ ...buildTelnyxAssistantUpdate(config, BASE, { voice: TTS_VOICE }), model: TEXT_MODEL, delegation_settings: { enabled: false } });
  });
});

describe("a new shop's assistant, made from a template in either mode", () => {
  function provisioner(template: Record<string, unknown>) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith("/ai/assistants/template") && !init?.method) return new Response(JSON.stringify(template));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { id: `assistant_${bodies.length}` } }));
    }) as typeof fetch;
    return { bodies, provisioner: new TelnyxProvisioner({ apiKey: "synthetic", templateAssistantId: "template", messagingProfileId: "profile", fetcher }) };
  }
  const create = async (template: Record<string, unknown>, config: BusinessConfig, speechToSpeech: SpeechToSpeechSettings | undefined) => {
    const made = provisioner(template);
    const voices: Array<Record<string, unknown>> = [];
    await made.provisioner.createAssistant({ tenantId: config.tenantId, businessName: config.businessName, assistantUpdate: buildTelnyxAssistantUpdate(config, BASE, { voice: TTS_VOICE }), speechToSpeech, onVoice: (voice) => voices.push(voice) });
    return { body: made.bodies[0]!, voice: voices[0]! };
  };

  it("default on: speech-to-speech from a standard template and from a speech-to-speech template", async () => {
    for (const template of [standardAssistant, s2sAssistant]) {
      const { body, voice } = await create(template, shop("shop_new"), DEFAULT_ON);
      expect(body).toMatchObject({ model: SPEECH_MODEL, delegation_settings: DELEGATION, enabled_features: ["telephony"] });
      // The paired voice only; the text-to-speech speed setting is left out.
      expect(body.voice_settings).toEqual({ voice: SPEECH_VOICE, tool_call_audio: (buildTelnyxAssistantUpdate(shop("shop_new"), BASE).voice_settings as Record<string, unknown>).tool_call_audio });
      expect(toolNames(body)).toContain("book_slot");
      expect(body.promote_to_main).toBeUndefined();
      expect(voice).toEqual({ mode: "speech_to_speech", cut: [], rollback: false });
    }
  });

  it("default on, a shop that can't be speech-to-speech: standard, and never a speaking model without delegation", async () => {
    // Standard template: exactly what a new shop got before (the template's text model, no delegation field).
    const plain = await create(standardAssistant, longShop("shop_long"), DEFAULT_ON);
    expect(plain.body).toMatchObject({ model: TEXT_MODEL, voice_settings: { voice: TTS_VOICE, voice_speed: 1 } });
    expect(plain.body.delegation_settings).toBeUndefined();
    expect(plain.voice).toEqual({ mode: "standard", cut: [], rollback: false, fallback: "instructions_too_long" });
    // Speech-to-speech template: its backend text model, the text-to-speech voice, delegation explicitly off.
    const fromS2s = await create(s2sAssistant, longShop("shop_long"), DEFAULT_ON);
    expect(fromS2s.body).toMatchObject({ model: TEXT_MODEL, voice_settings: { voice: TTS_VOICE, voice_speed: 1 }, delegation_settings: { enabled: false } });
    expect(fromS2s.voice).toEqual({ mode: "standard", cut: [], rollback: true, fallback: "instructions_too_long" });
    expect(JSON.stringify(fromS2s.body)).not.toContain(SPEECH_MODEL);
    expect(JSON.stringify(fromS2s.body)).not.toContain(SPEECH_VOICE);
    // The env half set (no voice): the same fallback, for every new shop.
    const noVoice = await create(s2sAssistant, shop("shop_new"), { ...DEFAULT_ON, voice: undefined });
    expect(noVoice.body).toMatchObject({ model: TEXT_MODEL, delegation_settings: { enabled: false } });
    expect(noVoice.voice).toMatchObject({ mode: "standard", fallback: "s2s_voice_not_set" });
  });

  it("standard shops made while the template is still in speech-to-speech mode get the text model too", async () => {
    // The mode was turned off, the shop opted out, or no settings were passed at all.
    for (const settings of [DEFAULT_OFF, { ...DEFAULT_ON, standardTenantIds: ["shop_new"] }, undefined]) {
      const { body, voice } = await create(s2sAssistant, shop("shop_new"), settings);
      expect(body).toMatchObject({ model: TEXT_MODEL, voice_settings: { voice: TTS_VOICE }, delegation_settings: { enabled: false } });
      expect(JSON.stringify(body)).not.toContain(SPEECH_MODEL);
      expect(voice).toEqual({ mode: "standard", cut: [], rollback: true });
    }
    // An update with no voice of its own never copies the speaking model's voice either.
    const made = provisioner(s2sAssistant);
    await made.provisioner.createAssistant({ tenantId: "shop_new", businessName: "Synthetic Plumbing", assistantUpdate: { instructions: "shop prompt" } });
    expect(made.bodies[0]).toMatchObject({ model: TEXT_MODEL, delegation_settings: { enabled: false } });
    expect(made.bodies[0]!.voice_settings).toBeUndefined();
  });

  it("standard mode with a standard template is byte for byte what it was", async () => {
    const config = shop("shop_new");
    const { promote_to_main: _promote, ...update } = buildTelnyxAssistantUpdate(config, BASE, { voice: TTS_VOICE });
    const expected = JSON.stringify({ model: TEXT_MODEL, voice_settings: update.voice_settings, enabled_features: ["telephony"], ...update, name: "Call Otto · Synthetic Plumbing" });
    for (const settings of [undefined, DEFAULT_OFF]) expect(JSON.stringify((await create(standardAssistant, config, settings)).body)).toBe(expected);
  });

  /** Telnyx that answers every speech-to-speech create (delegation on) with `status`, and makes anything else. */
  function refusing(template: Record<string, unknown>, status: number, options: { code?: string; refuseStandard?: boolean } = {}) {
    const posts: Array<{ key: string | null; body: Record<string, unknown> }> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith("/ai/assistants/template") && !init?.method) return new Response(JSON.stringify(template));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push({ key: new Headers(init?.headers).get("idempotency-key"), body });
      const speaking = (body.delegation_settings as { enabled?: unknown } | undefined)?.enabled === true;
      if (speaking || options.refuseStandard) return new Response(JSON.stringify({ errors: [{ code: options.code ?? "10015", detail: "synthetic refusal" }] }), { status: speaking ? status : 422 });
      return new Response(JSON.stringify({ data: { id: "assistant_standard" } }));
    }) as typeof fetch;
    const voices: Array<Record<string, unknown>> = [];
    const make = (config: BusinessConfig, speechToSpeech: SpeechToSpeechSettings) => new TelnyxProvisioner({ apiKey: "synthetic", templateAssistantId: "template", messagingProfileId: "profile", fetcher })
      .createAssistant({ tenantId: config.tenantId, businessName: config.businessName, assistantUpdate: buildTelnyxAssistantUpdate(config, BASE, { voice: TTS_VOICE }), speechToSpeech, onVoice: (voice) => voices.push(voice) });
    return { posts, voices, make };
  }

  it("default on, Telnyx refuses the speech-to-speech assistant: the shop is made once more on the standard payload, under its own key", async () => {
    const config = shop("shop_new");
    const { promote_to_main: _promote, ...update } = buildTelnyxAssistantUpdate(config, BASE, { voice: TTS_VOICE });
    // Standard template: the second create is byte for byte what a standard shop always got.
    const plain = refusing(standardAssistant, 422);
    expect(await plain.make(config, DEFAULT_ON)).toBe("assistant_standard");
    expect(plain.posts.map((post) => post.key)).toEqual(["front-office-assistant-shop_new", "front-office-assistant-shop_new-standard"]);
    expect(plain.posts[0]!.body).toMatchObject({ model: SPEECH_MODEL, delegation_settings: DELEGATION });
    expect(JSON.stringify(plain.posts[1]!.body)).toBe(JSON.stringify({ model: TEXT_MODEL, voice_settings: update.voice_settings, enabled_features: ["telephony"], ...update, name: "Call Otto · Synthetic Plumbing" }));
    expect(plain.voices).toEqual([
      { mode: "speech_to_speech", cut: [], rollback: false },
      { mode: "standard", cut: [], rollback: false, fallback: "provider_rejected", providerError: "Telnyx provisioning request failed with HTTP 422: synthetic refusal" },
    ]);
    // Speech-to-speech template: the template's backend text model, the text-to-speech voice, delegation explicitly off.
    const fromS2s = refusing(s2sAssistant, 400);
    expect(await fromS2s.make(config, DEFAULT_ON)).toBe("assistant_standard");
    expect(fromS2s.posts).toHaveLength(2);
    expect(fromS2s.posts[1]!.body).toMatchObject({ model: TEXT_MODEL, voice_settings: { voice: TTS_VOICE, voice_speed: 1 }, delegation_settings: { enabled: false } });
    expect(JSON.stringify(fromS2s.posts[1]!.body)).not.toContain(SPEECH_MODEL);
    expect(JSON.stringify(fromS2s.posts[1]!.body)).not.toContain(SPEECH_VOICE);
    expect(fromS2s.voices[1]).toMatchObject({ mode: "standard", rollback: true, fallback: "provider_rejected" });
  });

  it("only a refusal of the payload falls back: a listed tenant, a try-again answer, a sign-in problem or a reused key still fail", async () => {
    const config = shop("shop_new");
    // A tenant on the opt-in list keeps today's error.
    const listed = refusing(standardAssistant, 422);
    await expect(listed.make(config, { ...DEFAULT_ON, tenantIds: ["shop_new"] })).rejects.toThrow(/HTTP 422/);
    expect(listed.posts).toHaveLength(1);
    // Not a verdict on the payload: the standard one would fail the same way, or a second assistant would be made.
    for (const status of [401, 403, 408, 409, 429, 500, 503]) {
      const provider = refusing(standardAssistant, status);
      await expect(provider.make(config, DEFAULT_ON), String(status)).rejects.toThrow(`HTTP ${status}`);
      expect(provider.posts, String(status)).toHaveLength(1);
    }
    // The idempotency key was already used with another body (an earlier attempt made the assistant).
    const reused = refusing(standardAssistant, 422, { code: "10027" });
    await expect(reused.make(config, DEFAULT_ON)).rejects.toThrow(/HTTP 422/);
    expect(reused.posts).toHaveLength(1);
    // Telnyx refuses the standard payload too: one retry, then the error.
    const both = refusing(standardAssistant, 422, { refuseStandard: true });
    await expect(both.make(config, DEFAULT_ON)).rejects.toThrow(/HTTP 422/);
    expect(both.posts).toHaveLength(2);
  });

  it("go-live still works when Telnyx refuses the speech-to-speech assistant: the shop goes live on the standard voice and the log says why", async () => {
    const refused = await liveShop({ env: { TELNYX_VOICE_MODE: "speech_to_speech", TELNYX_S2S_MODEL: SPEECH_MODEL, TELNYX_S2S_VOICE: SPEECH_VOICE }, rejectSpeechToSpeech: true });
    try {
      const creates = refused.telnyx.requests.filter((request) => request.method === "POST" && request.path === "/v2/ai/assistants").map((request) => request.body!);
      expect(creates).toHaveLength(2);
      expect(creates[0]).toMatchObject({ model: SPEECH_MODEL, delegation_settings: { enabled: true } });
      expect(creates[1]).toMatchObject({ model: "synthetic/model" });
      expect(creates[1]!.delegation_settings).toBeUndefined();
      expect(JSON.stringify(creates[1])).not.toContain(SPEECH_MODEL);
      expect(refused.logs).toContainEqual({ level: "warn", event: "assistant_voice_mode", tenantId: refused.tenantId, mode: "standard", fallback: "provider_rejected", rollback: false, cut: [], providerError: expect.stringContaining("HTTP 422") });
      expect(refused.logs.some((entry) => entry.event === "line_provisioning_failed")).toBe(false);
      expect(await refused.store.getIntegrationSecret(refused.tenantId, "telnyx", "provisioned_assistant_id")).toBe("assistant-1");
      expect((await refused.store.getConfig(refused.tenantId)).paused).toBe(false);
    } finally { await refused.close(); }
  });

  it("go-live in default mode makes the shop's assistant speech-to-speech, and still goes live when it can't", async () => {
    const on = await liveShop({ env: { TELNYX_VOICE_MODE: "speech_to_speech", TELNYX_S2S_MODEL: SPEECH_MODEL, TELNYX_S2S_VOICE: SPEECH_VOICE } });
    try {
      const created = on.telnyx.requests.find((request) => request.method === "POST" && request.path === "/v2/ai/assistants")!.body!;
      expect(created).toMatchObject({ model: SPEECH_MODEL, voice_settings: { voice: SPEECH_VOICE }, delegation_settings: { enabled: true, mode: "telnyx", model: "synthetic/model" } });
      expect(on.logs).toContainEqual(expect.objectContaining({ event: "assistant_voice_mode", tenantId: on.tenantId, mode: "speech_to_speech", fallback: null }));
      // A settings save in the owner app reads the assistant first. This fake reports no text model for it, so the save
      // still goes through, on the standard payload, and the server log says why.
      const csrf = ((await (await fetch(`${on.baseUrl}/api/app/dashboard`, { headers: { cookie: on.cookie } })).json()) as { csrf: string }).csrf;
      const before = on.telnyx.requests.length;
      const saved = await fetch(`${on.baseUrl}/api/app/onboarding/hours`, { method: "POST", headers: { cookie: on.cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ preset: "every_day" }) });
      expect(saved.status).toBe(200);
      const pushed = on.telnyx.requests.slice(before).filter((request) => request.path === "/v2/ai/assistants/assistant-1");
      expect(pushed.map((request) => request.method)).toEqual(["GET", "POST"]);
      expect(pushed[1]!.body!.model).toBeUndefined();
      expect(pushed[1]!.body!.delegation_settings).toBeUndefined();
      expect(on.logs).toContainEqual({ level: "warn", event: "assistant_voice_mode", tenantId: on.tenantId, mode: "standard", fallback: "no_backend_model", rollback: false });
      expect((await on.store.getConfig(on.tenantId)).bookableHours.weekends).toBe(true);
    } finally { await on.close(); }
    // The mode is on but the model and voice were never set: the shop goes live on the standard voice, and the log says why.
    const incomplete = await liveShop({ env: { TELNYX_VOICE_MODE: "speech_to_speech" } });
    try {
      const created = incomplete.telnyx.requests.find((request) => request.method === "POST" && request.path === "/v2/ai/assistants")!.body!;
      expect(created).toMatchObject({ model: "synthetic/model" });
      expect(created.delegation_settings).toBeUndefined();
      expect(incomplete.logs).toContainEqual(expect.objectContaining({ level: "warn", event: "assistant_voice_mode", tenantId: incomplete.tenantId, mode: "standard", fallback: "s2s_model_not_set" }));
      expect((await incomplete.store.getConfig(incomplete.tenantId)).paused).toBe(false);
    } finally { await incomplete.close(); }
  });
});

describe("settings saves (saveAssistantConfig) in default mode", () => {
  const liveEnv = (overrides: Record<string, string> = {}) => ({
    ...demoEnvironment({ TELNYX_API_KEY: "synthetic-provider-key", TELNYX_ASSISTANT_ID: "assistant_demo", PUBLIC_BASE_URL: BASE, TELNYX_VOICE: TTS_VOICE, TELNYX_S2S_MODEL: SPEECH_MODEL, TELNYX_S2S_VOICE: SPEECH_VOICE, ...overrides }),
    DEMO_MODE: false,
  });
  /** Telnyx with one assistant: GET returns it, POST records the update. */
  function telnyx(assistant: Record<string, unknown>) {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
      return Response.json(assistant);
    }) as typeof fetch;
    return { calls, fetcher, posted: () => calls.filter((call) => call.method === "POST").map((call) => call.body!) };
  }

  it("the demo tenant goes through the same build: speech-to-speech when the mode is on, exactly today's when it is off", async () => {
    const store = new InMemoryStore();
    const original = createDemoConfig();
    await store.saveConfig(original);
    const on = telnyx(standardAssistant);
    await saveAssistantConfig(store, liveEnv({ TELNYX_VOICE_MODE: "speech_to_speech" }), { ...original, businessName: "Changed" }, on.fetcher, () => undefined);
    expect(on.calls.map((call) => `${call.method} ${call.url}`)).toEqual(["GET https://api.telnyx.com/v2/ai/assistants/assistant_demo", "POST https://api.telnyx.com/v2/ai/assistants/assistant_demo"]);
    expect(on.posted()[0]).toMatchObject({ model: SPEECH_MODEL, voice_settings: { voice: SPEECH_VOICE }, delegation_settings: DELEGATION });
    expect((await store.getConfig("demo")).businessName).toBe("Changed");

    // Mode off: the demo line keeps today's payload even when it is on the opt-in list.
    const off = telnyx(standardAssistant);
    const changed = { ...original, businessName: "Changed again" };
    await saveAssistantConfig(store, liveEnv({ TELNYX_S2S_TENANT_IDS: "demo" }), changed, off.fetcher, () => undefined);
    expect(JSON.stringify(off.posted()[0])).toBe(JSON.stringify(buildTelnyxAssistantUpdate(changed, BASE, { voice: TTS_VOICE })));
    // Nothing speech-to-speech set up at all: no read, one push, as it always was.
    const never = telnyx(standardAssistant);
    await saveAssistantConfig(store, liveEnv({ TELNYX_S2S_MODEL: "", TELNYX_S2S_VOICE: "" }), { ...changed, businessName: "Changed once more" }, never.fetcher, () => undefined);
    expect(never.calls.map((call) => call.method)).toEqual(["POST"]);
  });

  it("mode off again, before configure has run: a save puts a shop still in speech-to-speech mode back, and a failed read never stops a save", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    await store.saveConfig(shop("shop_a"));
    await store.saveProviderRoute(route("shop_a", "assistant_a"));
    const logs: Array<Record<string, unknown>> = [];
    const changed = { ...shop("shop_a"), businessName: "Changed" };
    const today = buildTelnyxAssistantUpdate(changed, BASE, { voice: TTS_VOICE });
    const still = telnyx(s2sAssistant);
    await saveAssistantConfig(store, liveEnv(), changed, still.fetcher, (entry) => logs.push(entry));
    expect(still.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(still.posted()[0]).toEqual({ ...today, model: TEXT_MODEL, delegation_settings: { enabled: false } });
    expect(logs).toEqual([{ level: "info", event: "assistant_voice_mode", tenantId: "shop_a", mode: "standard", fallback: null, rollback: true }]);
    // Already standard: exactly today's payload, nothing logged.
    const settled = telnyx(standardAssistant);
    await saveAssistantConfig(store, liveEnv(), changed, settled.fetcher, (entry) => logs.push(entry));
    expect(JSON.stringify(settled.posted()[0])).toBe(JSON.stringify(today));
    expect(logs).toHaveLength(1);
    // The read fails: the save goes through with today's payload.
    const posted: string[] = [];
    await saveAssistantConfig(store, liveEnv(), { ...changed, businessName: "Changed again" }, (async (_url: string | URL, init?: RequestInit) => {
      if (!init?.method) return new Response("", { status: 503 });
      posted.push(String(init.body));
      return Response.json({ id: "assistant_a" });
    }) as typeof fetch, (entry) => logs.push(entry));
    expect(posted).toEqual([JSON.stringify(buildTelnyxAssistantUpdate({ ...changed, businessName: "Changed again" }, BASE, { voice: TTS_VOICE }))]);
    expect((await store.getConfig("shop_a")).businessName).toBe("Changed again");
  });

  it("a shop the default can't make speech-to-speech saves on the standard voice, with its text model back, and logs why", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    await store.saveConfig(shop("shop_long"));
    await store.saveProviderRoute(route("shop_long", "assistant_long"));
    const logs: Array<Record<string, unknown>> = [];
    const provider = telnyx(s2sAssistant);
    const grown = longShop("shop_long");
    await saveAssistantConfig(store, liveEnv({ TELNYX_VOICE_MODE: "speech_to_speech" }), grown, provider.fetcher, (entry) => logs.push(entry));
    expect(provider.posted()[0]).toEqual({ ...buildTelnyxAssistantUpdate(grown, BASE, { voice: TTS_VOICE }), model: TEXT_MODEL, delegation_settings: { enabled: false } });
    expect(logs).toEqual([{ level: "warn", event: "assistant_voice_mode", tenantId: "shop_long", mode: "standard", fallback: "instructions_too_long", rollback: true }]);
    expect((await store.getConfig("shop_long")).approvedKnowledge).toHaveLength(80);
  });

  it("an incomplete env never fails a save in default mode; a tenant on the opt-in list still fails loudly", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    for (const tenantId of ["shop_regular", "shop_lab"]) {
      await store.saveConfig(shop(tenantId));
      await store.saveProviderRoute(route(tenantId, `assistant_${tenantId}`));
    }
    const env = liveEnv({ TELNYX_VOICE_MODE: "speech_to_speech", TELNYX_S2S_MODEL: "", TELNYX_S2S_TENANT_IDS: "shop_lab" });
    const logs: Array<Record<string, unknown>> = [];
    const provider = telnyx(standardAssistant);
    const changed = { ...shop("shop_regular"), businessName: "Changed" };
    await saveAssistantConfig(store, env, changed, provider.fetcher, (entry) => logs.push(entry));
    expect(JSON.stringify(provider.posted()[0])).toBe(JSON.stringify(buildTelnyxAssistantUpdate(changed, BASE, { voice: TTS_VOICE })));
    expect(logs).toEqual([expect.objectContaining({ level: "warn", fallback: "s2s_model_not_set", rollback: false })]);
    expect((await store.getConfig("shop_regular")).businessName).toBe("Changed");

    const strict = telnyx(standardAssistant);
    await expect(saveAssistantConfig(store, env, { ...shop("shop_lab"), businessName: "Changed" }, strict.fetcher, () => undefined)).rejects.toThrow(/TELNYX_S2S_MODEL/);
    expect(strict.posted()).toHaveLength(0);
    expect((await store.getConfig("shop_lab")).businessName).toBe("Synthetic Plumbing");
  });

  /** Telnyx with one assistant that answers a speech-to-speech update (delegation on) with `status`. */
  function refusingUpdates(assistant: Record<string, unknown>, status: number, refuseStandard = false) {
    const posted: Array<Record<string, unknown>> = [];
    const fetcher = (async (_input: string | URL, init?: RequestInit) => {
      if (!init?.method) return Response.json(assistant);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(body);
      const speaking = (body.delegation_settings as { enabled?: unknown } | undefined)?.enabled === true;
      if (speaking) return new Response(JSON.stringify({ errors: [{ detail: "synthetic refusal" }] }), { status });
      return refuseStandard ? new Response("{}", { status: 422 }) : Response.json({ id: "assistant" });
    }) as typeof fetch;
    return { posted, fetcher };
  }

  it("Telnyx refuses the speech-to-speech update: the save still goes through, on the standard payload, and the log says why", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    await store.saveConfig(shop("shop_a"));
    await store.saveProviderRoute(route("shop_a", "assistant_a"));
    const env = liveEnv({ TELNYX_VOICE_MODE: "speech_to_speech" });
    const logs: Array<Record<string, unknown>> = [];
    // A standard assistant: the second push is exactly today's payload.
    const changed = { ...shop("shop_a"), businessName: "Changed" };
    const fresh = refusingUpdates(standardAssistant, 422);
    await saveAssistantConfig(store, env, changed, fresh.fetcher, (entry) => logs.push(entry));
    expect(fresh.posted).toHaveLength(2);
    expect(fresh.posted[0]).toMatchObject({ model: SPEECH_MODEL, delegation_settings: DELEGATION });
    expect(JSON.stringify(fresh.posted[1])).toBe(JSON.stringify(buildTelnyxAssistantUpdate(changed, BASE, { voice: TTS_VOICE })));
    expect(logs).toEqual([{ level: "warn", event: "assistant_voice_mode", tenantId: "shop_a", mode: "standard", fallback: "provider_rejected", rollback: false, providerError: "HTTP 422: synthetic refusal" }]);
    expect((await store.getConfig("shop_a")).businessName).toBe("Changed");
    // An assistant already in speech-to-speech mode: its text model back, delegation off.
    const again = { ...changed, businessName: "Changed again" };
    const live = refusingUpdates(s2sAssistant, 400);
    await saveAssistantConfig(store, env, again, live.fetcher, (entry) => logs.push(entry));
    expect(live.posted[1]).toEqual({ ...buildTelnyxAssistantUpdate(again, BASE, { voice: TTS_VOICE }), model: TEXT_MODEL, delegation_settings: { enabled: false } });
    expect(logs[1]).toMatchObject({ level: "warn", fallback: "provider_rejected", rollback: true, providerError: "HTTP 400: synthetic refusal" });
    expect((await store.getConfig("shop_a")).businessName).toBe("Changed again");
  });

  it("only a refusal of the payload falls back on a save: a listed tenant, a try-again answer or a refused standard payload still fail it", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    for (const tenantId of ["shop_a", "shop_lab"]) {
      await store.saveConfig(shop(tenantId));
      await store.saveProviderRoute(route(tenantId, `assistant_${tenantId}`));
    }
    const changed = { ...shop("shop_a"), businessName: "Changed" };
    // A tenant on the opt-in list keeps today's error, in either mode.
    const listed = refusingUpdates(standardAssistant, 422);
    await expect(saveAssistantConfig(store, liveEnv({ TELNYX_VOICE_MODE: "speech_to_speech", TELNYX_S2S_TENANT_IDS: "shop_lab" }), { ...shop("shop_lab"), businessName: "Changed" }, listed.fetcher, () => undefined)).rejects.toThrow("Voice configuration update failed with HTTP 422");
    expect(listed.posted).toHaveLength(1);
    for (const status of [401, 403, 408, 409, 429, 500, 503]) {
      const provider = refusingUpdates(standardAssistant, status);
      await expect(saveAssistantConfig(store, liveEnv({ TELNYX_VOICE_MODE: "speech_to_speech" }), changed, provider.fetcher, () => undefined), String(status)).rejects.toThrow(`Voice configuration update failed with HTTP ${status}`);
      expect(provider.posted, String(status)).toHaveLength(1);
    }
    // The standard payload is refused too: one retry, then the save fails as it always did and nothing is saved.
    const both = refusingUpdates(standardAssistant, 422, true);
    await expect(saveAssistantConfig(store, liveEnv({ TELNYX_VOICE_MODE: "speech_to_speech" }), changed, both.fetcher, () => undefined)).rejects.toThrow("Voice configuration update failed with HTTP 422");
    expect(both.posted).toHaveLength(2);
    expect((await store.getConfig("shop_a")).businessName).toBe("Synthetic Plumbing");
    expect((await store.getConfig("shop_lab")).businessName).toBe("Synthetic Plumbing");
  });

  it("an opted-out shop is read too, so an assistant still in speech-to-speech mode is put back", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    await store.saveConfig(shop("shop_out"));
    await store.saveProviderRoute(route("shop_out", "assistant_out"));
    const logs: Array<Record<string, unknown>> = [];
    const provider = telnyx(s2sAssistant);
    await saveAssistantConfig(store, liveEnv({ TELNYX_VOICE_MODE: "speech_to_speech", TELNYX_STANDARD_TENANT_IDS: "shop_out" }), shop("shop_out"), provider.fetcher, (entry) => logs.push(entry));
    expect(provider.posted()[0]).toMatchObject({ model: TEXT_MODEL, voice_settings: { voice: TTS_VOICE }, delegation_settings: { enabled: false } });
    expect(logs).toEqual([{ level: "info", event: "assistant_voice_mode", tenantId: "shop_out", mode: "standard", fallback: null, rollback: true }]);
  });

  it("a read that fails stops the save before anything is pushed", async () => {
    const store = new InMemoryStore();
    const original = createDemoConfig();
    await store.saveConfig(original);
    const methods: string[] = [];
    await expect(saveAssistantConfig(store, liveEnv({ TELNYX_VOICE_MODE: "speech_to_speech" }), { ...original, businessName: "Changed" }, (async (_url: string | URL, init?: RequestInit) => { methods.push(init?.method ?? "GET"); return new Response("", { status: 503 }); }) as typeof fetch, () => undefined)).rejects.toThrow("Voice configuration read failed");
    expect(methods).toEqual(["GET"]);
    expect((await store.getConfig("demo")).businessName).toBe(original.businessName);
  });
});

describe("configure-telnyx: every assistant through the same build", () => {
  async function world() {
    const store = new InMemoryStore();
    await store.saveConfig(shop("demo"));
    await store.saveConfig(shop("shop_a"));
    await store.saveConfig(longShop("shop_long"));
    await store.saveConfig(shop("shop_out"));
    for (const tenantId of ["shop_a", "shop_long", "shop_out"]) await store.saveProviderRoute(route(tenantId, `assistant_${tenantId}`));
    return store;
  }
  const plan = async (speechToSpeech: SpeechToSpeechSettings, assistants: Record<string, unknown> | ((assistantId: string) => Record<string, unknown>)) =>
    planAssistantPushes({ store: await world(), defaultTenantId: "demo", demoAssistantId: "assistant_demo", publicBaseUrl: BASE, voice: TTS_VOICE, speechToSpeech, readAssistant: async (assistantId) => typeof assistants === "function" ? assistants(assistantId) : assistants });
  const byTenant = (pushes: Awaited<ReturnType<typeof plan>>) => Object.fromEntries(pushes.map((push) => [push.tenantId, push]));

  it("mode on: the demo assistant and every shop are speech-to-speech; a too-long shop and an opted-out shop stay standard", async () => {
    const pushes = byTenant(await plan({ ...DEFAULT_ON, standardTenantIds: ["shop_out"] }, standardAssistant));
    expect(Object.keys(pushes)).toEqual(["demo", "shop_a", "shop_long", "shop_out"]);
    for (const tenantId of ["demo", "shop_a"]) {
      expect(pushes[tenantId]).toMatchObject({ mode: "speech_to_speech", update: { model: SPEECH_MODEL, voice_settings: { voice: SPEECH_VOICE }, delegation_settings: DELEGATION } });
      expect(pushes[tenantId]!.error).toBeUndefined();
      expect(pushes[tenantId]!.fallback).toBeUndefined();
    }
    expect(pushes.shop_long).toMatchObject({ mode: "standard", fallback: "instructions_too_long" });
    expect(pushes.shop_long!.error).toBeUndefined();
    expect(JSON.stringify(pushes.shop_long!.update)).toBe(JSON.stringify(buildTelnyxAssistantUpdate(longShop("shop_long"), BASE, { voice: TTS_VOICE })));
    expect(pushes.shop_out).toMatchObject({ mode: "standard" });
    expect(pushes.shop_out!.fallback).toBeUndefined();
    expect(JSON.stringify(pushes.shop_out!.update)).toBe(JSON.stringify(buildTelnyxAssistantUpdate(shop("shop_out"), BASE, { voice: TTS_VOICE })));
    // The dry run says all of it in one line per assistant.
    expect(describePush(pushes.demo!)).toMatchObject({ tenantId: "demo", assistantId: "assistant_demo", mode: "speech_to_speech", fallback: null, rollback: false, cut: [], model: SPEECH_MODEL, delegation_settings: DELEGATION });
    expect(describePush(pushes.shop_long!)).toMatchObject({ tenantId: "shop_long", mode: "standard", fallback: "instructions_too_long", rollback: false, cut: [] });
    expect(describePush(pushes.shop_long!).instructionChars).toBeGreaterThan(S2S_INSTRUCTION_LIMIT_CHARS);
  });

  it("mode off again (rollback): the demo assistant and every shop get their text model back with delegation off", async () => {
    const pushes = await plan(DEFAULT_OFF, s2sAssistant);
    expect(pushes).toHaveLength(4);
    for (const push of pushes) {
      expect(push, push.tenantId).toMatchObject({ mode: "standard", rollback: true, update: { model: TEXT_MODEL, voice_settings: { voice: TTS_VOICE, voice_speed: 1 }, delegation_settings: { enabled: false } } });
      expect(push.error).toBeUndefined();
    }
    expect(describePush(pushes[0]!)).toMatchObject({ tenantId: "demo", mode: "standard", rollback: true, model: TEXT_MODEL, delegation_settings: { enabled: false } });
    // Once Telnyx reports them standard, the push is exactly today's again.
    const settled = byTenant(await plan(DEFAULT_OFF, standardAssistant));
    expect(settled.demo!.rollback).toBeUndefined();
    expect(JSON.stringify(settled.demo!.update)).toBe(JSON.stringify(buildTelnyxAssistantUpdate(shop("demo"), BASE, { voice: TTS_VOICE })));
  });

  it("mode on with shops already speech-to-speech: a too-long or opted-out shop is put back, the rest stay", async () => {
    const pushes = byTenant(await plan({ ...DEFAULT_ON, standardTenantIds: ["shop_out"] }, s2sAssistant));
    expect(pushes.demo).toMatchObject({ mode: "speech_to_speech", update: { delegation_settings: DELEGATION } });
    expect(pushes.shop_long).toMatchObject({ mode: "standard", fallback: "instructions_too_long", rollback: true, update: { model: TEXT_MODEL, delegation_settings: { enabled: false } } });
    expect(pushes.shop_out).toMatchObject({ mode: "standard", rollback: true, update: { model: TEXT_MODEL, delegation_settings: { enabled: false } } });
  });

  it("an incomplete env falls every default assistant back without an error; a listed shop is still an error", async () => {
    const pushes = byTenant(await plan({ ...DEFAULT_ON, voice: undefined, tenantIds: ["shop_a"] }, standardAssistant));
    expect(pushes.demo).toMatchObject({ mode: "standard", fallback: "s2s_voice_not_set" });
    expect(pushes.demo!.error).toBeUndefined();
    expect(JSON.stringify(pushes.demo!.update)).toBe(JSON.stringify(buildTelnyxAssistantUpdate(shop("demo"), BASE, { voice: TTS_VOICE })));
    expect(pushes.shop_out).toMatchObject({ mode: "standard", fallback: "s2s_voice_not_set" });
    expect(pushes.shop_a!.error).toMatch(/TELNYX_S2S_VOICE/);
    expect(pushes.shop_a!.update).toEqual({});
  });

  it("never pushes the demo assistant blind when it can't be read", async () => {
    const pushes = byTenant(await plan(DEFAULT_OFF, (assistantId) => { if (assistantId === "assistant_demo") throw new Error("HTTP 503"); return standardAssistant; }));
    expect(pushes.demo).toMatchObject({ update: {}, error: expect.stringMatching(/read failed/) });
    expect(pushes.shop_a!.error).toBeUndefined();
  });
});

describe("speech-to-speech instructions are plain ASCII", () => {
  it("folds curly quotes, dashes and accents an owner typed, and leaves ASCII text alone", async () => {
    const { plainAscii, speechToSpeechPayload } = await import("../src/voice/voice-mode.js");
    expect(plainAscii("Mike\u2019s Plumbing \u2014 Jos\u00e9 said \u201cyes\u201d\u2026 Settings \u203a Phone")).toBe("Mike's Plumbing - Jose said \"yes\"... Settings > Phone");
    expect(plainAscii("Plain text, {{caller_phone}}.\n- rule")).toBe("Plain text, {{caller_phone}}.\n- rule");
    const built = speechToSpeechPayload({ instructions: "You answer the phone for Mike\u2019s Plumbing.", voice_settings: {} }, { kind: "speech_to_speech", model: "speaker", voice: "Voice.A", backendModel: "text-model" });
    expect(built.payload.instructions).toBe("You answer the phone for Mike's Plumbing.");
  });
});
