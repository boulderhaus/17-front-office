import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { firstChargeFromEvent, StripeBillingClient } from "../src/adapters/stripe.js";
import { LeadGuaranteeService, OverageBillingService, recordFirstPaid } from "../src/application/billing-jobs.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig, normalizeBusinessConfig } from "../src/domain/config.js";
import type { CallRecord, CollectedCallFields } from "../src/domain/models.js";
import { knownPlans, planBlurb, planForPriceIds } from "../src/domain/plans.js";
import { isQualifyingLead, lastClosedBillingPeriod } from "../src/domain/usage.js";
import { createRequestHandler, createStripeClient } from "../src/http/app.js";
import { planStripeSetup } from "../scripts/create-stripe-plans.js";

const fields: CollectedCallFields = {
  callerName: "Maria G.", companyName: null, callbackNumber: "+15555550142", address: "41 Palm Ave, Springfield, IL",
  serviceCategory: "HVAC repair", serviceCategoryConfidence: 0.9, problemDescription: "AC not cooling", equipmentDetails: null,
  accessNotes: null, requestedStart: null, explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: false, confidence: 0.9,
};

function call(tenantId: string, startedAt: string, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: randomUUID(), tenantId, providerCallId: `v3:${randomUUID()}`, fromNumber: "+15555550142", fromNumberVerified: true,
    startedAt, endedAt: startedAt, durationSeconds: 90, fields, emergency: null, outcome: "pending_confirmation", transcript: null,
    recordingUrl: null, consentState: "unknown", billingDisposition: "billable", qualityFlags: [], createdAt: startedAt, updatedAt: startedAt,
    ...overrides,
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

describe("calls-based plans: domain", () => {
  it("describes each plan in plain words", () => {
    expect([60, 125, 250, 500].map(planBlurb)).toEqual([
      "60 answered calls a month, about 2 a day", "125 answered calls a month, about 4 a day",
      "250 answered calls a month, about 8 a day", "500 answered calls a month, about 17 a day",
    ]);
  });

  it("moves shops saved on the old plans and minutes onto calls", () => {
    const old = { ...createDemoConfig("old"), planId: "plus", includedMinutes: 200, overageCentsPerMinute: 20 } as unknown as Parameters<typeof normalizeBusinessConfig>[0];
    delete (old as { includedCalls?: number }).includedCalls;
    const config = normalizeBusinessConfig(old);
    expect(config).toMatchObject({ planId: "pro", includedCalls: 125, overageCentsPerCall: 75 });
    expect(config).not.toHaveProperty("includedMinutes");
    expect(normalizeBusinessConfig({ ...createDemoConfig("s"), planId: "standard" as never }).planId).toBe("solo");
  });

  it("knows which period just closed, from the Stripe period end", () => {
    // Renewal seen: the meter is on Jan 20 – Feb 20, so Dec 20 – Jan 20 closed.
    expect(lastClosedBillingPeriod(new Date("2026-01-25T00:00:00Z"), "2026-02-20T15:00:00.000Z")).toEqual(["2025-12-20T15:00:00.000Z", "2026-01-20T15:00:00.000Z"]);
    // Renewal not seen yet (or the plan ended): the stored period itself closed.
    expect(lastClosedBillingPeriod(new Date("2026-01-21T00:00:00Z"), "2026-01-20T15:00:00.000Z")).toEqual(["2025-12-20T15:00:00.000Z", "2026-01-20T15:00:00.000Z"]);
    expect(lastClosedBillingPeriod(new Date("2026-01-21T00:00:00Z"), null)).toBeNull();
  });

  it("counts a real lead only for an answered, non-spam call of 15 s+ with a name and a problem, or a booking/callback", () => {
    expect(isQualifyingLead(call("t", "2026-01-01T00:00:00Z"), false)).toBe(true);
    expect(isQualifyingLead(call("t", "2026-01-01T00:00:00Z", { fields: { ...fields, callerName: null } }), false)).toBe(false);
    expect(isQualifyingLead(call("t", "2026-01-01T00:00:00Z", { fields: { ...fields, callerName: null } }), true)).toBe(true);
    expect(isQualifyingLead(call("t", "2026-01-01T00:00:00Z", { fields: { ...fields, problemDescription: " " } }), false)).toBe(false);
    expect(isQualifyingLead(call("t", "2026-01-01T00:00:00Z", { durationSeconds: 14 }), true)).toBe(false);
    expect(isQualifyingLead(call("t", "2026-01-01T00:00:00Z", { outcome: "ignored_spam", billingDisposition: "spam_excluded" }), true)).toBe(false);
  });
});

describe("period-end overage billing", () => {
  const tenantId = "shop_overage";
  let store: InMemoryStore;
  let now: Date;
  const clock = { now: () => now };

  beforeEach(async () => {
    store = new InMemoryStore();
    now = new Date("2026-01-21T00:00:00Z");
    await store.saveConfig({ ...createDemoConfig(tenantId), includedCalls: 2 });
    await store.saveSubscription({
      tenantId, providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic", status: "active",
      currentPeriodEnd: "2026-02-20T15:00:00.000Z", providerEventCreatedAt: "2025-12-20T15:00:00.000Z", createdAt: "2025-12-20T15:00:00.000Z", updatedAt: "2025-12-20T15:00:00.000Z",
    });
    await recordFirstPaid(store, tenantId, "2025-12-20T15:00:00.000Z");
    // Closed period Dec 20 – Jan 20: five counted calls, one spam and one short (neither counts), one in the new period.
    for (const day of ["2025-12-21", "2025-12-28", "2026-01-02", "2026-01-09", "2026-01-15"]) await store.saveCall(call(tenantId, `${day}T15:00:00.000Z`));
    await store.saveCall(call(tenantId, "2026-01-03T15:00:00.000Z", { outcome: "ignored_spam", billingDisposition: "spam_excluded" }));
    await store.saveCall(call(tenantId, "2026-01-04T15:00:00.000Z", { durationSeconds: 9 }));
    await store.saveCall(call(tenantId, "2026-01-20T16:00:00.000Z"));
  });

  function stripeRoutes(options: { failItemOnce?: boolean } = {}) {
    let failed = false;
    let lines = 0;
    return fakeStripe((request) => {
      if (request.method === "POST" && request.url.endsWith("/v1/invoices")) return { json: { id: "in_overage" } };
      if (request.method === "GET" && request.url.endsWith("/v1/invoices/in_overage")) return { json: { id: "in_overage", status: "draft", lines: { data: Array.from({ length: lines }, () => ({ metadata: { front_office: "extra_calls" } })) } } };
      if (request.method === "POST" && request.url.endsWith("/v1/invoiceitems")) {
        if (options.failItemOnce && !failed) { failed = true; return { status: 500, json: { error: { message: "synthetic outage" } } }; }
        lines += 1;
        return { json: { id: "ii_overage" } };
      }
      if (request.method === "POST" && request.url.endsWith("/v1/invoices/in_overage/finalize")) return { json: { id: "in_overage", status: "open" } };
      return null;
    });
  }

  it("bills each extra call once at 75¢ on its own invoice, charged to the subscription's card", async () => {
    const stripe = stripeRoutes();
    const service = new OverageBillingService(store, new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, stripe.fetcher), clock);
    expect(await service.runOnce()).toEqual({ billed: 1, skipped: 0, failed: 0 });
    const [invoice, , item, finalize] = stripe.requests;
    expect(invoice!.body.get("customer")).toBe("cus_synthetic");
    expect(invoice!.body.get("subscription")).toBe("sub_synthetic");
    expect(invoice!.body.get("pending_invoice_items_behavior")).toBe("exclude");
    expect(invoice!.key).toBe(`fo-overage:${tenantId}:2025-12-20T15:00:00.000Z:invoice`);
    expect(item!.body.get("invoice")).toBe("in_overage");
    expect(item!.body.get("quantity")).toBe("3");
    expect(item!.body.get("unit_amount_decimal")).toBe("75");
    expect(item!.body.get("description")).toBe("Extra answered calls, Dec 20 – Jan 20: 3 × 75¢");
    expect(finalize!.url).toMatch(/\/v1\/invoices\/in_overage\/finalize$/);
    expect(JSON.parse((await store.getIntegrationSecret(tenantId, "billing", "overage:2025-12-20T15:00:00.000Z"))!)).toMatchObject({ state: "billed", calls: 3, amountCents: 225, invoiceId: "in_overage" });
    // Every replica, every hour after that: nothing more is sent to Stripe.
    await service.runOnce();
    now = new Date("2026-02-10T00:00:00Z");
    await service.runOnce();
    expect(stripe.requests).toHaveLength(4);
  });

  it("resumes on the same invoice after a failure halfway, never opening a second one", async () => {
    const stripe = stripeRoutes({ failItemOnce: true });
    const service = new OverageBillingService(store, new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, stripe.fetcher), clock);
    expect(await service.runOnce()).toMatchObject({ failed: 1 });
    expect(JSON.parse((await store.getIntegrationSecret(tenantId, "billing", "overage:2025-12-20T15:00:00.000Z"))!)).toMatchObject({ state: "invoice_created", invoiceId: "in_overage" });
    expect(await service.runOnce()).toMatchObject({ billed: 1 });
    expect(stripe.requests.filter((request) => request.method === "POST" && request.url.endsWith("/v1/invoices"))).toHaveLength(1);
    expect(stripe.requests.filter((request) => request.url.endsWith("/v1/invoiceitems"))).toHaveLength(2);
  });

  it("sends nothing to Stripe when the shop stayed within its calls, or for the month before it started paying", async () => {
    await store.saveConfig({ ...await store.getConfig(tenantId), includedCalls: 60 });
    const stripe = stripeRoutes();
    const service = new OverageBillingService(store, new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, stripe.fetcher), clock);
    await service.runOnce();
    expect(JSON.parse((await store.getIntegrationSecret(tenantId, "billing", "overage:2025-12-20T15:00:00.000Z"))!)).toMatchObject({ state: "none", calls: 0 });
    // First month: the "closed" period (Nov 20 – Dec 20) ends as they start paying.
    now = new Date("2026-01-05T00:00:00Z");
    await store.saveSubscription({ ...(await store.getSubscription(tenantId))!, currentPeriodEnd: "2026-01-20T15:00:00.000Z" });
    await store.saveConfig({ ...await store.getConfig(tenantId), includedCalls: 0 + 1 });
    await service.runOnce();
    expect(await store.getIntegrationSecret(tenantId, "billing", "overage:2025-11-20T15:00:00.000Z")).toBeNull();
    expect(stripe.requests).toHaveLength(0);
  });
});

