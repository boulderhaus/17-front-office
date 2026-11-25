import { forwardsBackToOtto } from "../domain/forwarding.js";
import type { Store } from "../ports.js";

/**
 * True when Otto ringing `phone` could come straight back to this shop's own Call Otto line: the owner picked
 * "Let Otto answer every call", or the last code a test proved is a forward-all one (switched back, off code not
 * dialed yet). Otto must never dial it (setup helper, urgent owner calls, warm transfers); texts still reach that
 * phone, since SMS isn't forwarded. A failed lookup throws, so callers retry instead of dialing blind.
 */
export async function dialsBackToOtto(store: Pick<Store, "getConfig" | "getIntegrationSecret">, tenantId: string, phone: string | null | undefined): Promise<boolean> {
  if (!phone) return false;
  const [config, businessNumber, dialedCode] = await Promise.all([
    store.getConfig(tenantId),
    store.getIntegrationSecret(tenantId, "forwarding", "business_number"),
    store.getIntegrationSecret(tenantId, "forwarding", "dialed_code"),
  ]);
  return forwardsBackToOtto({ mode: config.operationMode, businessNumber, phone, dialedCode });
}
