import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setupSteps, type SetupCallFacts } from "../src/adapters/telnyx-setup-call.js";
import { renderDialHandoff } from "../src/admin/error-page.js";
import { ringFirstNext } from "../src/domain/forwarding-steps.js";
import { staleCheck } from "../web/src/lib/line-status.js";
import { carrierFamily, forwardingPlan, gsmNetwork, parseRingFirstMisses, ringFirstMissesKept, ringFirstTry, type GsmNetwork } from "../src/domain/forwarding.js";

const OTTO = "+13125550100";

describe("which GSM network a carrier name is on", () => {
  it.each([
    "T-Mobile USA, Inc.", "T-Mobile", "TMobile", "MetroPCS", "Metro by T-Mobile", "Mint Mobile", "Ultra Mobile", "Google Fi", "US Mobile",
    // Legacy names carrier lookups still return for T-Mobile numbers.
    "Aerial Communications", "Omnipoint Communications", "VoiceStream Wireless", "Powertel Memphis Licenses", "Sprint Spectrum L.P.", "Nextel Communications", "SunCom Wireless",
  ])("%s is the T-Mobile family", (name) => {
    expect(gsmNetwork(name)).toBe("tmobile");
    expect(carrierFamily(name, "mobile")).toBe("gsm");
  });

  it.each(["AT&T Mobility", "AT&T Wireless", "New Cingular Wireless PCS", "Cricket Wireless", "Consumer Cellular"])("%s is the AT&T family", (name) => {
    expect(gsmNetwork(name)).toBe("att");
    expect(carrierFamily(name, "mobile")).toBe("gsm");
  });

  it.each([null, undefined, "", "Some Regional Wireless", "Tracfone"])("%s stays generic GSM", (name) => {
    expect(gsmNetwork(name)).toBe("gsm");
  });
});

describe("the ring-first sequence", () => {
  it("T-Mobile family: **61, clear ##004#, clear ##002#, then help and nothing more", () => {
    expect(ringFirstTry("tmobile", 0)).toEqual({ code: "no_answer", clear: "##004#", retry: null });
    expect(ringFirstTry("tmobile", 1)).toEqual({ code: "no_answer", clear: "##004#", retry: "clear" });
    expect(ringFirstTry("tmobile", 2)).toEqual({ code: "no_answer", clear: "##002#", retry: "clear_again" });
    expect(ringFirstTry("tmobile", 3)).toEqual({ code: "no_answer", clear: "##002#", retry: "help" });
    expect(ringFirstTry("tmobile", 7)).toEqual({ code: "no_answer", clear: "##002#", retry: "help" });
  });

  it.each(["att", "gsm"] as GsmNetwork[])("%s: **004, clear ##002#, then Try this code instead (**61), then help", (network) => {
    expect(ringFirstTry(network, 0)).toEqual({ code: "combined", clear: "##002#", retry: null });
    expect(ringFirstTry(network, 1)).toEqual({ code: "combined", clear: "##002#", retry: "clear" });
    expect(ringFirstTry(network, 2)).toEqual({ code: "no_answer", clear: "##002#", retry: "instead" });
    expect(ringFirstTry(network, 3)).toEqual({ code: "no_answer", clear: "##002#", retry: "help" });
    expect(ringFirstTry(network, 9)).toEqual({ code: "no_answer", clear: "##002#", retry: "help" });
  });

  it("odd counts are read as no misses", () => {
    expect(ringFirstTry("att", -1).retry).toBeNull();
    expect(ringFirstTry("tmobile", Number.NaN).retry).toBeNull();
    expect(ringFirstTry("att", 1.7).retry).toBe("clear");
  });

  it("never loops: walking every miss reaches help once, and every later step is help", () => {
    for (const network of ["tmobile", "att", "gsm"] as GsmNetwork[]) {
      const retries = [0, 1, 2, 3, 4, 5].map((misses) => ringFirstTry(network, misses).retry);
      const help = retries.indexOf("help");
      expect(help).toBe(3);
      expect(retries.slice(help).every((retry) => retry === "help")).toBe(true);
      // Each step before help is a different step: no code is offered twice in a row after a miss.
      expect(new Set(retries.slice(0, help)).size).toBe(help);
    }
  });

  it("a pass starts over, except an AT&T-family line keeps the code that worked", () => {
    expect(ringFirstMissesKept("tmobile", 2)).toBe(0);
    expect(ringFirstMissesKept("tmobile", 3)).toBe(0);
    expect(ringFirstMissesKept("att", 1)).toBe(0);
    expect(ringFirstMissesKept("att", 2)).toBe(2);
    expect(ringFirstMissesKept("gsm", 3)).toBe(2);
    expect(ringFirstMissesKept("att", 0)).toBe(0);
  });

  it("reads the saved count", () => {
    expect(parseRingFirstMisses(null)).toBe(0);
    expect(parseRingFirstMisses("2")).toBe(2);
    expect(parseRingFirstMisses("junk")).toBe(0);
    expect(parseRingFirstMisses("-3")).toBe(0);
    expect(parseRingFirstMisses("50")).toBe(9);
  });
});

