/**
 * The bell's list: what happened on calls that the owner would want to know, newest first. Built from the
 * dashboard the app already loads (calls and their follow-ups), so it needs no request of its own.
 * Self-contained types (no imports), so the rules are tested without a browser.
 */

export type AlertKind = "urgent" | "callback" | "booked" | "short"

export interface AlertItem { kind: AlertKind; callId: string; at: string; title: string; detail: string }

interface AlertCall {
  id: string
  startedAt: string
  endedAt: string | null
  durationSeconds: number | null
  outcome: string
  fields: { callerName: string | null; problemDescription: string; requestedStart: string | null }
  emergency: { emergency: boolean } | null
}
interface AlertTask { callId: string; status: string; priority: string; dueAt: string }

/** A call that ended before Otto got the details: under 20 seconds, or one that failed. Spam never counts. */
const SHORT_SECONDS = 20

export function buildAlerts(input: { calls: AlertCall[]; tasks: AlertTask[]; nowMs: number }, limit = 20): AlertItem[] {
  const tasks = new Map(input.tasks.map((task) => [task.callId, task]))
  const items: AlertItem[] = []
  for (const call of input.calls) {
    if (call.outcome === "ignored_spam" || call.outcome === "in_progress") continue
    const who = call.fields.callerName?.trim() || "Unknown caller"
    const problem = call.fields.problemDescription?.trim()
    const task = tasks.get(call.id)
    const open = task && (task.status === "open" || (task.status === "snoozed" && Date.parse(task.dueAt) <= input.nowMs))
    if (call.outcome === "booked") {
      items.push({ kind: "booked", callId: call.id, at: call.startedAt, title: `New booking: ${who}`, detail: problem || "Booked on the call" })
    } else if (open && (task.priority === "high" || call.emergency?.emergency)) {
      items.push({ kind: "urgent", callId: call.id, at: call.startedAt, title: `Urgent: ${who}`, detail: problem || "Call back now" })
    } else if (call.outcome === "failed" || (call.endedAt && call.durationSeconds !== null && call.durationSeconds < SHORT_SECONDS)) {
      items.push({ kind: "short", callId: call.id, at: call.startedAt, title: `Hung up early: ${who}`, detail: "Ended before Otto got the details" })
    } else if (open) {
      items.push({ kind: "callback", callId: call.id, at: call.startedAt, title: `${who} is waiting`, detail: problem || "Wants a call back" })
    }
  }
  return items.sort((left, right) => right.at.localeCompare(left.at)).slice(0, limit)
}

/** New since the bell was last opened: the dot on the bell. */
export function unseenAlerts(items: AlertItem[], seenAt: string | null): number {
  return items.filter((item) => !seenAt || item.at > seenAt).length
}
