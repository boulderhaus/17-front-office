import type { ApiCall, ApiDashboard, ApiTask } from "./types"
import { compactDate } from "./format"

export type Tone = "danger" | "warn" | "good" | "neutral"

export function urgency(task: ApiTask | undefined, call: ApiCall | undefined): { tone: Tone; label: string } {
  if (call?.outcome === "ignored_spam") return { tone: "neutral", label: "Likely spam" }
  if (call?.outcome === "in_progress") return { tone: "warn", label: "On the call" }
  if (task?.status === "completed") return call?.outcome === "booked" ? { tone: "good", label: "Booked" } : { tone: "neutral", label: "Complete" }
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
  const actionable = data.tasks
    .filter((task) => task.status === "open" || (task.status === "snoozed" && Date.parse(task.dueAt) <= nowMs))
    .sort((left, right) => (left.priority === right.priority ? left.dueAt.localeCompare(right.dueAt) : left.priority === "high" ? -1 : 1))
  const snoozed = data.tasks.filter((task) => task.status === "snoozed" && Date.parse(task.dueAt) > nowMs)
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
  const due = (task: ApiTask) => (Date.parse(task.dueAt) <= nowMs ? "Due now" : `Due ${compactDate(task.dueAt, tz)}`)
  const taskFor = (callId: string) => data.tasks.find((task) => task.callId === callId)
  return { nowMs, tz, callsById, actionable, snoozed, completed, handled, urgentCount, upcoming, booked, used, included, remaining, extraCalls, due, taskFor }
}

/** The line's state in plain words. Text alerts being off is shown separately, never folded into this label. */
export function coverageStatus(data: Pick<ApiDashboard, "viewer" | "shop" | "preview">): { tone: "on" | "pending" | "paused" | "warning"; label: string; detail: string } {
  if (data.preview) return { tone: "on", label: "Answering calls", detail: "Front Office picks up when you can’t." }
  if (data.viewer.status !== "active") return { tone: "pending", label: "Setting up your line", detail: "We turn it on as soon as it’s approved and let you know." }
  if (data.shop.pausedForBilling) return { tone: "warning", label: "Paused for billing", detail: "Update your card in Plan and billing to turn answering back on." }
  if (data.shop.paused) return { tone: "paused", label: "Answering paused", detail: "Front Office isn’t answering. Turn it back on in How calls are answered." }
  return { tone: "on", label: "Answering calls", detail: "Front Office picks up when you can’t." }
}

export function shortAddress(call: ApiCall | undefined): string {
  return (call?.fields.address ?? "").split(",").slice(0, 2).join(",").trim()
}
