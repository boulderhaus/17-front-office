import { withTimeout } from "../src/application/retry.js";
import { loadEnvironment } from "../src/config/environment.js";
import { createRuntime } from "../src/runtime.js";
import { buildTelnyxAssistantUpdate } from "../src/voice/system-prompt.js";

const apply = process.argv.includes("--apply");
const env = loadEnvironment(process.env);
const runtime = await createRuntime(env);

try {
  const config = await runtime.store.getConfig(env.DEFAULT_TENANT_ID);
  const update = buildTelnyxAssistantUpdate(config, env.PUBLIC_BASE_URL);
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry_run", assistantId: env.TELNYX_ASSISTANT_ID ?? null, update }, null, 2));
  } else {
    if (!env.TELNYX_API_KEY || !env.TELNYX_ASSISTANT_ID || !env.TELNYX_MESSAGING_PROFILE_ID) {
      throw new Error("TELNYX_API_KEY, TELNYX_ASSISTANT_ID, and TELNYX_MESSAGING_PROFILE_ID are required with --apply");
    }
    const current = await telnyxRequest<Record<string, unknown>>(
      env.TELNYX_API_KEY,
      `/ai/assistants/${encodeURIComponent(env.TELNYX_ASSISTANT_ID)}`,
    );
    const updated = await telnyxRequest<Record<string, unknown>>(
      env.TELNYX_API_KEY,
      `/ai/assistants/${encodeURIComponent(env.TELNYX_ASSISTANT_ID)}`,
      { method: "POST", body: JSON.stringify(update) },
    );
    const texmlAppId = readTexmlAppId(updated) ?? readTexmlAppId(current);
    if (!texmlAppId) throw new Error("Telnyx assistant did not expose telephony_settings.default_texml_app_id");
    await telnyxRequest(
      env.TELNYX_API_KEY,
      `/texml_applications/${encodeURIComponent(texmlAppId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status_callback: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx`,
          status_callback_method: "post",
          call_cost_in_webhooks: true,
        }),
      },
    );
    await telnyxRequest(
      env.TELNYX_API_KEY,
      `/messaging_profiles/${encodeURIComponent(env.TELNYX_MESSAGING_PROFILE_ID)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          webhook_api_version: "2",
          webhook_url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx`,
        }),
      },
    );
    console.log(JSON.stringify({
      mode: "applied",
      assistantId: env.TELNYX_ASSISTANT_ID,
      texmlAppId,
      messagingProfileId: env.TELNYX_MESSAGING_PROFILE_ID,
      webhookUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx`,
    }));
  }
} finally {
  await runtime.close();
}

async function telnyxRequest<T = unknown>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await withTimeout(fetch(`https://api.telnyx.com/v2${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...init.headers,
    },
  }), 8_000);
  const payload = await response.json().catch(() => ({})) as T & { errors?: Array<{ detail?: string }> };
  if (!response.ok) throw new Error(`Telnyx ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}${payload.errors?.[0]?.detail ? `: ${payload.errors[0].detail}` : ""}`);
  return payload;
}

function readTexmlAppId(value: Record<string, unknown>): string | null {
  const data = value.data && typeof value.data === "object" ? value.data as Record<string, unknown> : value;
  const telephony = data.telephony_settings && typeof data.telephony_settings === "object"
    ? data.telephony_settings as Record<string, unknown>
    : null;
  return typeof telephony?.default_texml_app_id === "string" ? telephony.default_texml_app_id : null;
}
