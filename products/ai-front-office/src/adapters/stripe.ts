import { createHmac, timingSafeEqual } from "node:crypto";
import { withTimeout } from "../application/retry.js";
import type { SubscriptionRecord } from "../domain/models.js";
import type { PlanId } from "../domain/plans.js";

export interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
}

export interface StripePrices {
  /** Solo. */
  base: string;
  pro?: string;
  team?: string;
  fleet?: string;
  /** Older prices still on live subscriptions (e.g. STRIPE_PRICE_ID_PLUS once STRIPE_PRICE_ID_PRO is set): recognized, never sold. */
  legacy?: string[];
  /** The Unlimited calls add-on, one price per plan: a second subscription item next to the plan's. */
  unlimited?: Partial<Record<PlanId, string>>;
  dailySms?: string;
  realtimeSms?: string;
}

/** A refund made under the lead guarantee. */
export interface GuaranteeRefund { refundId: string; amountCents: number; invoiceId: string }

export interface StripeSubscriptionSnapshot {
  id: string;
  status: SubscriptionRecord["status"];
  customer: string | null;
  tenantId: string | null;
  priceIds: string[];
  currentPeriodEnd: string | null;
}

const PORTAL_CONFIGURATION_TAG = "v1";

export class StripeBillingClient {
  private portalConfiguration: string | null = null;
  constructor(private readonly secretKey: string, private readonly prices: StripePrices, private readonly fetcher: typeof fetch = fetch) {}

  get basePriceId(): string { return this.prices.base; }

  /** The Stripe price for a plan, or undefined when that plan isn't for sale here. */
  planPrice(plan: PlanId): string | undefined {
    return plan === "solo" ? this.prices.base : this.prices[plan];
  }

  private planPrices(): string[] {
    return [this.prices.base, this.prices.pro, this.prices.team, this.prices.fleet, ...(this.prices.legacy ?? [])].filter((value): value is string => Boolean(value));
  }

  /** The Unlimited add-on price for a plan, or undefined when that plan doesn't offer it here. */
  unlimitedPrice(plan: PlanId): string | undefined {
    return this.prices.unlimited?.[plan];
  }

  private unlimitedPrices(): string[] {
    return Object.values(this.prices.unlimited ?? {}).filter((value): value is string => Boolean(value));
  }

  /** True when a subscription's prices include one of our plans (not just an add-on or a stranger's price). */
  hasPlanPrice(priceIds: string[]): boolean {
    return this.planPrices().some((price) => priceIds.includes(price));
  }

