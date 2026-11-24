import { lazy, Suspense, useState } from "react"
import { Link, Navigate, useSearchParams } from "react-router-dom"
import { ArrowRight, CalendarDays, Check, ChevronRight, Clock, Loader2, Phone } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { CallLink, Empty, Muted, SectionTitle, ToneBadge, ToneDot } from "@/components/app/bits"
import { CallHeader, ContactActions, Facts, phoneFact, SafetyNote } from "@/components/app/call-parts"
import { api } from "@/lib/api"
import { derive, shortAddress, urgency } from "@/lib/derive"
import { compactDate, dayLabel, money, perCall, timeOnly } from "@/lib/format"
import { useMode } from "@/lib/mode"
import { ForwardingCard } from "@/components/app/forwarding-card"
import type { ApiCall, ApiDashboard, ApiTask } from "@/lib/types"
import { cn, tapWidth } from "@/lib/utils"

const CallsChart = lazy(() => import("@/components/app/calls-chart"))

export function useTaskActions() {
  const { reload } = useMode()
  const act = async (callId: string, action: "complete" | "reopen" | "snooze", minutes?: number) => {
    try {
      await api(`/api/app/calls/${encodeURIComponent(callId)}/task`, { method: "POST", body: { action, ...(minutes ? { minutes } : {}) } })
      await reload()
      if (action === "complete") {
        toast.success("Marked handled.", { action: { label: "Undo", onClick: () => void act(callId, "reopen") } })
      } else if (action === "snooze") {
        toast("Moved to Waiting.")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn’t save. Please try again.")
    }
  }
  return act
}

export function TodayPage() {
  const { dashboard, preview, base } = useMode()
  const [params] = useSearchParams()
  if (!dashboard) return null
  // Old links: /app?view=pipeline|calendar
  const legacy = params.get("view")
  if (legacy === "pipeline" || legacy === "calendar") return <Navigate to={`${base}/${legacy === "pipeline" ? "jobs" : "calendar"}${params.get("call") ? `?call=${params.get("call")}` : ""}`} replace />
  const d = derive(dashboard)
  const selectedId = params.get("call")
  const selected = selectedId ? d.callsById.get(selectedId) ?? null : null
  const panelCall = selected ?? d.callsById.get(d.actionable[0]?.callId ?? "") ?? dashboard.calls[0] ?? null
  return (
    <div className={cn("grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start", selected && "max-lg:block")}>
      {/* On a phone, a selected call replaces the list (legacy ?call links). */}
      <div className={cn("grid min-w-0 gap-5", selected && "max-lg:hidden")}>
        <Banners dashboard={dashboard} />
        {!preview && dashboard.viewer.role === "owner" && <GuaranteeCard dashboard={dashboard} />}
        {!preview && dashboard.viewer.role === "owner" && <SetupCard dashboard={dashboard} />}
        {!preview && dashboard.viewer.role === "owner" && dashboard.onboarding.completed && dashboard.viewer.status === "active" && dashboard.line.number && <ForwardingCard dashboard={dashboard} />}
        {!preview && dashboard.viewer.role === "owner" && dashboard.onboarding.completed && <CalendarCard dashboard={dashboard} />}
        <StatCards dashboard={dashboard} />
        <section id="inbox" className="grid gap-2.5">
          <SectionTitle title="Needs your attention" count={d.actionable.length} />
          {d.actionable.length ? (
            <div className="grid gap-2.5">{d.actionable.map((task) => <TaskCard key={task.callId} task={task} call={d.callsById.get(task.callId)} dashboard={dashboard} />)}</div>
          ) : (
            <Empty image title="You’re all caught up." text="New emergencies, callbacks and times to confirm show up here automatically." />
          )}
        </section>
        <Suspense fallback={null}><CallsChart calls={dashboard.calls} now={dashboard.now} tz={dashboard.shop.timezone} /></Suspense>
        <section className="grid gap-2.5">
          <SectionTitle title="Coming up" action={<Link className="text-sm font-semibold" to={`${base}/calendar`}>Calendar</Link>} />
          <Card className="gap-0 py-0">
            {d.upcoming.length ? d.upcoming.slice(0, 4).map((call) => <AppointmentRow key={call.id} call={call} tz={d.tz} nowMs={d.nowMs} />) : <Muted>Nothing scheduled in the next 7 days.</Muted>}
          </Card>
        </section>
        <section id="recent-calls" className="grid gap-2.5">
          <SectionTitle title="Recent calls" action={<Link className="text-sm font-semibold" to={`${base}/jobs`}>All jobs</Link>} />
          <Card className="gap-0 py-0">
            {dashboard.calls.length ? dashboard.calls.slice(0, 8).map((call) => <CallRow key={call.id} call={call} task={d.taskFor(call.id)} tz={d.tz} selected={panelCall?.id === call.id} />) : <Muted>No calls yet. Your first answered call shows up here.</Muted>}
          </Card>
        </section>
        <section className="grid gap-2.5">
          <SectionTitle title="Recent activity" />
          <Card className="gap-0 py-0">
            {d.activity.length ? d.activity.map((item, index) => (
              <div key={index} className="flex items-center justify-between gap-3 border-t px-4 py-3 text-sm first:border-t-0">
                <span>{item.text}</span>
                <time className="shrink-0 text-xs text-muted-foreground">{compactDate(item.at, d.tz)}</time>
              </div>
            )) : <Muted>No activity yet.</Muted>}
          </Card>
        </section>
        <UsageCard dashboard={dashboard} />
      </div>
      <aside className={cn("lg:sticky lg:top-20", !selected && "max-lg:hidden")}>
        <CallPanel call={panelCall} task={panelCall ? d.taskFor(panelCall.id) : undefined} tz={d.tz} standalone={Boolean(selected)} />
      </aside>
    </div>
  )
}

function Banners({ dashboard }: { dashboard: ApiDashboard }) {
  const { preview } = useMode()
  return (
    <>
      {preview && (
        <Alert className="border-sky-200 bg-sky-50">
          <AlertTitle>Read-only demo</AlertTitle>
          <AlertDescription>Synthetic calls only. Real owners can call back, check off, and snooze.</AlertDescription>
        </Alert>
      )}
      {!preview && !dashboard.shop.alertsOn && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-950" role="status">
          <AlertTitle>Text notifications are off.</AlertTitle>
          <AlertDescription className="grid gap-2.5">
            <span>Urgent calls still show up here first, but we can’t text you about them.</span>
            <Button size="sm" className="w-fit" asChild><a href="/app/setup">Turn on text notifications</a></Button>
          </AlertDescription>
        </Alert>
      )}
    </>
  )
}

