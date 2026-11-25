import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { NotificationRouter } from "../src/adapters/notification-router.js";
import { normalizeSubscriptionStatus } from "../src/adapters/stripe.js";
import { GuaranteeError, LeadGuaranteeService, OverageBillingService } from "../src/application/billing-jobs.js";
import { OwnerSummaryService } from "../src/application/owner-summary-service.js";
import {
  ensureReviewAccount,
  generateReviewPassword,
  isCompTenant,
  REVIEW_ACCOUNT_EMAIL,
  REVIEW_BUSINESS_NAME,
  REVIEW_NO_LINE,
  reviewAccountToken,
  reviewAccountTokenValid,
} from "../src/application/review-account.js";
import { UsageAlertService } from "../src/application/usage-alerts.js";
import { loadEnvironment } from "../src/config/environment.js";
import { hasPlanAccess, isPaidStatus } from "../src/domain/billing.js";
import { createDemoConfig } from "../src/domain/config.js";
import { founderConnectToken, founderConnectTokenValid, signFounderToken } from "../src/domain/founder-booking.js";
import type { OutboxNotification } from "../src/domain/models.js";
import { createRequestHandler } from "../src/http/app.js";
import { NotificationHeldError } from "../src/ports.js";

const KEY = "review-signing-key-abcdefghijklmnopqrstuvwxyz-0123456789";
const WEBHOOK_SECRET = "whsec_synthetic_abcdefghijklmnopqrstuvwxyz";
const HOUR = 60 * 60_000;

describe("the review account link", () => {
  const now = new Date("2026-11-25T15:00:00Z");

  it("is signed for its own purpose and lasts at most 24 hours", () => {
    const token = reviewAccountToken(KEY, now);
    expect(reviewAccountTokenValid(KEY, token, now)).toBe(true);
    expect(reviewAccountTokenValid(KEY, token, new Date(now.getTime() + 24 * HOUR - 1))).toBe(true);
    expect(reviewAccountTokenValid(KEY, token, new Date(now.getTime() + 24 * HOUR))).toBe(false);
    // Asking for longer still gives 24 hours.
    const long = reviewAccountToken(KEY, now, 72 * HOUR);
    expect(reviewAccountTokenValid(KEY, long, new Date(now.getTime() + 24 * HOUR + 1))).toBe(false);
    // A hand-made token signed for three days is refused outright.
    expect(reviewAccountTokenValid(KEY, signFounderToken(KEY, "review-account", { exp: now.getTime() + 72 * HOUR }), now)).toBe(false);
  });

  it("never passes as another kind of link, under another key, or edited", () => {
    const token = reviewAccountToken(KEY, now);
    expect(reviewAccountTokenValid(KEY, founderConnectToken(KEY, now), now)).toBe(false);
    expect(founderConnectTokenValid(KEY, token, now)).toBe(false);
    expect(reviewAccountTokenValid(`${KEY}-other`, token, now)).toBe(false);
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ exp: now.getTime() + HOUR, admin: true })).toString("base64url");
    expect(reviewAccountTokenValid(KEY, `${forged}.${signature}`, now)).toBe(false);
    expect(reviewAccountTokenValid(KEY, `${payload}.${signature}x`, now)).toBe(false);
    expect(reviewAccountTokenValid(KEY, null, now)).toBe(false);
  });

  it("passwords are long, random and easy to copy", () => {
    const passwords = new Set(Array.from({ length: 50 }, () => generateReviewPassword()));
    expect(passwords.size).toBe(50);
    for (const password of passwords) expect(password).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{4}(?:-[A-HJ-NP-Za-km-np-z2-9]{4}){5}$/);
  });
});

