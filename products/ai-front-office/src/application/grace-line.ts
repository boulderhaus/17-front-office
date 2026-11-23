import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { formatEmailBody } from "../adapters/resend.js";
import { TelnyxProvisioner } from "../adapters/telnyx-provisioning.js";
import { TelnyxVoiceRoutingClient } from "../adapters/telnyx.js";
import type { Environment } from "../config/environment.js";
import { forwardingOffInstruction, type CarrierInfo } from "../domain/forwarding.js";
import type { OutboxNotification } from "../domain/models.js";
import type { Clock, Store } from "../ports.js";
import { redactError } from "./retry.js";

/**
 * Billing grace line. When a shop's subscription lapses we keep its Front Office number answering
 * with a voicemail (callers forwarded from the business phone never hit a dead line), text the
 * owner each message, remind them on day 23, and release the number on day 30.
 */
export const GRACE_DAYS = 30;
export const GRACE_REMINDER_DAY = 23;
const DAY_MS = 24 * 60 * 60_000;
export const GRACE_PROVIDER = "billing";
export const GRACE_STARTED_KEY = "grace_started_at";
/** How long a "no transcript" voicemail alert waits for the transcript before it goes out anyway. */
export const VOICEMAIL_FALLBACK_DELAY_MS = 3 * 60_000;

export interface GraceContext {
  store: Store;
  env: Environment;
  clock: Clock;
  fetcher?: typeof fetch | undefined;
  log: (entry: Record<string, unknown>) => void;
}

export async function graceStartedAt(store: Store, tenantId: string): Promise<string | null> {
  return store.getIntegrationSecret(tenantId, GRACE_PROVIDER, GRACE_STARTED_KEY);
}

/** End grace and withdraw a day-23 reminder that has not gone out yet. */
export async function clearGrace(store: Store, tenantId: string): Promise<void> {
  const startedAt = await graceStartedAt(store, tenantId);
  if (!startedAt) return;
  const config = await store.getConfig(tenantId).catch(() => null);
  const base = `grace-reminder:${tenantId}:${startedAt}`;
  for (const key of [...(config?.ownerNotificationRefs ?? []).map((reference) => `${base}:${reference}`), `${base}:email`]) {
    await store.cancelPendingNotification(key);
  }
  await store.deleteIntegrationSecret(tenantId, GRACE_PROVIDER, GRACE_STARTED_KEY);
}

export async function offInstruction(store: Store, tenantId: string): Promise<string> {
  const carrierJson = await store.getIntegrationSecret(tenantId, "forwarding", "carrier");
  let carrier: CarrierInfo | null = null;
  try { carrier = carrierJson ? JSON.parse(carrierJson) as CarrierInfo : null; } catch { carrier = null; }
  return forwardingOffInstruction(carrier?.family ?? null);
}

export function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/**
 * Numbers and assistants we bought for a shop go back to Telnyx. True only when nothing of ours is
 * left at Telnyx; false (logged) when the release failed or cannot run, so the grace sweep retries.
 */
export async function releaseProvisionedLine(context: GraceContext, tenantId: string): Promise<boolean> {
  const { store, env } = context;
  const [assistantId, inbound, pending] = await Promise.all([
    store.getIntegrationSecret(tenantId, "telnyx", "provisioned_assistant_id"),
    store.getIntegrationSecret(tenantId, "telnyx", "inbound_number"),
    store.getIntegrationSecret(tenantId, "telnyx", "pending_number"),
  ]);
  if (!assistantId) return true; // not a line we provisioned: nothing of ours to give back
  const phoneNumber = inbound ?? pending;
  if (!env.TELNYX_API_KEY) {
    context.log({ level: "error", event: "line_release_blocked", tenantId, reason: "TELNYX_API_KEY is not set" });
    return false;
  }
  try {
    await new TelnyxProvisioner({
      apiKey: env.TELNYX_API_KEY,
      templateAssistantId: env.TELNYX_TEMPLATE_ASSISTANT_ID ?? env.TELNYX_ASSISTANT_ID ?? "",
      messagingProfileId: env.TELNYX_MESSAGING_PROFILE_ID ?? "",
      ...(context.fetcher ? { fetcher: context.fetcher } : {}),
      campaignId: env.TELNYX_CAMPAIGN_ID,
    }).release({ phoneNumber, assistantId });
    return true;
  } catch (error) {
    context.log({ level: "error", event: "line_release_failed", tenantId, phoneNumber, assistantId, error: redactError(error) });
    return false;
  }
}

/**
 * Queue one owner message: SMS to every owner number that can receive it, or email to the owner
 * when no SMS can be delivered. Idempotent per `idempotencyBase`.
 */
