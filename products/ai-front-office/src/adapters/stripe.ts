import { createHmac, timingSafeEqual } from "node:crypto";
import { withTimeout } from "../application/retry.js";
import type { SubscriptionRecord } from "../domain/models.js";

export interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
}

export class StripeBillingClient {
  constructor(private readonly secretKey: string, private readonly priceId: string, private readonly fetcher: typeof fetch = fetch) {}

  async createCheckout(input: { tenantId: string; email: string; successUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<string> {
    const body = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": this.priceId,
      "line_items[0][quantity]": "1",
      customer_email: input.email,
      client_reference_id: input.tenantId,
      "metadata[tenant_id]": input.tenantId,
      "subscription_data[metadata][tenant_id]": input.tenantId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
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
  const object = event.data.object;
  const metadata = object.metadata && typeof object.metadata === "object" ? object.metadata as Record<string, unknown> : {};
  const tenantId = typeof metadata.tenant_id === "string" ? metadata.tenant_id : typeof object.client_reference_id === "string" ? object.client_reference_id : null;
  if (!tenantId) return null;
  const isSubscription = event.type.startsWith("customer.subscription.");
  const rawStatus = isSubscription && typeof object.status === "string" ? object.status : "incomplete";
  const status = normalizeSubscriptionStatus(event.type === "customer.subscription.deleted" ? "canceled" : rawStatus);
  const customer = typeof object.customer === "string" ? object.customer : existing?.providerCustomerId ?? null;
  const subscription = isSubscription && typeof object.id === "string"
    ? object.id
    : typeof object.subscription === "string" ? object.subscription : existing?.providerSubscriptionId ?? null;
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
