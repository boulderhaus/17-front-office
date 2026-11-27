import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { TelnyxProvisioner } from "../src/adapters/telnyx-provisioning.js";
import { GRACE_PROVIDER, GRACE_STARTED_KEY, releaseProvisionedLine } from "../src/application/grace-line.js";
import { isVoiceLabTenant, readVoiceLabLine } from "../src/application/voice-lab.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { BusinessConfig, SubscriptionRecord } from "../src/domain/models.js";
import { buildTelnyxAssistantUpdate } from "../src/voice/system-prompt.js";
import { buildShopAssistantPayload, rollbackFields, S2S_INSTRUCTION_LIMIT_CHARS, speechToSpeechPayload, VoiceModeError, type SpeechToSpeechSettings } from "../src/voice/voice-mode.js";
import { planAssistantPushes } from "../scripts/configure-telnyx.js";
import { applyLabLine, createLabTenant, labShopConfig, LabRefusal, planLabLine, removeLabLine, type LabDeps } from "../scripts/voice-lab-line.js";

// Synthetic ids only: no real model, voice, number or assistant appears in this file.
const BASE = "https://front-office.example";
const S2S: SpeechToSpeechSettings = { tenantIds: ["shop_lab"], model: "synthetic/speech-model", voice: "SyntheticVoice.One" };
const TEXT_MODEL = "synthetic/text-model";
const standardAssistant = { data: { model: TEXT_MODEL, delegation_settings: null, telephony_settings: { default_texml_app_id: "texml_lab" } } };
const s2sAssistant = { data: { model: S2S.model, delegation_settings: { enabled: true, mode: "telnyx", model: TEXT_MODEL }, telephony_settings: { default_texml_app_id: "texml_lab" } } };
const toolNames = (payload: Record<string, unknown>) => (payload.tools as Array<{ type: string; webhook?: { name: string } }>).map((tool) => tool.webhook?.name ?? tool.type);
const shop = (tenantId: string): BusinessConfig => ({ ...createDemoConfig(tenantId), businessName: "Synthetic Plumbing" });

