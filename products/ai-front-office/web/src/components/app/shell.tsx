import { useEffect, type ReactNode } from "react"
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom"
import { BellOff, CalendarDays, ChevronLeft, ChevronRight, Columns3, LogOut, PhoneCall, Settings2 } from "lucide-react"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenu,
  SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { BrandMark } from "./bits"
import { coverageStatus, derive } from "@/lib/derive"
import { useMode } from "@/lib/mode"
import { cn } from "@/lib/utils"

function useNav() {
  const { base, preview, dashboard } = useMode()
  const attention = dashboard ? derive(dashboard).actionable.length : 0
  return [
    { to: base, label: "Calls", icon: PhoneCall, end: true, badge: attention },
    { to: `${base}/jobs`, label: "Jobs", icon: Columns3, end: false, badge: 0 },
    { to: `${base}/calendar`, label: "Calendar", icon: CalendarDays, end: false, badge: 0 },
    preview
      ? { to: "/signup", label: "Start", icon: Settings2, end: false, badge: 0, external: true }
      : { to: `${base}/settings`, label: "Settings", icon: Settings2, end: false, badge: 0 },
  ] as Array<{ to: string; label: string; icon: typeof PhoneCall; end: boolean; badge: number; external?: boolean }>
}

const DOT = { on: "bg-emerald-500", pending: "bg-amber-500", paused: "bg-stone-400", warning: "bg-red-600" } as const

/** Text alerts off is a standing state, not news: it lives with the line status, never in the middle of the calls. */
export function AlertsOffNotice({ compact }: { compact?: boolean }) {
  const { dashboard, preview } = useMode()
  if (!dashboard || preview || dashboard.shop.alertsOn || dashboard.viewer.role !== "owner") return null
  return (
    // /app/setup records the owner's text-message consent, so "Turn on" still goes there.
    <a href="/app/setup" className={cn("flex items-center gap-2.5 rounded-xl bg-amber-50 text-amber-950 ring-1 ring-amber-200 ring-inset hover:bg-amber-100", compact ? "min-h-11 px-3 text-sm" : "min-h-12 px-3.5 text-[15px]")}>
      <BellOff className="size-4 shrink-0" />
      <span className="flex-1"><strong className="font-semibold">Text alerts are off.</strong> <span className="underline underline-offset-4">Turn on</span></span>
    </a>
  )
}

/**
 * The line, in words the owner knows: "Answering calls", "Setting up your line", "Answering paused".
 * Phone: a row at the top of Calls when it isn't simply on. Computer: always, at the foot of the sidebar.
 */
export function LineStatus({ always }: { always?: boolean }) {
  const { dashboard, preview } = useMode()
  if (!dashboard || preview) return null
  const status = coverageStatus(dashboard)
  if (!always && status.tone === "on") return null
  // While setup steps remain, the Finish setup card says what's left; this row would only repeat it.
  if (!always && !dashboard.onboarding.completed && dashboard.viewer.role === "owner") return null
  const to = status.tone === "warning" ? "/app/settings/plan" : status.tone === "paused" ? "/app/settings/answering" : dashboard.onboarding.completed ? "/app/settings/answering" : "/app/start"
  return (
    <Link to={to} className={cn("flex items-start gap-2.5 rounded-xl hover:bg-muted/60", always ? "px-2 py-2" : "border bg-card px-4 py-3")}>
      <i className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", DOT[status.tone])} />
      <span className="grid flex-1 gap-0.5">
        <strong className="text-[15px] font-semibold">{status.label}</strong>
        <span className={cn("text-muted-foreground", always ? "text-[13px] leading-snug" : "text-sm")}>{status.detail}</span>
      </span>
      {!always && <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />}
    </Link>
  )
}

/**
 * title: the page's name, on its own row under the bar (never squeezed beside the shop name).
 * back: a sub-page (a call, a settings page) shows "‹ Calls" in the bar on a phone instead of the logo.
 */
