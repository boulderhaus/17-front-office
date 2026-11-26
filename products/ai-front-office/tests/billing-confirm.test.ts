import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { StripeBillingClient } from "../src/adapters/stripe.js";
import { recordFirstPaid } from "../src/application/billing-jobs.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";

type Recorded = { method: string; url: string; body: URLSearchParams };
const PRICES: Record<string, number> = { price_solo_synthetic: 4_999, price_team_synthetic: 17_999, price_fleet_synthetic: 34_999, price_unl_solo: 5_000, price_unl_team: 7_500, price_unl_fleet: 12_500 };
const PERIOD_START = Math.floor(Date.parse("2026-11-26T14:00:00.000Z") / 1_000);
const PERIOD_END = Math.floor(Date.parse("2026-12-26T14:00:00.000Z") / 1_000);

/**
 * Stripe, faked with one tiny billing engine: the preview and the real update both prorate with it, so a test can
 * compare what the owner was shown with what the card was charged. Nothing leaves the process.
 */
function fakeStripe() {
  const requests: Recorded[] = [];
  const invoiced: number[] = [];
  let items: Array<{ id: string; price: { id: string } }> = [{ id: "si_plan", price: { id: "price_solo_synthetic" } }];
  let previewRefused = false;
  let creditBalance = 0;
  let cancelling = false;
  const prorate = (body: URLSearchParams, prefix: string, at: number): { cents: number; next: typeof items } => {
    let next = items.map((item) => ({ ...item }));
    let delta = 0;
    for (let index = 0; body.has(`${prefix}[${index}][id]`) || body.has(`${prefix}[${index}][price]`); index += 1) {
      const id = body.get(`${prefix}[${index}][id]`);
      const price = body.get(`${prefix}[${index}][price]`);
      const existing = next.find((item) => item.id === id);
      if (body.get(`${prefix}[${index}][deleted]`) === "true" && existing) { delta -= PRICES[existing.price.id]!; next = next.filter((item) => item !== existing); }
      else if (existing && price) { delta += PRICES[price]! - PRICES[existing.price.id]!; existing.price = { id: price }; }
      else if (price) { delta += PRICES[price]!; next.push({ id: `si_${price}`, price: { id: price } }); }
    }
    return { cents: Math.round(delta * (PERIOD_END - at) / (PERIOD_END - PERIOD_START)), next };
  };
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const request: Recorded = { method: init?.method ?? "GET", url: String(input), body: new URLSearchParams(init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === "string" ? init.body : "") };
    requests.push(request);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (request.method === "GET" && request.url.endsWith("/v1/subscriptions/sub_synthetic")) return json({ id: "sub_synthetic", status: "active", customer: "cus_synthetic", cancel_at_period_end: cancelling, current_period_end: PERIOD_END, items: { data: items } });
    if (request.method === "POST" && request.url.endsWith("/v1/invoices/create_preview")) {
      if (previewRefused) return json({ error: { message: "synthetic refusal" } }, 400);
      if (!request.body.has("subscription_details[proration_date]")) return json({ amount_due: 4_999 + creditBalance, next_payment_attempt: PERIOD_END, lines: { data: [] } });
      const { cents } = prorate(request.body, "subscription_details[items]", Number(request.body.get("subscription_details[proration_date]")));
      return json({ amount_due: Math.max(0, cents + creditBalance), starting_balance: creditBalance, lines: { data: [{ amount: cents, parent: { subscription_item_details: { proration: true } } }, { amount: 4_999, parent: { subscription_item_details: { proration: false } } }] } });
    }
    if (request.method === "POST" && request.url.endsWith("/v1/subscriptions/sub_synthetic")) {
      const at = Number(request.body.get("proration_date") ?? Math.floor(Date.now() / 1_000));
      const { cents, next } = prorate(request.body, "items", at);
      items = next;
      // always_invoice: a positive proration is charged now (after any credit); a negative one becomes credit.
      if (cents > 0) { invoiced.push(Math.max(0, cents + creditBalance)); creditBalance = Math.min(0, creditBalance + cents); }
      else { creditBalance += cents; invoiced.push(0); }
      return json({ id: "sub_synthetic", items: { data: items } });
    }
    if (request.method === "GET" && request.url.includes("/v1/invoices?")) return json({ data: [{ id: "in_first", amount_paid: 2_499, created: PERIOD_START, status_transitions: { paid_at: PERIOD_START } }] });
    throw new Error(`Unexpected Stripe request in test: ${request.method} ${request.url}`);
  }) as typeof fetch;
  return {
    requests, invoiced, fetcher,
    writes: () => requests.filter((request) => request.method === "POST" && request.url.endsWith("/v1/subscriptions/sub_synthetic")),
    refusePreview: (value: boolean) => { previewRefused = value; },
    cancelAtPeriodEnd: (value: boolean) => { cancelling = value; },
  };
}

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_abcdefghijklmnopqrstuvwxyz",
  STRIPE_PRICE_ID_SOLO: "price_solo_synthetic", STRIPE_PRICE_ID_TEAM: "price_team_synthetic", STRIPE_PRICE_ID_FLEET: "price_fleet_synthetic",
  STRIPE_PRICE_ID_UNLIMITED_SOLO: "price_unl_solo", STRIPE_PRICE_ID_UNLIMITED_TEAM: "price_unl_team", STRIPE_PRICE_ID_UNLIMITED_FLEET: "price_unl_fleet",
  STRIPE_FIRST_MONTH_COUPON_ID: "front_office_first_month_50",
};

