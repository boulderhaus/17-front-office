import type { Environment } from "../config/environment.js";

export type PlanId = "solo" | "pro" | "team" | "fleet";
export const PLAN_IDS: readonly PlanId[] = ["solo", "pro", "team", "fleet"];

/** What every plan charges per answered call past its included calls. */
export const DEFAULT_OVERAGE_CENTS_PER_CALL = 75;

/** The founder-approved plans (2026-11-23). Env can relabel or reprice them; these are the defaults. */
export const DEFAULT_PLANS: Record<PlanId, { label: string; priceCents: number; includedCalls: number; who: string }> = {
  solo: { label: "Solo", priceCents: 4_999, includedCalls: 60, who: "One truck" },
  pro: { label: "Pro", priceCents: 9_999, includedCalls: 125, who: "A busy owner" },
  team: { label: "Team", priceCents: 17_999, includedCalls: 250, who: "About 5 people" },
  fleet: { label: "Fleet", priceCents: 34_999, includedCalls: 500, who: "About 10 people" },
};

/** A plan as the owner sees it: Solo first and picked by default. */
export interface Plan {
  id: PlanId;
  label: string;
  /** Monthly price. */
  priceCents: number;
  /** What the first month costs with the intro coupon; equals priceCents when there is no coupon. */
  firstMonthCents: number;
  /** Answered calls included each month. */
  includedCalls: number;
  /** Each answered call past includedCalls. */
  overageCentsPerCall: number;
  /** Plain words: "60 answered calls a month, about 2 a day". */
  blurb: string;
  /** Who it's for: "One truck", "About 5 people". */
  who: string;
  /** Stripe price, or null where checkout isn't configured (the plan is display-only). */
  priceId: string | null;
}

type PlanEnv = Pick<Environment,
  | "STRIPE_SECRET_KEY" | "STRIPE_PRICE_ID" | "STRIPE_PRICE_ID_PLUS"
  | "STRIPE_PRICE_ID_SOLO" | "STRIPE_PRICE_ID_PRO" | "STRIPE_PRICE_ID_TEAM" | "STRIPE_PRICE_ID_FLEET"
  | "STRIPE_FIRST_MONTH_COUPON_ID" | "STRIPE_FIRST_MONTH_PERCENT_OFF" | "STRIPE_TRIAL_DAYS" | "OVERAGE_CENTS_PER_CALL" | "FIRST_MONTH_OFFER_ENABLED"
  | "PLAN_SOLO_LABEL" | "PLAN_SOLO_PRICE_CENTS" | "PLAN_SOLO_CALLS"
  | "PLAN_PRO_LABEL" | "PLAN_PRO_PRICE_CENTS" | "PLAN_PRO_CALLS"
  | "PLAN_TEAM_LABEL" | "PLAN_TEAM_PRICE_CENTS" | "PLAN_TEAM_CALLS"
  | "PLAN_FLEET_LABEL" | "PLAN_FLEET_PRICE_CENTS" | "PLAN_FLEET_CALLS">;

/** Each plan's Stripe price. Solo falls back to STRIPE_PRICE_ID and Pro to STRIPE_PRICE_ID_PLUS (the PR #16 names). */
export function planPriceIds(env: Pick<PlanEnv, "STRIPE_PRICE_ID" | "STRIPE_PRICE_ID_PLUS" | "STRIPE_PRICE_ID_SOLO" | "STRIPE_PRICE_ID_PRO" | "STRIPE_PRICE_ID_TEAM" | "STRIPE_PRICE_ID_FLEET">): Record<PlanId, string | undefined> {
  return {
    solo: env.STRIPE_PRICE_ID_SOLO ?? env.STRIPE_PRICE_ID,
    pro: env.STRIPE_PRICE_ID_PRO ?? env.STRIPE_PRICE_ID_PLUS,
    team: env.STRIPE_PRICE_ID_TEAM,
    fleet: env.STRIPE_PRICE_ID_FLEET,
  };
}

/**
 * The intro offer applies only when the coupon is configured and there is no free trial:
 * a once-only coupon on a trial would be spent on the $0 trial invoice, so we never promise it then.
 */
