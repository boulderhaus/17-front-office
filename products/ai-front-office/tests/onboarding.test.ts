import { createHmac, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { demoEnvironment, loadEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { chargeSentence } from "../src/domain/billing.js";
import { describeHours, hoursFromChoice } from "../src/domain/hours.js";
import { firstMonthCents, money, planCatalog } from "../src/domain/plans.js";
import { createRequestHandler } from "../src/http/app.js";
import { graceStartedAt } from "../src/application/grace-line.js";

type Call = { url: string; method: string; body: string | null };

/** Stripe and Telnyx, faked: checkout, its read-back, a trialing subscription, numbers and assistants. */
function fakeProviders(options: { subscriptionStatus?: string; subscriptionPrice?: string } = {}) {
  const calls: Call[] = [];
  const owned = new Map<string, { id: string; connection_id: string | null }>();
  let sessions = 0;
  const sessionTenants = new Map<string, string>();
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const raw = init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body: raw });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url === "https://api.stripe.com/v1/checkout/sessions" && method === "POST") {
      sessions += 1;
      const id = `cs_test_synthetic${sessions}`;
      sessionTenants.set(id, new URLSearchParams(raw ?? "").get("client_reference_id") ?? "");
      return json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    const session = /\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(url);
    if (session && method === "GET") return json({ id: session[1], status: "complete", client_reference_id: sessionTenants.get(session[1]!) ?? "someone-else", subscription: "sub_synthetic" });
    if (url.endsWith("/v1/subscriptions/sub_synthetic")) {
      const tenant = [...sessionTenants.values()][0] ?? null;
      return json({ id: "sub_synthetic", status: options.subscriptionStatus ?? "trialing", customer: "cus_synthetic", metadata: { tenant_id: tenant }, items: { data: [{ price: { id: options.subscriptionPrice ?? "price_synthetic" }, current_period_end: Date.parse("2026-11-30T15:00:00Z") / 1_000 }] } });
    }
    if (url.endsWith("/ai/assistants/template-assistant") && method === "GET") return json({ data: { id: "template-assistant", model: "synthetic/model", voice_settings: { voice: "synthetic-voice" } } });
    if (url.endsWith("/ai/assistants") && method === "POST") return json({ data: { id: "assistant-1" } });
    if (/\/ai\/assistants\/assistant-1$/.test(url)) return method === "GET" ? json({ data: { id: "assistant-1", telephony_settings: { default_texml_app_id: "texml-assistant-1" } } }) : json({ data: { id: "assistant-1" } });
    if (url.includes("/available_phone_numbers?")) return json({ data: [{ phone_number: "+19415550123" }] });
    if (url.endsWith("/number_orders") && method === "POST") {
      const number = (JSON.parse(raw ?? "{}") as { phone_numbers: Array<{ phone_number: string }> }).phone_numbers[0]!.phone_number;
      owned.set(number, { id: `num-${owned.size + 1}`, connection_id: null });
      return json({ data: { id: "order-1", status: "success" } });
    }
    if (url.includes("/number_orders/")) return json({ data: { status: "success" } });
    if (url.includes("/phone_numbers?")) {
      const number = new URL(url).searchParams.get("filter[phone_number]")!;
      const record = owned.get(number);
      return json({ data: record ? [{ id: record.id, phone_number: number, connection_id: record.connection_id }] : [] });
    }
    const patch = /\/phone_numbers\/(num-\d+)$/.exec(url);
    if (patch && method === "PATCH") {
      const entry = [...owned.values()].find((value) => value.id === patch[1])!;
      entry.connection_id = (JSON.parse(raw ?? "{}") as { connection_id: string | null }).connection_id ?? null;
      return json({ data: { connection_id: entry.connection_id } });
    }
    if (url.includes("/number_lookup/")) return json({ data: { carrier: { name: "Verizon Wireless", type: "mobile" }, portability: { line_type: "mobile" } } });
    if (url.endsWith("/10dlc/phone_number_campaigns")) return json({});
    throw new Error(`Unexpected outbound request in test: ${method} ${url}`);
  }) as typeof fetch;
  return { calls, fetcher, owned };
}

