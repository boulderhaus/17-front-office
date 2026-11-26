import { describe, expect, it } from "vitest";
import { forwardingOn, lineStatus, staleCheck, type LineStatusInput } from "../web/src/lib/line-status.js";

const base: LineStatusInput = {
  preview: false,
  viewer: { status: "active" },
  shop: { paused: false, pausedForBilling: false },
  line: { number: "+19415550100", mode: "always", confirmedAt: null, check: { status: "idle" }, business: { everyCallOn: false, update: null, plan: { on: "*72 941 555 0100" } } },
};
const withLine = (line: Partial<NonNullable<LineStatusInput["line"]>>): LineStatusInput => ({ ...base, line: { ...base.line!, ...line } });

describe("the line's status in the menu and on Calls", () => {
  it("never says answering before a test proved forwarding: amber, Not getting calls yet, Finish forwarding", () => {
    const status = lineStatus(base);
    expect(status).toMatchObject({ tone: "pending", label: "Not getting calls yet", detail: "Finish forwarding.", to: "/app/start?step=forward" });
    // Every-call picked but untested is still not getting calls.
    expect(lineStatus(withLine({ mode: "always" })).label).toBe("Not getting calls yet");
  });

  it("a failed last test is not forwarding either", () => {
    expect(lineStatus(withLine({ confirmedAt: "2026-11-25T10:00:00Z", check: { status: "not_reached" } })).label).toBe("Not getting calls yet");
  });

  it("after a passed every-call test: Answering every call", () => {
    const status = lineStatus(withLine({ confirmedAt: "2026-11-25T10:00:00Z", check: { status: "passed" }, business: { everyCallOn: true, update: null, plan: { on: "*72" } } }));
    expect(status).toMatchObject({ tone: "on", label: "Answering every call" });
  });

  it("after a passed ring-first test: Answering calls you miss", () => {
    const status = lineStatus(withLine({ mode: "overflow", confirmedAt: "2026-11-25T10:00:00Z", check: { status: "passed" }, business: { everyCallOn: false, update: null, plan: { on: "*71" } } }));
    expect(status).toMatchObject({ tone: "on", label: "Answering calls you miss" });
  });

  it("a changed choice whose new code isn't dialed yet: Dial your new code", () => {
    const status = lineStatus(withLine({ confirmedAt: "2026-11-25T10:00:00Z", check: { status: "passed" }, business: { everyCallOn: false, update: { clearFirst: null, leavingEveryCall: false }, plan: { on: "*72" } } }));
    expect(status).toMatchObject({ tone: "pending", label: "Dial your new code", to: "/app/start?step=forward" });
  });

  it("calls reach Otto but not the way the owner picked: Dial your new code, never Not getting calls yet", () => {
    const forwardsAll = lineStatus(withLine({ mode: "overflow", confirmedAt: "2026-11-25T10:00:00Z", check: { status: "forwards_all", choice: "ring-first", code: "*71" }, business: { everyCallOn: false, update: null, plan: { on: "*71" } } }));
    expect(forwardsAll).toMatchObject({ tone: "pending", label: "Dial your new code", detail: "Every call goes to Otto until you do.", to: "/app/start?step=forward" });
    const ringsFirst = lineStatus(withLine({ mode: "always", confirmedAt: "2026-11-25T10:00:00Z", check: { status: "rings_first", choice: "every-call", code: "*72 941 555 0100" } }));
    expect(ringsFirst).toMatchObject({ tone: "pending", label: "Dial your new code", detail: "Your phone still rings first." });
  });

  it("billing, pause, setup and the demo keep their own words", () => {
    expect(lineStatus({ ...base, viewer: { status: "pending_activation" } }).label).toBe("Setting up your line");
    expect(lineStatus({ ...base, shop: { paused: true, pausedForBilling: true } }).label).toBe("Paused for billing");
    expect(lineStatus({ ...base, shop: { paused: true, pausedForBilling: false } }).label).toBe("Answering paused");
    expect(lineStatus(withLine({ number: null })).label).toBe("Setting up your line");
    expect(lineStatus({ ...base, preview: true }).tone).toBe("on");
  });

  it("a finished test for another choice or code is stale: not shown, not a failure", () => {
    const failedForRingFirst = withLine({ mode: "always", confirmedAt: "2026-11-25T10:00:00Z", check: { status: "not_reached", choice: "ring-first", code: "*71" } }).line!;
    expect(staleCheck(failedForRingFirst)).toBe(true);
    expect(forwardingOn(failedForRingFirst)).toBe(true);
    const failedForToday = withLine({ mode: "always", confirmedAt: "2026-11-25T10:00:00Z", check: { status: "not_reached", choice: "every-call", code: "*72 941 555 0100" } }).line!;
    expect(staleCheck(failedForToday)).toBe(false);
    expect(forwardingOn(failedForToday)).toBe(false);
    // Tests from before choices were recorded are never stale.
    expect(staleCheck(withLine({ check: { status: "not_reached" } }).line!)).toBe(false);
  });
});
