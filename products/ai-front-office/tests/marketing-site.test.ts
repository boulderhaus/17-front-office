import { describe, expect, it } from "vitest";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { planCatalog } from "../src/domain/plans.js";
import { renderMarketing } from "../src/admin/marketing.js";

/** The homepage as ads will land on it: three plans, the limited-time first month, no reviews. */
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_abcdefghijklmnopqrstuvwxyz",
  STRIPE_PRICE_ID_SOLO: "price_solo_synthetic", STRIPE_PRICE_ID_TEAM: "price_team_synthetic", STRIPE_PRICE_ID_FLEET: "price_fleet_synthetic",
  STRIPE_PRICE_ID_UNLIMITED_SOLO: "price_unl_solo", STRIPE_PRICE_ID_UNLIMITED_TEAM: "price_unl_team", STRIPE_PRICE_ID_UNLIMITED_FLEET: "price_unl_fleet",
};
const config = createDemoConfig();
const withOffer = renderMarketing(config, [], { plans: planCatalog(demoEnvironment({ ...STRIPE_ENV, STRIPE_FIRST_MONTH_COUPON_ID: "front_office_first_month_50" })) });
const noOffer = renderMarketing(config, [], { plans: planCatalog(demoEnvironment({})) });
const css = /<style>([\s\S]*?)<\/style>/.exec(withOffer)![1]!;
const text = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
/** One section of the page, by its opening tag. */
const section = (html: string, open: string): string => {
  const start = html.indexOf(open);
  expect(start, open).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
};
/** The rules inside the reduced-motion block that also resets the example call. */
const reducedMotion = /@media\(prefers-reduced-motion:reduce\)\{(html\{scroll-behavior:auto\}[^@]*)\}\n/.exec(css)![1]!;

describe("homepage hero motion", () => {
  it("keeps the example call cycling through all four frames, three seconds each (SITE-01)", () => {
    expect(css).toContain(".frame{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:6px;opacity:0;animation:demoFrame 12s infinite both}");
    expect(css).toContain(".f2{animation-delay:3s}.f3{animation-delay:6s}.f4{animation-delay:9s}");
    // No frame is left holding once the others are done.
    expect(css).not.toContain("demoLast");
    expect(css).not.toMatch(/animation:demoFrame[^;}]* 1 both/);
    expect(css).toContain("@keyframes demoFrame{0%{opacity:0;transform:translateY(8px)}2.5%,22.5%{opacity:1;transform:none}25%,100%{opacity:0;transform:translateY(-6px)}}");
    expect(withOffer.match(/class="frame f[1-4]"/g)).toHaveLength(4);
  });

  it("scrolls the blue ribbon as a seamless marquee (SITE-02)", () => {
    const ribbon = /<div class="ribbon"[^>]*><div class="ribbon-track">(.*?)<\/div><\/div>/.exec(withOffer)![1]!;
    const phrases = ribbon.match(/YOUR NUMBER\. YOUR HOURS\. YOUR RULES\./g) ?? [];
    // Two identical halves, so sliding the track left by half its width loops with no jump.
    expect(phrases.length).toBeGreaterThanOrEqual(12);
    expect(phrases.length % 2).toBe(0);
    expect(ribbon.match(/aria-hidden="true"/g)).toHaveLength(phrases.length - 1);
    expect(css).toContain(".ribbon-track{display:flex;width:max-content;animation:ribbon 60s linear infinite}");
    expect(css).toContain("@keyframes ribbon{to{transform:translateX(-50%)}}");
    // Spacing is on each phrase, not a flex gap, or half the track would not be a whole number of phrases.
    expect(css).toMatch(/\.ribbon span\{flex:none;padding-right:42px\}/);
    expect(css).not.toMatch(/\.ribbon-track\{[^}]*gap:/);
  });

  it("makes Otto blink now and then (SITE-19)", () => {
    expect(withOffer).toMatch(/<span class="otto"><img src="\/assets\/front-office-mascot-flat\.png\?v=2"[^>]*><svg class="otto-blink" viewBox="0 0 852 900" aria-hidden="true">/);
    // Two lids, one over each eye of the artwork, drop from the top; the shut-eye line shows only while they are down.
    expect(withOffer.match(/<ellipse cx="(362|483)" cy="340" rx="24" ry="26"\/>/g)).toHaveLength(2);
    expect(css).toContain(".otto-blink ellipse{fill:#fcebd0;transform-box:fill-box;transform-origin:50% 0;transform:scaleY(0);animation:ottoLid 7s infinite}");
    expect(css).toMatch(/\.otto-blink path\{[^}]*opacity:0;animation:ottoBlink 7s infinite\}/);
    // Eyes are open for most of the loop: one blink, then a double blink.
    const lid = /@keyframes ottoLid\{([^@]*)\}\n/.exec(css)![1]!;
    expect(lid).toBe("0%,41%,46%,87%,91.5%,96%,100%{transform:scaleY(0)}42.5%,44.5%,88.5%,90%,93%,94.5%{transform:scaleY(1)}");
  });

  it("animates only opacity and transform, and stops all of it for reduced motion", () => {
    const keyframes = [...css.matchAll(/@keyframes (\w+)\{((?:[^{}]*\{[^{}]*\})*)\}/g)];
    expect(keyframes.map((match) => match[1]).sort()).toEqual(["demoDot", "demoFrame", "demoRing", "faqOpen", "ottoBlink", "ottoLid", "ribbon"]);
    for (const [, name, body] of keyframes) {
      const properties = [...body!.matchAll(/\{([^{}]*)\}/g)].flatMap((step) => step[1]!.split(";").filter(Boolean).map((declaration) => declaration.split(":")[0]));
      expect(properties.every((property) => property === "opacity" || property === "transform"), `${name}: ${properties.join(",")}`).toBe(true);
    }
    for (const rule of [".frame{position:static;opacity:1;animation:none;transform:none}", ".ring{animation:none}", ".demo-dots{display:none}", ".ribbon-track{width:auto;justify-content:center;animation:none}", ".ribbon span+span{display:none}", ".otto-blink{display:none}", ".faq details::details-content{transition:none}"]) expect(reducedMotion).toContain(rule);
    expect(css).not.toMatch(/transition:all/);
  });
});

