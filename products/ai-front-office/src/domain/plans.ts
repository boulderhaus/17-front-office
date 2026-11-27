import type { Environment } from "../config/environment.js";

export type PlanId = "solo" | "pro" | "team" | "fleet";
/** Every plan a subscription can be on. Pro is legacy: recognized so existing subscriptions keep working, never sold. */
export const PLAN_IDS: readonly PlanId[] = ["solo", "pro", "team", "fleet"];
/** The plans we sell (founder decision 2026-11-23): Solo, Team, Fleet. Solo first and picked by default. */
export const SOLD_PLAN_IDS: readonly PlanId[] = ["solo", "team", "fleet"];

/** The Unlimited add-on's fair use: no extra-call charges up to this many times the plan's included calls. */
export const FAIR_USE_MULTIPLIER = 3;
/** The fair-use line, word for word, shown right next to every Unlimited toggle. */
export const FAIR_USE_LINE = "Fair use: up to 3× your plan’s calls.";

/** What every plan charges per answered call past its included calls. */
export const DEFAULT_OVERAGE_CENTS_PER_CALL = 75;

/**
 * The founder-approved plans (2026-11-23; Team $149.99 from 2026-11-26). Env can relabel or reprice them; these are the defaults.
 * unlimitedAddOnCents is the monthly price of the Unlimited add-on on that plan (null: not offered, e.g. legacy Pro).
 */
export const DEFAULT_PLANS: Record<PlanId, { label: string; priceCents: number; includedCalls: number; who: string; unlimitedAddOnCents: number | null }> = {
  solo: { label: "Solo", priceCents: 4_999, includedCalls: 60, who: "One person", unlimitedAddOnCents: 5_000 },
  pro: { label: "Pro", priceCents: 9_999, includedCalls: 125, who: "A busy owner", unlimitedAddOnCents: null },
  team: { label: "Team", priceCents: 14_999, includedCalls: 250, who: "About 5 people", unlimitedAddOnCents: 7_500 },
  fleet: { label: "Fleet", priceCents: 34_999, includedCalls: 500, who: "About 10 people", unlimitedAddOnCents: 12_500 },
};

/** The Unlimited add-on on one plan: a second Stripe subscription item, toggled at checkout or in Settings. */
export interface UnlimitedAddOn {
  /** What the add-on adds each month: +$50 on Solo. */
  addOnCents: number;
  /** Plan plus add-on, monthly: $99.99 on Solo. */
  priceCents: number;
  /** Plan plus add-on in the first month: the intro coupon covers the whole first invoice, add-on included. */
  firstMonthCents: number;
  /** No extra-call charges up to this many counted calls a period (3× the plan's). */
  fairUseCalls: number;
  /** The add-on's Stripe price, or null without checkout (display only). */
  priceId: string | null;
}

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
  /** Who it's for: "One person", "About 5 people". */
  who: string;
  /** Stripe price, or null where checkout isn't configured (the plan is display-only). */
  priceId: string | null;
  /** Older prices for this plan still on live subscriptions (recognized, never sold). */
  legacyPriceIds: string[];
  /** False for legacy plans (Pro): recognized on existing subscriptions, never offered. */
  sold: boolean;
  /** The Unlimited add-on for this plan, or null where it isn't offered (legacy plan, or its price isn't set). */
  unlimited: UnlimitedAddOn | null;
}

type PlanEnv = Pick<Environment,
  | "STRIPE_SECRET_KEY" | "STRIPE_PRICE_ID" | "STRIPE_PRICE_ID_PLUS"
  | "STRIPE_PRICE_ID_SOLO" | "STRIPE_PRICE_ID_PRO" | "STRIPE_PRICE_ID_TEAM" | "STRIPE_PRICE_ID_TEAM_LEGACY" | "STRIPE_PRICE_ID_FLEET"
  | "STRIPE_PRICE_ID_UNLIMITED_SOLO" | "STRIPE_PRICE_ID_UNLIMITED_TEAM" | "STRIPE_PRICE_ID_UNLIMITED_FLEET"
  | "PLAN_SOLO_UNLIMITED_CENTS" | "PLAN_TEAM_UNLIMITED_CENTS" | "PLAN_FLEET_UNLIMITED_CENTS"
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
 * The PR #16 prices once the new ones are set: STRIPE_PRICE_ID stays Solo and STRIPE_PRICE_ID_PLUS stays Pro,
 * so subscriptions already paying on them keep being recognized (and keep their plan) after the switch.
 */
