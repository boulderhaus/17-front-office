import type { Environment } from "../config/environment.js";
import type { BusinessConfig } from "../domain/models.js";
import type { Store } from "../ports.js";
import { buildTelnyxAssistantUpdate } from "../voice/system-prompt.js";
import { buildShopAssistantPayload, isPayloadRejection, isSpeechToSpeechTenant, resolveVoiceMode, speechToSpeechConfigured, speechToSpeechSettings, standardVoicePayload, voiceRequest, type ShopAssistantPayload } from "../voice/voice-mode.js";
import { redactError, withTimeout } from "../application/retry.js";
import { TelnyxVoiceRoutingClient } from "./telnyx.js";

type Log = (entry: Record<string, unknown>) => void;

/** Never show saved rules while the live assistant still has different rules. */
export async function saveAssistantConfig(store: Store, env: Environment, config: BusinessConfig, fetcher: typeof fetch = fetch, log: Log = (entry) => console.log(JSON.stringify(entry))): Promise<void> {
  // Callers serialize read/modify/write under config:<tenant>. Also serialize
  // the external update and rollback so provider revisions cannot interleave.
  return store.withLock(`assistant-config:${config.tenantId}`, () => synchronize(store, env, config, fetcher, log));
}

/**
 * True when a save for this shop is really sent in speech-to-speech mode: the shop is asked to be (by the default or
 * the opt-in list, and not opted out), the speaking model and its voice are set, and a backend text model can be
 * found (TELNYX_S2S_BACKEND_MODEL, else the one the shop's assistant uses now, which is read). Anything else is
 * false, a read that fails included: the save then goes exactly as it always has. Reads only; changes nothing.
 */
export async function resolvesToSpeechToSpeech(store: Store, env: Environment, tenantId: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const s2s = speechToSpeechSettings(env);
  if (!isSpeechToSpeechTenant(s2s, tenantId) || !s2s.model || !s2s.voice) return false;
  const resolved = (existing: Record<string, unknown> | null): boolean => {
    try { return resolveVoiceMode(s2s, tenantId, existing).kind === "speech_to_speech"; } catch { return false; }
  };
  if (s2s.backendModel) return resolved(null);
  if (env.DEMO_MODE || !env.TELNYX_API_KEY) return false;
  try {
    const route = await store.getProviderRouteForTenant("telnyx", tenantId);
    const assistantId = route?.externalId ?? (tenantId === env.DEFAULT_TENANT_ID ? env.TELNYX_ASSISTANT_ID : undefined);
    if (!assistantId) return false;
    const found = await withTimeout(fetcher(`https://api.telnyx.com/v2/ai/assistants/${encodeURIComponent(assistantId)}`, { headers: { authorization: `Bearer ${env.TELNYX_API_KEY}`, "content-type": "application/json" } }), 8_000);
    if (!found.ok) return false;
    return resolved(await found.json() as Record<string, unknown>);
  } catch {
    return false;
  }
}