describe("three taps to a live line", () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = null; });

  async function start(options: { env?: Record<string, string>; subscriptionStatus?: string; subscriptionPrice?: string } = {}) {
    const providers = fakeProviders(options);
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const clock = { at: new Date("2026-11-23T15:00:00Z"), now() { return this.at; } };
    const keys = generateKeyPairSync("ed25519");
    const env = loadEnvironment({
      NODE_ENV: "production", DEMO_MODE: "false", PROVIDER_TEST_MODE: "false",
      PUBLIC_BASE_URL: "https://front-office.example", ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz",
      SESSION_SIGNING_KEY: "session-signing-key-abcdefghijklmnopqrstuvwxyz",
      DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      TELNYX_API_KEY: "KEY_synthetic", TELNYX_PUBLIC_KEY: (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64"),
      TELNYX_FROM_NUMBER: "+15555550199", TELNYX_MESSAGING_PROFILE_ID: "00000000-0000-4000-8000-000000000001", TELNYX_ASSISTANT_ID: "template-assistant",
      TELNYX_MESSAGING_APPROVED: "true", LIVE_PROVIDER_PROOF_AT: "2026-11-01T00:00:00Z",
      STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_PRICE_ID: "price_synthetic", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_abcdefghijklmnopqrstuvwxyz",
      GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic", OWNER_DESTINATIONS_JSON: "{\"owner-primary\":\"+15555550100\"}",
      SUPPORT_EMAIL: "help@example.test",
      ...options.env,
    });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined, fetcher: providers.fetcher }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return { baseUrl, store, providers, clock };
  }

  async function signUp(baseUrl: string, extra: Record<string, string> = {}) {
    // Exactly what the form sends: four answers, the browser's timezone, and (maybe) the text box.
    const response = await fetch(`${baseUrl}/signup`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ businessName: "Gulf Air", phone: "(941) 555-0199", email: "owner@example.test", password: "synthetic-password-42", timezone: "America/New_York", ...extra }),
    });
    return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }

  async function api(baseUrl: string, cookie: string, path: string, body: unknown = {}) {
    const { csrf } = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { csrf: string };
    return fetch(`${baseUrl}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
  }

  // Legacy Pro on the old STRIPE_PRICE_ID_PLUS name (recognized, never sold), Team and Fleet on their own.
  const PLANS = { STRIPE_PRICE_ID_PLUS: "price_plus_synthetic", STRIPE_PRICE_ID_TEAM: "price_team_synthetic", STRIPE_PRICE_ID_FLEET: "price_fleet_synthetic", STRIPE_FIRST_MONTH_COUPON_ID: "first_month_half_off" };

  it("goes from the signup form straight to Stripe: no trial, Solo, limited-time first month half off", async () => {
    const { baseUrl, store, providers } = await start({ env: PLANS });
    const { response } = await signUp(baseUrl);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/cs_test_synthetic1");
    const checkout = new URLSearchParams(providers.calls.find((call) => call.url.endsWith("/v1/checkout/sessions"))!.body!);
    expect(checkout.get("mode")).toBe("subscription");
    expect(checkout.get("payment_method_collection")).toBe("always");
    // Hard paywall: charged today, no free days.
    expect(checkout.has("subscription_data[trial_period_days]")).toBe(false);
    expect(checkout.get("line_items[0][price]")).toBe("price_synthetic");
    expect(checkout.get("discounts[0][coupon]")).toBe("first_month_half_off");
    expect(checkout.get("success_url")).toBe("https://front-office.example/app/start?checkout=success&session_id={CHECKOUT_SESSION_ID}");
    expect(checkout.get("cancel_url")).toBe("https://front-office.example/app/start?checkout=cancelled");
    expect(checkout.get("custom_text[submit][message]")).toBe("Today: $24.99 (limited-time half off). Then $49.99/month. Cancel anytime.");

    // Defaults come from the mobile number: Florida, Eastern time, the automatic greeting, owner confirms jobs.
    const account = (await store.getOwnerAccountByEmail("owner@example.test"))!;
    const config = await store.getConfig(account.tenantId);
    expect(config).toMatchObject({ serviceAreaTerms: ["FL"], timezone: "America/New_York", greeting: "Thanks for calling Gulf Air. How can I help?", bookingMode: "confirm", paused: true });
    // No consent box checked: no text notifications, but the number is still saved for setup.
    expect(config.ownerNotificationRefs).toEqual([]);
    expect(await store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary")).toBe("+19415550199");
    expect(await store.getIntegrationSecret(account.tenantId, "notifications", "owner_sms_consent")).toBeNull();
    expect(config).toMatchObject({ planId: "solo", flatMonthlyPriceCents: 4_999, includedCalls: 60, overageCentsPerCall: 75 });
    // No hours step: every new shop starts Mon–Fri 9 AM–5 PM; evenings and weekends are after hours.
    expect(config.bookableHours).toMatchObject({ weekdayStart: "09:00", weekdayEnd: "17:00", weekends: false });
    expect(config.afterHours).toMatchObject({ weekdayStart: "17:00", weekdayEnd: "09:00", weekends: true });
    expect(describeHours(config.bookableHours)).toBe("Mon–Fri 9 AM–5 PM");
  });

  it("shows Solo already picked and the bigger plans behind one compact line, and charges the one picked", async () => {
    const { baseUrl, store, providers } = await start({ env: PLANS });
    const page = await (await fetch(`${baseUrl}/signup`)).text();
    expect(page).toMatch(/<input type="radio" name="plan" id="plan-solo" value="solo" checked>/);
    for (const id of ["team", "fleet"]) expect(page).toMatch(new RegExp(`<input type="radio" name="plan" id="plan-${id}" value="${id}" >`));
    // Pro is no longer sold.
    expect(page).not.toContain('id="plan-pro"');
    // Bigger plans sit in a closed <details>: no extra tap for Solo.
    expect(page).toMatch(/<details class="bigger"><summary>Bigger shop\? Team, Fleet<\/summary>/);
    for (const text of ["Solo", "$49.99", "Limited time: first month half off", "60 answered calls a month, about 2 a day", "Team", "$179.99", "About 5 people", "Fleet", "$349.99", "About 10 people", "Today: $24.99 (limited-time half off). Then $49.99/month. Cancel anytime.", "Today: $89.99 (limited-time half off). Then $179.99/month. Cancel anytime.", "Lead guarantee"]) expect(page).toContain(text);
    expect(page).not.toMatch(/unlimited/i);
    // Terms are one line under the button, never a box to tick.
    expect(page).toContain("By continuing you agree to the");
    expect(page).not.toMatch(/name="(consent|terms)"/);
    expect(page.match(/By continuing you agree/g)).toHaveLength(1);

    await signUp(baseUrl, { plan: "team" });
    const checkout = new URLSearchParams(providers.calls.find((call) => call.url.endsWith("/v1/checkout/sessions"))!.body!);
    expect(checkout.get("line_items[0][price]")).toBe("price_team_synthetic");
    expect(checkout.get("discounts[0][coupon]")).toBe("first_month_half_off");
    expect(checkout.get("custom_text[submit][message]")).toBe("Today: $89.99 (limited-time half off). Then $179.99/month. Cancel anytime.");
    const account = (await store.getOwnerAccountByEmail("owner@example.test"))!;
    expect(await store.getConfig(account.tenantId)).toMatchObject({ planId: "team", flatMonthlyPriceCents: 17_999, includedCalls: 250 });
  });

  it("never sells Pro: a form still sending pro (or the old plus) buys Solo", async () => {
    for (const plan of ["plus", "pro"]) {
      const { baseUrl, providers } = await start({ env: PLANS });
      await signUp(baseUrl, { plan });
      const checkout = new URLSearchParams(providers.calls.find((call) => call.url.endsWith("/v1/checkout/sessions"))!.body!);
      expect(checkout.get("line_items[0][price]")).toBe("price_synthetic");
    }
  });

  it("turns the line on for a bigger plan too, and offers Solo, Team and Fleet again on the card screen", async () => {
    const { baseUrl } = await start({ env: PLANS, subscriptionPrice: "price_team_synthetic" });
    const { cookie } = await signUp(baseUrl, { plan: "team" });
    const before = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { billing: { planId: string; chargeNote: string; plans: Array<{ id: string; label: string; priceCents: number; firstMonthCents: number; includedCalls: number }> } };
    expect(before.billing.planId).toBe("team");
    expect(before.billing.chargeNote).toBe("Today: $89.99 (limited-time half off). Then $179.99/month. Cancel anytime.");
    expect(before.billing.plans.map((plan) => [plan.id, plan.priceCents, plan.firstMonthCents, plan.includedCalls])).toEqual([["solo", 4_999, 2_499, 60], ["team", 17_999, 8_999, 250], ["fleet", 34_999, 17_499, 500]]);
    const model = await (await api(baseUrl, cookie, "/api/app/onboarding/activate", { sessionId: "cs_test_synthetic1" })).json() as { activation: { status: string }; paid: boolean };
    expect(model.paid).toBe(true);
    expect(model.activation.status).toBe("live");
  });

  it("keeps a subscription already paying on the old Pro price working, on Pro", async () => {
    const { baseUrl } = await start({ env: PLANS, subscriptionPrice: "price_plus_synthetic" });
    const { cookie } = await signUp(baseUrl);
    const model = await (await api(baseUrl, cookie, "/api/app/onboarding/activate", { sessionId: "cs_test_synthetic1" })).json() as { activation: { status: string }; paid: boolean; billing: { planId: string; plans: Array<{ id: string }> }; usage: { includedCalls: number } };
    expect(model.paid).toBe(true);
    expect(model.activation.status).toBe("live");
    expect(model.billing.planId).toBe("pro");
    expect(model.usage.includedCalls).toBe(125);
    expect(model.billing.plans.map((plan) => plan.id)).toEqual(["solo", "team", "fleet"]);
  });

  it("switches the limited-time offer off everywhere with FIRST_MONTH_OFFER_ENABLED=false", async () => {
    const { baseUrl, providers } = await start({ env: { ...PLANS, FIRST_MONTH_OFFER_ENABLED: "false" } });
    const [signup, home] = await Promise.all([fetch(`${baseUrl}/signup`).then((r) => r.text()), fetch(`${baseUrl}/`).then((r) => r.text())]);
    for (const page of [signup, home]) expect(page).not.toMatch(/half off|limited time|First month \$/i);
    expect(signup).toContain("Today: $49.99. Then $49.99/month. Cancel anytime.");
    await signUp(baseUrl);
    const checkout = new URLSearchParams(providers.calls.find((call) => call.url.endsWith("/v1/checkout/sessions"))!.body!);
    expect(checkout.has("discounts[0][coupon]")).toBe(false);
    expect(checkout.get("custom_text[submit][message]")).toBe("Today: $49.99. Then $49.99/month. Cancel anytime.");
  });

  it("only sells plans that have a Stripe price, and never Pro", async () => {
    const { baseUrl } = await start({ env: { STRIPE_PRICE_ID_PRO: "price_pro_synthetic", STRIPE_PRICE_ID_TEAM: "price_team_synthetic" } });
    const page = await (await fetch(`${baseUrl}/signup`)).text();
    expect(page).toContain('id="plan-team"');
    expect(page).not.toContain('id="plan-pro"');
    expect(page).not.toContain('id="plan-fleet"');
    expect(page).toContain("Bigger shop? Team</summary>");
  });

  it("keeps a free trial only when STRIPE_TRIAL_DAYS asks for one, and never spends the coupon on it", async () => {
    const { baseUrl, providers } = await start({ env: { ...PLANS, STRIPE_TRIAL_DAYS: "7" } });
    await signUp(baseUrl);
    const checkout = new URLSearchParams(providers.calls.find((call) => call.url.endsWith("/v1/checkout/sessions"))!.body!);
    expect(checkout.get("subscription_data[trial_period_days]")).toBe("7");
    expect(checkout.has("discounts[0][coupon]")).toBe(false);
    expect(checkout.get("custom_text[submit][message]")).toBe("Free for 7 days. Your card is first charged $49.99 on Nov 30, then every month. Cancel before then and you pay nothing.");
  });

  it("records text consent only when the owner checks the separate box", async () => {
    const { baseUrl, store } = await start();
    await signUp(baseUrl, { ownerSmsConsent: "yes" });
    const account = (await store.getOwnerAccountByEmail("owner@example.test"))!;
    expect((await store.getConfig(account.tenantId)).ownerNotificationRefs).toEqual(["owner-primary"]);
    const proof = JSON.parse((await store.getIntegrationSecret(account.tenantId, "notifications", "owner_sms_consent"))!) as { at: string; source: string; wording: string };
    expect(proof).toMatchObject({ at: "2026-11-23T15:00:00.000Z", source: "signup" });
    expect(proof.wording).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
    expect([...store.notifications.values()].filter((item) => item.idempotencyKey === `owner-optin:${account.tenantId}:signup`)).toHaveLength(1);
  });

  it("charges the full price today, one plan, when no coupon or second price is configured", async () => {
    const { baseUrl, providers } = await start();
    await signUp(baseUrl);
    const checkout = new URLSearchParams(providers.calls.find((call) => call.url.endsWith("/v1/checkout/sessions"))!.body!);
    expect(checkout.has("subscription_data[trial_period_days]")).toBe(false);
    expect(checkout.has("discounts[0][coupon]")).toBe(false);
    expect(checkout.get("payment_method_collection")).toBe("always");
    expect(checkout.get("custom_text[submit][message]")).toBe("Today: $49.99. Then $49.99/month. Cancel anytime.");
    const page = await (await fetch(`${baseUrl}/signup`)).text();
    expect(page).toContain("Today: $49.99. Then $49.99/month. Cancel anytime.");
    expect(page).not.toContain('id="plan-plus"');
  });

  it("turns the line on as soon as the owner is back from Stripe, without Google or a button", async () => {
    const { baseUrl, store } = await start();
    const { cookie } = await signUp(baseUrl);
    const response = await api(baseUrl, cookie, "/api/app/onboarding/activate", { sessionId: "cs_test_synthetic1" });
    expect(response.status).toBe(200);
    const model = await response.json() as { activation: { status: string }; paid: boolean; billing: { status: string; trialEndsAt: string }; viewer: { status: string }; line: { number: string; business: { suggested: string | null } } };
    expect(model.activation.status).toBe("live");
    expect(model.paid).toBe(true);
    expect(model.billing).toMatchObject({ status: "trialing", trialEndsAt: "2026-11-30T15:00:00.000Z" });
    expect(model.viewer.status).toBe("active");
    expect(model.line.number).toBe("+19415550123");
    // Forwarding starts from the mobile they gave at signup.
    expect(model.line.business.suggested).toBe("+19415550199");
    const account = (await store.getOwnerAccountByEmail("owner@example.test"))!;
    expect((await store.getConfig(account.tenantId)).paused).toBe(false);
    // Opening the page again does not buy anything twice.
    const again = await (await api(baseUrl, cookie, "/api/app/onboarding/activate", { sessionId: "cs_test_synthetic1" })).json() as { activation: { status: string } };
    expect(again.activation.status).toBe("live");
  });

  it("refuses a checkout session that belongs to another shop", async () => {
    const { baseUrl } = await start();
    const { cookie } = await signUp(baseUrl);
    const response = await api(baseUrl, cookie, "/api/app/onboarding/activate", { sessionId: "cs_test_unknown99" });
    expect(response.status).toBe(400);
  });

  it("says calmly that carriers are approving the line in provider test mode, and keeps the rest of setup working", async () => {
    const { baseUrl, store } = await start({ env: { PROVIDER_TEST_MODE: "true" } });
    const { cookie } = await signUp(baseUrl);
    const model = await (await api(baseUrl, cookie, "/api/app/onboarding/activate", { sessionId: "cs_test_synthetic1" })).json() as { activation: { status: string; message: string }; paid: boolean; line: { number: string | null } };
    expect(model.activation.status).toBe("waiting");
    expect(model.activation.message).toContain("1 to 3 business days");
    expect(model.paid).toBe(true);
    expect(model.line.number).toBeNull();
    expect((await api(baseUrl, cookie, "/api/app/line/business-number", { number: "(941) 555-0199" })).status).toBe(200);
    expect((await api(baseUrl, cookie, "/api/app/onboarding/hours", { preset: "mon_sat" })).status).toBe(200);
    const done = await (await api(baseUrl, cookie, "/api/app/onboarding/done")).json() as { onboarding: { completed: boolean; hoursSet: boolean } };
    expect(done.onboarding).toEqual({ completed: true, hoursSet: true });
    const account = (await store.getOwnerAccountByEmail("owner@example.test"))!;
    expect((await store.getConfig(account.tenantId)).bookableHours).toEqual({ weekdayStart: "08:00", weekdayEnd: "18:00", weekends: false, saturday: true });
  });

  it("saves the hours preset and its after-hours window to the live assistant", async () => {
    const { baseUrl, store, providers } = await start();
    const { cookie } = await signUp(baseUrl);
    await api(baseUrl, cookie, "/api/app/onboarding/activate", { sessionId: "cs_test_synthetic1" });
    const bad = await api(baseUrl, cookie, "/api/app/onboarding/hours", { preset: "custom", start: "17:00", end: "08:00", days: "weekdays" });
    expect(bad.status).toBe(400);
    const saved = await (await api(baseUrl, cookie, "/api/app/onboarding/hours", { preset: "custom", start: "07:30", end: "16:00", days: "every_day" })).json() as { shop: { hours: string }; onboarding: { hoursSet: boolean } };
    expect(saved.shop.hours).toBe("Every day 7:30 AM–4 PM");
    expect(saved.onboarding.hoursSet).toBe(true);
    const account = (await store.getOwnerAccountByEmail("owner@example.test"))!;
    const config = await store.getConfig(account.tenantId);
    expect(config.afterHours).toMatchObject({ weekdayStart: "16:00", weekdayEnd: "07:30", weekends: false });
    expect(providers.calls.some((call) => call.method === "POST" && call.url.endsWith("/ai/assistants/assistant-1"))).toBe(true);
  });

  it("treats a trial as paid when Stripe's webhook arrives, so the line is never paused for it", async () => {
    const { baseUrl, store } = await start();
    const { cookie } = await signUp(baseUrl);
    await api(baseUrl, cookie, "/api/app/onboarding/activate", { sessionId: "cs_test_synthetic1" });
    const account = (await store.getOwnerAccountByEmail("owner@example.test"))!;
    const payload = JSON.stringify({ id: "evt_trial", type: "customer.subscription.updated", created: Math.floor(Date.parse("2026-11-23T15:00:01Z") / 1_000), data: { object: { id: "sub_synthetic", status: "trialing", customer: "cus_synthetic", metadata: { tenant_id: account.tenantId } } } });
    const timestamp = Math.floor(Date.parse("2026-11-23T15:00:00Z") / 1_000);
    const signature = createHmac("sha256", "whsec_synthetic_abcdefghijklmnopqrstuvwxyz").update(`${timestamp}.${payload}`).digest("hex");
    const webhook = await fetch(`${baseUrl}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body: payload });
    expect(webhook.status).toBe(200);
    expect((await store.getConfig(account.tenantId)).paused).toBe(false);
    expect((await store.getSubscription(account.tenantId))!.status).toBe("trialing");
    // A trial is paid: no voicemail grace period starts.
    expect(await graceStartedAt(store, account.tenantId)).toBeNull();
  });

  it("serves the setup screens from the React app", async () => {
    const { baseUrl } = await start();
    const { cookie } = await signUp(baseUrl);
    // Without a built web app the route still needs a session; it never 404s.
    const page = await fetch(`${baseUrl}/app/start`, { headers: { cookie }, redirect: "manual" });
    expect(page.status).not.toBe(404);
  });
});

