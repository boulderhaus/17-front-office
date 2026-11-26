/**
 * The Text button: the phone's message app, opened on a draft written from the call, so the owner only taps Send.
 * "Hi Linda, this is Suncoast Heating. Saw you called about your AC not cooling. When's a good time for us to come by?"
 */

export function smsDraft(input: { callerName: string | null; problem: string | null; shop: string | null }): string {
  const first = input.callerName?.trim().split(/\s+/)[0]
  const shop = input.shop?.trim()
  const problem = input.problem?.trim().replace(/[.!?\s]+$/, "")
  const hello = first ? `Hi ${first}` : "Hi"
  const from = shop ? `, this is ${shop}.` : "."
  // "Kitchen sink drains slowly" reads as "about kitchen sink drains slowly", unless it starts with a name (AC, HVAC).
  const about = problem ? ` Saw you called about ${/^[A-Z][a-z]/.test(problem) ? problem[0]!.toLowerCase() + problem.slice(1) : problem}.` : " Saw you called."
  return `${hello}${from}${about} When's a good time for us to come by?`
}

/**
 * iPhone (iOS 8 and later) reads the body after "&", Android after "?" (RFC 5724). Picked by the browser's
 * user agent; anything that isn't an Apple phone or tablet gets the standard "?".
 */
export function smsHref(phone: string, body: string, userAgent: string, touchMac = false): string {
  const apple = /iPhone|iPad|iPod/.test(userAgent) || touchMac
  return `sms:${phone}${apple ? "&" : "?"}body=${encodeURIComponent(body)}`
}
