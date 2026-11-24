import { useEffect, type ReactNode } from "react"
import { Link, NavLink, useLocation } from "react-router-dom"
import { CalendarDays, Columns3, LogOut, PhoneCall, Settings2, Users } from "lucide-react"
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

function StatusChip() {
  const { dashboard, base, preview } = useMode()
  if (!dashboard) return null
  const status = coverageStatus(dashboard)
  const dot = { on: "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.18)]", pending: "bg-stone-400", paused: "bg-amber-500", warning: "bg-amber-500" }[status.tone]
  return (
    <Link to={preview ? "/signup" : `${base}/settings`} className="inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border bg-card px-2.5 text-[13px] font-semibold shadow-xs">
      <i className={cn("size-2 rounded-full", dot)} />
      {status.label}
    </Link>
  )
}

export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => { document.title = `${title} · Call Otto` }, [title])
  const nav = useNav()
  const { dashboard, preview } = useMode()
  const location = useLocation()
  const isActive = (item: { to: string; end: boolean }) => (item.end ? location.pathname.replace(/\/$/, "") === item.to : location.pathname.startsWith(item.to))
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="inset" className="max-lg:hidden">
        <SidebarHeader>
          <Link to={nav[0]!.to} className="flex items-center gap-2.5 px-1 py-1.5">
            <BrandMark />
            <span className="truncate text-lg font-semibold tracking-tight group-data-[collapsible=icon]:hidden">Call <em className="font-serif italic">Otto</em></span>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {nav.map((item) => (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton asChild isActive={isActive(item)} tooltip={item.label} className="h-9 data-[active=true]:font-semibold">
                      {item.external ? <a href={item.to}><item.icon /><span>{item.label}</span></a> : <Link to={item.to}><item.icon /><span>{item.label}</span></Link>}
                    </SidebarMenuButton>
                    {item.badge > 0 && <SidebarMenuBadge className="rounded-md bg-red-600 text-white!">{item.badge}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="group-data-[collapsible=icon]:hidden">
          {preview ? (
            <div className="grid gap-2">
              <a href="/" className="px-2 text-sm font-medium">Back to site</a>
              <Button variant="brand" asChild><a href="/signup">Get started</a></Button>
            </div>
          ) : (
            <SidebarMenu>
              <SidebarMenuItem><SidebarMenuButton asChild><a href="/app/team"><Users /><span>Team &amp; calendars</span></a></SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton asChild><a href="/logout"><LogOut /><span>Sign out</span></a></SidebarMenuButton></SidebarMenuItem>
            </SidebarMenu>
          )}
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0 bg-background lg:bg-card">
        <header className="pt-safe sticky top-0 z-20 border-b bg-background/90 backdrop-blur-md lg:rounded-t-xl lg:bg-card/90">
          <div className="flex h-14 items-center justify-between gap-3 px-4 lg:px-6">
            <div className="flex min-w-0 items-center gap-2.5">
              <SidebarTrigger className="-ml-1 max-lg:hidden" />
              <BrandMark className="lg:hidden" />
              <div className="grid min-w-0 leading-tight">
                <small className="truncate text-xs font-medium text-muted-foreground">{dashboard?.shop.businessName ?? " "}</small>
                <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
              </div>
            </div>
            <StatusChip />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-4 pb-28 lg:px-6 lg:pt-6 lg:pb-10">{children}</main>
        <BottomTabs />
      </SidebarInset>
    </SidebarProvider>
  )
}

function BottomTabs() {
  const nav = useNav()
  return (
    <nav aria-label="Dashboard" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 backdrop-blur-md lg:hidden">
      <div className="grid grid-cols-4 gap-1 px-2 pt-1.5 pb-1.5">
        {nav.map((item) => {
          const inner = (active: boolean) => (
            <span className={cn("relative grid min-h-12 justify-items-center gap-0.5 rounded-xl px-1 py-1.5 text-xs font-semibold text-muted-foreground", active && "bg-accent text-foreground")}>
              {active && <span className="absolute top-0 left-1/2 h-1 w-8 -translate-x-1/2 rounded-b-full bg-brand-yellow" />}
              <item.icon className="size-5" />
              <span>{item.label}</span>
              {item.badge > 0 && <b className="tabular absolute top-0.5 left-[calc(50%+6px)] h-[18px] min-w-[18px] rounded-full bg-red-600 px-1.5 text-[11px] leading-[18px] text-white">{item.badge}</b>}
            </span>
          )
          return item.external
            ? <a key={item.label} href={item.to}>{inner(false)}</a>
            : <NavLink key={item.label} to={item.to} end={item.end}>{({ isActive }) => inner(isActive)}</NavLink>
        })}
      </div>
    </nav>
  )
}