describe("hours and charge wording", () => {
  it("maps the presets HVAC offices keep to bookable hours and after-hours coverage", () => {
    expect(hoursFromChoice({ preset: "weekdays" })).toMatchObject({ bookableHours: { weekdayStart: "07:30", weekdayEnd: "17:00", weekends: false, saturday: false }, afterHours: { weekdayStart: "17:00", weekdayEnd: "07:30", weekends: true, workSaturday: false } });
    const saturdayMornings = hoursFromChoice({ preset: "weekdays_sat" });
    expect(saturdayMornings.bookableHours).toMatchObject({ weekdayStart: "08:00", weekdayEnd: "17:00", saturday: true, saturdayEnd: "12:00" });
    expect(saturdayMornings.afterHours).toMatchObject({ weekdayStart: "17:00", weekdayEnd: "08:00", weekends: true, workSaturday: true, saturdayEnd: "12:00" });
    expect(describeHours(saturdayMornings.bookableHours)).toBe("Mon–Fri 8 AM–5 PM, Sat 8 AM–12 PM");
    expect(describeHours(hoursFromChoice({ preset: "weekdays" }).bookableHours)).toBe("Mon–Fri 7:30 AM–5 PM");
    expect(hoursFromChoice({ preset: "mon_sat" }).afterHours).toMatchObject({ weekends: true, workSaturday: true });
    expect(hoursFromChoice({ preset: "every_day" }).bookableHours).toMatchObject({ weekdayStart: "07:00", weekdayEnd: "19:00", weekends: true });
    expect(() => hoursFromChoice({ preset: "whenever" })).toThrow();
    expect(describeHours(hoursFromChoice({ preset: "mon_sat" }).bookableHours)).toBe("Mon–Sat 8 AM–6 PM");
  });

  it("says plainly when the card is charged", () => {
    const now = new Date("2026-11-23T15:00:00Z");
    expect(chargeSentence({ now, trialDays: 7, priceCents: 4_999 })).toContain("first charged $49.99 on Nov 30");
    expect(chargeSentence({ now, trialDays: 0, priceCents: 4_999, firstMonthCents: 2_499 })).toBe("Today: $24.99 (limited-time half off). Then $49.99/month. Cancel anytime.");
    expect(chargeSentence({ now, trialDays: 0, priceCents: 9_999 })).toBe("Today: $99.99. Then $99.99/month. Cancel anytime.");
  });

  it("works out the first month from the coupon percent and lists Solo first", () => {
    expect(firstMonthCents(4_999, 50)).toBe(2_499);
    expect(firstMonthCents(9_999, 50)).toBe(4_999);
    expect(firstMonthCents(4_999, 0)).toBe(4_999);
    const env = demoEnvironment({ PLAN_SOLO_PRICE_CENTS: "5999", PLAN_TEAM_CALLS: "300" });
    // Without Stripe the three plans for sale show for display, Solo first, and no intro price is promised. Prices and calls come from env.
    expect(planCatalog(env).map((plan) => [plan.id, plan.label, plan.priceCents, plan.firstMonthCents, plan.includedCalls, plan.overageCentsPerCall])).toEqual([
      ["solo", "Solo", 5_999, 5_999, 60, 75], ["team", "Team", 17_999, 17_999, 300, 75], ["fleet", "Fleet", 34_999, 34_999, 500, 75],
    ]);
    expect(money(4_999)).toBe("$49.99");
    expect(money(5_000)).toBe("$50");
  });
});
