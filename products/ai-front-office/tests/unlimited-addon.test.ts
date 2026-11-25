import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { StripeBillingClient } from "../src/adapters/stripe.js";
import { OverageBillingService, recordFirstPaid, recordUnlimitedObservation, unlimitedWindows } from "../src/application/billing-jobs.js";
import { usageAlertText } from "../src/application/usage-alerts.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { CallRecord, CollectedCallFields } from "../src/domain/models.js";
import { FAIR_USE_MULTIPLIER, knownPlans, planCatalog, planForPriceIds } from "../src/domain/plans.js";
import { extraCallsWithUnlimited } from "../src/domain/usage.js";
import { renderMarketing } from "../src/admin/marketing.js";
import { renderTerms } from "../src/admin/render.js";
import { createRequestHandler, createStripeClient } from "../src/http/app.js";
import { isDirectRun, planStripeSetup } from "../scripts/create-stripe-plans.js";

const fields: CollectedCallFields = {
  callerName: "Maria G.", companyName: null, callbackNumber: "+15555550142", address: "41 Palm Ave, Springfield, IL",
  serviceCategory: "HVAC repair", serviceCategoryConfidence: 0.9, problemDescription: "AC not cooling", equipmentDetails: null,
  accessNotes: null, requestedStart: null, explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: false, confidence: 0.9,
};

function call(tenantId: string, startedAt: string): CallRecord {
  return {
    id: randomUUID(), tenantId, providerCallId: `v3:${randomUUID()}`, fromNumber: "+15555550142", fromNumberVerified: true,
    startedAt, endedAt: startedAt, durationSeconds: 90, fields, emergency: null, outcome: "pending_confirmation", transcript: null,
    recordingUrl: null, consentState: "unknown", billingDisposition: "billable", qualityFlags: [], createdAt: startedAt, updatedAt: startedAt,
  };
}

type Recorded = { method: string; url: string; body: URLSearchParams; key: string | null };
/** Stripe, faked: records every request and answers from a small route table. Nothing leaves the process. */
function fakeStripe(routes: (request: Recorded) => { status?: number; json: unknown } | null) {
  const requests: Recorded[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const request: Recorded = { method: init?.method ?? "GET", url: String(input), body: new URLSearchParams(init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === "string" ? init.body : ""), key: headers["idempotency-key"] ?? null };
    requests.push(request);
    const answer = routes(request);
    if (!answer) throw new Error(`Unexpected Stripe request in test: ${request.method} ${request.url}`);
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { requests, fetcher };
}

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_abcdefghijklmnopqrstuvwxyz",
  STRIPE_PRICE_ID_SOLO: "price_solo_synthetic", STRIPE_PRICE_ID_PRO: "price_pro_synthetic", STRIPE_PRICE_ID_TEAM: "price_team_synthetic", STRIPE_PRICE_ID_FLEET: "price_fleet_synthetic",
  STRIPE_PRICE_ID_UNLIMITED_SOLO: "price_unl_solo", STRIPE_PRICE_ID_UNLIMITED_TEAM: "price_unl_team", STRIPE_PRICE_ID_UNLIMITED_FLEET: "price_unl_fleet",
};

