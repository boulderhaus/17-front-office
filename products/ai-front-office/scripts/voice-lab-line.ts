import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ensureCallEndCallback, TelnyxProvisioner } from "../src/adapters/telnyx-provisioning.js";
import { TelnyxVoiceRoutingClient } from "../src/adapters/telnyx.js";
import { withTimeout } from "../src/application/retry.js";
import { graceStartedAt } from "../src/application/grace-line.js";
import { readVoiceLabLine, VOICE_LAB_LINE_KEY, VOICE_LAB_PROVIDER, VOICE_LAB_TENANT_KEY, type VoiceLabLine } from "../src/application/voice-lab.js";
import { loadEnvironment, type Environment } from "../src/config/environment.js";
import { isCompStatus, isPaidStatus } from "../src/domain/billing.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { BusinessConfig } from "../src/domain/models.js";
import { PLATFORM_TENANT_ID, type Store } from "../src/ports.js";
import { buildTelnyxAssistantUpdate } from "../src/voice/system-prompt.js";
import { buildShopAssistantPayload, speechToSpeechSettings } from "../src/voice/voice-mode.js";

/**
 * The voice lab line: one complimentary lab shop on a number already on our Telnyx account, in the shop's configured
 * voice mode (TELNYX_S2S_TENANT_IDS, src/voice/voice-mode.ts), to compare by ear with a normal line. Never buys a
 * number. Dry run by default; --apply changes things. Run with the server's env, e.g.
 *   railway run node --import tsx scripts/voice-lab-line.ts --create-tenant [--apply]
 *   railway run node --import tsx scripts/voice-lab-line.ts --tenant <tenant id> --number-id <Telnyx number id> [--apply]
 *   railway run node --import tsx scripts/voice-lab-line.ts --remove [--apply]
 * --remove points the number back where it was, gives it back to the cancelled shop that held it (while that shop's
 * grace period runs) and deletes the lab assistant.
 */

export const LAB_BUSINESS_NAME = "Otto Lab Plumbing";

export interface LabDeps {
  store: Store;
  env: Pick<Environment, "TELNYX_API_KEY" | "TELNYX_ASSISTANT_ID" | "TELNYX_TEMPLATE_ASSISTANT_ID" | "TELNYX_MESSAGING_PROFILE_ID" | "TELNYX_VOICEMAIL_APP_ID" | "TELNYX_FROM_NUMBER" | "TELNYX_VOICE" | "PUBLIC_BASE_URL" | "DEFAULT_TENANT_ID" | "PUBLIC_DEMO_TENANT_ID" | "TELNYX_S2S_TENANT_IDS" | "TELNYX_S2S_MODEL" | "TELNYX_S2S_VOICE" | "TELNYX_S2S_BACKEND_MODEL">;
  fetcher?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
}

export class LabRefusal extends Error {}

/** A made-up shop: no owner account, no owner phone, no calendar (so confirm mode), nothing ever sent. */
export function labShopConfig(tenantId: string): BusinessConfig {
  return {
    ...createDemoConfig(tenantId),
    paused: true,
    businessName: LAB_BUSINESS_NAME,
    greeting: `Thanks for calling ${LAB_BUSINESS_NAME}. How can I help?`,
    timezone: "America/Chicago",
    serviceAreaTerms: ["Lakeview Springs", "Maple Hollow"],
    serviceCategories: ["plumbing repair", "drain cleaning", "water heater", "other"],
    emergencyKeywords: ["burst pipe", "flooding", "sewage backup"],
    bookingMode: "confirm",
    calendarConnectionRef: null,
    operationMode: "always",
    afterHours: { weekdayStart: "18:00", weekdayEnd: "07:00", weekends: true, holidayDates: [] },
    bookableHours: { weekdayStart: "07:00", weekdayEnd: "18:00", weekends: false },
    ownerNotificationRefs: [],
    ownerTransferNumberRef: null,
    requireDiagnosticFeeAcceptance: false,
    supportEmail: null,
    customerSmsEnabled: false,
    ownerWeeklyEmailEnabled: false,
    ownerDailySmsEnabled: false,
    ownerRealtimeSmsEnabled: false,
  };
}

