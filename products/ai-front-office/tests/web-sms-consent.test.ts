import { describe, expect, it } from "vitest";
import { SMS_CONSENT_END, SMS_CONSENT_JOIN, SMS_CONSENT_LEAD, SMS_CONSENT_PRIVACY, SMS_CONSENT_TERMS } from "../web/src/lib/sms-consent.js";
import { SMS_CONSENT_VERSION } from "../src/admin/footer.js";

/** The text-alert consent label exactly as the old /app/setup page rendered it (its HTML, entities and links). */
const SETUP_PAGE_LABEL = `Text me account notifications from Call Otto by Dutchworks LLC, like new-call and urgent-call notifications. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase. We will not share mobile information with third parties for promotional or marketing purposes. See <a href="/terms">Terms</a> and <a href="/privacy">Privacy</a>.`;

describe("text-alert consent in Settings › Alerts", () => {
  it("is byte-identical to the setup page's wording, links included, under the same consent version", () => {
    const escape = (value: string) => value.replaceAll("&", "&amp;");
    const rebuilt = `${escape(SMS_CONSENT_LEAD)}<a href="${SMS_CONSENT_TERMS.href}">${SMS_CONSENT_TERMS.label}</a>${SMS_CONSENT_JOIN}<a href="${SMS_CONSENT_PRIVACY.href}">${SMS_CONSENT_PRIVACY.label}</a>${SMS_CONSENT_END}`;
    expect(rebuilt).toBe(SETUP_PAGE_LABEL);
    expect(SMS_CONSENT_VERSION).toBe("2026-11-23.2");
  });
});
