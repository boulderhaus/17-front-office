import { createHash } from "node:crypto";
import { Retell } from "retell-sdk";
import { z } from "zod";
import type { CallSummaryInput, CollectedCallFields } from "../domain/models.js";

const retellEnvelopeSchema = z.object({
  event: z.string(),
  call: z.object({
    call_id: z.string(),
    from_number: z.string().optional(),
    start_timestamp: z.number().optional(),
    end_timestamp: z.number().optional(),
    duration_ms: z.number().optional(),
    transcript: z.string().optional(),
    recording_url: z.string().url().optional(),
    call_analysis: z.object({ custom_analysis_data: z.record(z.string(), z.unknown()).optional() }).passthrough().optional(),
    retell_llm_dynamic_variables: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  event_id: z.string().optional(),
}).passthrough();

export type RetellEnvelope = z.infer<typeof retellEnvelopeSchema>;

export async function verifyRetellWebhook(rawBody: string, apiKey: string, signature: string | undefined): Promise<boolean> {
  if (!signature) return false;
  return Retell.verify(rawBody, apiKey, signature);
}

export function parseRetellEnvelope(rawBody: string): RetellEnvelope {
  return retellEnvelopeSchema.parse(JSON.parse(rawBody));
}

export function retellEventId(envelope: RetellEnvelope, rawBody: string): string {
  return envelope.event_id ?? createHash("sha256").update(envelope.event).update("\0").update(envelope.call.call_id).update("\0").update(rawBody).digest("hex");
}

export function toCallSummary(envelope: RetellEnvelope, rawBody: string, tenantId: string, receivedAt: Date): CallSummaryInput {
  const call = envelope.call;
  const analysis = call.call_analysis?.custom_analysis_data ?? {};
  const dynamic = call.retell_llm_dynamic_variables ?? {};
  const read = (key: string): unknown => analysis[key] ?? dynamic[key];
  const text = (key: string): string | null => typeof read(key) === "string" && String(read(key)).trim() !== "" ? String(read(key)).trim() : null;
  const bool = (key: string): boolean => read(key) === true || read(key) === "true";
  const numeric = (key: string): number | undefined => typeof read(key) === "number" ? Number(read(key)) : undefined;
  const fields: CollectedCallFields = {
    callerName: text("caller_name"),
    companyName: text("company_name"),
    callbackNumber: text("callback_number") ?? call.from_number ?? null,
    address: text("service_address"),
    serviceCategory: text("service_category"),
    serviceCategoryConfidence: numeric("service_category_confidence") ?? 0,
    problemDescription: text("problem_description") ?? call.transcript ?? "",
    equipmentDetails: text("equipment_details"),
    accessNotes: text("access_notes"),
    requestedStart: text("requested_start"),
    explicitSlotConfirmation: bool("explicit_slot_confirmation"),
    diagnosticFeeAccepted: bool("diagnostic_fee_accepted"),
    humanRequested: bool("human_requested"),
    confidence: numeric("confidence") ?? 0,
  };
  const startedAt = call.start_timestamp ? new Date(call.start_timestamp).toISOString() : receivedAt.toISOString();
  const endedAt = call.end_timestamp ? new Date(call.end_timestamp).toISOString() : receivedAt.toISOString();
  const llmEmergencyScore = numeric("emergency_score");
  const llmEmergencyReason = text("emergency_reason");
  const isSpam = bool("is_spam") || bool("spam");
  return {
    webhookEventId: retellEventId(envelope, rawBody),
    tenantId,
    providerCallId: call.call_id,
    fromNumber: call.from_number ?? fields.callbackNumber ?? "unknown",
    startedAt,
    endedAt,
    durationSeconds: call.duration_ms === undefined ? null : Math.round(call.duration_ms / 1_000),
    fields,
    transcript: call.transcript ?? null,
    recordingUrl: call.recording_url ?? null,
    consentState: bool("recording_disclosure_given") ? "disclosed" : "unknown",
    ...(llmEmergencyScore === undefined ? {} : { llmEmergencyScore }),
    ...(llmEmergencyReason === null ? {} : { llmEmergencyReason }),
    ...(isSpam ? { isSpam: true } : {}),
  };
}
