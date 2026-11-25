import { randomUUID } from "node:crypto";
import { formatEmailBody } from "../adapters/resend.js";
import type { BusinessConfig, OutboxNotification, UsageSummary } from "../domain/models.js";
import { fairUseCalls } from "../domain/plans.js";
import { isCompStatus } from "../domain/billing.js";
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
    // Suspended, or complimentary (the Google review account): no usage alerts.
    if (account?.status === "suspended" || isCompStatus(subscription?.status)) return 0;
    const now = this.clock.now();
    const [periodStart, periodEnd] = currentBillingPeriod(now, subscription?.currentPeriodEnd);
    const usage = await this.store.getUsageSummary(tenantId, periodStart, periodEnd);
    const due = dueUsageAlerts(usage.billableCalls, callAllowance(config), config.usageAlertPercent);
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
 * "Otto: you've answered 45 of your 60 calls this month. Extra calls are $0.75 each. Change plans in Settings."
 * Dollars, never "¢": ¢ is outside GSM-7 and would double the SMS segments.
 */
export function usageAlertText(config: Pick<BusinessConfig, "includedCalls" | "overageCentsPerCall" | "unlimitedCalls">, usage: Pick<UsageSummary, "billableCalls">, percent: number): { subject: string; sms: string } {
  const included = callAllowance(config);
  const rate = `$${(config.overageCentsPerCall / 100).toFixed(2)}`;
  // With Unlimited, the limit that matters is fair use (3× the plan's calls); past it, calls are billed again.
  const sms = config.unlimitedCalls
    ? `Otto: you've answered ${usage.billableCalls} of your ${included} fair-use calls this month. Past that, calls are ${rate} each. Change plans in Settings.`
    : `Otto: you've answered ${usage.billableCalls} of your ${included} calls this month. Extra calls are ${rate} each. Change plans in Settings.`;
  const kind = config.unlimitedCalls ? "fair-use calls" : "calls";
  return {
    subject: percent >= 100 ? `Otto: you've answered all ${included} of your ${kind} this month` : `Otto: you've answered ${usage.billableCalls} of your ${included} ${kind}`,
    sms,
  };
}

/** Calls a period can use before anything extra is billed: the plan's calls, or fair use with Unlimited. */
export function callAllowance(config: Pick<BusinessConfig, "includedCalls" | "unlimitedCalls">): number {
  return config.unlimitedCalls ? fairUseCalls(config.includedCalls) : config.includedCalls;
}
