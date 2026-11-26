import { useSearchParams } from "react-router-dom"
import { ChevronRight } from "lucide-react"
import { CallLink, ListBox, Muted, ToneBadge, usePage } from "@/components/app/bits"
import { CallPanel } from "./today"
import { derive, type Tone } from "@/lib/derive"
import { callerLabel, compactDate } from "@/lib/format"
import { useMediaQuery, useMode } from "@/lib/mode"
import type { ApiCall } from "@/lib/types"
import { cn } from "@/lib/utils"

interface Row { call: ApiCall; label: string; tone: Tone; when: string }

export function JobsPage() {
  const { dashboard } = useMode()
  const [params, setParams] = useSearchParams()
  const wide = useMediaQuery("(min-width: 1024px)")
  const d = dashboard ? derive(dashboard) : null
  const rows = (items: Array<Row | null>): Row[] => items.filter((item): item is Row => item !== null)
  const lists: Array<{ id: string; title: string; empty: string; whenLabel: string; rows: Row[] }> = d ? [
    { id: "reply", title: "Needs reply", whenLabel: "Call back by", empty: "Nobody is waiting on a reply.", rows: rows(d.actionable.map((task) => { const call = d.callsById.get(task.callId); return call ? { call, label: task.priority === "high" ? "Urgent" : call.fields.requestedStart ? "Confirm time" : "Call back", tone: task.priority === "high" ? "danger" : call.fields.requestedStart ? "warn" : "neutral", when: d.due(task) === "Due now" ? "Now" : d.due(task).replace(/^Due today /, "Today ").replace(/^Due /, "") } : null })) },
    { id: "waiting", title: "Waiting", whenLabel: "Back on", empty: "Nothing set for later.", rows: rows(d.snoozed.map((task) => { const call = d.callsById.get(task.callId); return call ? { call, label: "Later", tone: "neutral", when: compactDate(task.dueAt, d.tz) } : null })) },
    { id: "booked", title: "Booked", whenLabel: "Visit", empty: "No booked visits in the next 7 days.", rows: d.booked.map((call) => ({ call, label: "Booked", tone: "good" as Tone, when: compactDate(call.fields.requestedStart!, d.tz) })) },
    { id: "complete", title: "Done", whenLabel: "Done", empty: "Nothing done yet.", rows: rows(d.handled.map((task) => { const call = d.callsById.get(task.callId); return call ? { call, label: "Done", tone: "neutral", when: compactDate(task.completedAt ?? task.updatedAt, d.tz) } : null })) },
  ] : []
  // All: every job once, newest call first, with the status it has in its own list.
  const seen = new Set<string>()
  const all = lists.flatMap((list) => list.rows).filter((row) => (seen.has(row.call.id) ? false : (seen.add(row.call.id), true)))
    .sort((left, right) => right.call.startedAt.localeCompare(left.call.startedAt))
  const columns = d ? [{ id: "all", title: "All", whenLabel: "Date", empty: "No jobs yet. Calls that need you show up here.", rows: all.map((row) => ({ ...row, when: compactDate(row.call.startedAt, d.tz) })) }, ...lists] : []
  const tab = columns.find((column) => column.id === (params.get("tab") === "handled" ? "complete" : params.get("tab") ?? "reply")) ?? columns[1]
  if (!dashboard || !d || !tab) return null
  const selectedId = params.get("call")
  // Wide screens: the open job sits on the right; the first row opens by default so the pane is never empty.
  const selected = (selectedId ? d.callsById.get(selectedId) : null) ?? (wide ? tab.rows[0]?.call ?? null : null)
  const pick = (id: string) => setParams({ tab: id }, { replace: true })
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start xl:grid-cols-[minmax(0,1fr)_440px]">
      <section className="grid min-w-0 content-start gap-4">
        {/* Five equal tiles: the count is the overview, the tap is the filter. Never scrolls sideways. */}
        <div role="tablist" aria-label="Jobs" className="grid grid-cols-5 gap-1 rounded-xl bg-secondary p-1">
          {columns.map((column) => {
            const active = column.id === tab.id
            return (
              <button key={column.id} role="tab" aria-selected={active} type="button" onClick={() => pick(column.id)}
                className={cn("grid min-h-16 content-center justify-items-center gap-0.5 rounded-lg px-1 text-center", active ? "bg-card shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-card/60")}>
                <strong className={cn("tabular text-[22px] leading-none font-semibold", active && "text-foreground", column.id === "reply" && column.rows.some((row) => row.tone === "danger") && "text-red-700")}>{column.rows.length}</strong>
                <span className="max-w-full text-[13px] leading-tight font-semibold">{column.title}</span>
              </button>
            )
          })}
        </div>
        <JobList key={tab.id} tab={tab} selectedId={selected?.id ?? null} />
      </section>
      <aside className="max-lg:hidden lg:sticky lg:top-8">
        {/* An empty tab in a shop with calls: nothing to open, and never "No calls yet". */}
        <CallPanel call={selected} task={selected ? d.taskFor(selected.id) : undefined} tz={d.tz} standalone={false} hasCalls={dashboard.calls.length > 0} />
      </aside>
    </div>
  )
}

function JobList({ tab, selectedId }: { tab: { empty: string; whenLabel: string; rows: Row[] }; selectedId: string | null }) {
  const { rows: page, pager } = usePage(tab.rows)
  if (tab.rows.length === 0) return <ListBox><Muted>{tab.empty}</Muted></ListBox>
  return (
    <>
      {/* The table's columns need about 40rem; narrower (a phone, or beside the open job) each job is a two-line row. */}
      <ListBox className="@container">
        <div className="hidden grid-cols-[minmax(0,10rem)_minmax(0,1fr)_7.5rem_8.5rem] gap-4 bg-muted/60 px-4 py-2.5 text-[13px] font-semibold text-muted-foreground @[40rem]:grid">
          <span>Caller</span><span>Problem</span><span>Status</span><span className="text-right">{tab.whenLabel}</span>
        </div>
        {page.map((row) => (
          <CallLink key={row.call.id} callId={row.call.id} aria-current={selectedId === row.call.id}
            className={cn("grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-3 hover:bg-muted/50 @[40rem]:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_7.5rem_8.5rem] @[40rem]:gap-4", selectedId === row.call.id && "bg-accent hover:bg-accent")}>
            <strong className="truncate text-base font-semibold">{callerLabel(row.call)}</strong>
            <span className="order-3 truncate text-[15px] text-muted-foreground @[40rem]:order-none">{row.call.fields.problemDescription || "No summary"}</span>
            <span className="order-2 justify-self-end @[40rem]:order-none @[40rem]:justify-self-start"><ToneBadge tone={row.tone}>{row.label}</ToneBadge></span>
            <span className="order-4 flex items-center justify-end gap-1 text-right text-sm text-muted-foreground @[40rem]:order-none">
              <span className="tabular">{row.when}</span><ChevronRight className="size-4 lg:hidden" />
            </span>
          </CallLink>
        ))}
      </ListBox>
      {pager}
    </>
  )
}
