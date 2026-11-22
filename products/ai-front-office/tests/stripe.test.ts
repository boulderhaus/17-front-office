import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StripeBillingClient, subscriptionFromStripeEvent, verifyStripeWebhook } from "../src/adapters/stripe.js";

describe("Stripe billing boundary", () => {
  it("adds selected recurring prices to checkout and safely syncs an active subscription", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://checkout.stripe.com/synthetic" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: { data: [{ id: "si_daily", price: { id: "price_daily" } }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "sub_synthetic" }), { status: 200 }));
    const fetcher = fetchMock as unknown as typeof fetch;
    const client = new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", {
      base: "price_base", dailySms: "price_daily", realtimeSms: "price_realtime",
    }, fetcher);
    await client.createCheckout({
      tenantId: "shop_synthetic", email: "owner@synthetic.example", successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel", idempotencyKey: "checkout:synthetic", dailySms: true, realtimeSms: false,
    });
    const checkoutBody = fetchMock.mock.calls[0]![1]?.body as URLSearchParams;
    expect(checkoutBody.get("line_items[0][price]")).toBe("price_base");
    expect(checkoutBody.get("line_items[1][price]")).toBe("price_daily");

    await client.syncAddOns("sub_synthetic", { dailySms: false, realtimeSms: true });
    const updateBody = fetchMock.mock.calls[2]![1]?.body as URLSearchParams;
    expect(updateBody.get("items[0][id]")).toBe("si_daily");
    expect(updateBody.get("items[0][deleted]")).toBe("true");
    expect(updateBody.get("items[1][price]")).toBe("price_realtime");
    expect(updateBody.get("proration_behavior")).toBe("always_invoice");
  });
  it("accepts a current signed subscription event and maps it to one tenant", () => {
    const secret = "whsec_synthetic_abcdefghijklmnopqrstuvwxyz";
    const now = new Date("2026-11-21T18:00:00.000Z");
    const raw = JSON.stringify({
      id: "evt_synthetic",
      type: "customer.subscription.updated",
      created: Math.floor(now.getTime() / 1_000),
      data: { object: { id: "sub_synthetic", customer: "cus_synthetic", status: "active", current_period_end: 1_798_308_000, metadata: { tenant_id: "shop_synthetic" } } },
    });
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
    const event = verifyStripeWebhook(raw, `t=${timestamp},v1=${signature}`, secret, now.getTime());
    expect(subscriptionFromStripeEvent(event, null, now.toISOString())).toMatchObject({
      tenantId: "shop_synthetic",
      providerCustomerId: "cus_synthetic",
      providerSubscriptionId: "sub_synthetic",
      status: "active",
      providerEventCreatedAt: now.toISOString(),
    });
  });

  it("does not let an older provider event roll subscription state backward", () => {
    const existing = {
      tenantId: "shop_synthetic",
      providerCustomerId: "cus_synthetic",
      providerSubscriptionId: "sub_synthetic",
      status: "active" as const,
      currentPeriodEnd: "2026-12-21T00:00:00.000Z",
      providerEventCreatedAt: "2026-11-21T18:00:00.000Z",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-21T18:00:00.000Z",
    };
    const older = subscriptionFromStripeEvent({
      id: "evt_older",
      type: "customer.subscription.updated",
      created: 1_795_280_400,
      data: { object: { id: "sub_synthetic", status: "past_due", metadata: { tenant_id: "shop_synthetic" } } },
    }, existing, "2026-11-21T19:00:00.000Z");
    expect(older).toEqual(existing);
  });

  it("rejects a forged or expired signature", () => {
    const raw = JSON.stringify({ id: "evt_synthetic", type: "checkout.session.completed", data: { object: {} } });
    expect(() => verifyStripeWebhook(raw, "t=1,v1=forged", "whsec_synthetic_abcdefghijklmnopqrstuvwxyz", Date.now())).toThrow();
  });
});
