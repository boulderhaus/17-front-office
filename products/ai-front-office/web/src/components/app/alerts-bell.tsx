import { useMemo, useSyncExternalStore } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Bell, CalendarCheck, PhoneMissed, PhoneIncoming, Settings2, TriangleAlert, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { buildAlerts, unseenAlerts, type AlertKind } from "@/lib/alerts"
import { callerLabel, compactDate } from "@/lib/format"
import { useMode } from "@/lib/mode"
import { JUMP } from "@/lib/nav"
import { cn } from "@/lib/utils"

const ICON: Record<AlertKind, LucideIcon> = { urgent: TriangleAlert, callback: PhoneIncoming, booked: CalendarCheck, short: PhoneMissed }
const TINT: Record<AlertKind, string> = { urgent: "bg-red-50 text-red-700", callback: "bg-secondary text-brand-ink", booked: "bg-emerald-50 text-emerald-800", short: "bg-amber-50 text-amber-800" }
/**
 * When the bell was last opened, per shop (two shops on one browser keep their own dots), shared by every bell on
 * the page (the phone bar's and the sidebar's), so reading it in one clears the other.
 */
const listeners = new Set<() => void>()
const seenKey = (shop: string) => `callotto.alerts.seen:${shop}`
/** Private mode (no storage): remembered until the page reloads. */
const memory = new Map<string, string>()
function readSeen(shop: string): string | null {
  try { return window.localStorage.getItem(seenKey(shop)) ?? memory.get(shop) ?? null } catch { return memory.get(shop) ?? null }
}
function writeSeen(shop: string, value: string) {
  memory.set(shop, value)
  try { window.localStorage.setItem(seenKey(shop), value) } catch { /* private mode: memory holds it */ }
  listeners.forEach((listener) => listener())
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener("storage", listener)
  return () => { listeners.delete(listener); window.removeEventListener("storage", listener) }
}

/**
 * The bell: a list of what happened on calls (urgent calls, people waiting on a call back, new bookings, callers
 * who hung up early), newest first, each opening its call. Its dot marks anything new since the bell was opened.
 * Alert settings is one small link at the foot.
 */
export function AlertsBell({ className }: { className?: string }) {
  const { dashboard, base } = useMode()
  const navigate = useNavigate()
  const shop = dashboard?.analytics?.tenantId ?? dashboard?.shop.businessName ?? "shop"
  const seen = useSyncExternalStore(subscribe, () => readSeen(shop), () => null)
  const alerts = useMemo(() => (dashboard ? buildAlerts({ calls: dashboard.calls, tasks: dashboard.tasks, nowMs: Date.parse(dashboard.now), who: callerLabel }) : []), [dashboard])
  const fresh = unseenAlerts(alerts, seen)
  const tz = dashboard?.shop.timezone ?? "America/New_York"
  const onOpenChange = (open: boolean) => {
    if (!open || !alerts[0]) return
    if (!seen || alerts[0].at > seen) writeSeen(shop, alerts[0].at)
  }
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn("relative size-11 shrink-0 focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-ink focus-visible:outline-solid", className)} aria-label={fresh ? `Alerts, ${fresh} new` : "Alerts"}>
          <Bell className="size-[22px]" strokeWidth={1.75} />
          {fresh > 0 && <span aria-hidden className="absolute top-2 right-2 size-2.5 rounded-full bg-red-600 ring-2 ring-background" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={12} className="w-[min(24rem,calc(100vw-1.5rem))] p-0">
        <DropdownMenuLabel className="px-4 pt-3.5 pb-2 text-[17px] font-semibold text-foreground">Alerts</DropdownMenuLabel>
        <DropdownMenuSeparator className="my-0" />
        <div className="max-h-[min(26rem,calc(100dvh-10rem))] overflow-y-auto p-1">
          {alerts.length === 0 ? (
            <p className="px-3 py-6 text-center text-[15px] text-muted-foreground">No alerts yet. New calls show up here.</p>
          ) : alerts.map((alert) => {
            const Icon = ICON[alert.kind]
            return (
              <DropdownMenuItem key={`${alert.kind}:${alert.callId}`} className="ph-no-capture min-h-14 items-start gap-3 rounded-lg px-3 py-2.5" onSelect={() => navigate(`${base}/calls/${encodeURIComponent(alert.callId)}`)}>
                <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-full", TINT[alert.kind])}><Icon className="size-4" /></span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="truncate text-[15px] font-semibold">{alert.title}</strong>
                  <span className="truncate text-[14px] text-muted-foreground">{alert.detail}</span>
                  <time className="tabular text-[13px] text-muted-foreground">{compactDate(alert.at, tz)}</time>
                </span>
              </DropdownMenuItem>
            )
          })}
        </div>
        <DropdownMenuSeparator className="my-0" />
        <DropdownMenuItem asChild className="min-h-11 gap-2 rounded-none px-4 text-[14px] font-medium text-muted-foreground">
          <Link to={`${base}/settings/alerts`} state={JUMP}><Settings2 className="size-4" />Alert settings</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