describe("homepage trades and steps", () => {
  it("shows every trade name short enough for one line on a phone (SITE-03)", () => {
    const names = [...section(withOffer, '<section class="wrap section trades"').matchAll(/<a class="trade" href="\/signup\?trade=(\w+)">.*?<strong>(.*?)<\/strong>/g)].map((match) => match[2]!.replace(/&#38;/g, "&"));
    expect(names).toEqual(["Heating & air", "Plumbing", "Electrical", "Roofing", "Contractors", "Water damage", "Garage doors", "Handyman", "Landscaping", "Pest control", "Locksmith", "Appliances", "Something else?"]);
    for (const name of names.slice(0, -1)) expect(name.length, name).toBeLessThanOrEqual(13);
    // And the phone layout never wraps a name.
    expect(css).toContain(".trade strong{font-size:15px;margin:0;white-space:nowrap}");
  });

  it("lines up the urgent words across cards whatever the quote length (SITE-15)", () => {
    // Each tile shares the grid's rows (icon, name, quote, urgent words), so a one-line quote cannot pull its card's words up.
    expect(css).toContain("@supports(grid-template-rows:subgrid){@media(min-width:641px){.trade-grid>li:not(.trade-other){display:grid;grid-row:span 4;grid-template-rows:subgrid;row-gap:0}.trade-grid>li:not(.trade-other) .trade{grid-row:1/-1;grid-template-rows:subgrid;row-gap:8px}");
    // Browsers without subgrid keep two lines for every quote.
    expect(css).toContain(".trade q{font:italic 500 16px/1.35 Georgia,serif;min-height:2.7em}");
  });

  it("never says you pick a trade at signup (SITE-21)", () => {
    for (const page of [withOffer, noOffer]) {
      expect(text(page)).not.toMatch(/pick your trade|choose your trade|your trade, your mobile/i);
      expect(page).toContain("<p>Shop name, your mobile and email. About a minute.</p>");
      expect(page).toContain("<p>Otto listens for your trade’s emergency words. Change them anytime in Settings.</p>");
    }
  });

  it("keeps the rule above step 3 on a phone (SITE-04)", () => {
    expect(css).toContain(".setup li{border-bottom:0!important;border-top:2px solid var(--blue);padding:22px 0 0!important;margin:0!important}");
    // The phone layout used to wipe the last step's border.
    expect(css).not.toMatch(/\.setup li:last-child\{[^}]*border:0/);
    expect(section(withOffer, '<section class="setup wrap section"').match(/<li>/g)).toHaveLength(3);
  });
});

describe("homepage pricing", () => {
  const pricing = section(withOffer, '<section class="price-section" id="pricing"');

  it("puts the plans first and Unlimited below them in its own add-on box (SITE-05)", () => {
    const plans = pricing.indexOf('<ul class="plan-list"');
    const lastPlan = pricing.lastIndexOf('class="plan-row');
    const addOn = pricing.indexOf('<div class="addon">');
    expect(plans).toBeGreaterThan(-1);
    expect(addOn).toBeGreaterThan(lastPlan);
    expect(pricing.indexOf('id="unlimited-toggle"')).toBeGreaterThan(addOn);
    expect(pricing).toContain('<div class="addon"><span class="addon-tag">Add-on</span><div class="unl-toggle">');
    // Three equal cards in one row on desktop, stacked on a phone.
    expect(css).toContain(".plan-list{list-style:none;margin:36px 0 0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}");
    expect(css).toMatch(/@media\(max-width:640px\)\{\.plan-list\{grid-template-columns:1fr;/);
    expect(pricing.match(/<a class="plan-row std"/g)).toHaveLength(3);
  });

  it("shows the price they pay now big, with the full price struck through next to it (SITE-06)", () => {
    for (const [plan, now, full] of [["solo", "$24.99", "$49.99"], ["team", "$89.99", "$179.99"], ["fleet", "$174.99", "$349.99"]]) {
      expect(pricing).toContain(`href="/signup?plan=${plan}">`);
      expect(pricing).toContain(`<span class="plan-price"><b>${now}</b><s><span class="vh">Regular price </span>${full}</s><small>first month, then ${full}/mo</small></span>`);
    }
    const size = (selector: string): number => Number(new RegExp(`${selector.replace(/[.]/g, "\\.")}\\{font-size:(\\d+)px`).exec(css)![1]);
    expect(size(".plan-price b")).toBeGreaterThanOrEqual(size(".plan-price s") * 2);
    expect(css).toMatch(/\.plan-price s\{[^}]*text-decoration-thickness/);
    // Nothing is struck through when there is no offer: the one price is the price.
    const plain = section(noOffer, '<section class="price-section" id="pricing"');
    expect(plain).not.toContain("<s>");
    expect(plain).toContain('<span class="plan-price"><b>$49.99</b><i>/mo</i></span>');
    // The hero leads with what they pay now too.
    expect(withOffer).toContain('<p class="hero-price"><strong>$24.99 first month</strong>, then $49.99/month · Keep your number</p>');
    expect(noOffer).toContain('<p class="hero-price"><strong>$49.99/month</strong> · Keep your number</p>');
  });

  it("marks Solo with a Start here badge on its name row (SITE-07) and calls it one person (SITE-08)", () => {
    expect(pricing).toContain('<span class="plan-name"><strong>Solo</strong><i class="plan-tag">Start here</i><small>One person</small></span>');
    // Once per Solo card (standard and Unlimited), never on Team or Fleet.
    expect(pricing.match(/Start here/g)).toHaveLength(2);
    expect(css).toMatch(/\.plan-tag,\.addon-tag\{[^}]*white-space:nowrap\}/);
    expect(text(withOffer)).not.toMatch(/one truck/i);
    for (const who of ["About 5 people", "About 10 people"]) expect(pricing).toContain(`<small>${who}</small>`);
  });

  it("shows three short notes in one row, an icon each, and no red rail (SITE-09)", () => {
    const notes = /<ul class="perks">(.*?)<\/ul>/.exec(pricing)![1]!;
    const items = [...notes.matchAll(/<li><svg[^>]*aria-hidden="true">.*?<\/svg><span><strong>(.*?)<\/strong><span>(.*?)<\/span><\/span><\/li>/g)].map((match) => [match[1], match[2]]);
    expect(items).toEqual([
      ["Limited time", "First month half off, every plan."],
      ["Lead guarantee", "No real lead in your first 30 days? We refund your first month."],
      ["One plan, whole team", "Your plan’s monthly calls are shared by your whole team."],
    ]);
    for (const [, line] of items) expect(line!.length).toBeLessThanOrEqual(64);
    expect(css).not.toMatch(/\.perks[^{]*\{[^}]*border-left/);
    expect(css).not.toMatch(/\.perks li\{[^}]*background/);
    // Without the offer there is no limited-time note.
    expect(/<ul class="perks">(.*?)<\/ul>/.exec(noOffer)![1]!.match(/<li>/g)).toHaveLength(2);
  });

  it("says the plan's calls are shared by the team, never that teammates are free (SITE-10)", () => {
    for (const page of [withOffer, noOffer]) {
      expect(text(page)).not.toMatch(/team members? (are )?free|teammates? (are )?(always )?free|at no charge|per seat/i);
      expect(page).toContain("Your plan’s monthly calls are shared by your whole team.");
    }
  });

  it("keeps every covered line short enough for one line on a phone (SITE-11)", () => {
    const lines = [.../<div class="included"><h3>The whole call, covered\.<\/h3><ul>(.*?)<\/ul>/.exec(pricing)![1]!.matchAll(/<li>(.*?)<\/li>/g)].map((match) => match[1]!);
    expect(lines).toHaveLength(8);
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(40);
    expect(lines).toContain("A phone alert for every new lead");
    // Texts are promised only once they are live.
    expect(text(withOffer)).not.toMatch(/\btext for (each|every)\b/i);
    expect(renderMarketing(config, [], { plans: planCatalog(demoEnvironment({})), textsLive: true })).toContain("<li>A phone alert and a text for each lead</li>");
  });

  it("explains extra calls in one sentence (SITE-12)", () => {
    const extras = /<div class="extras"><strong>Only add what you’ll use\.<\/strong><p>(.*?)<\/p><\/div>/.exec(pricing)![1]!;
    const standard = /<span class="std">(.*?)<\/span>/.exec(extras)![1]!;
    expect(standard).toBe("Past your plan’s calls, each extra call is&nbsp;75¢.");
    expect(standard.match(/[.!?](\s|$)/g)).toHaveLength(1);
    expect(/<span class="unl">(.*?)<\/span>/.exec(extras)![1]!.match(/[.!?](\s|$)/g)).toHaveLength(1);
  });

  it("is one column of plans, add-on, notes and the covered list, with far fewer words (SITE-16)", () => {
    // The old two-column grid put three white boxes beside the plan rows.
    expect(css).not.toContain(".price-grid");
    expect(withOffer).not.toContain('class="wrap price-grid"');
    const order = ['<ul class="plan-list"', '<div class="addon">', '<ul class="perks">', '<p class="price-caption">', '<div class="included">'].map((part) => pricing.indexOf(part));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // What a visitor reads with the Unlimited switch off: it was 289 words before the rebuild.
    const read = text(pricing.replace(/<a class="plan-row unl".*?<\/a>/g, "").replace(/<span class="unl">.*?<\/span>/g, "").replace(/<span class="fair">.*?<\/span>/g, "")).trim().split(" ").length;
    expect(read).toBeLessThanOrEqual(215);
  });
});

describe("homepage math, compare and FAQ", () => {
  it("makes the shop's math one visual point with real numbers (SITE-13)", () => {
    const math = section(withOffer, '<section class="wrap section math"');
    // One flowing headline, no forced break between its two styles.
    expect(math).toContain("<h2>One new paying customer <em>can cover the month.</em></h2>");
    expect([...math.matchAll(/<li><b>(.*?)<\/b><span>(.*?)<\/span><\/li>/g)].map((match) => `${match[1]} ${match[2]!.replace(/&nbsp;/g, " ")}`)).toEqual(["3 calls a week", "1 in 10 becomes a job", "$100 from that one job"]);
    expect(math).toContain('<span class="math-otto" style="width:50%"><small>Otto’s month</small><b>$49.99</b></span><span class="math-kept"><small>Left over</small><b>$50.01</b></span>');
    expect(text(math)).toContain("Get more than a few calls a week?");
    expect(text(withOffer)).not.toMatch(/number that matters|size of the invoice|25% conversion|profit calculator/i);
    // Left-aligned, two columns on desktop: never a centered wall of text.
    expect(css).not.toMatch(/\.math\{[^}]*text-align:center/);
    expect(css).toContain(".math{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:72px;align-items:center}");
    // The claim is only made while one $100 job really covers the month.
    const pricey = renderMarketing({ ...config, flatMonthlyPriceCents: 12_900 }, []);
    expect(pricey).not.toContain('class="math-figure"');
    expect(pricey).not.toContain("can cover the month");
  });

  it("shows the Full office suite column on a phone, scrolling inside the table with a cue (SITE-14)", () => {
    const compare = section(withOffer, '<section class="wrap section" id="compare"');
    expect(compare).toContain('<p class="compare-hint" aria-hidden="true">Swipe to compare <span>&rarr;</span></p><div class="comparison-scroll" role="region" aria-label="Comparison table" tabindex="0"><div class="comparison" role="table"');
    expect(compare.match(/role="columnheader"/g)).toHaveLength(4);
    // The phone layout used to drop the last column.
    expect(css).not.toMatch(/\.comparison-row>:last-child\{display:none\}/);
    const phone = /@media\(max-width:640px\)\{body\{font-size:16px\}(.*)\n/.exec(css)![1]!;
    // It scrolls inside its own box and comes to rest on a column edge, never mid-word under the pinned first column.
    expect(phone).toContain(".comparison-scroll{margin:0 -20px 0 0;padding-right:20px;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x mandatory;scroll-padding-left:112px}");
    expect(phone).toContain(".comparison-row{grid-template-columns:112px 104px 120px 132px;font-size:14px}");
    expect(phone).toContain(".compare-hint{display:block;");
    expect(phone).toContain(".comparison-row>:first-child{position:sticky;left:0;");
    // On wider screens all four columns fit, so there is no cue.
    expect(css).toContain(".compare-hint{display:none}");
  });

  it("opens and closes FAQ rows with a short transition (SITE-17)", () => {
    const faq = section(withOffer, '<section class="wrap section faq" id="faq"');
    expect(faq.match(/<details><summary>[^<]+<\/summary><div class="faq-a"><p>/g)).toHaveLength(7);
    expect(css).toContain("@supports selector(::details-content){.faq details::details-content{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .28s ease,opacity .28s ease,content-visibility .28s allow-discrete}.faq details[open]::details-content{grid-template-rows:1fr;opacity:1}.faq-a{min-height:0;overflow:hidden}}");
    // Older browsers still ease the answer in.
    expect(css).toContain("@supports not selector(::details-content){.faq details[open] .faq-a{animation:faqOpen .28s ease}}");
  });
});

describe("homepage on the narrowest phones (320px)", () => {
  it("keeps the headline to two lines and hangs wrapped check lines under their text", () => {
    const narrow = /@media\(max-width:359px\)\{\.plan-price b\{font-size:34px\}(.*)\}\n/.exec(css)![1]!;
    expect(narrow).toContain(".hero h1{font-size:52px}");
    // The three math steps stack as rows, the trades go to one column, the add-on label never wraps beside its switch.
    expect(narrow).toContain(".math-steps{grid-template-columns:1fr;gap:10px}");
    expect(narrow).toContain(".addon{grid-template-columns:1fr;justify-items:start}");
    expect(css).toContain("@media(max-width:359px){.trade-grid{grid-template-columns:1fr}}");
    expect(css).toContain(".trust li{position:relative;padding-left:21px;text-wrap:balance}.trust li:before{content:'✓';position:absolute;left:0}");
  });
});

describe("homepage links", () => {
  it("has no way into the demo account (SITE-18)", () => {
    for (const page of [withOffer, noOffer, renderMarketing(config)]) {
      expect(page).not.toMatch(/href="\/demo/);
      expect(text(page)).not.toMatch(/look inside|dashboard demo/i);
    }
  });

  it("keeps a 44px tap target on the brand link, with the space in its name, and loads no inline script", () => {
    // 28px type on a phone plus 8px above and below. Never a flex box: that swallows the space in "Call Otto".
    expect(css).toContain(".brand{display:inline-block;padding-block:8px;font:800 34px/1 Georgia,serif;");
    expect(css).toContain("footer .brand{display:inline-block;font-size:27px;padding-block:9px}");
    expect(withOffer.match(/<a class="brand" href="\/">Call <em>Otto<\/em><\/a>/g)).toHaveLength(2);
    expect(withOffer).not.toMatch(/<script(?![^>]*src=)/);
    // Strict CSP (img-src 'self'): icons are inline SVG, never a data: image.
    expect(withOffer).not.toMatch(/url\(\s*["']?data:/);
  });
});
