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

  it("rejects a forged or expired signature", () => {
    const raw = JSON.stringify({ id: "evt_synthetic", type: "checkout.session.completed", data: { object: {} } });
    expect(() => verifyStripeWebhook(raw, "t=1,v1=forged", "whsec_synthetic_abcdefghijklmnopqrstuvwxyz", Date.now())).toThrow();
  });
});

describe("Stripe webhook state is read from the Stripe API", () => {
  const secret = "whsec_synthetic_abcdefghijklmnopqrstuvwxyz";
  const now = new Date("2026-11-21T18:00:00.000Z");
  const timestamp = String(now.getTime() / 1_000);

  async function harness(options: { activeAccount?: boolean; telnyxFails?: boolean } = {}) {
    const api: { status: string; price: string; tenant: string | null; subscriptions: Record<string, { status: string; price: string }> } = { status: "active", price: "price_synthetic", tenant: null, subscriptions: {} };
    const calls: Array<{ url: string; method: string; body?: unknown; key?: string }> = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body, key: (init?.headers as Record<string, string> | undefined)?.["idempotency-key"] });
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
      const subscription = /api\.stripe\.com\/v1\/subscriptions\/([^?/]+)/.exec(url);
      if (subscription && method === "GET") {
        const id = decodeURIComponent(subscription[1]!);
        const state = api.subscriptions[id] ?? { status: api.status, price: api.price };
        return json({ id, status: state.status, customer: "cus_synthetic", metadata: { tenant_id: api.tenant }, items: { data: [{ price: { id: state.price }, current_period_end: 1_766_400_000 }] } });
      }
      if (url.includes("api.stripe.com/v1/checkout/sessions")) return json({ url: "https://checkout.stripe.com/c/synthetic" });
      if (url.includes("api.stripe.com/v1/billing_portal/configurations")) return json({ id: "bpc_synthetic" });
      if (url.includes("api.stripe.com/v1/billing_portal/sessions")) return json({ url: "https://billing.stripe.com/p/synthetic" });
      if (url.includes("api.telnyx.com/v2/ai/assistants/")) return options.telnyxFails ? json({ errors: [{ detail: "down" }] }, 503) : json({ data: { telephony_settings: { default_texml_app_id: "texml_synthetic" } } });
      if (url.includes("api.telnyx.com/v2/phone_numbers?")) return json({ data: [{ id: "num_synthetic", phone_number: "+12175550188", connection_id: "texml_synthetic" }] });
      if (url.includes("api.telnyx.com/v2/phone_numbers/num_synthetic") && method === "PATCH") return json({ data: { connection_id: null } });
      throw new Error(`Unexpected outbound request in test: ${method} ${url}`);
    }) as typeof fetch;
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const server = createServer(createRequestHandler({
      env: demoEnvironment({ STRIPE_WEBHOOK_SECRET: secret, STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_PRICE_ID: "price_synthetic", TELNYX_API_KEY: "KEY_synthetic" }),
      store, calendar: new InMemoryCalendar(), clock: { now: () => now }, integrations: {}, logger: () => undefined, fetcher,
    }));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const signup = await fetch(`${baseUrl}/signup`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ businessName: "Synthetic Heating", email: "billing@synthetic.example", password: "synthetic-password-42", consent: "yes", phone: "2175550199", ownerSmsConsent: "yes" }),
    });
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const account = (await store.getOwnerAccountByEmail("billing@synthetic.example"))!;
    const tenantId = account.tenantId;
    api.tenant = tenantId;
    if (options.activeAccount) {
      await store.updateOwnerAccountStatus(account.id, "active", now.toISOString());
      await store.saveProviderRoute({ provider: "telnyx", externalId: "assistant_synthetic", tenantId, createdAt: now.toISOString(), updatedAt: now.toISOString() });
      await store.saveIntegrationSecret(tenantId, "telnyx", "inbound_number", "+12175550188");
      await store.saveConfig({ ...(await store.getConfig(tenantId)), paused: false });
    }
    let sequence = 0;
    const post = (type: string, object: Record<string, unknown>) => {
      sequence += 1;
      const raw = JSON.stringify({ id: `evt_${sequence}`, type, created: Number(timestamp), data: { object } });
      const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
      return fetch(`${baseUrl}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body: raw });
    };
    const subscriptionEvent = (type: string, id = "sub_synthetic") => post(type, { id, customer: "cus_synthetic", status: "incomplete", metadata: { tenant_id: tenantId } });
    const receipt = (id = "sub_synthetic") => post("checkout.session.completed", { customer: "cus_synthetic", subscription: id, client_reference_id: tenantId });
    const close = async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };
    return { api, calls, store, tenantId, baseUrl, cookie, subscriptionEvent, receipt, close };
  }

  it("keeps a paid subscription active when the checkout receipt arrives in the same second", async () => {
    const h = await harness();
    try {
      expect((await h.subscriptionEvent("customer.subscription.updated")).status).toBe(200);
      expect((await h.receipt()).status).toBe(200);
      expect(await h.store.getSubscription(h.tenantId)).toMatchObject({ status: "active", providerSubscriptionId: "sub_synthetic", currentPeriodEnd: "2025-12-22T10:40:00.000Z" });
    } finally { await h.close(); }
  });

  it("reaches the same state whichever event arrives first", async () => {
    const h = await harness();
    try {
      expect((await h.receipt()).status).toBe(200);
      expect((await h.subscriptionEvent("customer.subscription.created")).status).toBe(200);
      expect((await h.store.getSubscription(h.tenantId))?.status).toBe("active");
      h.api.status = "canceled";
      expect((await h.receipt()).status).toBe(200);
      expect((await h.store.getSubscription(h.tenantId))?.status).toBe("canceled");
    } finally { await h.close(); }
  });

  it("ignores subscriptions that are not for the Front Office plan or belong to another workspace", async () => {
    const h = await harness();
    try {
      h.api.price = "price_unrelated";
      expect((await h.subscriptionEvent("customer.subscription.updated")).status).toBe(200);
      expect(await h.store.getSubscription(h.tenantId)).toBeNull();
      h.api.price = "price_synthetic";
      h.api.tenant = "shop_someone_else";
      expect((await h.subscriptionEvent("customer.subscription.updated")).status).toBe(400);
      expect(await h.store.getSubscription(h.tenantId)).toBeNull();
    } finally { await h.close(); }
  });

  it("never lets a second subscription replace or cancel the one that is paying", async () => {
    const h = await harness();
    try {
      await h.subscriptionEvent("customer.subscription.updated", "sub_first");
      h.api.subscriptions.sub_second = { status: "canceled", price: "price_synthetic" };
      await h.subscriptionEvent("customer.subscription.deleted", "sub_second");
      expect(await h.store.getSubscription(h.tenantId)).toMatchObject({ status: "active", providerSubscriptionId: "sub_first" });
    } finally { await h.close(); }
  });

  it("pauses the live line and texts the owner when an active shop's billing lapses", async () => {
    const h = await harness({ activeAccount: true });
    try {
      await h.subscriptionEvent("customer.subscription.updated");
      h.api.status = "past_due";
      expect((await h.subscriptionEvent("customer.subscription.updated")).status).toBe(200);
      expect(h.calls.some((call) => call.method === "PATCH" && call.url.includes("/phone_numbers/num_synthetic"))).toBe(true);
      expect((await h.store.getConfig(h.tenantId)).paused).toBe(true);
      expect((await h.store.getSubscription(h.tenantId))?.status).toBe("past_due");
      const lapse = [...h.store.notifications.values()].filter((item) => item.idempotencyKey.startsWith("billing-lapse:"));
      expect(lapse).toHaveLength(1);
      expect(lapse[0]!.body).toContain("past due");
      h.api.status = "active";
      await h.subscriptionEvent("customer.subscription.updated");
      expect((await h.store.getConfig(h.tenantId)).paused).toBe(true);
    } finally { await h.close(); }
  });

  it("asks Stripe to retry and saves nothing when the line cannot be paused", async () => {
    const h = await harness({ activeAccount: true, telnyxFails: true });
    try {
      await h.subscriptionEvent("customer.subscription.updated");
      h.api.status = "canceled";
      expect((await h.subscriptionEvent("customer.subscription.deleted")).status).toBe(502);
      expect((await h.store.getSubscription(h.tenantId))?.status).toBe("active");
    } finally { await h.close(); }
  });

  it("reuses one Checkout Session for repeat taps and sends unpaid shops to the billing portal", async () => {
    const h = await harness();
    try {
      const page = await (await fetch(`${h.baseUrl}/app`, { headers: { cookie: h.cookie } })).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
      const tap = () => fetch(`${h.baseUrl}/app/billing/checkout`, { method: "POST", redirect: "manual", headers: { cookie: h.cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) });
      expect((await tap()).headers.get("location")).toContain("checkout.stripe.com");
      await tap();
      const keys = h.calls.filter((call) => call.url.includes("/checkout/sessions")).map((call) => call.key);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
      h.api.status = "past_due";
      await h.subscriptionEvent("customer.subscription.updated");
      expect((await tap()).headers.get("location")).toContain("billing.stripe.com");
    } finally { await h.close(); }
  });
});