/** Create the complimentary lab shop once (the review account's pattern, minus the owner sign-in). */
export async function createLabTenant(deps: Pick<LabDeps, "store" | "now">, apply: boolean): Promise<{ tenantId: string | null; action: "exists" | "created" | "would_create" }> {
  return deps.store.withLock("voice-lab", async () => {
    const existing = await deps.store.getIntegrationSecret(PLATFORM_TENANT_ID, VOICE_LAB_PROVIDER, VOICE_LAB_TENANT_KEY);
    if (existing) return { tenantId: existing, action: "exists" };
    if (!apply) return { tenantId: null, action: "would_create" };
    const tenantId = `shop_lab_${randomUUID()}`;
    const now = (deps.now ?? (() => new Date()))().toISOString();
    await deps.store.saveConfig(labShopConfig(tenantId));
    await deps.store.saveSubscription({ tenantId, providerCustomerId: null, providerSubscriptionId: null, status: "comp", currentPeriodEnd: null, providerEventCreatedAt: now, createdAt: now, updatedAt: now });
    for (const key of ["hours_set_at", "completed_at"]) await deps.store.saveIntegrationSecret(tenantId, "onboarding", key, now);
    await deps.store.saveIntegrationSecret(PLATFORM_TENANT_ID, VOICE_LAB_PROVIDER, VOICE_LAB_TENANT_KEY, tenantId);
    return { tenantId, action: "created" };
  });
}

/** Only a complimentary shop that never had Stripe (no customer, subscription or checkout) can be the lab shop. */
export async function labTenantRefusal(deps: Pick<LabDeps, "store" | "env">, tenantId: string): Promise<string | null> {
  if (tenantId === deps.env.DEFAULT_TENANT_ID || tenantId === deps.env.PUBLIC_DEMO_TENANT_ID) return "The demo tenants can't be the lab shop";
  const subscription = await deps.store.getSubscription(tenantId);
  if (!subscription || !isCompStatus(subscription.status)) return "The lab shop must be complimentary (status comp)";
  if (subscription.providerCustomerId || subscription.providerSubscriptionId) return "This shop has had a Stripe customer or subscription, so it has had a paid plan";
  if (await deps.store.getIntegrationSecret(tenantId, "stripe", "open_checkout")) return "This shop has started a Stripe checkout";
  if (!(await deps.store.listTenantIds()).includes(tenantId)) return "No such shop";
  return null;
}

export interface LabLinePlan {
  tenantId: string;
  numberId: string;
  phoneNumber: string;
  currentConnectionId: string | null;
  holderTenantId: string | null;
  holderKeys: Array<"inbound_number" | "pending_number">;
  assistantId: string | null;
}

