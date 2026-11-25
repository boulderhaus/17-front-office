import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { COMPANY, SMS_CONSENT_VERSION } from "../src/admin/footer.js";
import { renderFounderBooking } from "../src/admin/founder.js";
import { renderOwnerSignup } from "../src/admin/render.js";
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

  it("the founder booking page is the same narrow page, with the strong red buttons", () => {
    const slots = [{ start: "2026-11-30T15:00:00Z", end: "2026-11-30T15:10:00Z" }];
    const pick = renderFounderBooking({ state: "pick", token: "t", businessName: "Synthetic Air", timeZone: "America/Chicago", slots });
    expect(pick).toContain('<main class="publicmain formpage authpage">');
    expect(pick).toContain('<div class="slotday" role="group" aria-labelledby="day-0"><h2 id="day-0">');
    expect(pick).toContain("--red-strong:#b42318");
    const booked = renderFounderBooking({ state: "booked", slot: slots[0]!, timeZone: "America/Chicago", callNumber: "(941) 555-0199", justBooked: true });
    expect(booked).toContain('<span class="nowrap">(941) 555-0199</span>');
    expect(booked).not.toContain('style="white-space:nowrap"');
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

  it("asks for a mobile number when the text box is checked without one", async () => {
    const page = await (await signup({ businessName: "Synthetic Air", email: "owner@synthetic.example", password: "long-password-for-tests", ownerSmsConsent: "yes" })).text();
    expect(page).toContain('<span class="fielderror" id="signup-phone-error">Add your mobile number to get texts.</span>');
  });

  it("an email that already has an account says so under the email field", async () => {
    const fields = { businessName: "Synthetic Air", email: "taken@synthetic.example", password: "long-password-for-tests", trade: "hvac" };
    expect((await signup(fields)).status).toBe(303);
    const again = await signup(fields);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('<span class="fielderror" id="signup-email-error">That email already has an account. Sign in instead.</span>');
  });
});
