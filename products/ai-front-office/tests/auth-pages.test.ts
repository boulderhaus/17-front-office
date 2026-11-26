import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { COMPANY, SMS_CONSENT_VERSION } from "../src/admin/footer.js";
import { renderFounderBooking } from "../src/admin/founder.js";
import { renderForgotPassword, renderOwnerLogin, renderOwnerSignup, renderResetPassword } from "../src/admin/render.js";
import { renderJoinPage } from "../src/admin/team.js";
import { findTrade } from "../src/domain/trades.js";
import { verifyOwnerPassword } from "../src/security/owner-auth.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { OWNER_CALL_CONSENT_DETAIL, OWNER_CALL_CONSENT_LABEL, OWNER_CALL_CONSENT_SIGNUP_LABEL, OWNER_CALL_CONSENT_SIGNUP_VERSION, OWNER_CALL_CONSENT_VERSION } from "../src/domain/owner-call-consent.js";
import { createRequestHandler } from "../src/http/app.js";
import { startSignup } from "./signup-steps.js";

/**
 * Carrier review (10DLC) approved this exact wording. Styling around it may change; these strings may not,
 * by one character. Changing them means a new consent version and a new carrier review first.
 */
const SMS_OPT_IN_LABEL = "<span>Send me Call Otto account notifications by text (new calls, appointments)—optional</span>";
const SMS_OPT_IN_DISCLOSURE = "<small>By checking this, you agree to receive SMS account notifications from Call Otto by Dutchworks LLC. Msg frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. We won’t share mobile info with third parties for marketing. Not required to sign up. <a href=\"/terms\">Terms</a> · <a href=\"/privacy\">Privacy</a></small>";

describe("signup consent wording", () => {
  it("is byte-identical to the reviewed text, with its version and company details unchanged", () => {
    expect(SMS_CONSENT_VERSION).toBe("2026-11-23.2");
    expect(COMPANY.email).toBe("hello@bydutchworks.com");
    expect(COMPANY.website).toBe("https://bydutchworks.com");
    expect(OWNER_CALL_CONSENT_VERSION).toBe("owner-urgent-calls-2026-11-23b");
    expect(OWNER_CALL_CONSENT_LABEL).toBe("Call my mobile with an automated message when a caller has an emergency (optional)");
    expect(OWNER_CALL_CONSENT_DETAIL).toBe("By choosing this, you agree that Call Otto by Dutchworks LLC may call this number with automated, artificial-voice messages about emergency calls to your business. Not required to sign up. Press 9 during a call, or turn it off in Settings, to stop.");
    // The text opt-in lives on the shop screen (Google, Microsoft, link or password sign-up alike), byte for byte.
    for (const provider of ["google", "microsoft", "email", "password"] as const) {
      const page = renderOwnerSignup("", {}, { verified: { email: "owner@synthetic.example", provider } });
      expect(page).toContain(`<div class="optin"><label class="check"><input name="ownerSmsConsent" type="checkbox" value="yes" >${SMS_OPT_IN_LABEL}</label>${SMS_OPT_IN_DISCLOSURE}</div>`);
      // Walk 11-26 (SIGNUP-03): the automated-call consent is one short line, no paragraph under it.
      expect(page).toContain(`<div class="optin"><label class="check"><input name="ownerCallConsent" type="checkbox" value="yes" ><span>${OWNER_CALL_CONSENT_SIGNUP_LABEL}</span></label></div>`);
      expect(page).not.toContain(OWNER_CALL_CONSENT_DETAIL);
      // One terms line on the page besides the opt-in's own links.
      expect(page.match(/By continuing you agree/g)).toHaveLength(1);
      // Easy to read: the disclosure is at least 13px.
      expect(page).toMatch(/\.optin small\{[^}]*font:500 13px/);
    }
    // The account screen has no consent boxes at all.
    expect(renderOwnerSignup()).not.toContain("ownerSmsConsent");
    expect(OWNER_CALL_CONSENT_SIGNUP_VERSION).toBe("owner-urgent-calls-signup-2026-11-26");
  });
});

