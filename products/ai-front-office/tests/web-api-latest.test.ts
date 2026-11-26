import { describe, expect, it } from "vitest";
import { latestOnly } from "../web/src/lib/latest.js";

describe("dashboard reloads that overlap", () => {
  it("an older response that arrives last never overwrites the newer one (the 'Ring my phone first' snap-back)", async () => {
    const order = latestOnly();
    let shown = "always";
    const reload = async (answer: Promise<string>) => {
      const ticket = order.next();
      const value = await answer;
      if (order.isLatest(ticket)) shown = value;
    };
    let slowDone!: (value: string) => void;
    const slow = reload(new Promise((resolve) => { slowDone = resolve; })); // started before the tap saved
    const fast = reload(Promise.resolve("overflow")); // the tap's own reload
    await fast;
    slowDone("always");
    await slow;
    expect(shown).toBe("overflow");
  });
});