/** Every check that can refuse, read-only. Refuses paid or demo shops, numbers a paying shop or another assistant uses, and the SMS sender. */
export async function planLabLine(deps: LabDeps, input: { tenantId: string; numberId: string }): Promise<LabLinePlan> {
  const refusal = await labTenantRefusal(deps, input.tenantId);
  if (refusal) throw new LabRefusal(refusal);
  if (!deps.env.TELNYX_API_KEY) throw new LabRefusal("TELNYX_API_KEY is not set");
  const lab = await readVoiceLabLine(deps.store);
  if (lab && (lab.tenantId !== input.tenantId || lab.numberId !== input.numberId)) throw new LabRefusal("A different lab line is set; run --remove first");
  const number = objectData(await telnyx(deps, `/phone_numbers/${encodeURIComponent(input.numberId)}`));
  const phoneNumber = typeof number.phone_number === "string" ? number.phone_number : null;
  if (!phoneNumber) throw new LabRefusal("That number id is not on our Telnyx account");
  if (number.status !== undefined && number.status !== "active") throw new LabRefusal("That number is not active");
  if (phoneNumber === deps.env.TELNYX_FROM_NUMBER) throw new LabRefusal("That is the platform SMS and demo number");
  const holders: Array<{ tenantId: string; keys: Array<"inbound_number" | "pending_number"> }> = [];
  for (const tenantId of await deps.store.listTenantIds()) {
    if (tenantId === input.tenantId) continue;
    const keys: Array<"inbound_number" | "pending_number"> = [];
    for (const key of ["inbound_number", "pending_number"] as const) {
      if (await deps.store.getIntegrationSecret(tenantId, "telnyx", key) === phoneNumber) keys.push(key);
    }
    if (keys.length === 0) continue;
    if (isPaidStatus((await deps.store.getSubscription(tenantId))?.status)) throw new LabRefusal("A paying shop uses that number");
    holders.push({ tenantId, keys });
  }
  if (holders.length > 1) throw new LabRefusal("More than one shop has that number saved");
  const assistantId = lab?.assistantId ?? await deps.store.getIntegrationSecret(input.tenantId, "telnyx", "provisioned_assistant_id");
  const currentConnectionId = connectionOf(number.connection_id);
  // Free, on the grace voicemail, or already the lab assistant's: anything else is a live line.
  const allowed = new Set([deps.env.TELNYX_VOICEMAIL_APP_ID, assistantId ? await assistantTexmlApp(deps, assistantId).catch(() => null) : null].filter(Boolean));
  if (currentConnectionId && !allowed.has(currentConnectionId)) throw new LabRefusal("That number answers on another connection, so it is in use");
  return {
    tenantId: input.tenantId, numberId: input.numberId, phoneNumber, currentConnectionId,
    holderTenantId: lab ? lab.previous.holderTenantId : holders[0]?.tenantId ?? null,
    holderKeys: lab ? lab.previous.holderKeys : holders[0]?.keys ?? [],
    assistantId,
  };
}

/**
 * Provision the lab shop's assistant in its configured voice mode, record the lab line (so nothing releases it), take
 * the number off the cancelled shop that held it, set the call-end callback, save the line on the lab shop the way
 * go-live does, and point the number at the assistant. Idempotent: a rerun updates the assistant and changes nothing else.
 */
export async function applyLabLine(deps: LabDeps, plan: LabLinePlan): Promise<{ assistantId: string; mode: string; cut: string[] }> {
  const { store, env } = deps;
  const apiKey = env.TELNYX_API_KEY!;
  const config = await store.getConfig(plan.tenantId);
  const speechToSpeech = speechToSpeechSettings(env);
  let assistantId = plan.assistantId;
  let mode = "standard";
  let cut: string[] = [];
  if (!assistantId) {
    const templateAssistantId = env.TELNYX_TEMPLATE_ASSISTANT_ID ?? env.TELNYX_ASSISTANT_ID;
    if (!templateAssistantId) throw new LabRefusal("No Telnyx template assistant is set");
    assistantId = await new TelnyxProvisioner({ apiKey, templateAssistantId, messagingProfileId: env.TELNYX_MESSAGING_PROFILE_ID ?? "", ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) })
      .createAssistant({ tenantId: plan.tenantId, businessName: config.businessName, assistantUpdate: buildTelnyxAssistantUpdate(config, env.PUBLIC_BASE_URL, { voice: env.TELNYX_VOICE }), speechToSpeech });
    await store.saveIntegrationSecret(plan.tenantId, "telnyx", "provisioned_assistant_id", assistantId);
  }
  const existing = await telnyx(deps, `/ai/assistants/${encodeURIComponent(assistantId)}`);
  const built = buildShopAssistantPayload(config, env.PUBLIC_BASE_URL, { voice: env.TELNYX_VOICE, speechToSpeech, existing });
  mode = built.mode;
  cut = built.cut;
  await telnyx(deps, `/ai/assistants/${encodeURIComponent(assistantId)}`, { method: "POST", body: JSON.stringify(built.payload) });

  // Recorded before anything moves, so the grace sweep or a delete never releases the number mid-way.
  const previous = await readVoiceLabLine(store);
  const line: VoiceLabLine = {
    tenantId: plan.tenantId, phoneNumber: plan.phoneNumber, numberId: plan.numberId, assistantId,
    previous: previous?.previous ?? { connectionId: plan.currentConnectionId, holderTenantId: plan.holderTenantId, holderKeys: plan.holderKeys },
    createdAt: previous?.createdAt ?? (deps.now ?? (() => new Date()))().toISOString(),
  };
  await store.saveIntegrationSecret(PLATFORM_TENANT_ID, VOICE_LAB_PROVIDER, VOICE_LAB_LINE_KEY, JSON.stringify(line));
  // One shop per number: the cancelled shop's number lookup would otherwise answer calls with its voicemail.
  if (plan.holderTenantId && !previous) {
    for (const key of plan.holderKeys) await store.deleteIntegrationSecret(plan.holderTenantId, "telnyx", key);
  }
  await ensureCallEndCallback({ apiKey, assistantId, publicBaseUrl: env.PUBLIC_BASE_URL, apply: true, fetcher: deps.fetcher });
  const now = (deps.now ?? (() => new Date()))().toISOString();
  await store.saveIntegrationSecret(plan.tenantId, "telnyx", "inbound_number", plan.phoneNumber);
  const route = await store.getProviderRoute("telnyx", assistantId);
  await store.saveProviderRoute({ provider: "telnyx", externalId: assistantId, tenantId: plan.tenantId, createdAt: route?.createdAt ?? now, updatedAt: now });
  await routing(deps, plan.phoneNumber, assistantId).setPaused(false);
  await store.withLock(`config:${plan.tenantId}`, async () => store.saveConfig({ ...await store.getConfig(plan.tenantId), paused: false }));
  return { assistantId, mode, cut };
}

