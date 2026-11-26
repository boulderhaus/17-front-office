/**
 * Jobs as a board: four columns in the order a job moves (Needs reply, Waiting, Booked, Done), each card the
 * caller, the problem, when, and one next step. Pure (no imports), so the columns are tested without a browser.
 */

export type JobColumnId = "reply" | "waiting" | "booked" | "done"
export type JobTone = "danger" | "warn" | "good" | "neutral"

interface JobCall { id: string; startedAt: string; fields: { requestedStart: string | null } }
interface JobTask { callId: string; priority: string; dueAt: string; completedAt: string | null; updatedAt: string }

export interface JobCard<C> { call: C; label: string; tone: JobTone; when: string; whenLabel: string; action: "call" | null }
export interface JobColumn<C> { id: JobColumnId; title: string; empty: string; cards: Array<JobCard<C>> }

export function jobColumns<C extends JobCall, T extends JobTask>(input: {
  callsById: Map<string, C>; actionable: T[]; snoozed: T[]; booked: C[]; handled: T[]
  due: (task: T) => string; date: (iso: string) => string
}): Array<JobColumn<C>> {
  const cards = (tasks: T[], make: (task: T, call: C) => JobCard<C>) => tasks.flatMap((task) => {
    const call = input.callsById.get(task.callId)
    return call ? [make(task, call)] : []
  })
  return [
    {
      id: "reply", title: "Needs reply", empty: "Nobody is waiting on you.",
      cards: cards(input.actionable, (task, call) => {
        const urgent = task.priority === "high"
        const due = input.due(task)
        return { call, label: urgent ? "Urgent" : call.fields.requestedStart ? "Confirm time" : "Call back", tone: urgent ? "danger" : call.fields.requestedStart ? "warn" : "neutral", whenLabel: "Call back", when: due === "Due now" ? "Now" : due.replace(/^Due today /, "Today ").replace(/^Due /, ""), action: "call" }
      }),
    },
    {
      id: "waiting", title: "Waiting", empty: "Nothing set for later.",
      cards: cards(input.snoozed, (task, call) => ({ call, label: "Later", tone: "neutral", whenLabel: "Back on", when: input.date(task.dueAt), action: "call" })),
    },
    {
      id: "booked", title: "Booked", empty: "Nothing booked in the next 7 days.",
      cards: input.booked.map((call) => ({ call, label: "Booked", tone: "good", whenLabel: "Visit", when: input.date(call.fields.requestedStart!), action: null })),
    },
    {
      id: "done", title: "Done", empty: "Nothing done yet.",
      cards: cards(input.handled, (task, call) => ({ call, label: "Done", tone: "neutral", whenLabel: "Done", when: input.date(task.completedAt ?? task.updatedAt), action: null }))
        .sort((left, right) => right.call.startedAt.localeCompare(left.call.startedAt)),
    },
  ]
}

/** ?tab=: the column a phone shows. Old links (handled, complete, all) land on the nearest one. */
export function jobTab(value: string | null): JobColumnId {
  if (value === "handled" || value === "complete") return "done"
  return value === "waiting" || value === "booked" || value === "done" ? value : "reply"
}
