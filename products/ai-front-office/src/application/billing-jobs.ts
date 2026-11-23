import type { GuaranteeRefund, StripeBillingClient } from "../adapters/stripe.js";
import { isPaidStatus } from "../domain/billing.js";
import { extraCalls, isQualifyingLead, lastClosedBillingPeriod } from "../domain/usage.js";
import type { Clock, Store } from "../ports.js";

const DAY_MS = 24 * 60 * 60_000;
/** The guarantee watches the first 30 days after the first payment… */
export const GUARANTEE_WINDOW_DAYS = 30;
/** …and the refund button stays up for a week after that (days 30–37). */
export const GUARANTEE_CLAIM_DAYS = 37;
/** A closed period older than this is never billed (first deploy, long-dead shops). */
const OVERAGE_LOOKBACK_DAYS = 35;

type Log = (entry: Record<string, unknown>) => void;

/** Set once, the first time a shop's subscription is seen paid. The guarantee window starts here. */
export async function recordFirstPaid(store: Store, tenantId: string, at: string): Promise<void> {
  if (await store.getIntegrationSecret(tenantId, "billing", "first_paid_at")) return;
  await store.saveIntegrationSecret(tenantId, "billing", "first_paid_at", at);
}

async function firstPaidAt(store: Store, tenantId: string): Promise<string | null> {
  const saved = await store.getIntegrationSecret(tenantId, "billing", "first_paid_at");
  if (saved) return saved;
  // Shops that paid before this was recorded: the subscription record is the closest date we have.
  const subscription = await store.getSubscription(tenantId);
  return subscription && isPaidStatus(subscription.status) ? subscription.createdAt : null;
}

type OverageMarker = { state: "none" | "invoice_created" | "billed"; calls: number; amountCents: number; invoiceId: string | null; at: string };

/**
 * Period-end overage: once a billing period closes, every counted call past the plan's included calls
 * is billed once as its own Stripe invoice (N × 75¢), charged to the subscription's card. Runs on every
 * replica under the shop's billing lock; a per-period marker plus Stripe idempotency keys make it bill once.
 */
export class OverageBillingService {
  constructor(private readonly store: Store, private readonly stripe: Pick<StripeBillingClient, "billExtraCalls"> | null, private readonly clock: Clock, private readonly log: Log = () => undefined) {}