describe("plans for sale: Solo, Team, Fleet (Pro is legacy only)", () => {
  it("sells three plans, Solo first, and never offers Pro", () => {
    const plans = planCatalog(demoEnvironment(STRIPE_ENV));
    expect(plans.map((plan) => [plan.id, plan.priceCents, plan.includedCalls, plan.overageCentsPerCall])).toEqual([
      ["solo", 4_999, 60, 75], ["team", 17_999, 250, 75], ["fleet", 34_999, 500, 75],
    ]);
    expect(planCatalog(demoEnvironment({})).map((plan) => plan.id)).toEqual(["solo", "team", "fleet"]);
  });

  it("keeps recognizing a subscription already on Pro (new or old price) so it keeps working", () => {
    const env = demoEnvironment({ ...STRIPE_ENV, STRIPE_PRICE_ID_PLUS: "price_plus_old" });
    const known = knownPlans(env);
    expect(planForPriceIds(known, ["price_pro_synthetic"])).toMatchObject({ id: "pro", sold: false, includedCalls: 125 });
    expect(planForPriceIds(known, ["price_plus_old"])?.id).toBe("pro");
    expect(createStripeClient(env, fetch)!.hasPlanPrice(["price_pro_synthetic"])).toBe(true);
    expect(createStripeClient(env, fetch)!.hasPlanPrice(["price_plus_old"])).toBe(true);
  });

  it("prices the Unlimited add-on per plan, fair use 3x the plan's calls", () => {
    const plans = planCatalog(demoEnvironment(STRIPE_ENV));
    expect(FAIR_USE_MULTIPLIER).toBe(3);
    expect(plans.map((plan) => [plan.id, plan.unlimited?.addOnCents, plan.unlimited?.priceCents, plan.unlimited?.fairUseCalls, plan.unlimited?.priceId])).toEqual([
      ["solo", 5_000, 9_999, 180, "price_unl_solo"],
      ["team", 7_500, 25_499, 750, "price_unl_team"],
      ["fleet", 12_500, 47_499, 1_500, "price_unl_fleet"],
    ]);
    // A plan whose add-on price isn't set in Stripe doesn't offer it.
    expect(planCatalog(demoEnvironment({ ...STRIPE_ENV, STRIPE_PRICE_ID_UNLIMITED_TEAM: "" })).find((plan) => plan.id === "team")!.unlimited).toBeNull();
  });

  it("takes half off the whole first invoice, add-on included, only with the offer on and the coupon set", () => {
    const withCoupon = planCatalog(demoEnvironment({ ...STRIPE_ENV, STRIPE_FIRST_MONTH_COUPON_ID: "front_office_first_month_50" }));
    expect(withCoupon.map((plan) => [plan.firstMonthCents, plan.unlimited?.firstMonthCents])).toEqual([[2_499, 4_999], [8_999, 12_749], [17_499, 23_749]]);
    const off = planCatalog(demoEnvironment({ ...STRIPE_ENV, STRIPE_FIRST_MONTH_COUPON_ID: "front_office_first_month_50", FIRST_MONTH_OFFER_ENABLED: "false" }));
    expect(off.map((plan) => [plan.firstMonthCents, plan.unlimited?.firstMonthCents])).toEqual([[4_999, 9_999], [17_999, 25_499], [34_999, 47_499]]);
    const noCoupon = planCatalog(demoEnvironment(STRIPE_ENV));
    expect(noCoupon[0]!.unlimited!.firstMonthCents).toBe(9_999);
  });
});

describe("extra calls with Unlimited", () => {
  it("bills nothing up to 3x the plan's calls while Unlimited is on, 75¢ each past that, and the plan's own limit while it was off", () => {
    // Never on: the plan's included calls.
    expect(extraCallsWithUnlimited({ countedCalls: 70, callsWithoutUnlimited: 70, includedCalls: 60 })).toBe(10);
    // On all period: free up to 180.
    expect(extraCallsWithUnlimited({ countedCalls: 170, callsWithoutUnlimited: 0, includedCalls: 60 })).toBe(0);
    expect(extraCallsWithUnlimited({ countedCalls: 185, callsWithoutUnlimited: 0, includedCalls: 60 })).toBe(5);
    // Turned on late: the 75 calls before it still went 15 past the plan.
    expect(extraCallsWithUnlimited({ countedCalls: 80, callsWithoutUnlimited: 75, includedCalls: 60 })).toBe(15);
  });
});

