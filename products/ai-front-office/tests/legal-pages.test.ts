import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { planCatalog } from "../src/domain/plans.js";
import { renderMarketing, SITE_CHROME_STYLES } from "../src/admin/marketing.js";
import { renderPrivacy, renderTerms } from "../src/admin/render.js";

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_abcdefghijklmnopqrstuvwxyz",
  STRIPE_PRICE_ID_SOLO: "price_solo_synthetic", STRIPE_PRICE_ID_TEAM: "price_team_synthetic", STRIPE_PRICE_ID_FLEET: "price_fleet_synthetic",
  STRIPE_PRICE_ID_UNLIMITED_SOLO: "price_unl_solo", STRIPE_PRICE_ID_UNLIMITED_TEAM: "price_unl_team", STRIPE_PRICE_ID_UNLIMITED_FLEET: "price_unl_fleet",
  STRIPE_FIRST_MONTH_COUPON_ID: "front_office_first_month_50",
};
const config = createDemoConfig();
const pages = {
  privacy: renderPrivacy(config),
  terms: renderTerms(config, planCatalog(demoEnvironment({}))),
  termsWithOffer: renderTerms(config, planCatalog(demoEnvironment(STRIPE_ENV))),
};

/** The words a reader sees inside one element: tags out, whitespace collapsed. */
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const inside = (html: string, tag: string): string => new RegExp(`<${tag}[^>]*>([\\s\\S]*)</${tag}>`).exec(html)?.[1] ?? "";
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("Privacy and Terms: a document layout that changes no words (LEGAL-01)", () => {
  /**
   * Fingerprints of the legal text (everything inside <main>) taken from the pages as they were before the
   * layout was rebuilt (commit 8791ddb36), with this same config. A hash keeps the company address and phone
   * out of the tests. If one of these fails, a word of the legal or SMS text changed: that needs its own review.
   */
  const BEFORE = {
    privacy: { heading: "Privacy notice", words: 955, sha256: "0964512f71ea8fc0a7ef36f58d56539f9faa2c330d6b0c755ed19cda3938ee80" },
    terms: { heading: "Service terms", words: 891, sha256: "cfdc232ed8bc07923e5f85e2d4414c69e803c76291c3ae4de8d7b3aec443cad0" },
    termsWithOffer: { heading: "Service terms", words: 915, sha256: "725151d33edee36bd887a87e7c81147fa10a8bee2cd2e0237d41794e96798a6c" },
  } as const;

  it("keeps every word of both pages exactly as it was", () => {
    for (const name of ["privacy", "terms", "termsWithOffer"] as const) {
      const body = text(inside(pages[name], "main"));
      expect(text(inside(pages[name], "h1")), name).toBe(BEFORE[name].heading);
      expect(body.split(" ").length, name).toBe(BEFORE[name].words);
      expect(sha256(body), name).toBe(BEFORE[name].sha256);
    }
  });

  it("keeps the SMS and consent lines carriers review, word for word", () => {
    expect(pages.terms).toContain("Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.");
    expect(pages.privacy).toContain("Phone numbers and SMS opt-in or consent records are not sold, rented, or shared with third parties or affiliates for marketing or promotional purposes.");
  });

  it("uses the site's own top bar and footer, not the old admin page", () => {
    const home = renderMarketing(config, []);
    const footer = /<footer class="wrap">.*?<\/footer>/.exec(home)![0];
    for (const page of [pages.privacy, pages.terms]) {
      // Same links as the homepage, pointed back at it.
      expect(page).toContain('<header class="nav"><a class="brand" href="/">Call <em>Otto</em></a><nav aria-label="Main"><a href="/#compare">Why Call Otto</a><a href="/#trades">Trades</a><a href="/#pricing">Pricing</a><a class="signin" href="/login">Sign in</a><a class="button" href="/signup">Get started</a></nav></header>');
      expect(page).toContain(footer);
      expect(page).toContain('<a class="skip" href="#main">Skip to content</a>');
      expect(page.match(/<h1>/g)).toHaveLength(1);
      // No white card on a grey page, none of the admin stylesheet.
      expect(page).not.toMatch(/legalpage|legaltop|owner-app|dashboard-main/);
    }
    expect(home).toContain('<nav aria-label="Main"><a href="#compare">Why Call Otto</a>');
    expect(pages.privacy).toContain('<a href="/terms">Terms</a></header>');
    expect(pages.terms).toContain('<a href="/privacy">Privacy</a></header>');
  });

  it("draws the top bar and footer with the homepage's own rules", () => {
    const homeCss = /<style>([\s\S]*?)<\/style>/.exec(renderMarketing(config, []))![1]!;
    // The shared rules are a copy of the homepage's: these must stay word for word the same in both.
    for (const rule of [
      ":root{color-scheme:light;--blue:#064c95;--ink:#073a6d;--paper:#faf8f1;--yellow:#e9f447;--red:#df3626;--line:#ccd3cc}",
      "body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}",
      ".wrap,.nav{max-width:1200px;margin:auto;padding-inline:32px}",
      ".brand{display:inline-block;padding-block:8px;font:800 34px/1 Georgia,serif;letter-spacing:-1.8px;text-decoration:none;white-space:nowrap}",
      ".nav nav{display:flex;gap:28px;align-items:center;font-size:14px;font-weight:650}",
      ".button{display:inline-flex;justify-content:center;align-items:center;min-height:48px;padding:13px 22px;border:1.5px solid var(--ink);border-radius:6px;background:var(--yellow);text-decoration:none;font-weight:750;font-size:16px;box-shadow:3px 3px 0 var(--ink);transition:box-shadow .16s,transform .16s}",
      "footer .brand{display:inline-block;font-size:27px;padding-block:9px}",
      "footer a{min-height:44px;display:inline-flex;align-items:center}",
      ".nav nav>a:not(.button):not(.signin){display:none}",
    ]) {
      expect(SITE_CHROME_STYLES, rule).toContain(rule);
      expect(homeCss, rule).toContain(rule);
    }
    expect(pages.privacy).toContain(SITE_CHROME_STYLES);
  });

  it("lists every section in a short contents list that links to it", () => {
    for (const page of [pages.privacy, pages.terms, pages.termsWithOffer]) {
      const headings = [...inside(page, "main").matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map((match) => [match[1], match[2]]);
      const contents = [.../<nav class="legal-toc" aria-label="Contents"><p>Contents<\/p><ul>(.*?)<\/ul><\/nav>/.exec(page)![1]!.matchAll(/<li><a href="#([^"]+)">(.*?)<\/a><\/li>/g)].map((match) => [match[1], match[2]]);
      expect(headings.length).toBeGreaterThanOrEqual(10);
      expect(contents).toEqual(headings);
      expect(new Set(headings.map(([id]) => id)).size).toBe(headings.length);
      // Every heading has an id; none is left without one.
      expect(inside(page, "main")).not.toMatch(/<h2>/);
    }
    // The link other pages already use still lands on its section.
    expect(pages.privacy).toContain('<h2 id="google-calendar">Google Calendar data</h2>');
    expect(pages.terms).toContain('<h2 id="unlimited-calls-add-on">Unlimited calls add-on</h2>');
  });

  it("sets a comfortable measure and a calm type scale", () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(pages.privacy)![1]!;
    // A 37rem column holds about 70 characters of 17px text.
    expect(css).toContain(".legal{display:grid;grid-template-columns:200px minmax(0,37rem);");
    expect(css).toContain(".legal-body{grid-column:2;font-size:17px;line-height:1.65}");
    const size = (selector: string): number => Number(new RegExp(`${selector.replace(/[.]/g, "\\.")}\\{[^}]*font-size:(\\d+)px`).exec(css)![1]);
    expect(size(".legal-head h1")).toBeLessThanOrEqual(44);
    expect(size(".legal-body h2")).toBeLessThanOrEqual(22);
    expect(size(".legal-body h2")).toBeGreaterThan(17);
    // On a phone: 16px text, one column, contents above the text with 44px rows.
    expect(css).toMatch(/@media\(max-width:640px\)\{[^@]*\.legal-body\{font-size:16px\}/);
    expect(css).toContain(".legal-toc a{display:flex;align-items:center;min-height:44px;");
    expect(css).toMatch(/@media\(max-width:900px\)\{\.legal\{grid-template-columns:minmax\(0,37rem\);/);
  });
});