async function synchronize(store: Store, env: Environment, config: BusinessConfig, fetcher: typeof fetch, log: Log): Promise<void> {
  const current = await store.getConfig(config.tenantId);
  const route = await store.getProviderRouteForTenant("telnyx", config.tenantId);
  const assistantId = route?.externalId ?? (config.tenantId === env.DEFAULT_TENANT_ID ? env.TELNYX_ASSISTANT_ID : undefined);
  const update = async (value: BusinessConfig) => {
    if (env.DEMO_MODE || !assistantId) return;
    if (!env.TELNYX_API_KEY) throw new Error("Voice configuration is unavailable");
    const url = `https://api.telnyx.com/v2/ai/assistants/${encodeURIComponent(assistantId)}`;
    const headers = { authorization: `Bearer ${env.TELNYX_API_KEY}`, "content-type": "application/json" };
    const s2s = speechToSpeechSettings(env);
    const read = async (): Promise<Record<string, unknown>> => {
      const found = await withTimeout(fetcher(url, { headers }), 8_000);
      if (!found.ok) throw new Error(`Voice configuration read failed with HTTP ${found.status}`);
      return await found.json() as Record<string, unknown>;
    };
    let existing: Record<string, unknown> | null = null;
    const build = (assistant: Record<string, unknown>): ShopAssistantPayload => {
      existing = assistant;
      return buildShopAssistantPayload(value, env.PUBLIC_BASE_URL, { voice: env.TELNYX_VOICE, speechToSpeech: s2s, existing: assistant });
    };
    const push = (body: Record<string, unknown>): Promise<Response> => withTimeout(fetcher(url, { method: "POST", headers, body: JSON.stringify(body) }), 8_000);
    let built: ShopAssistantPayload | null = null;
    if (isSpeechToSpeechTenant(s2s, value.tenantId) || s2s.defaultMode === "speech_to_speech") {
      // Speech-to-speech by default or by the opt-in list (src/voice/voice-mode.ts), the demo line included: read the
      // assistant for its backend text model. A shop the default can't make speech-to-speech, or one opted out, gets
      // the standard payload, with its text model back when its assistant is still in speech-to-speech mode.
      built = build(await read());
    } else if (speechToSpeechConfigured(s2s)) {
      // The mode is off for this shop, but speech-to-speech is set up here, so its assistant may still be in that mode
      // (the mode was just turned off and configure-telnyx has not run yet). Read it if we can and put it back; a read
      // that fails never stops the save, which then pushes the standard payload as it always did.
      built = await read().then(build).catch(() => null);
    }
    if (built && (built.fallback || built.rollback)) log({ level: built.fallback ? "warn" : "info", event: "assistant_voice_mode", tenantId: value.tenantId, mode: built.mode, fallback: built.fallback ?? null, rollback: built.rollback });
    const body = built?.payload ?? buildTelnyxAssistantUpdate(value, env.PUBLIC_BASE_URL, { voice: env.TELNYX_VOICE });
    let response = await push(body);
    if (!response.ok && built?.mode === "speech_to_speech" && !voiceRequest(s2s, value.tenantId).strict && isPayloadRejection(response.status)) {
      // Telnyx refused the speech-to-speech payload itself. The default never stops a save: push the standard payload
      // instead (with the text model back when the assistant is in speech-to-speech mode) and say so in the log. A
      // tenant on the opt-in list keeps the error, and so does a save Telnyx refuses on the standard payload too.
      const detail = await response.json().then((answer) => (answer as { errors?: Array<{ detail?: unknown }> } | null)?.errors?.[0]?.detail, () => undefined);
      const standard = standardVoicePayload(buildTelnyxAssistantUpdate(value, env.PUBLIC_BASE_URL, { voice: env.TELNYX_VOICE }), { speechToSpeech: s2s, existing }, "provider_rejected");
      log({ level: "warn", event: "assistant_voice_mode", tenantId: value.tenantId, mode: standard.mode, fallback: "provider_rejected", rollback: standard.rollback, providerError: redactError(new Error(`HTTP ${response.status}${typeof detail === "string" && detail ? `: ${detail}` : ""}`)) });
      response = await push(standard.payload);
    }
    if (!response.ok) throw new Error(`Voice configuration update failed with HTTP ${response.status}`);
  };
  await update(config);
  try { await store.saveConfig(config); }
  catch (error) {
    try { await update(current); }
    catch {
      const inbound = await store.getIntegrationSecret(config.tenantId, "telnyx", "inbound_number");
      const number = inbound ?? (config.tenantId === env.DEFAULT_TENANT_ID ? env.TELNYX_FROM_NUMBER : undefined);
      if (number && assistantId && env.TELNYX_API_KEY) await new TelnyxVoiceRoutingClient({ apiKey: env.TELNYX_API_KEY, phoneNumber: number, assistantId, fetcher }).setPaused(true);
      await store.saveConfig({ ...current, paused: true });
    }
    throw error;
  }
}
