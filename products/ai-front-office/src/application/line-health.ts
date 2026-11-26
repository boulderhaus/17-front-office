import { ensureCallEndCallback } from "../adapters/telnyx-provisioning.js";
import type { Store } from "../ports.js";
import { redactError } from "./retry.js";

export interface LineHealthResult {
  /** Assistants whose TeXML app was read. */
  checked: number;
  /** Lines that would never tell us a call ended. */
  missing: number;
  /** Shops whose line could not be read at all. */
  failed: number;
}

/**
 * Line health: every assistant that answers for a shop must have its TeXML app posting the end-of-call callback
 * here, or that shop's calls end with no transcript, summary, usage count or callback task. Go-live sets it and
 * scripts/configure-telnyx.ts --apply repairs it; this only reads, so it can run on every replica and can never
 * repoint a line from the wrong environment. A missing callback is logged as an error naming the shop.
 */
export class LineHealthCheck {
  constructor(
    private readonly store: Store,
    private readonly options: {
      apiKey: string;
      publicBaseUrl: string;
      log: (entry: Record<string, unknown>) => void;
      /** Called for each line that is on and missing its callback (error tracking). */
      onMissing?: ((tenantId: string) => void) | undefined;
      fetcher?: typeof fetch | undefined;
      sleep?: ((ms: number) => Promise<void>) | undefined;
    },
  ) {}

  async runOnce(): Promise<LineHealthResult> {
    const result: LineHealthResult = { checked: 0, missing: 0, failed: 0 };
    const seen = new Set<string>();
    for (const tenantId of await this.store.listTenantIds()) {
      try {
        const route = await this.store.getProviderRouteForTenant("telnyx", tenantId);
        if (!route || seen.has(route.externalId)) continue;
        seen.add(route.externalId);
        const lineOn = !(await this.store.getConfig(tenantId)).paused;
        const state = await ensureCallEndCallback({
          apiKey: this.options.apiKey, assistantId: route.externalId, publicBaseUrl: this.options.publicBaseUrl, apply: false,
          fetcher: this.options.fetcher, sleep: this.options.sleep,
        });
        result.checked += 1;
        if (state.action === "already_set") continue;
        result.missing += 1;
        // A paused line takes no calls, so it is a warning until it is turned back on.
        this.options.log({ level: lineOn ? "error" : "warn", event: "line_call_end_callback_missing", tenantId, lineOn, fix: "npm run configure:telnyx -- --apply" });
        if (lineOn) this.options.onMissing?.(tenantId);
      } catch (error) {
        result.failed += 1;
        this.options.log({ level: "error", event: "line_health_check_failed", tenantId, error: redactError(error) });
      }
    }
    return result;
  }
}
