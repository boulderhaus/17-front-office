import { pathToFileURL } from "node:url";
import { ensureCallEndCallback } from "../src/adapters/telnyx-provisioning.js";
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
 * telephony_settings (seven-minute backstop time_limit_secs, idle timers): the demo/template assistant plus each shop's provisioned assistant.
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

export interface CallEndCallbackOutcome {
  tenantId: string;
  assistantId: string;
  action: "already_set" | "set" | "would_set" | "failed";
  error?: string;
}

/**
 * The repair path for end-of-call callbacks: every assistant we push to (the demo assistant and each shop's own)
 * gets status_callback, POST and call cost on its own TeXML app. Without apply it only reads and reports.
 * One assistant failing never stops the rest.
 */
export async function syncCallEndCallbacks(input: { pushes: AssistantPush[]; apiKey: string; publicBaseUrl: string; apply: boolean; fetcher?: typeof fetch | undefined; sleep?: ((ms: number) => Promise<void>) | undefined }): Promise<CallEndCallbackOutcome[]> {
  const outcomes: CallEndCallbackOutcome[] = [];
  for (const push of input.pushes) {
    try {
      const result = await ensureCallEndCallback({ apiKey: input.apiKey, assistantId: push.assistantId, publicBaseUrl: input.publicBaseUrl, apply: input.apply, fetcher: input.fetcher, sleep: input.sleep });
      outcomes.push({ tenantId: push.tenantId, assistantId: push.assistantId, action: result.action });
    } catch (error) {
      outcomes.push({ tenantId: push.tenantId, assistantId: push.assistantId, action: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
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
        // Read-only: which assistants' TeXML apps still lack the end-of-call callback ("would_set").
        callEndCallbacks: env.TELNYX_API_KEY ? await syncCallEndCallbacks({ pushes, apiKey: env.TELNYX_API_KEY, publicBaseUrl: env.PUBLIC_BASE_URL, apply: false }) : "TELNYX_API_KEY not set",
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
      const assistantUpdateFailures = failed.length;
      const texmlAppId = readTexmlAppId(updated) ?? readTexmlAppId(current);
      if (!texmlAppId) throw new Error("Telnyx assistant did not expose telephony_settings.default_texml_app_id");
      // Every assistant has its own TeXML app: the demo assistant's and each shop's must all post the
      // end-of-call callback here, or that line's calls are never finalized.
      const callEndCallbacks = await syncCallEndCallbacks({ pushes, apiKey, publicBaseUrl: env.PUBLIC_BASE_URL, apply: true });
      for (const outcome of callEndCallbacks) {
        if (outcome.action === "failed") failed.push({ tenantId: outcome.tenantId, assistantId: outcome.assistantId, error: `call-end callback: ${outcome.error ?? "failed"}` });
      }
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
        assistantsUpdated: pushes.length - assistantUpdateFailures,
        failed,
        callEndCallbacks: callEndCallbacks.map(({ tenantId, assistantId, action }) => ({ tenantId, assistantId, action })),
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
