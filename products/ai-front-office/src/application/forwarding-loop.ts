import { forwardsBackToOtto } from "../domain/forwarding.js";
import type { Store } from "../ports.js";

/**
 * True when Otto ringing `phone` would come straight back to this shop's own Call Otto line: the owner picked
 * "Let Otto answer every call", so their business number forwards everything to Otto. Otto must never dial it
 * (setup helper, urgent owner calls, warm transfers); texts still reach that phone, since SMS isn't forwarded.
 */
export async function dialsBackToOtto(store: Pick<Store, "getConfig" | "getIntegrationSecret">, tenantId: string, phone: string | null | undefined): Promise<boolean> {
  if (!phone) return false;
  const [config, businessNumber] = await Promise.all([
    store.getConfig(tenantId),
    store.getIntegrationSecret(tenantId, "forwarding", "business_number"),
  ]);
  return forwardsBackToOtto({ mode: config.operationMode, businessNumber, phone });
}
