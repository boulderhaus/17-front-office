import { useRef, type ReactNode } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ChevronLeft, ChevronRight, Settings2, X } from "lucide-react"
import { CallLink } from "@/components/app/bits"
import { CallPanel } from "./today"
import { derive } from "@/lib/derive"
import { dateKey, timeOnly } from "@/lib/format"
import { useMediaQuery, useMode } from "@/lib/mode"
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

interface Visit { call: ApiCall; day: string; minutes: number; booked: boolean }

/** Computer: the page header's one action. A phone shows the same link as a row under the calendar, with Google's state. */
export function CalendarHeaderActions() {
  const { base, member, preview, dashboard } = useMode()
  const wide = useMediaQuery("(min-width: 1024px)")
  // Not until the dashboard says who is looking (a team member never gets a Settings link), and not in the demo (no Settings there).
  if (!dashboard || member || preview || !wide) return null
  return <Link to={`${base}/settings/calendar`} className="inline-flex h-11 items-center gap-2 rounded-lg border bg-card px-3 text-[15px] font-semibold hover:bg-muted"><Settings2 className="size-4" />Hours and Google Calendar</Link>
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
  const view: View = (["day", "week", "month"] as View[]).find((item) => item === params.get("view")) ?? (phone ? "day" : "week")
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? params.get("date")! : today
  const selected = params.get("call") ? d.callsById.get(params.get("call")!) ?? null : null
  const visits: Visit[] = dashboard.calls
    .filter((call) => call.fields.requestedStart && call.outcome !== "ignored_spam")
    .map((call) => ({ call, day: dateKey(new Date(call.fields.requestedStart!), d.tz), minutes: minutesIn(call.fields.requestedStart!, d.tz), booked: call.outcome === "booked" }))
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
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
          <div className="flex items-center gap-1.5">
            <button type="button" aria-label="Previous" onClick={() => step(-1)} className="grid size-11 place-items-center rounded-lg border bg-card hover:bg-muted"><ChevronLeft className="size-5" /></button>
            <button type="button" aria-label="Next" onClick={() => step(1)} className="grid size-11 place-items-center rounded-lg border bg-card hover:bg-muted"><ChevronRight className="size-5" /></button>
            <button type="button" onClick={() => go({ date: today })} disabled={anchor === today} className="h-11 rounded-lg border bg-card px-3.5 text-[15px] font-semibold hover:bg-muted disabled:opacity-50">Today</button>
            <h2 className="tabular ml-2 text-lg font-semibold tracking-tight">{title}</h2>
          </div>
          <div className="flex items-center gap-2 max-sm:w-full">
            <div role="tablist" aria-label="Calendar view" className="grid grid-cols-3 gap-1 rounded-lg bg-secondary p-1 max-sm:flex-1">
              {(["day", "week", "month"] as View[]).map((item) => (
                <button key={item} role="tab" aria-selected={view === item} type="button" onClick={() => go({ view: item })}
                  className={cn("h-9 rounded-md px-4 text-[15px] font-semibold capitalize", view === item ? "bg-card shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-card/60")}>{item}</button>
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
            : <TimeGrid days={view === "day" ? [anchor] : Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))} today={today} visits={visits} tz={d.tz} nowMs={d.nowMs} detailed={view === "day" || wide} selectedId={selected?.id ?? null} onDay={(day) => go({ view: "day", date: day })} />}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-2"><i className="size-3 rounded-sm bg-emerald-500" />Booked</span>
          <span className="inline-flex items-center gap-2"><i className="size-3 rounded-sm bg-amber-400" />Caller asked for this time. Confirm it.</span>
        </div>
        {!member && !preview && <Link to={`${base}/settings/calendar`} className="flex min-h-14 items-center justify-between gap-3 rounded-xl border bg-card px-4 py-2.5 lg:hidden">
          <span className="grid"><strong className="text-base font-semibold">Hours and Google Calendar</strong><span className="text-sm text-muted-foreground">{dashboard.googleConnected ? "Google Calendar connected" : dashboard.googleAvailable ? "Google Calendar not connected" : "Appointment hours and booking"}</span></span>
          <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
        </Link>}
      </section>
      {selected && (
        <aside className="max-lg:hidden lg:sticky lg:top-8">
          <div className="mb-2 flex justify-end"><button type="button" onClick={close} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-[15px] font-semibold hover:bg-muted"><X className="size-4" />Close</button></div>
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

/** Day and Week: a time grid like Google Calendar, today's column tinted, a line at the current time. */
function TimeGrid({ days, today, visits, tz, nowMs, detailed, selectedId, onDay }: { days: string[]; today: string; visits: Visit[]; tz: string; nowMs: number; detailed: boolean; selectedId: string | null; onDay: (day: string) => void }) {
  const shown = visits.filter((visit) => days.includes(visit.day))
  const first = Math.min(7, ...shown.map((visit) => Math.floor(visit.minutes / 60)))
  const last = Math.max(19, ...shown.map((visit) => Math.ceil(visit.minutes / 60) + 1))
  const hours = Array.from({ length: last - first }, (_, index) => first + index)
  const nowMinutes = minutesIn(new Date(nowMs).toISOString(), tz)
  const single = days.length === 1
  const cols = { gridTemplateColumns: `3rem repeat(${days.length}, minmax(0, 1fr))` }
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
      <div className="relative grid" style={cols}>
        <div>{hours.map((hour) => <div key={hour} style={{ height: HOUR }} className="relative"><span className="absolute -top-2 right-1.5 text-[11px] text-muted-foreground">{hour === first ? "" : `${hour % 12 || 12}${hour < 12 ? "a" : "p"}`}</span></div>)}</div>
        {days.map((day) => (
          <div key={day} className={cn("relative border-l", day === today && "bg-brand-yellow/10")}>
            {hours.map((hour) => <div key={hour} style={{ height: HOUR }} className="border-b border-border/70 last:border-b-0" />)}
            {day === today && nowMinutes >= first * 60 && nowMinutes <= last * 60 && (
              <span aria-hidden className="absolute inset-x-0 z-10 h-0.5 bg-red-600" style={{ top: ((nowMinutes - first * 60) / 60) * HOUR }}><i className="absolute -top-1 -left-1 size-2.5 rounded-full bg-red-600" /></span>
            )}
            {shown.filter((visit) => visit.day === day).map((visit) => (
              <CallLink key={visit.call.id} callId={visit.call.id} aria-current={selectedId === visit.call.id}
                className={cn("absolute inset-x-0.5 z-20 grid content-start overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-left leading-tight", visit.booked ? "border-emerald-600 bg-emerald-100 text-emerald-950" : "border-amber-500 bg-amber-100 text-amber-950", selectedId === visit.call.id && "ring-2 ring-brand-ink")}
                style={{ top: ((visit.minutes - first * 60) / 60) * HOUR + 1, height: HOUR * (detailed ? 1.5 : 1.2) - 3 }}>
                <span className="tabular text-[12px] font-semibold">{detailed ? timeOnly(visit.call.fields.requestedStart!, tz) : shortTime(visit.minutes)}</span>
                {detailed ? (
                  <>
                    <strong className="truncate text-[13px] font-semibold">{visit.call.fields.callerName ?? "Unknown caller"}</strong>
                    {single && <span className="truncate text-[13px]">{visit.call.fields.problemDescription}</span>}
                  </>
                ) : <span className="truncate text-[11px]">{(visit.call.fields.callerName ?? "Caller").split(" ")[0]}</span>}
              </CallLink>
            ))}
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
      <div key={day} className={cn("grid min-h-20 content-start gap-1 border-t border-l p-1 first:border-l-0 lg:min-h-28 lg:p-1.5 [&:nth-child(7n+1)]:border-l-0", outside && "bg-muted/40", day === today && "bg-brand-yellow/10")}>
        <button type="button" onClick={() => onDay(day)} className="justify-self-center lg:justify-self-start" aria-label={fmt(day, { weekday: "long", month: "long", day: "numeric" })}>
          <DayNumber day={day} today={day === today} className={cn(outside && "text-muted-foreground", "size-7 text-sm")} />
        </button>
        {wide ? items.slice(0, 3).map((visit) => (
          <CallLink key={visit.call.id} callId={visit.call.id} aria-current={selectedId === visit.call.id}
            className={cn("truncate rounded px-1.5 py-0.5 text-[12px] font-medium", visit.booked ? "bg-emerald-100 text-emerald-950" : "bg-amber-100 text-amber-950", selectedId === visit.call.id && "ring-2 ring-brand-ink")}>
            {visit.call.fields.callerName ?? "Caller"}
          </CallLink>
        )) : items.length > 0 && (
          <button type="button" onClick={() => onDay(day)} className="flex flex-wrap justify-center gap-1" aria-label={`${items.length} visits`}>
            {items.slice(0, 3).map((visit) => <i key={visit.call.id} className={cn("size-2 rounded-full", visit.booked ? "bg-emerald-600" : "bg-amber-500")} />)}
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
