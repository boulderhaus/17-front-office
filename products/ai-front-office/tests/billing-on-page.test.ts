import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { StripeBillingClient } from "../src/adapters/stripe.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";

type Recorded = { method: string; url: string; body: URLSearchParams };
const PERIOD_END = Math.floor(Date.parse("2026-12-26T14:00:00.000Z") / 1_000);
const WEBHOOK_SECRET = "whsec_synthetic_abcdefghijklmnopqrstuvwxyz";
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PRICE_ID_SOLO: "price_solo_synthetic" };
const PUBLISHABLE = "pk_test_synthetic1234567890";

/** Stripe, faked: Plan and billing's card, bills, card change and cancel. Nothing leaves the process. */
function fakeStripe() {
  const requests: Recorded[] = [];
  const state = {
    cancelling: false,
    subscriptionCard: null as null | Record<string, unknown>,
    customerCard: { id: "pm_old", card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2028 } } as null | Record<string, unknown>,
    sessionTenant: "",
    sessionComplete: true,
    refuse: new Set<string>(),
    uiModeRefused: false,
    newCardCreated: 2_000,
  };
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const request: Recorded = { method: init?.method ?? "GET", url: String(input), body: new URLSearchParams(init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === "string" ? init.body : "") };
    requests.push(request);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    const path = request.url.replace("https://api.stripe.com/v1/", "");
    const refused = [...state.refuse].find((prefix) => `${request.method} ${path}`.startsWith(prefix));
    if (refused) return json({ error: { message: "synthetic refusal" } }, 400);
    if (request.method === "GET" && path === "subscriptions/sub_synthetic?expand[]=default_payment_method") return json({ id: "sub_synthetic", default_payment_method: state.subscriptionCard });
    if (request.method === "GET" && path === "subscriptions/sub_synthetic") return json({ id: "sub_synthetic", status: "active", customer: "cus_synthetic", metadata: {}, cancel_at_period_end: state.cancelling, current_period_end: PERIOD_END, items: { data: [{ id: "si_plan", price: { id: "price_solo_synthetic" }, current_period_end: PERIOD_END }] } });
    if (request.method === "GET" && path.startsWith("customers/cus_synthetic?")) return json({ id: "cus_synthetic", invoice_settings: { default_payment_method: state.customerCard } });
    if (request.method === "GET" && path.startsWith("invoices?customer=cus_synthetic")) return json({ data: [
      { id: "in_paid", status: "paid", amount_paid: 4_999, amount_due: 4_999, created: PERIOD_END - 30 * 86_400, invoice_pdf: "https://pay.stripe.com/invoice/synthetic/pdf" },
      { id: "in_failed", status: "open", amount_paid: 0, amount_due: 4_999, attempt_count: 2, created: PERIOD_END - 2 * 86_400, invoice_pdf: "https://pay.stripe.com/invoice/synthetic2/pdf" },
      { id: "in_draft", status: "draft", amount_due: 900, created: PERIOD_END - 86_400 },
      { id: "in_zero", status: "paid", amount_paid: 0, amount_due: 0, created: PERIOD_END - 60 * 86_400 },
    ] });
    if (request.method === "GET" && path.startsWith("invoices?subscription=")) return json({ data: [] });
    if (request.method === "POST" && path === "invoices/create_preview") return json({ amount_due: 4_999, next_payment_attempt: PERIOD_END });
    if (request.method === "POST" && path === "checkout/sessions") {
      if (state.uiModeRefused && request.body.get("ui_mode") === "embedded") return json({ error: { message: "Invalid ui_mode: must be one of hosted_page, embedded_page", param: "ui_mode" } }, 400);
      return json({ id: "cs_setup_synthetic", client_secret: "cs_setup_synthetic_secret_abc" });
    }
    if (request.method === "GET" && path === "checkout/sessions/cs_setup_synthetic?expand[]=setup_intent.payment_method") return json({
      id: "cs_setup_synthetic", mode: "setup", status: state.sessionComplete ? "complete" : "open", customer: "cus_synthetic",
      metadata: { tenant_id: state.sessionTenant, front_office: "card_update" },
      setup_intent: { id: "seti_synthetic", status: state.sessionComplete ? "succeeded" : "requires_payment_method", payment_method: state.sessionComplete ? { id: "pm_new", created: state.newCardCreated } : null },
    });
    if (request.method === "POST" && path === "subscriptions/sub_synthetic") {
      if (request.body.has("cancel_at_period_end")) state.cancelling = request.body.get("cancel_at_period_end") === "true";
      if (request.body.has("default_payment_method")) state.subscriptionCard = { id: request.body.get("default_payment_method"), created: request.body.get("default_payment_method") === "pm_new" ? state.newCardCreated : 3_000, card: { brand: "mastercard", last4: "5555", exp_month: 1, exp_year: 2031 } };
      return json({ id: "sub_synthetic" });
    }
    if (request.method === "POST" && path === "customers/cus_synthetic") return json({ id: "cus_synthetic" });
    if (request.method === "GET" && path.startsWith("billing_portal/configurations")) return json({ data: [{ id: "bpc_synthetic", metadata: { front_office: "v1" } }] });
    if (request.method === "POST" && path === "billing_portal/sessions") return json({ url: "https://billing.stripe.com/p/session/synthetic" });
    throw new Error(`Unexpected Stripe request in test: ${request.method} ${request.url}`);
  }) as typeof fetch;
  const writes = (prefix: string) => requests.filter((request) => request.method === "POST" && request.url.endsWith(prefix));
  return { requests, state, fetcher, writes };
}

