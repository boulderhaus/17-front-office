export function compactDate(value: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value))
}

export function timeOnly(value: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(value))
}

export function dateKey(value: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(value)
}

export function dayLabel(value: string, tz: string, nowMs: number): string {
  const key = dateKey(new Date(value), tz)
  if (key === dateKey(new Date(nowMs), tz)) return "Today"
  if (key === dateKey(new Date(nowMs + 86_400_000), tz)) return "Tomorrow"
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(value))
}

export function formatPhone(phone: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone)
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone
}

/**
 * Who called: the name they gave, else the number they called from. "Unknown caller" only when there is no
 * number either (blocked or withheld).
 */
export function callerLabel(call: { phone: string | null; fields: { callerName: string | null } } | undefined): string {
  return call?.fields.callerName?.trim() || (call?.phone ? formatPhone(call.phone) : "Unknown caller")
}

export function outcomeWords(outcome: string): string {
  return ({ in_progress: "On the call", booked: "Booked", pending_confirmation: "Needs your OK", handoff_queued: "Call back", ignored_spam: "Likely spam", failed: "Failed" } as Record<string, string>)[outcome] ?? outcome
}

export function notificationWords(state: string): string {
  return ({ pending: "Queued", sending: "Sending", sent: "Sent", delivered: "Delivered", delivery_failed: "Not delivered", delivery_unconfirmed: "Sent, not confirmed", retry: "Retrying", dead: "Failed" } as Record<string, string>)[state] ?? state
}

export function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
}

/** "$49.99", or "$49" for whole dollars. */
export function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`
}

/** "75¢" under a dollar: how the per-call price reads. */
export function perCall(cents: number): string {
  return cents < 100 ? `${cents}¢` : money(cents)
}

/** The lead guarantee, word for word (mirrors LEAD_GUARANTEE on the server). */
export const LEAD_GUARANTEE = "If Call Otto doesn’t send you at least one real customer lead in your first 30 days, reply to your receipt (or tap Request refund) and we’ll refund your first month."

/** Shown right next to every Unlimited toggle, word for word (src/domain/plans.ts FAIR_USE_LINE). */
export const FAIR_USE_LINE = "Fair use: up to 3× your plan’s calls."
