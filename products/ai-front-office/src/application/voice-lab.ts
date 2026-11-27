import { isCompStatus } from "../domain/billing.js";
import { PLATFORM_TENANT_ID, type Store } from "../ports.js";

/**
 * The voice lab line (scripts/voice-lab-line.ts): one complimentary lab shop whose assistant tries an opt-in voice
 * mode (src/voice/voice-mode.ts) on a number already on our Telnyx account, so the founder can compare it by ear
 * with a normal line. Recorded once, as a platform secret, so the cancel, grace and delete logic never releases
 * that number or assistant while it is the lab line, and so the lab shop's calls are answered although it never pays.
 */
export const VOICE_LAB_PROVIDER = "voice_lab";
export const VOICE_LAB_LINE_KEY = "line";
export const VOICE_LAB_TENANT_KEY = "tenant_id";

export interface VoiceLabLine {
  tenantId: string;
  phoneNumber: string;
  numberId: string;
  assistantId: string;
  /** How the number was before it became the lab line, so --remove can put it back. */
  previous: {
    connectionId: string | null;
    /** The (cancelled, unpaid) shop that still had the number saved, and which of its keys held it. */
    holderTenantId: string | null;
    holderKeys: Array<"inbound_number" | "pending_number">;
  };
  createdAt: string;
}

export async function readVoiceLabLine(store: Pick<Store, "getIntegrationSecret">): Promise<VoiceLabLine | null> {
  const raw = await store.getIntegrationSecret(PLATFORM_TENANT_ID, VOICE_LAB_PROVIDER, VOICE_LAB_LINE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<VoiceLabLine>;
    return typeof value.tenantId === "string" && typeof value.phoneNumber === "string" && typeof value.assistantId === "string" ? value as VoiceLabLine : null;
  } catch {
    return null;
  }
}

/** The lab shop answers calls though it never pays: only while it is complimentary and is the recorded lab line. */
export async function isVoiceLabTenant(store: Pick<Store, "getIntegrationSecret" | "getSubscription">, tenantId: string): Promise<boolean> {
  const line = await readVoiceLabLine(store);
  if (!line || line.tenantId !== tenantId) return false;
  return isCompStatus((await store.getSubscription(tenantId))?.status);
}