describe("Plan and billing on our own page: card, bills, card change, cancel", () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = null; });

  async function start(extra: Record<string, string> = {}) {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const stripe = fakeStripe();
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", PUBLIC_BASE_URL: "https://callotto.example", ...STRIPE_ENV, ...extra });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => new Date("2026-12-01T14:00:00.000Z") }, integrations: {}, logger: () => undefined, fetcher: stripe.fetcher }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const shop = async (email: string, status: "active" | "comp" = "active") => {
      const signup = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", email, password: "synthetic-password-42" }) });
      const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
      const account = (await store.getOwnerAccountByEmail(email))!;
      await store.saveSubscription(status === "comp"
        ? { tenantId: account.tenantId, providerCustomerId: null, providerSubscriptionId: null, status: "comp", currentPeriodEnd: null, providerEventCreatedAt: "2026-11-26T14:00:00.000Z", createdAt: "2026-11-26T14:00:00.000Z", updatedAt: "2026-11-26T14:00:00.000Z" }
        : { tenantId: account.tenantId, providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic", status: "active", currentPeriodEnd: new Date(PERIOD_END * 1_000).toISOString(), providerEventCreatedAt: "2026-11-26T14:00:00.000Z", createdAt: "2026-11-26T14:00:00.000Z", updatedAt: "2026-11-26T14:00:00.000Z" });
      const { csrf } = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { csrf: string };
      // Signing up opens a plan checkout; only what happens on Plan and billing after this counts.
      stripe.requests.length = 0;
      const post = (path: string, body: unknown = {}, as = cookie, token = csrf) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { cookie: as, "content-type": "application/json", "x-csrf-token": token }, body: JSON.stringify(body) });
      const get = (path: string, as = cookie) => fetch(`${baseUrl}${path}`, { headers: { cookie: as } });
      return { cookie, csrf, account, post, get };
    };
    /** A teammate on the same shop: can't touch billing. */
    const teammate = async (owner: Awaited<ReturnType<typeof shop>>) => {
      await store.markOwnerEmailVerified(owner.account.id, new Date().toISOString(), null);
      const invite = await owner.post("/api/app/team/invite", { email: "teammate@synthetic.example" });
      const url = new URL((await invite.json() as { inviteUrl: string }).inviteUrl);
      const join = await fetch(`${baseUrl}/join`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ shop: url.searchParams.get("shop")!, token: url.searchParams.get("token")!, name: "Synthetic Teammate", password: "long-password-for-tests", consent: "yes" }) });
      const cookie = join.headers.get("set-cookie")!.split(";")[0]!;
      const csrf = (await (await fetch(`${baseUrl}/api/app/team`, { headers: { cookie } })).json() as { csrf: string }).csrf;
      return { cookie, csrf };
    };
    const webhook = (event: unknown) => {
      const body = JSON.stringify(event);
      const timestamp = Math.floor(Date.parse("2026-12-01T14:00:00.000Z") / 1_000);
      const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
      return fetch(`${baseUrl}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body });
    };
    return { baseUrl, store, stripe, shop, teammate, webhook };
  }

  it("shows the card on file and the past bills, paid or failed, with Stripe's PDF; drafts and $0 bills left out", async () => {
    const app = await start();
    const owner = await app.shop("owner@example.test");
    const details = await (await owner.get("/api/app/billing/details")).json();
    expect(details).toEqual({
      card: { brand: "visa", last4: "4242", expMonth: 8, expYear: 2028 },
      invoices: [
        { id: "in_failed", at: new Date((PERIOD_END - 2 * 86_400) * 1_000).toISOString(), amountCents: 4_999, status: "failed", pdfUrl: "https://pay.stripe.com/invoice/synthetic2/pdf" },
        { id: "in_paid", at: new Date((PERIOD_END - 30 * 86_400) * 1_000).toISOString(), amountCents: 4_999, status: "paid", pdfUrl: "https://pay.stripe.com/invoice/synthetic/pdf" },
      ],
      cardChange: "hosted",
    });
    // The subscription's own card wins over the customer's.
    app.stripe.state.subscriptionCard = { id: "pm_sub", card: { brand: "amex", last4: "0005", exp_month: 3, exp_year: 2029 } };
    expect(((await (await owner.get("/api/app/billing/details")).json()) as { card: unknown }).card).toEqual({ brand: "amex", last4: "0005", expMonth: 3, expYear: 2029 });
    // A refused read shows nothing rather than a guess.
    app.stripe.state.refuse.add("GET subscriptions/sub_synthetic?expand").add("GET customers/").add("GET invoices?customer");
    expect(await (await owner.get("/api/app/billing/details")).json()).toEqual({ card: null, invoices: [], cardChange: "hosted" });
    expect(app.stripe.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("keeps every new billing route to the signed-in owner: no session, a teammate and a complimentary shop get nothing", async () => {
    const app = await start({ STRIPE_PUBLISHABLE_KEY: PUBLISHABLE });
    const owner = await app.shop("owner@example.test");
    const member = await app.teammate(owner);
    const routes = ["/api/app/billing/card", "/api/app/billing/card/complete", "/api/app/billing/card/sync", "/api/app/billing/cancel", "/api/app/billing/keep"];
    expect((await fetch(`${app.baseUrl}/api/app/billing/details`)).status).toBe(401);
    for (const route of routes) expect((await fetch(`${app.baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "cs_setup_synthetic" }) })).status, route).toBe(401);
    expect((await owner.get("/api/app/billing/details", member.cookie)).status).toBe(403);
    for (const route of routes) expect((await owner.post(route, { sessionId: "cs_setup_synthetic" }, member.cookie, member.csrf)).status, route).toBe(403);
    // A wrong CSRF token is refused before Stripe is asked.
    expect((await owner.post("/api/app/billing/cancel", {}, owner.cookie, "wrong")).status).toBe(403);
    const comp = await app.shop("comp@example.test", "comp");
    expect(await (await comp.get("/api/app/billing/details")).json()).toEqual({ card: null, invoices: [], cardChange: null });
    for (const route of ["/api/app/billing/card", "/api/app/billing/card/sync", "/api/app/billing/cancel", "/api/app/billing/keep"]) expect((await comp.post(route)).status, route).toBe(409);
    expect(app.stripe.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("opens the card change inside our page when a publishable key is set: a setup-mode embedded session that charges nothing", async () => {
    const app = await start({ STRIPE_PUBLISHABLE_KEY: PUBLISHABLE });
    const owner = await app.shop("owner@example.test");
    const started = await (await owner.post("/api/app/billing/card")).json();
    expect(started).toEqual({ mode: "embedded", clientSecret: "cs_setup_synthetic_secret_abc", publishableKey: PUBLISHABLE, uiMode: "embedded" });
    const session = Object.fromEntries(app.stripe.writes("/v1/checkout/sessions")[0]!.body);
    expect(session).toMatchObject({ mode: "setup", ui_mode: "embedded", customer: "cus_synthetic", "payment_method_types[0]": "card", redirect_on_completion: "if_required", return_url: "https://callotto.example/app/settings/plan?card=done&session_id={CHECKOUT_SESSION_ID}", "metadata[tenant_id]": owner.account.tenantId, "metadata[front_office]": "card_update" });
    expect(session).not.toHaveProperty("line_items[0][price]");
    // An account on Stripe's newest API calls it embedded_page: tried next, same form.
    app.stripe.state.uiModeRefused = true;
    expect(await (await owner.post("/api/app/billing/card")).json()).toMatchObject({ mode: "embedded", uiMode: "embedded_page" });
    expect(app.stripe.writes("/v1/subscriptions/sub_synthetic")).toHaveLength(0);
  });

  it("falls back to Stripe's own card page, which returns the owner by itself: no key, Stripe refusing the form, or the page asking for it", async () => {
    const expectHosted = (app: Awaited<ReturnType<typeof start>>) => {
      const portal = Object.fromEntries(app.stripe.writes("/v1/billing_portal/sessions").at(-1)!.body);
      expect(portal).toMatchObject({ customer: "cus_synthetic", configuration: "bpc_synthetic", "flow_data[type]": "payment_method_update", "flow_data[after_completion][type]": "redirect", "flow_data[after_completion][redirect][return_url]": "https://callotto.example/app/settings/plan?card=back", return_url: "https://callotto.example/app/settings/plan" });
    };
    const none = await start();
    const first = await none.shop("owner@example.test");
    expect(await (await first.post("/api/app/billing/card")).json()).toEqual({ mode: "hosted", url: "https://billing.stripe.com/p/session/synthetic" });
    expect(none.stripe.writes("/v1/checkout/sessions")).toHaveLength(0);
    expectHosted(none);
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const keyed = await start({ STRIPE_PUBLISHABLE_KEY: PUBLISHABLE });
    const second = await keyed.shop("owner@example.test");
    keyed.stripe.state.refuse.add("POST checkout/sessions");
    expect(await (await second.post("/api/app/billing/card")).json()).toMatchObject({ mode: "hosted" });
    expectHosted(keyed);
    keyed.stripe.state.refuse.clear();
    // Stripe's script couldn't load in the browser: the page asks for the hosted page directly.
    const sessionsBefore = keyed.stripe.writes("/v1/checkout/sessions").length;
    expect(await (await second.post("/api/app/billing/card", { hosted: true })).json()).toMatchObject({ mode: "hosted" });
    expect(keyed.stripe.writes("/v1/checkout/sessions")).toHaveLength(sessionsBefore);
    // Stripe refuses both: one plain line, nothing changed.
    keyed.stripe.state.refuse.add("POST billing_portal/sessions");
    const failed = await second.post("/api/app/billing/card", { hosted: true });
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toBe("We couldn’t open the card form. Nothing changed. Try again in a minute.");
  });

  it("makes the new card the default for the subscription and the customer once the form is done, and only for the shop that made it", async () => {
    const app = await start({ STRIPE_PUBLISHABLE_KEY: PUBLISHABLE });
    const owner = await app.shop("owner@example.test");
    const other = await app.shop("other@example.test");
    app.stripe.state.sessionTenant = owner.account.tenantId;
    // Someone else's card form: refused, nothing written.
    const stolen = await other.post("/api/app/billing/card/complete", { sessionId: "cs_setup_synthetic" });
    expect(stolen.status).toBe(403);
    expect(app.stripe.writes("/v1/subscriptions/sub_synthetic")).toHaveLength(0);
    // Not finished yet.
    app.stripe.state.sessionComplete = false;
    expect((await owner.post("/api/app/billing/card/complete", { sessionId: "cs_setup_synthetic" })).status).toBe(409);
    app.stripe.state.sessionComplete = true;
    expect((await owner.post("/api/app/billing/card/complete", { sessionId: "not-a-session" })).status).toBe(400);
    const done = await owner.post("/api/app/billing/card/complete", { sessionId: "cs_setup_synthetic" });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { card: unknown }).card).toEqual({ brand: "mastercard", last4: "5555", expMonth: 1, expYear: 2031 });
    expect(Object.fromEntries(app.stripe.writes("/v1/subscriptions/sub_synthetic")[0]!.body)).toEqual({ default_payment_method: "pm_new" });
    expect(Object.fromEntries(app.stripe.writes("/v1/customers/cus_synthetic")[0]!.body)).toEqual({ "invoice_settings[default_payment_method]": "pm_new" });
    // Never a charge: no invoice, payment or plan write.
    expect(app.stripe.requests.filter((request) => request.method === "POST" && /\/v1\/(invoices|payment_intents|refunds)/.test(request.url))).toHaveLength(0);
    // Stripe refuses the switch: said plainly.
    app.stripe.state.refuse.add("POST subscriptions/sub_synthetic");
    const refused = await owner.post("/api/app/billing/card/complete", { sessionId: "cs_setup_synthetic" });
    expect(refused.status).toBe(502);
    app.stripe.state.refuse.clear();
    app.stripe.state.refuse.add("GET checkout/sessions");
    expect((await owner.post("/api/app/billing/card/complete", { sessionId: "cs_setup_synthetic" })).status).toBe(502);
  });

  it("switches the default card from the webhook too, if the owner closed the page before it finished", async () => {
    const app = await start({ STRIPE_PUBLISHABLE_KEY: PUBLISHABLE });
    const owner = await app.shop("owner@example.test");
    app.stripe.state.sessionTenant = owner.account.tenantId;
    const response = await app.webhook({ id: "evt_setup_done", type: "checkout.session.completed", created: PERIOD_END - 86_400, data: { object: { id: "cs_setup_synthetic", object: "checkout.session", mode: "setup", status: "complete", subscription: null, customer: "cus_synthetic", metadata: { tenant_id: owner.account.tenantId, front_office: "card_update" } } } });
    expect(response.status).toBe(200);
    expect(Object.fromEntries(app.stripe.writes("/v1/subscriptions/sub_synthetic")[0]!.body)).toEqual({ default_payment_method: "pm_new" });
    expect(await app.store.getSubscription(owner.account.tenantId)).toMatchObject({ status: "active" });
  });

  it("never puts back an older card: a late or repeated completion after a newer card is paying writes nothing", async () => {
    const app = await start({ STRIPE_PUBLISHABLE_KEY: PUBLISHABLE });
    const owner = await app.shop("owner@example.test");
    app.stripe.state.sessionTenant = owner.account.tenantId;
    // Card B (saved later) already pays; the webhook for card A arrives late.
    app.stripe.state.subscriptionCard = { id: "pm_newer", created: 5_000, card: { brand: "visa", last4: "1881", exp_month: 2, exp_year: 2032 } };
    const late = await app.webhook({ id: "evt_setup_late", type: "checkout.session.completed", created: PERIOD_END - 86_400, data: { object: { id: "cs_setup_synthetic", object: "checkout.session", mode: "setup", status: "complete", subscription: null, customer: "cus_synthetic", metadata: { tenant_id: owner.account.tenantId, front_office: "card_update" } } } });
    expect(late.status).toBe(200);
    expect(app.stripe.writes("/v1/subscriptions/sub_synthetic")).toHaveLength(0);
    expect(app.stripe.writes("/v1/customers/cus_synthetic")).toHaveLength(0);
    // The same card again (a duplicate) is harmless: it stays the one paying.
    app.stripe.state.subscriptionCard = { id: "pm_new", created: 2_000, card: { brand: "mastercard", last4: "5555", exp_month: 1, exp_year: 2031 } };
    expect((await owner.post("/api/app/billing/card/complete", { sessionId: "cs_setup_synthetic" })).status).toBe(200);
    expect(Object.fromEntries(app.stripe.writes("/v1/subscriptions/sub_synthetic")[0]!.body)).toEqual({ default_payment_method: "pm_new" });
  });

  it("back from Stripe's own card page, switches the plan to the card saved there, and only to a newer one", async () => {
    const app = await start();
    const owner = await app.shop("owner@example.test");
    // The subscription still pays with its own older card; Stripe's page saved a newer one for the customer.
    app.stripe.state.subscriptionCard = { id: "pm_sub_old", created: 1_000, card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2028 } };
    app.stripe.state.customerCard = { id: "pm_portal", created: 4_000, card: { brand: "discover", last4: "1117", exp_month: 12, exp_year: 2030 } };
    const synced = await owner.post("/api/app/billing/card/sync");
    expect(synced.status).toBe(200);
    expect(Object.fromEntries(app.stripe.writes("/v1/subscriptions/sub_synthetic")[0]!.body)).toEqual({ default_payment_method: "pm_portal" });
    // Already the same card: nothing written.
    app.stripe.state.subscriptionCard = { id: "pm_portal", created: 4_000, card: { brand: "discover", last4: "1117", exp_month: 12, exp_year: 2030 } };
    expect((await owner.post("/api/app/billing/card/sync")).status).toBe(200);
    // The subscription's card is newer than the customer's: left alone.
    app.stripe.state.subscriptionCard = { id: "pm_sub_newest", created: 9_000, card: { brand: "visa", last4: "1881", exp_month: 2, exp_year: 2032 } };
    expect((await owner.post("/api/app/billing/card/sync")).status).toBe(200);
    expect(app.stripe.writes("/v1/subscriptions/sub_synthetic")).toHaveLength(1);
    // Never a charge, and Stripe refusing is said plainly.
    expect(app.stripe.requests.filter((request) => request.method === "POST" && /\/v1\/(invoices|payment_intents|refunds|customers)/.test(request.url))).toHaveLength(0);
    app.stripe.state.subscriptionCard = { id: "pm_sub_old", created: 1_000, card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2028 } };
    app.stripe.state.refuse.add("POST subscriptions/sub_synthetic");
    const refused = await owner.post("/api/app/billing/card/sync");
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: string }).error).toBe("Your new card is saved, but we couldn’t switch to it. Try again in a minute.");
  });

  it("cancels at the end of the paid month on our page, shows the end date, and Keep my plan undoes it", async () => {
    const app = await start();
    const owner = await app.shop("owner@example.test");
    const cancelled = await owner.post("/api/app/billing/cancel");
    expect(cancelled.status).toBe(200);
    expect(Object.fromEntries(app.stripe.writes("/v1/subscriptions/sub_synthetic")[0]!.body)).toEqual({ cancel_at_period_end: "true" });
    expect(await cancelled.json()).toMatchObject({ endsAt: new Date(PERIOD_END * 1_000).toISOString(), next: null });
    // Nothing else changes until that date: the shop is still paid and live.
    expect(await app.store.getSubscription(owner.account.tenantId)).toMatchObject({ status: "active" });
    const kept = await owner.post("/api/app/billing/keep");
    expect(kept.status).toBe(200);
    expect(Object.fromEntries(app.stripe.writes("/v1/subscriptions/sub_synthetic")[1]!.body)).toEqual({ cancel_at_period_end: "false" });
    expect(await kept.json()).toMatchObject({ endsAt: null, next: { amountCents: 4_999 } });
    // Stripe refuses: nothing changed, said in one line.
    app.stripe.state.refuse.add("POST subscriptions/sub_synthetic");
    const refused = await owner.post("/api/app/billing/cancel");
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: string }).error).toBe("We couldn’t reach our payment processor. Nothing changed. Try again in a minute.");
    expect(app.stripe.state.cancelling).toBe(false);
  });

  it("allows Stripe's script and frames only on owner-app pages, and only once a publishable key is set", async () => {
    const keyed = await start({ STRIPE_PUBLISHABLE_KEY: PUBLISHABLE });
    const appCsp = (await fetch(`${keyed.baseUrl}/app/settings/plan`, { redirect: "manual" })).headers.get("content-security-policy") ?? "";
    expect(appCsp).toContain("script-src 'self' https://js.stripe.com https://*.js.stripe.com;");
    expect(appCsp).toContain("frame-src https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com https://hooks.stripe.com");
    expect(appCsp).toContain("connect-src 'self' https://api.stripe.com https://checkout.stripe.com");
    expect(appCsp).toContain("frame-ancestors 'none'");
    const signupCsp = (await fetch(`${keyed.baseUrl}/signup`)).headers.get("content-security-policy") ?? "";
    expect(signupCsp).not.toContain("js.stripe.com");
    expect(signupCsp).not.toContain("frame-src");
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const plain = await start();
    const plainCsp = (await fetch(`${plain.baseUrl}/app/settings/plan`, { redirect: "manual" })).headers.get("content-security-policy") ?? "";
    expect(plainCsp).toContain("script-src 'self';");
    expect(plainCsp).not.toContain("stripe.com https://checkout");
    expect(plainCsp).not.toContain("frame-src");
  });
});

describe("StripeBillingClient card details", () => {
  it("reads the customer's card when the subscription has none, and asks for nothing else", async () => {
    const urls: string[] = [];
    const fetcher = (async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/subscriptions/")) return new Response(JSON.stringify({ id: "sub_x", default_payment_method: null }));
      if (url.includes("/customers/")) return new Response(JSON.stringify({ invoice_settings: { default_payment_method: { card: { brand: "discover", last4: "1117", exp_month: 12, exp_year: 2030 } } } }));
      return new Response(JSON.stringify({ data: [{ id: "in_1", status: "uncollectible", amount_due: 1_000, created: 1_800_000_000 }] }));
    }) as typeof fetch;
    const client = new StripeBillingClient("sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", { base: "price_solo" }, fetcher);
    expect(await client.paymentDetails("cus_x", "sub_x")).toEqual({ card: { brand: "discover", last4: "1117", expMonth: 12, expYear: 2030 }, invoices: [{ id: "in_1", at: new Date(1_800_000_000_000).toISOString(), amountCents: 1_000, status: "failed", pdfUrl: null }] });
    expect(urls.every((url) => !url.includes("/charges") && !url.includes("/refunds"))).toBe(true);
  });
});
