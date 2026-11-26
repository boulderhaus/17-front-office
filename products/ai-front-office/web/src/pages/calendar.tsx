import { useRef, type ReactNode } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ChevronLeft, ChevronRight, Settings2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CallLink } from "@/components/app/bits"
import { CallPanel } from "./today"
import { derive } from "@/lib/derive"
import { callerLabel, dateKey, timeOnly } from "@/lib/format"
import { useMediaQuery, useMode } from "@/lib/mode"
import { JUMP } from "@/lib/nav"
import { layoutVisits, VISIT_MIN_SPAN } from "@/lib/calendar-layout"
import type { ApiCall } from "@/lib/types"
import { cn } from "@/lib/utils"

type View = "day" | "week" | "month"

/* Civil dates ("2026-11-23") in the shop's time zone; arithmetic in UTC so daylight saving never shifts a day. */
const toUtc = (key: string) => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y!, m! - 1, d!)) }
const keyOf = (date: Date) => date.toISOString().slice(0, 10)
const addDays = (key: string, days: number) => { const date = toUtc(key); date.setUTCDate(date.getUTCDate() + days); return keyOf(date) }
const weekday = (key: string) => toUtc(key).getUTCDay()
const startOfWeek = (key: string) => addDays(key, -weekday(key))
const fmt = (key: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(toUtc(key))
function minutesIn(value: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(value))
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0)
}

/** "9a", "1:30p": fits a seventh of a phone screen. */
const shortTime = (minutes: number) => `${Math.floor(minutes / 60) % 12 || 12}${minutes % 60 ? `:${String(minutes % 60).padStart(2, "0")}` : ""}${minutes < 720 ? "a" : "p"}`

/** booked: on the calendar. confirm: the caller asked for this time and nobody has called back yet. done: handled. */
type VisitState = "booked" | "confirm" | "done"
interface Visit { call: ApiCall; day: string; minutes: number; state: VisitState }

// "Call to confirm" also has a dashed edge, so it differs from booked by shape, not only color.
const BLOCK: Record<VisitState, string> = { booked: "border-emerald-600 bg-emerald-100 text-emerald-950", confirm: "border-dashed border-amber-600 bg-amber-100 text-amber-950", done: "border-stone-400 bg-stone-100 text-stone-700" }
/** Not by color alone: a mark before the name says the same thing. */
const MARK: Record<VisitState, string> = { booked: "✓", confirm: "?", done: "✓" }
const STATE_WORD: Record<VisitState, string> = { booked: "Booked", confirm: "Call to confirm", done: "Done" }

/** Computer: the page header's one action. A phone shows the same link as a row under the calendar, with Google's state. */
export function CalendarHeaderActions() {
  const { base, member, preview, dashboard } = useMode()
  const wide = useMediaQuery("(min-width: 1024px)")
  // Not until the dashboard says who is looking (a team member never gets a Settings link), and not in the demo (no Settings there).
  if (!dashboard || member || preview || !wide) return null
  return <Link to={`${base}/settings/calendar`} state={JUMP} className="inline-flex h-11 items-center gap-2 rounded-lg border bg-card px-3 text-[15px] font-semibold hover:bg-muted"><Settings2 className="size-4" />Hours and Google Calendar</Link>
}