type Quote = { plan: string; unlimited: boolean; monthlyCents: number; todayCents: number; creditCents: number; estimated: boolean; prorationDate: number | null; live: boolean; noChange: boolean; renewsAt: string | null };

describe("plan and Unlimited changes: a tap never charges", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  let now: Date;
  let stripe: ReturnType<typeof fakeStripe>;

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    now = new Date("2026-12-01T14:00:00.000Z"); // 5 days into a 30-day period
    stripe = fakeStripe();
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", ...STRIPE_ENV });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => now }, integrations: {}, logger: () => undefined, fetcher: stripe.fetcher }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  async function paidOwner() {
    const signup = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", email: "owner@example.test", password: "synthetic-password-42" }) });
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const account = (await store.getOwnerAccountByEmail("owner@example.test"))!;
    await store.saveSubscription({ tenantId: account.tenantId, providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic", status: "active", currentPeriodEnd: new Date(PERIOD_END * 1_000).toISOString(), providerEventCreatedAt: "2026-11-26T14:00:00.000Z", createdAt: "2026-11-26T14:00:00.000Z", updatedAt: "2026-11-26T14:00:00.000Z" });
    await recordFirstPaid(store, account.tenantId, "2026-11-26T14:00:00.000Z");
    const { csrf } = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { csrf: string };
    const post = (path: string, body: unknown = {}) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
    const preview = async (plan: string, unlimited: boolean) => await (await post("/api/app/billing/preview", { plan, unlimited })).json() as Quote;
    const confirm = (quote: Quote) => post("/api/app/billing/change", { plan: quote.plan, unlimited: quote.unlimited, confirm: { prorationDate: quote.prorationDate, todayCents: quote.todayCents, creditCents: quote.creditCents, estimated: quote.estimated } });
    return { cookie, tenantId: account.tenantId, post, preview, confirm };
  }

  it("previews Unlimited without writing to Stripe, then charges exactly the previewed amount once, on confirm", async () => {
    const shop = await paidOwner();
    const quote = await shop.preview("solo", true);
    // 25 of 30 days left on a $50.00 add-on.
    expect(quote).toMatchObject({ plan: "solo", unlimited: true, monthlyCents: 9_999, todayCents: 4_167, creditCents: 0, estimated: false, live: true, noChange: false, renewsAt: "2026-12-26T14:00:00.000Z" });
    const preview = stripe.requests.find((request) => request.url.endsWith("/v1/invoices/create_preview"))!;
    expect(Object.fromEntries(preview.body)).toMatchObject({ subscription: "sub_synthetic", "subscription_details[items][0][price]": "price_unl_solo", "subscription_details[proration_behavior]": "always_invoice", "subscription_details[proration_date]": String(quote.prorationDate) });
    expect(stripe.writes()).toHaveLength(0);
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ unlimitedCalls: false });
    // Time passes while the owner reads the dialog: the same proration date keeps the price the same.
    now = new Date(now.getTime() + 90_000);
    expect((await shop.confirm(quote)).status).toBe(200);
    expect(stripe.writes()).toHaveLength(1);
    expect(Object.fromEntries(stripe.writes()[0]!.body)).toMatchObject({ "items[0][price]": "price_unl_solo", proration_behavior: "always_invoice", proration_date: String(quote.prorationDate) });
    expect(stripe.invoiced).toEqual([quote.todayCents]);
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ unlimitedCalls: true });
  });

  it("never writes to Stripe from a bare tap: the older one-field routes need the confirmed price too", async () => {
    const shop = await paidOwner();
    const on = await shop.post("/api/app/billing/unlimited", { on: true });
    expect(on.status).toBe(409);
    expect(((await on.json()) as { error: string }).error).toBe("Check the price first. Nothing was charged.");
    expect((await shop.post("/api/app/billing/plan", { plan: "team" })).status).toBe(409);
    expect((await shop.post("/api/app/billing/change", { plan: "solo", unlimited: true })).status).toBe(409);
    expect(stripe.writes()).toHaveLength(0);
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ planId: "solo", unlimitedCalls: false });
  });

  it("refuses a confirm whose amount no longer matches Stripe, and never charges it", async () => {
    const shop = await paidOwner();
    const quote = await shop.preview("solo", true);
    const tampered = { ...quote, todayCents: quote.todayCents - 100 };
    const response = await shop.confirm(tampered);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("The price changed. Check the new price. Nothing was charged.");
    // An old quote (over 20 minutes) is refused too.
    now = new Date(now.getTime() + 21 * 60_000);
    expect((await shop.confirm(quote)).status).toBe(409);
    expect(stripe.writes()).toHaveLength(0);
  });

  it("turning Unlimited off says the credit, and repeated on and off never charges more than each confirmed amount", async () => {
    const shop = await paidOwner();
    const on = await shop.preview("solo", true);
    expect((await shop.confirm(on)).status).toBe(200);
    const off = await shop.preview("solo", false);
    expect(off).toMatchObject({ unlimited: false, monthlyCents: 4_999, todayCents: 0, creditCents: 4_167 });
    expect((await shop.confirm(off)).status).toBe(200);
    // On again: the credit from turning it off is used before the card.
    const again = await shop.preview("solo", true);
    expect(again).toMatchObject({ todayCents: 0, creditCents: 0 });
    expect((await shop.confirm(again)).status).toBe(200);
    expect(stripe.writes()).toHaveLength(3);
    expect(stripe.invoiced).toEqual([on.todayCents, 0, again.todayCents]);
    // Confirming the same state twice writes nothing.
    expect((await shop.confirm(again)).status).toBe(200);
    expect(stripe.writes()).toHaveLength(3);
  });

  it("changes plan only on confirm, keeping Unlimited at the new plan's add-on price", async () => {
    const shop = await paidOwner();
    expect((await shop.confirm(await shop.preview("solo", true))).status).toBe(200);
    const quote = await shop.preview("team", true);
    expect(quote).toMatchObject({ plan: "team", unlimited: true, monthlyCents: 25_499, estimated: false });
    expect(quote.todayCents).toBe(Math.round((17_999 - 4_999 + 7_500 - 5_000) * 25 / 30));
    expect(stripe.writes()).toHaveLength(1);
    expect((await shop.confirm(quote)).status).toBe(200);
    expect(stripe.writes()).toHaveLength(2);
    expect(stripe.invoiced.at(-1)).toBe(quote.todayCents);
    expect(await store.getConfig(shop.tenantId)).toMatchObject({ planId: "team", includedCalls: 250, unlimitedCalls: true });
  });

  it("falls back to a labelled estimate when Stripe refuses the preview", async () => {
    const shop = await paidOwner();
    stripe.refusePreview(true);
    const quote = await shop.preview("solo", true);
    expect(quote).toMatchObject({ estimated: true, todayCents: 4_167, creditCents: 0 });
    expect(stripe.writes()).toHaveLength(0);
    // The owner agreed to "about $41.67": that confirm goes through, once.
    expect((await shop.confirm(quote)).status).toBe(200);
    expect(stripe.writes()).toHaveLength(1);
  });

  it("says what was paid and what comes next, from Stripe", async () => {
    const shop = await paidOwner();
    const summary = await (await fetch(`${baseUrl}/api/app/billing/summary`, { headers: { cookie: shop.cookie } })).json();
    expect(summary).toEqual({ lastPaid: { amountCents: 2_499, paidAt: "2026-11-26T14:00:00.000Z" }, next: { amountCents: 4_999, at: "2026-12-26T14:00:00.000Z" }, endsAt: null, monthlyCents: 4_999 });
    expect(stripe.writes()).toHaveLength(0);
  });

  it("never invents a next bill: a cancelling plan shows when it ends, and a refused preview shows none", async () => {
    const shop = await paidOwner();
    stripe.cancelAtPeriodEnd(true);
    const ending = await (await fetch(`${baseUrl}/api/app/billing/summary`, { headers: { cookie: shop.cookie } })).json();
    expect(ending).toMatchObject({ next: null, endsAt: "2026-12-26T14:00:00.000Z" });
    stripe.cancelAtPeriodEnd(false);
    stripe.refusePreview(true);
    const refused = await (await fetch(`${baseUrl}/api/app/billing/summary`, { headers: { cookie: shop.cookie } })).json();
    expect(refused).toMatchObject({ next: null, endsAt: null });
    expect(stripe.writes()).toHaveLength(0);
  });

  it("gives every plan on the card step one quote: today's price, the struck-through full price and the renewal", async () => {
    const shop = await paidOwner();
    const dashboard = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie: shop.cookie } })).json() as { billing: { plans: Array<{ id: string; quote: unknown; unlimited: { quote: unknown } | null }> } };
    expect(dashboard.billing.plans[0]).toMatchObject({ id: "solo", quote: { todayCents: 2_499, monthlyCents: 4_999, strikeCents: 4_999, renewsAt: "2027-01-01T14:00:00.000Z" }, unlimited: { quote: { todayCents: 4_999, monthlyCents: 9_999, strikeCents: 9_999 } } });
  });
});

