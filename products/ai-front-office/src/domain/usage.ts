import type { CallRecord } from "./models.js";

/**
 * Calls shorter than this (connected seconds) never count against the owner's
 * minutes: hang-ups, wrong numbers and robocalls that drop at the greeting.
 * The Postgres usage query takes this value as a parameter, so both stores agree.
 */
export const MIN_BILLABLE_CALL_SECONDS = 15;

export const DEFAULT_USAGE_ALERT_PERCENT = 75;
export const MIN_USAGE_ALERT_PERCENT = 50;
export const MAX_USAGE_ALERT_PERCENT = 95;

/** What the dashboard says, so owners know a robocall or hang-up never costs them. */
export const USAGE_EXCLUSION_NOTE = "Spam and calls under 15 seconds aren’t counted.";

/** 75% and 90% first (the easy choices), then every 5% step in range, plus any saved odd value. */
export function usageAlertOptions(current: number): number[] {
  const steps: number[] = [];
  for (let percent = MIN_USAGE_ALERT_PERCENT; percent <= MAX_USAGE_ALERT_PERCENT; percent += 5) steps.push(percent);
  const rest = [...steps, ...(isValidUsageAlertPercent(current) ? [current] : [])].filter((value) => value !== 75 && value !== 90);
  return [75, 90, ...[...new Set(rest)].sort((left, right) => left - right)];
}

export type UsageClass = "billable" | "spam" | "short" | "not_billable";

/** How one call is treated for the owner's minutes. Mirrors PostgresStore.getUsageSummary exactly. */
export function usageClass(call: Pick<CallRecord, "billingDisposition" | "outcome" | "durationSeconds">): UsageClass {
  if (call.billingDisposition === "spam_excluded" || call.outcome === "ignored_spam") return "spam";
  if (call.billingDisposition !== "billable") return "not_billable";
  if ((call.durationSeconds ?? 0) < MIN_BILLABLE_CALL_SECONDS) return "short";
  return "billable";
}

/** Minutes a billable call adds: every started minute counts, as on the plan page. */
export function billedMinutesFor(call: Pick<CallRecord, "durationSeconds">): number {
  return Math.ceil((call.durationSeconds ?? 0) / 60);
}

export function isValidUsageAlertPercent(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_USAGE_ALERT_PERCENT && value <= MAX_USAGE_ALERT_PERCENT;
}

/**
 * Which alert (if any) the shop's usage has reached. Once the plan is used up only the
 * 100% alert applies, so a single long call that jumps past both sends one message.
 */
export function dueUsageAlerts(billedMinutes: number, includedMinutes: number, firstPercent: number): number[] {
  if (includedMinutes <= 0) return [];
  if (billedMinutes >= includedMinutes) return [100];
  if (billedMinutes * 100 >= includedMinutes * firstPercent) return [firstPercent];
  return [];
}

/**
 * The usage meter follows the shop's Stripe billing cycle so included minutes
 * reset when the subscription renews. Without a current period (unpaid, or a
 * stale record) it falls back to the UTC calendar month.
 */
export function currentBillingPeriod(now: Date, currentPeriodEnd?: string | null): [string, string] {
  const end = currentPeriodEnd ? new Date(currentPeriodEnd) : null;
  if (end && !Number.isNaN(end.getTime()) && end.getTime() > now.getTime()) {
    const start = new Date(end.getTime());
    start.setUTCMonth(start.getUTCMonth() - 1);
    if (start.getTime() <= now.getTime()) return [start.toISOString(), end.toISOString()];
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fallbackEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return [start.toISOString(), fallbackEnd.toISOString()];
}