describe("public page system", () => {
  it("signup: no shrinking or clipped text, hints outside labels, e.g. placeholder, no label on a plain div", () => {
    const account = renderOwnerSignup();
    const page = renderOwnerSignup("", {}, { verified: { email: "owner@synthetic.example", provider: "password" } });
    expect(page).not.toContain("3.2vw");
    expect(page).not.toContain("white-space:nowrap;line-height:1");
    expect(page).toContain('<div class="onboard-steps"><span>Step 1 of 3 · Your shop</span>');
    expect(page).toContain('<label for="signup-phone">Your mobile number</label><input name="phone" id="signup-phone"');
    expect(page).toContain('placeholder="e.g. (941) 555-0123"');
    expect(page).toMatch(/id="signup-phone" [^>]*aria-describedby="signup-phone-hint">/);
    // Walk 11-26 (SIGNUP-08): 8 characters, not 12.
    expect(account).toContain('<span class="hint" id="signup-password-hint">At least 8 characters.</span>');
    expect(account).toMatch(/<input name="password" id="signup-password" type="password" autocomplete="new-password" minlength="8"/);
    expect(account).toMatch(/<input name="email" id="signup-email" type="email" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false"/);
    expect(page).toContain(".plan .intro{color:var(--red-strong)");
    expect(page).toContain('<main class="publicmain formpage authpage">');
  });

  it("signup: the guarantee and one price summary sit above the button; only the terms line sits under it", () => {
    const plan = { id: "solo", label: "Solo", priceCents: 4_999, firstMonthCents: 2_499, includedCalls: 60, blurb: "60 answered calls a month, about 2 a day", who: "Just you", chargeNote: "Today: $24.99." };
    const page = renderOwnerSignup("", {}, { plans: [plan, { ...plan, id: "team", label: "Team" }], chargeNote: plan.chargeNote, verified: { email: "owner@synthetic.example", provider: "google" } });
    const at = (text: string): number => page.indexOf(text);
    const [guarantee, summary, button, agree] = [at('<p class="guarantee">'), at('<div class="quotes"'), at("<button>Continue to card</button>"), at('<p class="agree">')];
    expect(guarantee).toBeGreaterThan(at('<fieldset class="plans">'));
    // One price summary in one fixed place, right above the button; only the terms line sits under it.
    expect([guarantee < summary, summary < button, button < agree]).toEqual([true, true, true]);
    expect(page.slice(button, page.indexOf("</form>")).match(/<p class="/g)).toEqual(['<p class="']);
  });

  it("signup: Unlimited is a switch in its own add-on box, and the summary has a line for each plan with and without it", () => {
    const unlimited = (planCents: number, addOnCents: number) => ({ addOnCents, priceCents: planCents + addOnCents, firstMonthCents: Math.round((planCents + addOnCents) / 2), fairUseCalls: 180, priceId: null });
    const solo = { id: "solo", label: "Solo", priceCents: 4_999, firstMonthCents: 2_499, includedCalls: 60, blurb: "", who: "One person", chargeNote: "", unlimited: unlimited(4_999, 5_000) };
    const team = { ...solo, id: "team", label: "Team", priceCents: 17_999, firstMonthCents: 8_999, includedCalls: 250, who: "About 5 people", unlimited: unlimited(17_999, 7_500) };
    const page = renderOwnerSignup("", { unlimited: "yes", plan: "team" }, { plans: [solo, team], verified: { email: "owner@synthetic.example", provider: "google" } });
    expect(page).toMatch(/<div class="addon"><span class="addonhead">Add-on<\/span><label class="unltoggle" for="unlimited"><input type="checkbox" role="switch" id="unlimited" name="unlimited" value="yes" checked>/);
    expect(page).toMatch(/<input type="radio" name="plan" id="plan-team" value="team" checked>/);
    for (const key of ["solo", "solo+unlimited", "team", "team+unlimited"]) expect(page).toContain(`<div class="quote" data-plan="${key}">`);
    // Team with Unlimited: $254.99 a month, half off today.
    expect(page).toMatch(/data-plan="team\+unlimited"><span class="qlabel">Today · First month half off<\/span><span class="qbig"><b>\$127\.50<\/b><s>\$254\.99<\/s>/);
    // CSS picks the one summary that matches the checked plan and switch: no script needed.
    expect(page).toContain('.publicform:has(#plan-team:checked):has(#unlimited:checked) .quote[data-plan="team+unlimited"]{display:grid}');
    expect(page).not.toContain("Bigger shop");
  });

  it("signup and sign-in carry the Call Otto wordmark, not plain text", () => {
    for (const page of [renderOwnerSignup(), renderOwnerLogin()]) expect(page).toContain('<a class="brand smallbrand" href="/"><b class="mark" aria-hidden="true">CO</b>Call <em>Otto</em></a>');
  });

  it("sign-in, check-email, link, forgot and reset pages share one eyebrow", async () => {
    const render = await import("../src/admin/render.js");
    for (const page of [render.renderOwnerLogin(), render.renderSignInLinkSent("owner@synthetic.example"), render.renderSignInLinkConfirm("token"), render.renderForgotPassword({ emailEnabled: true }), render.renderResetPassword("token")]) {
      expect(page).toContain('<p class="eyebrow">Your calls. Your rules.</p>');
    }
  });

  it("the founder booking page is the same narrow page; times are white choices, not a wall of red buttons", () => {
    const slots = [{ start: "2026-11-30T15:00:00Z", end: "2026-11-30T15:10:00Z" }];
    const pick = renderFounderBooking({ state: "pick", token: "t", businessName: "Synthetic Air", timeZone: "America/Chicago", slots });
    expect(pick).toContain('<main class="publicmain formpage authpage">');
    expect(pick).toContain('<div class="slotday" role="group" aria-labelledby="day-0"><h2 id="day-0">');
    expect(pick).toMatch(/\.slotgrid button\{[^}]*background:var\(--white\);color:var\(--blue\)/);
    const booked = renderFounderBooking({ state: "booked", slot: slots[0]!, timeZone: "America/Chicago", callNumber: "(941) 555-0199", justBooked: true });
    expect(booked).toContain('<span class="nowrap">(941) 555-0199</span>');
    expect(booked).not.toContain('style="white-space:nowrap"');
    expect(booked).toMatch(/p\.done\{[^}]*text-wrap:balance/);
    // Brock is named once per line.
    const reply = renderFounderBooking({ state: "reply", reason: "nothing_open" });
    expect(reply).toContain("<p>Brock’s open times are full this week. Reply to his email with a good time and he’ll call you.</p>");
    // A taken time is said on load: the box takes focus so a screen reader reads it before the times.
    const taken = renderFounderBooking({ state: "pick", token: "t", businessName: "Synthetic Air", timeZone: "America/Chicago", slots, taken: true });
    expect(taken).toContain('<div class="formerror" role="alert" tabindex="-1" autofocus><p>That time just got taken. Pick another.</p></div>');
    expect(pick).not.toContain("autofocus");
  });

  it("a page-level error box takes focus only when no field does", () => {
    const focusBox = /<div class="formerror" role="alert" id="[^"]+" tabindex="-1" autofocus>/;
    expect(renderOwnerSignup("Check the form and try again.")).toMatch(focusBox);
    expect(renderOwnerSignup("", { email: "owner@synthetic" }, { fieldErrors: { email: "Enter an email like you@yourshop.com." } })).not.toMatch(focusBox);
    expect(renderOwnerSignup("", {}, { verified: { email: "a@b.example", provider: "password" }, fieldErrors: { phone: "Enter a 10-digit US mobile number." } })).not.toMatch(focusBox);
    expect(renderOwnerLogin("Google sign-in didn’t work. Try again.")).toMatch(focusBox);
    expect(renderOwnerLogin("That link expired or was already used. Send a new one.", { emailLink: true, errorField: "linkToken" })).not.toMatch(focusBox);
    expect(renderForgotPassword({ emailEnabled: true, error: "That reset link is expired or already used. Ask for a new one." })).toMatch(focusBox);
    expect(renderForgotPassword({ emailEnabled: true, error: "Enter the email on your account, like you@yourshop.com.", email: "owner@synthetic" })).not.toMatch(focusBox);
    expect(renderOwnerLogin()).toMatch(/\.formerror:focus-visible\{outline:3px solid var\(--field-ink\)/);
  });

  it("inline links grow to 44px as boxes, not padding that overlaps the line above or below", () => {
    const page = renderOwnerLogin();
    expect(page).toContain(".publicform .fielderror a{display:inline-flex;align-items:center;min-height:44px;");
    expect(page).toContain(".authnote a{display:inline-flex;align-items:center;min-height:44px;");
    expect(page).not.toMatch(/(fielderror|authnote) a\{[^}]*padding-block/);
  });
});

describe("signup errors", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => new Date("2026-01-15T08:00:00.000Z") }, integrations: { Demo: true }, logger: () => undefined }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const signup = (fields: Record<string, string>) => fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

  it("account screen: each problem under its field, naming the fix, keeps the email and focuses the first one", async () => {
    const response = await signup({ step: "account", email: "owner@synthetic", password: "short" });
    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain('<div class="formerror" role="alert" id="signup-error"><ul><li><a href="#signup-email">Enter an email like you@yourshop.com.</a></li><li><a href="#signup-password">Make your password at least 8 characters.</a></li></ul></div>');
    expect(page).toMatch(/<input name="email" id="signup-email" [^>]*value="owner@synthetic" required aria-describedby="signup-email-error" aria-invalid="true" autofocus>/);
    expect(page).toMatch(/<input name="password" id="signup-password" [^>]*aria-describedby="signup-password-error" aria-invalid="true">/);
    // The email box is open with the password showing; the password never comes back.
    expect(page).toContain('<div class="emailpath"><form method="post" action="/signup" novalidate class="pwopen">');
    expect(page).not.toContain('value="short"');
    // Nothing was stored.
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("afo_pending_identity=") && !cookie.startsWith("afo_pending_identity=;"))).toBe(false);
  });

  it("shop screen: each problem under its field, keeps what was typed and focuses the first one", async () => {
    const { cookie } = await startSignup(baseUrl);
    const response = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", phone: "555" }) });
    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain('<div class="formerror" role="alert" id="signup-error"><p><a href="#signup-phone">Enter a 10-digit US mobile number.</a></p></div>');
    expect(page).toMatch(/<input name="phone" id="signup-phone" [^>]*value="555" required aria-describedby="signup-phone-error signup-phone-hint" aria-invalid="true" autofocus>/);
    expect(page).toContain('value="Synthetic Air"');
    expect(page).not.toContain("signup-shop-error");
    expect(page).not.toContain('name="password"');
  });

  it("a one-letter shop name says how long it must be", async () => {
    const page = await (await signup({ businessName: "C", email: "owner@synthetic.example", password: "long-password-for-tests", trade: "hvac" })).text();
    expect(page).toContain('<span class="fielderror" id="signup-shop-error">Use at least 2 characters for your shop name.</span>');
  });

  it("asks for a mobile number when the text box is checked without one", async () => {
    const page = await (await signup({ businessName: "Synthetic Air", email: "owner@synthetic.example", password: "long-password-for-tests", ownerSmsConsent: "yes" })).text();
    expect(page).toContain('<span class="fielderror" id="signup-phone-error">Add your mobile number to get texts.</span>');
  });

  it("an email that already has an account says so on the account screen, before any shop questions", async () => {
    expect((await signup({ businessName: "Synthetic Air", email: "first@synthetic.example", password: "long-password-for-tests" })).status).toBe(303);
    const again = await signup({ step: "account", email: "first@synthetic.example", password: "another-password" });
    expect(again.status).toBe(409);
    const page = await again.text();
    expect(page).toContain('<span class="fielderror" id="signup-email-error">That email already has an account. <a href="/login">Sign in instead</a></span>');
    expect(page).not.toContain('name="businessName"');
  });

  it("an email that already has an account says so under the email field", async () => {
    const fields = { businessName: "Synthetic Air", email: "taken@synthetic.example", password: "long-password-for-tests", trade: "hvac" };
    expect((await signup(fields)).status).toBe(303);
    const again = await signup(fields);
    expect(again.status).toBe(409);
    const page = await again.text();
    // The fix is signing in, so both the field error and the summary link there.
    expect(page).toContain('<span class="fielderror" id="signup-email-error">That email already has an account. <a href="/login">Sign in instead</a></span>');
    expect(page).toContain('<div class="formerror" role="alert" id="signup-error"><p><a href="/login">That email already has an account. Sign in instead.</a></p></div>');
  });
});