export function CalendarPage() {
  const { dashboard, base, member, preview } = useMode()
  const [params, setParams] = useSearchParams()
  const wide = useMediaQuery("(min-width: 1024px)")
  // A phone opens on one day (a week of columns is too cramped there); a computer opens on the week.
  const phone = useMediaQuery("(max-width: 767px)")
  const touch = useRef<{ x: number; y: number } | null>(null)
  if (!dashboard) return null
  const d = derive(dashboard)
  const today = dateKey(new Date(d.nowMs), d.tz)
  // The demo opens on the week, so its visits show on a phone too (its day can be empty).
  const view: View = (["day", "week", "month"] as View[]).find((item) => item === params.get("view")) ?? (phone && !preview ? "day" : "week")
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? params.get("date")! : today
  const selected = params.get("call") ? d.callsById.get(params.get("call")!) ?? null : null
  const visits: Visit[] = dashboard.calls
    .filter((call) => call.fields.requestedStart && call.outcome !== "ignored_spam")
    .map((call) => ({ call, day: dateKey(new Date(call.fields.requestedStart!), d.tz), minutes: minutesIn(call.fields.requestedStart!, d.tz), state: (call.outcome === "booked" ? "booked" : d.taskFor(call.id)?.status === "completed" ? "done" : "confirm") as VisitState }))
    .sort((left, right) => left.call.fields.requestedStart!.localeCompare(right.call.fields.requestedStart!))
  const go = (next: { view?: View; date?: string }) => {
    const search = new URLSearchParams(params)
    if (next.view) search.set("view", next.view)
    if (next.date) search.set("date", next.date)
    search.delete("call")
    setParams(search, { replace: true })
  }
  const step = (direction: 1 | -1) => {
    if (view === "day") return go({ date: addDays(anchor, direction) })
    if (view === "week") return go({ date: addDays(anchor, 7 * direction) })
    const date = toUtc(anchor)
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() + direction)
    return go({ date: keyOf(date) })
  }
  const weekStart = startOfWeek(anchor)
  const title = view === "day" ? fmt(anchor, { weekday: "short", month: "short", day: "numeric" })
    : view === "week" ? `${fmt(weekStart, { month: "short", day: "numeric" })} – ${fmt(addDays(weekStart, 6), fmt(weekStart, { month: "short" }) === fmt(addDays(weekStart, 6), { month: "short" }) ? { day: "numeric" } : { month: "short", day: "numeric" })}`
    : fmt(anchor, { month: "long", year: "numeric" })
  const close = () => { const search = new URLSearchParams(params); search.delete("call"); setParams(search, { replace: true }) }
  return (
    <div className={cn("grid grid-cols-1 gap-6", selected && "lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start xl:grid-cols-[minmax(0,1fr)_440px]")}>
      <section className="grid min-w-0 content-start gap-3">
        {/* Not connected yet: the way to connect sits at the top, where people look first. */}
        {!member && !preview && !dashboard.googleConnected && dashboard.googleAvailable && (
          <div className="grid gap-3 rounded-xl border bg-card px-4 py-3 sm:flex sm:items-center sm:justify-between">
            <span className="grid"><strong className="text-base font-semibold">Put jobs on your Google Calendar</strong><span className="text-sm text-muted-foreground">Otto checks when you’re busy and adds the jobs you confirm.</span></span>
            <Button size="tap" variant="brand" className="w-full sm:w-auto" asChild><a href="/app/integrations/google/start">Connect Google Calendar</a></Button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
          <div className="flex items-center gap-1.5">
            <button type="button" aria-label="Previous" onClick={() => step(-1)} className="grid size-11 shrink-0 place-items-center rounded-lg border bg-card hover:bg-muted"><ChevronLeft className="size-5" /></button>
            <button type="button" aria-label="Next" onClick={() => step(1)} className="grid size-11 shrink-0 place-items-center rounded-lg border bg-card hover:bg-muted"><ChevronRight className="size-5" /></button>
            <button type="button" onClick={() => go({ date: today })} disabled={anchor === today} className="h-11 shrink-0 rounded-lg border bg-card px-3.5 text-[15px] font-semibold hover:bg-muted disabled:opacity-50">Today</button>
            <h2 className="tabular ml-2 text-lg font-semibold tracking-tight">{title}</h2>
          </div>
          <div className="flex items-center gap-2 max-sm:w-full">
            <div role="tablist" aria-label="Calendar view" className="grid grid-cols-3 gap-1 rounded-lg bg-secondary p-1 max-sm:flex-1">
              {(["day", "week", "month"] as View[]).map((item) => (
                <button key={item} role="tab" aria-selected={view === item} type="button" onClick={() => go({ view: item })}
                  // 44px tall: a full-size target, like every other control.
                  className={cn("h-11 rounded-md px-4 text-[15px] font-semibold capitalize", view === item ? "bg-card shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-card/60")}>{item}</button>
              ))}
            </div>
          </div>
        </div>

        <div
          onTouchStart={(event) => { const point = event.touches[0]!; touch.current = { x: point.clientX, y: point.clientY } }}
          onTouchEnd={(event) => {
            const start = touch.current; touch.current = null
            const point = event.changedTouches[0]
            if (!start || !point) return
            const dx = point.clientX - start.x
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(point.clientY - start.y) * 1.5) step(dx < 0 ? 1 : -1)
          }}
        >
          {view === "month"
            ? <MonthGrid anchor={anchor} today={today} visits={visits} wide={wide} onDay={(day) => go({ view: "day", date: day })} selectedId={selected?.id ?? null} />
            : view === "week" && phone ? <WeekList days={Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))} today={today} visits={visits} tz={d.tz} onDay={(day) => go({ view: "day", date: day })} />
            : <TimeGrid days={view === "day" ? [anchor] : Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))} today={today} visits={visits} tz={d.tz} nowMs={d.nowMs} detailed={view === "day" || wide} selectedId={selected?.id ?? null} onDay={(day) => go({ view: "day", date: day })} />}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-2"><i aria-hidden className="grid size-4 place-items-center rounded-sm bg-emerald-500 text-[11px] font-bold text-white not-italic">✓</i>Booked</span>
          <span className="inline-flex items-center gap-2"><i aria-hidden className="grid size-4 place-items-center rounded-sm bg-amber-400 text-[11px] font-bold text-amber-950 not-italic">?</i>Call to confirm, then tap Done</span>
          {visits.some((visit) => visit.state === "done") && <span className="inline-flex items-center gap-2"><i aria-hidden className="grid size-4 place-items-center rounded-sm bg-stone-300 text-[11px] font-bold text-stone-700 not-italic">✓</i>Done</span>}
        </div>
        {/* A jump into Settings: its "‹ Settings" goes to Settings, not back here. */}
        {!member && !preview && <Link to={`${base}/settings/calendar`} state={JUMP} className="flex min-h-14 items-center justify-between gap-3 rounded-xl border bg-card px-4 py-2.5 lg:hidden">
          <span className="grid"><strong className="text-base font-semibold">Hours and Google Calendar</strong><span className="text-sm text-muted-foreground">{dashboard.googleConnected ? "Google Calendar connected" : dashboard.googleAvailable ? "Google Calendar not connected" : "Appointment hours and booking"}</span></span>
          <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
        </Link>}
      </section>
      {selected && (
        <aside className="max-lg:hidden lg:sticky lg:top-8">
          <div className="mb-2 flex justify-end"><button type="button" onClick={close} className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-[15px] font-semibold hover:bg-muted"><X className="size-4" />Close</button></div>
          <CallPanel call={selected} task={d.taskFor(selected.id)} tz={d.tz} standalone={false} />
        </aside>
      )}
    </div>
  )
}

