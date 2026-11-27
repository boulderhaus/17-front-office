import type { Environment } from "../config/environment.js";
import type { BusinessConfig } from "../domain/models.js";
import { buildTelnyxAssistantUpdate } from "./system-prompt.js";

/**
 * Speech-to-speech voice (Telnyx AI Assistants speech-to-speech mode), as the default for every shop or for chosen shops.
 *
 * A speech-to-speech model hears and speaks audio itself, so it can laugh, backchannel and overlap like a person.
 * It never calls tools: Telnyx "delegation" hands each lookup or action to a backend text model that runs the
 * assistant's own tools (webhooks, transfer, hangup) and the speaking model says the result.
 *
 * Who gets it:
 * - TELNYX_VOICE_MODE=speech_to_speech: every tenant, the demo line and the "Call me now" setup helper included,
 *   except tenants in TELNYX_STANDARD_TENANT_IDS. A tenant that can't be speech-to-speech (model or voice unset, no
 *   backend text model, instructions over the limit) quietly gets the standard payload and the result names why
 *   (fallback); nothing throws for that reason. The same when Telnyx itself refuses the speech-to-speech payload
 *   (a 4xx to the create or the update): the shop is made or saved on the standard payload instead
 *   (fallback "provider_rejected").
 * - TELNYX_VOICE_MODE=standard (the default): only tenants in TELNYX_S2S_TENANT_IDS, never the demo line. A listed
 *   tenant that can't be configured throws (VoiceModeError), in either mode.
 * Every other tenant gets buildTelnyxAssistantUpdate's payload unchanged.
 *
 * Rollback: set TELNYX_VOICE_MODE=standard (or add the tenant to TELNYX_STANDARD_TENANT_IDS) and run
 * scripts/configure-telnyx.ts --apply; the push for an assistant still in speech-to-speech mode adds back its text
 * model and turns delegation off (rollbackFields).
 */

/**
 * Extra words for the delegation backend only (the text model that runs the tools on a speech-to-speech call). Real
 * calls showed it skipping triage_call now and then; the server triages every intake anyway (call-service.ts), and
 * this keeps the live alert early.
 */
export const BACKEND_TOOL_REMINDER = "You run the tools for a live phone call. The moment the caller has said what the problem is, call triage_call before anything else, every call, even when it sounds routine. Call save_intake as soon as you have the name and the problem, again whenever a detail changes, and once more before the call ends. Never skip a tool the instructions call for.";

/**
 * Telnyx: its hosted speech-to-speech model reads about 2,500 tokens (~10,000 characters) of instructions; longer ones are
 * accepted but the middle is dropped. Kept under that so the safety and booking rules are always read.
 */
export const S2S_INSTRUCTION_LIMIT_CHARS = 10_000;

export type DefaultVoiceMode = "standard" | "speech_to_speech";

export interface SpeechToSpeechSettings {
  /** TELNYX_S2S_TENANT_IDS: tenants explicitly put on speech-to-speech (strict: a problem throws). */
  tenantIds: readonly string[];
  model?: string | undefined;
  voice?: string | undefined;
  backendModel?: string | undefined;
  /** TELNYX_VOICE_MODE. Unset or "standard": only the listed tenants are speech-to-speech. */
  defaultMode?: DefaultVoiceMode | undefined;
  /** TELNYX_STANDARD_TENANT_IDS: tenants that keep the standard voice whatever else is set. */
  standardTenantIds?: readonly string[] | undefined;
  /** The demo line's tenant (DEFAULT_TENANT_ID): the opt-in list never applies to it, the default mode does. */
  demoTenantId?: string | undefined;
}

/**
 * Why a tenant that the default would make speech-to-speech got the standard payload instead. "provider_rejected":
 * Telnyx answered the speech-to-speech payload itself with a refusal (isPayloadRejection), so the standard one was sent.
 */
export type VoiceFallback = "s2s_model_not_set" | "s2s_voice_not_set" | "no_backend_model" | "backend_model_is_s2s_model" | "instructions_too_long" | "provider_rejected";

export type VoiceMode =
  | { kind: "standard"; fallback?: VoiceFallback }
  | { kind: "speech_to_speech"; model: string; voice: string; backendModel: string };

