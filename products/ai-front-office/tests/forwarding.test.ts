import { describe, expect, it } from "vitest";
import { carrierFamily, forwardingOffInstruction, forwardingPlan } from "../src/domain/forwarding.js";

describe("carrier family from a number lookup", () => {
  it.each([
    ["Verizon Wireless", "mobile", "verizon"],
    ["Cellco Partnership dba Verizon Wireless", "mobile", "verizon"],
    ["Xfinity Mobile", "mobile", "verizon"],
    ["AT&T Mobility", "mobile", "gsm"],
    ["New Cingular Wireless PCS", "mobile", "gsm"],
    ["T-Mobile USA", "mobile", "gsm"],
    ["Cricket Wireless", "mobile", "gsm"],
    ["Comcast IP Phone", "voip", "office"],
    ["Verizon Business", "fixed line", "office"],
    ["Some Regional Wireless", "mobile", "unknown"],
    [null, null, "unknown"],
  ])("%s / %s → %s", (name, type, family) => {
    expect(carrierFamily(name, type)).toBe(family);
  });
});

describe("one code per phone company", () => {
  it("always-forward uses the unconditional codes", () => {
    expect(forwardingPlan("verizon", "+19415550123", "always").on).toBe("*729415550123");
    expect(forwardingPlan("gsm", "+19415550123", "always")).toMatchObject({ on: "**21*19415550123#", off: "##002#" });
  });
  it("office lines get portal steps and human help, never a code", () => {
    const plan = forwardingPlan("office", "+19415550123", "overflow");
    expect(plan.on).toBeNull();
    expect(plan.what).toContain("(941) 555-0123");
  });
  it("the off instruction names the exact code when we know the carrier", () => {
    expect(forwardingOffInstruction("verizon")).toContain("*73");
    expect(forwardingOffInstruction("gsm")).toContain("##002#");
    expect(forwardingOffInstruction(null)).toContain("*73");
  });
});
