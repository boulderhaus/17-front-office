import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { StripeBillingClient, subscriptionFromStripeEvent, verifyStripeWebhook } from "../src/adapters/stripe.js";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";

describe("Stripe billing boundary", () => {
  it("creates a cancellation-enabled portal for the server-selected customer only", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "bpc_synthetic" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session/synthetic" }), { status: 200 }));
    const client = new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_base" }, fetchMock as unknown as typeof fetch);
    expect(await client.createPortal("cus_synthetic", "https://example.com/app")).toContain("https://billing.stripe.com/");
    const configuration = fetchMock.mock.calls[0]![1]?.body as URLSearchParams;
    expect(configuration.get("features[subscription_cancel][enabled]")).toBe("true");
    expect(configuration.get("features[subscription_cancel][mode]")).toBe("at_period_end");
    const session = fetchMock.mock.calls[1]![1]?.body as URLSearchParams;
    expect(session.get("customer")).toBe("cus_synthetic");
    expect(session.get("return_url")).toBe("https://example.com/app");
  });
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

  it.each(["active", "canceled"] as const)("does not overwrite %s access with a delayed checkout receipt", (status) => {
    const existing = {
      tenantId: "shop_synthetic", providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic",
      status, currentPeriodEnd: "2026-12-21T00:00:00.000Z", providerEventCreatedAt: "2026-11-21T18:00:00.000Z",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-21T18:00:00.000Z",
    };
    const receipt = {
      id: "evt_checkout_delayed", type: "checkout.session.completed", created: Date.parse("2026-11-21T18:00:01.000Z") / 1_000,
      data: { object: { customer: "cus_synthetic", subscription: "sub_synthetic", client_reference_id: "shop_synthetic" } },
    };
    expect(subscriptionFromStripeEvent(receipt, existing, "2026-11-21T18:00:02.000Z")).toBeNull();
  });

  it("does not treat checkout completion alone as authoritative subscription state", () => {
    expect(subscriptionFromStripeEvent({
      id: "evt_checkout_first", type: "checkout.session.completed",
      data: { object: { customer: "cus_synthetic", subscription: "sub_synthetic", client_reference_id: "shop_synthetic" } },
    }, null, "2026-11-21T18:00:00.000Z")).toBeNull();
  });

  it("preserves signed subscription lifecycle state across delayed and replayed checkout webhooks", async () => {
    const secret = "whsec_synthetic_abcdefghijklmnopqrstuvwxyz";
    const now = new Date("2026-11-21T18:00:00.000Z");
    const timestamp = String(now.getTime() / 1_000);
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const server = createServer(createRequestHandler({
      env: demoEnvironment({ STRIPE_WEBHOOK_SECRET: secret, STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_PRICE_ID: "price_synthetic" }), store, calendar: new InMemoryCalendar(),
      clock: { now: () => now }, integrations: {}, logger: () => undefined,
    }));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const signup = await fetch(`${baseUrl}/signup`, {
        method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ businessName: "Synthetic Heating", email: "billing@synthetic.example", password: "synthetic-password-42", consent: "yes" }),
      });
      expect(signup.status).toBe(303);
      const account = await store.getOwnerAccountByEmail("billing@synthetic.example");
      expect(account).not.toBeNull();
      const tenantId = account!.tenantId;
      const postEvent = (event: object, forged = false) => {
        const raw = JSON.stringify(event);
        const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
        return fetch(`${baseUrl}/webhooks/stripe`, {
          method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${forged ? "forged" : signature}` }, body: raw,
        });
      };
      const subscriptionObject = { id: "sub_synthetic", customer: "cus_synthetic", status: "active", metadata: { tenant_id: tenantId } };
      const active = { id: "evt_active", type: "customer.subscription.updated", created: Number(timestamp), data: { object: subscriptionObject } };
      expect((await postEvent(active, true)).status).toBe(401);
      expect(await store.getSubscription(tenantId)).toBeNull();
      expect((await postEvent(active)).status).toBe(200);
      expect((await store.getSubscription(tenantId))?.status).toBe("active");
      const receipt = { id: "evt_receipt", type: "checkout.session.completed", created: Number(timestamp) + 1,
        data: { object: { customer: "cus_synthetic", subscription: "sub_synthetic", client_reference_id: tenantId } } };
      expect((await postEvent(receipt)).status).toBe(200);
      expect((await store.getSubscription(tenantId))?.status).toBe("active");
      const cancel = { id: "evt_cancel", type: "customer.subscription.deleted", created: Number(timestamp) + 2,
        data: { object: { ...subscriptionObject, status: "canceled" } } };
      expect((await postEvent(cancel)).status).toBe(200);
      const replay = await postEvent(receipt);
      expect(await replay.json()).toEqual({ received: true, duplicate: true });
      expect((await store.getSubscription(tenantId))?.status).toBe("canceled");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a forged or expired signature", () => {
    const raw = JSON.stringify({ id: "evt_synthetic", type: "checkout.session.completed", data: { object: {} } });
    expect(() => verifyStripeWebhook(raw, "t=1,v1=forged", "whsec_synthetic_abcdefghijklmnopqrstuvwxyz", Date.now())).toThrow();
  });
});
