import { useSearchParams } from "react-router-dom"
import { CallLink } from "@/components/app/bits"
import { CallPanel } from "./today"
import { derive } from "@/lib/derive"
import { dateKey, timeOnly } from "@/lib/format"
import { useMode } from "@/lib/mode"
import { cn } from "@/lib/utils"

export function CalendarPage() {
  const { dashboard } = useMode()
  const [params] = useSearchParams()
  if (!dashboard) return null
  const d = derive(dashboard)
  const selected = params.get("call") ? d.callsById.get(params.get("call")!) ?? null : null
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(d.nowMs + index * 86_400_000)
    const key = dateKey(day, d.tz)
    return {
      key,
      index,
      name: index === 0 ? "Today" : new Intl.DateTimeFormat("en-US", { timeZone: d.tz, weekday: "short" }).format(day),
      date: new Intl.DateTimeFormat("en-US", { timeZone: d.tz, month: "short", day: "numeric" }).format(day),
      items: d.upcoming.filter((call) => dateKey(new Date(call.fields.requestedStart!), d.tz) === key),
    }
  })
  return (
    <div className={cn("grid grid-cols-1 gap-4", selected && "lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start")}>
      <section className="grid min-w-0 gap-3">
        <h2 className="px-1 text-base font-semibold tracking-tight">Next seven days</h2>
        <div className={cn("grid gap-2.5 md:grid-cols-2", !selected && "xl:grid-cols-7", selected && "xl:grid-cols-2")}>
          {days.map((day) => (
            <section key={day.key} className={cn("grid content-start gap-2 rounded-xl border bg-card p-3 shadow-xs xl:min-h-52", day.index === 0 && "border-brand-ink/60 ring-2 ring-brand-yellow/70")}>
              <header className="flex items-baseline gap-2">
                <strong className="font-semibold">{day.name}</strong>
                <span className="text-[13px] text-muted-foreground">{day.date}</span>
              </header>
              {day.items.length ? day.items.map((call) => (
                <CallLink key={call.id} callId={call.id} className={cn("grid gap-0.5 rounded-lg border-l-[3px] px-3 py-2.5", call.outcome === "booked" ? "border-emerald-600 bg-emerald-50" : "border-amber-500 bg-amber-50")}>
                  <strong className="text-sm font-semibold">{timeOnly(call.fields.requestedStart!, d.tz)}</strong>
                  <span className="truncate text-sm">{call.fields.callerName ?? "Unknown caller"}</span>
                  <small className="text-xs text-muted-foreground">{call.outcome === "booked" ? "Booked" : "Awaiting your confirmation"}</small>
                </CallLink>
              )) : <span className="text-sm text-muted-foreground">Open</span>}
            </section>
          ))}
        </div>
      </section>
      {selected && (
        <aside className="max-lg:hidden lg:sticky lg:top-20">
          <CallPanel call={selected} task={d.taskFor(selected.id)} tz={d.tz} standalone={false} />
        </aside>
      )}
    </div>
  )
}