export function introCouponId(env: Pick<PlanEnv, "STRIPE_FIRST_MONTH_COUPON_ID" | "STRIPE_TRIAL_DAYS" | "FIRST_MONTH_OFFER_ENABLED">): string | null {
  // Limited-time offer: FIRST_MONTH_OFFER_ENABLED=false turns off the coupon and, with it, every "half off" line.
  return env.FIRST_MONTH_OFFER_ENABLED && env.STRIPE_FIRST_MONTH_COUPON_ID && env.STRIPE_TRIAL_DAYS <= 0 ? env.STRIPE_FIRST_MONTH_COUPON_ID : null;
}

/** "half off" at 50%, otherwise "40% off": how the limited-time offer is named. */
export function offerWords(priceCents: number, firstMonthCents: number): string {
  const percent = Math.round(100 - (firstMonthCents * 100) / priceCents);
  return percent === 50 ? "half off" : `${percent}% off`;
}

/** "60 answered calls a month, about 2 a day" (30-day month, rounded). */
export function planBlurb(includedCalls: number): string {
  const perDay = Math.max(1, Math.round(includedCalls / 30));
  return `${includedCalls} answered calls a month, about ${perDay} a day`;
}

/**
 * The plans this server can sell, Solo first. With Stripe configured, a plan appears only once its
 * price exists (Solo always does). Without Stripe (demo, local) all four are shown for display.
 */
export function planCatalog(env: PlanEnv): Plan[] {
  const prices = planPriceIds(env);
  const checkout = Boolean(env.STRIPE_SECRET_KEY && prices.solo);
  const percentOff = introCouponId(env) ? env.STRIPE_FIRST_MONTH_PERCENT_OFF : 0;
  const configured: Record<PlanId, { label: string; priceCents: number; includedCalls: number }> = {
    solo: { label: env.PLAN_SOLO_LABEL, priceCents: env.PLAN_SOLO_PRICE_CENTS, includedCalls: env.PLAN_SOLO_CALLS },
    pro: { label: env.PLAN_PRO_LABEL, priceCents: env.PLAN_PRO_PRICE_CENTS, includedCalls: env.PLAN_PRO_CALLS },
    team: { label: env.PLAN_TEAM_LABEL, priceCents: env.PLAN_TEAM_PRICE_CENTS, includedCalls: env.PLAN_TEAM_CALLS },
    fleet: { label: env.PLAN_FLEET_LABEL, priceCents: env.PLAN_FLEET_PRICE_CENTS, includedCalls: env.PLAN_FLEET_CALLS },
  };
  return PLAN_IDS
    .filter((id) => id === "solo" || !checkout || Boolean(prices[id]))
    .map((id) => ({
      id,
      ...configured[id],
      firstMonthCents: firstMonthCents(configured[id].priceCents, percentOff),
      overageCentsPerCall: env.OVERAGE_CENTS_PER_CALL,
      blurb: planBlurb(configured[id].includedCalls),
      who: DEFAULT_PLANS[id].who,
      priceId: prices[id] ?? null,
    }));
}

/** Old plan ids (PR #16) map onto the new ones: Standard is Solo, Plus is Pro. */
export function normalizePlanId(value: unknown): PlanId | null {
  if (value === "standard") return "solo";
  if (value === "plus") return "pro";
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value) ? value as PlanId : null;
}

/** The plan asked for, or Solo when the value is missing or unknown. */
export function pickPlan(plans: Plan[], value: unknown): Plan {
  const id = normalizePlanId(value);
  return plans.find((plan) => plan.id === id) ?? plans[0]!;
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

/** "75¢" under a dollar, otherwise money(): how per-call prices read. */
export function perCall(cents: number): string {
  return cents < 100 ? `${cents}¢` : money(cents);
}

/** The guarantee, word for word, wherever it is shown. */
export const LEAD_GUARANTEE = "If Front Office doesn’t send you at least one real customer lead in your first 30 days, reply to your receipt (or tap Request refund) and we’ll refund your first month.";
