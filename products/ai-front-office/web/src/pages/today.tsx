import { useState, type ReactNode } from "react"
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { ArrowRight, Check, ChevronRight, Clock, Loader2, MapPin, Phone, PhoneForwarded, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { CallLink, Empty, ListBox, MoreLink, Muted, SectionTitle, ToneBadge, usePage } from "@/components/app/bits"
import { ActionBar, CallBackNote, CallHeader, callLabel, Facts, phoneFact, SafetyNote, SpamNote, Transcript, type Action } from "@/components/app/call-parts"
import { AlertsOffNotice, LineStatus } from "@/components/app/shell"
import { api } from "@/lib/api"
import { derive, forwardingOn, shortAddress, urgency } from "@/lib/derive"
import { allCallsRowSelected, attentionRowSelected, nextOpenCall, PANEL_EDGE, panelSearch, revealDelta, ROW_FOCUS, rowShowsDone, SELECTED_ROW, stillOpenCalls } from "@/lib/selection"
import { createTaskGate, QUIET_MS, runTaskAction, type TaskAction, type TaskDeps, type TaskMoves } from "@/lib/task-action"
import { compactDate, dateKey, money, perCall, timeOnly } from "@/lib/format"
import { useMediaQuery, useMode } from "@/lib/mode"
import type { ApiCall, ApiDashboard, ApiTask } from "@/lib/types"
import { cn, tapWidth } from "@/lib/utils"
import { callOrigin, JUMP } from "@/lib/nav"

// One gate for every Done, Later and Undo on the page: one save at a time, and a double-click never reaches the next caller.
const taskGate = createTaskGate()

export function useTaskActions() {
  const { reload } = useMode()
  const deps: TaskDeps = {
    post: (callId, action, minutes) => api(`/api/app/calls/${encodeURIComponent(callId)}/task`, { method: "POST", body: { action, ...(minutes ? { minutes } : {}) } }),
    reload,
    toast: { success: (message, options) => void toast.success(message, options), message: (message) => void toast(message), error: (message) => void toast.error(message) },
    gate: taskGate,
  }
  return (callId: string, action: TaskAction, minutes?: number, moves: TaskMoves = {}): Promise<boolean> => runTaskAction(deps, callId, action, minutes, moves)
}

const LATER: Array<[string, number]> = [["In 1 hour", 60], ["In 4 hours", 240], ["Tomorrow", 1440]]

/** Done / Later for an open follow-up, Reopen for a handled one: the same tiles everywhere a call is shown. */
export function useTaskTiles() {
  const { preview } = useMode()
  const act = useTaskActions()
  // From the click until the list has reloaded, and a moment longer when the panel moved on to the next caller,
  // the status buttons are disabled: a second click never lands on the next caller's Done.
  const [pending, setPending] = useState(false)
  return (task: ApiTask | null | undefined, after?: () => Promise<void> | void, moves?: TaskMoves): Action[] => {
    if (preview || !task || task.status === "cancelled") return []
    const run = async (action: TaskAction, minutes?: number) => {
      setPending(true)
      let moved = false
      const tracked: TaskMoves | undefined = moves && { ...moves, leave: () => { moved = true; moves.leave?.() } }
      try {
        if (await act(task.callId, action, minutes, tracked)) await after?.()
      } finally {
        if (moved) window.setTimeout(() => setPending(false), QUIET_MS)
        else setPending(false)
      }
    }
    if (task.status === "completed") return [{ key: "reopen", label: "Reopen", icon: <RotateCcw />, group: "status", disabled: pending, busy: pending, onClick: () => void run("reopen") }]
    return [
      { key: "done", label: "Done", icon: <Check />, group: "status", disabled: pending, busy: pending, onClick: () => void run("complete") },
      { key: "later", label: "Later", icon: <Clock />, group: "status", disabled: pending, busy: pending, menu: LATER.map(([label, minutes]) => ({ label, onSelect: () => void run("snooze", minutes) })) },
    ]
  }
}

export function TodayPage() {
  const { dashboard, preview, base } = useMode()
  const [params] = useSearchParams()
  const location = useLocation()
  const wide = useMediaQuery("(min-width: 1024px)")
  if (!dashboard) return null
  // Old links: /app?view=pipeline|calendar
  const legacy = params.get("view")
  if (legacy === "pipeline" || legacy === "calendar") return <Navigate to={`${base}/${legacy === "pipeline" ? "jobs" : "calendar"}${params.get("call") ? `?call=${params.get("call")}` : ""}`} replace />
  const d = derive(dashboard)
  const selectedId = params.get("call")
  const selected = selectedId ? d.callsById.get(selectedId) ?? null : null
  // The last waiting caller was just marked done or moved to later, and no other call is still open: the panel
  // says so instead of opening a finished call or a robocall (until someone new is waiting).
  const doneLast = (location.state as { caughtUp?: string } | null)?.caughtUp
  const caughtUp = Boolean(doneLast) && !selected && d.actionable.every((task) => task.callId === doneLast)
  // Wide screens: one call is always open on the right, and it is the only place its buttons live.
  const panelCall = caughtUp ? null : selected ?? d.callsById.get(d.actionable[0]?.callId ?? "") ?? dashboard.calls[0] ?? null
  // One lit row: the one that was clicked (from=all marks the "All calls" list).
  const from = params.get("from")
  const waiting = new Set(d.actionable.map((task) => task.callId))
  const owner = !preview && dashboard.viewer.role === "owner"
  return (
    <div className={cn("grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start xl:grid-cols-[minmax(0,1fr)_440px]", selected && "max-lg:block")}>
      {/* On a phone, a selected call replaces the list (legacy ?call links). */}
      <div className={cn("grid min-w-0 gap-6", selected && "max-lg:hidden")}>
        {preview && (
          <Alert className="border-sky-200 bg-sky-50">
            <AlertTitle>Read-only demo</AlertTitle>
            <AlertDescription>Synthetic calls only. Real owners can call back, check off, and snooze.</AlertDescription>
          </Alert>
        )}
        {owner && <GuaranteeCard dashboard={dashboard} />}
        {owner && <SetupCard dashboard={dashboard} />}
        {/* Callers first: the line's state is one row under them, never a screen of setup above them. */}
        <section aria-labelledby="attention" className="grid gap-2.5 scroll-mt-20" id="attention-list">
          <SectionTitle id="attention" title="Needs your attention" count={d.actionable.length} urgent={d.urgentCount > 0} />
          {d.actionable.length ? (
            <ListBox className="@container">{d.actionable.map((task) => <TaskRow key={task.callId} task={task} call={d.callsById.get(task.callId)} due={d.due(task)} selected={attentionRowSelected({ wide, panelId: panelCall?.id, callId: task.callId, from })} open={wide && panelCall?.id === task.callId} wide={wide} />)}</ListBox>
          ) : (
            <Empty image title="You’re all caught up." text="Emergencies, callbacks and times to confirm show up here the moment a call ends." />
          )}
        </section>
        {/* Forwarding not on (or a new code to dial): one titled row to its own screen. Otherwise the line's state
            on a phone (a computer has it in the side menu). Never both: they'd say the same thing. */}
        {owner && dashboard.onboarding.completed && dashboard.viewer.status === "active" && dashboard.line.number && (!forwardingOn(dashboard.line) || dashboard.line.business.update) ? (
          <div className="grid gap-2.5">
            <ForwardingRow dashboard={dashboard} />
            <div className="lg:hidden empty:hidden"><AlertsOffNotice /></div>
          </div>
        ) : (
          // A computer has these in the side menu: nothing here, not even an empty gap.
          <div className="grid gap-2.5 empty:hidden lg:hidden"><LineStatus /><AlertsOffNotice /></div>
        )}
        <Summary dashboard={dashboard} />
        <ComingUp dashboard={dashboard} />
        <AllCalls dashboard={dashboard} panelId={wide ? panelCall?.id ?? null : null} from={from} waiting={waiting} />
        {owner && dashboard.onboarding.completed && <CalendarCard dashboard={dashboard} />}
      </div>
      <aside className={cn("lg:sticky lg:top-8", !selected && "max-lg:hidden")}>
        <CallPanel call={panelCall} task={panelCall ? d.taskFor(panelCall.id) : undefined} tz={d.tz} standalone={Boolean(selected)} linked caughtUp={caughtUp}
          next={(doneId) => nextOpenCall(d.actionable.map((task) => task.callId), stillOpenCalls(dashboard.calls, (callId) => d.taskFor(callId)?.status), doneId)} />
      </aside>
    </div>
  )
}

/** Three numbers, one row, no empty space reserved for a pill. Each one opens where it leads. */
function Summary({ dashboard }: { dashboard: ApiDashboard }) {
  const { base, preview, member } = useMode()
  const d = derive(dashboard)
  const usage = dashboard.usage
  const cell = "grid min-h-[84px] content-center gap-1 px-3.5 py-3 hover:bg-muted/60 md:px-5"
  const label = "text-[13px] font-medium text-muted-foreground md:text-sm"
  const number = "tabular text-[30px] leading-none font-semibold tracking-tight md:text-4xl"
  return (
    <div className="grid gap-2.5">
      <nav aria-label="Shop overview" className="grid grid-cols-3 divide-x overflow-hidden rounded-xl border bg-card">
        <a href="#attention-list" className={cell}>
          <span className={label}>To call back</span>
          <strong className={cn(number, d.urgentCount > 0 && "text-red-700")}>{d.actionable.length}</strong>
        </a>
        <Link to={`${base}/calendar`} className={cell}>
          <span className={label}>Booked</span>
          <strong className={number}>{d.booked.length}</strong>
        </Link>
        {/* Nowhere to go in the demo or for a teammate (Plan is the owner's): plain text, saying out of how many. */}
        {preview || member ? (
          <div className={cn(cell, "hover:bg-transparent")}>
            <span className={label}>{usage.unlimited ? "Answered" : "Calls left"}</span>
            <strong className={number}>{usage.unlimited ? d.used : d.remaining}</strong>
            {!usage.unlimited && <span className="text-[13px] text-muted-foreground">of {d.included}</span>}
          </div>
        ) : (
          <Link to={`${base}/settings/plan`} state={JUMP} className={cell}>
            <span className={label}>{usage.unlimited ? "Answered" : "Calls left"}</span>
            <strong className={number}>{usage.unlimited ? d.used : d.remaining}</strong>
          </Link>
        )}
      </nav>
      {usage.extraCalls > 0 && !member && (
        <Link to={`${base}/settings/plan`} state={JUMP} className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-amber-50 px-3.5 py-2.5 text-[15px] text-amber-950 ring-1 ring-amber-200 ring-inset">
          <span><strong className="font-semibold">{usage.extraCalls} extra calls</strong> at {perCall(usage.overageCentsPerCall)}: <span className="tabular">{money(usage.extraCents)}</span> so far</span>
          <span className="flex shrink-0 items-center font-semibold">See plans<ChevronRight className="size-4" /></span>
        </Link>
      )}
    </div>
  )
}

function Meta({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="inline-flex min-w-0 items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0">{icon}<span className="truncate">{children}</span></span>
}

/**
 * A caller waiting on the owner. Phone: the row carries Call back / Done / Later (no detail pane there).
 * Wide screens: the row selects; every row but the open one carries one quiet Done. The open call's buttons live
 * once, in the pane on the right (`open`, whichever list it was opened from; `selected` is the lit row).
 */
function TaskRow({ task, call, due, selected, open, wide }: { task: ApiTask; call: ApiCall | undefined; due: string; selected: boolean; open: boolean; wide: boolean }) {
  const { preview } = useMode()
  const act = useTaskActions()
  const [pending, setPending] = useState(false)
  const badge = urgency(task, call)
  const address = shortAddress(call)
  const body = (
    <>
      <span className="flex items-start justify-between gap-3">
        <strong className="truncate text-[17px] font-semibold">{call?.fields.callerName ?? "Unknown caller"}</strong>
        <ToneBadge tone={badge.tone}>{badge.label}</ToneBadge>
      </span>
      <span className="line-clamp-2 text-[15px] text-foreground/90">{call?.fields.problemDescription || task.reason}</span>
      <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {/* Urgent always reads "Call back now", at least as strong as a routine call that's due. */}
        <Meta icon={<Clock />}><span className={cn(badge.tone === "danger" && "font-semibold text-red-700")}>{due === "Due now" || badge.tone === "danger" ? "Call back now" : due.startsWith("Due today ") ? `Call back today by ${due.slice("Due today ".length)}` : due.replace(/^Due/, "Call back by")}</span></Meta>
        {address && <Meta icon={<MapPin />}>{address}</Meta>}
      </span>
    </>
  )
  if (wide) {
    // The link's ::after covers the row, so a click anywhere selects it; Done sits above that layer. Every row keeps
    // the Done column (an invisible stand-in on the open row), so all badges share one right edge and never move.
    // A narrow list (a 1024px screen, beside the open call) has no room for that column: Done goes under the row,
    // at the right, and the open row needs no stand-in.
    const doneClass = "relative z-10 inline-flex h-11 items-center gap-1.5 justify-self-end self-end rounded-lg border border-transparent px-2.5 text-sm font-semibold text-muted-foreground transition-colors group-hover:border-muted-foreground hover:bg-card hover:text-foreground focus-visible:border-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-ink disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4"
    const done = () => {
      setPending(true)
      void act(task.callId, "complete").finally(() => setPending(false))
    }
    return (
      <div className={cn("group relative px-4 py-3.5 hover:bg-muted/50", preview ? "grid" : "grid grid-cols-1 gap-2 @sm:grid-cols-[minmax(0,1fr)_auto] @sm:gap-3", selected && SELECTED_ROW)}>
        <CallLink callId={task.callId} aria-current={selected} className="grid grid-cols-1 gap-1.5 outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-brand-ink">{body}</CallLink>
        {rowShowsDone({ wide, open, preview }) ? (
          <button type="button" aria-label={`Mark ${call?.fields.callerName ?? "call"} handled`} disabled={pending} aria-busy={pending || undefined} onClick={done} className={doneClass}>
            <Check />Done
          </button>
        ) : !preview && <span aria-hidden className={cn(doneClass, "invisible @max-sm:hidden")}><Check />Done</span>}
      </div>
    )
  }
  return (
    <article className="grid min-w-0 gap-3 px-4 py-4">
      <CallLink callId={task.callId} className="grid grid-cols-1 gap-1.5">{body}</CallLink>
      {/* Call, Done and Later side by side; on a small phone (320px) Call takes its own row so no label is cut.
          The demo has no Done or Later: Call and Details share the row. */}
      <div className={cn("grid gap-2 [&>*]:px-2", preview ? "grid-cols-2 @[20rem]:grid-cols-[minmax(0,1.5fr)_minmax(0,2fr)]" : "grid-cols-2 *:first:col-span-2 @[20rem]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)] @[20rem]:*:first:col-span-1")}>
        {call?.phone && call.outcome !== "ignored_spam"
          ? preview
            // The demo's numbers are made up: never dial one.
            ? <Button size="tap" className="w-full" onClick={() => toast(`In your account, this calls ${call.fields.callerName?.split(" ")[0] ?? "the caller"} from your phone.`)}><Phone /><span className="truncate">{callLabel(call)}</span></Button>
            : <Button size="tap" className="w-full" asChild><a href={`tel:${call.phone}`}><Phone /><span className="truncate">{callLabel(call)}</span></a></Button>
          : <Button size="tap" className="w-full" asChild><CallLink callId={task.callId}>Open</CallLink></Button>}
        {preview ? (
          <Button size="tap" variant="outline" className="w-full" asChild><CallLink callId={task.callId}>Details</CallLink></Button>
        ) : (
          <>
            <Button size="tap" variant="outline" className="w-full" aria-label={`Mark ${call?.fields.callerName ?? "call"} handled`} onClick={() => void act(task.callId, "complete")}><Check />Done</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="tap" variant="outline" className="w-full"><Clock />Later</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                {LATER.map(([label, minutes]) => <DropdownMenuItem key={label} className="min-h-11 text-[15px]" onSelect={() => void act(task.callId, "snooze", minutes)}>{label}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </article>
  )
}

/** The next booked or requested visits, right under the callbacks: the calendar is one glance, not one scroll. */
function ComingUp({ dashboard }: { dashboard: ApiDashboard }) {
  const { base } = useMode()
  const d = derive(dashboard)
  return (
    <section className="grid gap-2.5">
      <SectionTitle title="Coming up" count={d.upcoming.length} action={<MoreLink to={`${base}/calendar`}>Calendar</MoreLink>} />
      {d.upcoming.length ? (
        <ListBox>{d.upcoming.slice(0, 3).map((call) => <VisitRow key={call.id} call={call} tz={d.tz} nowMs={d.nowMs} done={d.taskFor(call.id)?.status === "completed"} />)}</ListBox>
      ) : (
        <ListBox><Muted>Nothing booked or requested in the next 7 days.</Muted></ListBox>
      )}
    </section>
  )
}

export function DateTile({ value, tz, nowMs }: { value: string; tz: string; nowMs: number }) {
  const date = new Date(value)
  const today = dateKey(date, tz) === dateKey(new Date(nowMs), tz)
  return (
    <span className={cn("grid w-12 shrink-0 justify-items-center rounded-lg py-1.5 leading-none", today ? "bg-brand-yellow text-brand-ink" : "bg-secondary")}>
      <small className="text-[11px] font-semibold tracking-wide uppercase">{today ? "Today" : new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date)}</small>
      <strong className="tabular mt-1 text-xl font-semibold">{new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(date)}</strong>
    </span>
  )
}

/** done: the owner already marked it Done (called to confirm), so it no longer asks for a confirmation. */
function VisitRow({ call, tz, nowMs, done }: { call: ApiCall; tz: string; nowMs: number; done: boolean }) {
  const booked = call.outcome === "booked"
  return (
    <CallLink callId={call.id} className="flex min-h-16 items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
      <DateTile value={call.fields.requestedStart!} tz={tz} nowMs={nowMs} />
      <span className="grid min-w-0 flex-1">
        <strong className="tabular text-base font-semibold">{timeOnly(call.fields.requestedStart!, tz)}</strong>
        <span className="truncate text-[15px] text-muted-foreground">{call.fields.callerName ?? "Unknown caller"}</span>
      </span>
      <ToneBadge tone={booked ? "good" : done ? "neutral" : "warn"}>{booked ? "Booked" : done ? "Done" : "Confirm time"}</ToneBadge>
    </CallLink>
  )
}

/** Every answered call, newest first, ten to a page. Replaces “Recent calls” and “Recent activity”. */
function AllCalls({ dashboard, panelId, from, waiting }: { dashboard: ApiDashboard; panelId: string | null; from: string | null; waiting: ReadonlySet<string> }) {
  const d = derive(dashboard)
  const { rows, pager } = usePage(dashboard.calls)
  return (
    <section className="grid gap-2.5">
      <SectionTitle title="All calls" />
      {dashboard.calls.length ? (
        <>
          <ListBox>{rows.map((call) => <CallRow key={call.id} call={call} task={d.taskFor(call.id)} tz={d.tz} list="all" selected={allCallsRowSelected({ panelId, callId: call.id, from, actionable: waiting })} />)}</ListBox>
          {pager}
        </>
      ) : <ListBox><Muted>No calls yet. Your first answered call shows up here.</Muted></ListBox>}
    </section>
  )
}

export function CallRow({ call, task, tz, selected, list }: { call: ApiCall; task: ApiTask | undefined; tz: string; selected: boolean; list?: "all" }) {
  const badge = urgency(task, call)
  const spam = call.outcome === "ignored_spam"
  return (
    <CallLink callId={call.id} list={list} aria-current={selected} className={cn("grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-3 hover:bg-muted/50", ROW_FOCUS, selected && SELECTED_ROW)}>
      <strong className={cn("truncate text-base font-semibold", spam && "font-medium text-muted-foreground")}>{call.fields.callerName ?? "Unknown caller"}</strong>
      <time className="tabular text-right text-sm text-muted-foreground">{compactDate(call.startedAt, tz)}</time>
      <span className="truncate text-[15px] text-muted-foreground">{call.fields.problemDescription || (spam ? "Robocall or sales pitch" : "No summary")}</span>
      <span className="flex items-center justify-end gap-1.5">
        <ToneBadge tone={badge.tone} className="h-5.5 px-1.5 text-xs">{badge.label}</ToneBadge>
        <ChevronRight className="size-4 text-muted-foreground lg:hidden" />
      </span>
    </CallLink>
  )
}

/** Forwarding isn't on yet (or a changed choice needs its new code): one row that opens the forwarding screen. */
function ForwardingRow({ dashboard }: { dashboard: ApiDashboard }) {
  const update = forwardingOn(dashboard.line) && dashboard.line.business.update
  return (
    <Link to="/app/start?step=forward" className="flex min-h-14 items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3 text-amber-950 ring-1 ring-amber-200 ring-inset hover:bg-amber-100">
      <span className="flex min-w-0 items-center gap-2.5">
        <PhoneForwarded className="size-5 shrink-0" />
        <span className="grid min-w-0">
          <strong className="text-[15px] font-semibold">{update ? "Dial your new code" : "Forwarding isn’t on"}</strong>
          <span className="text-sm">{update ? "Your change is on once you dial it." : "Otto won’t get calls until it is."}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center text-[15px] font-semibold">{update ? "Show code" : "Finish"}<ChevronRight className="size-4" /></span>
    </Link>
  )
}

/** Until the new-owner flow is finished, Calls points back to the one next step. */
function SetupCard({ dashboard }: { dashboard: ApiDashboard }) {
  if (dashboard.onboarding.completed) return null
  const steps = [
    { done: true, label: "Your shop" },
    { done: dashboard.paid, label: "Your card" },
    { done: Boolean(dashboard.line.confirmedAt), label: "Forward your calls" },
  ]
  const done = steps.filter((step) => step.done).length
  const next = steps.find((step) => !step.done)
  return (
    <section className="grid gap-3 rounded-xl border-2 border-brand-ink bg-card p-4 md:flex md:items-center md:justify-between">
      <div className="grid gap-0.5">
        <h2 className="text-[17px] font-semibold"><span className="marker">Finish setup</span></h2>
        <p className="text-[15px] text-muted-foreground"><span className="tabular">{done} of {steps.length}</span> done.{next ? ` Next: ${next.label.toLowerCase()}.` : " Just one tap left."}</p>
      </div>
      <Button size="tap" variant="brand" className={tapWidth} asChild><Link to="/app/start">Continue setup<ArrowRight /></Link></Button>
    </section>
  )
}

/** Optional, after setup: booked jobs on Google Calendar. Going live never needs it. */
function CalendarCard({ dashboard }: { dashboard: ApiDashboard }) {
  const { base, member } = useMode()
  if (member || !dashboard.googleAvailable || dashboard.googleConnected) return null
  return (
    <Link to={`${base}/settings/calendar`} state={JUMP} className="flex min-h-14 items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-[15px] hover:bg-muted/50">
      <span><strong className="font-semibold">Put jobs on Google Calendar</strong><span className="block text-sm text-muted-foreground">Optional. Confirmed jobs land on your calendar.</span></span>
      <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
    </Link>
  )
}

/**
 * The lead guarantee, only when the server has counted zero real leads in the first 30 days (days 30–37).
 * The tap is re-checked on the server, so this card is a shortcut, never the decision.
 */
function GuaranteeCard({ dashboard }: { dashboard: ApiDashboard }) {
  const { reload } = useMode()
  const [busy, setBusy] = useState(false)
  const g = dashboard.guarantee
  if (g.state === "refunded" && g.refund) {
    return (
      <p role="status" className="rounded-xl bg-emerald-50 px-4 py-3 text-[15px] text-emerald-950 ring-1 ring-emerald-200 ring-inset">
        <strong className="block">Your first month is refunded.</strong>{money(g.refund.amountCents)} goes back to your card in 5 to 10 business days.
      </p>
    )
  }
  if (g.state !== "eligible") return null
  const until = g.claimUntil ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: dashboard.shop.timezone }).format(new Date(g.claimUntil)) : null
  const refund = async () => {
    setBusy(true)
    try {
      await api("/api/app/billing/lead-refund", { method: "POST", body: {} })
      toast.success("Refund on its way.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn’t work. Reply to your receipt and we’ll refund you.")
    } finally {
      await reload().catch(() => undefined)
      setBusy(false)
    }
  }
  return (
    <section className="grid gap-3 rounded-xl border-2 border-brand-ink bg-card p-4">
      <div className="grid gap-1">
        <h2 className="text-[17px] font-semibold">Request refund</h2>
        <p className="text-[15px]">No real customer leads came in during your first 30 days. That’s on us: your first month is refundable{until ? ` until ${until}` : ""}.</p>
      </div>
      <Button size="tap" variant="brand" className={tapWidth} disabled={busy} onClick={() => void refund()}>{busy ? <Loader2 className="animate-spin" /> : null}Refund my first month</Button>
      <p className="text-sm text-muted-foreground">Your line keeps working. Cancel anytime from Settings, Plan &amp; billing.</p>
    </section>
  )
}

/** Bring the lit row into sight when the panel moved on to a caller whose row is off-screen (under the top bar counts). */
function revealLitRow() {
  const link = document.querySelector<HTMLElement>('[aria-current="true"]')
  if (!link) return
  const row = (link.closest(".group") ?? link).getBoundingClientRect()
  const top = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0
  const delta = revealDelta(row, { top: Math.max(0, top), bottom: window.innerHeight })
  if (delta) window.scrollBy({ top: delta, behavior: "smooth" })
}

/**
 * The open call: the one place on wide screens with its buttons. On a phone, legacy ?call= links show it alone.
 * With `next` (Calls), Done or Later on a wide screen moves the panel to the next caller; Undo brings it back.
 * `linked` (Calls only) ties the panel to the lit row: the matching ink left edge and the yellow header band.
 */
export function CallPanel({ call, task, tz, standalone, next, linked = false, caughtUp = false, hasCalls = false }: { call: ApiCall | null; task: ApiTask | undefined; tz: string; standalone: boolean; next?: (doneId: string) => string | null; linked?: boolean; caughtUp?: boolean; hasCalls?: boolean }) {
  const { base, preview } = useMode()
  const tiles = useTaskTiles()
  const wide = useMediaQuery("(min-width: 1024px)")
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  // Only while the owner is still on this page: an Undo tapped after leaving never pulls them back.
  const openCall = (id: string | null, doneId?: string) => {
    if (window.location.pathname !== pathname) return
    navigate({ pathname, search: panelSearch(window.location.search, id) }, { replace: true, state: id ? null : { caughtUp: doneId } })
  }
  // After Done or Later, focus goes to the panel the next caller now fills, not their Done button.
  const focusPanel = () => requestAnimationFrame(() => {
    const panel = document.getElementById("detail")
    const active = document.activeElement
    if (panel && (!active || active === document.body || panel.contains(active))) panel.focus({ preventScroll: true })
  })
  if (!call) {
    if (caughtUp) {
      return (
        <Card>
          <CardContent className="grid gap-1.5">
            <h2 className="text-lg font-semibold">You’re all caught up.</h2>
            <p className="text-[15px] text-muted-foreground">Emergencies, callbacks and times to confirm show up here the moment a call ends.</p>
          </CardContent>
        </Card>
      )
    }
    if (hasCalls) {
      return (
        <Card>
          <CardContent className="grid gap-1.5">
            <h2 className="text-lg font-semibold">Pick a job</h2>
            <p className="text-[15px] text-muted-foreground">Nothing in this list right now. Pick another tab to see its jobs.</p>
          </CardContent>
        </Card>
      )
    }
    return (
      <Card>
        <CardContent className="grid gap-1.5">
          <h2 className="text-lg font-semibold">No calls yet</h2>
          <p className="text-[15px] text-muted-foreground">When Call Otto answers, the caller, problem and next step show up here.</p>
        </CardContent>
      </Card>
    )
  }
  const badge = urgency(task, call)
  const spam = call.outcome === "ignored_spam"
  const facts: Array<[string, string]> = [
    phoneFact(call),
    ["Address", call.fields.address?.trim() || "Not confirmed"],
    ["Called", compactDate(call.startedAt, tz)],
    ...(call.fields.requestedStart ? [[call.outcome === "booked" ? "Booked for" : "Asked for", compactDate(call.fields.requestedStart, tz)] as [string, string]] : []),
    ...(call.fields.equipmentDetails ? [["Equipment", call.fields.equipmentDetails] as [string, string]] : []),
    ...(call.fields.accessNotes ? [["Access", call.fields.accessNotes] as [string, string]] : []),
  ]
  const callId = call.id
  const moves: TaskMoves | undefined = wide && next ? {
    leave: () => {
      const to = next(callId)
      openCall(to, callId)
      focusPanel()
    },
    back: () => openCall(callId),
    settle: () => requestAnimationFrame(() => requestAnimationFrame(revealLitRow)),
  } : undefined
  return (
    <section id="detail" aria-label="Open call" tabIndex={linked ? -1 : undefined} className={cn("grid gap-4 rounded-xl border bg-card p-4 lg:max-h-[calc(100dvh-4rem)] lg:overflow-y-auto lg:p-5", linked && cn(PANEL_EDGE, "outline-none"))}>
      {standalone && <Button variant="ghost" className="-ml-2 h-11 w-fit text-base lg:hidden" asChild><Link to={base}>← Calls</Link></Button>}
      {linked ? (
        // The same yellow as the lit row: the header band names the caller whose row is lit.
        <div className="-mx-4 -mt-4 rounded-tr-xl bg-accent px-4 pt-4 pb-3 lg:-mx-5 lg:-mt-5 lg:px-5 lg:pt-5">
          <CallHeader call={call} tone={badge.tone} label={badge.label} />
        </div>
      ) : <CallHeader call={call} tone={badge.tone} label={badge.label} />}
      <SafetyNote call={call} />
      {spam && <SpamNote />}
      <ActionBar call={call} extra={spam ? [] : tiles(task, undefined, moves)} reachNote={<CallBackNote call={call} />} />
      <Facts rows={facts} />
      <div className="grid gap-3">
        <h3 className="text-[17px] font-semibold">Call transcript</h3>
        <Transcript call={call} />
      </div>
      <Link className="inline-flex min-h-11 items-center gap-0.5 text-[15px] font-semibold text-brand-ink" to={`${base}/calls/${encodeURIComponent(call.id)}`} state={{ origin: callOrigin({ base, pathname, search }) }}>
        {preview ? "Open the full call" : "Recording and full record"}<ChevronRight className="size-4" />
      </Link>
    </section>
  )
}