  async runOnce(): Promise<{ billed: number; skipped: number; failed: number }> {
    const result = { billed: 0, skipped: 0, failed: 0 };
    if (!this.stripe) return result;
    for (const tenantId of await this.store.listTenantIds()) {
      try {
        const outcome = await this.billTenant(tenantId);
        if (outcome === "billed") result.billed += 1; else result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        this.log({ level: "error", event: "overage_billing_failed", tenantId, error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
      }
    }
    return result;
  }

  async billTenant(tenantId: string): Promise<"billed" | "skipped"> {
    const stripe = this.stripe;
    if (!stripe) return "skipped";
    return this.store.withLock(`billing:${tenantId}`, async () => {
      const subscription = await this.store.getSubscription(tenantId);
      if (!subscription?.providerCustomerId) return "skipped";
      const now = this.clock.now();
      const period = lastClosedBillingPeriod(now, subscription.currentPeriodEnd);
      if (!period) return "skipped";
      const [periodStart, periodEnd] = period;
      if (Date.parse(periodEnd) < now.getTime() - OVERAGE_LOOKBACK_DAYS * DAY_MS) return "skipped";
      const paidAt = await firstPaidAt(this.store, tenantId);
      // The period must fall after the shop started paying (the month before their first one is not theirs).
      if (!paidAt || Date.parse(periodEnd) <= Date.parse(paidAt) + DAY_MS) return "skipped";
      const key = `overage:${periodStart}`;
      const savedRaw = await this.store.getIntegrationSecret(tenantId, "billing", key);
      const saved = savedRaw ? JSON.parse(savedRaw) as OverageMarker : null;
      if (saved?.state === "billed" || saved?.state === "none") return "skipped";
      const [config, usage] = await Promise.all([
        this.store.getConfig(tenantId),
        this.store.getUsageSummary(tenantId, periodStart, periodEnd),
      ]);
      const calls = saved?.calls ?? extraCalls(usage.billableCalls, config.includedCalls);
      const at = now.toISOString();
      if (calls <= 0) {
        await this.store.saveIntegrationSecret(tenantId, "billing", key, JSON.stringify({ state: "none", calls: 0, amountCents: 0, invoiceId: null, at } satisfies OverageMarker));
        return "skipped";
      }
      const centsPerCall = config.overageCentsPerCall;
      const billed = await stripe.billExtraCalls({
        tenantId, customerId: subscription.providerCustomerId, subscriptionId: subscription.providerSubscriptionId,
        periodStart, periodEnd, calls, centsPerCall, invoiceId: saved?.invoiceId ?? null,
        // Saved before the line is added, so a crash after this point reuses the invoice instead of opening a second one.
        onInvoiceCreated: (invoiceId) => this.store.saveIntegrationSecret(tenantId, "billing", key, JSON.stringify({ state: "invoice_created", calls, amountCents: calls * centsPerCall, invoiceId, at } satisfies OverageMarker)),
      });
      await this.store.saveIntegrationSecret(tenantId, "billing", key, JSON.stringify({ state: "billed", calls, amountCents: billed.amountCents, invoiceId: billed.invoiceId, at } satisfies OverageMarker));
      this.log({ level: "info", event: "overage_billed", tenantId, periodStart, periodEnd, calls, amountCents: billed.amountCents, invoiceId: billed.invoiceId });
      return "billed";
    });
  }
}

export type GuaranteeState = "none" | "watching" | "eligible" | "refunded" | "closed";
export interface GuaranteeStatus {
  state: GuaranteeState;
  /** Real customer leads in the first 30 days so far. */
  leads: number;
  /** When the 30 days end, and when the refund offer closes (day 37). */
  windowEndsAt: string | null;
  claimUntil: string | null;
  refund: { amountCents: number; at: string } | null;
}
type RefundMarker = GuaranteeRefund & { at: string; by: "owner" | "admin"; leads: number };

export class GuaranteeError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * The lead guarantee: no real customer lead in the first 30 days after the first payment, and the
 * owner can refund their first month (days 30–37) with one tap; support can do it from the admin
 * endpoint (the "reply to your receipt" path). One refund per shop, ever.
 */
export class LeadGuaranteeService {
  constructor(private readonly store: Store, private readonly stripe: Pick<StripeBillingClient, "refundFirstInvoice"> | null, private readonly clock: Clock, private readonly log: Log = () => undefined) {}

  async status(tenantId: string): Promise<GuaranteeStatus> {
    const refundRaw = await this.store.getIntegrationSecret(tenantId, "billing", "lead_refund");
    const paidAt = await firstPaidAt(this.store, tenantId);
    const refund = refundRaw ? JSON.parse(refundRaw) as RefundMarker : null;
    if (!paidAt) return { state: refund ? "refunded" : "none", leads: 0, windowEndsAt: null, claimUntil: null, refund: refund ? { amountCents: refund.amountCents, at: refund.at } : null };
    const start = Date.parse(paidAt);
    const windowEnd = start + GUARANTEE_WINDOW_DAYS * DAY_MS;
    const claimUntil = start + GUARANTEE_CLAIM_DAYS * DAY_MS;
    const now = this.clock.now().getTime();
    const leads = await this.countLeads(tenantId, start, Math.min(now, windowEnd));
    const base = { leads, windowEndsAt: new Date(windowEnd).toISOString(), claimUntil: new Date(claimUntil).toISOString() };
    if (refund) return { ...base, state: "refunded", refund: { amountCents: refund.amountCents, at: refund.at } };
    const state: GuaranteeState = now < windowEnd ? "watching" : now <= claimUntil && leads === 0 ? "eligible" : "closed";
    return { ...base, state, refund: null };
  }

  /**
   * Refund the first month, enforced here, never on trust: the server re-counts qualifying leads in the
   * first 30 days and refuses (409) if there is even one. Owners can claim on days 30–37; support (a reply
   * to the receipt) may refund a late claim, but only under the same zero-lead check. Idempotent, once per shop.
   */
  async refund(tenantId: string, by: "owner" | "admin"): Promise<RefundMarker> {
    const stripe = this.stripe;
    if (!stripe) throw new GuaranteeError("Refunds aren’t available right now. Reply to your receipt and we’ll handle it.", 503);
    return this.store.withLock(`billing:${tenantId}`, async () => {
      const existing = await this.store.getIntegrationSecret(tenantId, "billing", "lead_refund");
      if (existing) return JSON.parse(existing) as RefundMarker;
      const status = await this.status(tenantId);
      if (status.leads > 0) {
        throw new GuaranteeError(`Front Office sent you ${status.leads} real ${status.leads === 1 ? "lead" : "leads"} in your first 30 days, so the lead guarantee doesn’t apply.`, 409);
      }
      if (status.state === "watching") throw new GuaranteeError("Your first 30 days aren’t over yet.", 409);
      const allowed = status.state === "eligible" || (by === "admin" && status.state === "closed");
      if (!allowed) throw new GuaranteeError("This shop isn’t eligible for the lead guarantee refund.", 409);
      const subscription = await this.store.getSubscription(tenantId);
      if (!subscription?.providerSubscriptionId) throw new GuaranteeError("There’s no paid subscription to refund.", 409);
      const refund = await stripe.refundFirstInvoice({ tenantId, subscriptionId: subscription.providerSubscriptionId });
      const marker: RefundMarker = { ...refund, at: this.clock.now().toISOString(), by, leads: status.leads };
      await this.store.saveIntegrationSecret(tenantId, "billing", "lead_refund", JSON.stringify(marker));
      this.log({ level: "warn", event: "lead_guarantee_refunded", tenantId, by, leads: status.leads, amountCents: refund.amountCents, refundId: refund.refundId, invoiceId: refund.invoiceId });
      return marker;
    });
  }

  private async countLeads(tenantId: string, fromMs: number, toMs: number): Promise<number> {
    const [calls, tasks, bookings] = await Promise.all([
      this.store.listCalls(tenantId, 5_000),
      this.store.listCallbackTasks(tenantId, 5_000),
      this.store.listBookingsForTenant(tenantId),
    ]);
    const followed = new Set([
      ...tasks.filter((task) => task.status !== "cancelled").map((task) => task.callId),
      ...bookings.filter((booking) => booking.status === "confirmed" || booking.status === "pending").map((booking) => booking.callId),
    ]);
    return calls.filter((call) => {
      const at = Date.parse(call.startedAt);
      return at >= fromMs && at <= toMs && isQualifyingLead(call, followed.has(call.id));
    }).length;
  }
}