/** Until the new-owner flow is finished, Today points back to the one next step. */
function SetupCard({ dashboard }: { dashboard: ApiDashboard }) {
  if (dashboard.onboarding.completed) return null
  const steps = [
    { done: true, label: "Your shop" },
    { done: dashboard.paid, label: "Your card" },
    { done: Boolean(dashboard.line.confirmedAt), label: "Forward your calls" },
  ]
  const done = steps.filter((step) => step.done).length
  const next = steps.find((step) => !step.done)
  const percent = Math.round((done / steps.length) * 100)
  return (
    <Card className="relative overflow-hidden border-brand-ink/15">
      <span aria-hidden className="absolute inset-x-0 top-0 h-1.5 bg-brand-yellow" />
      <CardContent className="grid gap-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight"><span className="marker">Finish setup</span></h2>
            <p className="mt-1 text-sm text-muted-foreground">{done} of {steps.length} done.{next ? ` Next: ${next.label.toLowerCase()}.` : " Just one tap left."}</p>
          </div>
          <div className="relative grid size-14 shrink-0 place-items-center rounded-full text-[13px] font-bold" style={{ background: `conic-gradient(var(--brand-ink) ${percent}%, #ece8da 0)` }}>
            <span className="absolute inset-1.5 rounded-full bg-card" />
            <span className="relative">{done}/{steps.length}</span>
          </div>
        </div>
        <ol className="grid gap-2">
          {steps.map((step) => (
            <li key={step.label} className={cn("flex items-center gap-2.5 text-[15px] font-medium", step.done && "text-muted-foreground line-through")}>
              <span className={cn("grid size-5.5 place-items-center rounded-full border text-xs", step.done ? "border-emerald-600 bg-emerald-600 text-white" : "border-brand-ink/40")}>{step.done && <Check className="size-3.5" />}</span>
              {step.label}
            </li>
          ))}
        </ol>
        <Button size="tap" variant="brand" className={tapWidth} asChild><Link to="/app/start">Continue setup<ArrowRight /></Link></Button>
      </CardContent>
    </Card>
  )
}

