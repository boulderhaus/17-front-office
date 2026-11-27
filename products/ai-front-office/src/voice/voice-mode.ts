import type { Environment } from "../config/environment.js";
import type { BusinessConfig } from "../domain/models.js";
import { buildTelnyxAssistantUpdate } from "./system-prompt.js";

/**
 * Opt-in speech-to-speech voice for chosen shops only (Telnyx AI Assistants speech-to-speech mode).
 *
 * A speech-to-speech model hears and speaks audio itself, so it can laugh, backchannel and overlap like a person.
 * It never calls tools: Telnyx "delegation" hands each lookup or action to a backend text model that runs the
 * assistant's own tools (webhooks, transfer, hangup) and the speaking model says the result.
 *
 * Every tenant not in TELNYX_S2S_TENANT_IDS (and the demo line) gets buildTelnyxAssistantUpdate's payload unchanged.
 * Rollback: remove the tenant from the list and run scripts/configure-telnyx.ts --apply; the push for an assistant
 * still in speech-to-speech mode adds back its text model and turns delegation off (rollbackFields).
 */

/**
 * Telnyx: its hosted speech-to-speech model reads about 2,500 tokens (~10,000 characters) of instructions; longer ones are
 * accepted but the middle is dropped. Kept under that so the safety and booking rules are always read.
 */
export const S2S_INSTRUCTION_LIMIT_CHARS = 10_000;

export interface SpeechToSpeechSettings {
  tenantIds: readonly string[];
  model?: string | undefined;
  voice?: string | undefined;
  backendModel?: string | undefined;
}

export type VoiceMode =
  | { kind: "standard" }
  | { kind: "speech_to_speech"; model: string; voice: string; backendModel: string };

export class VoiceModeError extends Error {}

export function speechToSpeechSettings(env: Pick<Environment, "TELNYX_S2S_TENANT_IDS" | "TELNYX_S2S_MODEL" | "TELNYX_S2S_VOICE" | "TELNYX_S2S_BACKEND_MODEL">): SpeechToSpeechSettings {
  return { tenantIds: env.TELNYX_S2S_TENANT_IDS ?? [], model: env.TELNYX_S2S_MODEL, voice: env.TELNYX_S2S_VOICE, backendModel: env.TELNYX_S2S_BACKEND_MODEL };
}

export function isSpeechToSpeechTenant(settings: SpeechToSpeechSettings | undefined, tenantId: string): boolean {
  return Boolean(settings?.tenantIds.includes(tenantId));
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
 * Standard for every unlisted tenant. A listed tenant needs TELNYX_S2S_MODEL and TELNYX_S2S_VOICE, and a backend
 * text model: TELNYX_S2S_BACKEND_MODEL, else the one its assistant (or the template it is made from) already uses.
 */
export function resolveVoiceMode(settings: SpeechToSpeechSettings | undefined, tenantId: string, existing: Record<string, unknown> | null | undefined): VoiceMode {
  if (!settings || !isSpeechToSpeechTenant(settings, tenantId)) return { kind: "standard" };
  if (!settings.model) throw new VoiceModeError("TELNYX_S2S_MODEL is not set, so a speech-to-speech tenant can't be configured");
  if (!settings.voice) throw new VoiceModeError("TELNYX_S2S_VOICE is not set, so a speech-to-speech tenant can't be configured");
  const backendModel = settings.backendModel ?? currentTextModel(existing);
  if (!backendModel) throw new VoiceModeError("No backend text model: set TELNYX_S2S_BACKEND_MODEL or read the shop's assistant first");
  if (backendModel === settings.model) throw new VoiceModeError("The backend text model can't be the speech-to-speech model");
  return { kind: "speech_to_speech", model: settings.model, voice: settings.voice, backendModel };
}

export interface ShopAssistantPayload {
  mode: VoiceMode["kind"];
  payload: Record<string, unknown>;
  /** Instruction sections dropped to fit the speech-to-speech limit (empty when nothing was cut). */
  cut: string[];
  /** True when the payload also returns a speech-to-speech assistant to its text model. */
  rollback: boolean;
}

/**
 * What to push to one shop's assistant. `existing` is the assistant as Telnyx has it now (GET), or the template a
 * new assistant is made from; without it, an unlisted tenant still gets today's payload, but no rollback is added.
 */
export function buildShopAssistantPayload(config: BusinessConfig, publicBaseUrl: string, options: { voice?: string | undefined; speechToSpeech?: SpeechToSpeechSettings | undefined; existing?: Record<string, unknown> | null | undefined }): ShopAssistantPayload {
  const standard = buildTelnyxAssistantUpdate(config, publicBaseUrl, { voice: options.voice });
  const mode = resolveVoiceMode(options.speechToSpeech, config.tenantId, options.existing);
  if (mode.kind === "speech_to_speech") {
    const { payload, cut } = speechToSpeechPayload(standard, mode);
    return { mode: mode.kind, payload, cut, rollback: false };
  }
  const restore = rollbackFields(options.existing);
  return restore
    ? { mode: "standard", payload: { ...standard, ...restore }, cut: [], rollback: true }
    : { mode: "standard", payload: standard, cut: [], rollback: false };
}

/**
 * Today's payload with the speaking model, its paired voice and delegation to the backend text model. Instructions,
 * greeting, tools, webhooks, dynamic variables, telephony (recording, idle and time limits) and speech settings are
 * the same. Only if the instructions pass the documented limit is the "HOW YOU SOUND" style section cut (the
 * speaking model sets its own rhythm); identity, safety, emergency, booking and ending rules are never cut.
 */
export function speechToSpeechPayload(standard: Record<string, unknown>, mode: Extract<VoiceMode, { kind: "speech_to_speech" }>): { payload: Record<string, unknown>; cut: string[] } {
  let instructions = String(standard.instructions ?? "");
  const cut: string[] = [];
  if (instructions.length > S2S_INSTRUCTION_LIMIT_CHARS) {
    const shorter = instructions.replace(/\nHOW YOU SOUND[^\n]*\n(?:- [^\n]*\n)+/, "\n");
    if (shorter !== instructions) {
      instructions = shorter;
      cut.push("HOW YOU SOUND");
    }
  }
  if (instructions.length > S2S_INSTRUCTION_LIMIT_CHARS) {
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
      delegation_settings: { enabled: true, mode: "telnyx", model: mode.backendModel, speak_results: true },
    },
    cut,
  };
}

/** For an assistant still in speech-to-speech mode: its text model back, delegation off. Null for a standard assistant. */
export function rollbackFields(existing: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!isSpeechToSpeechAssistant(existing)) return null;
  const model = currentTextModel(existing);
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