export class VoiceModeError extends Error {}

export function speechToSpeechSettings(env: Pick<Environment, "TELNYX_S2S_TENANT_IDS" | "TELNYX_S2S_MODEL" | "TELNYX_S2S_VOICE" | "TELNYX_S2S_BACKEND_MODEL"> & Partial<Pick<Environment, "TELNYX_VOICE_MODE" | "TELNYX_STANDARD_TENANT_IDS" | "DEFAULT_TENANT_ID">>): SpeechToSpeechSettings {
  return {
    tenantIds: env.TELNYX_S2S_TENANT_IDS ?? [], model: env.TELNYX_S2S_MODEL, voice: env.TELNYX_S2S_VOICE, backendModel: env.TELNYX_S2S_BACKEND_MODEL,
    defaultMode: env.TELNYX_VOICE_MODE ?? "standard", standardTenantIds: env.TELNYX_STANDARD_TENANT_IDS ?? [], demoTenantId: env.DEFAULT_TENANT_ID,
  };
}

/**
 * What a tenant is asked to sound like, before checking that it can. The opt-out list always wins. A tenant on the
 * opt-in list is strict (a problem throws); one that is speech-to-speech only because of the default falls back.
 */
export function voiceRequest(settings: SpeechToSpeechSettings | undefined, tenantId: string): { want: VoiceMode["kind"]; strict: boolean } {
  if (!settings || settings.standardTenantIds?.includes(tenantId)) return { want: "standard", strict: false };
  if (tenantId !== settings.demoTenantId && settings.tenantIds.includes(tenantId)) return { want: "speech_to_speech", strict: true };
  if (settings.defaultMode === "speech_to_speech") return { want: "speech_to_speech", strict: false };
  return { want: "standard", strict: false };
}

/** True when the tenant is asked to be speech-to-speech: on the opt-in list, or by the default and not opted out. */
export function isSpeechToSpeechTenant(settings: SpeechToSpeechSettings | undefined, tenantId: string): boolean {
  return voiceRequest(settings, tenantId).want === "speech_to_speech";
}

/** True when anything speech-to-speech is set up here, so an assistant may be in that mode and need its text model back. */
export function speechToSpeechConfigured(settings: SpeechToSpeechSettings | undefined): boolean {
  return Boolean(settings && (settings.defaultMode === "speech_to_speech" || settings.tenantIds.length > 0 || settings.model));
}

/** True when Telnyx reports the assistant in speech-to-speech mode (delegation on). Standard assistants report delegation_settings null. */
export function isSpeechToSpeechAssistant(assistant: Record<string, unknown> | null | undefined): boolean {
  const delegation = objectOf(unwrap(assistant).delegation_settings);
  return delegation.enabled === true;
}

/** The text model the assistant runs on today: its delegation backend in speech-to-speech mode, else its own model. */
export function currentTextModel(assistant: Record<string, unknown> | null | undefined): string | null {
  const data = unwrap(assistant);
  const delegation = objectOf(data.delegation_settings);
  if (delegation.enabled === true) return typeof delegation.model === "string" && delegation.model ? delegation.model : null;
  return typeof data.model === "string" && data.model ? data.model : null;
}

/**
 * Standard for every tenant not asked to be speech-to-speech. One that is needs TELNYX_S2S_MODEL and TELNYX_S2S_VOICE,
 * and a backend text model: TELNYX_S2S_BACKEND_MODEL, else the one its assistant (or the template it is made from)
 * already uses. Missing any of them, a listed tenant throws and a default one is standard with the reason (fallback).
 */
