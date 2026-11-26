/**
 * The third number on Calls: calls Otto answered this month, in every answering mode and on every plan, so it
 * never changes meaning when the owner switches to "Ring my phone first" or turns on Unlimited.
 * With a call allowance, the line under it says how many are left; with Unlimited, "this month".
 */
export function usageTile(usage: { countedCalls: number; includedCalls: number; fairUseCalls: number | null; unlimited: boolean }): { label: string; value: number; note: string } {
  const answered = usage.countedCalls
  if (usage.unlimited) return { label: "Otto answered", value: answered, note: "this month" }
  const left = Math.max(0, usage.includedCalls - answered)
  return { label: "Otto answered", value: answered, note: `${left} of ${usage.includedCalls} left` }
}
