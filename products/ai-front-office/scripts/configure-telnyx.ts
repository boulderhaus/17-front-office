import { pathToFileURL } from "node:url";
import { ensureCallEndCallback } from "../src/adapters/telnyx-provisioning.js";
import { withTimeout } from "../src/application/retry.js";
import { loadEnvironment } from "../src/config/environment.js";
import type { Store } from "../src/ports.js";
import { buildTelnyxAssistantUpdate } from "../src/voice/system-prompt.js";
import { buildShopAssistantPayload, isSpeechToSpeechTenant, speechToSpeechSettings, type SpeechToSpeechSettings } from "../src/voice/voice-mode.js";
import { buildSetupAssistant, inheritedModel } from "../src/adapters/telnyx-setup-call.js";
import { PLATFORM_TENANT_ID } from "../src/ports.js";

export interface AssistantPush {
  tenantId: string;
  assistantId: string;
  update: Record<string, unknown>;
  /** "speech_to_speech" only for a tenant in TELNYX_S2S_TENANT_IDS (src/voice/voice-mode.ts). */
  mode?: "standard" | "speech_to_speech";
  /** This push also returns a speech-to-speech assistant to its text model (the tenant left the list). */
  rollback?: boolean;
  /** Instruction sections cut to fit the speech-to-speech limit. */
  cut?: string[];
  /** Set when this assistant can't be configured (e.g. a listed tenant with TELNYX_S2S_MODEL unset): never pushed. */
  error?: string;
}

/**
 * Every assistant we run gets the current prompt, tools, voice (TELNYX_VOICE), turn-taking and
 * telephony_settings (seven-minute backstop time_limit_secs, idle timers): the demo/template assistant plus each shop's provisioned assistant.
 */