export function resolveVoiceMode(settings: SpeechToSpeechSettings | undefined, tenantId: string, existing: Record<string, unknown> | null | undefined): VoiceMode {
  const request = voiceRequest(settings, tenantId);
  if (!settings || request.want === "standard") return { kind: "standard" };
  const cannot = (fallback: VoiceFallback, message: string): VoiceMode => {
    if (request.strict) throw new VoiceModeError(message);
    return { kind: "standard", fallback };
  };
  if (!settings.model) return cannot("s2s_model_not_set", "TELNYX_S2S_MODEL is not set, so a speech-to-speech tenant can't be configured");
  if (!settings.voice) return cannot("s2s_voice_not_set", "TELNYX_S2S_VOICE is not set, so a speech-to-speech tenant can't be configured");
  const backendModel = settings.backendModel ?? currentTextModel(existing);
  if (!backendModel) return cannot("no_backend_model", "No backend text model: set TELNYX_S2S_BACKEND_MODEL or read the shop's assistant first");
  if (backendModel === settings.model) return cannot("backend_model_is_s2s_model", "The backend text model can't be the speech-to-speech model");
  return { kind: "speech_to_speech", model: settings.model, voice: settings.voice, backendModel };
}

export interface ShopAssistantPayload {
  mode: VoiceMode["kind"];
  payload: Record<string, unknown>;
  /** Instruction sections dropped to fit the speech-to-speech limit (empty when nothing was cut). */
  cut: string[];
  /** True when the payload also returns a speech-to-speech assistant to its text model. */
  rollback: boolean;
  /** Set when the default asked for speech-to-speech and this tenant got the standard payload instead: why. */
  fallback?: VoiceFallback;
  /** With fallback "provider_rejected": what Telnyx answered to the speech-to-speech payload (status and its own detail). */
  providerError?: string;
}

/**
 * What to push to one shop's assistant. `existing` is the assistant as Telnyx has it now (GET), or the template a
 * new assistant is made from; without it, a standard tenant still gets today's payload, but no rollback is added.
 */
export function buildShopAssistantPayload(config: BusinessConfig, publicBaseUrl: string, options: { voice?: string | undefined; speechToSpeech?: SpeechToSpeechSettings | undefined; existing?: Record<string, unknown> | null | undefined }): ShopAssistantPayload {
  const standard = buildTelnyxAssistantUpdate(config, publicBaseUrl, { voice: options.voice });
  return assistantVoicePayload(standard, { tenantId: config.tenantId, speechToSpeech: options.speechToSpeech, existing: options.existing });
}

/**
 * A standard payload turned into what this tenant's voice mode sends. Speech-to-speech adds the speaking model, its
 * voice and delegation. Standard is the payload as given, plus the text model and delegation off when `existing` (the
 * assistant now, or the template a new one copies its model from) is in speech-to-speech mode.
 */
export function assistantVoicePayload(standard: Record<string, unknown>, options: { tenantId: string; speechToSpeech?: SpeechToSpeechSettings | undefined; existing?: Record<string, unknown> | null | undefined }): ShopAssistantPayload {
  let mode = resolveVoiceMode(options.speechToSpeech, options.tenantId, options.existing);
  if (mode.kind === "speech_to_speech") {
    // A listed tenant over the limit throws inside speechToSpeechPayload; a default one falls back to standard.
    if (voiceRequest(options.speechToSpeech, options.tenantId).strict || fitInstructions(String(standard.instructions ?? "")).fits) {
      const { payload, cut } = speechToSpeechPayload(standard, mode);
      return { mode: mode.kind, payload, cut, rollback: false };
    }
    mode = { kind: "standard", fallback: "instructions_too_long" };
  }
  return standardVoicePayload(standard, options, mode.fallback);
}

/**
 * The standard payload as this tenant is sent it: as given, plus the text model and delegation off when `existing`
 * is in speech-to-speech mode. Also what a default tenant is sent after Telnyx refuses its speech-to-speech payload
 * (`fallback` "provider_rejected").
 */
export function standardVoicePayload(standard: Record<string, unknown>, options: { speechToSpeech?: SpeechToSpeechSettings | undefined; existing?: Record<string, unknown> | null | undefined }, fallback?: VoiceFallback): ShopAssistantPayload {
  const restore = rollbackFields(options.existing, options.speechToSpeech?.backendModel);
  return {
    mode: "standard", payload: restore ? { ...standard, ...restore } : standard, cut: [], rollback: Boolean(restore),
    ...(fallback ? { fallback } : {}),
  };
}