describe("the forwarding plan per network", () => {
  it("T-Mobile family ring first: one no-answer code, its own clear code, and the two optional extras", () => {
    const plan = forwardingPlan("gsm", OTTO, "overflow", 2, { carrierName: "Aerial Communications" });
    expect(plan).toMatchObject({ on: "**61*13125550100**10#", off: "##004#", network: "tmobile", retry: null, ringSeconds: 10, forwardsAll: false });
    expect(plan.extras).toEqual(["**67*13125550100#", "**62*13125550100#"]);
    expect(plan.dialLink).toBe("tel:%2A%2A61%2A13125550100%2A%2A10%23");
    expect(plan.offDialLink).toBe("tel:%23%23004%23");
    expect(plan.what).toBe("Your phone rings 10 seconds first. Calls you miss go to Call Otto.");
    expect(forwardingPlan("gsm", OTTO, "overflow", 4, { carrierName: "T-Mobile USA" }).on).toBe("**61*13125550100**25#");
  });

  it("T-Mobile family after misses: ##004#, then ##002#, then help; the code stays **61", () => {
    const at = (misses: number) => forwardingPlan("gsm", OTTO, "overflow", 2, { carrierName: "T-Mobile USA", misses });
    expect(at(1)).toMatchObject({ on: "**61*13125550100**10#", off: "##004#", retry: "clear" });
    expect(at(2)).toMatchObject({ on: "**61*13125550100**10#", off: "##002#", retry: "clear_again" });
    expect(at(3)).toMatchObject({ on: "**61*13125550100**10#", off: "##002#", retry: "help" });
  });

  it("every call is unchanged on every network: **21, clear ##002#, no retry, no extras", () => {
    for (const carrierName of ["T-Mobile USA", "AT&T Mobility", null]) {
      const plan = forwardingPlan("gsm", OTTO, "always", 2, { carrierName, misses: 3 });
      expect(plan).toMatchObject({ on: "**21*13125550100#", off: "##002#", retry: null, extras: [], forwardsAll: true });
    }
  });

  it("AT&T family and unknown GSM: **004 first, **61 instead after the clear step failed", () => {
    for (const carrierName of ["AT&T Mobility", "Some Regional Wireless", null]) {
      expect(forwardingPlan("gsm", OTTO, "overflow", 2, { carrierName })).toMatchObject({ on: "**004*13125550100**10#", off: "##002#", retry: null, extras: [] });
      expect(forwardingPlan("gsm", OTTO, "overflow", 2, { carrierName, misses: 1 })).toMatchObject({ on: "**004*13125550100**10#", retry: "clear" });
      const instead = forwardingPlan("gsm", OTTO, "overflow", 2, { carrierName, misses: 2 });
      expect(instead).toMatchObject({ on: "**61*13125550100**10#", off: "##002#", retry: "instead", extras: [] });
      expect(instead.what).toBe("Your phone rings 10 seconds first. Calls you miss go to Call Otto.");
      expect(forwardingPlan("gsm", OTTO, "overflow", 2, { carrierName, misses: 3 })).toMatchObject({ retry: "help" });
    }
  });

  it("without options it's the old combined code (callers that don't know the carrier)", () => {
    expect(forwardingPlan("gsm", OTTO, "overflow", 2)).toMatchObject({ on: "**004*13125550100**10#", off: "##002#" });
  });

  it("Verizon family and office lines ignore the carrier name and misses", () => {
    expect(forwardingPlan("verizon", OTTO, "overflow", 2, { carrierName: "T-Mobile USA", misses: 3 })).toMatchObject({ on: "*713125550100", off: "*73" });
    expect(forwardingPlan("verizon", OTTO, "overflow", 2, { misses: 3 }).retry).toBeUndefined();
    expect(forwardingPlan("office", OTTO, "overflow", 2, { misses: 3 })).toMatchObject({ on: null, off: null });
  });
});

