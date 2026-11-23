import { randomUUID } from "node:crypto";
import { formatEmailBody } from "../adapters/resend.js";
import type { BusinessConfig, OutboxNotification, UsageSummary } from "../domain/models.js";
import { currentBillingPeriod, dueUsageAlerts } from "../domain/usage.js";
import type { Clock, Store } from "../ports.js";

/**
 * Tells the owner when this billing period’s answered calls cross their alert threshold and again at 100%.
 * Runs when a call finalizes (the only time usage changes). The outbox's unique idempotency key
 * `usage-alert:<tenant>:<periodStart>:<percent>` makes it safe across webhook replays, restarts and replicas.
 */
export class UsageAlertService {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly publicBaseUrl: string,
    private readonly ownerEmailAvailable: boolean,
  ) {}

  async check(tenantId: string): Promise<number> {
    const [config, subscription, account] = await Promise.all([
      this.store.getConfig(tenantId),
      this.store.getSubscription(tenantId),
      this.store.getOwnerAccountByTenant(tenantId),
    ]);
    if (account?.status === "suspended") return 0;
    const now = this.clock.now();
    const [periodStart, periodEnd] = currentBillingPeriod(now, subscription?.currentPeriodEnd);
    const usage = await this.store.getUsageSummary(tenantId, periodStart, periodEnd);
    const due = dueUsageAlerts(usage.billableCalls, config.includedCalls, config.usageAlertPercent);
    if (due.length === 0) return 0;

    // One message per threshold, to one place: the owner's alert phone, or their sign-in email.
    const smsRef = config.ownerNotificationRefs[0] ?? null;
    const email = !smsRef && this.ownerEmailAvailable && account?.email ? account.email : null;
    if (!smsRef && !email) return 0;

    let queued = 0;
    for (const percent of due) {
      const text = usageAlertText(config, usage, percent);
      const stamp = now.toISOString();
      const notification: OutboxNotification = {
        id: randomUUID(), tenantId, callId: null,
        channel: smsRef ? "sms" : "email",
        destinationRef: smsRef ?? `email:${email}`,
        body: smsRef ? text.sms : formatEmailBody(text.subject, `${text.sms}\n\nSee your calls or change plans: ${this.publicBaseUrl.replace(/\/$/, "")}/app/settings`),
        priority: "normal", state: "pending", attempts: 0, nextAttemptAt: stamp,
        idempotencyKey: `usage-alert:${tenantId}:${periodStart}:${percent}`,
        providerReceipt: null, lastError: null, createdAt: stamp, sentAt: null,
      };
      if (await this.store.enqueueNotification(notification)) queued += 1;
    }
    return queued;
  }
}

/**
 * Plain words for a busy owner: the real numbers, the price of an extra call, and what to do.
 * "Front Office: you've answered 45 of your 60 calls this month. Extra calls are $0.75 each. Change plans in Settings."
 * Dollars, never "¢": ¢ is outside GSM-7 and would double the SMS segments.
 */
export function usageAlertText(config: Pick<BusinessConfig, "includedCalls" | "overageCentsPerCall">, usage: Pick<UsageSummary, "billableCalls">, percent: number): { subject: string; sms: string } {
  const included = config.includedCalls;
  const sms = `Front Office: you've answered ${usage.billableCalls} of your ${included} calls this month. Extra calls are $${(config.overageCentsPerCall / 100).toFixed(2)} each. Change plans in Settings.`;
  return {
    subject: percent >= 100 ? `Front Office: you've answered all ${included} of your calls this month` : `Front Office: you've answered ${usage.billableCalls} of your ${included} calls`,
    sms,
  };
}
