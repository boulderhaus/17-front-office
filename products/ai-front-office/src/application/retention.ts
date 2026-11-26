import type { Store } from "../ports.js";
import { TOOL_LEDGER_RETENTION_MS } from "../voice/tool-results.js";

/**
 * The hourly clean-up. Call records, transcripts and recordings are kept for good: an owner deletes a call (or the
 * whole account) on request, never a timer. Only internal plumbing expires: raw provider webhooks after 30 days and
 * the voice-tool ledger after its window.
 */
export async function runRetentionCycle(store: Pick<Store, "purgeWebhookEvents" | "purgeToolLedger">, now: Date): Promise<{ purgedWebhooks: number; purgedToolLedger: number }> {
  const purgedWebhooks = await store.purgeWebhookEvents(new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString());
  const purgedToolLedger = await store.purgeToolLedger(new Date(now.getTime() - TOOL_LEDGER_RETENTION_MS).toISOString());
  return { purgedWebhooks, purgedToolLedger };
}