describe("opt-in speech-to-speech voice mode", () => {
  it("builds today's payload, byte for byte, for every unlisted shop and the demo line", async () => {
    const config = shop("shop_regular");
    const today = buildTelnyxAssistantUpdate(config, BASE, { voice: "Synthetic.Voice" });
    expect(today).toMatchSnapshot();
    for (const options of [{}, { speechToSpeech: S2S }, { speechToSpeech: S2S, existing: standardAssistant }, { speechToSpeech: { tenantIds: [] } }]) {
      const built = buildShopAssistantPayload(config, BASE, { voice: "Synthetic.Voice", ...options });
      expect(JSON.stringify(built.payload)).toBe(JSON.stringify(today));
      expect(built).toMatchObject({ mode: "standard", rollback: false, cut: [] });
    }
    const store = new InMemoryStore();
    await store.saveConfig(shop("demo"));
    await store.saveConfig(config);
    await store.saveProviderRoute({ provider: "telnyx", externalId: "assistant_regular", tenantId: "shop_regular", createdAt: "2026-11-27T00:00:00.000Z", updatedAt: "2026-11-27T00:00:00.000Z" });
    // Even with the demo tenant listed, the demo assistant keeps today's payload.
    const pushes = await planAssistantPushes({ store, defaultTenantId: "demo", demoAssistantId: "assistant_demo", publicBaseUrl: BASE, voice: "Synthetic.Voice", speechToSpeech: { ...S2S, tenantIds: ["demo"] }, readAssistant: async () => standardAssistant });
    expect(JSON.stringify(pushes.find((push) => push.assistantId === "assistant_demo")?.update)).toBe(JSON.stringify(buildTelnyxAssistantUpdate(shop("demo"), BASE, { voice: "Synthetic.Voice" })));
    expect(JSON.stringify(pushes.find((push) => push.assistantId === "assistant_regular")?.update)).toBe(JSON.stringify(today));
  });

  it("gives a listed shop the speech-to-speech payload with every tool, webhook, variable and recording setting", () => {
    const config = shop("shop_lab");
    const today = buildTelnyxAssistantUpdate(config, BASE) as Record<string, unknown>;
    const built = buildShopAssistantPayload(config, BASE, { speechToSpeech: S2S, existing: standardAssistant });
    expect(built.mode).toBe("speech_to_speech");
    const payload = built.payload;
    expect(payload.model).toBe(S2S.model);
    expect(payload.voice_settings).toEqual({ voice: S2S.voice, tool_call_audio: (today.voice_settings as Record<string, unknown>).tool_call_audio });
    // Tools run through delegation to the text model the shop already uses.
    expect(payload.delegation_settings).toEqual({ enabled: true, mode: "telnyx", model: TEXT_MODEL, speak_results: true });
    expect(toolNames(payload)).toEqual(toolNames(today));
    expect(toolNames(payload)).toEqual(["get_approved_answer", "save_intake", "triage_call", "check_service_area", "check_availability", "book_slot", "request_human", "mark_spam_call", "transfer", "hangup"]);
    for (const key of ["instructions", "greeting", "tools", "tool_ids", "dynamic_variables_webhook_url", "dynamic_variables_webhook_timeout_ms", "dynamic_variables", "telephony_settings", "transcription", "interruption_settings", "promote_to_main"]) {
      expect(payload[key], key).toEqual(today[key]);
    }
    expect(String(payload.instructions).length).toBeLessThan(S2S_INSTRUCTION_LIMIT_CHARS);
    // An env backend model wins over the shop's own.
    expect(buildShopAssistantPayload(config, BASE, { speechToSpeech: { ...S2S, backendModel: "synthetic/other-text" }, existing: standardAssistant }).payload.delegation_settings).toMatchObject({ model: "synthetic/other-text" });
    // Rerunning on an assistant already in speech-to-speech keeps its backend model.
    expect(buildShopAssistantPayload(config, BASE, { speechToSpeech: S2S, existing: s2sAssistant }).payload).toEqual(payload);
  });

  it("never configures a listed shop without a model, a voice or a backend text model", () => {
    const config = shop("shop_lab");
    expect(() => buildShopAssistantPayload(config, BASE, { speechToSpeech: { ...S2S, model: undefined }, existing: standardAssistant })).toThrow(VoiceModeError);
    expect(() => buildShopAssistantPayload(config, BASE, { speechToSpeech: { ...S2S, voice: undefined }, existing: standardAssistant })).toThrow(VoiceModeError);
    expect(() => buildShopAssistantPayload(config, BASE, { speechToSpeech: S2S, existing: null })).toThrow(VoiceModeError);
  });

  it("cuts only the style section past the instruction limit, never safety or booking, and refuses past it", () => {
    const long = { ...shop("shop_lab"), approvedKnowledge: Array.from({ length: 30 }, (_, index) => ({ topic: `topic ${index}`, text: "x".repeat(70) })) };
    const today = buildTelnyxAssistantUpdate(long, BASE) as Record<string, unknown>;
    expect(String(today.instructions).length).toBeGreaterThan(S2S_INSTRUCTION_LIMIT_CHARS);
    const { payload, cut } = speechToSpeechPayload(today, { kind: "speech_to_speech", model: S2S.model!, voice: S2S.voice!, backendModel: TEXT_MODEL });
    expect(cut).toEqual(["HOW YOU SOUND"]);
    const instructions = String(payload.instructions);
    expect(instructions.length).toBeLessThanOrEqual(S2S_INSTRUCTION_LIMIT_CHARS);
    for (const section of ["IDENTITY AND TRUST", "SERVICE-CALL CHECK", "SAFETY", "BOOKING", "HUMAN HELP", "ENDING THE CALL"]) expect(instructions).toContain(section);
    expect(instructions).not.toContain("HOW YOU SOUND");
    const huge = buildTelnyxAssistantUpdate({ ...long, approvedKnowledge: Array.from({ length: 80 }, (_, index) => ({ topic: `t${index}`, text: "x".repeat(70) })) }, BASE);
    expect(() => speechToSpeechPayload(huge, { kind: "speech_to_speech", model: S2S.model!, voice: S2S.voice!, backendModel: TEXT_MODEL })).toThrow(VoiceModeError);
  });

  it("rolls back: an unlisted shop still on speech-to-speech gets its text model back, then today's payload", async () => {
    const config = shop("shop_lab");
    const today = buildTelnyxAssistantUpdate(config, BASE);
    const back = buildShopAssistantPayload(config, BASE, { speechToSpeech: { ...S2S, tenantIds: [] }, existing: s2sAssistant });
    expect(back.rollback).toBe(true);
    expect(back.payload).toEqual({ ...today, model: TEXT_MODEL, delegation_settings: { enabled: false } });
    // Telnyx reports delegation off after the rollback push: from then on the payload is exactly today's.
    const rolledBack = { data: { model: TEXT_MODEL, delegation_settings: { enabled: false, model: null } } };
    expect(rollbackFields(rolledBack)).toBeNull();
    expect(JSON.stringify(buildShopAssistantPayload(config, BASE, { existing: rolledBack }).payload)).toBe(JSON.stringify(today));

    const store = new InMemoryStore();
    await store.saveConfig(config);
    await store.saveProviderRoute({ provider: "telnyx", externalId: "assistant_lab", tenantId: "shop_lab", createdAt: "2026-11-27T00:00:00.000Z", updatedAt: "2026-11-27T00:00:00.000Z" });
    const [listed] = await planAssistantPushes({ store, defaultTenantId: "demo", publicBaseUrl: BASE, speechToSpeech: S2S, readAssistant: async () => standardAssistant });
    expect(listed).toMatchObject({ mode: "speech_to_speech", update: { model: S2S.model } });
    const [removed] = await planAssistantPushes({ store, defaultTenantId: "demo", publicBaseUrl: BASE, speechToSpeech: { ...S2S, tenantIds: [] }, readAssistant: async () => s2sAssistant });
    expect(removed).toMatchObject({ mode: "standard", rollback: true, update: { model: TEXT_MODEL, delegation_settings: { enabled: false } } });
    const [missing] = await planAssistantPushes({ store, defaultTenantId: "demo", publicBaseUrl: BASE, speechToSpeech: { ...S2S, model: undefined }, readAssistant: async () => standardAssistant });
    expect(missing?.error).toMatch(/TELNYX_S2S_MODEL/);
  });

  it("provisioning creates a listed shop's assistant in speech-to-speech mode on the template's text model", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/ai/assistants/template") && !init?.method) return new Response(JSON.stringify({ data: { model: TEXT_MODEL, enabled_features: ["telephony"], voice_settings: { voice: "Template.Voice" } } }));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { id: `assistant_${bodies.length}` } }));
    }) as typeof fetch;
    const provisioner = new TelnyxProvisioner({ apiKey: "synthetic", templateAssistantId: "template", messagingProfileId: "profile", fetcher });
    for (const tenantId of ["shop_regular", "shop_lab"]) {
      await provisioner.createAssistant({ tenantId, businessName: "Synthetic Plumbing", assistantUpdate: buildTelnyxAssistantUpdate(shop(tenantId), BASE), speechToSpeech: S2S });
    }
    expect(bodies[0]).toMatchObject({ model: TEXT_MODEL });
    expect(bodies[0]!.delegation_settings).toBeUndefined();
    expect(bodies[1]).toMatchObject({ model: S2S.model, voice_settings: { voice: S2S.voice }, delegation_settings: { enabled: true, model: TEXT_MODEL } });
    expect(toolNames(bodies[1]!)).toEqual(toolNames(bodies[0]!));
  });
});

