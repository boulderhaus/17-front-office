import type { Store } from "../ports.js";
import { TOOL_LEDGER_RETENTION_MS } from "../voice/tool-results.js";

const DAY_MS = 24 * 60 * 60_000;

export interface ExpiredCallDeleter {
  deleteExpired(tenantId: string, endedBefore: string): Promise<{ deleted: number; failed: number }>;
}

type RetentionStore = Pick<Store, "purgeWebhookEvents" | "purgeToolLedger" | "listTenantIds" | "getConfig" | "getOwnerAccountByTenant" | "getSubscription">;

/**
 * The hourly clean-up. A live shop keeps its calls for good: the owner deletes a call (or the whole account) on
 * request, never a timer. A shop with no owner account (demo, platform) or one cancelled longer ago than its
 * retention window still has its old calls removed on that timer. Internal plumbing always expires: raw provider
 * webhooks after 30 days and the voice-tool ledger after its window.
 */
export async function runRetentionCycle(
  store: RetentionStore,
  now: Date,
  deletion: ExpiredCallDeleter | null = null,
  onTenantError: (tenantId: string, error: unknown) => void = () => undefined,
): Promise<{ purgedWebhooks: number; purgedToolLedger: number; purgedCalls: number }> {
  let purgedCalls = 0;
  if (deletion) {
    for (const tenantId of await store.listTenantIds()) {
      try {
        const config = await store.getConfig(tenantId);
        const windowMs = config.dataRetentionDays * DAY_MS;
        const account = await store.getOwnerAccountByTenant(tenantId);
        if (account) {
          const subscription = await store.getSubscription(tenantId);
          const cancelledLongAgo = subscription?.status === "canceled" && now.getTime() - Date.parse(subscription.updatedAt) > windowMs;
          if (!cancelledLongAgo) continue;
        }
        const result = await deletion.deleteExpired(tenantId, new Date(now.getTime() - windowMs).toISOString());
        purgedCalls += result.deleted;
      } catch (error) {
        onTenantError(tenantId, error);
      }
    }
  }
  const purgedWebhooks = await store.purgeWebhookEvents(new Date(now.getTime() - 30 * DAY_MS).toISOString());
  const purgedToolLedger = await store.purgeToolLedger(new Date(now.getTime() - TOOL_LEDGER_RETENTION_MS).toISOString());
  return { purgedWebhooks, purgedToolLedger, purgedCalls };
}
