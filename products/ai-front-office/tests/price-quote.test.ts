import { describe, expect, it } from "vitest";
import { demoEnvironment } from "../src/config/environment.js";
import { addOneMonth, DEFAULT_PLANS, oneMonthBefore, monthlyCents, planCatalog, priceQuote, prorationEstimateCents } from "../src/domain/plans.js";

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_abcdefghijklmnopqrstuvwxyz",
  STRIPE_PRICE_ID_SOLO: "price_solo_synthetic", STRIPE_PRICE_ID_TEAM: "price_team_synthetic", STRIPE_PRICE_ID_FLEET: "price_fleet_synthetic",
  STRIPE_PRICE_ID_UNLIMITED_SOLO: "price_unl_solo", STRIPE_PRICE_ID_UNLIMITED_TEAM: "price_unl_team", STRIPE_PRICE_ID_UNLIMITED_FLEET: "price_unl_fleet",
};
const now = new Date("2026-11-26T15:00:00.000Z");
const withOffer = planCatalog(demoEnvironment({ ...STRIPE_ENV, STRIPE_FIRST_MONTH_COUPON_ID: "front_office_first_month_50" }));
const noOffer = planCatalog(demoEnvironment({ ...STRIPE_ENV, STRIPE_FIRST_MONTH_COUPON_ID: "front_office_first_month_50", FIRST_MONTH_OFFER_ENABLED: "false" }));

describe("priceQuote: one price for every summary", () => {
  // [plan, unlimited, today, monthly] with the half-off first month.
  const offerTable: Array<[string, boolean, number, number]> = [
    ["solo", false, 2_499, 4_999], ["solo", true, 4_999, 9_999],
    ["team", false, 7_499, 14_999], ["team", true, 11_249, 22_499],
    ["fleet", false, 17_499, 34_999], ["fleet", true, 23_749, 47_499],
  ];
  it.each(offerTable)("%s with Unlimited %s: today %i, struck-through full price, then %i a month", (id, unlimited, today, monthly) => {
    const plan = withOffer.find((item) => item.id === id)!;
    expect(priceQuote({ plan, unlimited, now })).toEqual({ todayCents: today, monthlyCents: monthly, strikeCents: monthly, renewsAt: "2026-12-26T15:00:00.000Z" });
    expect(monthlyCents(plan, unlimited)).toBe(monthly);
  });

  it.each(offerTable)("%s with Unlimited %s and no offer: today is the full price, nothing struck through", (id, unlimited, _today, monthly) => {
    const plan = noOffer.find((item) => item.id === id)!;
    expect(priceQuote({ plan, unlimited, now })).toEqual({ todayCents: monthly, monthlyCents: monthly, strikeCents: null, renewsAt: "2026-12-26T15:00:00.000Z" });
  });

  it("charges nothing today during a free trial and renews when it ends", () => {
    const plan = noOffer[0]!;
    expect(priceQuote({ plan, unlimited: true, now, trialDays: 7 })).toEqual({ todayCents: 0, monthlyCents: 9_999, strikeCents: null, renewsAt: "2026-12-03T15:00:00.000Z" });
  });

  it("ignores Unlimited where the plan has no add-on", () => {
    const plan = { ...withOffer[0]!, unlimited: null };
    expect(priceQuote({ plan, unlimited: true, now }).monthlyCents).toBe(4_999);
  });

  it("renews one calendar month later, clamped to the month's end", () => {
    expect(addOneMonth(new Date("2027-01-31T12:00:00.000Z")).toISOString()).toBe("2027-02-28T12:00:00.000Z");
    expect(addOneMonth(new Date("2026-12-15T12:00:00.000Z")).toISOString()).toBe("2027-01-15T12:00:00.000Z");
    expect(oneMonthBefore(new Date("2026-12-26T14:00:00.000Z")).toISOString()).toBe("2026-11-26T14:00:00.000Z");
    expect(oneMonthBefore(new Date("2027-03-31T12:00:00.000Z")).toISOString()).toBe("2027-02-28T12:00:00.000Z");
  });

  it("says one person for Solo, never one truck", () => {
    expect(DEFAULT_PLANS.solo.who).toBe("One person");
    expect(withOffer.map((plan) => plan.who).join(" ")).not.toMatch(/truck/i);
  });
});

describe("prorationEstimateCents: the local stand-in when Stripe's preview is refused", () => {
  const periodStart = new Date("2026-11-26T15:00:00.000Z");
  const periodEnd = new Date("2026-12-26T15:00:00.000Z");
  it("charges the share of the period left and credits a removal", () => {
    expect(prorationEstimateCents({ fromMonthlyCents: 4_999, toMonthlyCents: 9_999, periodStart, periodEnd, at: periodStart })).toBe(5_000);
    expect(prorationEstimateCents({ fromMonthlyCents: 4_999, toMonthlyCents: 9_999, periodStart, periodEnd, at: new Date("2026-12-11T15:00:00.000Z") })).toBe(2_500);
    expect(prorationEstimateCents({ fromMonthlyCents: 9_999, toMonthlyCents: 4_999, periodStart, periodEnd, at: new Date("2026-12-11T15:00:00.000Z") })).toBe(-2_500);
    expect(prorationEstimateCents({ fromMonthlyCents: 4_999, toMonthlyCents: 9_999, periodStart, periodEnd, at: periodEnd })).toBe(0);
  });
});