describe("two-screen sign-up (walk 11-26: account first, then the shop)", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => new Date("2026-01-15T08:00:00.000Z") }, integrations: { Demo: true }, logger: () => undefined }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (fields: Record<string, string>, cookie = "") => fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
  const shop = { businessName: "Synthetic Plumbing", phone: "9415550142", timezone: "America/New_York" };

  it("email and password first, nothing stored; the shop screen makes the account and workspace with that password", async () => {
    const { cookie, email, response } = await startSignup(baseUrl, { email: "two-step@synthetic.example", password: "eight-ch" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/signup");
    // Abandoning here leaves nothing behind: no account, no workspace.
    expect(await store.getOwnerAccountByEmail(email)).toBeNull();
    expect(store.ownerAccounts.size).toBe(0);
    // The password hash rides encrypted, never readable in the browser.
    expect(Buffer.from(cookie.split("=")[1]!.split(".")[0]!, "base64url").toString("utf8")).not.toContain("scrypt");
    const page = await (await fetch(`${baseUrl}/signup`, { headers: { cookie } })).text();
    expect(page).toContain("<h1>Set up your shop</h1>");
    expect(page).toContain(`Signing up as <b>${email}</b>.`);
    expect(page).not.toContain("Verified with");
    const done = await post(shop, cookie);
    expect(done.status).toBe(303);
    expect(done.headers.getSetCookie().some((value) => value.startsWith("afo_pending_identity=;"))).toBe(true);
    const account = (await store.getOwnerAccountByEmail(email))!;
    expect(await verifyOwnerPassword("eight-ch", account.passwordHash)).toBe(true);
    // A typed password proves nothing about the email.
    expect(account.emailVerifiedAt).toBeNull();
    const config = await store.getConfig(account.tenantId);
    expect(config.businessName).toBe("Synthetic Plumbing");
    expect(config.serviceCategories).toEqual(findTrade("plumbing")!.services);
    // They can sign in with it.
    const login = await fetch(`${baseUrl}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password: "eight-ch" }) });
    expect(login.status).toBe(303);
  });

  it("resumes on the shop screen after leaving, and 'Use a different email' starts over", async () => {
    const { cookie } = await startSignup(baseUrl);
    for (let visit = 0; visit < 2; visit += 1) expect(await (await fetch(`${baseUrl}/signup`, { headers: { cookie } })).text()).toContain("<h1>Set up your shop</h1>");
    const fresh = await fetch(`${baseUrl}/signup?fresh=1`, { redirect: "manual", headers: { cookie } });
    expect(fresh.headers.get("set-cookie")).toContain("afo_pending_identity=;");
    expect(await (await fetch(`${baseUrl}/signup`)).text()).toContain("Continue");
  });

  it("a double tap, a refresh-resubmit or Back never makes a second workspace", async () => {
    const { cookie, email } = await startSignup(baseUrl);
    const [first, second] = await Promise.all([post(shop, cookie), post(shop, cookie)]);
    expect([first.status, second.status]).toEqual([303, 303]);
    const again = await post(shop, cookie);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/app/start");
    expect([...store.ownerAccounts.values()].filter((account) => account.email === email)).toHaveLength(1);
    // Back to /signup while signed in: their shop, not a new sign-up.
    const session = first.headers.getSetCookie().find((value) => value.startsWith("afo_owner="))!.split(";")[0]!;
    const back = await fetch(`${baseUrl}/signup`, { redirect: "manual", headers: { cookie: session } });
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/app");
  });

  it("someone else's account with that email is never signed into from a pending sign-up", async () => {
    const { cookie, email } = await startSignup(baseUrl);
    // Another browser finishes a sign-up with the same email first, with its own password.
    const other = await startSignup(baseUrl, { email, password: "other-password" });
    expect((await post(shop, other.cookie)).status).toBe(303);
    const late = await post(shop, cookie);
    expect(late.status).toBe(409);
    expect(late.headers.getSetCookie().some((value) => value.startsWith("afo_owner="))).toBe(false);
    expect(await late.text()).toContain("That email already has an account.");
  });

  it("another site can't start a sign-up in this browser", async () => {
    const response = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.example" }, body: new URLSearchParams({ step: "account", email: "planted@synthetic.example", password: "synthetic-pass-1" }) });
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie().some((value) => value.startsWith("afo_pending_identity="))).toBe(false);
  });

  it("a shop screen sent after the pending sign-up ran out says so once, with no errors for unseen fields", async () => {
    const response = await post(shop);
    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain("Your sign-up timed out. Start again with Google or your email.");
    expect(page).not.toContain("Enter an email like");
    expect(page).not.toContain("Make your password at least");
    expect(store.ownerAccounts.size).toBe(0);
  });

  it("an email with no password yet opens the password box instead of an error (no-script path)", async () => {
    const response = await post({ step: "account", email: "owner@synthetic.example" });
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).not.toContain('role="alert"');
    expect(page).toMatch(/<input name="password" id="signup-password" [^>]*autofocus/);
  });

  it("passwords need 8 characters, not 12: sign-up and reset", async () => {
    expect((await post({ step: "account", email: "seven@synthetic.example", password: "seven77" })).status).toBe(400);
    expect((await post({ step: "account", email: "eight@synthetic.example", password: "eight888" })).status).toBe(303);
    const reset = (password: string) => fetch(`${baseUrl}/reset`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: "synthetic-token", password, confirm: password }) });
    expect(await (await reset("seven77")).text()).toContain("Make your password at least 8 characters.");
    // Eight passes the length check (this synthetic link is simply expired).
    expect(await (await reset("eight888")).text()).toContain("That reset link is expired or already used.");
    expect(renderResetPassword("t")).toContain('minlength="8"');
    expect(renderJoinPage("shop_x", "t", "tech@synthetic.example", "Synthetic Shop")).toContain('minlength="8"');
  });
});