  private async post(path: string, body: URLSearchParams, idempotencyKey?: string): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> & { id?: string; error?: { message?: string; code?: string } } }> {
    const response = await withTimeout(this.fetcher(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body,
    }), 8_000);
    const payload = await response.json().catch(() => ({})) as Record<string, unknown> & { id?: string; error?: { message?: string; code?: string } };
    return { ok: response.ok, status: response.status, payload };
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const response = await withTimeout(this.fetcher(`https://api.stripe.com/v1/${path}`, { headers: { authorization: `Bearer ${this.secretKey}` } }), 8_000);
    const payload = await response.json().catch(() => ({})) as Record<string, unknown> & { error?: { message?: string } };
    if (!response.ok) throw new Error(`Stripe GET ${path.split("?")[0]} failed with HTTP ${response.status}${payload.error?.message ? `: ${payload.error.message}` : ""}`);
    return payload;
  }

  /**
   * Put a paying subscription on a plan, with or without the Unlimited add-on, prorated: the plan item's price
   * is swapped, the add-on item is added, re-priced for the new plan, or removed, all in one update, and Stripe
   * invoices the difference now (credit for a downgrade). Other add-on items (SMS) are left alone. No change, no write.
   */
  async changePlan(subscriptionId: string, plan: PlanId, options: { unlimited?: boolean } = {}): Promise<void> {
    const price = requiredPrice(this.planPrice(plan), `${plan} plan`);
    const unlimited = options.unlimited === true;
    const addOnPrice = unlimited ? requiredPrice(this.unlimitedPrice(plan), `${plan} Unlimited add-on`) : null;
    const subscription = await this.get(`subscriptions/${encodeURIComponent(subscriptionId)}`) as { items?: { data?: Array<{ id?: string; price?: { id?: string } }> } };
    const items = subscription.items?.data ?? [];
    const ours = this.planPrices();
    const addOns = this.unlimitedPrices();
    const item = items.find((entry) => entry.price?.id && ours.includes(entry.price.id));
    if (!item?.id) throw new Error("Stripe subscription has no Front Office plan item");
    const addOnItem = items.find((entry) => entry.price?.id && addOns.includes(entry.price.id));
    const changes: Array<{ id?: string; price?: string; deleted?: boolean }> = [];
    if (item.price?.id !== price) changes.push({ id: item.id, price });
    if (addOnPrice && !addOnItem) changes.push({ price: addOnPrice });
    else if (addOnPrice && addOnItem?.id && addOnItem.price?.id !== addOnPrice) changes.push({ id: addOnItem.id, price: addOnPrice });
    else if (!addOnPrice && addOnItem?.id) changes.push({ id: addOnItem.id, deleted: true });
    if (changes.length === 0) return;
    const body = new URLSearchParams();
    changes.forEach((change, index) => {
      if (change.id) body.set(`items[${index}][id]`, change.id);
      if (change.price) {
        body.set(`items[${index}][price]`, change.price);
        body.set(`items[${index}][quantity]`, "1");
      }
      if (change.deleted) body.set(`items[${index}][deleted]`, "true");
    });
    body.set("proration_behavior", "always_invoice");
    body.set("payment_behavior", "error_if_incomplete");
    body.set("metadata[plan]", plan);
    body.set("metadata[unlimited]", unlimited ? "yes" : "no");
    const update = await this.post(`subscriptions/${encodeURIComponent(subscriptionId)}`, body);
    if (!update.ok || update.payload.id !== subscriptionId) throw new Error(`Stripe plan change failed with HTTP ${update.status}${update.payload.error?.message ? `: ${update.payload.error.message}` : ""}`);
  }

  /**
   * Bill a closed period's extra calls as their own invoice, charged to the card on file. Each step has an
   * idempotency key and the caller saves the invoice id between steps, so a retry never bills twice.
   * Returns the invoice id once it is finalized (Stripe then collects it automatically).
   */
  async billExtraCalls(input: { tenantId: string; customerId: string; subscriptionId: string | null; periodStart: string; periodEnd: string; calls: number; centsPerCall: number; invoiceId?: string | null; onInvoiceCreated?: (invoiceId: string) => Promise<void> }): Promise<{ invoiceId: string; amountCents: number }> {
    const key = `fo-overage:${input.tenantId}:${input.periodStart}`;
    const range = `${shortDate(input.periodStart)} – ${shortDate(input.periodEnd)}`;
    const description = `Extra answered calls, ${range}: ${input.calls} × ${input.centsPerCall < 100 ? `${input.centsPerCall}¢` : `$${(input.centsPerCall / 100).toFixed(2)}`}`;
    const metadata = { "metadata[tenant_id]": input.tenantId, "metadata[front_office]": "extra_calls", "metadata[period_start]": input.periodStart, "metadata[period_end]": input.periodEnd };
    let invoiceId = input.invoiceId ?? null;
    if (!invoiceId) {
      const created = await this.post("invoices", new URLSearchParams({
        customer: input.customerId,
        collection_method: "charge_automatically",
        auto_advance: "false",
        pending_invoice_items_behavior: "exclude",
        description: "Front Office extra calls",
        // On the subscription, so Stripe charges the card the subscription pays with.
        ...(input.subscriptionId ? { subscription: input.subscriptionId } : {}),
        ...metadata,
      }), `${key}:invoice`);
      if (!created.ok || typeof created.payload.id !== "string") throw new Error(`Stripe overage invoice failed with HTTP ${created.status}${created.payload.error?.message ? `: ${created.payload.error.message}` : ""}`);
      invoiceId = created.payload.id;
      await input.onInvoiceCreated?.(invoiceId);
    }
    const invoice = await this.get(`invoices/${encodeURIComponent(invoiceId)}`) as { status?: string; lines?: { data?: Array<{ metadata?: Record<string, string> }> }; amount_due?: number };
    const hasLine = (invoice.lines?.data ?? []).some((line) => line.metadata?.front_office === "extra_calls");
    if (invoice.status === "draft" && !hasLine) {
      const item = await this.post("invoiceitems", new URLSearchParams({
        customer: input.customerId,
        invoice: invoiceId,
        currency: "usd",
        quantity: String(input.calls),
        unit_amount_decimal: String(input.centsPerCall),
        description,
        "period[start]": String(Math.floor(Date.parse(input.periodStart) / 1_000)),
        "period[end]": String(Math.floor(Date.parse(input.periodEnd) / 1_000)),
        ...metadata,
      }), `${key}:item`);
      if (!item.ok) throw new Error(`Stripe overage item failed with HTTP ${item.status}${item.payload.error?.message ? `: ${item.payload.error.message}` : ""}`);
    }
    if (invoice.status === "draft") {
      const finalized = await this.post(`invoices/${encodeURIComponent(invoiceId)}/finalize`, new URLSearchParams({ auto_advance: "true" }), `${key}:finalize`);
      if (!finalized.ok) throw new Error(`Stripe overage finalize failed with HTTP ${finalized.status}${finalized.payload.error?.message ? `: ${finalized.payload.error.message}` : ""}`);
    }
    return { invoiceId, amountCents: input.calls * input.centsPerCall };
  }

  /**
   * Refund the subscription's first paid invoice in full (the lead guarantee). Idempotent per shop:
   * the same key always returns the same refund. Works with both the older invoice.charge /
   * invoice.payment_intent fields and the newer invoice payments list.
   */
  async refundFirstInvoice(input: { tenantId: string; subscriptionId: string }): Promise<GuaranteeRefund> {
    const list = await this.get(`invoices?subscription=${encodeURIComponent(input.subscriptionId)}&status=paid&limit=100`) as { data?: Array<{ id?: string; amount_paid?: number; created?: number; charge?: string | { id?: string } | null; payment_intent?: string | { id?: string } | null }> };
    const first = (list.data ?? []).filter((invoice) => typeof invoice.id === "string" && (invoice.amount_paid ?? 0) > 0)
      .sort((left, right) => (left.created ?? 0) - (right.created ?? 0))[0];
    if (!first?.id) throw new Error("No paid first invoice to refund");
    const idOf = (value: string | { id?: string } | null | undefined): string | null => typeof value === "string" ? value : value?.id ?? null;
    let target: { charge: string } | { payment_intent: string } | null = idOf(first.charge) ? { charge: idOf(first.charge)! } : idOf(first.payment_intent) ? { payment_intent: idOf(first.payment_intent)! } : null;
    if (!target) {
      const payments = await this.get(`invoice_payments?invoice=${encodeURIComponent(first.id)}&status=paid&limit=10`) as { data?: Array<{ payment?: { type?: string; payment_intent?: string | { id?: string }; charge?: string | { id?: string } } }> };
      const payment = payments.data?.[0]?.payment;
      const intent = idOf(payment?.payment_intent);
      const charge = idOf(payment?.charge);
      target = intent ? { payment_intent: intent } : charge ? { charge } : null;
    }
    if (!target) throw new Error("The first invoice has no card payment to refund");
    // A refund made by an earlier attempt (even past the 24-hour idempotency window) is returned, never repeated.
    const query = "charge" in target ? `charge=${encodeURIComponent(target.charge)}` : `payment_intent=${encodeURIComponent(target.payment_intent)}`;
    const earlier = await this.get(`refunds?${query}&limit=100`) as { data?: Array<{ id?: string; amount?: number; status?: string; metadata?: Record<string, string> }> };
    const made = earlier.data?.find((item) => item.metadata?.front_office === "lead_guarantee" && item.metadata?.tenant_id === input.tenantId && item.status !== "failed" && item.status !== "canceled");
    if (made?.id) return { refundId: made.id, amountCents: made.amount ?? first.amount_paid ?? 0, invoiceId: first.id };
    const refund = await this.post("refunds", new URLSearchParams({
      ...target,
      reason: "requested_by_customer",
      "metadata[tenant_id]": input.tenantId,
      "metadata[front_office]": "lead_guarantee",
      "metadata[invoice_id]": first.id,
    }), `lead-refund:${input.tenantId}`);
    if (!refund.ok || typeof refund.payload.id !== "string") throw new Error(`Stripe refund failed with HTTP ${refund.status}${refund.payload.error?.message ? `: ${refund.payload.error.message}` : ""}`);
    return { refundId: refund.payload.id, amountCents: typeof refund.payload.amount === "number" ? refund.payload.amount : first.amount_paid ?? 0, invoiceId: first.id };
  }

  private async findPortalConfiguration(): Promise<string | null> {
    const response = await withTimeout(this.fetcher("https://api.stripe.com/v1/billing_portal/configurations?active=true&limit=100", {
      headers: { authorization: `Bearer ${this.secretKey}` },
    }), 6_000);
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({})) as { data?: Array<{ id?: string; metadata?: Record<string, string> }> };
    return payload.data?.find((item) => item.metadata?.front_office === PORTAL_CONFIGURATION_TAG)?.id ?? null;
  }

  async createPortal(customerId: string, returnUrl: string): Promise<string> {
    if (!this.portalConfiguration) this.portalConfiguration = await this.findPortalConfiguration();
    if (!this.portalConfiguration) {
      // No permanent idempotency key: Stripe replays a stored failure for 24 hours and
      // rejects the same key with a changed body. A tagged configuration is found next time.
      const body = new URLSearchParams({
        "metadata[front_office]": PORTAL_CONFIGURATION_TAG,
        "business_profile[headline]": "Manage your Front Office subscription",
        "features[subscription_cancel][enabled]": "true",
        "features[subscription_cancel][mode]": "at_period_end",
        "features[payment_method_update][enabled]": "true",
        "features[invoice_history][enabled]": "true",
      });
      const response = await withTimeout(this.fetcher("https://api.stripe.com/v1/billing_portal/configurations", {
        method: "POST", headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" }, body,
      }), 6_000);
      const data = await response.json() as { id?: string };
      if (!response.ok || !data.id) throw new Error(`Stripe billing portal configuration failed with HTTP ${response.status}`);
      this.portalConfiguration = data.id;
    }
    const response = await withTimeout(this.fetcher("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST", headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ customer: customerId, configuration: this.portalConfiguration, return_url: returnUrl }),
    }), 6_000);
    const data = await response.json() as { url?: string };
    if (!response.ok || !data.url?.startsWith("https://billing.stripe.com/")) throw new Error(`Stripe billing portal failed with HTTP ${response.status}`);
    return data.url;
  }

  async createCheckout(input: { tenantId: string; email: string; customerId?: string | null; successUrl: string; cancelUrl: string; idempotencyKey: string; dailySms: boolean; realtimeSms: boolean; now?: Date; trialDays?: number; submitMessage?: string; plan?: PlanId; unlimited?: boolean; couponId?: string | null }): Promise<{ id: string; url: string; expiresAt: string }> {
    // Sessions expire in ~31 minutes (Stripe's minimum is 30) so a stale one cannot be paid later.
    const expiresAt = Math.floor((input.now ?? new Date()).getTime() / 1_000) + 31 * 60;
    const body = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": requiredPrice(this.planPrice(input.plan ?? "solo"), `${input.plan ?? "solo"} plan`),
      "line_items[0][quantity]": "1",
      // A returning shop keeps its Stripe customer instead of getting a second one.
      ...(input.customerId ? { customer: input.customerId } : { customer_email: input.email }),
      expires_at: String(expiresAt),
      client_reference_id: input.tenantId,
      "metadata[tenant_id]": input.tenantId,
      "subscription_data[metadata][tenant_id]": input.tenantId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // Card upfront every time, trial or not.
      payment_method_collection: "always",
    });
    if (input.trialDays && input.trialDays > 0) body.set("subscription_data[trial_period_days]", String(Math.floor(input.trialDays)));
    // First month half off: a once-only coupon on the first invoice (all of it, the Unlimited add-on included: the
    // coupon has no product restriction). Never alongside a trial (it would land on the $0 invoice).
    else if (input.couponId) body.set("discounts[0][coupon]", input.couponId);
    // Said again on Stripe's page, right above the button, so nobody is surprised by the charge date.
    if (input.submitMessage) body.set("custom_text[submit][message]", input.submitMessage.slice(0, 1_000));
    let lineItem = 1;
    if (input.unlimited) {
      // The Unlimited add-on: its own item, so it can be turned off later without touching the plan.
      body.set(`line_items[${lineItem}][price]`, requiredPrice(this.unlimitedPrice(input.plan ?? "solo"), `${input.plan ?? "solo"} Unlimited add-on`));
      body.set(`line_items[${lineItem}][quantity]`, "1");
      lineItem += 1;
    }
    for (const [enabled, price, label] of [[input.dailySms, this.prices.dailySms, "daily SMS"], [input.realtimeSms, this.prices.realtimeSms, "instant lead SMS"]] as const) {
      if (!enabled) continue;
      body.set(`line_items[${lineItem}][price]`, requiredPrice(price, label));
      body.set(`line_items[${lineItem}][quantity]`, "1");
      lineItem += 1;
    }
    const response = await withTimeout(this.fetcher("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": input.idempotencyKey,
      },
      body,
    }), 6_000);
    const payload = await response.json().catch(() => ({})) as { id?: string; url?: string; error?: { message?: string } };
    if (!response.ok || !payload.url?.startsWith("https://") || !payload.id) throw new Error(`Stripe checkout failed with HTTP ${response.status}${payload.error?.message ? `: ${payload.error.message}` : ""}`);
    return { id: payload.id, url: payload.url, expiresAt: new Date(expiresAt * 1_000).toISOString() };
  }

  /** A finished Checkout Session, read back when the owner returns, before the webhook may have landed. */
  async retrieveCheckoutSession(sessionId: string): Promise<{ id: string; status: string; paymentStatus: string | null; tenantId: string | null; subscriptionId: string | null }> {
    const response = await withTimeout(this.fetcher(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${this.secretKey}` },
    }), 6_000);
    const payload = await response.json().catch(() => ({})) as { id?: string; status?: string; payment_status?: string; client_reference_id?: string | null; subscription?: string | { id?: string } | null };
    if (!response.ok || payload.id !== sessionId) throw new Error(`Stripe checkout lookup failed with HTTP ${response.status}`);
    const subscription = typeof payload.subscription === "string" ? payload.subscription : payload.subscription?.id ?? null;
    return { id: payload.id, status: payload.status ?? "open", paymentStatus: payload.payment_status ?? null, tenantId: payload.client_reference_id ?? null, subscriptionId: subscription };
  }

  /** Expire an unpaid Checkout Session so it can no longer start a subscription. */
  /** Returns "complete" if the session was already paid; a new checkout must not be created then. */
  async expireCheckout(sessionId: string): Promise<"expired" | "complete"> {
    const response = await withTimeout(this.fetcher(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
      method: "POST", headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
    }), 6_000);
    if (response.ok) return "expired";
    if (response.status !== 400) throw new Error(`Stripe checkout expire failed with HTTP ${response.status}`);
    // 400: already expired or already completed. Find out which.
    const current = await withTimeout(this.fetcher(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${this.secretKey}` },
    }), 6_000);
    const session = await current.json().catch(() => ({})) as { status?: string };
    if (!current.ok) throw new Error(`Stripe checkout lookup failed with HTTP ${current.status}`);
    return session.status === "complete" ? "complete" : "expired";
  }

  /**
   * Current subscription state from Stripe. Webhook order is not guaranteed and
   * Stripe advises against ordering by event timestamps, so the API is the source of truth.
   */
  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionSnapshot> {
    const response = await withTimeout(this.fetcher(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { authorization: `Bearer ${this.secretKey}` },
    }), 6_000);
    const payload = await response.json().catch(() => ({})) as {
      id?: string; status?: string; customer?: string | { id?: string }; current_period_end?: number;
      metadata?: Record<string, unknown>;
      items?: { data?: Array<{ price?: { id?: string }; current_period_end?: number }> };
      error?: { message?: string };
    };
    if (!response.ok || payload.id !== subscriptionId) throw new Error(`Stripe subscription lookup failed with HTTP ${response.status}`);
    const items = payload.items?.data ?? [];
    // Newer API versions report the period on each item instead of the subscription.
    const periodEnds = [payload.current_period_end, ...items.map((item) => item.current_period_end)].filter((value): value is number => typeof value === "number");
    const customer = typeof payload.customer === "string" ? payload.customer : payload.customer?.id ?? null;
    return {
      id: payload.id,
      status: normalizeSubscriptionStatus(payload.status ?? "incomplete"),
      customer,
      tenantId: typeof payload.metadata?.tenant_id === "string" ? payload.metadata.tenant_id : null,
      priceIds: items.map((item) => item.price?.id).filter((value): value is string => typeof value === "string"),
      currentPeriodEnd: periodEnds.length ? new Date(Math.max(...periodEnds) * 1_000).toISOString() : null,
    };
  }

  async syncAddOns(subscriptionId: string, input: { dailySms: boolean; realtimeSms: boolean }): Promise<void> {
    const response = await withTimeout(this.fetcher(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=items.data.price`, {
      headers: { authorization: `Bearer ${this.secretKey}` },
    }), 6_000);
    const payload = await response.json().catch(() => ({})) as {
      items?: { data?: Array<{ id?: string; price?: { id?: string } }> };
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(`Stripe subscription lookup failed with HTTP ${response.status}${payload.error?.message ? `: ${payload.error.message}` : ""}`);
    const items = payload.items?.data ?? [];
    const changes: Array<{ id?: string; price?: string; deleted?: boolean }> = [];
    for (const [enabled, price, label] of [
      [input.dailySms, this.prices.dailySms, "daily SMS"],
      [input.realtimeSms, this.prices.realtimeSms, "instant lead SMS"],
    ] as const) {
      if (enabled && !price) throw new Error(`Stripe ${label} price is not configured`);
      const existing = price ? items.find((item) => item.price?.id === price) : undefined;
      if (enabled && price && !existing) changes.push({ price });
      if (!enabled && existing?.id) changes.push({ id: existing.id, deleted: true });
    }
    if (changes.length === 0) return;
    const body = new URLSearchParams({ proration_behavior: "always_invoice", payment_behavior: "error_if_incomplete" });
    changes.forEach((change, index) => {
      if (change.id) body.set(`items[${index}][id]`, change.id);
      if (change.price) {
        body.set(`items[${index}][price]`, change.price);
        body.set(`items[${index}][quantity]`, "1");
      }
      if (change.deleted) body.set(`items[${index}][deleted]`, "true");
    });
    const update = await withTimeout(this.fetcher(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body,
    }), 6_000);
    const updated = await update.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
    if (!update.ok || updated.id !== subscriptionId) throw new Error(`Stripe subscription update failed with HTTP ${update.status}${updated.error?.message ? `: ${updated.error.message}` : ""}`);
  }
}

function requiredPrice(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Stripe ${label} price is not configured`);
  return value;
}

/** "Nov 1" in UTC, for invoice line descriptions. */
function shortDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value));
}

