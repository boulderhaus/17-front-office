import type { ApiCall, ApiDashboard, ApiTask } from "./types"
import { compactDate, dateKey, timeOnly } from "./format"
import { oneJobPerCaller } from "./jobs"

export type Tone = "danger" | "warn" | "good" | "neutral"

export function urgency(task: ApiTask | undefined, call: ApiCall | undefined): { tone: Tone; label: string } {
  if (call?.outcome === "ignored_spam") return { tone: "neutral", label: "Likely spam" }
  if (call?.outcome === "in_progress") return { tone: "warn", label: "On the call" }
  if (task?.status === "completed") return call?.outcome === "booked" ? { tone: "good", label: "Booked" } : { tone: "neutral", label: "Done" }
  if (call?.emergency?.severity === "life_safety") return { tone: "danger", label: "Emergency" }
  if (task?.priority === "high" || call?.emergency?.emergency) return { tone: "danger", label: "Urgent" }
  if (call?.outcome === "booked") return { tone: "good", label: "Booked" }
  if (call?.fields.requestedStart) return { tone: "warn", label: "Confirm time" }
  // No open follow-up: the call was answered and nothing is waiting on the owner.
  if (!task || task.status === "cancelled") return { tone: "neutral", label: "Answered" }
  if (task.status === "snoozed") return { tone: "neutral", label: "Later" }
  return { tone: "neutral", label: "Call back" }
}

/** Same buckets as the server-rendered dashboard. */
export function derive(data: ApiDashboard) {
  const nowMs = Date.parse(data.now)
  const tz = data.shop.timezone
  const callsById = new Map(data.calls.map((call) => [call.id, call]))
  const open = oneJobPerCaller(data.tasks
    .filter((task) => task.status === "open" || (task.status === "snoozed" && Date.parse(task.dueAt) <= nowMs))
    .sort((left, right) => (left.priority === right.priority ? left.dueAt.localeCompare(right.dueAt) : left.priority === "high" ? -1 : 1)), callsById)
  const later = oneJobPerCaller(data.tasks.filter((task) => task.status === "snoozed" && Date.parse(task.dueAt) > nowMs), callsById)
  const actionable = open.jobs
  const snoozed = later.jobs
  // A caller's other open calls, by the call their one job shows: Done and Later close them too.
  const earlier = new Map([...later.earlier, ...open.earlier])
  const completed = data.tasks.filter((task) => task.status === "completed")
  const handled = completed.filter((task) => callsById.get(task.callId)?.outcome !== "booked")
  const urgentCount = actionable.filter((task) => task.priority === "high").length
  const upcoming = data.calls
    .filter((call) => call.fields.requestedStart && Date.parse(call.fields.requestedStart) >= nowMs && Date.parse(call.fields.requestedStart) < nowMs + 7 * 86_400_000)
    .sort((left, right) => left.fields.requestedStart!.localeCompare(right.fields.requestedStart!))
  const booked = upcoming.filter((call) => call.outcome === "booked")
  const used = data.usage.countedCalls
  // With Unlimited, the meter runs to fair use (3× the plan's calls) instead.
  const included = data.usage.fairUseCalls ?? data.usage.includedCalls
  const remaining = Math.max(0, included - used)
  const extraCalls = data.usage.extraCalls
  // "Due now", "Due today 11:52 AM" (same day: no date), or "Due Nov 26, 9:00 AM".
  const due = (task: ApiTask) => (Date.parse(task.dueAt) <= nowMs ? "Due now"
    : dateKey(new Date(task.dueAt), tz) === dateKey(new Date(nowMs), tz) ? `Due today ${timeOnly(task.dueAt, tz)}`
      : `Due ${compactDate(task.dueAt, tz)}`)
  const taskFor = (callId: string) => data.tasks.find((task) => task.callId === callId)
  return { nowMs, tz, callsById, actionable, snoozed, earlier, completed, handled, urgentCount, upcoming, booked, used, included, remaining, extraCalls, due, taskFor }
}

export { forwardingOn, lineStatus as coverageStatus } from "./line-status"

export function shortAddress(call: ApiCall | undefined): string {
  return (call?.fields.address ?? "").split(",").slice(0, 2).join(",").trim()
}
