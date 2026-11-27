import type { Environment } from "../config/environment.js";
import type { BusinessConfig } from "../domain/models.js";
import type { Store } from "../ports.js";
import { buildTelnyxAssistantUpdate } from "../voice/system-prompt.js";
import { buildShopAssistantPayload, isSpeechToSpeechTenant, speechToSpeechConfigured, speechToSpeechSettings, type ShopAssistantPayload } from "../voice/voice-mode.js";
import { withTimeout } from "../application/retry.js";
import { TelnyxVoiceRoutingClient } from "./telnyx.js";

type Log = (entry: Record<string, unknown>) => void;

/** Never show saved rules while the live assistant still has different rules. */
export async function saveAssistantConfig(store: Store, env: Environment, config: BusinessConfig, fetcher: typeof fetch = fetch, log: Log = (entry) => console.log(JSON.stringify(entry))): Promise<void> {
  // Callers serialize read/modify/write under config:<tenant>. Also serialize
  // the external update and rollback so provider revisions cannot interleave.
  return store.withLock(`assistant-config:${config.tenantId}`, () => synchronize(store, env, config, fetcher, log));
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
    const build = (existing: Record<string, unknown>): ShopAssistantPayload => buildShopAssistantPayload(value, env.PUBLIC_BASE_URL, { voice: env.TELNYX_VOICE, speechToSpeech: s2s, existing });
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
    const response = await withTimeout(fetcher(url, { method: "POST", headers, body: JSON.stringify(body) }), 8_000);
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