/** Optional, after setup: booked jobs on Google Calendar. Going live never needs it. */
function CalendarCard({ dashboard }: { dashboard: ApiDashboard }) {
  if (!dashboard.googleAvailable || dashboard.googleConnected) return null
  return (
    <Card>
      <CardContent className="grid gap-3 md:flex md:items-center md:justify-between">
        <div className="flex gap-3">
          <CalendarDays className="mt-0.5 size-5 shrink-0 text-brand-ink/70" />
          <div className="grid gap-0.5">
            <h2 className="text-base font-semibold">Optional: put jobs on Google Calendar</h2>
            <p className="text-sm text-muted-foreground">Right now you confirm each job yourself. Connect your calendar so confirmed jobs land on it.</p>
          </div>
        </div>
        <Button size="tap" variant="outline" className={cn(tapWidth, "md:min-w-44")} asChild><a href="/app/integrations/google/start">Connect calendar</a></Button>
      </CardContent>
    </Card>
  )
}

export function StatCards({ dashboard }: { dashboard: ApiDashboard }) {
  const d = derive(dashboard)
  const card = "relative grid content-start gap-1 rounded-xl border bg-gradient-to-t from-brand-ink/[0.04] to-card p-3.5 shadow-xs md:p-5"
  return (
    <div className="grid grid-cols-3 gap-2.5 md:gap-4" aria-label="Shop overview">
      <div className={cn(card, d.urgentCount > 0 && "border-red-200 from-red-50")}>
        <span className="text-[13px] font-medium text-muted-foreground">To call back</span>
        <strong className={cn("tabular text-3xl leading-none font-semibold tracking-tight md:text-4xl", d.urgentCount > 0 && "text-red-700")}>{d.actionable.length}</strong>
        {d.urgentCount > 0 && <ToneBadge tone="danger" className="h-5 w-fit md:absolute md:top-4 md:right-4">{d.urgentCount} urgent</ToneBadge>}
        <small className="hidden text-[13px] text-muted-foreground md:block">{d.actionable.length ? "Callers waiting on you" : "You’re all caught up"}</small>
      </div>
      <div className={card}>
        <span className="text-[13px] font-medium text-muted-foreground">Booked</span>
        <strong className="tabular text-3xl leading-none font-semibold tracking-tight md:text-4xl">{d.booked.length}</strong>
        <small className="hidden text-[13px] text-muted-foreground md:block">Next 7 days</small>
      </div>
      <div className={card}>
        <span className="text-[13px] font-medium text-muted-foreground">Calls left</span>
        <strong className="tabular text-3xl leading-none font-semibold tracking-tight md:text-4xl">{d.remaining}</strong>
        <small className="hidden text-[13px] text-muted-foreground md:block">{d.used} of {d.included} answered</small>
      </div>
    </div>
  )
}

