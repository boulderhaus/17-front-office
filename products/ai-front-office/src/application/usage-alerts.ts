import { randomUUID } from "node:crypto";
import { formatEmailBody } from "../adapters/resend.js";
import type { BusinessConfig, OutboxNotification, UsageSummary } from "../domain/models.js";
import { currentBillingPeriod, dueUsageAlerts } from "../domain/usage.js";
import type { Clock, Store } from "../ports.js";

/**
 * Tells the owner when this billing period's minutes cross their alert threshold and again at 100%.
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
    const due = dueUsageAlerts(usage.billedMinutes, config.includedMinutes, config.usageAlertPercent);
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
        body: smsRef ? text.sms : formatEmailBody(text.subject, `${text.sms}\n\nSee your minutes or change this alert: ${this.publicBaseUrl.replace(/\/$/, "")}/app/settings`),
        priority: "normal", state: "pending", attempts: 0, nextAttemptAt: stamp,
        idempotencyKey: `usage-alert:${tenantId}:${periodStart}:${percent}`,
        providerReceipt: null, lastError: null, createdAt: stamp, sentAt: null,
      };
      if (await this.store.enqueueNotification(notification)) queued += 1;
    }
    return queued;
  }
}

/** Plain words for a busy owner: no jargon, the real numbers, and what to do. */
export function usageAlertText(config: Pick<BusinessConfig, "includedMinutes" | "overageCentsPerMinute">, usage: Pick<UsageSummary, "billedMinutes" | "periodEnd">, percent: number): { subject: string; sms: string } {
  const included = config.includedMinutes;
  if (percent >= 100) {
    const resets = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(usage.periodEnd));
    return {
      subject: "Front Office: you've used all your minutes",
      sms: `Front Office: you've used all ${included} of your minutes this month. Extra minutes are $${(config.overageCentsPerMinute / 100).toFixed(2)} each until they reset on ${resets}.`,
    };
  }
  const used = Math.floor((usage.billedMinutes * 100) / included);
  return {
    subject: `Front Office: you've used ${used}% of your minutes`,
    sms: `Front Office: you've used ${used}% of your ${included} minutes this month (${usage.billedMinutes}). Change this alert in Settings.`,
  };
}