describe("lead guarantee", () => {
  const tenantId = "shop_guarantee";
  let store: InMemoryStore;
  let now: Date;
  const clock = { now: () => now };
  const refunds: Array<{ tenantId: string; subscriptionId: string }> = [];
  const stripe = { refundFirstInvoice: async (input: { tenantId: string; subscriptionId: string }) => { refunds.push(input); return { refundId: "re_synthetic", amountCents: 2_499, invoiceId: "in_first" }; } };

  beforeEach(async () => {
    refunds.length = 0;
    store = new InMemoryStore();
    now = new Date("2026-01-01T00:00:00Z");
    await store.saveConfig(createDemoConfig(tenantId));
    await store.saveSubscription({
      tenantId, providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic", status: "active",
      currentPeriodEnd: "2026-01-31T00:00:00.000Z", providerEventCreatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await recordFirstPaid(store, tenantId, "2026-01-01T00:00:00.000Z");
  });

  it("watches the first 30 days, offers the refund only on days 30–37 with zero real leads, then closes", async () => {
    const guarantee = new LeadGuaranteeService(store, stripe, clock);
    now = new Date("2026-01-20T00:00:00Z");
    expect(await guarantee.status(tenantId)).toMatchObject({ state: "watching", leads: 0, windowEndsAt: "2026-01-31T00:00:00.000Z", claimUntil: "2026-02-07T00:00:00.000Z" });
    await expect(guarantee.refund(tenantId, "owner")).rejects.toMatchObject({ status: 409, message: "Your first 30 days aren’t over yet." });
    now = new Date("2026-02-02T00:00:00Z");
    // Spam, hang-ups and nameless calls without a follow-up are not leads.
    await store.saveCall(call(tenantId, "2026-01-05T00:00:00.000Z", { outcome: "ignored_spam", billingDisposition: "spam_excluded" }));
    await store.saveCall(call(tenantId, "2026-01-06T00:00:00.000Z", { durationSeconds: 8 }));
    await store.saveCall(call(tenantId, "2026-01-07T00:00:00.000Z", { fields: { ...fields, callerName: null } }));
    // A lead after day 30 doesn't count toward the first 30 days.
    await store.saveCall(call(tenantId, "2026-02-01T00:00:00.000Z"));
    expect(await guarantee.status(tenantId)).toMatchObject({ state: "eligible", leads: 0 });
    now = new Date("2026-02-08T00:00:00Z");
    expect(await guarantee.status(tenantId)).toMatchObject({ state: "closed" });
  });

  it("refunds once, idempotently, and logs it", async () => {
    const log: Array<Record<string, unknown>> = [];
    const guarantee = new LeadGuaranteeService(store, stripe, clock, (entry) => log.push(entry));
    now = new Date("2026-02-03T00:00:00Z");
    const first = await guarantee.refund(tenantId, "owner");
    const again = await guarantee.refund(tenantId, "owner");
    expect(first).toEqual(again);
    expect(refunds).toEqual([{ tenantId, subscriptionId: "sub_synthetic" }]);
    expect(log).toEqual([expect.objectContaining({ event: "lead_guarantee_refunded", tenantId, by: "owner", leads: 0, amountCents: 2_499, refundId: "re_synthetic" })]);
    expect(await guarantee.status(tenantId)).toMatchObject({ state: "refunded", refund: { amountCents: 2_499 } });
  });

  it("refuses when even one real lead came in, for the owner and for support", async () => {
    const guarantee = new LeadGuaranteeService(store, stripe, clock);
    await store.saveCall(call(tenantId, "2026-01-10T00:00:00.000Z", { fields: { ...fields, callerName: null } }));
    const withTask = call(tenantId, "2026-01-12T00:00:00.000Z", { fields: { ...fields, callerName: null } });
    await store.saveCall(withTask);
    await store.saveCallbackTask({ id: randomUUID(), tenantId, callId: withTask.id, ownerRef: "owner-primary", reason: "Call back", priority: "normal", status: "open", dueAt: "2026-01-12T01:00:00.000Z", completedAt: null, completionSource: null, createdAt: "2026-01-12T00:00:00.000Z", updatedAt: "2026-01-12T00:00:00.000Z" });
    now = new Date("2026-02-02T00:00:00Z");
    expect(await guarantee.status(tenantId)).toMatchObject({ state: "closed", leads: 1 });
    await expect(guarantee.refund(tenantId, "owner")).rejects.toMatchObject({ status: 409, message: "Call Otto sent you 1 real lead in your first 30 days, so the lead guarantee doesn’t apply." });
    await expect(guarantee.refund(tenantId, "admin")).rejects.toMatchObject({ status: 409 });
    expect(refunds).toHaveLength(0);
  });

  it("lets support refund a late claim (a receipt reply after day 37) under the same zero-lead check", async () => {
    const guarantee = new LeadGuaranteeService(store, stripe, clock);
    now = new Date("2026-02-20T00:00:00Z");
    await expect(guarantee.refund(tenantId, "owner")).rejects.toMatchObject({ status: 409 });
    expect((await guarantee.refund(tenantId, "admin")).by).toBe("admin");
  });

  it("refunds the first paid invoice's payment in Stripe, old and new API shapes", async () => {
    const newer = fakeStripe((request) => {
      if (request.url.includes("/v1/invoices?subscription=sub_synthetic&status=paid")) return { json: { data: [{ id: "in_second", amount_paid: 4_999, created: 200 }, { id: "in_first", amount_paid: 2_499, created: 100 }] } };
      if (request.url.includes("/v1/invoice_payments?invoice=in_first")) return { json: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_first" } }] } };
      if (request.method === "GET" && request.url.includes("/v1/refunds?payment_intent=pi_first")) return { json: { data: [] } };
      if (request.method === "POST" && request.url.endsWith("/v1/refunds")) return { json: { id: "re_1", amount: 2_499 } };
      return null;
    });
    const refund = await new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, newer.fetcher).refundFirstInvoice({ tenantId, subscriptionId: "sub_synthetic" });
    expect(refund).toEqual({ refundId: "re_1", amountCents: 2_499, invoiceId: "in_first" });
    const post = newer.requests.at(-1)!;
    expect(post.body.get("payment_intent")).toBe("pi_first");
    expect(post.body.get("metadata[front_office]")).toBe("lead_guarantee");
    expect(post.key).toBe(`lead-refund:${tenantId}`);

    const older = fakeStripe((request) => {
      if (request.url.includes("/v1/invoices?")) return { json: { data: [{ id: "in_first", amount_paid: 2_499, created: 100, charge: "ch_first" }] } };
      if (request.method === "GET" && request.url.includes("/v1/refunds?charge=ch_first")) return { json: { data: [] } };
      if (request.method === "POST" && request.url.endsWith("/v1/refunds")) return { json: { id: "re_2", amount: 2_499 } };
      return null;
    });
    await new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, older.fetcher).refundFirstInvoice({ tenantId, subscriptionId: "sub_synthetic" });
    expect(older.requests.at(-1)!.body.get("charge")).toBe("ch_first");
  });
});

describe("plan changes and the guarantee over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  let now: Date;
  let stripe: ReturnType<typeof fakeStripe>;
  let subscriptionPrice = "price_solo_synthetic";

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    now = new Date("2026-01-15T08:00:00.000Z");
    subscriptionPrice = "price_solo_synthetic";
    stripe = fakeStripe((request) => {
      if (request.method === "POST" && request.url.endsWith("/v1/checkout/sessions")) return { json: { id: "cs_test_synthetic", url: "https://checkout.stripe.com/c/pay/cs_test_synthetic" } };
      if (request.method === "GET" && request.url.endsWith("/v1/subscriptions/sub_synthetic")) return { json: { id: "sub_synthetic", items: { data: [{ id: "si_plan", price: { id: subscriptionPrice } }, { id: "si_addon", price: { id: "price_addon" } }] } } };
      // Stripe's invoice preview for a proposed change: one proration line.
      if (request.method === "POST" && request.url.endsWith("/v1/invoices/create_preview")) return { json: { lines: { data: [{ amount: 1_000, proration: true }] } } };
      if (request.method === "POST" && request.url.endsWith("/v1/subscriptions/sub_synthetic")) return { json: { id: "sub_synthetic" } };
      if (request.url.includes("/v1/invoices?")) return { json: { data: [{ id: "in_first", amount_paid: 2_499, created: 1, charge: "ch_first" }] } };
      if (request.method === "GET" && request.url.includes("/v1/refunds?")) return { json: { data: [] } };
      if (request.method === "POST" && request.url.endsWith("/v1/refunds")) return { json: { id: "re_http", amount: 2_499 } };
      return null;
    });
    const env = demoEnvironment({
      ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz",
      STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_abcdefghijklmnopqrstuvwxyz",
      STRIPE_PRICE_ID_SOLO: "price_solo_synthetic", STRIPE_PRICE_ID_PRO: "price_pro_synthetic", STRIPE_PRICE_ID_TEAM: "price_team_synthetic", STRIPE_PRICE_ID_FLEET: "price_fleet_synthetic",
    });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => now }, integrations: {}, logger: () => undefined, fetcher: stripe.fetcher }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  async function owner(paid: boolean) {
    const response = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", email: "owner@example.test", password: "synthetic-password-42" }) });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const account = (await store.getOwnerAccountByEmail("owner@example.test"))!;
    if (paid) {
      await store.saveSubscription({ tenantId: account.tenantId, providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic", status: "active", currentPeriodEnd: "2026-02-01T00:00:00.000Z", providerEventCreatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
      await recordFirstPaid(store, account.tenantId, "2026-01-01T00:00:00.000Z");
    }
    const { csrf } = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { csrf: string };
    const post = (path: string, body: unknown = {}) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
    // A paying shop's change goes through the price check first: preview, then confirm with that quote.
    const change = async (plan: string, unlimited: boolean) => {
      const quote = await (await post("/api/app/billing/preview", { plan, unlimited })).json() as { prorationDate: number | null; todayCents: number; creditCents: number; estimated: boolean };
      return post("/api/app/billing/change", { plan, unlimited, confirm: quote.prorationDate === null ? undefined : { prorationDate: quote.prorationDate, todayCents: quote.todayCents, creditCents: quote.creditCents, estimated: quote.estimated } });
    };
    return { cookie, tenantId: account.tenantId, accountId: account.id, post, change };
  }

  it("moves a paying owner to Team in Stripe with proration, then saves the new calls", async () => {
    const shop = await owner(true);
    stripe.requests.length = 0;
    const response = await shop.change("team", false);
    expect(response.status).toBe(200);
    const update = stripe.requests.find((request) => request.method === "POST" && request.url.endsWith("/v1/subscriptions/sub_synthetic"))!;
    expect(Object.fromEntries(update.body)).toMatchObject({ "items[0][id]": "si_plan", "items[0][price]": "price_team_synthetic", proration_behavior: "always_invoice", payment_behavior: "error_if_incomplete", proration_date: String(Math.floor(now.getTime() / 1_000)) });
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ planId: "team", flatMonthlyPriceCents: 17_999, includedCalls: 250 });
    const dashboard = await response.json() as { billing: { planId: string }; usage: { includedCalls: number } };
    expect(dashboard.billing.planId).toBe("team");
    expect(dashboard.usage.includedCalls).toBe(250);
  });

  it("remembers the pick before paying without calling Stripe, and rejects unknown plans", async () => {
    const shop = await owner(false);
    stripe.requests.length = 0;
    expect((await shop.post("/api/app/billing/plan", { plan: "fleet" })).status).toBe(200);
    expect(stripe.requests).toHaveLength(0);
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ planId: "fleet", includedCalls: 500 });
    expect((await shop.post("/api/app/billing/plan", { plan: "unlimited" })).status).toBe(400);
  });

  it("keeps the plan when settings are saved, whatever the price", async () => {
    const shop = await owner(true);
    await shop.change("fleet", false);
    const settings = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie: shop.cookie } })).json() as { csrf: string; values: Record<string, unknown>; plan: { id: string; includedCalls: number; plans: unknown[] } };
    expect(settings.plan).toMatchObject({ id: "fleet", includedCalls: 500 });
    expect(settings.plan.plans).toHaveLength(3);
    const saved = await fetch(`${baseUrl}/api/app/settings`, { method: "PUT", headers: { cookie: shop.cookie, "content-type": "application/json", "x-csrf-token": settings.csrf }, body: JSON.stringify({ ...settings.values, greeting: "Thanks for calling Synthetic Air." }) });
    expect(saved.status).toBe(200);
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ planId: "fleet", flatMonthlyPriceCents: 34_999, includedCalls: 500 });
  });

  it("shows the refund only when the server finds zero real leads, and re-checks on the tap", async () => {
    now = new Date("2026-02-02T00:00:00.000Z"); // day 32 after the first payment on Jan 1
    const shop = await owner(true);
    let dashboard = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie: shop.cookie } })).json() as { guarantee: { state: string; leads: number } };
    expect(dashboard.guarantee).toMatchObject({ state: "eligible", leads: 0 });
    // A lead lands in the record (e.g. a late webhook for a day-10 call): the tap is refused, nothing is refunded.
    await store.saveCall(call(shop.tenantId, "2026-01-10T00:00:00.000Z"));
    const refused = await shop.post("/api/app/billing/lead-refund");
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toBe("Call Otto sent you 1 real lead in your first 30 days, so the lead guarantee doesn’t apply.");
    expect(stripe.requests.some((request) => request.url.includes("/v1/refunds"))).toBe(false);
    dashboard = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie: shop.cookie } })).json() as { guarantee: { state: string; leads: number } };
    expect(dashboard.guarantee).toMatchObject({ state: "closed", leads: 1 });
  });

  it("refunds the first month with one tap when eligible, once", async () => {
    now = new Date("2026-02-02T00:00:00.000Z"); // day 32 after the first payment on Jan 1
    const shop = await owner(true);
    const response = await shop.post("/api/app/billing/lead-refund");
    expect(response.status).toBe(200);
    expect((await response.json() as { guarantee: { state: string } }).guarantee.state).toBe("refunded");
    expect((await shop.post("/api/app/billing/lead-refund")).status).toBe(200);
    expect(stripe.requests.filter((request) => request.url.endsWith("/v1/refunds"))).toHaveLength(1);
  });

  it("starts the guarantee clock from Stripe's invoice.paid webhook, at the time it was paid", async () => {
    const shop = await owner(false);
    expect(await store.getIntegrationSecret(shop.tenantId, "billing", "first_paid_at")).toBeNull();
    const paidAt = Math.floor(Date.parse("2026-01-15T07:59:00.000Z") / 1_000);
    const body = JSON.stringify({ id: "evt_invoice_paid", type: "invoice.paid", created: paidAt + 5, data: { object: { id: "in_first", amount_paid: 2_499, status_transitions: { paid_at: paidAt }, parent: { subscription_details: { metadata: { tenant_id: shop.tenantId } } } } } });
    const timestamp = Math.floor(now.getTime() / 1_000);
    const signature = createHmac("sha256", "whsec_synthetic_abcdefghijklmnopqrstuvwxyz").update(`${timestamp}.${body}`).digest("hex");
    const response = await fetch(`${baseUrl}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body });
    expect(response.status).toBe(200);
    expect(await store.getIntegrationSecret(shop.tenantId, "billing", "first_paid_at")).toBe("2026-01-15T07:59:00.000Z");
  });

  it("gives support the same check from the admin endpoint", async () => {
    now = new Date("2026-02-02T00:00:00.000Z"); // day 32 after the first payment on Jan 1
    const shop = await owner(true);
    const auth = { authorization: "Bearer admin-token-abcdefghijklmnopqrstuvwxyz" };
    const status = await (await fetch(`${baseUrl}/admin/owners/${shop.accountId}/lead-refund`, { headers: auth })).json() as { guarantee: { state: string } };
    expect(status.guarantee.state).toBe("eligible");
    const refunded = await fetch(`${baseUrl}/admin/owners/${shop.accountId}/lead-refund`, { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: "" });
    expect(refunded.status).toBe(200);
    expect(await refunded.json()).toMatchObject({ refunded: true, refund: { by: "admin", refundId: "re_http" } });
  });
});

describe("scripts/create-stripe-plans.ts", () => {
  it("plans the monthly prices by lookup key and the 50%-once coupon from the approved defaults", () => {
    const setup = planStripeSetup({});
    expect(setup.products.map((product) => product.name)).toEqual(["Call Otto Solo", "Call Otto Team", "Call Otto Fleet", "Unlimited calls"]);
    expect(setup.prices.filter((price) => price.kind === "plan").map((price) => [price.envName, price.label, price.unitAmount, price.includedCalls, price.lookupKey])).toEqual([
      ["STRIPE_PRICE_ID_SOLO", "Solo", 4_999, 60, "front_office_solo_4999_monthly"],
      ["STRIPE_PRICE_ID_TEAM", "Team", 17_999, 250, "front_office_team_17999_monthly"],
      ["STRIPE_PRICE_ID_FLEET", "Fleet", 34_999, 500, "front_office_fleet_34999_monthly"],
    ]);
    expect(setup.coupon).toEqual({ id: "front_office_first_month_50", percentOff: 50 });
    // A new price gets a new lookup key, so an old price is never reused for a new amount.
    expect(planStripeSetup({ PLAN_TEAM_PRICE_CENTS: "18999" }).prices[1]!.lookupKey).toBe("front_office_team_18999_monthly");
    expect(planStripeSetup({ PLAN_TEAM_UNLIMITED_CENTS: "8000" }).prices[4]!.lookupKey).toBe("front_office_unlimited_team_8000_monthly");
  });
});

describe("money-path hardening (review fixes)", () => {
  const tenantId = "shop_hardening";
  let store: InMemoryStore;
  let now: Date;
  const clock = { now: () => now };

  async function paidShop(paidAt: string | null, periodEnd = "2026-02-20T15:00:00.000Z") {
    store = new InMemoryStore();
    await store.saveConfig({ ...createDemoConfig(tenantId), includedCalls: 2 });
    await store.saveSubscription({
      tenantId, providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic", status: "active",
      currentPeriodEnd: periodEnd, providerEventCreatedAt: "2025-11-01T00:00:00.000Z", createdAt: "2025-11-01T00:00:00.000Z", updatedAt: "2025-11-01T00:00:00.000Z",
    });
    if (paidAt) await recordFirstPaid(store, tenantId, paidAt);
  }
  const refundingStripe = (failFirst = false) => {
    let calls = 0;
    return {
      calls: () => calls,
      refundFirstInvoice: async () => {
        calls += 1;
        if (failFirst && calls === 1) throw new Error("synthetic timeout");
        return { refundId: "re_synthetic", amountCents: 2_499, invoiceId: "in_first" };
      },
    };
  };

  it("never guesses the guarantee clock from the subscription record: no recorded charge, no refund", async () => {
    await paidShop(null);
    now = new Date("2026-02-02T00:00:00Z");
    const stripe = refundingStripe();
    const guarantee = new LeadGuaranteeService(store, stripe, clock);
    expect(await guarantee.status(tenantId)).toMatchObject({ state: "none" });
    await expect(guarantee.refund(tenantId, "owner")).rejects.toMatchObject({ status: 409 });
    await expect(guarantee.refund(tenantId, "admin")).rejects.toMatchObject({ status: 409 });
    expect(stripe.calls()).toBe(0);
  });

  it("keeps the earliest recorded charge, whatever order Stripe's events arrive in", async () => {
    await paidShop("2026-01-03T00:00:00.000Z");
    await recordFirstPaid(store, tenantId, "2026-01-01T00:00:00.000Z");
    await recordFirstPaid(store, tenantId, "2026-02-01T00:00:00.000Z");
    expect(await store.getIntegrationSecret(tenantId, "billing", "first_paid_at")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reads the first charge from invoice.paid (old and new shapes) and paid checkouts, never from $0 or subscription events", () => {
    const event = (type: string, object: Record<string, unknown>) => ({ id: "evt", type, created: 1_767_225_600, data: { object } });
    expect(firstChargeFromEvent(event("invoice.paid", { amount_paid: 2_499, status_transitions: { paid_at: 1_767_225_000 }, parent: { subscription_details: { metadata: { tenant_id: "shop_a" } } } }))).toEqual({ tenantId: "shop_a", at: new Date(1_767_225_000_000).toISOString() });
    expect(firstChargeFromEvent(event("invoice.paid", { amount_paid: 2_499, subscription_details: { metadata: { tenant_id: "shop_b" } } }))).toEqual({ tenantId: "shop_b", at: new Date(1_767_225_600_000).toISOString() });
    expect(firstChargeFromEvent(event("invoice.paid", { amount_paid: 0, subscription_details: { metadata: { tenant_id: "shop_b" } } }))).toBeNull();
    expect(firstChargeFromEvent(event("checkout.session.completed", { payment_status: "paid", amount_total: 2_499, client_reference_id: "shop_c" }))).toMatchObject({ tenantId: "shop_c" });
    expect(firstChargeFromEvent(event("checkout.session.completed", { payment_status: "no_payment_required", amount_total: 0, client_reference_id: "shop_c" }))).toBeNull();
    expect(firstChargeFromEvent(event("customer.subscription.updated", { status: "active", metadata: { tenant_id: "shop_d" } }))).toBeNull();
  });

  it("refuses the refund when the lead scan can't read every call in the window", async () => {
    await paidShop("2026-01-01T00:00:00.000Z");
    class CappedStore extends InMemoryStore {
      // A window with more calls than the scan reads: every one a non-lead, but the page is full.
      override async listCallsStartedBetween(tenant: string, from: string, _to: string, limit: number): Promise<CallRecord[]> {
        return Array.from({ length: limit }, () => call(tenant, from, { durationSeconds: 5 }));
      }
    }
    const capped = new CappedStore();
    await capped.saveConfig(createDemoConfig(tenantId));
    await capped.saveSubscription((await store.getSubscription(tenantId))!);
    await recordFirstPaid(capped, tenantId, "2026-01-01T00:00:00.000Z");
    now = new Date("2026-02-02T00:00:00Z");
    const stripe = refundingStripe();
    const guarantee = new LeadGuaranteeService(capped, stripe, clock);
    expect(await guarantee.status(tenantId)).toMatchObject({ state: "closed", leads: 0, complete: false });
    await expect(guarantee.refund(tenantId, "owner")).rejects.toMatchObject({ status: 409, message: "We couldn’t check every call from your first 30 days. Reply to your receipt and we’ll review it." });
    await expect(guarantee.refund(tenantId, "admin")).rejects.toMatchObject({ status: 409 });
    expect(stripe.calls()).toBe(0);
  });

  it("counts leads only inside [first charge, +30 days], however many calls came later", async () => {
    await paidShop("2026-01-01T00:00:00.000Z");
    await store.saveCall(call(tenantId, "2025-12-31T23:00:00.000Z")); // before the first charge
    await store.saveCall(call(tenantId, "2026-01-31T00:00:01.000Z")); // after day 30
    for (let index = 0; index < 50; index += 1) await store.saveCall(call(tenantId, `2026-02-01T0${index % 10}:00:00.000Z`, { fields: { ...fields, callerName: null } }));
    now = new Date("2026-02-02T00:00:00Z");
    expect(await new LeadGuaranteeService(store, refundingStripe(), clock).status(tenantId)).toMatchObject({ state: "eligible", leads: 0, complete: true });
  });

  it("writes a pending marker before calling Stripe, and a retry finishes that same refund", async () => {
    await paidShop("2026-01-01T00:00:00.000Z");
    now = new Date("2026-02-02T00:00:00Z");
    const stripe = refundingStripe(true);
    const guarantee = new LeadGuaranteeService(store, stripe, clock);
    await expect(guarantee.refund(tenantId, "owner")).rejects.toThrow("synthetic timeout");
    expect(JSON.parse((await store.getIntegrationSecret(tenantId, "billing", "lead_refund"))!)).toMatchObject({ state: "pending", by: "owner", subscriptionId: "sub_synthetic" });
    expect(await guarantee.status(tenantId)).toMatchObject({ state: "pending" });
    // The decision was made; a lead record landing now doesn't undo a refund already under way.
    await store.saveCall(call(tenantId, "2026-01-10T00:00:00.000Z"));
    expect(await guarantee.refund(tenantId, "owner")).toMatchObject({ state: "refunded", refundId: "re_synthetic" });
    expect(await guarantee.refund(tenantId, "owner")).toMatchObject({ state: "refunded" });
    expect(stripe.calls()).toBe(2);
  });

  it("returns a refund Stripe already made instead of making a second one", async () => {
    const stripe = fakeStripe((request) => {
      if (request.url.includes("/v1/invoices?")) return { json: { data: [{ id: "in_first", amount_paid: 2_499, created: 1, charge: "ch_first" }] } };
      if (request.method === "GET" && request.url.includes("/v1/refunds?charge=ch_first")) return { json: { data: [{ id: "re_earlier", amount: 2_499, status: "succeeded", metadata: { front_office: "lead_guarantee", tenant_id: tenantId } }] } };
      return null;
    });
    const refund = await new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, stripe.fetcher).refundFirstInvoice({ tenantId, subscriptionId: "sub_synthetic" });
    expect(refund).toEqual({ refundId: "re_earlier", amountCents: 2_499, invoiceId: "in_first" });
    expect(stripe.requests.some((request) => request.method === "POST")).toBe(false);
  });

  function overageStripe() {
    let lines = 0;
    return fakeStripe((request) => {
      if (request.method === "POST" && request.url.endsWith("/v1/invoices")) return { json: { id: "in_overage" } };
      if (request.method === "GET" && request.url.endsWith("/v1/invoices/in_overage")) return { json: { id: "in_overage", status: "draft", lines: { data: Array.from({ length: lines }, () => ({ metadata: { front_office: "extra_calls" } })) } } };
      if (request.method === "POST" && request.url.endsWith("/v1/invoiceitems")) { lines += 1; return { json: { id: "ii_overage" } }; }
      if (request.method === "POST" && request.url.endsWith("/finalize")) return { json: { id: "in_overage" } };
      return null;
    });
  }

  it("never bills calls from before the first charge, even inside the closed period", async () => {
    // Closed period Dec 20 – Jan 20, but the first charge was Jan 5: only calls from Jan 5 count.
    await paidShop("2026-01-05T00:00:00.000Z");
    for (const day of ["2025-12-22", "2025-12-26", "2026-01-02", "2026-01-03"]) await store.saveCall(call(tenantId, `${day}T15:00:00.000Z`));
    for (const day of ["2026-01-06", "2026-01-08", "2026-01-12"]) await store.saveCall(call(tenantId, `${day}T15:00:00.000Z`));
    now = new Date("2026-01-21T00:00:00Z");
    const stripe = overageStripe();
    await new OverageBillingService(store, new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, stripe.fetcher), clock).runOnce();
    expect(stripe.requests.find((request) => request.url.endsWith("/v1/invoiceitems"))!.body.get("quantity")).toBe("1"); // 3 counted − 2 included
    expect(JSON.parse((await store.getIntegrationSecret(tenantId, "billing", "overage:2025-12-20T15:00:00.000Z"))!)).toMatchObject({ usageFrom: "2026-01-05T00:00:00.000Z", calls: 1 });
  });

  it("snapshots the period's allowance and rate when it closes, and keeps re-counting late calls", async () => {
    await paidShop("2025-12-20T15:00:00.000Z");
    await store.saveConfig({ ...await store.getConfig(tenantId), includedCalls: 3, overageCentsPerCall: 75 });
    for (const day of ["2025-12-22", "2025-12-26", "2026-01-02"]) await store.saveCall(call(tenantId, `${day}T15:00:00.000Z`));
    now = new Date("2026-01-21T00:00:00Z");
    const stripe = overageStripe();
    const service = new OverageBillingService(store, new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, stripe.fetcher), clock);
    await service.runOnce();
    expect(JSON.parse((await store.getIntegrationSecret(tenantId, "billing", "overage:2025-12-20T15:00:00.000Z"))!)).toMatchObject({ state: "none", includedCalls: 3, centsPerCall: 75 });
    // The owner moves to a plan with fewer calls and a different rate after the period closed: the old period keeps its snapshot.
    await store.saveConfig({ ...await store.getConfig(tenantId), includedCalls: 1, overageCentsPerCall: 99 });
    now = new Date("2026-01-22T00:00:00Z");
    await service.runOnce();
    expect(stripe.requests).toHaveLength(0);
    // A late record for a call inside the period: "none" was not final, so it is billed at the snapshot.
    await store.saveCall(call(tenantId, "2026-01-10T15:00:00.000Z"));
    now = new Date("2026-01-23T00:00:00Z");
    expect(await service.runOnce()).toMatchObject({ billed: 1 });
    const item = stripe.requests.find((request) => request.url.endsWith("/v1/invoiceitems"))!;
    expect([item.body.get("quantity"), item.body.get("unit_amount_decimal")]).toEqual(["1", "75"]);
    // After the lookback, a closed period is left alone.
    await store.saveCall(call(tenantId, "2026-01-11T15:00:00.000Z"));
    await store.deleteIntegrationSecret(tenantId, "billing", "overage:2025-12-20T15:00:00.000Z");
    await store.saveSubscription({ ...(await store.getSubscription(tenantId))!, currentPeriodEnd: "2026-01-20T15:00:00.000Z" });
    now = new Date("2026-03-01T00:00:00Z");
    stripe.requests.length = 0;
    await service.runOnce();
    expect(stripe.requests).toHaveLength(0);
  });

  it("keeps recognizing subscriptions on the old Plus price as Pro once a new Pro price is set", async () => {
    const env = demoEnvironment({
      STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_abcdefghijklmnopqrstuvwxyz",
      STRIPE_PRICE_ID: "price_standard_old", STRIPE_PRICE_ID_SOLO: "price_solo_new", STRIPE_PRICE_ID_PLUS: "price_plus_old", STRIPE_PRICE_ID_PRO: "price_pro_new",
    });
    const plans = knownPlans(env);
    expect(planForPriceIds(plans, ["price_plus_old"])?.id).toBe("pro");
    expect(planForPriceIds(plans, ["price_standard_old"])?.id).toBe("solo");
    expect(plans.find((plan) => plan.id === "pro")!.priceId).toBe("price_pro_new"); // new sales use the new price
    const stripe = fakeStripe((request) => {
      if (request.method === "GET" && request.url.endsWith("/v1/subscriptions/sub_old")) return { json: { id: "sub_old", items: { data: [{ id: "si_old", price: { id: "price_plus_old" } }] } } };
      if (request.method === "POST" && request.url.endsWith("/v1/subscriptions/sub_old")) return { json: { id: "sub_old" } };
      return null;
    });
    const client = createStripeClient(env, stripe.fetcher)!;
    expect(client.hasPlanPrice(["price_plus_old"])).toBe(true);
    expect(client.hasPlanPrice(["price_standard_old"])).toBe(true);
    await client.changePlan("sub_old", "team").catch(() => undefined);
    await client.changePlan("sub_old", "pro");
    expect(stripe.requests.at(-1)!.body.get("items[0][id]")).toBe("si_old");
    expect(stripe.requests.at(-1)!.body.get("items[0][price]")).toBe("price_pro_new");
  });
});
