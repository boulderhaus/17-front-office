import { forwardsBackToOtto, parseTestedFor } from "../domain/forwarding.js";
import type { BusinessConfig } from "../domain/models.js";
import type { Store } from "../ports.js";

/** A transfer can never dial caller-controlled data or loop into either leg. */
export async function approvedTransferTargets(store: Store, config: BusinessConfig, callerPhone: string, defaultInbound: string | undefined): Promise<Array<{ name: string; to: string }>> {
  if (!config.warmTransferEnabled || !config.ownerTransferNumberRef) return [];
  const [owner, inbound, businessNumber, testedFor] = await Promise.all([
    store.getIntegrationSecret(config.tenantId, "notifications", config.ownerTransferNumberRef),
    store.getIntegrationSecret(config.tenantId, "telnyx", "inbound_number"),
    store.getIntegrationSecret(config.tenantId, "forwarding", "business_number"),
    store.getIntegrationSecret(config.tenantId, "forwarding", "tested_for"),
  ]);
  if (!owner || !/^\+1[2-9]\d{9}$/.test(owner)) return [];
  // "Every call" picked, or the last passed test was for every call: the business phone may send everything to Otto,
  // so a transfer there loops back.
  if (forwardsBackToOtto({ mode: config.operationMode, businessNumber, phone: owner, testedFor: parseTestedFor(testedFor) })) return [];
  const caller = canonicalUsPhone(callerPhone);
  if (!caller || owner === caller || owner === canonicalUsPhone(inbound) || owner === canonicalUsPhone(defaultInbound)) return [];
  return [{ name: "Owner", to: owner }];
}

function canonicalUsPhone(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  return /^[2-9]\d{9}$/.test(digits) ? `+1${digits}` : /^1[2-9]\d{9}$/.test(digits) ? `+${digits}` : null;
}