export async function queueOwnerMessage(context: GraceContext, input: {
  tenantId: string;
  sms: string;
  emailSubject: string;
  emailText?: string;
  idempotencyBase: string;
  priority?: OutboxNotification["priority"];
  sendAfter?: Date;
}): Promise<{ channel: "sms" | "email" | null; queued: number; idempotencyKeys: string[] }> {
  const { store, env } = context;
  const now = context.clock.now().toISOString();
  const nextAttemptAt = (input.sendAfter ?? context.clock.now()).toISOString();
  const base = (channel: "sms" | "email", destinationRef: string, body: string, idempotencyKey: string): OutboxNotification => ({
    id: randomUUID(), tenantId: input.tenantId, callId: null, channel, destinationRef, body,
    priority: input.priority ?? "high", state: "pending", attempts: 0, nextAttemptAt,
    idempotencyKey, providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
  });
  const config = await store.getConfig(input.tenantId);
  const smsConfigured = Boolean(env.TELNYX_API_KEY && env.TELNYX_FROM_NUMBER && env.TELNYX_MESSAGING_PROFILE_ID) || env.DEMO_MODE;
  const smsRefs: string[] = [];
  if (smsConfigured) {
    for (const reference of config.ownerNotificationRefs) {
      const phone = await store.getIntegrationSecret(input.tenantId, "notifications", reference);
      if (phone && !await store.isSmsOptedOut(input.tenantId, phone)) smsRefs.push(reference);
    }
  }
  if (smsRefs.length > 0) {
    const keys = smsRefs.map((reference) => `${input.idempotencyBase}:${reference}`);
    let queued = 0;
    for (const [index, reference] of smsRefs.entries()) {
      if (await store.enqueueNotification(base("sms", reference, input.sms, keys[index]!))) queued += 1;
    }
    return { channel: "sms", queued, idempotencyKeys: keys };
  }
  const account = await store.getOwnerAccountByTenant(input.tenantId);
  if (account && env.RESEND_API_KEY && env.RESEND_FROM_EMAIL) {
    const key = `${input.idempotencyBase}:email`;
    const queued = await store.enqueueNotification(base("email", `email:${account.email}`, formatEmailBody(input.emailSubject, input.emailText ?? input.sms), key));
    return { channel: "email", queued: queued ? 1 : 0, idempotencyKeys: [key] };
  }
  context.log({ level: "error", event: "owner_message_undeliverable", tenantId: input.tenantId, idempotencyBase: input.idempotencyBase });
  return { channel: null, queued: 0, idempotencyKeys: [] };
}

// ---------------------------------------------------------------------------------------------
// Voicemail TeXML

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!);
}

export function voicemailToken(secret: string, tenantId: string, callSid: string): string {
  return createHmac("sha256", secret).update(`front-office-voicemail\0${tenantId}\0${callSid}`).digest("base64url");
}

export function voicemailTokenMatches(secret: string, tenantId: string, callSid: string, supplied: string | null): boolean {
  if (!supplied) return false;
  const expected = Buffer.from(voicemailToken(secret, tenantId, callSid));
  const given = Buffer.from(supplied);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function renderVoicemailTexml(input: { businessName: string; publicBaseUrl: string; tenantId: string; callSid: string; token: string }): string {
  const base = input.publicBaseUrl.replace(/\/$/, "");
  const query = `t=${encodeURIComponent(input.tenantId)}&amp;s=${encodeURIComponent(input.token)}`;
  const greeting = `You've reached ${input.businessName}. We can't get to the phone right now. Please leave your name, number and what you need after the tone, and we'll call you back.`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    `<Say>${escapeXml(greeting)}</Say>`,
    `<Record action="${base}/texml/voicemail/done" method="POST" maxLength="120" playBeep="true" finishOnKey="#" trim="trim-silence"`
      + ` recordingStatusCallback="${base}/texml/voicemail/recording?${query}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"`
      + ` transcription="true" transcriptionCallback="${base}/texml/voicemail/transcription?${query}"/>`,
    `<Hangup/>`,
    `</Response>`,
  ].join("\n");
}

export function renderHangupTexml(message: string | null): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    ...(message ? [`<Say>${escapeXml(message)}</Say>`] : []),
    `<Hangup/>`,
    `</Response>`,
  ].join("\n");
}

export function describeCaller(from: string | null): string {
  const match = from ? /^\+1(\d{3})(\d{3})(\d{4})$/.exec(from) : null;
  if (match) return `(${match[1]}) ${match[2]}-${match[3]}`;
  return from && /^\+[1-9]\d{7,14}$/.test(from) ? from : "A caller";
}

