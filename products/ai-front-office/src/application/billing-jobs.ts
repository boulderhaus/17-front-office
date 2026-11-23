import type { GuaranteeRefund, StripeBillingClient } from "../adapters/stripe.js";
import type { PlanId } from "../domain/plans.js";
import { extraCallsWithUnlimited, isQualifyingLead, lastClosedBillingPeriod } from "../domain/usage.js";
import type { Clock, Store } from "../ports.js";

const DAY_MS = 24 * 60 * 60_000;
/** The guarantee watches the first 30 days after the first successful charge… */
export const GUARANTEE_WINDOW_DAYS = 30;
/** …and the refund button stays up for a week after that (days 30–37). */
export const GUARANTEE_CLAIM_DAYS = 37;
/** A closed period is re-checked (late call records) until this long after it ends, then never billed. */
const OVERAGE_LOOKBACK_DAYS = 35;
/** Calls read for the lead check. A full page means the scan is incomplete, and then the refund is refused. */
export const LEAD_SCAN_LIMIT = 10_000;

type Log = (entry: Record<string, unknown>) => void;

/**
 * When the shop was first charged successfully (from Stripe's invoice.paid or a paid checkout). The guarantee
 * window and overage clamping start here. Keeps the earliest time, whatever order the events arrive in.
 */
export async function recordFirstPaid(store: Store, tenantId: string, at: string): Promise<void> {
  if (Number.isNaN(Date.parse(at))) return;
  const existing = await store.getIntegrationSecret(tenantId, "billing", "first_paid_at");
  if (existing && Date.parse(existing) <= Date.parse(at)) return;
  await store.saveIntegrationSecret(tenantId, "billing", "first_paid_at", at);
}

/** Only a recorded charge counts: no guess from the subscription record. Null means unknown. */
export async function firstPaidAt(store: Store, tenantId: string): Promise<string | null> {
  return store.getIntegrationSecret(tenantId, "billing", "first_paid_at");
}

/** When the Unlimited add-on was on: [from, to) windows, to = null while it still is. Append-only. */
export interface UnlimitedWindow { from: string; to: string | null }

export async function unlimitedWindows(store: Store, tenantId: string): Promise<UnlimitedWindow[]> {
  const raw = await store.getIntegrationSecret(tenantId, "billing", "unlimited_windows");
  return raw ? JSON.parse(raw) as UnlimitedWindow[] : [];
}

/**
 * Record that Stripe bills (on) or stopped billing (off) the Unlimited add-on at `at`. Idempotent: on with a
 * window already open, or off with none open, changes nothing. The overage job uses these windows, so calls made
 * before the add-on was turned on still count against the plan's included calls.
 */
export async function recordUnlimited(store: Store, tenantId: string, on: boolean, at: string): Promise<void> {
  const windows = await unlimitedWindows(store, tenantId);
  const last = windows.at(-1);
  const open = last && last.to === null ? last : null;
  if (on === Boolean(open)) return;
  if (on) windows.push({ from: at, to: null });
  else if (open) open.to = Date.parse(at) > Date.parse(open.from) ? at : open.from;
  await store.saveIntegrationSecret(tenantId, "billing", "unlimited_windows", JSON.stringify(windows));
}

/** One closed period's overage record. The allowance and rate are snapshotted when the period is first seen closed. */
interface OverageMarker {
  state: "none" | "invoice_created" | "billed";
  calls: number;
  amountCents: number;
  invoiceId: string | null;
  at: string;
  /** Snapshot of the plan for this period: retries and later plan changes never move it. */
  planId: PlanId;
  includedCalls: number;
  centsPerCall: number;
  /** The calls counted: from max(period start, first charge) to period end. */
  usageFrom: string;
}