const NUMBER = "+15555550142";
const VOICEMAIL_APP = "texml_voicemail";

function fakeTelnyx(initialConnection: string | null) {
  const state = { connection: initialConnection, assistants: new Map<string, Record<string, unknown>>(), deleted: [] as string[], numberDeletes: 0, callbackSet: false };
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.endsWith("/ai/assistants/template")) return json({ data: { model: TEXT_MODEL, enabled_features: ["telephony"] } });
    if (url.endsWith("/ai/assistants") && method === "POST") {
      const id = `assistant_${state.assistants.size + 1}`;
      state.assistants.set(id, { ...body, id, delegation_settings: body.delegation_settings ?? null, telephony_settings: { default_texml_app_id: "texml_lab" } });
      return json({ data: { id } });
    }
    const assistant = /\/ai\/assistants\/([^/?]+)$/.exec(url)?.[1];
    if (assistant) {
      const current = state.assistants.get(assistant);
      if (!current) return json({ errors: [{ detail: "not found" }] }, 404);
      if (method === "DELETE") { state.assistants.delete(assistant); state.deleted.push(assistant); return json({}); }
      if (method === "POST") state.assistants.set(assistant, { ...current, ...body, telephony_settings: current.telephony_settings });
      return json({ data: state.assistants.get(assistant) });
    }
    if (url.includes("/texml_applications/texml_lab")) {
      if (method === "PATCH") state.callbackSet = true;
      return json({ data: state.callbackSet ? { status_callback: `${BASE}/webhooks/telnyx`, status_callback_method: "post", call_cost_in_webhooks: true } : { friendly_name: "lab", voice_url: "https://texml.example" } });
    }
    if (url.endsWith("/phone_numbers/num_lab") || url.includes("/phone_numbers?")) {
      if (method === "PATCH") state.connection = (body.connection_id as string | null) ?? null;
      if (method === "DELETE") { state.numberDeletes += 1; return json({}); }
      const number = { id: "num_lab", phone_number: NUMBER, status: "active", connection_id: state.connection ?? "" };
      return json(url.includes("?") ? { data: [number] } : { data: number });
    }
    if (url.includes("/10dlc/")) return json({});
    return json({ errors: [{ detail: `unexpected ${method} ${url}` }] }, 500);
  }) as typeof fetch;
  return { state, fetcher };
}