describe("StripeBillingClient.previewChange", () => {
  it("sums only the proration lines and uses account credit before the card", async () => {
    const fetcher = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/subscriptions/sub_x")) return new Response(JSON.stringify({ id: "sub_x", items: { data: [{ id: "si_plan", price: { id: "price_solo" } }] } }));
      return new Response(JSON.stringify({ starting_balance: -1_000, lines: { data: [{ amount: 4_000, proration: true }, { amount: 4_999, parent: { subscription_item_details: { proration: false } } }] } }));
    }) as typeof fetch;
    const client = new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo", unlimited: { solo: "price_unl_solo" } }, fetcher);
    expect(await client.previewChange("sub_x", "solo", { unlimited: true, prorationDate: 1_800_000_000 })).toEqual({ changeCents: 4_000, chargeCents: 3_000, creditCents: 0, noChange: false });
    expect(await client.previewChange("sub_x", "solo", { unlimited: false, prorationDate: 1_800_000_000 })).toEqual({ changeCents: 0, chargeCents: 0, creditCents: 0, noChange: true });
  });

  it("adds a debit on the account and pending invoice items, which always_invoice charges on the same invoice", async () => {
    const fetcher = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/subscriptions/sub_x")) return new Response(JSON.stringify({ id: "sub_x", items: { data: [{ id: "si_plan", price: { id: "price_solo" } }] } }));
      return new Response(JSON.stringify({ starting_balance: 100, lines: { data: [
        { amount: 1_000, proration: true },
        { amount: 250, parent: { type: "invoice_item_details", invoice_item_details: { invoice_item: "ii_synthetic" } } },
        { amount: 4_999, parent: { subscription_item_details: { proration: false } } },
      ] } }));
    }) as typeof fetch;
    const client = new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo", unlimited: { solo: "price_unl_solo" } }, fetcher);
    expect(await client.previewChange("sub_x", "solo", { unlimited: true, prorationDate: 1_800_000_000 })).toEqual({ changeCents: 1_000, chargeCents: 1_350, creditCents: 0, noChange: false });
  });
});