describe("complimentary access", () => {
  it("opens the owner app but never counts as paid", () => {
    expect(hasPlanAccess("comp")).toBe(true);
    expect(isPaidStatus("comp")).toBe(false);
    expect(hasPlanAccess("active")).toBe(true);
    expect(hasPlanAccess("incomplete")).toBe(false);
    expect(hasPlanAccess(null)).toBe(false);
  });

  it("Stripe can never set it", () => {
    expect(normalizeSubscriptionStatus("comp")).toBe("incomplete");
  });
});

// ---- The app, end to end, with every outbound request recorded (nothing real is ever called) ----

type Outbound = { url: string; method: string };
let server: Server | null = null;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = null;
});

async function app() {
  const store = new InMemoryStore();
  await store.saveConfig(createDemoConfig());
  const clock = { at: new Date("2026-11-29T15:00:00Z"), now() { return this.at; } };
  const outbound: Outbound[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    outbound.push({ url, method });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    // Only a normal owner's signup reaches these, for the "owners can't set comp" checks.
    if (url.includes("api.stripe.com/v1/checkout/sessions")) return json({ id: "cs_synthetic_000001", url: "https://checkout.stripe.com/c/synthetic" });
    throw new Error(`Unexpected outbound request in test: ${method} ${url}`);
  }) as typeof fetch;
  const env = loadEnvironment({
    NODE_ENV: "test", DEMO_MODE: "false", PUBLIC_BASE_URL: "https://front-office.example",
    ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz",
    SESSION_SIGNING_KEY: KEY, DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-secret",
    STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_PRICE_ID: "price_synthetic", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELNYX_API_KEY: "KEY_synthetic", TELNYX_FROM_NUMBER: "+15555550199", TELNYX_CHECK_CONNECTION_ID: "check-connection",
    RESEND_API_KEY: "re_synthetic", RESEND_FROM_EMAIL: "alerts@callotto.example", SUPPORT_EMAIL: "help@callotto.example",
  });
  const handler = createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: (entry) => logs.push(entry), fetcher });
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const open = (k: string | null) => fetch(`${baseUrl}/admin/review-account${k === null ? "" : `?k=${encodeURIComponent(k)}`}`, { redirect: "manual" });
  const passwordOn = (html: string): string => [...html.matchAll(/<code>([^<]+)<\/code>/g)].map((match) => match[1]!)[1]!;
  const login = (email: string, password: string) => fetch(`${baseUrl}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password }) });
  async function signedIn(email: string, password: string) {
    const response = await login(email, password);
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const dashboard = async () => (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as Promise<Record<string, any>>;
    const csrf = (await dashboard()).csrf as string;
    const api = (path: string, body: unknown = {}) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
    const form = (path: string, fields: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...fields }) });
    return { cookie, csrf, dashboard, api, form };
  }
  async function reviewAccount() {
    const page = await open(reviewAccountToken(KEY, clock.now()));
    expect(page.status).toBe(200);
    return { email: REVIEW_ACCOUNT_EMAIL, password: passwordOn(await page.text()) };
  }
  const stripeWebhook = (type: string, object: Record<string, unknown>) => {
    const timestamp = String(Math.floor(clock.now().getTime() / 1_000));
    const raw = JSON.stringify({ id: `evt_${type}_${Math.random()}`, type, created: Number(timestamp), data: { object } });
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest("hex");
    return fetch(`${baseUrl}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body: raw });
  };
  const paidProviders = () => outbound.filter((call) => /stripe\.com|telnyx\.com/.test(call.url));
  return { store, clock, baseUrl, handler, outbound, logs, open, passwordOn, login, signedIn, reviewAccount, stripeWebhook, paidProviders };
}

