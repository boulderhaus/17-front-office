import { createHmac, timingSafeEqual } from "node:crypto";
import { withTimeout } from "../application/retry.js";
import type { SubscriptionRecord } from "../domain/models.js";

export interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
}

export interface StripePrices {
  base: string;
  dailySms?: string;
  realtimeSms?: string;
}

export class StripeBillingClient {
  private portalConfiguration: string | null = null;
  constructor(private readonly secretKey: string, private readonly prices: StripePrices, private readonly fetcher: typeof fetch = fetch) {}

  async createPortal(customerId: string, returnUrl: string): Promise<string> {
    if (!this.portalConfiguration) {
      const body = new URLSearchParams({
        "business_profile[headline]": "Manage your Front Office subscription",
        "features[subscription_cancel][enabled]": "true",
        "features[subscription_cancel][mode]": "at_period_end",
        "features[payment_method_update][enabled]": "true",
        "features[invoice_history][enabled]": "true",
      });
      const response = await withTimeout(this.fetcher("https://api.stripe.com/v1/billing_portal/configurations", {
        method: "POST", headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": "front-office-portal-v1" }, body,
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

  async createCheckout(input: { tenantId: string; email: string; successUrl: string; cancelUrl: string; idempotencyKey: string; dailySms: boolean; realtimeSms: boolean }): Promise<string> {
    const body = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": this.prices.base,
      "line_items[0][quantity]": "1",
      customer_email: input.email,
      client_reference_id: input.tenantId,
      "metadata[tenant_id]": input.tenantId,
      "subscription_data[metadata][tenant_id]": input.tenantId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    let lineItem = 1;
    if (input.dailySms) body.set(`line_items[${lineItem++}][price]`, requiredPrice(this.prices.dailySms, "daily SMS"));
    if (input.realtimeSms) body.set(`line_items[${lineItem}][price]`, requiredPrice(this.prices.realtimeSms, "instant lead SMS"));
    const response = await withTimeout(this.fetcher("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": input.idempotencyKey,
      },
      body,
    }), 6_000);
    const payload = await response.json().catch(() => ({})) as { url?: string; error?: { message?: string } };
    if (!response.ok || !payload.url?.startsWith("https://")) throw new Error(`Stripe checkout failed with HTTP ${response.status}${payload.error?.message ? `: ${payload.error.message}` : ""}`);
    return payload.url;
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
      if (change.price) body.set(`items[${index}][price]`, change.price);
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

function normalizeSubscriptionStatus(value: string): SubscriptionRecord["status"] {
  if (value === "trialing" || value === "active" || value === "past_due" || value === "canceled" || value === "unpaid" || value === "incomplete") return value;
  return "incomplete";
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