export async function planAssistantPushes(input: {
  store: Store;
  defaultTenantId: string;
  demoAssistantId?: string | undefined;
  publicBaseUrl: string;
  voice?: string | undefined;
  /** Opt-in speech-to-speech tenants. The demo assistant never uses it. */
  speechToSpeech?: SpeechToSpeechSettings | undefined;
  /** Reads a shop's assistant as Telnyx has it (GET), for the speech-to-speech backend model and for rollback. */
  readAssistant?: ((assistantId: string) => Promise<Record<string, unknown>>) | undefined;
}): Promise<AssistantPush[]> {
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
    const config = await input.store.getConfig(tenantId);
    const listed = isSpeechToSpeechTenant(input.speechToSpeech, tenantId);
    let existing: Record<string, unknown> | null = null;
    if (input.readAssistant) {
      try { existing = await input.readAssistant(route.externalId); }
      catch (error) {
        // Never push blind: an assistant we can't read may still be in speech-to-speech mode, and today's payload alone
        // would leave its speaking model on with a text-to-speech voice. Reported as failed; rerun configure.
        pushes.push({ tenantId, assistantId: route.externalId, update: {}, error: `assistant read failed${listed ? " (speech-to-speech)" : ""}: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
    }
    try {
      const built = buildShopAssistantPayload(config, input.publicBaseUrl, { voice: input.voice, speechToSpeech: input.speechToSpeech, existing });
      pushes.push({ tenantId, assistantId: route.externalId, update: built.payload, mode: built.mode, ...(built.rollback ? { rollback: true } : {}), ...(built.cut.length ? { cut: built.cut } : {}) });
    } catch (error) {
      pushes.push({ tenantId, assistantId: route.externalId, update: {}, error: error instanceof Error ? error.message : String(error) });
    }
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

export interface SetupHelperPlan {
  /** The existing setup helper to update, or null to create one. */
  assistantId: string | null;
  body: Record<string, unknown>;
}

/**
 * The "Call me now" setup helper: one assistant for every shop, with Otto's voice, speech settings and model (copied
 * from Otto's assistant, never named here) and its tools. TELNYX_SETUP_ASSISTANT_ID wins, then the id the app saved.
 */
export async function planSetupHelper(input: { store: Store; setupAssistantId?: string | undefined; ottoAssistant: Record<string, unknown>; publicBaseUrl: string; voice?: string | undefined }): Promise<SetupHelperPlan> {
  const assistantId = input.setupAssistantId ?? await input.store.getIntegrationSecret(PLATFORM_TENANT_ID, "telnyx", "setup_assistant_id");
  return { assistantId, body: buildSetupAssistant({ publicBaseUrl: input.publicBaseUrl, voice: input.voice, inherited: inheritedModel(input.ottoAssistant) }) };
}

/** Create or update the setup helper; a new one's id is saved where the app reads it. */
export async function applySetupHelper(input: { plan: SetupHelperPlan; store: Store; request: <T>(path: string, init?: RequestInit) => Promise<T> }): Promise<{ assistantId: string; action: "updated" | "created" }> {
  if (input.plan.assistantId) {
    await input.request(`/ai/assistants/${encodeURIComponent(input.plan.assistantId)}`, { method: "POST", body: JSON.stringify(input.plan.body) });
    return { assistantId: input.plan.assistantId, action: "updated" };
  }
  const created = await input.request<{ data?: { id?: unknown }; id?: unknown }>("/ai/assistants", { method: "POST", headers: { "idempotency-key": "call-otto-setup-helper-v2" }, body: JSON.stringify(input.plan.body) });
  const id = typeof created.data?.id === "string" ? created.data.id : typeof created.id === "string" ? created.id : null;
  if (!id) throw new Error("Telnyx did not return a setup assistant id");
  await input.store.saveIntegrationSecret(PLATFORM_TENANT_ID, "telnyx", "setup_assistant_id", id);
  return { assistantId: id, action: "created" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes("--apply");
  const env = loadEnvironment(process.env);
  const { createRuntime } = await import("../src/runtime.js");
  const runtime = await createRuntime(env);

  try {
    const pushes = await planAssistantPushes({
      store: runtime.store, defaultTenantId: env.DEFAULT_TENANT_ID, demoAssistantId: env.TELNYX_ASSISTANT_ID, publicBaseUrl: env.PUBLIC_BASE_URL, voice: env.TELNYX_VOICE,
      speechToSpeech: speechToSpeechSettings(env),
      // Read-only GETs, in dry runs too: a listed shop's backend model, and rollback for a shop that left the list.
      ...(env.TELNYX_API_KEY ? { readAssistant: (assistantId: string) => telnyxRequest<Record<string, unknown>>(env.TELNYX_API_KEY!, `/ai/assistants/${encodeURIComponent(assistantId)}`) } : {}),
    });
    if (!apply) {
      console.log(JSON.stringify({
        mode: "dry_run",
        assistants: pushes.map((push) => ({ tenantId: push.tenantId, assistantId: push.assistantId, mode: push.mode ?? "standard", rollback: push.rollback ?? false, cut: push.cut ?? [], error: push.error, model: push.update.model, delegation_settings: push.update.delegation_settings, voice_settings: push.update.voice_settings, telephony_settings: push.update.telephony_settings })),
        demoUpdate: pushes.find((push) => push.assistantId === env.TELNYX_ASSISTANT_ID)?.update ?? null,
        // Read-only: which assistants' TeXML apps still lack the end-of-call callback ("would_set").
        callEndCallbacks: env.TELNYX_API_KEY ? await syncCallEndCallbacks({ pushes, apiKey: env.TELNYX_API_KEY, publicBaseUrl: env.PUBLIC_BASE_URL, apply: false }) : "TELNYX_API_KEY not set",
        // The "Call me now" setup helper (model copied from Otto's assistant on --apply).
        setupHelper: await planSetupHelper({ store: runtime.store, setupAssistantId: env.TELNYX_SETUP_ASSISTANT_ID, ottoAssistant: {}, publicBaseUrl: env.PUBLIC_BASE_URL, voice: env.TELNYX_VOICE }).then((plan) => ({ action: plan.assistantId ? "would_update" : "would_create", assistantId: plan.assistantId, tools: (plan.body.tools as Array<{ type: string; webhook?: { name: string } }>).map((tool) => tool.webhook?.name ?? tool.type), telephony_settings: plan.body.telephony_settings })),
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
        if (push.error) {
          failed.push({ tenantId: push.tenantId, assistantId: push.assistantId, error: push.error });
          continue;
        }
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
      // The setup helper: same voice, speech settings and model as Otto. A failure is reported, never hides the rest.
      let setupHelper: { assistantId: string; action: string } | { action: "failed"; error: string };
      try {
        const plan = await planSetupHelper({ store: runtime.store, setupAssistantId: env.TELNYX_SETUP_ASSISTANT_ID, ottoAssistant: (current.data && typeof current.data === "object" ? current.data : current) as Record<string, unknown>, publicBaseUrl: env.PUBLIC_BASE_URL, voice: env.TELNYX_VOICE });
        setupHelper = await applySetupHelper({ plan, store: runtime.store, request: (path, init) => telnyxRequest(apiKey, path, init) });
      } catch (error) {
        setupHelper = { action: "failed", error: error instanceof Error ? error.message : String(error) };
        failed.push({ tenantId: PLATFORM_TENANT_ID, assistantId: "setup-helper", error: setupHelper.error });
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
        setupHelper,
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