describe("GET /admin/review-account", () => {
  it("needs a valid signed link", async () => {
    const made = await app();
    expect((await made.open(null)).status).toBe(401);
    expect((await made.open("forged.link")).status).toBe(401);
    expect((await made.open(founderConnectToken(KEY, made.clock.now()))).status).toBe(401);
    const expired = reviewAccountToken(KEY, new Date(made.clock.now().getTime() - 25 * HOUR));
    expect((await made.open(expired)).status).toBe(401);
    const post = await fetch(`${made.baseUrl}/admin/review-account?k=${encodeURIComponent(reviewAccountToken(KEY, made.clock.now()))}`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(await made.store.getOwnerAccountByEmail(REVIEW_ACCOUNT_EMAIL)).toBeNull();
  });

  it("a chat app's link preview changes nothing", async () => {
    const made = await app();
    const k = encodeURIComponent(reviewAccountToken(KEY, made.clock.now()));
    for (const agent of ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "facebookexternalhit/1.1 Facebot Twitterbot/1.0", "WhatsApp/2.23.20.0", "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)"]) {
      const preview = await fetch(`${made.baseUrl}/admin/review-account?k=${k}`, { headers: { "user-agent": agent } });
      expect(preview.status, agent).toBe(200);
      expect(await preview.text()).toContain("Open this link in a browser");
    }
    expect(await made.store.getOwnerAccountByEmail(REVIEW_ACCOUNT_EMAIL)).toBeNull();
    const browser = await fetch(`${made.baseUrl}/admin/review-account?k=${k}`, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" } });
    expect(await browser.text()).toContain("Created.");
  });

  it("makes one account, shows its password once, and a second visit only changes the password", async () => {
    const made = await app();
    const first = await made.open(reviewAccountToken(KEY, made.clock.now()));
    expect(first.status).toBe(200);
    expect(first.headers.get("x-robots-tag")).toContain("noindex");
    expect(first.headers.get("cache-control")).toBe("no-store");
    const html = await first.text();
    expect(html).toContain("<title>Google OAuth review account · Call Otto</title>");
    expect(html).toContain("<h1>Google OAuth review account</h1>");
    expect(html).toContain('<meta name="robots" content="noindex,nofollow,noarchive">');
    expect(html).toContain(REVIEW_ACCOUNT_EMAIL);
    expect(html).toContain("Created.");
    const password = made.passwordOn(html);
    expect(password).toMatch(/^[\w]{4}(?:-[\w]{4}){5}$/);

    const account = (await made.store.getOwnerAccountByEmail(REVIEW_ACCOUNT_EMAIL))!;
    expect(account).toMatchObject({ status: "pending_activation", displayName: "Google Reviewer" });
    expect(account.role).not.toBe("member");
    expect(account.emailVerifiedAt).toBeTruthy();
    expect(await made.store.getSubscription(account.tenantId)).toMatchObject({ status: "comp", providerCustomerId: null, providerSubscriptionId: null });
    const config = await made.store.getConfig(account.tenantId);
    expect(config).toMatchObject({ businessName: REVIEW_BUSINESS_NAME, paused: true, ownerNotificationRefs: [], ownerWeeklyEmailEnabled: false, ownerDailySmsEnabled: false, customerSmsEnabled: false });
    expect(await made.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary")).toBeNull();
    expect((await made.login(REVIEW_ACCOUNT_EMAIL, password)).status).toBe(303);

    const second = await made.open(reviewAccountToken(KEY, made.clock.now()));
    const secondHtml = await second.text();
    expect(secondHtml).toContain("This is a new password");
    const newPassword = made.passwordOn(secondHtml);
    expect(newPassword).not.toBe(password);
    const owners = await made.store.listOwnerAccounts(50);
    expect(owners.filter((item) => item.email === REVIEW_ACCOUNT_EMAIL)).toHaveLength(1);
    const again = (await made.store.getOwnerAccountByEmail(REVIEW_ACCOUNT_EMAIL))!;
    expect(again.id).toBe(account.id);
    expect(again.tenantId).toBe(account.tenantId);
    expect((await made.login(REVIEW_ACCOUNT_EMAIL, password)).status).toBe(401);
    expect((await made.login(REVIEW_ACCOUNT_EMAIL, newPassword)).status).toBe(303);
    // The password is never logged.
    expect(JSON.stringify(made.logs)).not.toContain(password);
    expect(JSON.stringify(made.logs)).not.toContain(newPassword);
    expect(made.logs.map((entry) => entry.event)).toEqual(expect.arrayContaining(["review_account_created", "review_account_password_reset"]));
    expect(made.paidProviders()).toEqual([]);
  });

  it("a session from before the reset stops working", async () => {
    const made = await app();
    const reviewer = await made.reviewAccount();
    const session = await made.signedIn(reviewer.email, reviewer.password);
    expect((await fetch(`${made.baseUrl}/api/app/dashboard`, { headers: { cookie: session.cookie } })).status).toBe(200);
    await made.reviewAccount();
    expect((await fetch(`${made.baseUrl}/api/app/dashboard`, { headers: { cookie: session.cookie } })).status).toBe(401);
  });

  it("takes over a stray signup with that email, but never a shop that has touched Stripe", async () => {
    const made = await app();
    const now = made.clock.now().toISOString();
    // Someone signed up with our address and left a phone number: taken over, demo settings, phone gone.
    await made.store.createOwnerWorkspace({
      account: { id: "11111111-1111-4111-8111-111111111111", tenantId: "shop_stray", email: REVIEW_ACCOUNT_EMAIL, displayName: "Stray", passwordHash: "x", status: "pending_activation", createdAt: now, updatedAt: now },
      config: { ...createDemoConfig("shop_stray"), businessName: "Not ours" }, ownerPhone: "+15555550111",
    });
    const reviewer = await made.reviewAccount();
    expect(await made.store.getSubscription("shop_stray")).toMatchObject({ status: "comp" });
    expect((await made.store.getConfig("shop_stray")).businessName).toBe(REVIEW_BUSINESS_NAME);
    expect(await made.store.getIntegrationSecret("shop_stray", "notifications", "owner-primary")).toBeNull();
    expect((await made.login(reviewer.email, reviewer.password)).status).toBe(303);

    // A billing record: refused, nothing changed.
    await made.store.saveSubscription({ tenantId: "shop_stray", providerCustomerId: "cus_real", providerSubscriptionId: "sub_real", status: "active", currentPeriodEnd: null, providerEventCreatedAt: new Date(made.clock.now().getTime() + 1_000).toISOString(), createdAt: now, updatedAt: now });
    const refused = await made.open(reviewAccountToken(KEY, made.clock.now()));
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("Stripe billing record");
    expect(await made.store.getSubscription("shop_stray")).toMatchObject({ status: "active", providerSubscriptionId: "sub_real" });
    expect((await made.login(reviewer.email, reviewer.password)).status).toBe(303);
  });
});

describe("the review account in the owner app", () => {
  it("opens as on a plan, and Settings > Calendar starts Google's consent screen with the two calendar scopes", async () => {
    const made = await app();
    const reviewer = await made.reviewAccount();
    const owner = await made.signedIn(reviewer.email, reviewer.password);
    const dashboard = await owner.dashboard();
    expect(dashboard).toMatchObject({ paid: true, googleAvailable: true, googleConnected: false, billing: { status: "comp" }, onboarding: { completed: true } });
    const settings = await (await fetch(`${made.baseUrl}/api/app/settings`, { headers: { cookie: owner.cookie } })).json() as Record<string, any>;
    expect(settings.plan.paid).toBe(true);
    expect(settings.integrations).toMatchObject({ googleAvailable: true, googleConnected: false });
    const start = await fetch(`${made.baseUrl}/app/integrations/google/start`, { headers: { cookie: owner.cookie }, redirect: "manual" });
    expect(start.status).toBe(303);
    const google = new URL(start.headers.get("location")!);
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy");
    expect(made.paidProviders()).toEqual([]);
  });

  it("never calls Stripe or Telnyx: no checkout, no billing portal, no number, no test or helper calls", async () => {
    const made = await app();
    const reviewer = await made.reviewAccount();
    const owner = await made.signedIn(reviewer.email, reviewer.password);
    const tenantId = (await made.store.getOwnerAccountByEmail(REVIEW_ACCOUNT_EMAIL))!.tenantId;

    const checkout = await owner.form("/app/billing/checkout", { from: "start", plan: "team" });
    expect(checkout.status).toBe(303);
    expect(checkout.headers.get("location")).toBe("/app");
    expect((await owner.form("/app/billing/portal")).status).toBe(409);
    expect((await owner.form("/app/line/go-live")).status).toBe(303);

    const activate = await (await owner.api("/api/app/onboarding/activate", { sessionId: "cs_synthetic_forged" })).json() as Record<string, any>;
    expect(activate.activation).toEqual({ status: "blocked", message: REVIEW_NO_LINE });
    for (const path of ["/api/app/line/business-number", "/api/app/line/check", "/api/app/line/help", "/api/app/line/go-live"]) {
      const response = await owner.api(path, { number: "9415550123", device: "iphone" });
      expect(response.status, path).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe(REVIEW_NO_LINE);
    }
    // Plan picks are only remembered; the refund needs a real charge.
    expect((await owner.api("/api/app/billing/plan", { plan: "solo" })).status).toBe(200);
    expect((await owner.api("/api/app/billing/lead-refund")).status).toBe(409);

    const jobs = await made.handler.runActivationJobs();
    expect(jobs.activated).toBe(0);
    expect((await made.store.getOwnerAccountByEmail(REVIEW_ACCOUNT_EMAIL))!.status).toBe("pending_activation");
    expect(await made.store.getIntegrationSecret(tenantId, "telnyx", "inbound_number")).toBeNull();
    expect(await made.store.getIntegrationSecret(tenantId, "telnyx", "pending_number")).toBeNull();
    expect(await made.store.getSubscription(tenantId)).toMatchObject({ status: "comp", providerCustomerId: null });
    expect(made.paidProviders()).toEqual([]);
  });

  it("a Stripe event naming the review shop is ignored, without reading Stripe", async () => {
    const made = await app();
    await made.reviewAccount();
    const tenantId = (await made.store.getOwnerAccountByEmail(REVIEW_ACCOUNT_EMAIL))!.tenantId;
    const response = await made.stripeWebhook("customer.subscription.updated", { id: "sub_x", customer: "cus_x", status: "active", metadata: { tenant_id: tenantId } });
    expect(response.status).toBe(200);
    expect(await made.store.getSubscription(tenantId)).toMatchObject({ status: "comp", providerSubscriptionId: null });
    expect(made.logs.some((entry) => entry.event === "stripe_event_for_comp_shop_ignored")).toBe(true);
    expect(made.paidProviders()).toEqual([]);
  });

  it("owners can't make their own shop complimentary", async () => {
    const made = await app();
    const signup = await fetch(`${made.baseUrl}/signup`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ businessName: "Synthetic Heating", email: "owner@synthetic.example", password: "synthetic-password-42", consent: "yes", phone: "2175550199", ownerSmsConsent: "yes", plan: "comp" }),
    });
    expect(signup.status).toBe(303);
    const tenantId = (await made.store.getOwnerAccountByEmail("owner@synthetic.example"))!.tenantId;
    const owner = await made.signedIn("owner@synthetic.example", "synthetic-password-42");
    expect((await owner.api("/api/app/billing/plan", { plan: "comp" })).status).toBe(400);
    await owner.form("/app/billing/checkout", { plan: "comp" });
    await owner.api("/api/app/onboarding/activate", {});
    // A Stripe payload claiming "comp" for this shop is read as Stripe's own status, never as complimentary.
    await made.stripeWebhook("checkout.session.completed", { client_reference_id: tenantId, metadata: { tenant_id: tenantId }, status: "comp" });
    expect((await made.store.getSubscription(tenantId))?.status).not.toBe("comp");
    expect((await owner.dashboard()).paid).toBe(false);
    expect(await isCompTenant(made.store, tenantId)).toBe(false);
  });
});

