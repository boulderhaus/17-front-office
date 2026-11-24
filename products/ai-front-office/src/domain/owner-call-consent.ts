/**
 * Automated urgent calls to the owner's mobile are artificial-voice calls (TCPA): only with the owner's prior
 * express consent, recorded with time, source and wording version, and stoppable by pressing 9 during a call
 * or in Settings. Only for urgent and life-safety calls.
 */
export const OWNER_CALL_CONSENT_VERSION = "owner-urgent-calls-2026-11-23";
export const OWNER_CALL_CONSENT_LABEL = "Call my mobile with an automated message when a caller has an emergency (optional)";
export const OWNER_CALL_CONSENT_DETAIL = "By checking this, you agree that Front Office by Dutchworks LLC may call this number with automated, artificial-voice messages about emergency calls to your business. Not required to sign up. Press 9 during a call, or turn it off in Settings, to stop.";
/** Integration secret (provider "notifications") holding the consent record; absent means no automated calls. */
export const OWNER_CALL_CONSENT_KEY = "owner_call_consent";

export function ownerCallConsentRecord(input: { at: string; source: "signup" | "settings"; ip: string | null }): string {
  return JSON.stringify({ at: input.at, source: input.source, wording: OWNER_CALL_CONSENT_VERSION, ip: input.ip });
}
