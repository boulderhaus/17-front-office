/**
 * The hint under "Call Otto is" in Settings. Picking Paused warns only when calls to the business number may all go
 * to Otto (every call picked, or the last passed test was for every call: the same rule that stops Otto dialing that
 * number), since pausing would leave those callers nowhere to go. No imports, so the server tests can check it too.
 */
export function pauseHint(input: { active: boolean; paused: boolean; mayForwardAll: boolean; off: string | null | undefined }): string | undefined {
  if (!input.active) return "Your line turns on after it’s approved. Until then it stays paused."
  if (!input.paused || !input.mayForwardAll) return undefined
  return `Otto answers every call, so pausing stops all calls to your business number. Turn forwarding off first${input.off ? `: dial ${input.off} on that phone` : " with your phone company"}.`
}
