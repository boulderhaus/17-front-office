import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { ALL_PARTY_CONSENT_STATES, serviceAreaState } from "../src/domain/area-codes.js";
import { normalizeServiceAreaInput } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";
import { ALL_PARTY_CONSENT_STATES as WEB_ALL_PARTY, allPartyState, recordingHint, serviceAreaStateCode } from "../web/src/lib/recording-hint.js";

describe("owner app fixes (walk 70039f169)", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  const now = new Date("2026-11-25T15:00:00.000Z");
  let at = now;

  beforeEach(async () => {
    at = now;
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ PUBLIC_BASE_URL: "http://127.0.0.1:8787", RESEND_API_KEY: "re_synthetic", RESEND_FROM_EMAIL: "alerts@front-office.example" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => at }, integrations: {}, logger: () => undefined }));
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
    expect(recordingHint(false, "Sarasota FL, 34236")).toContain("Florida may need everyone’s OK");
    expect(recordingHint(true, "Austin TX")).toContain("transcript only");
    // Oregon is one-party for phone calls: no notice by default, no all-party hint.
    const oregon = await signUp("or@synthetic.example", "(503) 555-0142");
    expect((await store.getConfig(oregon.account.tenantId)).recordingDisclosure).toBe("");
    expect(allPartyState("Portland OR")).toBeNull();
  });

  it("reads the shop's state with the server's rule: the end of a place, never a word in a town's name", () => {
    for (const typed of ["Sarasota FL, 34236", "Sarasota, FL", "Sarasota fl", "34236, FL", "De Pere WI", "De Pere", "Dover DE", "Austin TX, Round Rock TX", "34236"]) {
      expect(serviceAreaStateCode(typed), typed).toBe(serviceAreaState(normalizeServiceAreaInput(typed).terms));
    }
    expect(allPartyState("De Pere WI")).toBeNull();
    expect(recordingHint(false, "Dover DE")).toBe("Delaware may need everyone’s OK to record a call. To be safe, turn this on: transcript only, no audio.");
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
    // Short (about 30 characters), so the QR is small and sparse enough for a phone camera.
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8787\/d\/[A-Za-z0-9]{8}$/);
    const path = new URL(url).pathname;
    const phone = await fetch(`${baseUrl}${path}`, { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile" } });
    expect(phone.status).toBe(200);
    expect(phone.headers.get("cache-control")).toBe("no-store");
    const html = await phone.text();
    expect(html).toContain("Dial this on (941) 555-0177");
    expect(html).toContain("3125550144");
    expect(html).toContain("Tap to dial");
    // iOS never turns the code into a phone link (press and hold must offer Copy).
    expect(html).toContain('<meta name="format-detection" content="telephone=no">');
    expect(html).not.toContain("clear it");
    expect(html.match(/class="code"/g)).toHaveLength(1);
    // A changed token is refused, and so is one past its 15 minutes.
    const forged = await fetch(`${baseUrl}${path.slice(0, -2)}xx`);
    expect(forged.status).toBe(410);
    expect(await forged.text()).toContain("Open the setup page on your computer for a new one.");
    at = new Date(now.getTime() + 16 * 60_000);
    expect((await fetch(`${baseUrl}${path}`)).status).toBe(410);
  });

  it("expired QR links are deleted when a new one is made, so refreshes never pile up", async () => {
    const { account, post } = await signUp("qr-sweep@synthetic.example", "(941) 555-0148");
    await store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", "+13125550148");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", "+19415550181");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify({ name: "T-Mobile USA", lineType: "mobile", family: "gsm", chosen: false }));
    const idOf = async () => new URL(((await (await post("/api/app/line/handoff")).json()) as { url: string }).url).pathname.slice(3);
    const first = await idOf();
    const second = await idOf();
    expect(await store.getIntegrationSecret("platform", "dial-handoff", first)).toBeTruthy();
    at = new Date(now.getTime() + 16 * 60_000);
    const third = await idOf();
    expect(await store.getIntegrationSecret("platform", "dial-handoff", first)).toBeNull();
    expect(await store.getIntegrationSecret("platform", "dial-handoff", second)).toBeNull();
    expect(await store.getIntegrationSecret("platform", "dial-handoff", third)).toBeTruthy();
    expect(JSON.parse((await store.getIntegrationSecret(account.tenantId, "forwarding", "handoff_ids"))!)).toEqual([third]);
  });

  it("Email me these steps sends the owner's own email a day-long link to the same page", async () => {
    const { account, post } = await signUp("qr-mail@synthetic.example", "(941) 555-0147");
    await store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", "+13125550147");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", "+19415550180");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify({ name: "T-Mobile USA", lineType: "mobile", family: "gsm", chosen: false }));
    const sent = await post("/api/app/line/handoff/email");
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ sentTo: "qr-mail@synthetic.example" });
    const email = [...store.notifications.values()].find((item) => item.destinationRef === "email:qr-mail@synthetic.example" && item.body.includes("forwarding steps"));
    // Every call on a GSM-family number: the iPhone Settings switch steps, the same words as the screens, Otto's number as digits.
    expect(email?.body).toContain("On an iPhone, Otto's number is 3125550147:");
    expect(email?.body).toContain("1. Open Settings › Apps › Phone.");
    expect(email?.body).toContain("3. Tap Forward To and paste the number.");
    expect(email?.body).not.toContain("**21");
    const link = /http:\/\/127\.0\.0\.1:8787(\/d\/[A-Za-z0-9]{8})/.exec(email?.body ?? "")?.[1];
    expect(link).toBeTruthy();
    at = new Date(now.getTime() + 3 * 60 * 60_000);
    const page = await (await fetch(`${baseUrl}${link}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" } })).text();
    // iPhone, every call: the Settings switch is the way (no gray box), Otto's number with a Copy button.
    expect(page).toContain("Forward calls on (941) 555-0180");
    expect(page).toContain('<div class="num">(312) 555-0147</div>');
    expect(page).toContain('data-copy="3125550147"');
    expect(page).toContain("<li>Open Settings › Apps › Phone.</li><li>Tap Call Forwarding and turn it on.</li><li>Tap Forward To and paste the number.</li>");
    expect(page).toContain('<script src="/assets/copy-number.js" defer></script>');
    // The code flow stays, unchanged, behind the quiet link (and only there does the gray box come up).
    const [switchPart, fallback] = page.split("<details><summary>Don’t see Call Forwarding?</summary>");
    expect(switchPart).not.toContain("gray box");
    expect(switchPart).not.toContain("**21");
    expect(fallback).toContain("**21*13125550147#");
    expect(fallback).toContain("tap Paste, then Call");
    expect(fallback).toContain("gray box that says Succeeded. Tap Dismiss");
    expect(page).not.toContain("tel:");
    expect((await fetch(`${baseUrl}/assets/copy-number.js`)).status).toBe(200);
    // Android keeps today's code flow, no switch.
    const android = await (await fetch(`${baseUrl}${link}`, { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile" } })).text();
    expect(android).toContain("Dial this on (941) 555-0180");
    expect(android).not.toContain("Call Forwarding");
    expect(android).toContain("Tap to dial");
  });

  it("Email me these steps for a Verizon number, or ring first, sends the code page as before", async () => {
    const { account, post } = await signUp("qr-mail-vz@synthetic.example", "(941) 555-0149");
    await store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", "+13125550149");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", "+19415550182");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify({ name: "Verizon Wireless", lineType: "mobile", family: "verizon", chosen: false }));
    expect((await post("/api/app/line/handoff/email")).status).toBe(200);
    const email = [...store.notifications.values()].find((item) => item.destinationRef === "email:qr-mail-vz@synthetic.example");
    expect(email?.body).toContain("Your Call Otto forwarding code");
    expect(email?.body).not.toContain("Call Forwarding");
    const link = /(\/d\/[A-Za-z0-9]{8})/.exec(email?.body ?? "")?.[1];
    const page = await (await fetch(`${baseUrl}${link}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" } })).text();
    expect(page).toContain("Dial this on (941) 555-0182");
    expect(page).toContain("*723125550149");
    expect(page).not.toContain("Call Forwarding");
    // Ring first on a GSM iPhone: still the code, with the heads-up about the gray box.
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify({ name: "T-Mobile USA", lineType: "mobile", family: "gsm", chosen: false }));
    await store.saveConfig({ ...await store.getConfig(account.tenantId), operationMode: "overflow" });
    const ring = await (await fetch(`${baseUrl}${link}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" } })).text();
    expect(ring).toContain("Dial this on (941) 555-0182");
    expect(ring).toContain("**004*13125550149");
    expect(ring).toContain("gray box that says Succeeded. Tap Dismiss");
    expect(ring).not.toContain("data-copy");
  });

  it("the QR page shows one code at a time: the clear code only after a test found every call still forwarded, then Next", async () => {
    const { account, post } = await signUp("qr-clear@synthetic.example", "(941) 555-0146");
    await store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", "+13125550146");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", "+19415550179");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify({ name: "T-Mobile USA", lineType: "mobile", family: "gsm", chosen: false }));
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "confirmed_at", now.toISOString());
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "tested_for", JSON.stringify({ mode: "every-call", code: "**21*13125550146#", at: now.toISOString() }));
    await store.saveConfig({ ...await store.getConfig(account.tenantId), operationMode: "overflow" });
    const android = { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile" } };
    const { url } = await (await post("/api/app/line/handoff")).json() as { url: string };
    const path = new URL(url).pathname;
    // Switching to ring first alone: just the ring-first code, never two codes on one screen.
    const plain = await (await fetch(`${baseUrl}${path}`, android)).text();
    expect(plain).toContain("**004*13125550146");
    expect(plain).not.toContain("##002#");
    // Our ring-first test reached Otto with no ring: every call is still forwarded. Clear code alone, then Next.
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "check", JSON.stringify({ startedAt: now.toISOString(), method: "auto", choice: "ring-first", code: "**004*13125550146**10#", forwardedAfterMs: 2_000, atOnce: true }));
    const clear = await (await fetch(`${baseUrl}${path}`, android)).text();
    expect(clear).toContain("Every call is still being forwarded.");
    expect(clear).toContain('<div class="code">##002#</div>');
    expect(clear).toContain('href="tel:%23%23002%23"');
    expect(clear).not.toContain("**004*");
    expect(clear).toContain(`href="${path}?step=code"`);
    const next = await (await fetch(`${baseUrl}${path}?step=code`, android)).text();
    expect(next).toContain("**004*13125550146");
    expect(next).not.toContain("##002#");
    // iPhone: clear it with the Settings switch, the clear code behind the quiet link, then Next to the ring-first code.
    const iphone = { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" } };
    const off = await (await fetch(`${baseUrl}${path}`, iphone)).text();
    expect(off).toContain("Clear the old forwarding on (941) 555-0179");
    expect(off).toContain("<p>Open Settings › Apps › Phone. Tap Call Forwarding and turn it off.</p>");
    expect(off.split("<details>")[0]).not.toContain("##002#");
    expect(off.split("<details>")[1]).toContain('<div class="code">##002#</div>');
    expect(off.match(/Next: your code/g)).toHaveLength(1);
    const ringCode = await (await fetch(`${baseUrl}${path}?step=code`, iphone)).text();
    expect(ringCode).toContain("Dial this on (941) 555-0179");
    expect(ringCode).toContain("**004*13125550146");
    expect(ringCode).toContain("gray box that says Succeeded. Tap Dismiss");
    expect(ringCode).not.toContain("Call Forwarding");
  });

  it("an iPhone leaving every call for ring first turns the Settings switch off first, before any test", async () => {
    const { account, post } = await signUp("qr-leave@synthetic.example", "(941) 555-0150");
    await store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", "+13125550150");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", "+19415550183");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify({ name: "T-Mobile USA", lineType: "mobile", family: "gsm", chosen: false }));
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "confirmed_at", now.toISOString());
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "tested_for", JSON.stringify({ mode: "every-call", code: "**21*13125550150#", at: now.toISOString() }));
    await store.saveConfig({ ...await store.getConfig(account.tenantId), operationMode: "overflow" });
    const { url } = await (await post("/api/app/line/handoff")).json() as { url: string };
    const path = new URL(url).pathname;
    const iphone = await (await fetch(`${baseUrl}${path}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" } })).text();
    expect(iphone).toContain("Open Settings › Apps › Phone. Tap Call Forwarding and turn it off.");
    expect(iphone).toContain(`href="${path}?step=code"`);
    // Android is unchanged: just the ring-first code.
    const android = await (await fetch(`${baseUrl}${path}`, { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile" } })).text();
    expect(android).toContain("**004*13125550150");
    expect(android).not.toContain("##002#");
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

  it("a test from another phone keeps waiting as long as the server accepts the forwarded call", async () => {
    const { account, cookie } = await signUp("manual@synthetic.example", "(941) 555-0147");
    await store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", "+13125550147");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", "+19415550180");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify({ name: "T-Mobile USA", lineType: "mobile", family: "gsm", chosen: false }));
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "check", JSON.stringify({ startedAt: now.toISOString(), method: "manual", autoFailed: true, choice: "every-call", code: null }));
    const status = async () => (await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { line: { check: { status: string } } }).line.check.status;
    at = new Date(now.getTime() + 90_000);
    expect(await status()).toBe("calling");
    at = new Date(now.getTime() + 101_000);
    expect(await status()).toBe("not_reached");
  });

  it("Cancel goes back to the last finished test: a failure after a pass never turns into Forwarding works", async () => {
    const { account, cookie, post } = await signUp("cancel@synthetic.example", "(941) 555-0148");
    await store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", "+13125550148");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", "+19415550181");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify({ name: "T-Mobile USA", lineType: "mobile", family: "gsm", chosen: false }));
    // Passed ten minutes ago, then a later test failed.
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "confirmed_at", new Date(now.getTime() - 10 * 60_000).toISOString());
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "check", JSON.stringify({ startedAt: new Date(now.getTime() - 5 * 60_000).toISOString(), method: "manual", choice: "every-call", code: "**21*13125550148#" }));
    const check = async () => (await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { line: { confirmedAt: string | null; check: { status: string } } }).line;
    expect((await check()).check.status).toBe("not_reached");
    expect((await post("/api/app/line/check")).status).toBe(200);
    expect((await check()).check.status).toBe("calling");
    expect((await post("/api/app/line/check/cancel")).status).toBe(200);
    expect((await check()).check.status).toBe("not_reached");
    // With no earlier test, Cancel is idle.
    expect((await post("/api/app/line/check/cancel")).status).toBe(200);
    expect((await check()).check.status).toBe("idle");
  });

  it("an expired form says the page expired, never the raw CSRF error", async () => {
    const { cookie } = await signUp("csrf@synthetic.example", "(941) 555-0149");
    const page = await fetch(`${baseUrl}/app/config`, { method: "POST", headers: { cookie, accept: "text/html", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "stale" }) });
    expect(page.status).toBe(403);
    const html = await page.text();
    expect(html).toContain("This page expired");
    expect(html).not.toContain("CSRF");
  });

  it("a new mobile while texts are on records the yes again; without a yes on file it records nothing", async () => {
    const { account, cookie, csrf, post } = await signUp("renumber@synthetic.example", "(941) 555-0150");
    expect((await post("/api/app/alerts/texts", { on: true })).status).toBe(200);
    const first = JSON.parse((await store.getIntegrationSecret(account.tenantId, "notifications", "owner_sms_consent"))!) as { at: string; wording: string };
    at = new Date(now.getTime() + 60 * 60_000);
    const put = async (phone: string) => {
      const current = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie } })).json() as { values: Record<string, unknown> };
      return fetch(`${baseUrl}/api/app/settings`, { method: "PUT", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ ...current.values, ownerPhone: phone }) });
    };
    expect((await put("(941) 555-0151")).status).toBe(200);
    const second = JSON.parse((await store.getIntegrationSecret(account.tenantId, "notifications", "owner_sms_consent"))!) as { at: string; wording: string; source: string };
    expect(second.at).toBe(at.toISOString());
    expect(second.at).not.toBe(first.at);
    expect(second.wording).toBe(first.wording);
    // A shop with texts set on before consent was recorded (old Settings) gets no consent record from a number change.
    await store.deleteIntegrationSecret(account.tenantId, "notifications", "owner_sms_consent");
    expect((await put("(941) 555-0152")).status).toBe(200);
    expect(await store.getIntegrationSecret(account.tenantId, "notifications", "owner_sms_consent")).toBeNull();
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
  it("two choices, one 'or': providers, then Continue with email, which holds the email, the password and the link", async () => {
    const { renderOwnerSignup, providerButtons } = await import("../src/admin/render.js");
    const page = renderOwnerSignup("", {}, { providers: { google: true, microsoft: true }, emailLink: true });
    // Walk 11-26 (SIGNUP-02): three stacked choices and two "or"s. Now one "or" between the providers and email.
    expect(page.match(/class="ordivider"/g)).toHaveLength(1);
    expect(page).not.toContain("or fill this in");
    expect(page).not.toContain("linkstart");
    expect(page.indexOf("Continue with Google")).toBeLessThan(page.indexOf("Continue with email"));
    expect(page).toContain('<details class="emailpath"><summary class="emailbtn">');
    // Inside: email, then password (revealed once the email looks complete), then the link as a small second choice.
    const emailForm = page.slice(page.indexOf('<details class="emailpath">'), page.indexOf("</details>"));
    expect(emailForm.indexOf('name="email"')).toBeLessThan(emailForm.indexOf('name="password"'));
    expect(emailForm).toContain('<button class="linkbtn" formaction="/login/email" formnovalidate>Email me a sign-in link instead</button>');
    expect(emailForm.indexOf("<button>Continue</button>")).toBeLessThan(emailForm.indexOf("Email me a sign-in link instead"));
    expect(page).toContain(".authpage .emailpath form:has(input[type=email]:valid) .pwstep");
    expect(page).toContain(".idp .microsoft{border:1px solid #747775;color:#1f1f1f}");
    expect(page).toContain('action="/signup" novalidate');
    // No shop questions before the account exists, and never a trade.
    for (const name of ["businessName", "phone", "trade", "ownerSmsConsent"]) expect(page).not.toContain(`name="${name}"`);
    // Without a provider, the email form shows at once (nothing to choose between).
    const emailOnly = renderOwnerSignup("", {}, { emailLink: true });
    expect(emailOnly).not.toContain("<details");
    expect(emailOnly).not.toContain(`class="ordivider"`);
    // Verified already (Google, Microsoft or the link): the shop screen, no second way in.
    expect(renderOwnerSignup("", {}, { providers: { google: true }, emailLink: true, verified: { email: "a@b.example", provider: "email" } })).not.toContain("Email me a sign-in link");
    expect(providerButtons({ google: true, microsoft: true })).toContain("Continue with Microsoft");
  });
});