describe("period-end overage respects Unlimited", () => {
  const tenantId = "shop_unlimited";
  let store: InMemoryStore;
  let now: Date;
  const clock = { now: () => now };

  function overageStripe() {
    return fakeStripe((request) => {
      if (request.method === "POST" && request.url.endsWith("/v1/invoices")) return { json: { id: "in_overage" } };
      if (request.method === "GET" && request.url.endsWith("/v1/invoices/in_overage")) return { json: { id: "in_overage", status: "draft", lines: { data: [] } } };
      if (request.method === "POST" && request.url.endsWith("/v1/invoiceitems")) return { json: { id: "ii_overage" } };
      if (request.method === "POST" && request.url.endsWith("/v1/invoices/in_overage/finalize")) return { json: { id: "in_overage", status: "open" } };
      return null;
    });
  }

  beforeEach(async () => {
    store = new InMemoryStore();
    now = new Date("2026-01-21T00:00:00Z");
    // Two included calls, so fair use is six.
    await store.saveConfig({ ...createDemoConfig(tenantId), includedCalls: 2, unlimitedCalls: true });
    await store.saveSubscription({
      tenantId, providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic", status: "active",
      currentPeriodEnd: "2026-02-20T15:00:00.000Z", providerEventCreatedAt: "2025-12-20T15:00:00.000Z", createdAt: "2025-12-20T15:00:00.000Z", updatedAt: "2025-12-20T15:00:00.000Z",
    });
    await recordFirstPaid(store, tenantId, "2025-12-20T15:00:00.000Z");
  });

  async function calls(days: string[]) {
    for (const day of days) await store.saveCall(call(tenantId, `${day}T15:00:00.000Z`));
  }
  /** Stripe shows the add-on item (created at `at`), or no add-on item, as of `at`. */
  const on = (at: string, id = "si_unl") => recordUnlimitedObservation(store, tenantId, { at, items: [{ id, createdAt: at }] });
  const off = (at: string) => recordUnlimitedObservation(store, tenantId, { at, items: [] });
  async function billedQuantity(): Promise<string | null> {
    const stripe = overageStripe();
    await new OverageBillingService(store, new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, stripe.fetcher), clock).runOnce();
    return stripe.requests.find((request) => request.url.endsWith("/v1/invoiceitems"))?.body.get("quantity") ?? null;
  }

  it("bills nothing while the period stayed within fair use", async () => {
    await on("2025-12-20T15:00:00.000Z");
    await calls(["2025-12-21", "2025-12-22", "2025-12-23", "2025-12-24", "2025-12-25", "2025-12-26"]);
    const stripe = overageStripe();
    await new OverageBillingService(store, new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, stripe.fetcher), clock).runOnce();
    expect(stripe.requests).toHaveLength(0);
    expect(JSON.parse((await store.getIntegrationSecret(tenantId, "billing", "overage:2025-12-20T15:00:00.000Z"))!)).toMatchObject({ state: "none", calls: 0 });
  });

  it("bills each call past fair use at 75¢", async () => {
    await on("2025-12-20T15:00:00.000Z");
    await calls(["2025-12-21", "2025-12-22", "2025-12-23", "2025-12-24", "2025-12-25", "2025-12-26", "2025-12-27", "2025-12-28"]);
    const stripe = overageStripe();
    await new OverageBillingService(store, new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, stripe.fetcher), clock).runOnce();
    const item = stripe.requests.find((request) => request.url.endsWith("/v1/invoiceitems"))!;
    expect([item.body.get("quantity"), item.body.get("unit_amount_decimal")]).toEqual(["2", "75"]);
  });

  it("still bills the calls made before Unlimited was turned on, so a last-day switch can't erase a month of extras", async () => {
    await calls(["2025-12-21", "2025-12-22", "2025-12-23", "2025-12-24", "2026-01-18"]);
    await on("2026-01-19T00:00:00.000Z");
    await calls(["2026-01-19"]);
    const stripe = overageStripe();
    await new OverageBillingService(store, new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, stripe.fetcher), clock).runOnce();
    // 5 calls while off against 2 included: 3 extra. The one call after it went on is covered.
    expect(stripe.requests.find((request) => request.url.endsWith("/v1/invoiceitems"))!.body.get("quantity")).toBe("3");
  });

  it("covers only the time it was on when it was turned off mid-period", async () => {
    await on("2025-12-20T15:00:00.000Z");
    await calls(["2025-12-21", "2025-12-22", "2025-12-23", "2025-12-24"]);
    await off("2026-01-01T00:00:00.000Z");
    await store.saveConfig({ ...await store.getConfig(tenantId), unlimitedCalls: false });
    await calls(["2026-01-02", "2026-01-03", "2026-01-04"]);
    const stripe = overageStripe();
    await new OverageBillingService(store, new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, stripe.fetcher), clock).runOnce();
    // 3 calls while off against 2 included: 1 extra. Total 7 is past fair use (6) by 1 too, so 1.
    expect(stripe.requests.find((request) => request.url.endsWith("/v1/invoiceitems"))!.body.get("quantity")).toBe("1");
  });

  it("builds the same windows whatever order Stripe delivers on and off in", async () => {
    // Webhook payloads: the add-on item (created Dec 25) seen on Dec 25, gone by Jan 1. Delivered off first.
    await off("2026-01-01T00:00:00.000Z");
    await recordUnlimitedObservation(store, tenantId, { at: "2025-12-25T00:00:00.000Z", items: [{ id: "si_unl", createdAt: "2025-12-25T00:00:00.000Z" }] });
    expect(await unlimitedWindows(store, tenantId)).toEqual([{ from: "2025-12-25T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" }]);
    // Calls: 2 before (Dec 21, 22), 4 while on (Dec 26-29), 2 after (Jan 2, 3). Off calls 4 vs 2 included: 2 extra.
    await calls(["2025-12-21", "2025-12-22", "2025-12-26", "2025-12-27", "2025-12-28", "2025-12-29", "2026-01-02", "2026-01-03"]);
    expect(await billedQuantity()).toBe("2");
  });

  it("ignores a retried old 'on' after the add-on was removed, and duplicates", async () => {
    await on("2025-12-25T00:00:00.000Z");
    await on("2025-12-25T00:00:00.000Z");
    await off("2026-01-01T00:00:00.000Z");
    await off("2026-01-01T00:00:00.000Z");
    // Stripe retries the Dec 25 event after Jan 1: the window must stay closed, and must not move.
    await on("2025-12-25T00:00:00.000Z");
    await recordUnlimitedObservation(store, tenantId, { at: "2025-12-26T00:00:00.000Z", items: [{ id: "si_unl", createdAt: "2025-12-25T00:00:00.000Z" }] });
    expect(await unlimitedWindows(store, tenantId)).toEqual([{ from: "2025-12-25T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" }]);
    // An "off" seen later never pushes the end out; an earlier true "off" pulls it in.
    await off("2026-01-05T00:00:00.000Z");
    expect((await unlimitedWindows(store, tenantId))[0]!.to).toBe("2026-01-01T00:00:00.000Z");
    await off("2025-12-30T00:00:00.000Z");
    expect((await unlimitedWindows(store, tenantId))[0]!.to).toBe("2025-12-30T00:00:00.000Z");
  });

  it("closes a window turned on and off within the same second once a later observation sees it gone", async () => {
    await on("2025-12-25T00:00:00.000Z");
    await off("2025-12-25T00:00:00.000Z"); // same second: can't tell the order from Stripe's timestamps alone
    await recordUnlimitedObservation(store, tenantId, { at: "2025-12-25T00:00:00.400Z", items: [], live: true });
    const windows = await unlimitedWindows(store, tenantId);
    expect(windows).toEqual([{ from: "2025-12-25T00:00:00.000Z", to: "2025-12-25T00:00:00.400Z" }]);
    // Live reads taken at the same instant still advance: a toggle and its undo never leave a window open.
    await recordUnlimitedObservation(store, tenantId, { at: "2025-12-26T00:00:00.000Z", items: [{ id: "owner:x", createdAt: "2025-12-26T00:00:00.000Z" }], live: true });
    await recordUnlimitedObservation(store, tenantId, { at: "2025-12-26T00:00:00.000Z", items: [], live: true });
    const second = (await unlimitedWindows(store, tenantId))[1]!;
    expect(second.to).not.toBeNull();
    expect(Date.parse(second.to!)).toBeGreaterThan(Date.parse(second.from));
  });

  it("counts calls once where windows overlap and never goes negative", async () => {
    // Two add-on items overlapping (a replaced item seen briefly beside the old one): A Dec 20-25, B Dec 24-27.
    await recordUnlimitedObservation(store, tenantId, { at: "2025-12-24T12:00:00.000Z", items: [{ id: "si_a", createdAt: "2025-12-20T15:00:00.000Z" }, { id: "si_b", createdAt: "2025-12-24T00:00:00.000Z" }] });
    await recordUnlimitedObservation(store, tenantId, { at: "2025-12-25T00:00:00.000Z", items: [{ id: "si_b", createdAt: "2025-12-24T00:00:00.000Z" }] });
    await off("2025-12-27T00:00:00.000Z");
    // Dec 24 sits in both windows, Dec 26 in B; Dec 28-31 were made with it off. 4 off calls vs 2 included: 2 extra.
    // Summing the windows would count Dec 24 twice and bill only 1.
    await calls(["2025-12-24", "2025-12-26", "2025-12-28", "2025-12-29", "2025-12-30", "2025-12-31"]);
    expect(await billedQuantity()).toBe("2");
  });

  it("speaks fair use in the usage alert when Unlimited is on", () => {
    const text = usageAlertText({ includedCalls: 60, overageCentsPerCall: 75, unlimitedCalls: true }, { billableCalls: 140 }, 75);
    expect(text.sms).toBe("Otto: you've answered 140 of your 180 fair-use calls this month. Past that, calls are $0.75 each. Change plans in Settings.");
    expect(text.sms).toMatch(/^[A-Za-z0-9 !"#%&'()*+,\-./:;<=>?@$_\n]+$/);
  });
});

