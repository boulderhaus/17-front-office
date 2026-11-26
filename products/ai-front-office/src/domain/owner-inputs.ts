/**
 * Small rules for what owners type in Settings. The owner app checks "Other" services with the same rule
 * (web/src/lib/settings-picks.ts; a test keeps the two equal).
 */

/**
 * Calls one number may make to the shop's Otto line in 24 hours before Otto asks them to call the business directly.
 * Fixed by Call Otto (not an owner setting): high enough for a worried caller ringing back, low enough that one
 * number can't use up a month of calls.
 */
export const REPEAT_CALLER_DAILY_LIMIT = 10;

// Whole words only, so "gutter" or "skill saw" never trip them.
const NOT_A_SERVICE = /\b(?:hitm[ae]n|hit ?m[ae]n|assassination|murders?|kidnap\w*|drugs?|cocaine|heroin|fentanyl|escorts?|prostitut\w*|sex|porn\w*|weapons?|firearms?|explosives?|bombs?|launder\w*|fake ids?|counterfeit\w*|stolen)\b/i;

/** One problem with the "Other" services an owner typed, in words they can act on; null when they're fine. */
export function otherServiceProblem(items: string[]): string | null {
  if (items.length > 12) return "Keep Other to 12 services or fewer.";
  for (const item of items) {
    const text = item.trim();
    if (text.length < 2 || text.length > 40) return `“${text.slice(0, 40)}” should be 2 to 40 letters, like “Pool repair”.`;
    if (!/[a-z]{2}/i.test(text) || /[@<>{}[\]\\|]|https?:|www\.|\.com\b/i.test(text)) return `“${text}” doesn’t look like a service. Try something like “Pool repair”.`;
    if (NOT_A_SERVICE.test(text)) return `“${text}” isn’t a service Otto can take calls for.`;
  }
  return null;
}
