import type { Store } from "../ports.js";

/**
 * Automated urgent calls to the owner's mobile are artificial-voice calls (TCPA): only with the owner's prior
 * express consent for that exact number, recorded with time, source and the wording version shown, and
 * stoppable by pressing 9 during a call or in Settings. Only for urgent and life-safety calls.
 */
export const OWNER_CALL_CONSENT_VERSION = "owner-urgent-calls-2026-11-23";
export const OWNER_CALL_CONSENT_LABEL = "Call my mobile with an automated message when a caller has an emergency (optional)";
/** Shown in full beside the signup box and the Settings switch, so both record the same wording version. */
export const OWNER_CALL_CONSENT_DETAIL = "By choosing this, you agree that Front Office by Dutchworks LLC may call this number with automated, artificial-voice messages about emergency calls to your business. Not required to sign up. Press 9 during a call, or turn it off in Settings, to stop.";
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

export async function grantOwnerCallConsent(store: Store, tenantId: string, input: { at: string; source: "signup" | "settings"; ip: string | null; phone: string }): Promise<void> {
  const record: ConsentRecord = { at: input.at, source: input.source, wording: OWNER_CALL_CONSENT_VERSION, ip: input.ip, phone: input.phone };
  await store.saveIntegrationSecret(tenantId, "notifications", OWNER_CALL_CONSENT_KEY, JSON.stringify(record));
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
    if (input.before && Date.parse(record.at) >= Date.parse(input.before)) return false;
    let log: unknown[] = [];
    try {
      const raw = await store.getIntegrationSecret(tenantId, "notifications", CONSENT_LOG_KEY);
      const parsed = raw ? JSON.parse(raw) as unknown : [];
      log = Array.isArray(parsed) ? parsed : [];
    } catch {
      log = [];
    }
    await store.saveIntegrationSecret(tenantId, "notifications", CONSENT_LOG_KEY, JSON.stringify([...log, { grant: record, revokedAt: input.at, revokeSource: input.source }].slice(-50)));
    await store.deleteIntegrationSecret(tenantId, "notifications", OWNER_CALL_CONSENT_KEY);
    return true;
  });
}