describe("Stripe: the add-on as its own subscription item", () => {
  const prices = { base: "price_solo", team: "price_team", fleet: "price_fleet", unlimited: { solo: "price_unl_solo", team: "price_unl_team", fleet: "price_unl_fleet" } };

  it("adds the add-on as a second line at checkout, with the once-only half-off coupon on the whole first invoice", async () => {
    const stripe = fakeStripe((request) => request.url.endsWith("/v1/checkout/sessions") ? { json: { id: "cs_x", url: "https://checkout.stripe.com/c/pay/cs_x" } } : null);
    const client = new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", prices, stripe.fetcher);
    await client.createCheckout({ tenantId: "t", email: "o@example.test", successUrl: "https://x.example/s", cancelUrl: "https://x.example/c", idempotencyKey: "k", plan: "team", unlimited: true, couponId: "front_office_first_month_50" });
    const body = Object.fromEntries(stripe.requests[0]!.body);
    expect(body).toMatchObject({ "line_items[0][price]": "price_team", "line_items[1][price]": "price_unl_team", "line_items[1][quantity]": "1", "discounts[0][coupon]": "front_office_first_month_50" });
    await client.createCheckout({ tenantId: "t", email: "o@example.test", successUrl: "https://x.example/s", cancelUrl: "https://x.example/c", idempotencyKey: "k2", plan: "solo", unlimited: false });
    expect(stripe.requests[1]!.body.has("line_items[1][price]")).toBe(false);
  });

  it("swaps the plan and the add-on together on a plan change, and adds or removes the add-on on a toggle", async () => {
    let items: Array<{ id: string; price: { id: string } }> = [{ id: "si_plan", price: { id: "price_solo" } }, { id: "si_unl", price: { id: "price_unl_solo" } }];
    const stripe = fakeStripe((request) => {
      if (request.method === "GET" && request.url.includes("/v1/subscriptions/sub_x")) return { json: { id: "sub_x", items: { data: items } } };
      if (request.method === "POST" && request.url.endsWith("/v1/subscriptions/sub_x")) return { json: { id: "sub_x" } };
      return null;
    });
    const client = new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", prices, stripe.fetcher);
    await client.changePlan("sub_x", "team", { unlimited: true });
    expect(Object.fromEntries(stripe.requests.at(-1)!.body)).toMatchObject({
      "items[0][id]": "si_plan", "items[0][price]": "price_team", "items[1][id]": "si_unl", "items[1][price]": "price_unl_team",
      proration_behavior: "always_invoice", payment_behavior: "error_if_incomplete",
    });
    await client.changePlan("sub_x", "solo", { unlimited: false });
    expect(Object.fromEntries(stripe.requests.at(-1)!.body)).toMatchObject({ "items[0][id]": "si_unl", "items[0][deleted]": "true", proration_behavior: "always_invoice" });
    items = [{ id: "si_plan", price: { id: "price_solo" } }];
    stripe.requests.length = 0;
    await client.changePlan("sub_x", "solo", { unlimited: true });
    expect(Object.fromEntries(stripe.requests.at(-1)!.body)).toMatchObject({ "items[0][price]": "price_unl_solo", "items[0][quantity]": "1", proration_behavior: "always_invoice" });
    expect(stripe.requests.at(-1)!.body.has("items[0][id]")).toBe(false);
    // Nothing to change: no write.
    stripe.requests.length = 0;
    await client.changePlan("sub_x", "solo", { unlimited: false });
    expect(stripe.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });
});

describe("Unlimited over HTTP: card step, Settings toggle, webhook sync", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  let now: Date;
  let stripe: ReturnType<typeof fakeStripe>;
  let items: Array<{ id: string; price: { id: string } }>;

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    now = new Date("2026-01-15T08:00:00.000Z");
    items = [{ id: "si_plan", price: { id: "price_solo_synthetic" } }];
    stripe = fakeStripe((request) => {
      if (request.method === "POST" && request.url.endsWith("/v1/checkout/sessions")) return { json: { id: "cs_test_synthetic", url: "https://checkout.stripe.com/c/pay/cs_test_synthetic" } };
      if (request.method === "POST" && request.url.endsWith("/expire")) return { json: { id: "cs_test_synthetic", status: "expired" } };
      if (request.method === "GET" && request.url.includes("/v1/subscriptions/sub_synthetic")) {
        return { json: { id: "sub_synthetic", status: "active", customer: "cus_synthetic", current_period_end: 1_770_000_000, metadata: {}, items: { data: items } } };
      }
      if (request.method === "POST" && request.url.endsWith("/v1/subscriptions/sub_synthetic")) return { json: { id: "sub_synthetic" } };
      return null;
    });
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", ...STRIPE_ENV, STRIPE_FIRST_MONTH_COUPON_ID: "front_office_first_month_50" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => now }, integrations: {}, logger: () => undefined, fetcher: stripe.fetcher }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  async function signup(extra: Record<string, string> = {}) {
    const response = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", email: "owner@example.test", password: "synthetic-password-42", ...extra }) });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const account = (await store.getOwnerAccountByEmail("owner@example.test"))!;
    return { response, cookie, account };
  }

  async function owner(paid: boolean) {
    const { cookie, account } = await signup();
    if (paid) {
      await store.saveSubscription({ tenantId: account.tenantId, providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic", status: "active", currentPeriodEnd: "2026-02-01T00:00:00.000Z", providerEventCreatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
      await recordFirstPaid(store, account.tenantId, "2026-01-01T00:00:00.000Z");
    }
    const { csrf } = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { csrf: string };
    const post = (path: string, body: unknown = {}) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
    return { cookie, csrf, tenantId: account.tenantId, post };
  }

  it("signs up with Unlimited from the pricing page and checks out with the add-on and the half-off coupon", async () => {
    const page = await (await fetch(`${baseUrl}/signup?unlimited=1`)).text();
    expect(page).toMatch(/<input[^>]*id="unlimited"[^>]*checked/);
    expect(page).toContain("Fair use: up to 3× your plan’s calls.");
    expect((await (await fetch(`${baseUrl}/signup`)).text())).not.toMatch(/<input[^>]*id="unlimited"[^>]*checked/);
    const { response, account } = await signup({ unlimited: "yes" });
    expect(response.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/cs_test_synthetic");
    const checkout = Object.fromEntries(stripe.requests.find((request) => request.url.endsWith("/v1/checkout/sessions"))!.body);
    expect(checkout).toMatchObject({ "line_items[0][price]": "price_solo_synthetic", "line_items[1][price]": "price_unl_solo", "discounts[0][coupon]": "front_office_first_month_50" });
    expect(checkout["custom_text[submit][message]"]).toContain("$49.99");
    expect(checkout["custom_text[submit][message]"]).toContain("$99.99");
    expect(await store.getConfig(account.tenantId)).toMatchObject({ planId: "solo", unlimitedCalls: true });
  });

  it("keeps Unlimited off by default and offers it on the card step with its own charge line", async () => {
    const shop = await owner(false);
    const dashboard = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie: shop.cookie } })).json() as { billing: { unlimited: boolean; plans: Array<{ id: string; unlimited: { priceCents: number; firstMonthCents: number; fairUseCalls: number; chargeNote: string } | null }> } };
    expect(dashboard.billing.unlimited).toBe(false);
    expect(dashboard.billing.plans.map((plan) => plan.id)).toEqual(["solo", "team", "fleet"]);
    expect(dashboard.billing.plans[0]!.unlimited).toMatchObject({ priceCents: 9_999, firstMonthCents: 4_999, fairUseCalls: 180 });
    expect(dashboard.billing.plans[0]!.unlimited!.chargeNote).toContain("$99.99");
    // The card step posts its choice: the add-on goes on the checkout.
    stripe.requests.length = 0;
    const response = await fetch(`${baseUrl}/app/billing/checkout`, { method: "POST", redirect: "manual", headers: { cookie: shop.cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: shop.csrf, from: "start", plan: "team", unlimited: "yes" }) });
    expect(response.status).toBe(303);
    expect(Object.fromEntries(stripe.requests.find((request) => request.url.endsWith("/v1/checkout/sessions"))!.body)).toMatchObject({ "line_items[0][price]": "price_team_synthetic", "line_items[1][price]": "price_unl_team" });
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ planId: "team", unlimitedCalls: true });
  });

  it("lets the owner turn Unlimited on and off in Settings, prorated in Stripe, and never offers Pro", async () => {
    const shop = await owner(true);
    const settings = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie: shop.cookie } })).json() as { plan: { plans: Array<{ id: string }>; unlimited: boolean } };
    expect(settings.plan.plans.map((plan) => plan.id)).toEqual(["solo", "team", "fleet"]);
    expect(settings.plan.unlimited).toBe(false);
    expect((await shop.post("/api/app/billing/plan", { plan: "pro" })).status).toBe(400);
    stripe.requests.length = 0;
    const on = await shop.post("/api/app/billing/unlimited", { on: true });
    expect(on.status).toBe(200);
    const update = stripe.requests.find((request) => request.method === "POST" && request.url.endsWith("/v1/subscriptions/sub_synthetic"))!;
    expect(Object.fromEntries(update.body)).toMatchObject({ "items[0][price]": "price_unl_solo", proration_behavior: "always_invoice", payment_behavior: "error_if_incomplete" });
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ unlimitedCalls: true });
    expect(await unlimitedWindows(store, shop.tenantId)).toEqual([{ from: now.toISOString(), to: null }]);
    const dashboard = await on.json() as { billing: { unlimited: boolean }; usage: { unlimited: boolean; fairUseCalls: number | null } };
    expect(dashboard.billing.unlimited).toBe(true);
    expect(dashboard.usage).toMatchObject({ unlimited: true, fairUseCalls: 180 });
    // Off again.
    items = [{ id: "si_plan", price: { id: "price_solo_synthetic" } }, { id: "si_unl", price: { id: "price_unl_solo" } }];
    now = new Date("2026-01-20T08:00:00.000Z");
    expect((await shop.post("/api/app/billing/unlimited", { on: false })).status).toBe(200);
    expect(Object.fromEntries(stripe.requests.at(-1)!.body)).toMatchObject({ "items[0][id]": "si_unl", "items[0][deleted]": "true" });
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ unlimitedCalls: false });
    expect(await unlimitedWindows(store, shop.tenantId)).toEqual([{ from: "2026-01-15T08:00:00.000Z", to: "2026-01-20T08:00:00.000Z" }]);
  });

  it("keeps the add-on on a plan change, at the new plan's add-on price", async () => {
    const shop = await owner(true);
    await shop.post("/api/app/billing/unlimited", { on: true });
    items = [{ id: "si_plan", price: { id: "price_solo_synthetic" } }, { id: "si_unl", price: { id: "price_unl_solo" } }];
    stripe.requests.length = 0;
    expect((await shop.post("/api/app/billing/plan", { plan: "fleet" })).status).toBe(200);
    expect(Object.fromEntries(stripe.requests.at(-1)!.body)).toMatchObject({ "items[0][price]": "price_fleet_synthetic", "items[1][id]": "si_unl", "items[1][price]": "price_unl_fleet" });
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ planId: "fleet", includedCalls: 500, unlimitedCalls: true });
  });

  it("turns Unlimited on from Stripe's webhook (e.g. a change in the billing portal) and opens its window once", async () => {
    const shop = await owner(true);
    items = [{ id: "si_plan", price: { id: "price_team_synthetic" } }, { id: "si_unl", price: { id: "price_unl_team" } }];
    const body = JSON.stringify({ id: "evt_sub_updated", type: "customer.subscription.updated", created: Math.floor(now.getTime() / 1_000), data: { object: { id: "sub_synthetic", metadata: { tenant_id: shop.tenantId } } } });
    const timestamp = Math.floor(now.getTime() / 1_000);
    const signature = createHmac("sha256", "whsec_synthetic_abcdefghijklmnopqrstuvwxyz").update(`${timestamp}.${body}`).digest("hex");
    const send = () => fetch(`${baseUrl}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body });
    expect((await send()).status).toBe(200);
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ planId: "team", unlimitedCalls: true });
    await send();
    expect(await unlimitedWindows(store, shop.tenantId)).toHaveLength(1);
  });

  it("rejects anything but a yes or no for the add-on", async () => {
    const shop = await owner(true);
    expect((await shop.post("/api/app/billing/unlimited", { on: "yes" })).status).toBe(400);
  });
});

describe("homepage pricing and terms", () => {
  const config = createDemoConfig();

  it("shows Solo, Team and Fleet with an Unlimited toggle that is off, and the fair-use line right next to it", () => {
    const plans = planCatalog(demoEnvironment({}));
    const html = renderMarketing(config, [], { plans });
    expect(html).toMatch(/<input[^>]*id="unlimited-toggle"[^>]*>/);
    expect(html).not.toMatch(/<input[^>]*id="unlimited-toggle"[^>]*checked/);
    expect(html).toMatch(/Unlimited calls<\/span><\/label><span class="fair">Fair use: up to 3× your plan’s calls\.<\/span>/);
    expect(html).not.toContain(">Pro<");
    for (const price of ["$49.99", "$179.99", "$349.99", "$99.99", "$254.99", "$474.99"]) expect(html).toContain(price);
    // Nothing is half off without the coupon.
    expect(html).not.toContain("half off");
    expect(html).toContain('href="/signup?unlimited=1"');
  });

  it("gives every plan card a standard and an Unlimited link, shown one at a time, named by the card's own text", () => {
    const plans = planCatalog(demoEnvironment({}));
    const html = renderMarketing(config, [], { plans });
    for (const plan of plans) {
      expect(html).toContain(`<a class="plan-row std" href="/signup?plan=${plan.id}">`);
      if (plan.unlimited) expect(html).toContain(`<a class="plan-row unl" href="/signup?plan=${plan.id}&amp;unlimited=1">`);
    }
    expect(html).not.toMatch(/class="plan-row[^"]*"[^>]*aria-label/);
    expect(html).toContain("a.plan-row.unl{display:none}");
    expect(html).toContain(".price-section:has(#unlimited-toggle:checked) a.plan-row.std{display:none}");
    expect(html).toContain(".price-section:has(#unlimited-toggle:checked) a.plan-row.unl{display:grid}");
  });

  it("advertises the first month half off only when the offer is on and the coupon is set", () => {
    const on = renderMarketing(config, [], { plans: planCatalog(demoEnvironment({ ...STRIPE_ENV, STRIPE_FIRST_MONTH_COUPON_ID: "front_office_first_month_50" })) });
    expect(on).toContain("Limited time: first month half off");
    const off = renderMarketing(config, [], { plans: planCatalog(demoEnvironment({ ...STRIPE_ENV, STRIPE_FIRST_MONTH_COUPON_ID: "front_office_first_month_50", FIRST_MONTH_OFFER_ENABLED: "false" })) });
    expect(off).not.toContain("half off");
  });

  it("puts the Unlimited add-on and its fair-use limit in the terms", () => {
    const terms = renderTerms(config, planCatalog(demoEnvironment({})));
    expect(terms).toContain("Unlimited calls");
    expect(terms).toContain("3 times the plan’s included calls");
    expect(terms).toContain("75¢");
    expect(terms).not.toContain("Pro is");
  });

  it("matches the owner text example on the homepage", () => {
    const html = renderMarketing(config, [], { plans: planCatalog(demoEnvironment({})) });
    expect(html).toContain("<b>New call: Maria</b><br>- AC not cooling<br>- 41 Palm Ave, Sarasota<br>- Wants someone today<br><br>Call back:");
  });
});

describe("scripts/create-stripe-plans.ts", () => {
  it("plans Solo, Team and Fleet, the three Unlimited add-ons by lookup key, and the 50%-once coupon", () => {
    const setup = planStripeSetup({});
    expect(setup.prices.map((price) => [price.envName, price.unitAmount, price.lookupKey])).toEqual([
      ["STRIPE_PRICE_ID_SOLO", 4_999, "front_office_solo_4999_monthly"],
      ["STRIPE_PRICE_ID_TEAM", 17_999, "front_office_team_17999_monthly"],
      ["STRIPE_PRICE_ID_FLEET", 34_999, "front_office_fleet_34999_monthly"],
      ["STRIPE_PRICE_ID_UNLIMITED_SOLO", 5_000, "front_office_unlimited_solo_5000_monthly"],
      ["STRIPE_PRICE_ID_UNLIMITED_TEAM", 7_500, "front_office_unlimited_team_7500_monthly"],
      ["STRIPE_PRICE_ID_UNLIMITED_FLEET", 12_500, "front_office_unlimited_fleet_12500_monthly"],
    ]);
    expect(setup.coupon).toEqual({ id: "front_office_first_month_50", percentOff: 50 });
  });

  it("runs when started directly, from the .ts source or the compiled .js", () => {
    expect(isDirectRun("file:///app/dist/scripts/create-stripe-plans.js", "/app/dist/scripts/create-stripe-plans.js")).toBe(true);
    expect(isDirectRun("file:///app/scripts/create-stripe-plans.ts", "/app/scripts/create-stripe-plans.ts")).toBe(true);
    expect(isDirectRun("file:///app/scripts/create-stripe-plans.ts", "/app/node_modules/vitest/vitest.mjs")).toBe(false);
    expect(isDirectRun("file:///app/scripts/create-stripe-plans.ts", undefined)).toBe(false);
  });
});