function DayNumber({ day, today, className }: { day: string; today: boolean; className?: string }) {
  return <span className={cn("tabular grid size-8 place-items-center rounded-full text-[15px] font-semibold", today && "bg-brand-yellow text-brand-ink", className)}>{fmt(day, { day: "numeric" })}</span>
}

const HOUR = 52
/** Minutes a Day block needs for its third line, the problem: 68/60 x 52px - 3 = 56px for 8 + 15 + 16.25 + 16.25. */
const THREE_LINES = 68

/** Day and Week: a time grid like Google Calendar, today's column tinted, a line at the current time. */
function TimeGrid({ days, today, visits, tz, nowMs, detailed, selectedId, onDay }: { days: string[]; today: string; visits: Visit[]; tz: string; nowMs: number; detailed: boolean; selectedId: string | null; onDay: (day: string) => void }) {
  const shown = visits.filter((visit) => days.includes(visit.day))
  const first = Math.min(7, ...shown.map((visit) => Math.floor(visit.minutes / 60)))
  const last = Math.max(19, ...shown.map((visit) => Math.ceil(visit.minutes / 60) + 1))
  const hours = Array.from({ length: last - first }, (_, index) => first + index)
  const nowMinutes = minutesIn(new Date(nowMs).toISOString(), tz)
  const single = days.length === 1
  const cols = { gridTemplateColumns: `3rem repeat(${days.length}, minmax(0, 1fr))` }
  // A block shows 1.5 hours (1.2 in a phone's week), shorter when the next visit starts sooner; closer visits sit side by side.
  const placed = (day: string) => {
    const mine = shown.filter((visit) => visit.day === day).sort((left, right) => left.minutes - right.minutes)
    const slots = layoutVisits(mine.map((visit) => visit.minutes), detailed ? 90 : 72, VISIT_MIN_SPAN)
    return mine.map((visit, index) => ({ visit, slot: slots[index]! }))
  }
  // A phone's week: side-by-side lanes in a 30-40px column would be slivers, so visits that share the column show as
  // one block ("+1") that opens the day, where they sit side by side at full width.
  const shared = (items: ReturnType<typeof placed>) => {
    const groups = new Map<number, ReturnType<typeof placed>>()
    for (const item of items) if (!detailed && item.slot.lanes > 1) groups.set(item.slot.group, [...(groups.get(item.slot.group) ?? []), item])
    return [...groups.values()]
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className={cn("grid border-b", single && "hidden")} style={cols}>
        <span />
        {days.map((day) => (
          <button key={day} type="button" onClick={() => onDay(day)} disabled={single} className={cn("grid justify-items-center gap-0.5 border-l py-2 disabled:cursor-default", day === today && "bg-brand-yellow/15")}>
            <span className={cn("text-[12px] font-semibold uppercase", day === today ? "text-brand-ink" : "text-muted-foreground")}>{fmt(day, { weekday: single ? "long" : "short" })}</span>
            <DayNumber day={day} today={day === today} />
          </button>
        ))}
      </div>
      {single && !shown.length && <p className="border-b px-4 py-3 text-[15px] text-muted-foreground">Nothing booked or requested {days[0] === today ? "today" : "this day"}.</p>}
      {/* pt-3: room for the first hour's label above its line. */}
      <div className="relative grid pt-3" style={cols}>
        <div>{hours.map((hour) => <div key={hour} style={{ height: HOUR }} className="relative"><span className="tabular absolute -top-2.5 right-2 text-[12px] font-medium text-muted-foreground">{`${hour % 12 || 12}${hour < 12 ? "a" : "p"}`}</span></div>)}</div>
        {days.map((day) => (
          <div key={day} className={cn("relative border-l", day === today && "bg-brand-yellow/10")}>
            {hours.map((hour) => <div key={hour} style={{ height: HOUR }} className="border-t border-border/70" />)}
            {day === today && nowMinutes >= first * 60 && nowMinutes <= last * 60 && (
              <span aria-hidden className="absolute inset-x-0 z-10 h-0.5 bg-red-600" style={{ top: ((nowMinutes - first * 60) / 60) * HOUR }}><i className="absolute -top-1 -left-1 size-2.5 rounded-full bg-red-600" /></span>
            )}
            {/* auto-rows-max: each line keeps its height and a short block clips at its foot, instead of the lines squeezing into each other. */}
            {placed(day).filter(({ slot }) => detailed || slot.lanes === 1).map(({ visit, slot }) => (
              <CallLink key={visit.call.id} callId={visit.call.id} aria-current={selectedId === visit.call.id}
                aria-label={`${callerLabel(visit.call)}, ${timeOnly(visit.call.fields.requestedStart!, tz)}, ${STATE_WORD[visit.state]}`}
                className={cn("absolute z-20 grid auto-rows-max content-start overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-left leading-tight", BLOCK[visit.state], selectedId === visit.call.id && "ring-2 ring-brand-ink")}
                style={{ top: ((slot.start - first * 60) / 60) * HOUR + 1, height: ((slot.end - slot.start) / 60) * HOUR - 3, left: `calc(${(slot.lane / slot.lanes) * 100}% + 2px)`, width: `calc(${100 / slot.lanes}% - 4px)` }}>
                <span className="tabular truncate text-[12px] font-semibold">{detailed && <span aria-hidden>{MARK[visit.state]} </span>}{detailed ? timeOnly(visit.call.fields.requestedStart!, tz) : shortTime(visit.minutes)}</span>
                {detailed ? (
                  <>
                    <strong className="truncate text-[13px] font-semibold">{callerLabel(visit.call)}</strong>
                    {single && slot.end - slot.start >= THREE_LINES && <span className="truncate text-[13px]">{visit.call.fields.problemDescription}</span>}
                  </>
                ) : <span className="truncate text-[11px]">{(visit.call.fields.callerName ?? "Caller").split(" ")[0]}</span>}
              </CallLink>
            ))}
            {shared(placed(day)).map((group) => {
              const start = group[0]!.slot.start
              const end = Math.max(...group.map(({ slot }) => slot.end))
              const state: VisitState = group.every(({ visit }) => visit.state === "booked") ? "booked" : group.some(({ visit }) => visit.state === "confirm") ? "confirm" : "done"
              return (
                <button key={group[0]!.visit.call.id} type="button" onClick={() => onDay(day)} aria-label={`${group.length} visits from ${shortTime(start)}. Open ${fmt(day, { weekday: "long", month: "long", day: "numeric" })}`}
                  className={cn("absolute z-20 grid auto-rows-max content-start overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-left leading-tight", BLOCK[state], group.some(({ visit }) => visit.call.id === selectedId) && "ring-2 ring-brand-ink")}
                  style={{ top: ((start - first * 60) / 60) * HOUR + 1, height: ((end - start) / 60) * HOUR - 3, left: 2, width: "calc(100% - 4px)" }}>
                  <span className="tabular text-[12px] font-semibold">{shortTime(start)}</span>
                  <span className="truncate text-[11px]">{(group[0]!.visit.call.fields.callerName ?? "Caller").split(" ")[0]}</span>
                  <span className="text-[11px] font-semibold">+{group.length - 1}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Month: every day of the month, today circled; tap a day to open it. */
function MonthGrid({ anchor, today, visits, wide, onDay, selectedId }: { anchor: string; today: string; visits: Visit[]; wide: boolean; onDay: (day: string) => void; selectedId: string | null }) {
  const monthStart = `${anchor.slice(0, 7)}-01`
  const gridStart = startOfWeek(monthStart)
  const month = anchor.slice(0, 7)
  const daysInMonth = new Date(Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 0)).getUTCDate()
  const weeks = Math.ceil((weekday(monthStart) + daysInMonth) / 7)
  const days = Array.from({ length: weeks * 7 }, (_, index) => addDays(gridStart, index))
  const cell = (day: string): ReactNode => {
    const items = visits.filter((visit) => visit.day === day)
    const outside = day.slice(0, 7) !== month
    return (
      <div key={day} className={cn("relative grid min-h-20 content-start gap-1 border-t border-l p-1 first:border-l-0 lg:min-h-28 lg:p-1.5 [&:nth-child(7n+1)]:border-l-0", outside && "bg-muted/40", day === today && "bg-brand-yellow/10")}>
        {/* Phone and tablet: the whole day is the tap target, not just its 28px number. */}
        <button type="button" onClick={() => onDay(day)} className={cn("justify-self-center lg:justify-self-start", !wide && "after:absolute after:inset-0")} aria-label={fmt(day, { weekday: "long", month: "long", day: "numeric" })}>
          <DayNumber day={day} today={day === today} className={cn(outside && "text-muted-foreground", "size-7 text-sm")} />
        </button>
        {wide ? items.slice(0, 3).map((visit) => (
          <CallLink key={visit.call.id} callId={visit.call.id} aria-current={selectedId === visit.call.id}
            aria-label={`${visit.call.fields.callerName ?? "Caller"}, ${STATE_WORD[visit.state]}`}
            className={cn("truncate rounded px-1.5 py-0.5 text-[12px] font-medium", BLOCK[visit.state], selectedId === visit.call.id && "ring-2 ring-brand-ink")}>
            <span aria-hidden>{MARK[visit.state]} </span>{visit.call.fields.callerName ?? "Caller"}
          </CallLink>
        )) : items.length > 0 && (
          <button type="button" onClick={() => onDay(day)} className="flex flex-wrap justify-center gap-1" aria-label={`${items.length} visits: ${items.map((visit) => STATE_WORD[visit.state]).join(", ")}`}>
            {/* Shape as well as color: booked is a filled dot, "call to confirm" a ring, done a grey dot. */}
            {items.slice(0, 3).map((visit) => <i key={visit.call.id} className={cn("size-2.5 rounded-full", visit.state === "booked" ? "bg-emerald-600" : visit.state === "confirm" ? "border-2 border-amber-600 bg-transparent" : "bg-stone-400")} />)}
          </button>
        )}
        {wide && items.length > 3 && <button type="button" onClick={() => onDay(day)} className="text-left text-[12px] font-semibold text-muted-foreground">{items.length - 3} more</button>}
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="grid grid-cols-7">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name) => <span key={name} className="py-2 text-center text-[12px] font-semibold text-muted-foreground uppercase">{name}</span>)}
      </div>
      <div className="grid grid-cols-7">{days.map(cell)}</div>
    </div>
  )
}

/**
 * A phone's week: seven columns of 40px cut every name to "Mo…", so it is a list instead. One row per day, today
 * marked, each visit its time, name and state; a day with nothing says so. Tap a day to open it.
 */
function WeekList({ days, today, visits, tz, onDay }: { days: string[]; today: string; visits: Visit[]; tz: string; onDay: (day: string) => void }) {
  return (
    <ol className="divide-y overflow-hidden rounded-xl border bg-card">
      {days.map((day) => {
        const items = visits.filter((visit) => visit.day === day)
        const now = day === today
        return (
          <li key={day} className={cn(now && "bg-brand-yellow/10")}>
            <button type="button" onClick={() => onDay(day)} aria-label={`Open ${fmt(day, { weekday: "long", month: "long", day: "numeric" })}`}
              className="flex min-h-14 w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-ink">
              <span className="grid w-11 shrink-0 justify-items-center pt-0.5">
                <span className={cn("text-[12px] font-semibold uppercase", now ? "text-brand-ink" : "text-muted-foreground")}>{fmt(day, { weekday: "short" })}</span>
                <DayNumber day={day} today={now} />
              </span>
              <span className="grid min-w-0 flex-1 content-center gap-1.5 self-center">
                {items.length === 0 ? <span className="text-[15px] text-muted-foreground">Nothing booked</span> : items.map((visit) => (
                  <span key={visit.call.id} className={cn("ph-no-capture flex min-w-0 items-center gap-2 rounded-md border-l-[3px] px-2 py-1.5 text-[15px]", BLOCK[visit.state])}>
                    <span aria-hidden className="text-[13px] font-bold">{MARK[visit.state]}</span>
                    <span className="tabular shrink-0 font-semibold">{timeOnly(visit.call.fields.requestedStart!, tz)}</span>
                    <span className="truncate">{callerLabel(visit.call)}</span>
                    <span className="sr-only">, {STATE_WORD[visit.state]}</span>
                  </span>
                ))}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