describe("the phone page follows the same steps", () => {
  const base = { businessNumber: "(941) 555-0100", what: "", dialLink: null, device: "android" as const, family: "gsm" };

  it("Try this code instead: the other code, nothing to clear", () => {
    const page = renderDialHandoff({ ...base, code: "**61*13125550100**10#", retry: "instead" });
    expect(page).toContain("Try this code on (941) 555-0100");
    expect(page).toContain("That code didn’t work on this phone. Try this code instead.");
    expect(page).toContain('<div class="code">**61*13125550100**10#</div>');
  });

  it("clearing again names all forwarding", () => {
    const page = renderDialHandoff({ ...base, code: "**61*13125550100**10#", retry: "clear_again", clearFirst: { code: "##002#", dialLink: null }, nextHref: "/d/abc?step=code" });
    expect(page).toContain("Your phone still never rang. Dial this first to clear all forwarding.");
    expect(page).toContain('<div class="code">##002#</div>');
  });

  it("help: no code at all, the way to our team", () => {
    const page = renderDialHandoff({ ...base, code: "**61*13125550100**10#", retry: "help" });
    expect(page).toContain("Ring first didn’t work on this phone.");
    expect(page).toContain("Call me now");
    expect(page).not.toContain('<div class="code">');
  });
});

describe("the setup helper says the same steps", () => {
  const facts: SetupCallFacts = { businessName: "Test Shop", businessNumber: "+19415550100", carrierName: "T-Mobile USA", family: "gsm", code: "**61*13125550100**10#", offCode: "##004#", confirm: null, ottoNumber: OTTO, device: "iphone", forwardsAll: false, ringFirstCode: "**61*13125550100**10#", everyCallCode: "**21*13125550100#", ringFirstSeconds: 10 };

  it("never asks for a Decline during a timed test", () => {
    const text = setupSteps(facts).join("\n");
    expect(text).not.toContain("tap Decline");
    expect(text).toContain("they don't answer or decline it");
  });

  it("clear, instead and help follow the screen", () => {
    expect(setupSteps({ ...facts, ringFirstRetry: "clear" }).join("\n")).toContain("First they dial ##004#");
    expect(setupSteps({ ...facts, offCode: "##002#", ringFirstRetry: "clear_again" }).join("\n")).toContain("First they dial ##002#");
    expect(setupSteps({ ...facts, ringFirstRetry: "instead" }).join("\n")).toContain("Try this code instead: **61*13125550100**10#");
    const help = setupSteps({ ...facts, ringFirstRetry: "help" }).join("\n");
    expect(help).toContain("Don't give them another code.");
    expect(setupSteps(facts).join("\n")).not.toContain("Don't give them another code.");
  });

  it("offers the extras only as optional, one at a time", () => {
    const text = setupSteps({ ...facts, ringFirstExtras: ["**67*13125550100#", "**62*13125550100#"] }).join("\n");
    expect(text).toContain("it's optional. They dial **67*13125550100# (say it as:");
    expect(text).toContain("one at a time");
    expect(setupSteps({ ...facts, forwardsAll: true, ringFirstExtras: ["**67*13125550100#"] }).join("\n")).not.toContain("it's optional");
  });
});

