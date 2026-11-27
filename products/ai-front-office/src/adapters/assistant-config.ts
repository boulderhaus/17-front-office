import type { Environment } from "../config/environment.js";
import type { BusinessConfig } from "../domain/models.js";
import type { Store } from "../ports.js";
import { buildTelnyxAssistantUpdate } from "../voice/system-prompt.js";
import { buildShopAssistantPayload, isSpeechToSpeechTenant, speechToSpeechSettings } from "../voice/voice-mode.js";
import { withTimeout } from "../application/retry.js";
import { TelnyxVoiceRoutingClient } from "./telnyx.js";

/** Never show saved rules while the live assistant still has different rules. */
export async function saveAssistantConfig(store: Store, env: Environment, config: BusinessConfig, fetcher: typeof fetch = fetch): Promise<void> {
  // Callers serialize read/modify/write under config:<tenant>. Also serialize
  // the external update and rollback so provider revisions cannot interleave.
  return store.withLock(`assistant-config:${config.tenantId}`, () => synchronize(store, env, config, fetcher));
}

async function synchronize(store: Store, env: Environment, config: BusinessConfig, fetcher: typeof fetch): Promise<void> {
  const current = await store.getConfig(config.tenantId);
  const route = await store.getProviderRouteForTenant("telnyx", config.tenantId);
  const assistantId = route?.externalId ?? (config.tenantId === env.DEFAULT_TENANT_ID ? env.TELNYX_ASSISTANT_ID : undefined);
  const update = async (value: BusinessConfig) => {
    if (env.DEMO_MODE || !assistantId) return;
    if (!env.TELNYX_API_KEY) throw new Error("Voice configuration is unavailable");
    const url = `https://api.telnyx.com/v2/ai/assistants/${encodeURIComponent(assistantId)}`;
    const headers = { authorization: `Bearer ${env.TELNYX_API_KEY}`, "content-type": "application/json" };
    let body: Record<string, unknown>;
    const s2s = speechToSpeechSettings(env);
    if (isSpeechToSpeechTenant(s2s, value.tenantId) && value.tenantId !== env.DEFAULT_TENANT_ID) {
      // Opt-in speech-to-speech shop (src/voice/voice-mode.ts): read the assistant for its backend text model.
      const current = await withTimeout(fetcher(url, { headers }), 8_000);
      if (!current.ok) throw new Error(`Voice configuration read failed with HTTP ${current.status}`);
      body = buildShopAssistantPayload(value, env.PUBLIC_BASE_URL, { voice: env.TELNYX_VOICE, speechToSpeech: s2s, existing: await current.json() as Record<string, unknown> }).payload;
    } else {
      body = buildTelnyxAssistantUpdate(value, env.PUBLIC_BASE_URL, { voice: env.TELNYX_VOICE });
    }
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
