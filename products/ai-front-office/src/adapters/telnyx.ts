import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { withTimeout } from "../application/retry.js";
import type { CallSummaryInput, CollectedCallFields, OutboxNotification } from "../domain/models.js";
import type { NotificationPort } from "../ports.js";

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

export type TelnyxEnvelope = z.infer<typeof envelopeBaseSchema>;
export type TelnyxInitializationEnvelope = z.infer<typeof initializationSchema>;
export type TelnyxConversationEndedEnvelope = z.infer<typeof conversationEndedSchema>;

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

export function asTelnyxInitialization(envelope: TelnyxEnvelope): TelnyxInitializationEnvelope {
  return initializationSchema.parse(envelope);
}

export function asTelnyxConversationEnded(envelope: TelnyxEnvelope): TelnyxConversationEndedEnvelope {
  return conversationEndedSchema.parse(envelope);
}

export function telnyxEventId(envelope: TelnyxEnvelope, rawBody: string): string {
  return envelope.data.id || createHash("sha256").update(envelope.data.event_type).update("\0").update(rawBody).digest("hex");
}

export function toTelnyxCallSummary(
  envelope: TelnyxConversationEndedEnvelope,
  rawBody: string,
  tenantId: string,
  receivedAt: Date,
  recordingUrl: string,
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
    consentState: bool("recording_disclosure_given") ? "disclosed" : "unknown",
    ...(llmEmergencyScore === undefined ? {} : { llmEmergencyScore }),
    ...(llmEmergencyReason === null ? {} : { llmEmergencyReason }),
  };
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
    return [`${message.role === "user" ? "Caller" : "AI assistant"}: ${message.content.trim()}`];
  });
  return lines.length > 0 ? lines.join("\n") : null;
}

function userTranscript(messages: TelnyxConversationEndedEnvelope["data"]["payload"]["messages"]): string {
  return messages.filter((message) => message.role === "user" && message.content?.trim()).map((message) => message.content!.trim()).join(" ");
}

interface TelnyxSmsOptions {
  apiKey: string;
  fromNumber: string;
  messagingProfileId?: string;
  resolveDestination: (reference: string) => Promise<string | null>;
  fetcher?: typeof fetch;
}

export class TelnyxSmsAdapter implements NotificationPort {
  constructor(private readonly options: TelnyxSmsOptions) {}

  async send(notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    const direct = notification.destinationRef.startsWith("tel:") ? notification.destinationRef.slice(4) : null;
    const to = direct ?? await this.options.resolveDestination(notification.destinationRef);
    if (!to || !/^\+[1-9]\d{7,14}$/.test(to)) throw new Error(`No valid E.164 phone number is configured for destination reference ${notification.destinationRef}`);
    const body = {
      from: this.options.fromNumber,
      to,
      text: notification.body,
      ...(this.options.messagingProfileId ? { messaging_profile_id: this.options.messagingProfileId } : {}),
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
}
