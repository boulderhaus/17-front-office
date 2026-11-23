/**
 * Server-side check on the caller quote the model sends with request_human.
 * A request for service ("I need a technician to look at my furnace") is not a
 * request to speak with a person and must not block booking.
 */
export function isExplicitHumanRequest(callerQuote: string): boolean {
  const quote = callerQuote.toLowerCase().replace(/\s+/g, " ").trim();
  const person = "(?:a |an |the |your |some )?(?:human|real person|live person|person|owner|representative|operator|manager|someone|somebody)";
  if (new RegExp(`\\b(?:do not|don't|dont|never|no need to|not trying to|not asking to|do not want to|don't want to)\\b.{0,40}\\b${person}\\b`).test(quote)) return false;
  return [
    new RegExp(`\\b(?:i|we)\\s+(?:want|need|would like|'d like|have)\\s+to\\s+(?:speak|talk)\\s+(?:with|to)\\s+${person}\\b`),
    new RegExp(`\\b(?:can|could|may|would|will)\\s+(?:i|you)\\s+(?:please\\s+)?(?:speak|talk|connect me|transfer me|put me through)\\b.{0,30}\\b${person}\\b`),
    new RegExp(`\\b(?:connect|transfer|put)\\s+me\\b.{0,30}\\b${person}\\b`),
    new RegExp(`\\b(?:let me|please let me)\\s+(?:speak|talk)\\b.{0,30}\\b${person}\\b`),
    /\b(?:have|ask)\s+(?:the\s+)?(?:owner|technician|someone|somebody)\s+(?:to\s+)?call\s+me(?:\s+back)?\b/,
    /\b(?:i|we)\s+(?:want|need)\s+(?:a|an)\s+(?:human|real person|live person|person|representative|operator)\b/,
    /\b(?:human|person|representative|operator)\s*(?:please|now)?[.!?]*$/,
  ].some((pattern) => pattern.test(quote));
}
