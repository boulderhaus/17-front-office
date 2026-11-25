import { forwardsBackToOtto, parseTestedFor } from "../domain/forwarding.js";
import type { Store } from "../ports.js";

/**
 * True when Otto ringing `phone` could come straight back to this shop's own Call Otto line: it's the business
 * number, and "every call" is picked or the last passed test was for every call (see mayForwardAll). Otto must never
 * dial it (setup helper, urgent owner calls, warm transfers); texts still reach that phone, since SMS isn't forwarded.
 * A failed lookup throws, so callers retry instead of dialing blind.
 */
export async function dialsBackToOtto(store: Pick<Store, "getConfig" | "getIntegrationSecret">, tenantId: string, phone: string | null | undefined): Promise<boolean> {
  if (!phone) return false;
  const [config, businessNumber, testedFor] = await Promise.all([
    store.getConfig(tenantId),
    store.getIntegrationSecret(tenantId, "forwarding", "business_number"),
    store.getIntegrationSecret(tenantId, "forwarding", "tested_for"),
  ]);
  return forwardsBackToOtto({ mode: config.operationMode, businessNumber, phone, testedFor: parseTestedFor(testedFor) });
}
