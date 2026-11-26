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
}

/** A refund made under the lead guarantee. */
export interface GuaranteeRefund { refundId: string; amountCents: number; invoiceId: string }

export interface StripeSubscriptionSnapshot {
  id: string;
  status: SubscriptionRecord["status"];
  customer: string | null;
  tenantId: string | null;
  priceIds: string[];
  /** The Unlimited add-on items on the subscription right now (empty: the add-on is off). */
  addOnItems: Array<{ id: string; createdAt: string | null }>;
  currentPeriodEnd: string | null;
}

const PORTAL_CONFIGURATION_TAG = "v1";
/** Marks our card-change Checkout Sessions, so the webhook can tell them from a plan purchase. */
export const CARD_UPDATE_TAG = "card_update";

/** The card on file, as Plan and billing shows it. */
export interface CardOnFile { brand: string; last4: string; expMonth: number; expYear: number }
/** One past bill. pdfUrl is Stripe's own invoice PDF. */
export interface BillLine { id: string; at: string; amountCents: number; status: "paid" | "failed" | "due"; pdfUrl: string | null }

function cardFrom(value: unknown): CardOnFile | null {
  if (!value || typeof value !== "object") return null;
  const card = (value as { card?: { brand?: unknown; last4?: unknown; exp_month?: unknown; exp_year?: unknown } }).card;
  if (!card || typeof card.last4 !== "string" || typeof card.exp_month !== "number" || typeof card.exp_year !== "number") return null;
  return { brand: typeof card.brand === "string" ? card.brand : "card", last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year };
}

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
   * The item changes that put a subscription on a plan, with or without the Unlimited add-on: the plan item's
   * price is swapped, the add-on item is added, re-priced for the new plan, or removed. Any other item is left alone.
   */
  private async planItemChanges(subscriptionId: string, plan: PlanId, unlimited: boolean): Promise<{ changes: Array<{ id?: string; price?: string; deleted?: boolean }>; items: Array<Record<string, unknown>> }> {
    const price = requiredPrice(this.planPrice(plan), `${plan} plan`);
    const addOnPrice = unlimited ? requiredPrice(this.unlimitedPrice(plan), `${plan} Unlimited add-on`) : null;
    const subscription = await this.get(`subscriptions/${encodeURIComponent(subscriptionId)}`) as { items?: { data?: Array<{ id?: string; price?: { id?: string } }> } };
    const items = subscription.items?.data ?? [];
    const ours = this.planPrices();
    const addOns = this.unlimitedPrices();
    const item = items.find((entry) => entry.price?.id && ours.includes(entry.price.id));
    if (!item?.id) throw new Error("Stripe subscription has no Call Otto plan item");
    const addOnItem = items.find((entry) => entry.price?.id && addOns.includes(entry.price.id));
    const changes: Array<{ id?: string; price?: string; deleted?: boolean }> = [];
    if (item.price?.id !== price) changes.push({ id: item.id, price });
    if (addOnPrice && !addOnItem) changes.push({ price: addOnPrice });
    else if (addOnPrice && addOnItem?.id && addOnItem.price?.id !== addOnPrice) changes.push({ id: addOnItem.id, price: addOnPrice });
    else if (!addOnPrice && addOnItem?.id) changes.push({ id: addOnItem.id, deleted: true });
    return { changes, items: items as Array<Record<string, unknown>> };
  }

  private static itemParams(body: URLSearchParams, prefix: string, changes: Array<{ id?: string; price?: string; deleted?: boolean }>): void {
    changes.forEach((change, index) => {
      if (change.id) body.set(`${prefix}[${index}][id]`, change.id);
      if (change.price) {
        body.set(`${prefix}[${index}][price]`, change.price);
        body.set(`${prefix}[${index}][quantity]`, "1");
      }
      if (change.deleted) body.set(`${prefix}[${index}][deleted]`, "true");
    });
  }

  /**
   * What a plan change would charge today, from Stripe's own invoice preview (POST /v1/invoices/create_preview),
   * as if made at prorationDate. Nothing changes in Stripe. changeCents is the sum of the proration lines
   * (negative: a credit); chargeCents is what the card would actually be charged now, after any account credit.
   * Passing the same prorationDate to changePlan makes Stripe invoice exactly this amount.
   */
  async previewChange(subscriptionId: string, plan: PlanId, options: { unlimited: boolean; prorationDate: number }): Promise<{ changeCents: number; chargeCents: number; creditCents: number; noChange: boolean }> {
    const { changes } = await this.planItemChanges(subscriptionId, plan, options.unlimited);
    if (changes.length === 0) return { changeCents: 0, chargeCents: 0, creditCents: 0, noChange: true };
    const body = new URLSearchParams({ subscription: subscriptionId });
    StripeBillingClient.itemParams(body, "subscription_details[items]", changes);
    body.set("subscription_details[proration_behavior]", "always_invoice");
    body.set("subscription_details[proration_date]", String(options.prorationDate));
    const preview = await this.post("invoices/create_preview", body);
    if (!preview.ok) throw new Error(`Stripe invoice preview failed with HTTP ${preview.status}${preview.payload.error?.message ? `: ${preview.payload.error.message}` : ""}`);
    type Line = { amount?: number; proration?: boolean; parent?: { type?: string; subscription_item_details?: { proration?: boolean }; invoice_item_details?: unknown } };
    const payload = preview.payload as { lines?: { data?: Line[] }; starting_balance?: number };
    const lines = payload.lines?.data ?? [];
    const amount = (line: Line) => (typeof line.amount === "number" ? line.amount : 0);
    // Stripe's advice: the prorations being previewed are the lines marked proration.
    const isProration = (line: Line) => line.parent?.subscription_item_details?.proration === true || line.proration === true;
    const changeCents = lines.filter(isProration).reduce((sum, line) => sum + amount(line), 0);
    // always_invoice also sweeps any pending invoice items onto the same invoice, so they are charged now too.
    const pendingCents = lines.filter((line) => !isProration(line) && (line.parent?.type === "invoice_item_details" || line.parent?.invoice_item_details !== undefined))
      .reduce((sum, line) => sum + amount(line), 0);
    // The account balance applies to that invoice: a credit (negative) is used before the card, a debit (positive) is added.
    const balance = typeof payload.starting_balance === "number" ? payload.starting_balance : 0;
    const total = changeCents + pendingCents + balance;
    return { changeCents, chargeCents: Math.max(0, total), creditCents: changeCents < 0 ? -changeCents : 0, noChange: false };
  }

  /**
   * Put a paying subscription on a plan, with or without the Unlimited add-on, prorated, in one update; Stripe
   * invoices the difference now (credit for a downgrade). Only ever called after the owner confirmed the amount:
   * pass the prorationDate that preview used so the invoice matches it to the cent. No change, no write.
   */
  async changePlan(subscriptionId: string, plan: PlanId, options: { unlimited?: boolean; prorationDate?: number } = {}): Promise<{ addOnItems: Array<{ id: string; createdAt: string | null }> | null }> {
    const unlimited = options.unlimited === true;
    const { changes, items } = await this.planItemChanges(subscriptionId, plan, unlimited);
    if (changes.length === 0) return { addOnItems: this.addOnItemsFrom(items) };
    const body = new URLSearchParams();
    StripeBillingClient.itemParams(body, "items", changes);
    body.set("proration_behavior", "always_invoice");
    if (options.prorationDate) body.set("proration_date", String(options.prorationDate));
    body.set("payment_behavior", "error_if_incomplete");
    body.set("metadata[plan]", plan);
    body.set("metadata[unlimited]", unlimited ? "yes" : "no");
    const update = await this.post(`subscriptions/${encodeURIComponent(subscriptionId)}`, body);
    if (!update.ok || update.payload.id !== subscriptionId) throw new Error(`Stripe plan change failed with HTTP ${update.status}${update.payload.error?.message ? `: ${update.payload.error.message}` : ""}`);
    // Stripe answers with the updated subscription: its add-on items (and their creation times) are the new truth.
    const updated = update.payload.items as { data?: unknown } | undefined;
    return { addOnItems: Array.isArray(updated?.data) ? this.addOnItemsFrom(updated.data as Array<Record<string, unknown>>) : null };
  }

  /**
   * What the owner last paid and what the next bill is, for the top line of Plan and billing. Read only.
   * The next bill comes from Stripe's preview of the subscription's next invoice, so a credit is already applied.
   */
  async billingSummary(subscriptionId: string): Promise<{ lastPaid: { amountCents: number; paidAt: string } | null; next: { amountCents: number; at: string | null } | null; endsAt: string | null }> {
    const [paid, upcoming, subscription] = await Promise.all([
      this.get(`invoices?subscription=${encodeURIComponent(subscriptionId)}&status=paid&limit=10`).catch(() => null) as Promise<{ data?: Array<{ amount_paid?: number; created?: number; status_transitions?: { paid_at?: number | null } }> } | null>,
      this.post("invoices/create_preview", new URLSearchParams({ subscription: subscriptionId })).catch(() => null),
      this.get(`subscriptions/${encodeURIComponent(subscriptionId)}`).catch(() => null) as Promise<{ cancel_at_period_end?: boolean; cancel_at?: number | null; current_period_end?: number; items?: { data?: Array<{ current_period_end?: number }> } } | null>,
    ]);
    // Set to cancel: there is no next bill, only an end date.
    const endSeconds = subscription?.cancel_at ?? (subscription?.cancel_at_period_end ? (subscription.items?.data?.[0]?.current_period_end ?? subscription.current_period_end ?? null) : null);
    const endsAt = typeof endSeconds === "number" ? new Date(endSeconds * 1_000).toISOString() : null;
    const last = (paid?.data ?? []).filter((invoice) => (invoice.amount_paid ?? 0) > 0)
      .map((invoice) => ({ amountCents: invoice.amount_paid ?? 0, at: invoice.status_transitions?.paid_at ?? invoice.created ?? 0 }))
      .sort((left, right) => right.at - left.at)[0];
    const next = upcoming?.ok ? upcoming.payload as { amount_due?: number; next_payment_attempt?: number | null; period_end?: number } : null;
    return {
      lastPaid: last && last.at > 0 ? { amountCents: last.amountCents, paidAt: new Date(last.at * 1_000).toISOString() } : null,
      next: !endsAt && next && typeof next.amount_due === "number" ? { amountCents: next.amount_due, at: typeof next.next_payment_attempt === "number" ? new Date(next.next_payment_attempt * 1_000).toISOString() : null } : null,
      endsAt,
    };
  }

  /** The Unlimited add-on items among a subscription's items (from the API or a webhook payload). */
  addOnItemsFrom(items: Array<{ id?: unknown; created?: unknown; price?: unknown }>): Array<{ id: string; createdAt: string | null }> {
    const addOns = this.unlimitedPrices();
    return items.flatMap((item) => {
      const price = typeof item.price === "string" ? item.price : (item.price as { id?: unknown } | undefined)?.id;
      if (typeof item.id !== "string" || typeof price !== "string" || !addOns.includes(price)) return [];
      return [{ id: item.id, createdAt: typeof item.created === "number" ? new Date(item.created * 1_000).toISOString() : null }];
    });
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
        description: "Call Otto extra calls",
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

  /**
   * The card the subscription pays with (the subscription's own default, else the customer's) and the last bills,
   * for Plan and billing. Read only. Each half fails on its own: a refused read shows nothing, never a guess.
   */
  async paymentDetails(customerId: string, subscriptionId: string): Promise<{ card: CardOnFile | null; invoices: BillLine[] }> {
    const [subscription, invoices] = await Promise.all([
      this.get(`subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=default_payment_method`).catch(() => null) as Promise<{ default_payment_method?: unknown } | null>,
      this.get(`invoices?customer=${encodeURIComponent(customerId)}&limit=12`).catch(() => null) as Promise<{ data?: Array<Record<string, unknown>> } | null>,
    ]);
    let card = cardFrom(subscription?.default_payment_method);
    if (!card) {
      const customer = await this.get(`customers/${encodeURIComponent(customerId)}?expand[]=invoice_settings.default_payment_method`).catch(() => null) as { invoice_settings?: { default_payment_method?: unknown } } | null;
      card = cardFrom(customer?.invoice_settings?.default_payment_method);
    }
    const bills = (invoices?.data ?? []).flatMap((invoice): BillLine[] => {
      const status = invoice.status;
      const due = typeof invoice.amount_due === "number" ? invoice.amount_due : 0;
      const paid = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
      const created = typeof invoice.created === "number" ? invoice.created : null;
      if (typeof invoice.id !== "string" || created === null) return [];
      // Drafts and voided bills were never charged; a $0 bill (a trial) is noise.
      if (status !== "paid" && status !== "open" && status !== "uncollectible") return [];
      if (Math.max(due, paid) <= 0) return [];
      const attempts = typeof invoice.attempt_count === "number" ? invoice.attempt_count : 0;
      const state: BillLine["status"] = status === "paid" ? "paid" : status === "uncollectible" || attempts > 0 ? "failed" : "due";
      const pdf = typeof invoice.invoice_pdf === "string" && invoice.invoice_pdf.startsWith("https://") ? invoice.invoice_pdf : null;
      return [{ id: invoice.id, at: new Date(created * 1_000).toISOString(), amountCents: status === "paid" ? paid : due, status: state, pdfUrl: pdf }];
    }).sort((left, right) => right.at.localeCompare(left.at));
    return { card, invoices: bills };
  }

  /**
   * A setup-mode Checkout Session shown inside our own page (embedded Checkout): it saves a new card and charges
   * nothing. Accounts on Stripe's newest API name the embedded form "embedded_page"; that name is tried when the
   * older one is refused. Returns the client secret Stripe.js mounts and which name worked.
   */
  async createCardSetup(input: { customerId: string; tenantId: string; returnUrl: string }): Promise<{ clientSecret: string; uiMode: "embedded" | "embedded_page" }> {
    const attempt = async (uiMode: "embedded" | "embedded_page") => this.post("checkout/sessions", new URLSearchParams({
      mode: "setup",
      ui_mode: uiMode,
      customer: input.customerId,
      currency: "usd",
      "payment_method_types[0]": "card",
      return_url: input.returnUrl,
      redirect_on_completion: "if_required",
      "metadata[tenant_id]": input.tenantId,
      "metadata[front_office]": CARD_UPDATE_TAG,
      "setup_intent_data[metadata][tenant_id]": input.tenantId,
    }));
    let created = await attempt("embedded");
    let uiMode: "embedded" | "embedded_page" = "embedded";
    if (!created.ok && created.status === 400 && /ui_mode/i.test(`${created.payload.error?.message ?? ""} ${(created.payload.error as { param?: string } | undefined)?.param ?? ""}`)) {
      created = await attempt("embedded_page");
      uiMode = "embedded_page";
    }
    const secret = created.payload.client_secret;
    if (!created.ok || typeof secret !== "string" || !secret) throw new Error(`Stripe card setup failed with HTTP ${created.status}${created.payload.error?.message ? `: ${created.payload.error.message}` : ""}`);
    return { clientSecret: secret, uiMode };
  }

  /** A finished card-setup session: whose it is and the card it saved (null until the owner finished). */
  async retrieveCardSetup(sessionId: string): Promise<{ tenantId: string | null; customerId: string | null; paymentMethodId: string | null; isCardUpdate: boolean }> {
    const session = await this.get(`checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=setup_intent`) as {
      id?: string; mode?: string; status?: string; customer?: string | { id?: string } | null; metadata?: Record<string, string>;
      setup_intent?: string | { status?: string; payment_method?: string | { id?: string } | null; metadata?: Record<string, string> } | null;
    };
    if (session.id !== sessionId) throw new Error("Stripe card setup lookup returned another session");
    const intent = typeof session.setup_intent === "object" && session.setup_intent ? session.setup_intent : null;
    const method = intent?.status === "succeeded" ? (typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id ?? null) : null;
    return {
      tenantId: session.metadata?.tenant_id ?? intent?.metadata?.tenant_id ?? null,
      customerId: typeof session.customer === "string" ? session.customer : session.customer?.id ?? null,
      paymentMethodId: session.status === "complete" ? method : null,
      isCardUpdate: session.mode === "setup" && session.metadata?.front_office === CARD_UPDATE_TAG,
    };
  }

  /**
   * Make a saved card the one the subscription and the customer pay with. The subscription is the one that bills,
   * so it must succeed; the customer's default (used by one-off invoices such as extra calls) is set too.
   */
  async setDefaultCard(input: { customerId: string; subscriptionId: string; paymentMethodId: string }): Promise<{ customerUpdated: boolean }> {
    const subscription = await this.post(`subscriptions/${encodeURIComponent(input.subscriptionId)}`, new URLSearchParams({ default_payment_method: input.paymentMethodId }));
    if (!subscription.ok) throw new Error(`Stripe default card update failed with HTTP ${subscription.status}${subscription.payload.error?.message ? `: ${subscription.payload.error.message}` : ""}`);
    const customer = await this.post(`customers/${encodeURIComponent(input.customerId)}`, new URLSearchParams({ "invoice_settings[default_payment_method]": input.paymentMethodId })).catch(() => null);
    return { customerUpdated: customer?.ok === true };
  }

  /** Cancel at the end of the paid period (true), or undo that (false). Nothing is charged or refunded. */
  async setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean): Promise<void> {
    const update = await this.post(`subscriptions/${encodeURIComponent(subscriptionId)}`, new URLSearchParams({ cancel_at_period_end: cancel ? "true" : "false" }));
    if (!update.ok) throw new Error(`Stripe cancel change failed with HTTP ${update.status}${update.payload.error?.message ? `: ${update.payload.error.message}` : ""}`);
  }

  /**
   * Stripe's own card-update page, used when the embedded form can't be: it opens straight on "update card" and
   * sends the owner back to Plan and billing by itself once the card is saved.
   */
  async createCardUpdatePortal(customerId: string, returnUrl: string, doneUrl: string): Promise<string> {
    if (!this.portalConfiguration) this.portalConfiguration = await this.findPortalConfiguration();
    const body = new URLSearchParams({
      customer: customerId,
      return_url: returnUrl,
      "flow_data[type]": "payment_method_update",
      "flow_data[after_completion][type]": "redirect",
      "flow_data[after_completion][redirect][return_url]": doneUrl,
    });
    if (this.portalConfiguration) body.set("configuration", this.portalConfiguration);
    const session = await this.post("billing_portal/sessions", body);
    const url = session.payload.url;
    if (!session.ok || typeof url !== "string" || !url.startsWith("https://billing.stripe.com/")) throw new Error(`Stripe card update page failed with HTTP ${session.status}`);
    return url;
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
        "business_profile[headline]": "Manage your Call Otto subscription",
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

  async createCheckout(input: { tenantId: string; email: string; customerId?: string | null; successUrl: string; cancelUrl: string; idempotencyKey: string; now?: Date; trialDays?: number; submitMessage?: string; plan?: PlanId; unlimited?: boolean; couponId?: string | null }): Promise<{ id: string; url: string; expiresAt: string }> {
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
    if (input.unlimited) {
      // The Unlimited add-on: its own item, so it can be turned off later without touching the plan.
      body.set("line_items[1][price]", requiredPrice(this.unlimitedPrice(input.plan ?? "solo"), `${input.plan ?? "solo"} Unlimited add-on`));
      body.set("line_items[1][quantity]", "1");
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
      items?: { data?: Array<{ id?: string; created?: number; price?: { id?: string }; current_period_end?: number }> };
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
      addOnItems: this.addOnItemsFrom(items),
      currentPeriodEnd: periodEnds.length ? new Date(Math.max(...periodEnds) * 1_000).toISOString() : null,
    };
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