describe("the screen's next step after a ring-first test (owner app and phone page)", () => {
  it("acts on the plan's retry only while ring first is picked and the latest test never rang", () => {
    expect(ringFirstNext({ retry: "instead", neverRang: false, everyCall: false })).toEqual({ retry: null, mayClear: true, clearByCode: false, noCodes: false });
    expect(ringFirstNext({ retry: "help", neverRang: true, everyCall: true }).retry).toBeNull();
    expect(ringFirstNext({ retry: null, neverRang: true, everyCall: false })).toEqual({ retry: null, mayClear: true, clearByCode: false, noCodes: false });
  });

  it("clear and clear again clear; clear again by code; instead and help clear nothing; help has no codes", () => {
    expect(ringFirstNext({ retry: "clear", neverRang: true, everyCall: false })).toEqual({ retry: "clear", mayClear: true, clearByCode: false, noCodes: false });
    expect(ringFirstNext({ retry: "clear_again", neverRang: true, everyCall: false })).toEqual({ retry: "clear_again", mayClear: true, clearByCode: true, noCodes: false });
    expect(ringFirstNext({ retry: "instead", neverRang: true, everyCall: false })).toEqual({ retry: "instead", mayClear: false, clearByCode: false, noCodes: false });
    expect(ringFirstNext({ retry: "help", neverRang: true, everyCall: false })).toEqual({ retry: "help", mayClear: false, clearByCode: false, noCodes: true });
  });

  it("the card uses this decision and shows the help that exists, never another code", () => {
    const card = readFileSync(new URL("../web/src/components/app/forwarding-card.tsx", import.meta.url), "utf8");
    expect(card).toContain("ringFirstNext({ retry: plan?.retry, neverRang: forwardsAll, everyCall: Boolean(plan?.forwardsAll) })");
    const help = card.slice(card.indexOf("function NoMoreCodes"), card.indexOf("function ExtraCodes"));
    expect(help).toContain("Call me now");
    expect(help).toContain("Book a time with our team");
    expect(help).not.toContain("DialCode");
    expect(card).toContain('"Try this code instead on "');
    const extras = card.slice(card.indexOf("function ExtraCodes"), card.indexOf("function extraDialLink"));
    expect(extras).toContain("Also send calls to Otto when you decline or have no signal");
    expect(extras).toContain("Optional.");
    // The extras show only after a timed ring-first pass.
    expect(card).toContain('business.lastTest?.mode === "ring-first" && business.lastTest.timed && !plan.forwardsAll && <ExtraCodes');
    // The gray-box heads-up stays on every code, extras included.
    expect(card).toContain("<p className=\"text-sm text-muted-foreground\">{afterDialLine(family, platform)}</p>");
  });
});

describe("a ring-first miss that moved the code on is still today's result", () => {
  it("is not stale while the plan carries the next step", () => {
    const line = (retry: string | null) => ({ number: "+15555550123", mode: "overflow", confirmedAt: null, check: { status: "forwards_all", choice: "ring-first", code: "**004*15555550123**10#" }, business: { everyCallOn: false, update: null, plan: { on: "**61*15555550123**10#", retry } } });
    expect(staleCheck(line("instead"))).toBe(false);
    expect(staleCheck(line("help"))).toBe(false);
    // Without a next step, a result for another code is still stale.
    expect(staleCheck(line(null))).toBe(true);
  });
});