async function labWorld(options: { holderStatus?: SubscriptionRecord["status"]; connection?: string | null } = {}) {
  const store = new InMemoryStore();
  const env = demoEnvironment({ TELNYX_API_KEY: "synthetic", TELNYX_TEMPLATE_ASSISTANT_ID: "template", TELNYX_VOICEMAIL_APP_ID: VOICEMAIL_APP, TELNYX_FROM_NUMBER: "+15555550100", PUBLIC_BASE_URL: BASE, TELNYX_S2S_MODEL: S2S.model, TELNYX_S2S_VOICE: S2S.voice });
  const telnyx = fakeTelnyx(options.connection === undefined ? VOICEMAIL_APP : options.connection);
  telnyx.state.assistants.set("assistant_cancelled", { id: "assistant_cancelled", telephony_settings: { default_texml_app_id: "texml_cancelled" } });
  const now = () => new Date("2026-11-27T12:00:00.000Z");
  const created = await createLabTenant({ store, now }, true);
  const labTenant = created.tenantId!;
  const deps: LabDeps = { store, env: { ...env, TELNYX_S2S_TENANT_IDS: [labTenant] }, fetcher: telnyx.fetcher, now };
  // The cancelled shop whose line ends in the lab number: unpaid, in its grace period, number on the voicemail app.
  await store.saveConfig(shop("shop_cancelled"));
  await store.saveSubscription({ tenantId: "shop_cancelled", providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic", status: options.holderStatus ?? "canceled", currentPeriodEnd: null, providerEventCreatedAt: "2026-11-26T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-26T00:00:00.000Z" });
  await store.saveIntegrationSecret("shop_cancelled", "telnyx", "inbound_number", NUMBER);
  await store.saveIntegrationSecret("shop_cancelled", "telnyx", "provisioned_assistant_id", "assistant_cancelled");
  await store.saveIntegrationSecret("shop_cancelled", GRACE_PROVIDER, GRACE_STARTED_KEY, "2026-11-26T00:00:00.000Z");
  return { store, deps, telnyx, labTenant };
}

describe("voice lab line script", () => {
  it("creates one complimentary lab shop that never had Stripe", async () => {
    const { store, labTenant, deps } = await labWorld();
    expect(await createLabTenant({ store }, true)).toEqual({ tenantId: labTenant, action: "exists" });
    expect((await store.getSubscription(labTenant))?.status).toBe("comp");
    expect(await store.getConfig(labTenant)).toMatchObject({ businessName: "Otto Lab Plumbing", bookingMode: "confirm", calendarConnectionRef: null, ownerNotificationRefs: [] });
    expect(labShopConfig(labTenant).serviceAreaTerms.length).toBeGreaterThan(0);
    await expect(planLabLine(deps, { tenantId: labTenant, numberId: "num_lab" })).resolves.toMatchObject({ holderTenantId: "shop_cancelled", holderKeys: ["inbound_number"] });
  });

  it("refuses any shop that has or ever had a paid plan, and the demo tenants", async () => {
    const { store, deps } = await labWorld();
    for (const [tenantId, subscription] of [
      ["shop_paid", { status: "active", providerCustomerId: "cus_x", providerSubscriptionId: "sub_x" }],
      ["shop_was_paid", { status: "comp", providerCustomerId: "cus_x", providerSubscriptionId: null }],
      ["shop_trial", { status: "trialing", providerCustomerId: null, providerSubscriptionId: null }],
    ] as const) {
      await store.saveConfig(shop(tenantId));
      await store.saveSubscription({ tenantId, ...subscription, currentPeriodEnd: null, providerEventCreatedAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
      await expect(planLabLine(deps, { tenantId, numberId: "num_lab" })).rejects.toThrow(LabRefusal);
    }
    await store.saveConfig(shop("shop_checkout"));
    await store.saveSubscription({ tenantId: "shop_checkout", status: "comp", providerCustomerId: null, providerSubscriptionId: null, currentPeriodEnd: null, providerEventCreatedAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
    await store.saveIntegrationSecret("shop_checkout", "stripe", "open_checkout", "{}");
    await expect(planLabLine(deps, { tenantId: "shop_checkout", numberId: "num_lab" })).rejects.toThrow(/checkout/);
    await expect(planLabLine(deps, { tenantId: deps.env.DEFAULT_TENANT_ID, numberId: "num_lab" })).rejects.toThrow(LabRefusal);
  });

  it("refuses a number a paying shop uses, one live on another connection, and the SMS sender", async () => {
    const paying = await labWorld({ holderStatus: "active" });
    await expect(planLabLine(paying.deps, { tenantId: paying.labTenant, numberId: "num_lab" })).rejects.toThrow(/paying shop/);
    const live = await labWorld({ connection: "texml_some_other_assistant" });
    await expect(planLabLine(live.deps, { tenantId: live.labTenant, numberId: "num_lab" })).rejects.toThrow(/in use/);
    const sender = await labWorld();
    await expect(planLabLine({ ...sender.deps, env: { ...sender.deps.env, TELNYX_FROM_NUMBER: NUMBER } }, { tenantId: sender.labTenant, numberId: "num_lab" })).rejects.toThrow(/SMS/);
    expect(paying.telnyx.state.connection).toBe(VOICEMAIL_APP);
  });

  it("dry run changes nothing; --apply provisions in the configured voice mode; grace never releases it; --remove restores", async () => {
    const { store, deps, telnyx, labTenant } = await labWorld();
    const plan = await planLabLine(deps, { tenantId: labTenant, numberId: "num_lab" });
    expect(telnyx.state.assistants.size).toBe(1);
    expect(telnyx.state.connection).toBe(VOICEMAIL_APP);

    const applied = await applyLabLine(deps, plan);
    expect(applied.mode).toBe("speech_to_speech");
    const assistant = telnyx.state.assistants.get(applied.assistantId)!;
    expect(assistant).toMatchObject({ model: S2S.model, delegation_settings: { enabled: true, model: TEXT_MODEL } });
    expect(toolNames(assistant)).toContain("book_slot");
    expect(telnyx.state.connection).toBe("texml_lab");
    expect(telnyx.state.callbackSet).toBe(true);
    expect(await store.getIntegrationSecret(labTenant, "telnyx", "inbound_number")).toBe(NUMBER);
    expect(await store.getIntegrationSecret("shop_cancelled", "telnyx", "inbound_number")).toBeNull();
    expect(await store.getProviderRoute("telnyx", applied.assistantId)).toMatchObject({ tenantId: labTenant });
    expect((await store.getConfig(labTenant)).paused).toBe(false);
    expect(await isVoiceLabTenant(store, labTenant)).toBe(true);
    expect(await isVoiceLabTenant(store, "shop_cancelled")).toBe(false);
    // Rerun is idempotent.
    await applyLabLine(deps, await planLabLine(deps, { tenantId: labTenant, numberId: "num_lab" }));
    expect(telnyx.state.assistants.size).toBe(2);

    // Day 30 for the cancelled shop, or deleting it: its own assistant goes, the lab number and assistant stay.
    const log: Array<Record<string, unknown>> = [];
    expect(await releaseProvisionedLine({ store, env: deps.env as never, clock: { now: () => new Date() }, fetcher: telnyx.fetcher, log: (entry) => log.push(entry) }, "shop_cancelled")).toBe(true);
    expect(await releaseProvisionedLine({ store, env: deps.env as never, clock: { now: () => new Date() }, fetcher: telnyx.fetcher, log: (entry) => log.push(entry) }, labTenant)).toBe(true);
    expect(telnyx.state.numberDeletes).toBe(0);
    expect(telnyx.state.deleted).toEqual(["assistant_cancelled"]);
    expect(telnyx.state.assistants.has(applied.assistantId)).toBe(true);

    expect(await removeLabLine(deps, false)).toMatchObject({ action: "would_remove", restoreConnectionId: VOICEMAIL_APP });
    expect(telnyx.state.connection).toBe("texml_lab");
    expect(await removeLabLine(deps, true)).toMatchObject({ action: "removed" });
    expect(telnyx.state.connection).toBe(VOICEMAIL_APP);
    expect(telnyx.state.deleted).toContain(applied.assistantId);
    expect(await store.getIntegrationSecret("shop_cancelled", "telnyx", "inbound_number")).toBe(NUMBER);
    expect(await store.getIntegrationSecret(labTenant, "telnyx", "inbound_number")).toBeNull();
    expect(await readVoiceLabLine(store)).toBeNull();
    expect(await isVoiceLabTenant(store, labTenant)).toBe(false);
    expect((await store.getConfig(labTenant)).paused).toBe(true);
    expect(telnyx.state.numberDeletes).toBe(0);
  });
});
