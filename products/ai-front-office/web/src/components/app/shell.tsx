import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { ArrowLeft, Bell, BellOff, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, CircleUser, Columns3, LogOut, Menu, PhoneCall, Settings2, X, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { BrandMark } from "./bits"
import { SETTINGS_PAGES } from "./settings-pages"
import { coverageStatus, derive } from "@/lib/derive"
import { useMediaQuery, useMode } from "@/lib/mode"
import { backGoes, JUMP, navActive, navEntries, swipeCloses, type NavEntry, type NavId } from "@/lib/nav"
import { revealDelta } from "@/lib/selection"
import { cn } from "@/lib/utils"

interface NavItem extends NavEntry {
  icon: LucideIcon
  /** Settings: its pages, listed under it on a guide line. */
  children?: Array<{ to: string; label: string }>
}

const ICONS: Record<NavId, LucideIcon> = { calls: PhoneCall, jobs: Columns3, calendar: CalendarDays, settings: Settings2, start: Settings2 }

function useNav(): NavItem[] {
  const { base, preview, member, dashboard } = useMode()
  const attention = dashboard ? derive(dashboard).actionable.length : 0
  return navEntries({ base, preview, member, attention }).map((entry) => ({
    ...entry,
    icon: ICONS[entry.id],
    ...(entry.id === "settings" ? { children: SETTINGS_PAGES.map((page) => ({ to: `${base}/settings/${page.id}`, label: page.title })) } : {}),
  }))
}

const DOT = { on: "bg-emerald-500", pending: "bg-amber-500", paused: "bg-stone-400", warning: "bg-red-600" } as const

/** Keyboard focus: a solid ink ring, offset, never the same as hover. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-ink"
/** The same ring on a shadcn Button, in place of its pale default halo (about 2:1 on cream). */
const FOCUS_BUTTON = cn(FOCUS, "focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-solid")
/** Menu rows draw the ring inside: the scrolling menu would clip an outside one, and the next row would cover it. */
const FOCUS_IN = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-ink"
/** One menu row: 44px tall, an outline icon, the label. The lit row is a soft grey pill. */
const ROW = cn("flex min-h-11 min-w-0 items-center gap-3 rounded-lg px-3 text-[15px] text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground motion-reduce:transition-none", FOCUS_IN)
const ROW_ON = "bg-sidebar-accent font-semibold text-sidebar-foreground hover:bg-sidebar-accent"

function usePath() {
  return useLocation().pathname.replace(/\/$/, "")
}

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
 * Phone: a row at the top of Calls when it isn't simply on. The menu (side menu, phone drawer): always, at its foot.
 * onNavigate: the phone drawer closes when it is tapped, even on the page it already shows.
 */
export function LineStatus({ always, onNavigate }: { always?: boolean; onNavigate?: () => void }) {
  const { dashboard, preview, member } = useMode()
  if (!dashboard || preview) return null
  const status = coverageStatus(dashboard)
  if (!always && status.tone === "on") return null
  // While setup steps remain, the Finish setup card says what's left; this row would only repeat it.
  if (!always && !dashboard.onboarding.completed && dashboard.viewer.role === "owner") return null
  const to = status.tone === "warning" ? "/app/settings/plan" : status.tone === "paused" ? "/app/settings/answering" : dashboard.onboarding.completed ? "/app/settings/answering" : "/app/start"
  const body = (
    <>
      <i className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", DOT[status.tone])} />
      <span className="grid flex-1 gap-0.5">
        <strong className="text-[15px] font-semibold">{status.label}</strong>
        <span className={cn("text-muted-foreground", always ? "text-[13px] leading-snug" : "text-sm")}>{status.detail}</span>
      </span>
      {!always && !member && <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />}
    </>
  )
  const frame = cn("flex items-start gap-2.5 rounded-xl", always ? "px-2 py-2" : "border bg-card px-4 py-3")
  // A team member sees the line's state but has nowhere to go: Settings is the owner's.
  if (member) return <div className={frame}>{body}</div>
  // A jump into Settings: its "‹ Settings" goes to Settings, not back here.
  return <Link to={to} state={JUMP} onClick={onNavigate} className={cn(frame, "hover:bg-muted/60", always && FOCUS_IN)}>{body}</Link>
}

function Wordmark() {
  return <span className="truncate text-lg font-semibold tracking-tight">Call <em className="font-serif italic">Otto</em></span>
}

/**
 * The menu: wordmark and shop name, then Calls, Jobs, Calendar, Settings (its pages on a guide line), then the line
 * status and Sign out. Always on the left on a computer; in the drawer on a phone (`drawer`, with its own Close).
 * The lit row is always scrolled into view. On a short screen the whole menu scrolls as one, so its foot never
 * squeezes the list down to nothing.
 */
function NavPanel({ drawer, onNavigate }: { drawer?: boolean; onNavigate?: () => void }) {
  const nav = useNav()
  const { dashboard, preview } = useMode()
  const path = usePath()
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const lit = list.current?.querySelector<HTMLElement>('[aria-current="page"]')
    const scroller = [list.current, panel.current].find((element) => element && element.scrollHeight > element.clientHeight + 1)
    if (!lit || !scroller) return
    scroller.scrollTop += revealDelta(lit.getBoundingClientRect(), scroller.getBoundingClientRect())
  }, [path])
  return (
    <div ref={panel} className="flex min-h-0 flex-1 flex-col short:overflow-y-auto">
      <div className="flex items-center gap-1 px-4 pt-4 pb-3">
        <Link to={nav[0]!.to} onClick={onNavigate} className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg", FOCUS_IN)}>
          <BrandMark />
          <span className="grid min-w-0 leading-tight">
            <Wordmark />
            {dashboard?.shop.businessName && <span className="truncate text-[13px] text-muted-foreground">{dashboard.shop.businessName}</span>}
          </span>
        </Link>
        {drawer && (
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className={cn("-mr-2 size-11 shrink-0", FOCUS_BUTTON, "focus-visible:-outline-offset-2")} aria-label="Close menu"><X className="size-5" /></Button>
          </SheetClose>
        )}
      </div>
      <nav ref={list} aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 short:flex-none short:overflow-visible">
        <ul className="grid gap-0.5">
          {nav.map((item) => (item.children
            ? <NavGroup key={item.label} item={item} pages={item.children} onNavigate={onNavigate} />
            : <NavRow key={item.label} item={item} active={navActive(path, item)} onNavigate={onNavigate} />))}
        </ul>
      </nav>
      <div className="grid gap-2 border-t border-sidebar-border px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {preview ? (
          <>
            <a href="/" className={ROW}><ArrowLeft className="size-[18px] shrink-0" strokeWidth={1.75} />Back to site</a>
            <Button variant="brand" size="tap" className={FOCUS_BUTTON} asChild><a href="/signup">Get started</a></Button>
          </>
        ) : (
          <>
            <LineStatus always onNavigate={onNavigate} />
            <AlertsOffNotice compact />
            <a href="/logout" className={ROW}><LogOut className="size-[18px] shrink-0" strokeWidth={1.75} />Sign out</a>
          </>
        )}
      </div>
    </div>
  )
}

