import { withTimeout } from "../src/application/retry.js";
import { loadEnvironment } from "../src/config/environment.js";
import { createRuntime } from "../src/runtime.js";
import { buildTelnyxOutboundTestCall } from "../src/voice/system-prompt.js";

const env = loadEnvironment(process.env);
const to = readArgument("--to") ?? process.env.TELNYX_TEST_TO_NUMBER;
if (!to || !/^\+[1-9]\d{7,14}$/.test(to)) throw new Error("Pass a private E.164 destination with --to or TELNYX_TEST_TO_NUMBER");
if (!env.TELNYX_API_KEY || !env.TELNYX_ASSISTANT_ID || !env.TELNYX_FROM_NUMBER) {
  throw new Error("TELNYX_API_KEY, TELNYX_ASSISTANT_ID, and TELNYX_FROM_NUMBER are required");
}

const runtime = await createRuntime(env);
try {
  const config = await runtime.store.getConfig(env.DEFAULT_TENANT_ID);
  const assistant = await telnyxRequest<Record<string, unknown>>(
    env.TELNYX_API_KEY,
    `/ai/assistants/${encodeURIComponent(env.TELNYX_ASSISTANT_ID)}`,
  );
  const texmlAppId = readTexmlAppId(assistant);
  if (!texmlAppId) throw new Error("Telnyx assistant did not expose telephony_settings.default_texml_app_id");
  const callback = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx`;
  const call = await telnyxRequest<Record<string, unknown>>(
    env.TELNYX_API_KEY,
    `/texml/ai_calls/${encodeURIComponent(texmlAppId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        ...buildTelnyxOutboundTestCall({
          from: env.TELNYX_FROM_NUMBER,
          to,
          assistantId: env.TELNYX_ASSISTANT_ID,
          businessName: config.businessName,
          recordingDisclosure: config.recordingDisclosure,
        }),
        StatusCallback: callback,
        StatusCallbackMethod: "POST",
        StatusCallbackEvent: "initiated answered completed failed",
        ConversationCallback: callback,
        ConversationCallbackMethod: "POST",
      }),
    },
  );
  console.log(JSON.stringify({ mode: "outbound_test_accepted", callId: readCallId(call) }));
} finally {
  await runtime.close();
}

async function telnyxRequest<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await withTimeout(fetch(`https://api.telnyx.com/v2${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...init.headers },
  }), 8_000);
  const payload = await response.json().catch(() => ({})) as T & { errors?: Array<{ detail?: string }> };
  if (!response.ok) throw new Error(`Telnyx ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}${payload.errors?.[0]?.detail ? `: ${payload.errors[0].detail}` : ""}`);
  return payload;
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readTexmlAppId(value: Record<string, unknown>): string | null {
  const data = value.data && typeof value.data === "object" ? value.data as Record<string, unknown> : value;
  const telephony = data.telephony_settings && typeof data.telephony_settings === "object" ? data.telephony_settings as Record<string, unknown> : null;
  return typeof telephony?.default_texml_app_id === "string" ? telephony.default_texml_app_id : null;
}

function readCallId(value: Record<string, unknown>): string | null {
  const data = value.data && typeof value.data === "object" ? value.data as Record<string, unknown> : value;
  for (const key of ["call_control_id", "call_sid", "id"]) {
    if (typeof data[key] === "string") return data[key] as string;
  }
  return null;
}
