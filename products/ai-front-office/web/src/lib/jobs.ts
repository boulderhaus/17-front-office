/**
 * Jobs as a board: four columns in the order a job moves (Needs reply, Waiting, Booked, Done), each card the
 * caller, the problem, when, and one next step. Pure (no imports), so the columns are tested without a browser.
 */

export type JobColumnId = "reply" | "waiting" | "booked" | "done"
export type JobTone = "danger" | "warn" | "good" | "neutral"

interface JobCall { id: string; startedAt: string; outcome: string; fields: { requestedStart: string | null } }
interface JobTask { callId: string; priority: string; dueAt: string; completedAt: string | null; updatedAt: string }

export interface JobCard<C> { call: C; label: string; tone: JobTone; when: string; whenLabel: string; action: "call" | null; sortAt: string }
export interface JobColumn<C> { id: JobColumnId; title: string; empty: string; cards: Array<JobCard<C>> }

/**
 * Every job lands in exactly one column. A call with a follow-up still open is in Needs reply or Waiting, even if
 * it was booked; a booked visit still ahead (however far) is in Booked; a visit that has passed, or a follow-up
 * the owner closed, is in Done, newest first.
 */
export function jobColumns<C extends JobCall, T extends JobTask>(input: {
  callsById: Map<string, C>; actionable: T[]; snoozed: T[]; handled: T[]; nowMs: number
  due: (task: T) => string; date: (iso: string) => string
}): Array<JobColumn<C>> {
  const cards = (tasks: T[], make: (task: T, call: C) => JobCard<C>) => tasks.flatMap((task) => {
    const call = input.callsById.get(task.callId)
    return call ? [make(task, call)] : []
  })
  const reply = cards(input.actionable, (task, call) => {
    const urgent = task.priority === "high"
    const due = input.due(task)
    return { call, label: urgent ? "Urgent" : call.fields.requestedStart ? "Confirm time" : "Call back", tone: urgent ? "danger" : call.fields.requestedStart ? "warn" : "neutral", whenLabel: "Call back", when: due === "Due now" ? "Now" : due.replace(/^Due today /, "Today ").replace(/^Due /, ""), action: "call", sortAt: task.dueAt } as JobCard<C>
  })
  const waiting = cards(input.snoozed, (task, call) => ({ call, label: "Later", tone: "neutral", whenLabel: "Back on", when: input.date(task.dueAt), action: "call", sortAt: task.dueAt }))
  const open = new Set([...reply, ...waiting].map((card) => card.call.id))
  const bookedCalls = [...input.callsById.values()].filter((call) => call.outcome === "booked" && !open.has(call.id))
  const ahead = (call: C) => Boolean(call.fields.requestedStart) && Date.parse(call.fields.requestedStart!) >= input.nowMs
  const booked = bookedCalls.filter(ahead)
    .map((call): JobCard<C> => ({ call, label: "Booked", tone: "good", whenLabel: "Visit", when: input.date(call.fields.requestedStart!), action: null, sortAt: call.fields.requestedStart! }))
    .sort((left, right) => left.sortAt.localeCompare(right.sortAt))
  const visited = bookedCalls.filter((call) => !ahead(call))
    .map((call): JobCard<C> => ({ call, label: "Done", tone: "neutral", whenLabel: "Visit", when: input.date(call.fields.requestedStart ?? call.startedAt), action: null, sortAt: call.fields.requestedStart ?? call.startedAt }))
  const closed = cards(input.handled.filter((task) => !open.has(task.callId)), (task, call) => ({ call, label: "Done", tone: "neutral", whenLabel: "Done", when: input.date(task.completedAt ?? task.updatedAt), action: null, sortAt: task.completedAt ?? task.updatedAt }))
  const done = [...new Map([...visited, ...closed].map((card) => [card.call.id, card])).values()].sort((left, right) => right.sortAt.localeCompare(left.sortAt))
  return [
    { id: "reply", title: "Needs reply", empty: "Nobody is waiting on you.", cards: reply },
    { id: "waiting", title: "Waiting", empty: "Nothing set for later.", cards: waiting },
    { id: "booked", title: "Booked", empty: "Nothing booked yet.", cards: booked },
    { id: "done", title: "Done", empty: "Nothing done yet.", cards: done },
  ]
}

/** ?tab=: the column a phone shows. Old links (handled, complete, all) land on the nearest one. */
export function jobTab(value: string | null): JobColumnId {
  if (value === "handled" || value === "complete") return "done"
  return value === "waiting" || value === "booked" || value === "done" ? value : "reply"
}
