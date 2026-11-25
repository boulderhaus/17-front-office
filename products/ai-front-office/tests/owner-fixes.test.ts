import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { ALL_PARTY_CONSENT_STATES } from "../src/domain/area-codes.js";
import { createRequestHandler } from "../src/http/app.js";
import { ALL_PARTY_CONSENT_STATES as WEB_ALL_PARTY, recordingHint } from "../web/src/lib/recording-hint.js";

describe("owner app fixes (walk 70039f169)", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  const now = new Date("2026-11-25T15:00:00.000Z");

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => now }, integrations: {}, logger: () => undefined }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  const signUp = async (email: string, phone: string) => {
    const response = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", email, password: "long-password-for-tests", phone }) });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const account = (await store.getOwnerAccountByEmail(email))!;
    const { csrf } = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie } })).json() as { csrf: string };
    const post = (path: string, body: unknown = {}) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
    return { cookie, account, csrf, post };
  };

  it("starts a shop in an all-party-consent state with the recording notice on, and others off", async () => {
    const florida = await signUp("fl@synthetic.example", "(941) 555-0142");
    expect((await store.getConfig(florida.account.tenantId)).recordingDisclosure).not.toBe("");
    const texas = await signUp("tx@synthetic.example", "(512) 555-0142");
    expect((await store.getConfig(texas.account.tenantId)).recordingDisclosure).toBe("");
    // The app's hint names the state, from the same list.
    expect(Object.keys(WEB_ALL_PARTY).sort()).toEqual([...ALL_PARTY_CONSENT_STATES].sort());
    expect(recordingHint(false, "Sarasota FL, 34236")).toContain("Florida needs everyone’s OK");
    expect(recordingHint(true, "Austin TX")).toContain("transcript only");
  });

  it("answers a browser with a page (and a way back), never raw JSON; JSON clients keep JSON", async () => {
    const page = await fetch(`${baseUrl}/this-page-does-not-exist`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(404);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
    expect(html).toContain('name="viewport"');
    const json = await fetch(`${baseUrl}/this-page-does-not-exist`);
    expect(json.headers.get("content-type")).toContain("application/json");
  });

  it("sends a failed Manage billing back to Plan and billing with a reason, not a JSON error", async () => {
    const { cookie, csrf } = await signUp("billing@synthetic.example", "(941) 555-0143");
    const portal = await fetch(`${baseUrl}/app/billing/portal`, { method: "POST", redirect: "manual", headers: { cookie, accept: "text/html", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) });
    expect(portal.status).toBe(303);
    expect(portal.headers.get("location")).toBe("/app/settings/plan?billing=none");
  });

  it("the computer's QR opens the code on a signed-out phone for 15 minutes, and nothing else", async () => {
    const { account, post } = await signUp("qr@synthetic.example", "(941) 555-0144");
    await store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", "+13125550144");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", "+19415550177");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify({ name: "T-Mobile USA", lineType: "mobile", family: "gsm", chosen: false }));
    const { url } = await (await post("/api/app/line/handoff")).json() as { url: string };
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8787\/dial\/[\w-]+\.[\w-]+$/);
    const path = new URL(url).pathname;
    const phone = await fetch(`${baseUrl}${path}`, { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile" } });
    expect(phone.status).toBe(200);
    expect(phone.headers.get("cache-control")).toBe("no-store");
    const html = await phone.text();
    expect(html).toContain("Dial this on (941) 555-0177");
    expect(html).toContain("3125550144");
    expect(html).toContain("Tap to dial");
    // A changed token is refused.
    const forged = await fetch(`${baseUrl}${path.slice(0, -2)}xx`);
    expect(forged.status).toBe(410);
  });

  it("Cancel ends a running test, and a test our call couldn't place says why", async () => {
    const { account, cookie, post } = await signUp("check@synthetic.example", "(941) 555-0145");
    await store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", "+13125550145");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", "+19415550178");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify({ name: "T-Mobile USA", lineType: "mobile", family: "gsm", chosen: false }));
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "check", JSON.stringify({ startedAt: now.toISOString(), method: "manual", autoFailed: true, choice: "every-call", code: null }));
    const dashboard = async () => (await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { line: { check: { status: string; autoFailed: boolean } } }).line.check;
    expect(await dashboard()).toMatchObject({ status: "calling", autoFailed: true });
    expect((await post("/api/app/line/check/cancel")).status).toBe(200);
    expect((await dashboard()).status).toBe("idle");
  });

  it("saving a mobile in Settings is just the number: texts stay off until the owner says yes", async () => {
    const { account, cookie, csrf } = await signUp("mobile@synthetic.example", "");
    const current = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie } })).json() as { values: Record<string, unknown> };
    const saved = await fetch(`${baseUrl}/api/app/settings`, { method: "PUT", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ ...current.values, ownerPhone: "(941) 555-0199" }) });
    expect(saved.status).toBe(200);
    const body = await saved.json() as { integrations: { ownerPhoneMasked: string }; texts: { on: boolean } };
    expect(body.integrations.ownerPhoneMasked).toBe("(941) •••-0199");
    expect(body.texts.on).toBe(false);
    expect((await store.getConfig(account.tenantId)).ownerNotificationRefs).toEqual([]);
  });
});

describe("sign-up page start (walk 70039f169)", () => {
  it("offers Google, Microsoft and an email link with equal weight, a full-size trade select, and server-side errors", async () => {
    const { renderOwnerSignup, providerButtons } = await import("../src/admin/render.js");
    const page = renderOwnerSignup("", {}, { providers: { google: true, microsoft: true }, emailLink: true });
    expect(page).toContain('<form class="linkstart" method="post" action="/login/email">');
    expect(page).toContain("Sign up with an email link");
    expect(page.indexOf("Continue with Google")).toBeLessThan(page.indexOf("Sign up with an email link"));
    expect(page).toContain(".idp .microsoft{border:1px solid #747775;color:#1f1f1f}");
    expect(page).toContain('<span class="selectwrap"><select name="trade" id="signup-trade"');
    expect(page).toContain('action="/signup" novalidate>');
    expect(page).not.toContain("Callers never see it");
    // Verified already (Google, Microsoft or the link): no second way in.
    expect(renderOwnerSignup("", {}, { providers: { google: true }, emailLink: true, verified: { email: "a@b.example", provider: "email" } })).not.toContain("Sign up with an email link");
    expect(providerButtons({ google: true, microsoft: true })).toContain("Continue with Microsoft");
  });
});