export function verifyStripeWebhook(rawBody: string, signatureHeader: string | undefined, secret: string, now = Date.now()): StripeEvent {
  if (!signatureHeader) throw new Error("Missing Stripe signature");
  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) throw new Error("Invalid Stripe signature");
  if (Math.abs(now - Number(timestamp) * 1_000) > 5 * 60_000) throw new Error("Expired Stripe signature");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  if (!signatures.some((signature) => constantTimeEqual(signature, expected))) throw new Error("Invalid Stripe signature");
  const parsed = JSON.parse(rawBody) as Partial<StripeEvent>;
  if (typeof parsed.id !== "string" || typeof parsed.type !== "string" || !parsed.data?.object) throw new Error("Invalid Stripe event");
  return parsed as StripeEvent;
}

export function subscriptionFromStripeEvent(event: StripeEvent, existing: SubscriptionRecord | null, now: string): SubscriptionRecord | null {
  // Checkout receipts have no authoritative subscription status and can arrive
  // after subscription updates. Ignoring them also avoids resaving stale state.
  if (!event.type.startsWith("customer.subscription.")) return null;
  const object = event.data.object;
  const metadata = object.metadata && typeof object.metadata === "object" ? object.metadata as Record<string, unknown> : {};
  const tenantId = typeof metadata.tenant_id === "string" ? metadata.tenant_id : typeof object.client_reference_id === "string" ? object.client_reference_id : null;
  if (!tenantId) return null;
  const rawStatus = typeof object.status === "string" ? object.status : "incomplete";
  const status = normalizeSubscriptionStatus(event.type === "customer.subscription.deleted" ? "canceled" : rawStatus);
  const customer = typeof object.customer === "string" ? object.customer : existing?.providerCustomerId ?? null;
  const subscription = typeof object.id === "string" ? object.id : existing?.providerSubscriptionId ?? null;
  const periodEndSeconds = typeof object.current_period_end === "number" ? object.current_period_end : null;
  const providerEventCreatedAt = typeof event.created === "number" ? new Date(event.created * 1_000).toISOString() : now;
  if (existing && existing.providerEventCreatedAt > providerEventCreatedAt) return existing;
  return {
    tenantId,
    providerCustomerId: customer,
    providerSubscriptionId: subscription,
    status,
    currentPeriodEnd: periodEndSeconds === null ? existing?.currentPeriodEnd ?? null : new Date(periodEndSeconds * 1_000).toISOString(),
    providerEventCreatedAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * A successful charge in a Stripe event, with the shop it belongs to and when it was paid: `invoice.paid` /
 * `invoice.payment_succeeded` with money collected (paid_at), or `checkout.session.completed` that collected
 * payment (event time). Null for anything else, including $0 invoices.
 */
export function firstChargeFromEvent(event: StripeEvent): { tenantId: string; at: string } | null {
  const object = event.data.object as Record<string, unknown> & {
    amount_paid?: number; amount_total?: number; payment_status?: string; client_reference_id?: string;
    status_transitions?: { paid_at?: number | null };
    metadata?: Record<string, unknown>;
    subscription_details?: { metadata?: Record<string, unknown> };
    parent?: { subscription_details?: { metadata?: Record<string, unknown> } };
  };
  const eventAt = typeof event.created === "number" ? new Date(event.created * 1_000).toISOString() : null;
  if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
    if (!(typeof object.amount_paid === "number" && object.amount_paid > 0)) return null;
    // Older API versions carry the subscription's metadata on subscription_details, newer ones under parent.
    const tenant = object.parent?.subscription_details?.metadata?.tenant_id ?? object.subscription_details?.metadata?.tenant_id ?? object.metadata?.tenant_id;
    const paidAt = typeof object.status_transitions?.paid_at === "number" ? new Date(object.status_transitions.paid_at * 1_000).toISOString() : eventAt;
    return typeof tenant === "string" && paidAt ? { tenantId: tenant, at: paidAt } : null;
  }
  if (event.type === "checkout.session.completed") {
    if (object.payment_status !== "paid" || !(typeof object.amount_total === "number" && object.amount_total > 0)) return null;
    const tenant = typeof object.client_reference_id === "string" ? object.client_reference_id : object.metadata?.tenant_id;
    return typeof tenant === "string" && eventAt ? { tenantId: tenant, at: eventAt } : null;
  }
  return null;
}

export function normalizeSubscriptionStatus(value: string): SubscriptionRecord["status"] {
  // An expired first payment can never be paid; treat it as ended so the shop can buy again.
  if (value === "incomplete_expired") return "canceled";
  if (value === "trialing" || value === "active" || value === "past_due" || value === "canceled" || value === "unpaid" || value === "incomplete") return value;
  return "incomplete";
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
