import type { SubscriptionRecord } from "./models.js";

/** A free trial started with a card on file is paid access: the line may run. */
export function isPaidStatus(status: SubscriptionRecord["status"] | null | undefined): boolean {
  return status === "active" || status === "trialing";
}

/** When a card added now is first charged: now plus the trial, or now with no trial. */
export function firstChargeDate(now: Date, trialDays: number): Date {
  return new Date(now.getTime() + Math.max(0, trialDays) * 24 * 60 * 60_000);
}

/** Plain words for when the card is charged, e.g. "Free for 7 days. Then $49 a month, first charged on Dec 1." */
export function chargeSentence(input: { now: Date; trialDays: number; priceCents: number; timezone?: string }): string {
  const price = `$${Math.round(input.priceCents / 100)}`;
  if (input.trialDays <= 0) return `Your card is charged ${price} today, then every month. Cancel anytime.`;
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: input.timezone ?? "America/New_York" }).format(firstChargeDate(input.now, input.trialDays));
  return `Free for ${input.trialDays} days. Your card is first charged ${price} on ${date}, then every month. Cancel before then and you pay nothing.`;
}
