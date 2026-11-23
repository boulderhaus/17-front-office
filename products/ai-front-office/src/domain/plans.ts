import type { Environment } from "../config/environment.js";

export type PlanId = "standard" | "plus";

/** A plan as the owner sees it: the cheaper one is listed first and picked by default. */
export interface Plan {
  id: PlanId;
  label: string;
  /** Monthly price. */
  priceCents: number;
  /** What the first month costs with the intro coupon; equals priceCents when there is no coupon. */
  firstMonthCents: number;
  /** One line on what the plan covers, e.g. "Up to 60 answered calls a month". */
  blurb: string;
  /** Stripe price, or null where checkout isn't configured (the plan is display-only). */
  priceId: string | null;
}

type PlanEnv = Pick<Environment,
  | "STRIPE_SECRET_KEY" | "STRIPE_PRICE_ID" | "STRIPE_PRICE_ID_PLUS" | "STRIPE_FIRST_MONTH_COUPON_ID" | "STRIPE_FIRST_MONTH_PERCENT_OFF" | "STRIPE_TRIAL_DAYS"
  | "PLAN_STANDARD_LABEL" | "PLAN_STANDARD_PRICE_CENTS" | "PLAN_STANDARD_BLURB" | "PLAN_PLUS_LABEL" | "PLAN_PLUS_PRICE_CENTS" | "PLAN_PLUS_BLURB">;

/**
 * The intro offer applies only when the coupon is configured and there is no free trial:
 * a once-only coupon on a trial would be spent on the $0 trial invoice, so we never promise it then.
 */
export function introCouponId(env: PlanEnv): string | null {
  return env.STRIPE_FIRST_MONTH_COUPON_ID && env.STRIPE_TRIAL_DAYS <= 0 ? env.STRIPE_FIRST_MONTH_COUPON_ID : null;
}

/**
 * The plans this server can sell, cheapest first. With Stripe configured, the second plan appears only
 * once its price exists. Without Stripe (demo, local) both are shown for display.
 */
export function planCatalog(env: PlanEnv): Plan[] {
  const checkout = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID);
  const percentOff = introCouponId(env) ? env.STRIPE_FIRST_MONTH_PERCENT_OFF : 0;
  const make = (id: PlanId, label: string, priceCents: number, blurb: string, priceId: string | null): Plan => ({
    id, label, priceCents, blurb, priceId,
    firstMonthCents: firstMonthCents(priceCents, percentOff),
  });
  const plans = [make("standard", env.PLAN_STANDARD_LABEL, env.PLAN_STANDARD_PRICE_CENTS, env.PLAN_STANDARD_BLURB, env.STRIPE_PRICE_ID ?? null)];
  if (!checkout || env.STRIPE_PRICE_ID_PLUS) plans.push(make("plus", env.PLAN_PLUS_LABEL, env.PLAN_PLUS_PRICE_CENTS, env.PLAN_PLUS_BLURB, env.STRIPE_PRICE_ID_PLUS ?? null));
  return plans.sort((left, right) => left.priceCents - right.priceCents);
}

/** The plan asked for, or the cheapest one when the value is missing or unknown. */
export function pickPlan(plans: Plan[], value: unknown): Plan {
  return plans.find((plan) => plan.id === value) ?? plans[0]!;
}

/** Which plan a Stripe subscription is on, from its price ids; null when it is none of ours. */
export function planForPriceIds(plans: Plan[], priceIds: string[]): Plan | null {
  return plans.find((plan) => plan.priceId !== null && priceIds.includes(plan.priceId)) ?? null;
}

/** The first month with a percent-off coupon, discount rounded to the cent: $49.99 at 50% off → $24.99. */
export function firstMonthCents(priceCents: number, percentOff: number): number {
  if (percentOff <= 0) return priceCents;
  return priceCents - Math.round(priceCents * percentOff / 100);
}

/** "$49.99", or "$49" for whole dollars. */
export function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}