/**
 * Period-end overage: once a billing period closes, every counted call past the period's included calls is
 * billed once as its own Stripe invoice (N × $0.75). With the Unlimited add-on, calls made while it was on are
 * free up to fair use (3× the period's included calls), charged to the subscription's card. "Nothing extra" is not
 * final: the period is re-counted (late call records) until the lookback ends. Runs on every replica under the
 * shop's billing lock; a per-period marker plus Stripe idempotency keys make it bill once.
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
      // Never bill calls from before the first charge: the window starts at the later of the two.
      const paidAt = await firstPaidAt(this.store, tenantId);
      if (!paidAt) return "skipped";
      const usageFrom = new Date(Math.max(Date.parse(periodStart), Date.parse(paidAt))).toISOString();
      if (Date.parse(usageFrom) >= Date.parse(periodEnd)) return "skipped";
      const key = `overage:${periodStart}`;
      const savedRaw = await this.store.getIntegrationSecret(tenantId, "billing", key);
      const saved = savedRaw ? JSON.parse(savedRaw) as Partial<OverageMarker> : null;
      if (saved?.state === "billed") return "skipped";
      const config = await this.store.getConfig(tenantId);
      // The plan this period closed on. Saved with the first look, reused on every retry and after plan changes.
      const snapshot = saved?.includedCalls !== undefined && saved.centsPerCall !== undefined && saved.planId
        ? { planId: saved.planId, includedCalls: saved.includedCalls, centsPerCall: saved.centsPerCall }
        : { planId: config.planId ?? "solo", includedCalls: config.includedCalls, centsPerCall: config.overageCentsPerCall };
      const at = now.toISOString();
      const marker = (state: OverageMarker["state"], calls: number, invoiceId: string | null): string => JSON.stringify({
        state, calls, amountCents: calls * snapshot.centsPerCall, invoiceId, at, ...snapshot, usageFrom,
      } satisfies OverageMarker);
      let calls: number;
      if (saved?.state === "invoice_created" && typeof saved.calls === "number") {
        calls = saved.calls;
      } else {
        const usage = await this.store.getUsageSummary(tenantId, usageFrom, periodEnd);
        // Calls made while the Unlimited add-on was on are covered up to fair use; the rest use the plan's calls.
        let covered = 0;
        for (const window of await unlimitedWindows(this.store, tenantId)) {
          const from = Math.max(Date.parse(window.from), Date.parse(usageFrom));
          const to = Math.min(window.to === null ? Infinity : Date.parse(window.to), Date.parse(periodEnd));
          if (to > from) covered += (await this.store.getUsageSummary(tenantId, new Date(from).toISOString(), new Date(to).toISOString())).billableCalls;
        }
        calls = extraCallsWithUnlimited({ countedCalls: usage.billableCalls, callsWithoutUnlimited: usage.billableCalls - covered, includedCalls: snapshot.includedCalls });
      }
      if (calls <= 0) {
        // Not final: a late call record can still push the period over, until the lookback ends.
        await this.store.saveIntegrationSecret(tenantId, "billing", key, marker("none", 0, null));
        return "skipped";
      }
      const billed = await stripe.billExtraCalls({
        tenantId, customerId: subscription.providerCustomerId, subscriptionId: subscription.providerSubscriptionId,
        periodStart, periodEnd, calls, centsPerCall: snapshot.centsPerCall, invoiceId: saved?.invoiceId ?? null,
        // Saved before the line is added, so a crash after this point reuses the invoice instead of opening a second one.
        onInvoiceCreated: (invoiceId) => this.store.saveIntegrationSecret(tenantId, "billing", key, marker("invoice_created", calls, invoiceId)),
      });
      await this.store.saveIntegrationSecret(tenantId, "billing", key, marker("billed", calls, billed.invoiceId));
      this.log({ level: "info", event: "overage_billed", tenantId, periodStart, periodEnd, usageFrom, calls, includedCalls: snapshot.includedCalls, amountCents: billed.amountCents, invoiceId: billed.invoiceId });
      return "billed";
    });
  }
}

export type GuaranteeState = "none" | "watching" | "eligible" | "pending" | "refunded" | "closed";
export interface GuaranteeStatus {
  state: GuaranteeState;
  /** Real customer leads in the first 30 days so far. */
  leads: number;
  /** False when the lead check couldn't read every call in the window: never eligible then. */
  complete: boolean;
  /** When the 30 days end, and when the refund offer closes (day 37). */
  windowEndsAt: string | null;
  claimUntil: string | null;
  refund: { amountCents: number; at: string } | null;
}
type RefundMarker =
  | { state: "pending"; at: string; by: "owner" | "admin"; leads: number; subscriptionId: string }
  | (GuaranteeRefund & { state: "refunded"; at: string; by: "owner" | "admin"; leads: number; subscriptionId: string });

export class GuaranteeError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * The lead guarantee: no real customer lead in the first 30 days after the first successful charge, and the
 * owner can refund their first month (days 30–37) with one tap; support can do it from the admin endpoint (the
 * "reply to your receipt" path) under the same check. Enforced here, never on trust. One refund per shop, ever.
 */
export class LeadGuaranteeService {
  constructor(private readonly store: Store, private readonly stripe: Pick<StripeBillingClient, "refundFirstInvoice"> | null, private readonly clock: Clock, private readonly log: Log = () => undefined) {}