export function legacyPlanPriceIds(env: Pick<PlanEnv, "STRIPE_PRICE_ID" | "STRIPE_PRICE_ID_PLUS" | "STRIPE_PRICE_ID_SOLO" | "STRIPE_PRICE_ID_PRO"> & Partial<Pick<PlanEnv, "STRIPE_PRICE_ID_TEAM" | "STRIPE_PRICE_ID_TEAM_LEGACY">>): Record<PlanId, string[]> {
  return {
    solo: env.STRIPE_PRICE_ID && env.STRIPE_PRICE_ID_SOLO && env.STRIPE_PRICE_ID !== env.STRIPE_PRICE_ID_SOLO ? [env.STRIPE_PRICE_ID] : [],
    pro: env.STRIPE_PRICE_ID_PLUS && env.STRIPE_PRICE_ID_PRO && env.STRIPE_PRICE_ID_PLUS !== env.STRIPE_PRICE_ID_PRO ? [env.STRIPE_PRICE_ID_PLUS] : [],
    // The $179.99 Team price, once STRIPE_PRICE_ID_TEAM points at the $149.99 one.
    team: env.STRIPE_PRICE_ID_TEAM_LEGACY && env.STRIPE_PRICE_ID_TEAM_LEGACY !== env.STRIPE_PRICE_ID_TEAM ? [env.STRIPE_PRICE_ID_TEAM_LEGACY] : [],
    fleet: [],
  };
}

/** Each plan's Unlimited add-on price (Stripe). Pro has none. */
export function unlimitedPriceIds(env: Pick<PlanEnv, "STRIPE_PRICE_ID_UNLIMITED_SOLO" | "STRIPE_PRICE_ID_UNLIMITED_TEAM" | "STRIPE_PRICE_ID_UNLIMITED_FLEET">): Record<PlanId, string | undefined> {
  return { solo: env.STRIPE_PRICE_ID_UNLIMITED_SOLO, pro: undefined, team: env.STRIPE_PRICE_ID_UNLIMITED_TEAM, fleet: env.STRIPE_PRICE_ID_UNLIMITED_FLEET };
}

