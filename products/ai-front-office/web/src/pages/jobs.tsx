import { Link, useLocation, useSearchParams } from "react-router-dom"
import { Clock, Phone } from "lucide-react"
import { ToneBadge } from "@/components/app/bits"
import { callLabel } from "@/components/app/call-parts"
import { derive } from "@/lib/derive"
import { compactDate } from "@/lib/format"
import { jobColumns, jobTab, type JobCard, type JobColumn, type JobColumnId } from "@/lib/jobs"
import { useMediaQuery, useMode } from "@/lib/mode"
import { callOrigin } from "@/lib/nav"
import type { ApiCall } from "@/lib/types"
import { cn } from "@/lib/utils"

/** The newest cards a column shows; Done keeps growing, the board shouldn't. */
const COLUMN_CAP = 12

/**
 * Jobs, the way Linear and Notion show a board. Computer: four columns in the order a job moves (Needs reply,
 * Waiting, Booked, Done), each headed by its count, each job a card (who, what, when, one next step).
 * Phone and tablet: the same four as a one-line tab strip that scrolls sideways, over that column's cards.
 */
export function JobsPage() {
  const { dashboard } = useMode()
  const [params, setParams] = useSearchParams()
  const board = useMediaQuery("(min-width: 1024px)")
  if (!dashboard) return null
  const d = derive(dashboard)
  const columns = jobColumns({ callsById: d.callsById, actionable: d.actionable, snoozed: d.snoozed, booked: d.booked, handled: d.handled, due: d.due, date: (iso) => compactDate(iso, d.tz) })
  if (board) {
    return (
      <div className="grid grid-cols-4 items-start gap-3">
        {columns.map((column) => <BoardColumn key={column.id} column={column} />)}
      </div>
    )
  }
  const tab = jobTab(params.get("tab"))
  const shown = columns.find((column) => column.id === tab)!
  return (
    <div className="grid gap-4">
      <div role="tablist" aria-label="Jobs" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {columns.map((column) => {
          const active = column.id === tab
          return (
            <button key={column.id} type="button" role="tab" aria-selected={active} onClick={() => setParams({ tab: column.id }, { replace: true })}
              className={cn("inline-flex h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-[15px] font-semibold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-ink",
                active ? "border-brand-ink bg-brand-ink text-white" : "bg-card text-foreground/80 hover:bg-muted")}>
              {column.title}
              <Count column={column} inverted={active} />
            </button>
          )
        })}
      </div>
      <Cards column={shown} />
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
    <section aria-labelledby={`col-${column.id}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2 rounded-xl bg-secondary/70 p-2">
      <h2 id={`col-${column.id}`} className="flex h-9 items-center gap-2 px-1.5 text-[15px] font-semibold">
        <Dot id={column.id} />{column.title}<Count column={column} />
      </h2>
      <Cards column={column} />
    </section>
  )
}

const DOTS: Record<JobColumnId, string> = { reply: "bg-red-600", waiting: "bg-amber-500", booked: "bg-emerald-600", done: "bg-stone-400" }
function Dot({ id }: { id: JobColumnId }) {
  return <i aria-hidden className={cn("size-2.5 shrink-0 rounded-full", DOTS[id])} />
}

function Cards({ column }: { column: JobColumn<ApiCall> }) {
  if (!column.cards.length) return <p className="rounded-lg border border-dashed bg-card/60 px-3 py-4 text-center text-[15px] text-muted-foreground">{column.empty}</p>
  const shown = column.cards.slice(0, COLUMN_CAP)
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
      {shown.map((card) => <li key={card.call.id} className="min-w-0"><Card card={card} status={column.id === "reply"} /></li>)}
      {column.cards.length > COLUMN_CAP && <li className="px-1.5 text-[13px] text-muted-foreground">Showing the {COLUMN_CAP} newest of {column.cards.length}.</li>}
    </ul>
  )
}

/** Who, what, when, and one next step. The card opens the call; Call back dials from the owner's phone. */
/** status: show the card's status word. Only Needs reply has more to say (Urgent, Confirm time); elsewhere it would repeat the column. */
function Card({ card, status }: { card: JobCard<ApiCall>; status: boolean }) {
  const { base, preview } = useMode()
  // A board column is ~220px: the next step gets its own full-width row under the time. A phone has room beside it.
  const board = useMediaQuery("(min-width: 1024px)")
  const location = useLocation()
  const call = card.call
  const dial = card.action === "call" && call.phone && call.outcome !== "ignored_spam" && !preview
  const badge = status ? <ToneBadge tone={card.tone} className="h-5.5 px-1.5 text-xs">{card.label}</ToneBadge> : null
  return (
    <article className="ph-no-capture relative grid grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border bg-card p-3 shadow-xs transition-colors hover:border-foreground/25">
      <div className="flex items-start justify-between gap-2">
        <Link to={`${base}/calls/${encodeURIComponent(call.id)}`} state={{ origin: callOrigin({ base, pathname: location.pathname, search: location.search }) }}
          className="min-w-0 truncate text-base font-semibold outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline-2 focus-visible:after:outline-brand-ink">
          {call.fields.callerName ?? "Unknown caller"}
        </Link>
        {/* A board column is narrow: the status sits on the time row there, so the name gets the whole line. */}
        {!board && badge}
      </div>
      <p className="line-clamp-2 text-[15px] leading-snug text-foreground/85">{call.fields.problemDescription || "No summary"}</p>
      <div className={cn("flex min-h-9 justify-between gap-2", board ? "flex-col items-stretch" : "items-center")}>
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground"><Clock className="size-3.5 shrink-0" /><span className="truncate"><span className="sr-only">{card.whenLabel}: </span>{card.when}</span></span>
          {board && badge}
        </span>
        {dial && (
          <a href={`tel:${call.phone}`} className="relative z-10 inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-ink lg:pointer-fine:h-10">
            <Phone className="size-4" />{callLabel(call)}
          </a>
        )}
      </div>
    </article>
  )
}
