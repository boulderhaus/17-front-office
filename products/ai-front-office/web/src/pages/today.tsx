import { useState, type ReactNode } from "react"
import { Link, Navigate, useSearchParams } from "react-router-dom"
import { ArrowRight, Check, ChevronRight, Clock, Loader2, MapPin, Phone, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { CallLink, Empty, ListBox, MoreLink, Muted, SectionTitle, ToneBadge, usePage } from "@/components/app/bits"
import { ActionBar, CallBackNote, CallHeader, callLabel, Facts, phoneFact, SafetyNote, SpamNote, Transcript, type Action } from "@/components/app/call-parts"
import { AlertsOffNotice, LineStatus } from "@/components/app/shell"
import { api } from "@/lib/api"
import { derive, shortAddress, urgency } from "@/lib/derive"
import { compactDate, dateKey, money, perCall, timeOnly } from "@/lib/format"
import { useMediaQuery, useMode } from "@/lib/mode"
import { ForwardingCard } from "@/components/app/forwarding-card"
import type { ApiCall, ApiDashboard, ApiTask } from "@/lib/types"
import { cn, tapWidth } from "@/lib/utils"

export function useTaskActions() {
  const { reload } = useMode()
  const act = async (callId: string, action: "complete" | "reopen" | "snooze", minutes?: number) => {
    try {
      await api(`/api/app/calls/${encodeURIComponent(callId)}/task`, { method: "POST", body: { action, ...(minutes ? { minutes } : {}) } })
      await reload()
      if (action === "complete") {
        toast.success("Marked done.", { action: { label: "Undo", onClick: () => void act(callId, "reopen") } })
      } else if (action === "snooze") {
        toast("Moved to Waiting.")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn’t save. Please try again.")
    }
  }
  return act
}

const LATER: Array<[string, number]> = [["In 1 hour", 60], ["In 4 hours", 240], ["Tomorrow", 1440]]

/** Done / Later for an open follow-up, Reopen for a handled one: the same tiles everywhere a call is shown. */
export function useTaskTiles() {
  const { preview } = useMode()
  const act = useTaskActions()
  return (task: ApiTask | null | undefined, after?: () => Promise<void> | void): Action[] => {
    if (preview || !task || task.status === "cancelled") return []
    const run = async (action: "complete" | "reopen" | "snooze", minutes?: number) => { await act(task.callId, action, minutes); await after?.() }
    if (task.status === "completed") return [{ key: "reopen", label: "Reopen", icon: <RotateCcw />, onClick: () => void run("reopen") }]
    return [
      { key: "done", label: "Done", icon: <Check />, onClick: () => void run("complete") },
      { key: "later", label: "Later", icon: <Clock />, menu: LATER.map(([label, minutes]) => ({ label, onSelect: () => void run("snooze", minutes) })) },
    ]
  }
}

export function TodayPage() {
  const { dashboard, preview, base } = useMode()
  const [params] = useSearchParams()
  const wide = useMediaQuery("(min-width: 1024px)")
  if (!dashboard) return null
  // Old links: /app?view=pipeline|calendar
  const legacy = params.get("view")
  if (legacy === "pipeline" || legacy === "calendar") return <Navigate to={`${base}/${legacy === "pipeline" ? "jobs" : "calendar"}${params.get("call") ? `?call=${params.get("call")}` : ""}`} replace />
  const d = derive(dashboard)
  const selectedId = params.get("call")
  const selected = selectedId ? d.callsById.get(selectedId) ?? null : null
  // Wide screens: one call is always open on the right, and it is the only place its buttons live.
  const panelCall = selected ?? d.callsById.get(d.actionable[0]?.callId ?? "") ?? dashboard.calls[0] ?? null
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
        <div className="grid gap-2.5 empty:hidden lg:hidden"><LineStatus /><AlertsOffNotice /></div>
        {owner && <GuaranteeCard dashboard={dashboard} />}
        {owner && <SetupCard dashboard={dashboard} />}
        {owner && dashboard.onboarding.completed && dashboard.viewer.status === "active" && dashboard.line.number && <ForwardingCard dashboard={dashboard} />}
        <Summary dashboard={dashboard} />
        <section aria-labelledby="attention" className="grid gap-2.5 scroll-mt-20" id="attention-list">
          <SectionTitle id="attention" title="Needs your attention" count={d.actionable.length} urgent={d.urgentCount > 0} />
          {d.actionable.length ? (
            <ListBox>{d.actionable.map((task) => <TaskRow key={task.callId} task={task} call={d.callsById.get(task.callId)} due={d.due(task)} selected={wide && panelCall?.id === task.callId} wide={wide} />)}</ListBox>
          ) : (
            <Empty image title="You’re all caught up." text="Emergencies, callbacks and times to confirm show up here the moment a call ends." />
          )}
        </section>
        <ComingUp dashboard={dashboard} />
        <AllCalls dashboard={dashboard} panelId={wide ? panelCall?.id ?? null : null} />
        {owner && dashboard.onboarding.completed && <CalendarCard dashboard={dashboard} />}
      </div>
      <aside className={cn("lg:sticky lg:top-20", !selected && "max-lg:hidden")}>
        <CallPanel call={panelCall} task={panelCall ? d.taskFor(panelCall.id) : undefined} tz={d.tz} standalone={Boolean(selected)} />
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
        <Link to={preview || member ? `${base}` : `${base}/settings/plan`} className={cell}>
          <span className={label}>{usage.unlimited ? "Answered" : "Calls left"}</span>
          <strong className={number}>{usage.unlimited ? d.used : d.remaining}</strong>
        </Link>
      </nav>
      {usage.extraCalls > 0 && !member && (
        <Link to={`${base}/settings/plan`} className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-amber-50 px-3.5 py-2.5 text-[15px] text-amber-950 ring-1 ring-amber-200 ring-inset">
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
 * Wide screens: the row only selects; the buttons live once, in the pane on the right.
 */
function TaskRow({ task, call, due, selected, wide }: { task: ApiTask; call: ApiCall | undefined; due: string; selected: boolean; wide: boolean }) {
  const { preview } = useMode()
  const act = useTaskActions()
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
        <Meta icon={<Clock />}><span className={cn(due === "Due now" && badge.tone === "danger" && "font-semibold text-red-700")}>{due === "Due now" ? "Call back now" : due.replace(/^Due/, "Call back by")}</span></Meta>
        {address && <Meta icon={<MapPin />}>{address}</Meta>}
      </span>
    </>
  )
  if (wide) {
    return (
      <CallLink callId={task.callId} aria-current={selected} className={cn("grid gap-1.5 px-4 py-3.5 hover:bg-muted/50", selected && "bg-accent hover:bg-accent")}>{body}</CallLink>
    )
  }
  return (
    <article className="grid min-w-0 gap-3 px-4 py-4">
      <CallLink callId={task.callId} className="grid gap-1.5">{body}</CallLink>
      <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 [&>*]:px-2">
        {call?.phone && call.outcome !== "ignored_spam"
          ? <Button size="tap" className="w-full" asChild><a href={`tel:${call.phone}`}><Phone />{callLabel(call)}</a></Button>
          : <Button size="tap" className="w-full" asChild><CallLink callId={task.callId}>Open</CallLink></Button>}
        {preview ? (
          <Button size="tap" variant="outline" className="col-span-2 w-full" asChild><CallLink callId={task.callId}>Details</CallLink></Button>
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
        <ListBox>{d.upcoming.slice(0, 3).map((call) => <VisitRow key={call.id} call={call} tz={d.tz} nowMs={d.nowMs} />)}</ListBox>
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

function VisitRow({ call, tz, nowMs }: { call: ApiCall; tz: string; nowMs: number }) {
  const booked = call.outcome === "booked"
  return (
    <CallLink callId={call.id} className="flex min-h-16 items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
      <DateTile value={call.fields.requestedStart!} tz={tz} nowMs={nowMs} />
      <span className="grid min-w-0 flex-1">
        <strong className="tabular text-base font-semibold">{timeOnly(call.fields.requestedStart!, tz)}</strong>
        <span className="truncate text-[15px] text-muted-foreground">{call.fields.callerName ?? "Unknown caller"}</span>
      </span>
      <ToneBadge tone={booked ? "good" : "warn"}>{booked ? "Booked" : "Confirm time"}</ToneBadge>
    </CallLink>
  )
}

/** Every answered call, newest first, ten to a page. Replaces “Recent calls” and “Recent activity”. */
function AllCalls({ dashboard, panelId }: { dashboard: ApiDashboard; panelId: string | null }) {
  const d = derive(dashboard)
  const { rows, pager } = usePage(dashboard.calls)
  return (
    <section className="grid gap-2.5">
      <SectionTitle title="All calls" />
      {dashboard.calls.length ? (
        <>
          <ListBox>{rows.map((call) => <CallRow key={call.id} call={call} task={d.taskFor(call.id)} tz={d.tz} selected={panelId === call.id} />)}</ListBox>
          {pager}
        </>
      ) : <ListBox><Muted>No calls yet. Your first answered call shows up here.</Muted></ListBox>}
    </section>
  )
}

export function CallRow({ call, task, tz, selected }: { call: ApiCall; task: ApiTask | undefined; tz: string; selected: boolean }) {
  const badge = urgency(task, call)
  const spam = call.outcome === "ignored_spam"
  return (
    <CallLink callId={call.id} aria-current={selected} className={cn("grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-3 hover:bg-muted/50", selected && "bg-accent hover:bg-accent")}>
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
    <Link to={`${base}/settings/calendar`} className="flex min-h-14 items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-[15px] hover:bg-muted/50">
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

/** The open call: the one place on wide screens with its buttons. On a phone, legacy ?call= links show it alone. */
export function CallPanel({ call, task, tz, standalone }: { call: ApiCall | null; task: ApiTask | undefined; tz: string; standalone: boolean }) {
  const { base, preview } = useMode()
  const tiles = useTaskTiles()
  if (!call) {
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
  return (
    <section id="detail" aria-label="Open call" className="grid gap-4 rounded-xl border bg-card p-4 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:p-5">
      {standalone && <Button variant="ghost" className="-ml-2 h-11 w-fit text-base lg:hidden" asChild><Link to={base}>← Calls</Link></Button>}
      <CallHeader call={call} tone={badge.tone} label={badge.label} />
      <SafetyNote call={call} />
      {spam && <SpamNote />}
      <ActionBar call={call} extra={spam ? [] : tiles(task)} />
      <CallBackNote call={call} />
      <Facts rows={facts} />
      <div className="grid gap-3">
        <h3 className="text-[17px] font-semibold">Call transcript</h3>
        <Transcript call={call} />
      </div>
      <Link className="inline-flex min-h-11 items-center gap-0.5 text-[15px] font-semibold text-brand-ink" to={`${base}/calls/${encodeURIComponent(call.id)}`}>
        {preview ? "Open the full call" : "Recording and full record"}<ChevronRight className="size-4" />
      </Link>
    </section>
  )
}