export function AppShell({ title, back, hideTitle, children }: { title: string; back?: { to: string; label: string }; hideTitle?: boolean; children: ReactNode }) {
  useEffect(() => { document.title = `${title} · Front Office` }, [title])
  const nav = useNav()
  const { dashboard, preview } = useMode()
  const location = useLocation()
  const navigate = useNavigate()
  const isActive = (item: { to: string; end: boolean }) => (item.end ? location.pathname.replace(/\/$/, "") === item.to || location.pathname.startsWith(`${item.to}/calls`) : location.pathname.startsWith(item.to))
  // In-app history goes back one step; a deep link (first page of the visit) goes to the parent screen.
  const goBack = () => (location.key !== "default" ? navigate(-1) : navigate(back!.to))
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="inset" className="max-lg:hidden">
        <SidebarHeader>
          <Link to={nav[0]!.to} className="flex items-center gap-2.5 px-1 py-1.5">
            <BrandMark />
            <span className="truncate text-lg font-semibold tracking-tight group-data-[collapsible=icon]:hidden">Front <em className="font-serif italic">Office</em></span>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {nav.map((item) => (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton asChild isActive={isActive(item)} tooltip={item.label} className="h-10 text-[15px] data-[active=true]:font-semibold [&_svg]:size-[18px]">
                      {item.external ? <a href={item.to}><item.icon /><span>{item.label}</span></a> : <Link to={item.to}><item.icon /><span>{item.label}</span></Link>}
                    </SidebarMenuButton>
                    {item.badge > 0 && <SidebarMenuBadge className="top-2 rounded-full bg-red-600 px-2 text-white!">{item.badge}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="gap-2">
          {preview ? (
            <div className="grid gap-2 group-data-[collapsible=icon]:hidden">
              <a href="/" className="px-2 text-sm font-medium">Back to site</a>
              <Button variant="brand" asChild><a href="/signup">Get started</a></Button>
            </div>
          ) : (
            <>
              <div className="grid gap-2 group-data-[collapsible=icon]:hidden">
                <LineStatus always />
                <AlertsOffNotice compact />
              </div>
              <SidebarMenu>
                <SidebarMenuItem><SidebarMenuButton asChild tooltip="Sign out" className="h-10"><a href="/logout"><LogOut /><span>Sign out</span></a></SidebarMenuButton></SidebarMenuItem>
              </SidebarMenu>
            </>
          )}
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0 bg-background lg:bg-card">
        <header className="pt-safe sticky top-0 z-20 border-b bg-background/95 backdrop-blur-md lg:rounded-t-xl lg:bg-card/95">
          <div className="flex h-14 items-center gap-2.5 px-4 lg:px-6">
            <SidebarTrigger className="-ml-1 max-lg:hidden" />
            {back ? (
              <button type="button" onClick={goBack} className="-ml-2 inline-flex min-h-11 items-center gap-0.5 rounded-lg pr-2 text-[17px] font-semibold text-brand-ink hover:bg-muted lg:hidden">
                <ChevronLeft className="size-6" />{back.label}
              </button>
            ) : <BrandMark className="lg:hidden" />}
            <span className={cn("truncate text-[15px] font-medium text-muted-foreground", back && "max-lg:hidden")}>{dashboard?.shop.businessName ?? ""}</span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-4 pb-28 lg:px-6 lg:pt-6 lg:pb-10">
          {!hideTitle && <h1 className="mb-4 text-[28px] leading-tight font-semibold tracking-tight lg:mb-5">{title}</h1>}
          {children}
        </main>
        <BottomTabs />
      </SidebarInset>
    </SidebarProvider>
  )
}

function BottomTabs() {
  const nav = useNav()
  const location = useLocation()
  return (
    <nav aria-label="Main" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 backdrop-blur-md lg:hidden">
      <div className="grid grid-cols-4 gap-1 px-2 pt-1.5 pb-1.5">
        {nav.map((item) => {
          const inner = (active: boolean) => (
            <span className={cn("relative grid min-h-13 content-center justify-items-center gap-0.5 rounded-xl px-1 py-1 text-[13px] font-semibold text-muted-foreground", active && "bg-accent text-foreground")}>
              <item.icon className="size-6" strokeWidth={active ? 2.25 : 1.75} />
              <span>{item.label}</span>
              {item.badge > 0 && <b className="tabular absolute top-0 left-[calc(50%+6px)] h-5 min-w-5 rounded-full bg-red-600 px-1.5 text-center text-xs leading-5 text-white">{item.badge}</b>}
            </span>
          )
          // A call opened from Calls keeps the Calls tab lit.
          const callsChild = item.end && location.pathname.startsWith(`${item.to}/calls/`)
          return item.external
            ? <a key={item.label} href={item.to}>{inner(false)}</a>
            : <NavLink key={item.label} to={item.to} end={item.end}>{({ isActive }) => inner(isActive || callsChild)}</NavLink>
        })}
      </div>
    </nav>
  )
}
