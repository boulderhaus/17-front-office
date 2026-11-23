import { pathToFileURL } from "node:url";
import { withTimeout } from "../src/application/retry.js";
import { loadEnvironment } from "../src/config/environment.js";
import type { Store } from "../src/ports.js";
import { buildTelnyxAssistantUpdate } from "../src/voice/system-prompt.js";

export interface AssistantPush {
  tenantId: string;
  assistantId: string;
  update: Record<string, unknown>;
}

/**
 * Every assistant we run gets the current prompt, tools, voice (TELNYX_VOICE), turn-taking and
 * telephony_settings (six-minute time_limit_secs, idle timers): the demo/template assistant plus each shop's provisioned assistant.
 */
export async function planAssistantPushes(input: { store: Store; defaultTenantId: string; demoAssistantId?: string | undefined; publicBaseUrl: string; voice?: string | undefined }): Promise<AssistantPush[]> {
  const pushes: AssistantPush[] = [];
  const seen = new Set<string>();
  if (input.demoAssistantId) {
    pushes.push({ tenantId: input.defaultTenantId, assistantId: input.demoAssistantId, update: buildTelnyxAssistantUpdate(await input.store.getConfig(input.defaultTenantId), input.publicBaseUrl, { voice: input.voice }) });
    seen.add(input.demoAssistantId);
  }
  for (const tenantId of (await input.store.listTenantIds()).sort()) {
    const route = await input.store.getProviderRouteForTenant("telnyx", tenantId);
    if (!route || seen.has(route.externalId)) continue;
    seen.add(route.externalId);
    pushes.push({ tenantId, assistantId: route.externalId, update: buildTelnyxAssistantUpdate(await input.store.getConfig(tenantId), input.publicBaseUrl, { voice: input.voice }) });
  }
  return pushes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes("--apply");
  const env = loadEnvironment(process.env);
  const { createRuntime } = await import("../src/runtime.js");
  const runtime = await createRuntime(env);

  try {
    const pushes = await planAssistantPushes({ store: runtime.store, defaultTenantId: env.DEFAULT_TENANT_ID, demoAssistantId: env.TELNYX_ASSISTANT_ID, publicBaseUrl: env.PUBLIC_BASE_URL, voice: env.TELNYX_VOICE });
    if (!apply) {
      console.log(JSON.stringify({
        mode: "dry_run",
        assistants: pushes.map((push) => ({ tenantId: push.tenantId, assistantId: push.assistantId, voice_settings: push.update.voice_settings, telephony_settings: push.update.telephony_settings })),
        demoUpdate: pushes.find((push) => push.assistantId === env.TELNYX_ASSISTANT_ID)?.update ?? null,
      }, null, 2));
    } else {
      if (!env.TELNYX_API_KEY || !env.TELNYX_ASSISTANT_ID || !env.TELNYX_MESSAGING_PROFILE_ID) {
        throw new Error("TELNYX_API_KEY, TELNYX_ASSISTANT_ID, and TELNYX_MESSAGING_PROFILE_ID are required with --apply");
      }
      const apiKey = env.TELNYX_API_KEY;
      const current = await telnyxRequest<Record<string, unknown>>(apiKey, `/ai/assistants/${encodeURIComponent(env.TELNYX_ASSISTANT_ID)}`);
      let updated: Record<string, unknown> = {};
      const failed: Array<{ tenantId: string; assistantId: string; error: string }> = [];
      for (const push of pushes) {
        try {
          const result = await telnyxRequest<Record<string, unknown>>(apiKey, `/ai/assistants/${encodeURIComponent(push.assistantId)}`, { method: "POST", body: JSON.stringify(push.update) });
          if (push.assistantId === env.TELNYX_ASSISTANT_ID) updated = result;
        } catch (error) {
          failed.push({ tenantId: push.tenantId, assistantId: push.assistantId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const texmlAppId = readTexmlAppId(updated) ?? readTexmlAppId(current);
      if (!texmlAppId) throw new Error("Telnyx assistant did not expose telephony_settings.default_texml_app_id");
      await telnyxRequest(apiKey, `/texml_applications/${encodeURIComponent(texmlAppId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          status_callback: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx`,
          status_callback_method: "post",
          call_cost_in_webhooks: true,
        }),
      });
      await telnyxRequest(apiKey, `/messaging_profiles/${encodeURIComponent(env.TELNYX_MESSAGING_PROFILE_ID)}`, {
        method: "PATCH",
        body: JSON.stringify({
          webhook_api_version: "2",
          webhook_url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx`,
        }),
      });
      console.log(JSON.stringify({
        mode: "applied",
        assistantId: env.TELNYX_ASSISTANT_ID,
        assistantsUpdated: pushes.length - failed.length,
        failed,
        texmlAppId,
        messagingProfileId: env.TELNYX_MESSAGING_PROFILE_ID,
        webhookUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx`,
      }));
      if (failed.length > 0) process.exitCode = 1;
    }
  } finally {
    await runtime.close();
  }
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