/** Put the number back as it was found, give it back to the shop that held it, delete the lab assistant. */
export async function removeLabLine(deps: LabDeps, apply: boolean): Promise<Record<string, unknown>> {
  const { store, env } = deps;
  const line = await readVoiceLabLine(store);
  if (!line) return { action: "none", reason: "No lab line is set" };
  const holder = line.previous.holderTenantId;
  // Give it back only while the holder's grace period still runs; after it ended the sweep would have released it.
  const holderGrace = holder ? Boolean(await graceStartedAt(store, holder)) : false;
  const plan = {
    tenantId: line.tenantId, numberId: line.numberId, restoreConnectionId: line.previous.connectionId,
    restoreHolder: holder && holderGrace ? { tenantId: holder, keys: line.previous.holderKeys } : null,
    holderGraceEnded: Boolean(holder && !holderGrace),
    deleteAssistant: line.assistantId,
  };
  if (!apply) return { action: "would_remove", ...plan };
  if (!env.TELNYX_API_KEY) throw new LabRefusal("TELNYX_API_KEY is not set");
  await store.withLock(`config:${line.tenantId}`, async () => store.saveConfig({ ...await store.getConfig(line.tenantId), paused: true }));
  const number = objectData(await telnyx(deps, `/phone_numbers/${encodeURIComponent(line.numberId)}`));
  if (connectionOf(number.connection_id) !== line.previous.connectionId) {
    const updated = objectData(await telnyx(deps, `/phone_numbers/${encodeURIComponent(line.numberId)}`, { method: "PATCH", body: JSON.stringify({ connection_id: line.previous.connectionId }) }));
    if (connectionOf(updated.connection_id) !== line.previous.connectionId) throw new Error("Telnyx did not put the number back on its connection");
  }
  await store.deleteIntegrationSecret(line.tenantId, "telnyx", "inbound_number");
  if (plan.restoreHolder) {
    for (const key of plan.restoreHolder.keys) {
      if (!await store.getIntegrationSecret(plan.restoreHolder.tenantId, "telnyx", key)) await store.saveIntegrationSecret(plan.restoreHolder.tenantId, "telnyx", key, line.phoneNumber);
    }
  }
  if (line.assistantId !== (env.TELNYX_TEMPLATE_ASSISTANT_ID ?? env.TELNYX_ASSISTANT_ID)) {
    await telnyx(deps, `/ai/assistants/${encodeURIComponent(line.assistantId)}`, { method: "DELETE" }, [404]);
  }
  await store.deleteIntegrationSecret(line.tenantId, "telnyx", "provisioned_assistant_id");
  await store.deleteIntegrationSecret(PLATFORM_TENANT_ID, VOICE_LAB_PROVIDER, VOICE_LAB_LINE_KEY);
  return { action: "removed", ...plan };
}