describe("the review shop is left out of every job and sends nothing", () => {
  async function compShop() {
    const store = new InMemoryStore();
    const clock = { now: () => new Date("2026-11-29T15:00:00Z") };
    const result = await ensureReviewAccount(store, clock);
    return { store, clock, tenantId: result.tenantId };
  }

  it("is never billed for extra calls, even with a customer id on file", async () => {
    const { store, clock, tenantId } = await compShop();
    const subscription = (await store.getSubscription(tenantId))!;
    await store.saveSubscription({ ...subscription, providerCustomerId: "cus_should_not_matter", currentPeriodEnd: "2026-11-20T00:00:00Z" });
    await store.saveIntegrationSecret(tenantId, "billing", "first_paid_at", "2026-10-01T00:00:00Z");
    const stripe = { billExtraCalls: async () => { throw new Error("Stripe must not be called"); } };
    const overage = new OverageBillingService(store, stripe, clock);
    expect(await overage.billTenant(tenantId)).toBe("skipped");
  });

  it("has no lead guarantee to claim", async () => {
    const { store, clock, tenantId } = await compShop();
    const stripe = { refundFirstInvoice: async () => { throw new Error("Stripe must not be called"); } };
    const guarantee = new LeadGuaranteeService(store, stripe, clock);
    expect((await guarantee.status(tenantId)).state).toBe("none");
    await expect(guarantee.refund(tenantId, "owner")).rejects.toBeInstanceOf(GuaranteeError);
  });

  it("gets no recap, weekly email or usage alert", async () => {
    const { store, tenantId } = await compShop();
    const account = (await store.getOwnerAccountByTenant(tenantId))!;
    await store.updateOwnerAccountStatus(account.id, "active", "2026-11-29T15:00:00Z");
    await store.saveConfig({ ...await store.getConfig(tenantId), ownerWeeklyEmailEnabled: true, ownerDailySmsEnabled: true, ownerNotificationRefs: ["owner-primary"], includedCalls: 1 });
    const sunday = { now: () => new Date("2026-11-29T15:00:00Z") };
    expect(await new OwnerSummaryService(store, sunday, "https://front-office.example").runOnce()).toEqual({ smsQueued: 0, emailQueued: 0 });
    expect(await new UsageAlertService(store, sunday, "https://front-office.example", true).check(tenantId)).toBe(0);
    expect(store.notifications.size).toBe(0);
  });

  it("anything queued for it anyway is held, never sent", async () => {
    const { store, tenantId } = await compShop();
    const sent: OutboxNotification[] = [];
    const sender = { send: async (notification: OutboxNotification) => { sent.push(notification); return { providerReceipt: "sent" }; } };
    // The same rule runtime.ts gives the real sender.
    const router = new NotificationRouter(sender, sender, sender, sender, (id) => isCompTenant(store, id));
    const base = { callId: null, body: "hello", priority: "normal" as const, state: "pending" as const, attempts: 0, nextAttemptAt: "2026-11-29T15:00:00Z", providerReceipt: null, lastError: null, createdAt: "2026-11-29T15:00:00Z", sentAt: null };
    for (const channel of ["sms", "email", "push", "voice"] as const) {
      await expect(router.send({ ...base, id: channel, tenantId, channel, destinationRef: "owner-primary", idempotencyKey: channel })).rejects.toBeInstanceOf(NotificationHeldError);
    }
    expect(sent).toEqual([]);
    await router.send({ ...base, id: "other", tenantId: "shop_other", channel: "email", destinationRef: "email:owner@synthetic.example", idempotencyKey: "other" });
    expect(sent).toHaveLength(1);
  });
});