function TaskCard({ task, call, dashboard }: { task: ApiTask; call: ApiCall | undefined; dashboard: ApiDashboard }) {
  const { preview } = useMode()
  const act = useTaskActions()
  const d = derive(dashboard)
  const badge = urgency(task, call)
  const meta = [d.due(task), shortAddress(call)].filter(Boolean).join(" · ")
  const rail = { danger: "before:bg-red-600", warn: "before:bg-amber-500", good: "before:bg-emerald-600", neutral: "before:bg-stone-300" }[badge.tone]
  return (
    <article className={cn("relative grid gap-3 overflow-hidden rounded-xl border bg-card p-4 shadow-xs before:absolute before:inset-y-0 before:left-0 before:w-1", rail)}>
      <CallLink callId={task.callId} className="grid gap-1">
        <span className="flex items-center justify-between gap-2">
          <strong className="truncate text-base font-semibold">{call?.fields.callerName ?? "Unknown caller"}</strong>
          <ToneBadge tone={badge.tone}>{badge.label}</ToneBadge>
        </span>
        <span className="line-clamp-2 text-[15px]">{call?.fields.problemDescription || task.reason}</span>
        <span className="text-[13px] text-muted-foreground">{task.reason}{meta ? ` · ${meta}` : ""}</span>
      </CallLink>
      <div className="flex flex-wrap gap-2">
        {call?.phone ? (
          <Button size="tap" className="min-w-36 flex-1" asChild><a href={`tel:${call.phone}`}><Phone />Call back</a></Button>
        ) : (
          <Button size="tap" className="min-w-36 flex-1" asChild><CallLink callId={task.callId}>Open</CallLink></Button>
        )}
        {preview ? (
          <Button size="tap" variant="outline" asChild><CallLink callId={task.callId}>Details</CallLink></Button>
        ) : (
          <>
            <Button size="tap" variant="outline" aria-label={`Mark ${call?.fields.callerName ?? "call"} handled`} onClick={() => void act(task.callId, "complete")}><Check />Done</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="tap" variant="outline"><Clock />Later</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem className="min-h-11" onSelect={() => void act(task.callId, "snooze", 60)}>In 1 hour</DropdownMenuItem>
                <DropdownMenuItem className="min-h-11" onSelect={() => void act(task.callId, "snooze", 240)}>In 4 hours</DropdownMenuItem>
                <DropdownMenuItem className="min-h-11" onSelect={() => void act(task.callId, "snooze", 1440)}>Tomorrow</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </article>
  )
}

function AppointmentRow({ call, tz, nowMs }: { call: ApiCall; tz: string; nowMs: number }) {
  const bookedCall = call.outcome === "booked"
  return (
    <CallLink callId={call.id} className="flex min-h-14 items-center justify-between gap-3 border-t px-4 py-2.5 first:border-t-0 hover:bg-muted/50">
      <span className="grid min-w-0">
        <strong className="text-[15px] font-semibold">{timeOnly(call.fields.requestedStart!, tz)} · {dayLabel(call.fields.requestedStart!, tz, nowMs)}</strong>
        <small className="truncate text-[13px] text-muted-foreground">{call.fields.callerName ?? "Unknown caller"} · {call.fields.problemDescription || "Service visit"}</small>
      </span>
      <ToneBadge tone={bookedCall ? "good" : "warn"}>{bookedCall ? "Booked" : "Confirm"}</ToneBadge>
    </CallLink>
  )
}

function CallRow({ call, task, tz, selected }: { call: ApiCall; task: ApiTask | undefined; tz: string; selected: boolean }) {
  const badge = urgency(task, call)
  return (
    <CallLink callId={call.id} className={cn("flex min-h-14 items-center justify-between gap-3 border-t px-4 py-2.5 first:border-t-0 hover:bg-muted/50", selected && "lg:bg-accent")}>
      <span className="grid min-w-0">
        <strong className="text-[15px] font-semibold">{call.fields.callerName ?? "Unknown caller"}</strong>
        <small className="truncate text-[13px] text-muted-foreground">{call.fields.problemDescription || "No summary"}</small>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <time className="text-xs text-muted-foreground">{compactDate(call.startedAt, tz)}</time>
        <ToneDot tone={badge.tone} label={badge.label} />
        <ChevronRight className="size-4 text-muted-foreground lg:hidden" />
      </span>
    </CallLink>
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
      <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[15px] text-emerald-950">
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
    <Card className="relative overflow-hidden border-brand-ink/15">
      <span aria-hidden className="absolute inset-x-0 top-0 h-1.5 bg-brand-yellow" />
      <CardContent className="grid gap-3">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">Request refund</h2>
          <p className="text-[15px]">No real customer leads came in during your first 30 days. That’s on us: your first month is refundable{until ? ` until ${until}` : ""}.</p>
        </div>
        <Button size="tap" variant="brand" className={tapWidth} disabled={busy} onClick={() => void refund()}>{busy ? <Loader2 className="animate-spin" /> : null}Refund my first month</Button>
        <p className="text-[13px] text-muted-foreground">Your line keeps working. Cancel anytime from Manage billing.</p>
      </CardContent>
    </Card>
  )
}

function UsageCard({ dashboard }: { dashboard: ApiDashboard }) {
  const { preview, base } = useMode()
  const d = derive(dashboard)
  const usage = dashboard.usage
  const skipped = usage.excludedSpamCalls + usage.excludedShortCalls
  const leads = dashboard.guarantee.state === "watching" ? dashboard.guarantee.leads : 0
  return (
    <Card>
      <CardContent className="grid gap-2.5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">{usage.unlimited ? "Unlimited calls" : "Calls left"}</h2>
          <strong className="tabular text-3xl font-semibold tracking-tight">{d.remaining}</strong>
        </div>
        <Progress value={Math.min(100, Math.round((d.used / Math.max(1, d.included)) * 100))} aria-label={`${d.used} of ${d.included} included calls answered`} className="h-2 [&>div]:bg-brand-ink" />
        <p className="text-[13px] text-muted-foreground">{usage.unlimited ? `${d.used} answered this period. Fair use is up to ${d.included}.` : `${d.used} of ${d.included} calls answered this period`}</p>
        {usage.extraCalls > 0 && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            <strong className="font-semibold">Extra calls this month: {usage.extraCalls} × {perCall(usage.overageCentsPerCall)}</strong>
            <span className="block text-[13px]">{money(usage.extraCents)} so far, billed after the month ends. {usage.unlimited ? "You’re past fair use. " : ""}A bigger plan{usage.unlimited ? "" : " or Unlimited calls"} may cost less: <Link className="font-semibold underline underline-offset-4" to={`${base}/settings`}>change plans</Link>.</span>
          </p>
        )}
        {leads > 0 && <p className="text-[13px] text-muted-foreground">You’ve had {leads} real {leads === 1 ? "lead" : "leads"} this month.</p>}
        <p className="text-[13px] text-muted-foreground">Spam and calls under 15 seconds aren’t counted.{skipped > 0 ? ` ${skipped} skipped this period.` : ""}</p>
        {!preview && dashboard.viewer.role === "owner" && dashboard.paid && (
          <form method="post" action="/app/billing/portal">
            <input type="hidden" name="csrf" value={dashboard.csrf} />
            <Button variant="link" className="h-10 px-0">Manage billing or cancel</Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

export function CallPanel({ call, task, tz, standalone }: { call: ApiCall | null; task: ApiTask | undefined; tz: string; standalone: boolean }) {
  const { base, preview } = useMode()
  if (!call) {
    return (
      <Card>
        <CardContent className="grid gap-1.5">
          <h2 className="text-lg font-semibold">No calls yet</h2>
          <p className="text-sm text-muted-foreground">When Call Otto answers, the caller, problem and next step show up here.</p>
        </CardContent>
      </Card>
    )
  }
  const badge = urgency(task, call)
  const facts: Array<[string, string]> = [
    phoneFact(call),
    ["Address", call.fields.address?.trim() || "Not confirmed"],
    ["Called", compactDate(call.startedAt, tz)],
    ...(call.fields.requestedStart ? [[call.outcome === "booked" ? "Booked for" : "Asked for", compactDate(call.fields.requestedStart, tz)] as [string, string]] : []),
    ...(call.fields.equipmentDetails ? [["Equipment", call.fields.equipmentDetails] as [string, string]] : []),
    ...(call.fields.accessNotes ? [["Access", call.fields.accessNotes] as [string, string]] : []),
  ]
  return (
    <Card id="detail" className="gap-4">
      <CardContent className="grid gap-4">
        {standalone && <Button variant="ghost" className="-ml-2 h-10 w-fit lg:hidden" asChild><Link to={base}>← Back</Link></Button>}
        <CallHeader call={call} tone={badge.tone} label={badge.label} />
        <SafetyNote call={call} />
        <ContactActions call={call} />
        <Facts rows={facts} />
        <details className="group rounded-xl border">
          <summary className="flex min-h-12 cursor-pointer items-center px-3.5 font-semibold">Read the call</summary>
          <p className="ph-no-capture px-3.5 pb-3.5 text-sm whitespace-pre-wrap text-foreground/85">{call.transcript ?? "Transcript unavailable"}</p>
        </details>
        <Button variant="link" className="h-10 w-fit px-0" asChild>
          <Link to={`${base}/calls/${encodeURIComponent(call.id)}`}>{preview ? "Open the full call" : "Full record, recording & delete"}</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