function NavRow({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  const body = (
    <>
      <item.icon className="size-[18px] shrink-0" strokeWidth={active ? 2.25 : 1.75} />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge > 0 && (
        <>
          <b aria-hidden className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">{item.badge}</b>
          <span className="sr-only">, {item.badge} to call back</span>
        </>
      )}
    </>
  )
  return (
    <li>
      {item.external
        ? <a href={item.to} className={ROW}>{body}</a>
        : <Link to={item.to} aria-current={active ? "page" : undefined} onClick={onNavigate} className={cn(ROW, active && ROW_ON)}>{body}</Link>}
    </li>
  )
}

/**
 * Settings: the row opens the settings list; the chevron shows or hides its pages. Open by itself inside Settings.
 * The hover pill covers the whole row (link and chevron); the chevron darkens on its own to show it is a second target.
 */
function NavGroup({ item, pages, onNavigate }: { item: NavItem; pages: NonNullable<NavItem["children"]>; onNavigate?: () => void }) {
  const path = usePath()
  const inside = path === item.to || path.startsWith(`${item.to}/`)
  const onList = path === item.to
  const [open, setOpen] = useState(inside)
  useEffect(() => { if (inside) setOpen(true) }, [inside])
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className={cn("flex items-center gap-0.5 rounded-lg transition-colors motion-reduce:transition-none", onList ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60")}>
          <Link to={item.to} aria-current={onList ? "page" : undefined} onClick={onNavigate} className={cn(ROW, "flex-1 hover:bg-transparent", inside && "font-semibold text-sidebar-foreground")}>
            <item.icon className="size-[18px] shrink-0" strokeWidth={inside ? 2.25 : 1.75} />
            <span className="flex-1 truncate">{item.label}</span>
          </Link>
          <CollapsibleTrigger asChild>
            <button type="button" aria-label={`${item.label} pages`} className={cn("grid size-11 shrink-0 place-items-center rounded-lg text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground", FOCUS_IN)}>
              <ChevronDown className={cn("size-4 transition-transform duration-200 motion-reduce:transition-none", !open && "-rotate-90")} />
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          {/* The guide line sits under the icon's centre: 12px row padding + half the 18px icon. */}
          <ul aria-label={`${item.label} pages`} className="mt-0.5 ml-[21px] grid gap-0.5 border-l border-sidebar-border pl-2">
            {pages.map((page) => {
              const on = path === page.to
              return (
                <li key={page.to}>
                  {/* A jump straight into a settings page: its "‹ Settings" goes to Settings, not back to where this started. */}
                  <Link to={page.to} state={JUMP} aria-current={on ? "page" : undefined} onClick={onNavigate} className={cn(ROW, on && ROW_ON)}>
                    <span className="truncate">{page.label}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/**
 * The name of an icon button on hover, with a mouse only. On a touch screen it would show when focus comes back to
 * the button (after the account menu closes) and stay over the page; the button's aria-label names it either way.
 */
function Tip({ label, children, open, onOpenChange }: { label: string; children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const mouse = useMediaQuery("(hover: hover) and (pointer: fine)")
  if (!mouse) return <>{children}</>
  return (
    <Tooltip {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function IconLink({ to, label, icon: Icon }: { to: string; label: string; icon: LucideIcon }) {
  return (
    <Tip label={label}>
      <Button variant="ghost" size="icon" className={cn("size-11", FOCUS_BUTTON)} asChild>
        <Link to={to} state={JUMP} aria-label={label}><Icon className="size-[22px]" strokeWidth={1.75} /></Link>
      </Button>
    </Tip>
  )
}

function AccountMenu() {
  const { dashboard } = useMode()
  // Closing the menu hands focus back to its button (keyboard users keep their place); that must not pop "Account" up.
  const [tip, setTip] = useState(false)
  const closedAt = useRef(0)
  return (
    <DropdownMenu onOpenChange={(open) => { setTip(false); if (!open) closedAt.current = Date.now() }}>
      <Tip label="Account" open={tip} onOpenChange={(open) => setTip(open && Date.now() - closedAt.current > 500)}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className={cn("size-11", FOCUS_BUTTON)} aria-label="Account"><CircleUser className="size-[22px]" strokeWidth={1.75} /></Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-auto min-w-56">
        {dashboard?.shop.businessName && (
          <>
            <DropdownMenuLabel className="truncate px-2 py-2 text-[15px] font-semibold text-foreground">{dashboard.shop.businessName}</DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem asChild className="min-h-11 gap-2.5 px-2 text-[15px]"><a href="/logout"><LogOut className="size-[18px]" />Sign out</a></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Phone and tablet: the menu button, the wordmark (or "‹ Calls" on a sub-page), Alerts and the account menu.
 * The menu opens a drawer from the left; choosing a page, Close, Esc, a tap on the dimmed page or a swipe left closes it.
 * Focus: on opening, the page you're on; after choosing a page, that page's content; otherwise back to the menu button.
 */
function TopBar({ back }: { back?: BackLink }) {
  const { base, preview, member, dashboard } = useMode()
  const location = useLocation()
  const navigate = useNavigate()
  const wide = useMediaQuery("(min-width: 1024px)")
  const [menu, setMenu] = useState(false)
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const drawer = useRef<HTMLDivElement>(null)
  const navigated = useRef(false)
  useEffect(() => setMenu(false), [location.pathname, location.search])
  // Growing the window into the computer layout puts the menu on the left for good.
  useEffect(() => { if (wide) setMenu(false) }, [wide])
  const attention = dashboard ? derive(dashboard).actionable.length : 0
  const owner = !preview && !member && dashboard?.viewer.role === "owner"
  // Going up to the parent (no list behind this page) replaces it, so Back from the parent doesn't return here.
  const goBack = () => ((back?.history ?? backGoes({ key: location.key, state: location.state }) === "history") ? navigate(-1) : navigate(back!.to, { replace: true }))
  return (
    <header className="pt-safe sticky top-0 z-20 border-b bg-background/95 pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] backdrop-blur-md lg:hidden">
      <div className="flex h-14 items-center gap-1 px-2">
        <Sheet open={menu} onOpenChange={setMenu}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className={cn("relative size-11 shrink-0", FOCUS_BUTTON)} aria-label={attention ? `Open menu, ${attention} to call back` : "Open menu"}>
              <Menu className="size-6" strokeWidth={1.75} />
              {attention > 0 && <span aria-hidden className="absolute top-2 right-2 size-2.5 rounded-full bg-red-600 ring-2 ring-background" />}
            </Button>
          </SheetTrigger>
          <SheetContent
            ref={drawer}
            side="left"
            showCloseButton={false}
            aria-describedby={undefined}
            overlayClassName="bg-black/40 supports-backdrop-filter:backdrop-blur-none motion-reduce:animate-none!"
            className="gap-0 bg-sidebar p-0 pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] text-sidebar-foreground data-[side=left]:w-[min(calc(18rem+env(safe-area-inset-left)),85vw)] data-[side=left]:border-sidebar-border motion-reduce:animate-none! motion-reduce:transition-none"
            onOpenAutoFocus={(event) => {
              // Start on the page you're on, without scrolling the menu back to its top.
              event.preventDefault()
              const root = drawer.current
              const start = root?.querySelector<HTMLElement>('[aria-current="page"]') ?? root?.querySelector<HTMLElement>("a[href]")
              start?.focus({ preventScroll: true })
            }}
            onCloseAutoFocus={(event) => {
              if (!navigated.current) return
              navigated.current = false
              event.preventDefault()
              document.getElementById("main")?.focus({ preventScroll: true })
            }}
            onTouchStart={(event) => { const point = event.touches[0]; swipe.current = point ? { x: point.clientX, y: point.clientY } : null }}
            onTouchEnd={(event) => {
              const start = swipe.current
              swipe.current = null
              const point = event.changedTouches[0]
              if (start && point && swipeCloses(start, { x: point.clientX, y: point.clientY })) setMenu(false)
            }}
          >
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <NavPanel drawer onNavigate={() => { navigated.current = true; setMenu(false) }} />
          </SheetContent>
        </Sheet>
        {back ? (
          <button type="button" onClick={goBack} className={cn("inline-flex min-h-11 min-w-0 items-center gap-0.5 rounded-lg pr-2 text-[17px] font-semibold text-brand-ink hover:bg-muted", FOCUS)}>
            <ChevronLeft className="size-6 shrink-0" /><span className="truncate">{back.label}</span>
          </button>
        ) : (
          <Link to={base} className={cn("flex min-h-11 min-w-0 items-center gap-2 rounded-lg pr-2", FOCUS)}>
            <BrandMark /><Wordmark />
          </Link>
        )}
        <div className="ml-auto flex shrink-0 items-center">
          {owner && <IconLink to="/app/settings/alerts" label="Alerts" icon={Bell} />}
          {preview
            ? <Button variant="brand" size="lg" className={cn("mr-1.5 h-11 px-3.5 text-[15px]", FOCUS_BUTTON)} asChild><a href="/signup">Get started</a></Button>
            : <AccountMenu />}
        </div>
      </div>
    </header>
  )
}

/** A sub-page's "‹ Calls". `history`: whether it steps back in history; left out, the generic rule (backGoes) decides. */
export interface BackLink { to: string; label: string; history?: boolean }

/** A page's header: the title, one grey line on what the page is for, and its actions (right on a computer, under on a phone). */
function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 lg:mb-6 lg:flex-row lg:items-end lg:justify-between lg:gap-6">
      <div className="grid min-w-0 gap-1">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-balance">{title}</h1>
        {subtitle && <p className="text-[15px] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 empty:hidden lg:shrink-0">{actions}</div>}
    </div>
  )
}

/**
 * title: the page's name, at the top of the page. subtitle and actions: see PageHeader.
 * back: a sub-page (a call, a settings page) shows "‹ Calls" in the phone's top bar beside the menu button.
 */
export function AppShell({ title, subtitle, actions, back, hideTitle, children }: { title: string; subtitle?: string; actions?: ReactNode; back?: BackLink; hideTitle?: boolean; children: ReactNode }) {
  useEffect(() => { document.title = `${title} · Call Otto` }, [title])
  const location = useLocation()
  // A new page whose link went away with the old one (Settings from the menu, a call from the list) leaves focus
  // nowhere; put it at the top of the new page's content so the next Tab, and a screen reader, start there.
  useEffect(() => {
    if (location.key === "default") return
    const focused = document.activeElement
    if (!focused || focused === document.body) document.getElementById("main")?.focus({ preventScroll: true })
    // Only a new page: a changed ?view or ?call keeps focus where the owner put it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      {/* Moves focus without touching the URL, so Back never lands on the same page. */}
      <a href="#main" onClick={(event) => { event.preventDefault(); document.getElementById("main")?.focus() }}
        className="sr-only rounded-lg bg-card text-[15px] font-semibold text-foreground ring-2 ring-brand-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:px-4 focus:py-3 focus:shadow-lg">
        Skip to content
      </a>
      <div className="sticky top-0 hidden h-dvh flex-col self-start border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <NavPanel />
      </div>
      <div className="flex min-h-dvh min-w-0 flex-col lg:bg-card">
        <TopBar back={back} />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-5 pb-[calc(2.5rem+env(safe-area-inset-bottom))] outline-none lg:px-8 lg:pt-8 lg:pb-12">
          {!hideTitle && <PageHeader title={title} subtitle={subtitle} actions={actions} />}
          {children}
        </main>
      </div>
    </div>
  )
}