function routing(deps: LabDeps, phoneNumber: string, assistantId: string): TelnyxVoiceRoutingClient {
  return new TelnyxVoiceRoutingClient({ apiKey: deps.env.TELNYX_API_KEY!, phoneNumber, assistantId, voicemailConnectionId: deps.env.TELNYX_VOICEMAIL_APP_ID, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) });
}

async function assistantTexmlApp(deps: LabDeps, assistantId: string): Promise<string | null> {
  const telephony = objectData(objectData(await telnyx(deps, `/ai/assistants/${encodeURIComponent(assistantId)}`)).telephony_settings);
  return typeof telephony.default_texml_app_id === "string" ? telephony.default_texml_app_id : null;
}

async function telnyx(deps: LabDeps, path: string, init: RequestInit = {}, tolerated: number[] = []): Promise<Record<string, unknown>> {
  const response = await withTimeout((deps.fetcher ?? fetch)(`https://api.telnyx.com/v2${path}`, {
    ...init,
    headers: { authorization: `Bearer ${deps.env.TELNYX_API_KEY}`, "content-type": "application/json", ...init.headers },
  }), 10_000);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown> & { errors?: Array<{ detail?: string }> };
  if (!response.ok && !tolerated.includes(response.status)) throw new Error(`Telnyx ${init.method ?? "GET"} ${path.split("?")[0]} failed with HTTP ${response.status}${payload.errors?.[0]?.detail ? `: ${payload.errors[0].detail}` : ""}`);
  return payload;
}

function connectionOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function objectData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  return object.data && typeof object.data === "object" && !Array.isArray(object.data) ? object.data as Record<string, unknown> : object;
}

/** Last four digits only: the full number never goes to logs. */
function masked(phoneNumber: string): string {
  return `…${phoneNumber.slice(-4)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const env = loadEnvironment(process.env);
  const { createRuntime } = await import("../src/runtime.js");
  const runtime = await createRuntime(env);
  const deps: LabDeps = { store: runtime.store, env };
  try {
    if (args.includes("--create-tenant")) {
      console.log(JSON.stringify({ mode: apply ? "applied" : "dry_run", ...await createLabTenant(deps, apply) }));
    } else if (args.includes("--remove")) {
      const result = await removeLabLine(deps, apply);
      console.log(JSON.stringify({ mode: apply ? "applied" : "dry_run", ...result }));
    } else {
      const tenantId = value("--tenant");
      const numberId = value("--number-id");
      if (!tenantId || !numberId) throw new Error("Usage: --create-tenant | --tenant <id> --number-id <id> | --remove, each with optional --apply");
      const plan = await planLabLine(deps, { tenantId, numberId });
      const s2s = speechToSpeechSettings(env);
      const summary = { tenantId: plan.tenantId, number: masked(plan.phoneNumber), currentConnectionId: plan.currentConnectionId, holderTenantId: plan.holderTenantId, holderKeys: plan.holderKeys, assistantId: plan.assistantId, voiceMode: s2s.tenantIds.includes(plan.tenantId) ? "speech_to_speech" : "standard" };
      if (!apply) console.log(JSON.stringify({ mode: "dry_run", ...summary }));
      else { const result = await applyLabLine(deps, plan); console.log(JSON.stringify({ mode: "applied", ...summary, assistantId: result.assistantId, voiceMode: result.mode, cut: result.cut })); }
    }
  } catch (error) {
    console.error(JSON.stringify({ refused: error instanceof LabRefusal, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}
