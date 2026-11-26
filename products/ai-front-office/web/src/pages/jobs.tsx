import { useEffect, useRef, useState } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { Clock, Phone } from "lucide-react"
import { ToneBadge } from "@/components/app/bits"
import { Button } from "@/components/ui/button"
import { derive } from "@/lib/derive"
import { callerLabel, compactDate } from "@/lib/format"
import { BOARD_CAP, cappedCards, jobColumns, jobTab, PHONE_CAP, type JobCard, type JobColumn, type JobColumnId } from "@/lib/jobs"
import { useMediaQuery, useMode } from "@/lib/mode"
import { callOrigin } from "@/lib/nav"
import type { ApiCall } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Jobs, the way Linear and Notion show a board. Computer: four columns in the order a job moves (Needs reply,
 * Waiting, Booked, Done), each headed by its count, each job a card (who, what, when, one next step).
 * Each column scrolls on its own. Phone and tablet: the same four as tabs with counts, over that column as a compact
 * list (urgent and newest first, the rest behind "Show all"), so a busy column is rows you can tell apart, not tall cards.
 */
export function JobsPage() {
  const { dashboard } = useMode()
  const [params, setParams] = useSearchParams()
  const board = useMediaQuery("(min-width: 1024px)")
  if (!dashboard) return null
  const d = derive(dashboard)
  const columns = jobColumns({ callsById: d.callsById, actionable: d.actionable, snoozed: d.snoozed, handled: d.handled, nowMs: d.nowMs, due: d.due, date: (iso) => compactDate(iso, d.tz) })
  if (board) {
    return (
      // One row as tall as the board (minmax(0,1fr)), so each column's max-h-full is a real height and its list scrolls on its own.
      <div className="grid grid-cols-4 grid-rows-[minmax(0,1fr)] items-start gap-3 lg:h-[calc(100dvh-13rem)] lg:min-h-96">
        {columns.map((column) => <BoardColumn key={column.id} column={column} />)}
      </div>
    )
  }
  const tab = jobTab(params.get("tab"))
  const shown = columns.find((column) => column.id === tab)!
  return (
    <div className="grid gap-4">
      {/* All four fit on one line on a phone (walk 11-26, APP-08): the name over its count, nothing scrolls off the edge. */}
      <div role="tablist" aria-label="Jobs" className="grid grid-cols-4 gap-1 rounded-xl bg-secondary/70 p-1">
        {columns.map((column) => {
          const active = column.id === tab
          return (
            <button key={column.id} type="button" role="tab" aria-selected={active} onClick={() => setParams({ tab: column.id }, { replace: true })}
              className={cn("flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-[13px] leading-tight font-semibold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-ink sm:text-[15px]",
                active ? "bg-brand-ink text-white" : "text-foreground/80 hover:bg-card")}>
              {column.title}
              <Count column={column} inverted={active} />
            </button>
          )
        })}
      </div>
      <Rows key={shown.id} column={shown} />
    </div>
  )
}

function Count({ column, inverted }: { column: JobColumn<ApiCall>; inverted?: boolean }) {
  const urgent = column.id === "reply" && column.cards.some((card) => card.tone === "danger")
  return (
    <span className={cn("tabular grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-[13px] font-bold",
      urgent ? "bg-red-600 text-white" : inverted ? "bg-white/20 text-white" : "bg-secondary text-foreground/80")}>{column.cards.length}</span>
  )
}

function BoardColumn({ column }: { column: JobColumn<ApiCall> }) {
  return (
    <section aria-labelledby={`col-${column.id}`} className="flex max-h-full min-h-0 min-w-0 flex-col rounded-xl bg-secondary/70">
      <h2 id={`col-${column.id}`} className="flex h-11 shrink-0 items-center gap-2 px-3.5 text-[15px] font-semibold">
        <Dot id={column.id} />{column.title}<Count column={column} />
      </h2>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2"><Cards column={column} /></div>
    </section>
  )
}

const DOTS: Record<JobColumnId, string> = { reply: "bg-red-600", waiting: "bg-amber-500", booked: "bg-emerald-600", done: "bg-stone-400" }
function Dot({ id }: { id: JobColumnId }) {
  return <i aria-hidden className={cn("size-2.5 shrink-0 rounded-full", DOTS[id])} />
}

/** Computer: a column of compact cards. */
function Cards({ column }: { column: JobColumn<ApiCall> }) {
  const { all, list, showAll } = useShowAll<HTMLUListElement>(BOARD_CAP)
  if (!column.cards.length) return <Empty column={column} />
  const { shown, hidden } = cappedCards(column.cards, BOARD_CAP, all)
  return (
    <ul ref={list} className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      {shown.map((card) => <li key={card.call.id} className="min-w-0"><Card card={card} status={column.id === "reply"} /></li>)}
      {hidden > 0 && <li><ShowAll count={column.cards.length} onClick={showAll} /></li>}
    </ul>
  )
}

