import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { COMPANY, SMS_CONSENT_VERSION } from "../src/admin/footer.js";
import { renderFounderBooking } from "../src/admin/founder.js";
import { renderForgotPassword, renderOwnerLogin, renderOwnerSignup } from "../src/admin/render.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { OWNER_CALL_CONSENT_DETAIL, OWNER_CALL_CONSENT_LABEL, OWNER_CALL_CONSENT_VERSION } from "../src/domain/owner-call-consent.js";
import { createRequestHandler } from "../src/http/app.js";

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
    for (const page of [renderOwnerSignup(), renderOwnerSignup("", {}, { verified: { email: "owner@synthetic.example", provider: "google" } })]) {
      expect(page).toContain(`<input name="ownerSmsConsent" type="checkbox" value="yes" >${SMS_OPT_IN_LABEL}</label>${SMS_OPT_IN_DISCLOSURE}`);
      expect(page).toContain(`<input name="ownerCallConsent" type="checkbox" value="yes" ><span>${OWNER_CALL_CONSENT_LABEL}</span></label><small>${OWNER_CALL_CONSENT_DETAIL}</small>`);
      // Easy to read: the disclosure is at least 13px.
      expect(page).toMatch(/\.optin small\{[^}]*font:500 13px/);
    }
  });
});

describe("public page system", () => {
  it("signup: no shrinking or clipped text, hints outside labels, e.g. placeholder, no label on a plain div", () => {
    const page = renderOwnerSignup();
    expect(page).not.toContain("3.2vw");
    expect(page).not.toContain("white-space:nowrap;line-height:1");
    expect(page).toContain('<div class="onboard-steps"><span>Step 1 of 3 · Your shop</span>');
    expect(page).toContain('<label for="signup-phone">Your mobile number</label><input name="phone" id="signup-phone"');
    expect(page).toContain('placeholder="e.g. (941) 555-0123"');
    expect(page).toMatch(/id="signup-phone" [^>]*aria-describedby="signup-phone-hint">/);
    expect(page).toContain('<span class="hint" id="signup-password-hint">At least 12 characters.</span>');
    expect(page).toMatch(/<input name="email" id="signup-email" type="email" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false"/);
    expect(page).toContain(".plan .intro{color:var(--red-strong)");
    expect(page).toContain('<main class="publicmain formpage authpage">');
  });

  it("signup: the guarantee sits with the plan above the button; only the charge and terms lines sit under it", () => {
    const plan = { id: "solo", label: "Solo", priceCents: 4_999, firstMonthCents: 2_499, includedCalls: 60, blurb: "60 answered calls a month, about 2 a day", who: "Just you", chargeNote: "Today: $24.99." };
    const page = renderOwnerSignup("", {}, { plans: [plan, { ...plan, id: "team", label: "Team" }], chargeNote: plan.chargeNote });
    const at = (text: string): number => page.indexOf(text);
    const [guarantee, button, charge, agree] = [at('<p class="guarantee">'), at("<button>Continue to card</button>"), at('<p class="charge"'), at('<p class="agree">')];
    expect(guarantee).toBeGreaterThan(at('<fieldset class="plans">'));
    expect([guarantee < button, button < charge, charge < agree]).toEqual([true, true, true]);
    expect(page.slice(button, page.indexOf("</form>")).match(/<p class="(?!charge)/g)).toEqual(['<p class="']);
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

  it("puts each problem under its field, naming the fix, keeps what was typed and focuses the first one", async () => {
    const response = await signup({ businessName: "Synthetic Air", phone: "555", email: "owner@synthetic", password: "short", trade: "hvac" });
    expect(response.status).toBe(400);
    const page = await response.text();
    // A summary at the top that links to each field.
    expect(page).toContain('<div class="formerror" role="alert" id="signup-error"><ul><li><a href="#signup-phone">Enter a 10-digit US mobile number.</a></li><li><a href="#signup-email">Enter an email like you@yourshop.com.</a></li><li><a href="#signup-password">Make your password at least 12 characters.</a></li></ul></div>');
    // Each field: its own error, aria-invalid, described by the error.
    expect(page).toMatch(/<input name="phone" id="signup-phone" [^>]*value="555" required aria-describedby="signup-phone-error signup-phone-hint" aria-invalid="true" autofocus>/);
    expect(page).toContain('<span class="fielderror" id="signup-phone-error">Enter a 10-digit US mobile number.</span>');
    expect(page).toMatch(/<input name="email" id="signup-email" [^>]*value="owner@synthetic" required aria-describedby="signup-email-error" aria-invalid="true">/);
    expect(page).toMatch(/<input name="password" id="signup-password" [^>]*aria-describedby="signup-password-error" aria-invalid="true">/);
    // Typed values stay; the password never comes back.
    expect(page).toContain('value="Synthetic Air"');
    expect(page).not.toContain('value="short"');
    expect(page).toContain('<option value="hvac" selected>');
    // The shop name was fine, so it carries no error.
    expect(page).not.toContain("signup-shop-error");
  });

  it("a one-letter shop name says how long it must be", async () => {
    const page = await (await signup({ businessName: "C", email: "owner@synthetic.example", password: "long-password-for-tests", trade: "hvac" })).text();
    expect(page).toContain('<span class="fielderror" id="signup-shop-error">Use at least 2 characters for your shop name.</span>');
  });

  it("asks for a mobile number when the text box is checked without one", async () => {
    const page = await (await signup({ businessName: "Synthetic Air", email: "owner@synthetic.example", password: "long-password-for-tests", ownerSmsConsent: "yes" })).text();
    expect(page).toContain('<span class="fielderror" id="signup-phone-error">Add your mobile number to get texts.</span>');
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
