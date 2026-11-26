import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { withTimeout } from "../application/retry.js";
import type { CallSummaryInput, CollectedCallFields, OutboxNotification } from "../domain/models.js";
import { NotificationHeldError, type NotificationPort } from "../ports.js";
import { brandOwnerSms, hasStopLanguage, withOwnerSmsCompliance } from "../domain/owner-sms.js";

const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal("function").optional(),
  function: z.object({ name: z.string(), arguments: z.string() }),
}).passthrough();

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "tool", "system", "developer"]),
  content: z.string().optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
}).passthrough();

const envelopeBaseSchema = z.object({
  data: z.object({
    record_type: z.string().optional(),
    event_type: z.string(),
    id: z.string(),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    payload: z.record(z.string(), z.unknown()),
  }).passthrough(),
}).passthrough();

const initializationSchema = z.object({
  data: z.object({
    event_type: z.literal("assistant.initialization"),
    id: z.string(),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    payload: z.object({
      telnyx_conversation_channel: z.string().optional(),
      telnyx_agent_target: z.string().optional(),
      telnyx_end_user_target: z.string().optional(),
      telnyx_end_user_target_verified: z.boolean().optional(),
      call_control_id: z.string(),
      assistant_id: z.string(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const conversationEndedSchema = z.object({
  data: z.object({
    event_type: z.literal("call.conversation.ended"),
    id: z.string(),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    payload: z.object({
      assistant_id: z.string(),
      call_control_id: z.string(),
      call_leg_id: z.string().optional(),
      call_session_id: z.string().optional(),
      conversation_id: z.string().optional(),
      duration_sec: z.number().int().nonnegative().optional(),
      reason: z.string().nullable().optional(),
      messages: z.array(messageSchema).default([]),
      from: z.string().optional(),
      to: z.string().optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const messageFinalizedSchema = z.object({
  data: z.object({
    event_type: z.literal("message.finalized"),
    id: z.string(),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    payload: z.object({
      id: z.string(),
      errors: z.array(z.object({ code: z.string().optional(), title: z.string().optional(), detail: z.string().optional() }).passthrough()).default([]),
      to: z.array(z.object({ phone_number: z.string(), status: z.string() }).passthrough()).min(1),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const messageReceivedSchema = z.object({
  data: z.object({
    event_type: z.literal("message.received"),
    id: z.string(),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    payload: z.object({
      autoresponse_type: z.string().nullable().optional(),
      from: z.object({ phone_number: z.string() }).passthrough(),
      to: z.array(z.object({ phone_number: z.string() }).passthrough()).default([]),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export type TelnyxEnvelope = z.infer<typeof envelopeBaseSchema>;
export type TelnyxInitializationEnvelope = z.infer<typeof initializationSchema>;

/**
 * Telnyx flag-mode call screening labels likely spam with call_screening_result ("spam_likely", or an
 * object whose reputation is spam_likely) and a "SPAM LIKELY" caller name. Telnyx does not document these
 * on assistant.initialization, so read them defensively: a hint for a faster intent check, never a hang-up.
 */
export function callerReputation(payload: Record<string, unknown>): "likely_spam" | "unknown" {
  const spam = (value: unknown) => typeof value === "string" && /spam[\s_-]*likely/i.test(value);
  const screening = payload.call_screening_result;
  if (spam(screening)) return "likely_spam";
  if (screening && typeof screening === "object" && !Array.isArray(screening)) {
    const result = screening as Record<string, unknown>;
    if (spam(result.reputation) || spam(result.result) || spam(result.status)) return "likely_spam";
  }
  for (const key of ["caller_id_name", "telnyx_end_user_target_name", "from_display_name", "caller_name"]) {
    if (spam(payload[key])) return "likely_spam";
  }
  return "unknown";
}
export type TelnyxConversationEndedEnvelope = z.infer<typeof conversationEndedSchema>;
export type TelnyxMessageFinalizedEnvelope = z.infer<typeof messageFinalizedSchema>;
export type TelnyxMessageReceivedEnvelope = z.infer<typeof messageReceivedSchema>;

export interface TelnyxTexmlCallback {
  callStatus: string | null;
  providerCallId: string | null;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyTelnyxWebhook(
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
  publicKey: string,
  now = Date.now(),
  replayWindowMs = 5 * 60_000,
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  const timestampMs = Number(timestamp) * 1_000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > replayWindowMs) return false;
  try {
    const rawKey = Buffer.from(publicKey, "base64");
    if (rawKey.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]), format: "der", type: "spki" });
    return verify(
      null,
      Buffer.from(`${timestamp}|${rawBody}`, "utf8"),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function parseTelnyxEnvelope(rawBody: string): TelnyxEnvelope {
  return envelopeBaseSchema.parse(JSON.parse(rawBody));
}

export function parseTelnyxTexmlCallback(rawBody: string): TelnyxTexmlCallback {
  const form = new URLSearchParams(rawBody);
  return {
    callStatus: form.get("CallStatus"),
    providerCallId: form.get("CallSid"),
  };
}

export function asTelnyxInitialization(envelope: TelnyxEnvelope): TelnyxInitializationEnvelope {
  return initializationSchema.parse(envelope);
}

export function asTelnyxConversationEnded(envelope: TelnyxEnvelope): TelnyxConversationEndedEnvelope {
  return conversationEndedSchema.parse(envelope);
}

export function asTelnyxMessageFinalized(envelope: TelnyxEnvelope): TelnyxMessageFinalizedEnvelope {
  return messageFinalizedSchema.parse(envelope);
}

export function asTelnyxMessageReceived(envelope: TelnyxEnvelope): TelnyxMessageReceivedEnvelope {
  return messageReceivedSchema.parse(envelope);
}

export function telnyxEventId(envelope: TelnyxEnvelope, rawBody: string): string {
  return envelope.data.id || createHash("sha256").update(envelope.data.event_type).update("\0").update(rawBody).digest("hex");
}

export function toTelnyxCallSummary(
  envelope: TelnyxConversationEndedEnvelope,
  rawBody: string,
  tenantId: string,
  receivedAt: Date,
  recordingUrl: string | null,
): CallSummaryInput {
  const payload = envelope.data.payload;
  const toolArguments = collectToolArguments(payload.messages);
  const read = (key: string): unknown => toolArguments[key];
  const text = (key: string): string | null => typeof read(key) === "string" && String(read(key)).trim() ? String(read(key)).trim() : null;
  const bool = (key: string): boolean => read(key) === true || read(key) === "true";
  const numeric = (key: string): number | undefined => typeof read(key) === "number" && Number.isFinite(read(key)) ? Number(read(key)) : undefined;
  const fields: CollectedCallFields = {
    callerName: text("caller_name"),
    companyName: text("company_name"),
    callbackNumber: text("callback_number") ?? payload.from ?? null,
    address: text("service_address") ?? text("address"),
    serviceCategory: text("service_category"),
    serviceCategoryConfidence: numeric("service_category_confidence") ?? 0,
    problemDescription: text("problem_description") ?? userTranscript(payload.messages),
    equipmentDetails: text("equipment_details"),
    accessNotes: text("access_notes"),
    requestedStart: text("requested_start") ?? text("slot_start"),
    explicitSlotConfirmation: bool("explicit_slot_confirmation") || bool("explicit_confirmation"),
    diagnosticFeeAccepted: bool("diagnostic_fee_accepted"),
    humanRequested: bool("human_requested") || toolArguments.__requested_human === true,
    confidence: numeric("confidence") ?? 0,
  };
  const endedAt = envelope.data.occurred_at ?? receivedAt.toISOString();
  const firstMessageAt = payload.messages.map((message) => message.timestamp).find(Boolean);
  const durationSeconds = payload.duration_sec ?? null;
  const startedAt = firstMessageAt ?? (durationSeconds === null
    ? endedAt
    : new Date(Date.parse(endedAt) - durationSeconds * 1_000).toISOString());
  const llmEmergencyScore = numeric("llm_score") ?? numeric("emergency_score");
  const llmEmergencyReason = text("llm_reason") ?? text("emergency_reason");
  return {
    webhookEventId: telnyxEventId(envelope, rawBody),
    tenantId,
    providerCallId: payload.call_control_id,
    fromNumber: payload.from ?? fields.callbackNumber ?? "unknown",
    startedAt,
    endedAt,
    durationSeconds,
    fields,
    transcript: readableTranscript(payload.messages),
    recordingUrl,
    consentState: bool("recording_disclosure_declined") ? "declined" : bool("recording_disclosure_given") ? "disclosed" : "unknown",
    ...(llmEmergencyScore === undefined ? {} : { llmEmergencyScore }),
    ...(llmEmergencyReason === null ? {} : { llmEmergencyReason }),
  };
}

export function toTelnyxTexmlCallSummary(
  rawBody: string,
  tenantId: string,
  receivedAt: Date,
  recordingUrl: string | null,
): CallSummaryInput {
  const form = new URLSearchParams(rawBody);
  const callStatus = form.get("CallStatus");
  const providerCallId = form.get("CallSid");
  if (callStatus !== "conversation_ended" || !providerCallId) {
    throw new Error("Not a Telnyx TeXML conversation-ended callback");
  }
  let messages: unknown;
  try {
    messages = JSON.parse(form.get("Messages") ?? "[]");
  } catch {
    throw new Error("Telnyx TeXML conversation history is invalid JSON");
  }
  const duration = form.get("DurationSec");
  const eventId = createHash("sha256").update("texml:conversation_ended\0").update(rawBody).digest("hex");
  const envelope = conversationEndedSchema.parse({
    data: {
      record_type: "event",
      event_type: "call.conversation.ended",
      id: eventId,
      occurred_at: receivedAt.toISOString(),
      payload: {
        assistant_id: "texml-callback",
        call_control_id: providerCallId,
        call_session_id: form.get("CallSessionId") ?? undefined,
        conversation_id: form.get("ConversationId") ?? undefined,
        duration_sec: duration && /^\d+$/.test(duration) ? Number(duration) : undefined,
        reason: form.get("Reason") || undefined,
        messages,
      },
    },
  });
  return toTelnyxCallSummary(envelope, rawBody, tenantId, receivedAt, recordingUrl);
}

function collectToolArguments(messages: TelnyxConversationEndedEnvelope["data"]["payload"]["messages"]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(toolCall.function.arguments);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const argumentsRecord = parsed as Record<string, unknown>;
      for (const [key, value] of Object.entries(argumentsRecord)) {
        if (value !== null && value !== "" && value !== undefined) merged[key] = value;
      }
      if (toolCall.function.name === "request_human") merged.__requested_human = true;
    }
  }
  return merged;
}

function readableTranscript(messages: TelnyxConversationEndedEnvelope["data"]["payload"]["messages"]): string | null {
  const lines = messages.flatMap((message) => {
    if (!message.content?.trim() || (message.role !== "user" && message.role !== "assistant")) return [];
    return [`${message.role === "user" ? "Caller" : "Otto"}: ${message.content.trim()}`];
  });
  return lines.length > 0 ? lines.join("\n") : null;
}

function userTranscript(messages: TelnyxConversationEndedEnvelope["data"]["payload"]["messages"]): string {
  return messages.filter((message) => message.role === "user" && message.content?.trim()).map((message) => message.content!.trim()).join(" ");
}

interface TelnyxSmsOptions {
  apiKey: string;
  fromNumber: string;
  founderFromNumber?: string;
  messagingProfileId?: string;
  resolveDestination: (tenantId: string, reference: string) => Promise<string | null>;
  allowedDirectDestinations?: ReadonlySet<string>;
  /**
   * Carrier approval for texting (TELNYX_MESSAGING_APPROVED). Until then nothing is sent, except in provider
   * test mode to the allowlisted test numbers (allowedDirectDestinations): every other text is held.
   */
  textingApproved: boolean;
  isOptedOut?: (tenantId: string, phone: string) => Promise<boolean>;
  /**
   * The owner's yes to texts is on file (owner_sms_consent). Owner texts (not texts to callers, not the founder's
   * note) are held without it, whatever the shop's config says: the one check every owner-text sender goes through.
   */
  hasOwnerTextConsent?: (tenantId: string) => Promise<boolean>;
  /** Claims a number's one-time "Reply STOP to opt out" line for this notification (see Store.claimSmsStopNotice). */
  claimStopNotice?: (phone: string, notificationId: string, firstAttempt: boolean) => Promise<boolean>;
  webhookUrl?: string;
  fetcher?: typeof fetch;
}

export class TelnyxSmsAdapter implements NotificationPort {
  constructor(private readonly options: TelnyxSmsOptions) {}

  async send(notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    if (notification.channel !== "sms") throw new Error("Telnyx SMS only sends SMS notifications");
    const direct = notification.destinationRef.startsWith("tel:") ? notification.destinationRef.slice(4) : null;
    if (direct && this.options.allowedDirectDestinations && !this.options.allowedDirectDestinations.has(direct)) {
      throw new Error("Direct SMS destination is not allowlisted in provider test mode");
    }
    const to = direct ?? await this.options.resolveDestination(notification.tenantId, notification.destinationRef);
    if (!to || !isAllowedUsNumber(to)) throw new Error(`No valid US phone number is configured for destination reference ${notification.destinationRef}`);
    if (!this.options.textingApproved && !this.options.allowedDirectDestinations?.has(to)) {
      throw new NotificationHeldError("Texting is not approved yet; text held, not sent");
    }
    if (!direct && notification.senderRef !== "founder" && this.options.hasOwnerTextConsent && !await this.options.hasOwnerTextConsent(notification.tenantId)) {
      throw new NotificationHeldError("Owner has not agreed to texts; text held, not sent");
    }
    if (await this.options.isOptedOut?.(notification.tenantId, to)) throw new Error("Destination has opted out of SMS");
    const from = notification.senderRef === "founder" ? this.options.founderFromNumber : this.options.fromNumber;
    if (!from) throw new Error("Founder welcome sender is not configured");
    // Owner texts (not texts to callers, not the founder's personal note) name Call Otto first, and the first
    // one a number ever gets ends with the STOP line. A text that already has STOP language does not use up the notice.
    let text = notification.body;
    if (!direct && notification.senderRef !== "founder") {
      const branded = brandOwnerSms(notification.body);
      const stopNotice = !hasStopLanguage(branded) && this.options.claimStopNotice ? await this.options.claimStopNotice(to, notification.id, notification.attempts <= 1) : false;
      text = withOwnerSmsCompliance(branded, stopNotice);
    }
    const body = {
      from,
      to,
      text,
      ...(this.options.messagingProfileId ? { messaging_profile_id: this.options.messagingProfileId } : {}),
      ...(this.options.webhookUrl ? { webhook_url: this.options.webhookUrl } : {}),
    };
    const response = await withTimeout((this.options.fetcher ?? fetch)("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": notification.id,
      },
      body: JSON.stringify(body),
    }), 4_000);
    const payload = await response.json().catch(() => ({})) as { data?: { id?: string }; errors?: Array<{ detail?: string }> };
    const receipt = payload.data?.id;
    if (!response.ok || !receipt) {
      const detail = payload.errors?.[0]?.detail;
      throw new Error(`Telnyx SMS failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return { providerReceipt: receipt };
  }
}

interface TelnyxVoiceRoutingOptions {
  apiKey: string;
  phoneNumber: string;
  assistantId: string;
  /** Shared grace-period voicemail TeXML app. A number pointed at it is still ours to reconnect or pause. */
  voicemailConnectionId?: string | undefined;
  fetcher?: typeof fetch;
}

export class TelnyxVoiceRoutingClient {
  constructor(private readonly options: TelnyxVoiceRoutingOptions) {}

  async setPaused(paused: boolean): Promise<{ changed: boolean; numberId: string }> {
    const assistantConnectionId = await this.assistantConnectionId();
    return this.assignConnection(paused ? null : assistantConnectionId, assistantConnectionId);
  }

  /** Point the number at the shared voicemail TeXML app (billing grace line) instead of disconnecting it. */
  async setVoicemail(): Promise<{ changed: boolean; numberId: string }> {
    if (!this.options.voicemailConnectionId) throw new Error("No voicemail TeXML application is configured");
    const assistantConnectionId = await this.assistantConnectionId();
    return this.assignConnection(this.options.voicemailConnectionId, assistantConnectionId);
  }

  private async assistantConnectionId(): Promise<string> {
    const assistant = await this.request<Record<string, unknown>>(`/ai/assistants/${encodeURIComponent(this.options.assistantId)}`);
    const assistantData = objectData(assistant);
    const telephony = objectData(assistantData.telephony_settings);
    const assistantConnectionId = typeof telephony.default_texml_app_id === "string" ? telephony.default_texml_app_id : null;
    if (!assistantConnectionId) throw new Error("Telnyx assistant has no default TeXML application");
    return assistantConnectionId;
  }

  private async assignConnection(desiredConnectionId: string | null, assistantConnectionId: string): Promise<{ changed: boolean; numberId: string }> {
    const url = new URL("https://api.telnyx.com/v2/phone_numbers");
    url.searchParams.set("filter[phone_number]", this.options.phoneNumber);
    const response = await this.request<{ data?: Array<Record<string, unknown>> }>(url.toString(), undefined, true);
    const number = response.data?.find((candidate) => candidate.phone_number === this.options.phoneNumber) ?? response.data?.[0];
    const numberId = typeof number?.id === "string" ? number.id : null;
    if (!numberId) throw new Error("Telnyx phone number was not found");
    const currentConnectionId = connectionOf(number?.connection_id);
    if (currentConnectionId === desiredConnectionId) return { changed: false, numberId };
    const ours = new Set([assistantConnectionId, this.options.voicemailConnectionId].filter(Boolean));
    if (currentConnectionId && !ours.has(currentConnectionId)) {
      throw new Error("Telnyx phone number is assigned to an unexpected voice connection");
    }

    const updated = await this.request<Record<string, unknown>>(`/phone_numbers/${encodeURIComponent(numberId)}`, {
      method: "PATCH",
      body: JSON.stringify({ connection_id: desiredConnectionId }),
    });
    if (connectionOf(objectData(updated).connection_id) !== desiredConnectionId) {
      throw new Error("Telnyx did not persist the requested voice-routing state");
    }
    return { changed: true, numberId };
  }

  private async request<T>(path: string, init?: RequestInit, absolute = false): Promise<T> {
    const target = absolute ? path : `https://api.telnyx.com/v2${path}`;
    const response = await withTimeout((this.options.fetcher ?? fetch)(target, {
      ...init,
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", ...init?.headers },
    }), 5_000);
    const payload = await response.json().catch(() => ({})) as T & { errors?: Array<{ detail?: string }> };
    if (!response.ok) throw new Error(`Telnyx routing request failed with HTTP ${response.status}${payload.errors?.[0]?.detail ? `: ${payload.errors[0].detail}` : ""}`);
    return payload;
  }
}

/** Telnyx reports a number with no voice connection as "" (not null). */
function connectionOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function objectData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  return object.data && typeof object.data === "object" && !Array.isArray(object.data)
    ? object.data as Record<string, unknown>
    : object;
}

function isAllowedUsNumber(value: string): boolean {
  const match = /^\+1([2-9]\d{2})[2-9]\d{6}$/.exec(value);
  return Boolean(match && match[1] !== "900");
}

export class TelnyxRecordingClient {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  async getDownloadUrl(callControlId: string): Promise<string | null> {
    const url = new URL("https://api.telnyx.com/v2/recordings");
    url.searchParams.set("filter[call_control_id]", callControlId);
    url.searchParams.set("page[size]", "1");
    const response = await withTimeout(this.fetcher(url, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    }), 4_000);
    const payload = await response.json().catch(() => ({})) as {
      data?: Array<{ download_urls?: { mp3?: string; wav?: string } }>;
      errors?: Array<{ detail?: string }>;
    };
    if (!response.ok) throw new Error(`Telnyx recordings lookup failed with HTTP ${response.status}${payload.errors?.[0]?.detail ? `: ${payload.errors[0].detail}` : ""}`);
    const candidate = payload.data?.[0]?.download_urls?.mp3 ?? payload.data?.[0]?.download_urls?.wav;
    return candidate && /^https:\/\//i.test(candidate) ? candidate : null;
  }

  async deleteForCall(callControlId: string): Promise<void> {
    const url = new URL("https://api.telnyx.com/v2/recordings");
    url.searchParams.set("filter[call_control_id]", callControlId);
    url.searchParams.set("page[size]", "100");
    const response = await withTimeout(this.fetcher(url, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    }), 4_000);
    const payload = await response.json().catch(() => ({})) as { data?: Array<{ id?: string }> };
    if (!response.ok) throw new Error(`Telnyx recordings lookup failed with HTTP ${response.status}`);
    for (const record of payload.data ?? []) {
      if (!record.id) continue;
      const deletion = await withTimeout(this.fetcher(`https://api.telnyx.com/v2/recordings/${encodeURIComponent(record.id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.apiKey}` },
      }), 4_000);
      if (deletion.status !== 404 && !deletion.ok) throw new Error(`Telnyx recording delete failed with HTTP ${deletion.status}`);
    }
  }
}

/** Telnyx errors that mean the call or its assistant is gone, so a message can never land. */
const CALL_GONE_CODES = new Set(["90015", "90018"]);

/**
 * Adds messages to the AI assistant running on a live call (Telnyx "Add messages to AI Assistant").
 * `command_id` makes a repeat of the same command a no-op on Telnyx's side.
 */
export class TelnyxAssistantMessenger {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  /**
   * "sent" when Telnyx accepted it, "call_ended" when the call is already over, "rejected" for any other 4xx that a
   * retry cannot fix (say the assistant already left after a transfer). Throws on 408, 429, 5xx and network errors.
   */
  async addSystemMessage(callControlId: string, content: string, commandId: string, options: { triggerResponse?: boolean } = {}): Promise<"sent" | "call_ended" | "rejected"> {
    const response = await withTimeout(this.fetcher(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/ai_assistant_add_messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      // trigger_response false (the default): the message applies on the assistant's next natural turn, so it never talks
      // over the caller. true starts a turn now, which may interrupt them.
      body: JSON.stringify({ messages: [{ role: "system", content }], command_id: commandId, trigger_response: options.triggerResponse === true }),
    }), 4_000);
    if (response.ok) return "sent";
    const payload = await response.json().catch(() => ({})) as { errors?: Array<{ code?: unknown }> };
    if (response.status === 404 || payload.errors?.some((error) => CALL_GONE_CODES.has(String(error.code)))) return "call_ended";
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) return "rejected";
    throw new Error(`Telnyx add-messages failed with HTTP ${response.status}${payload.errors?.[0]?.code ? ` (code ${String(payload.errors[0].code)})` : ""}`);
  }
}