/** Phone: one column as a list of compact rows, the first few, the rest behind "Show all". */
function Rows({ column }: { column: JobColumn<ApiCall> }) {
  const { all, list, showAll } = useShowAll<HTMLUListElement>(PHONE_CAP)
  if (!column.cards.length) return <Empty column={column} />
  const { shown, hidden } = cappedCards(column.cards, PHONE_CAP, all)
  return (
    <div className="grid gap-2">
      <ul ref={list} className="grid grid-cols-[minmax(0,1fr)] divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
        {shown.map((card) => <li key={card.call.id} className="min-w-0"><Row card={card} status={column.id === "reply"} /></li>)}
      </ul>
      {hidden > 0 && <ShowAll count={column.cards.length} onClick={showAll} />}
    </div>
  )
}

/** "Show all" unmounts itself, so focus moves to the first job it revealed instead of dropping to the top of the page. */
function useShowAll<E extends HTMLElement>(cap: number) {
  const [all, setAll] = useState(false)
  const list = useRef<E>(null)
  const moveFocus = useRef(false)
  useEffect(() => {
    if (!all || !moveFocus.current) return
    moveFocus.current = false
    list.current?.querySelectorAll<HTMLAnchorElement>("a[data-open]")[cap]?.focus()
  }, [all, cap])
  return { all, list, showAll: () => { moveFocus.current = true; setAll(true) } }
}

function Empty({ column }: { column: JobColumn<ApiCall> }) {
  return <p className="rounded-lg border border-dashed bg-card/60 px-3 py-4 text-center text-[15px] text-muted-foreground">{column.empty}</p>
}

function ShowAll({ count, onClick }: { count: number; onClick: () => void }) {
  return <Button type="button" variant="ghost" className="h-11 w-full text-[15px] font-semibold" onClick={onClick}>Show all {count}</Button>
}

/** What a card or row shares: where it opens, whether it can dial, and its status word (Urgent, Confirm time). */
function useJob(card: JobCard<ApiCall>, status: boolean) {
  const { base, preview } = useMode()
  const location = useLocation()
  const call = card.call
  return {
    to: `${base}/calls/${encodeURIComponent(call.id)}`,
    state: { origin: callOrigin({ base, pathname: location.pathname, search: location.search }) },
    dial: Boolean(card.action === "call" && call.phone && call.outcome !== "ignored_spam" && !preview),
    badge: status && card.label !== "Call back" ? <ToneBadge tone={card.tone} className="h-5.5 shrink-0 px-1.5 text-xs">{card.label}</ToneBadge> : null,
  }
}

const OPEN = "min-w-0 truncate font-semibold outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-brand-ink"

function When({ card }: { card: JobCard<ApiCall> }) {
  return <span className="tabular min-w-0 truncate text-sm text-muted-foreground"><span className="sr-only">{card.whenLabel}: </span>{card.when}</span>
}

/**
 * Computer card: who and status, the problem in one line, when, and one next step. The card opens the call; Call back
 * dials from the owner's phone.
 */
function Card({ card, status }: { card: JobCard<ApiCall>; status: boolean }) {
  const job = useJob(card, status)
  const call = card.call
  return (
    <article className="ph-no-capture relative grid grid-cols-[minmax(0,1fr)] gap-1 rounded-lg border bg-card px-3 py-2.5 shadow-xs transition-colors hover:border-foreground/25">
      <div className="flex min-w-0 items-center gap-2">
        <Link data-open to={job.to} state={job.state} className={cn(OPEN, "flex-1 text-[15px] after:rounded-lg")}>{callerLabel(call)}</Link>
        {job.badge}
      </div>
      <p className="truncate text-sm text-foreground/80">{call.fields.problemDescription || "No summary"}</p>
      <div className="flex min-h-8 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 truncate"><Clock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><When card={card} /></span>
        {job.dial && <CallButton call={call} className="size-11 pointer-fine:size-9" icon="size-4" />}
      </div>
    </article>
  )
}

/** Phone row: name, status and how long ago on one line, the problem under it, a round call button on the right. */
function Row({ card, status }: { card: JobCard<ApiCall>; status: boolean }) {
  const job = useJob(card, status)
  const call = card.call
  return (
    <article className="ph-no-capture relative flex min-h-16 items-center gap-3 py-2.5 pr-2.5 pl-4 transition-colors active:bg-secondary/60">
      <div className="grid min-w-0 flex-1 gap-0.5">
        {/* Wraps the time under the name only when name, status and time can't share the line (320px, long due time). */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
          <Link data-open to={job.to} state={job.state} className={cn(OPEN, "text-base")}>{callerLabel(call)}</Link>
          {job.badge}
          <span className="ml-auto flex shrink-0 pl-1"><When card={card} /></span>
        </div>
        <p className="truncate text-[15px] text-foreground/80">{call.fields.problemDescription || "No summary"}</p>
      </div>
      {job.dial && <CallButton call={call} className="size-11" icon="size-5" />}
    </article>
  )
}

/** The one next step: a round call button (Call back, said to screen readers and on hover), so a busy list stays short. */
function CallButton({ call, className, icon }: { call: ApiCall; className: string; icon: string }) {
  return (
    <a href={`tel:${call.phone}`} aria-label={`Call back ${callerLabel(call)}`} title="Call back"
      className={cn("relative z-10 grid shrink-0 place-items-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-ink", className)}>
      <Phone aria-hidden className={icon} />
    </a>
  )
}
