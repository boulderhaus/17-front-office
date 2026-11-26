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
interface AlertTask { callId: string; status: string; priority: string; dueAt: string; updatedAt?: string }

/** A call that ended before Otto got the details: under 20 seconds. Spam never counts. */
const SHORT_SECONDS = 20

const later = (...values: Array<string | null | undefined>) => values.filter((value): value is string => Boolean(value)).sort().reverse()[0]!

/**
 * at: when the alert appeared (the call ended, the call back came due, the follow-up changed), not when the call
 * started, so something that turned urgent after the bell was opened still gets the dot and sorts as new.
 * The list stops at `limit`, but an open urgent call or call back is never pushed off by newer bookings.
 */
export function buildAlerts(input: { calls: AlertCall[]; tasks: AlertTask[]; nowMs: number }, limit = 20): AlertItem[] {
  const tasks = new Map(input.tasks.map((task) => [task.callId, task]))
  const items: AlertItem[] = []
  for (const call of input.calls) {
    if (call.outcome === "ignored_spam" || call.outcome === "in_progress") continue
    const who = call.fields.callerName?.trim() || "Unknown caller"
    const problem = call.fields.problemDescription?.trim()
    const task = tasks.get(call.id)
    const dueNow = task?.status === "snoozed" && Date.parse(task.dueAt) <= input.nowMs
    const open = task && (task.status === "open" || dueNow)
    const ended = call.endedAt ?? call.startedAt
    const taskAt = task ? later(ended, task.updatedAt, dueNow ? task.dueAt : null) : ended
    const short = call.endedAt !== null && call.durationSeconds !== null && call.durationSeconds < SHORT_SECONDS
    if (call.outcome === "booked") {
      items.push({ kind: "booked", callId: call.id, at: ended, title: `New booking: ${who}`, detail: problem || "Booked on the call" })
    } else if (open && (task.priority === "high" || call.emergency?.emergency)) {
      items.push({ kind: "urgent", callId: call.id, at: taskAt, title: `Urgent: ${who}`, detail: problem || "Call back now" })
    } else if (short) {
      items.push({ kind: "short", callId: call.id, at: ended, title: `Hung up early: ${who}`, detail: "Ended before Otto got the details" })
    } else if (call.outcome === "failed") {
      items.push({ kind: "short", callId: call.id, at: ended, title: `Call dropped: ${who}`, detail: problem || "The call cut off" })
    } else if (open) {
      items.push({ kind: "callback", callId: call.id, at: taskAt, title: `${who} is waiting`, detail: problem || "Wants a call back" })
    }
  }
  const newest = (list: AlertItem[]) => list.sort((left, right) => right.at.localeCompare(left.at))
  const waiting = items.filter((item) => item.kind === "urgent" || item.kind === "callback")
  const rest = newest(items.filter((item) => item.kind !== "urgent" && item.kind !== "callback")).slice(0, Math.max(0, limit - waiting.length))
  return newest([...waiting, ...rest])
}

/** New since the bell was last opened: the dot on the bell. */
export function unseenAlerts(items: AlertItem[], seenAt: string | null): number {
  return items.filter((item) => !seenAt || item.at > seenAt).length
}