/**
 * True when the provider's answer refuses the payload itself (400, 422 and the like), so sending the standard payload
 * instead can help. Not sign-in or permission (401, 403), not "try again" (408, 429, any 5xx), and not 409 (the same
 * create is still running): those would fail the standard payload too, or make a second assistant.
 */
export function isPayloadRejection(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && ![401, 403, 408, 409, 429].includes(status);
}

/**
 * NVIDIA's model card says the speaking model takes ASCII instructions. Owners type curly quotes, dashes and accents
 * (an iPhone keyboard does it by default: "Mike\u2019s Plumbing"), so those are folded to plain characters and anything
 * else outside ASCII is dropped. Standard assistants keep the text as typed.
 */
export function plainAscii(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u203A\u2192]/g, ">")
    .replace(/[\u00A0\u2009\u202F]/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

/** The instructions as the speaking model gets them: whole, or without the "HOW YOU SOUND" style section when over the limit. */
function fitInstructions(text: string): { instructions: string; cut: string[]; fits: boolean } {
  let instructions = plainAscii(text);
  const cut: string[] = [];
  if (instructions.length > S2S_INSTRUCTION_LIMIT_CHARS) {
    const shorter = instructions.replace(/\nHOW YOU SOUND[^\n]*\n(?:- [^\n]*\n)+/, "\n");
    if (shorter !== instructions) {
      instructions = shorter;
      cut.push("HOW YOU SOUND");
    }
  }
  return { instructions, cut, fits: instructions.length <= S2S_INSTRUCTION_LIMIT_CHARS };
}

/**
 * True when these instructions fit what the speaking model reads (after the same folding and the one allowed cut).
 * A settings save asks this before it lets a change push a speech-to-speech shop back onto the standard voice.
 */
export function speechToSpeechInstructionsFit(instructions: string): boolean {
  return fitInstructions(instructions).fits;
}

/**
 * Today's payload with the speaking model, its paired voice and delegation to the backend text model. Instructions,
 * greeting, tools, webhooks, dynamic variables, telephony (recording, idle and time limits) and speech settings are
 * the same. Only if the instructions pass the documented limit is the "HOW YOU SOUND" style section cut (the
 * speaking model sets its own rhythm); identity, safety, emergency, booking and ending rules are never cut.
 */
export function speechToSpeechPayload(standard: Record<string, unknown>, mode: Extract<VoiceMode, { kind: "speech_to_speech" }>): { payload: Record<string, unknown>; cut: string[] } {
  const { instructions, cut, fits } = fitInstructions(String(standard.instructions ?? ""));
  if (!fits) {
    throw new VoiceModeError(`Speech-to-speech instructions are ${instructions.length} characters, over the ${S2S_INSTRUCTION_LIMIT_CHARS} the model reads; shorten the shop's prices or answers`);
  }
  const voiceSettings = objectOf(standard.voice_settings);
  return {
    payload: {
      ...standard,
      instructions,
      model: mode.model,
      // The speaking model's own voice; voice_speed is a text-to-speech setting, so it is left out.
      voice_settings: { voice: mode.voice, ...(voiceSettings.tool_call_audio ? { tool_call_audio: voiceSettings.tool_call_audio } : {}) },
      delegation_settings: { enabled: true, mode: "telnyx", model: mode.backendModel, speak_results: true, instructions: BACKEND_TOOL_REMINDER },
    },
    cut,
  };
}

/**
 * For an assistant still in speech-to-speech mode: its text model back (its delegation backend, else `textModel`, the
 * configured backend model), delegation off. Null for a standard assistant.
 */
export function rollbackFields(existing: Record<string, unknown> | null | undefined, textModel?: string | undefined): Record<string, unknown> | null {
  if (!isSpeechToSpeechAssistant(existing)) return null;
  const model = currentTextModel(existing) ?? textModel;
  if (!model) throw new VoiceModeError("The speech-to-speech assistant has no backend text model to roll back to");
  return { model, delegation_settings: { enabled: false } };
}

function unwrap(value: unknown): Record<string, unknown> {
  const object = objectOf(value);
  return object.data && typeof object.data === "object" && !Array.isArray(object.data) ? object.data as Record<string, unknown> : object;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