export function transcriptSnippet(text: string, limit = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------------------------
// Grace sweep: day-23 reminder, day-30 release. Safe to run on every replica.

export class GraceLineService {
  constructor(private readonly context: GraceContext) {}

  async runOnce(): Promise<{ reminded: number; released: number }> {
    let reminded = 0;
    let released = 0;
    for (const tenantId of await this.context.store.listTenantIds()) {
      const seen = await graceStartedAt(this.context.store, tenantId);
      if (!seen) continue;
      try {
        const outcome = await this.context.store.withLock(`billing:${tenantId}`, () => this.advance(tenantId, seen));
        if (outcome === "reminded") reminded += 1;
        if (outcome === "released") released += 1;
      } catch (error) {
        this.context.log({ level: "error", event: "grace_sweep_failed", tenantId, error: redactError(error) });
      }
    }
    return { reminded, released };
  }

  private async advance(tenantId: string, seen: string): Promise<"reminded" | "released" | null> {
    const { store, clock, log } = this.context;
    const startedAt = await graceStartedAt(store, tenantId);
    if (startedAt !== seen) return null; // finished by another replica, ended by payment, or restarted
    const [subscription, account] = await Promise.all([store.getSubscription(tenantId), store.getOwnerAccountByTenant(tenantId)]);
    if (subscription?.status === "active" || !account) {
      await clearGrace(store, tenantId);
      return null;
    }
    const elapsed = clock.now().getTime() - Date.parse(startedAt);
    if (!Number.isFinite(elapsed)) {
      await clearGrace(store, tenantId);
      return null;
    }
    if (elapsed >= GRACE_DAYS * DAY_MS) {
      // Last look before anything irreversible: payment may have landed while this sweep waited for the lock.
      const [stillStarted, latest] = await Promise.all([graceStartedAt(store, tenantId), store.getSubscription(tenantId)]);
      if (stillStarted !== startedAt || latest?.status === "active") return null;
      if (!await this.disconnectUnownedNumber(tenantId)) return null; // retried next sweep
      if (!await releaseProvisionedLine(this.context, tenantId)) return null; // retried next sweep
      await Promise.all(["inbound_number", "pending_number", "provisioned_assistant_id"].map((key) => store.deleteIntegrationSecret(tenantId, "telnyx", key)));
      await store.withLock(`config:${tenantId}`, async () => {
        const current = await store.getConfig(tenantId);
        await store.saveConfig({ ...current, paused: true, pausedForBilling: false });
      });
      // The number is gone: paying again means going live again with a new number.
      await store.updateOwnerAccountStatus(account.id, "pending_activation", clock.now().toISOString());
      await clearGrace(store, tenantId);
      log({ level: "warn", event: "grace_line_released", tenantId });
      return "released";
    }
    if (elapsed >= GRACE_REMINDER_DAY * DAY_MS) {
      const config = await store.getConfig(tenantId);
      const off = await offInstruction(store, tenantId);
      const daysLeft = Math.max(1, Math.ceil((GRACE_DAYS * DAY_MS - elapsed) / DAY_MS));
      const result = await queueOwnerMessage(this.context, {
        tenantId,
        sms: `Front Office for ${config.businessName}: in ${daysLeft} days this number stops working and forwarded calls will hit a dead line. Update billing in your dashboard to keep it, or ${lowerFirst(off)}`,
        emailSubject: `Your Front Office number stops working in ${daysLeft} days`,
        idempotencyBase: `grace-reminder:${tenantId}:${startedAt}`,
      });
      if (result.queued > 0) {
        log({ level: "info", event: "grace_reminder_queued", tenantId, channel: result.channel });
        return "reminded";
      }
    }
    return null;
  }

  /** A number we did not buy is never deleted, but it must stop answering with this shop's voicemail. */
  private async disconnectUnownedNumber(tenantId: string): Promise<boolean> {
    const { store, env, log } = this.context;
    const [assistantId, inbound] = await Promise.all([
      store.getIntegrationSecret(tenantId, "telnyx", "provisioned_assistant_id"),
      store.getIntegrationSecret(tenantId, "telnyx", "inbound_number"),
    ]);
    if (assistantId || !inbound) return true; // ours (deleted by the release) or nothing to move
    const route = await store.getProviderRouteForTenant("telnyx", tenantId);
    if (!env.TELNYX_API_KEY || !route) {
      log({ level: "error", event: "grace_disconnect_blocked", tenantId, reason: env.TELNYX_API_KEY ? "no assistant route" : "TELNYX_API_KEY is not set" });
      return false;
    }
    try {
      await new TelnyxVoiceRoutingClient({
        apiKey: env.TELNYX_API_KEY, phoneNumber: inbound, assistantId: route.externalId,
        voicemailConnectionId: env.TELNYX_VOICEMAIL_APP_ID,
        ...(this.context.fetcher ? { fetcher: this.context.fetcher } : {}),
      }).setPaused(true);
      return true;
    } catch (error) {
      log({ level: "error", event: "grace_disconnect_failed", tenantId, error: redactError(error) });
      return false;
    }
  }
}
