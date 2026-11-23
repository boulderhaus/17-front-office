import type { ApiCall, ApiDashboard, ApiTask } from "./types"
import { compactDate } from "./format"

export type Tone = "danger" | "warn" | "good" | "neutral"

export function urgency(task: ApiTask | undefined, call: ApiCall | undefined): { tone: Tone; label: string } {
  if (call?.emergency?.severity === "life_safety") return { tone: "danger", label: "Emergency" }
  if (task?.priority === "high" || call?.emergency?.emergency) return { tone: "danger", label: "Urgent" }
  if (call?.outcome === "booked") return { tone: "good", label: "Booked" }
  if (call?.fields.requestedStart) return { tone: "warn", label: "Confirm time" }
  return { tone: "neutral", label: "Call back" }
}

/** Same buckets as the server-rendered dashboard. */
export function derive(data: ApiDashboard) {
  const nowMs = Date.parse(data.now)
  const tz = data.shop.timezone
  const callsById = new Map(data.calls.map((call) => [call.id, call]))
  const actionable = data.tasks
    .filter((task) => task.status === "open" || (task.status === "snoozed" && Date.parse(task.dueAt) <= nowMs))
    .sort((left, right) => (left.priority === right.priority ? left.dueAt.localeCompare(right.dueAt) : left.priority === "high" ? -1 : 1))
  const snoozed = data.tasks.filter((task) => task.status === "snoozed" && Date.parse(task.dueAt) > nowMs)
  const completed = data.tasks.filter((task) => task.status === "completed")
  const handled = completed.filter((task) => callsById.get(task.callId)?.outcome !== "booked").slice(0, 10)
  const urgentCount = actionable.filter((task) => task.priority === "high").length
  const upcoming = data.calls
    .filter((call) => call.fields.requestedStart && Date.parse(call.fields.requestedStart) >= nowMs && Date.parse(call.fields.requestedStart) < nowMs + 7 * 86_400_000)
    .sort((left, right) => left.fields.requestedStart!.localeCompare(right.fields.requestedStart!))
  const booked = upcoming.filter((call) => call.outcome === "booked")
  const used = data.usage.countedCalls
  const included = data.usage.includedCalls
  const remaining = Math.max(0, included - used)
  const extraCalls = data.usage.extraCalls
  const due = (task: ApiTask) => (Date.parse(task.dueAt) <= nowMs ? "Due now" : `Due ${compactDate(task.dueAt, tz)}`)
  const taskFor = (callId: string) => data.tasks.find((task) => task.callId === callId)
  const activity = [
    ...data.calls.filter((call) => call.endedAt).map((call) => ({ at: call.endedAt!, text: call.outcome === "booked" ? `Booked ${call.fields.callerName ?? "a caller"}` : `Answered ${call.fields.callerName ?? "a caller"}` })),
    ...completed.map((task) => ({ at: task.completedAt ?? task.updatedAt, text: task.completionSource === "verified_booking" ? "Closed after a verified booking" : `Marked ${callsById.get(task.callId)?.fields.callerName ?? "a call"} handled` })),
  ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 5)
  return { nowMs, tz, callsById, actionable, snoozed, completed, handled, urgentCount, upcoming, booked, used, included, remaining, extraCalls, due, taskFor, activity }
}

export function coverageStatus(data: Pick<ApiDashboard, "viewer" | "shop" | "preview">): { tone: "on" | "pending" | "paused" | "warning"; label: string } {
  if (data.preview) return { tone: "on", label: "Answering calls" }
  if (data.viewer.status !== "active") return { tone: "pending", label: "Activation pending" }
  if (data.shop.pausedForBilling) return { tone: "warning", label: "Paused · billing" }
  if (data.shop.paused) return { tone: "paused", label: "Paused" }
  if (!data.shop.alertsOn) return { tone: "warning", label: "On · alerts off" }
  return { tone: "on", label: "Answering calls" }
}

export function shortAddress(call: ApiCall | undefined): string {
  return (call?.fields.address ?? "").split(",").slice(0, 2).join(",").trim()
}
