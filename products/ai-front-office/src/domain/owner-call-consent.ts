import type { Store } from "../ports.js";

/**
 * Automated urgent calls to the owner's mobile are artificial-voice calls (TCPA): only with the owner's prior
 * express consent for that exact number, recorded with time, source and the wording version shown, and
 * stoppable by pressing 9 during a call or in Settings. Only for urgent and life-safety calls.
 */
export const OWNER_CALL_CONSENT_VERSION = "owner-urgent-calls-2026-11-23b";
export const OWNER_CALL_CONSENT_LABEL = "Call my mobile with an automated message when a caller has an emergency (optional)";
/** Shown in full beside the signup box and the Settings switch, so both record the same wording version. */
export const OWNER_CALL_CONSENT_DETAIL = "By choosing this, you agree that Call Otto by Dutchworks LLC may call this number with automated, artificial-voice messages about emergency calls to your business. Not required to sign up. Press 9 during a call, or turn it off in Settings, to stop.";
/**
 * Sign-up's one-line version of the same consent (who calls, automated voice, why, optional, how to stop). A grant
 * from sign-up records this version, so the proof always names the words the owner actually saw.
 */
export const OWNER_CALL_CONSENT_SIGNUP_VERSION = "owner-urgent-calls-signup-2026-11-26";
export const OWNER_CALL_CONSENT_SIGNUP_LABEL = "Call Otto may call my mobile with an automated voice message when a caller has an emergency. Optional; press 9 to stop.";
/**
 * The Settings switch: one line that says what turning it on does, with the same consent terms (automated message,
 * this number, emergencies only, how to stop). Recorded under its own wording version.
 */
export const OWNER_CALL_CONSENT_SETTINGS_VERSION = "owner-urgent-calls-settings-2026-11-26";
export const OWNER_CALL_CONSENT_SETTINGS_DETAIL = "Otto calls this mobile with an automated, artificial-voice message the moment a caller has an emergency. Press 9 on that call, or turn this off, to stop.";
/** Integration secret (provider "notifications") holding the active consent; absent means no automated calls. */
export const OWNER_CALL_CONSENT_KEY = "owner_call_consent";
/** Every grant ever given and how it ended, kept after a stop as proof of the consent behind earlier calls. */
const CONSENT_LOG_KEY = "owner_call_consent_log";

interface ConsentRecord { at: string; source: "signup" | "settings"; wording: string; ip: string | null; phone: string }

async function readConsent(store: Store, tenantId: string): Promise<ConsentRecord | null> {
  const raw = await store.getIntegrationSecret(tenantId, "notifications", OWNER_CALL_CONSENT_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ConsentRecord>;
    return typeof value.at === "string" && typeof value.phone === "string" ? value as ConsentRecord : null;
  } catch {
    return null;
  }
}

export async function grantOwnerCallConsent(store: Store, tenantId: string, input: { at: string; source: "signup" | "settings"; ip: string | null; phone: string; wording?: string }): Promise<void> {
  const record: ConsentRecord = { at: input.at, source: input.source, wording: input.wording ?? (input.source === "signup" ? OWNER_CALL_CONSENT_SIGNUP_VERSION : OWNER_CALL_CONSENT_VERSION), ip: input.ip, phone: input.phone };
  await store.withLock(`owner-call-consent:${tenantId}`, async () => {
    // A grant it replaces stays on file as proof for the calls already placed under it.
    const previous = await readConsent(store, tenantId);
    if (previous) await appendConsentLog(store, tenantId, { grant: previous, revokedAt: input.at, revokeSource: "superseded" });
    await store.saveIntegrationSecret(tenantId, "notifications", OWNER_CALL_CONSENT_KEY, JSON.stringify(record));
  });
}

/** Append-only proof of every grant. A log that can't be read is never rewritten (and the change fails). */
async function appendConsentLog(store: Store, tenantId: string, entry: Record<string, unknown>): Promise<void> {
  const raw = await store.getIntegrationSecret(tenantId, "notifications", CONSENT_LOG_KEY);
  const parsed = raw ? JSON.parse(raw) as unknown : [];
  if (!Array.isArray(parsed)) throw new Error("Owner call consent log is unreadable");
  await store.saveIntegrationSecret(tenantId, "notifications", CONSENT_LOG_KEY, JSON.stringify([...parsed, entry]));
}

/** Consent counts only for the number it was given for: a replaced mobile is never called without a new yes. */
export async function hasOwnerCallConsent(store: Store, tenantId: string, phone: string | null): Promise<boolean> {
  const record = await readConsent(store, tenantId);
  return Boolean(record && phone && record.phone === phone);
}

/**
 * Stop the calls, keeping the grant in the log. `before`: only a grant given before this moment is revoked, so a
 * redelivered keypad webhook never undoes a later "turn it back on".
 */
export async function revokeOwnerCallConsent(store: Store, tenantId: string, input: { at: string; source: "settings" | "keypad"; before?: string }): Promise<boolean> {
  return store.withLock(`owner-call-consent:${tenantId}`, async () => {
    const record = await readConsent(store, tenantId);
    if (!record) return false;
    if (input.before && !Number.isNaN(Date.parse(input.before)) && Date.parse(record.at) >= Date.parse(input.before)) return false;
    await appendConsentLog(store, tenantId, { grant: record, revokedAt: input.at, revokeSource: input.source });
    await store.deleteIntegrationSecret(tenantId, "notifications", OWNER_CALL_CONSENT_KEY);
    return true;
  });
}