  async status(tenantId: string): Promise<GuaranteeStatus> {
    const marker = await this.marker(tenantId);
    const paidAt = await firstPaidAt(this.store, tenantId);
    const none = { leads: 0, complete: true, windowEndsAt: null, claimUntil: null, refund: null };
    if (marker?.state === "refunded") return { ...none, state: "refunded", refund: { amountCents: marker.amountCents, at: marker.at } };
    if (marker?.state === "pending") return { ...none, state: "pending" };
    if (!paidAt) return { ...none, state: "none" };
    const start = Date.parse(paidAt);
    const windowEnd = start + GUARANTEE_WINDOW_DAYS * DAY_MS;
    const claimUntil = start + GUARANTEE_CLAIM_DAYS * DAY_MS;
    const now = this.clock.now().getTime();
    const scan = await this.scanLeads(tenantId, start, Math.min(now, windowEnd));
    const state: GuaranteeState = now < windowEnd ? "watching" : now <= claimUntil && scan.complete && scan.leads === 0 ? "eligible" : "closed";
    return { state, leads: scan.leads, complete: scan.complete, windowEndsAt: new Date(windowEnd).toISOString(), claimUntil: new Date(claimUntil).toISOString(), refund: null };
  }

  /**
   * Refund the first month. The server re-counts qualifying leads and refuses (409) on even one, on an
   * incomplete scan, or without a recorded first charge. A pending marker is written before Stripe is called,
   * so a retry finishes the same refund (Stripe also dedupes by key and by the refund's metadata).
   */
  async refund(tenantId: string, by: "owner" | "admin"): Promise<RefundMarker> {
    const stripe = this.stripe;
    if (!stripe) throw new GuaranteeError("Refunds aren’t available right now. Reply to your receipt and we’ll handle it.", 503);
    return this.store.withLock(`billing:${tenantId}`, async () => {
      let marker = await this.marker(tenantId);
      if (marker?.state === "refunded") return marker;
      if (!marker) {
        if (!await firstPaidAt(this.store, tenantId)) throw new GuaranteeError("We can’t confirm when you were first charged yet. Reply to your receipt and we’ll sort it out.", 409);
        const status = await this.status(tenantId);
        if (!status.complete) throw new GuaranteeError("We couldn’t check every call from your first 30 days. Reply to your receipt and we’ll review it.", 409);
        if (status.leads > 0) throw new GuaranteeError(`Front Office sent you ${status.leads} real ${status.leads === 1 ? "lead" : "leads"} in your first 30 days, so the lead guarantee doesn’t apply.`, 409);
        if (status.state === "watching") throw new GuaranteeError("Your first 30 days aren’t over yet.", 409);
        const allowed = status.state === "eligible" || (by === "admin" && status.state === "closed");
        if (!allowed) throw new GuaranteeError("This shop isn’t eligible for the lead guarantee refund.", 409);
        const subscription = await this.store.getSubscription(tenantId);
        if (!subscription?.providerSubscriptionId) throw new GuaranteeError("There’s no paid subscription to refund.", 409);
        marker = { state: "pending", at: this.clock.now().toISOString(), by, leads: status.leads, subscriptionId: subscription.providerSubscriptionId };
        await this.store.saveIntegrationSecret(tenantId, "billing", "lead_refund", JSON.stringify(marker));
      }
      const refund = await stripe.refundFirstInvoice({ tenantId, subscriptionId: marker.subscriptionId });
      const done: RefundMarker = { ...refund, state: "refunded", at: this.clock.now().toISOString(), by: marker.by, leads: marker.leads, subscriptionId: marker.subscriptionId };
      await this.store.saveIntegrationSecret(tenantId, "billing", "lead_refund", JSON.stringify(done));
      this.log({ level: "warn", event: "lead_guarantee_refunded", tenantId, by: done.by, leads: done.leads, amountCents: refund.amountCents, refundId: refund.refundId, invoiceId: refund.invoiceId });
      return done;
    });
  }

  private async marker(tenantId: string): Promise<RefundMarker | null> {
    const raw = await this.store.getIntegrationSecret(tenantId, "billing", "lead_refund");
    return raw ? JSON.parse(raw) as RefundMarker : null;
  }

  /** Leads among calls that started in [from, to): a windowed read, never a capped page of recent calls. */
  private async scanLeads(tenantId: string, fromMs: number, toMs: number): Promise<{ leads: number; complete: boolean }> {
    if (toMs <= fromMs) return { leads: 0, complete: true };
    const calls = await this.store.listCallsStartedBetween(tenantId, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), LEAD_SCAN_LIMIT + 1);
    const complete = calls.length <= LEAD_SCAN_LIMIT;
    const window = calls.slice(0, LEAD_SCAN_LIMIT);
    const [tasks, bookings] = await Promise.all([
      this.store.listCallbackTasksForCalls(tenantId, window.map((call) => call.id)),
      this.store.listBookingsForTenant(tenantId),
    ]);
    const followed = new Set([
      ...tasks.filter((task) => task.status !== "cancelled").map((task) => task.callId),
      ...bookings.filter((booking) => booking.status === "confirmed" || booking.status === "pending").map((booking) => booking.callId),
    ]);
    return { leads: window.filter((call) => isQualifyingLead(call, followed.has(call.id))).length, complete };
  }
}