/** The most counted calls a period that the Unlimited add-on covers: 3× the plan's included calls. */
export function fairUseCalls(includedCalls: number): number {
  return includedCalls * FAIR_USE_MULTIPLIER;
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
 * The plans this server sells, Solo first: Solo, Team, Fleet. With Stripe configured, a plan appears only once
 * its price exists (Solo always does), and its Unlimited add-on only once that price exists. Without Stripe
 * (demo, local) all three are shown, add-ons included, for display.
 */
export function planCatalog(env: PlanEnv): Plan[] {
  return knownPlans(env).filter((plan) => plan.sold);
}

/**
 * Every plan a shop can be on: the plans for sale plus legacy Pro (sold: false), so a subscription already
 * on a Pro price keeps its plan, its calls and its label. Use planCatalog for anything offered to an owner.
 */
export function knownPlans(env: PlanEnv): Plan[] {
  const prices = planPriceIds(env);
  const addOnPrices = unlimitedPriceIds(env);
  const checkout = Boolean(env.STRIPE_SECRET_KEY && prices.solo);
  const percentOff = introCouponId(env) ? env.STRIPE_FIRST_MONTH_PERCENT_OFF : 0;
  const configured: Record<PlanId, { label: string; priceCents: number; includedCalls: number; addOnCents: number | null }> = {
    solo: { label: env.PLAN_SOLO_LABEL, priceCents: env.PLAN_SOLO_PRICE_CENTS, includedCalls: env.PLAN_SOLO_CALLS, addOnCents: env.PLAN_SOLO_UNLIMITED_CENTS },
    pro: { label: env.PLAN_PRO_LABEL, priceCents: env.PLAN_PRO_PRICE_CENTS, includedCalls: env.PLAN_PRO_CALLS, addOnCents: null },
    team: { label: env.PLAN_TEAM_LABEL, priceCents: env.PLAN_TEAM_PRICE_CENTS, includedCalls: env.PLAN_TEAM_CALLS, addOnCents: env.PLAN_TEAM_UNLIMITED_CENTS },
    fleet: { label: env.PLAN_FLEET_LABEL, priceCents: env.PLAN_FLEET_PRICE_CENTS, includedCalls: env.PLAN_FLEET_CALLS, addOnCents: env.PLAN_FLEET_UNLIMITED_CENTS },
  };
  const legacy = legacyPlanPriceIds(env);
  return PLAN_IDS
    .filter((id) => SOLD_PLAN_IDS.includes(id) ? id === "solo" || !checkout || Boolean(prices[id]) : Boolean(prices[id]) || legacy[id].length > 0 || !checkout)
    .map((id): Plan => {
      const plan = configured[id];
      const addOnPrice = addOnPrices[id] ?? null;
      const addOn = plan.addOnCents !== null && (!checkout || addOnPrice) ? plan.addOnCents : null;
      return {
        id,
        label: plan.label,
        priceCents: plan.priceCents,
        includedCalls: plan.includedCalls,
        firstMonthCents: firstMonthCents(plan.priceCents, percentOff),
        overageCentsPerCall: env.OVERAGE_CENTS_PER_CALL,
        blurb: planBlurb(plan.includedCalls),
        who: DEFAULT_PLANS[id].who,
        priceId: prices[id] ?? null,
        legacyPriceIds: legacy[id],
        sold: SOLD_PLAN_IDS.includes(id),
        unlimited: addOn === null ? null : {
          addOnCents: addOn,
          priceCents: plan.priceCents + addOn,
          // The coupon takes its percent off the whole first invoice, so the add-on is discounted too.
          firstMonthCents: firstMonthCents(plan.priceCents + addOn, percentOff),
          fairUseCalls: fairUseCalls(plan.includedCalls),
          priceId: addOnPrice,
        },
      };
    });
}

/** The plan a shop is on (legacy Pro included), or Solo when its saved plan is unknown here. */
export function currentPlan(known: Plan[], planId: PlanId | undefined): Plan {
  return known.find((plan) => plan.id === (planId ?? "solo")) ?? known.find((plan) => plan.id === "solo") ?? known[0]!;
}

/** True when a subscription's prices include an Unlimited add-on price. */
export function hasUnlimitedPrice(known: Plan[], priceIds: string[]): boolean {
  return known.some((plan) => plan.unlimited?.priceId && priceIds.includes(plan.unlimited.priceId));
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
  return plans.find((plan) => (plan.priceId !== null && priceIds.includes(plan.priceId)) || plan.legacyPriceIds.some((id) => priceIds.includes(id))) ?? null;
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
export const LEAD_GUARANTEE = "If Call Otto doesn’t send you at least one real customer lead in your first 30 days, reply to your receipt (or tap Request refund) and we’ll refund your first month.";

/** What a plan costs, in the one shape every price summary shows (signup card step and Settings). */
export interface PriceQuote {
  /** Charged today when the card is added: the first month, intro offer applied; 0 during a free trial. */
  todayCents: number;
  /** The regular monthly price from the renewal on (plan plus the Unlimited add-on when it is on). */
  monthlyCents: number;
  /** The full price shown struck through next to today's price, or null when today's price is the full price. */
  strikeCents: number | null;
  /** When the regular monthly price is first charged (ISO): one month from now, or the end of a free trial. */
  renewsAt: string;
}

/** One calendar month later, clamped to the month's last day (Jan 31 → Feb 28), as Stripe bills monthly. */
export function addOneMonth(date: Date): Date {
  return shiftMonths(date, 1);
}

/** One calendar month earlier, clamped the same way: the start of a monthly period that ends on this date. */
export function oneMonthBefore(date: Date): Date {
  return shiftMonths(date, -1);
}

function shiftMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next;
}

/**
 * The single price function behind every summary: plan, Unlimited on or off, the intro offer (already in the
 * plan's firstMonthCents) and any free trial. There is no yearly price, so there is no interval to pick.
 */
export function priceQuote(input: { plan: Pick<Plan, "priceCents" | "firstMonthCents" | "unlimited">; unlimited: boolean; now: Date; trialDays?: number }): PriceQuote {
  const total = input.unlimited && input.plan.unlimited ? input.plan.unlimited : input.plan;
  const trialDays = Math.max(0, Math.floor(input.trialDays ?? 0));
  if (trialDays > 0) {
    return { todayCents: 0, monthlyCents: total.priceCents, strikeCents: null, renewsAt: new Date(input.now.getTime() + trialDays * 86_400_000).toISOString() };
  }
  const today = total.firstMonthCents;
  return { todayCents: today, monthlyCents: total.priceCents, strikeCents: today < total.priceCents ? total.priceCents : null, renewsAt: addOneMonth(input.now).toISOString() };
}

/** The plan plus the add-on, monthly: what a shop pays each month on this plan with Unlimited on or off. */
export function monthlyCents(plan: Pick<Plan, "priceCents" | "unlimited">, unlimited: boolean): number {
  return unlimited && plan.unlimited ? plan.unlimited.priceCents : plan.priceCents;
}

/**
 * A local stand-in for Stripe's proration, used only when Stripe's preview is refused (and then shown as "about"):
 * the monthly difference times the share of the period still to run, rounded to the cent. Negative is a credit.
 */
export function prorationEstimateCents(input: { fromMonthlyCents: number; toMonthlyCents: number; periodStart: Date; periodEnd: Date; at: Date }): number {
  const total = input.periodEnd.getTime() - input.periodStart.getTime();
  if (total <= 0) return 0;
  const left = Math.min(total, Math.max(0, input.periodEnd.getTime() - input.at.getTime()));
  return Math.round((input.toMonthlyCents - input.fromMonthlyCents) * left / total);
}
