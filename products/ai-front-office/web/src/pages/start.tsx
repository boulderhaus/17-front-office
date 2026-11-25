import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom"
import { ArrowLeft, ArrowRight, CalendarClock, Check, CheckCircle2, Clock3, Loader2, MessageSquareText, Phone, PhoneCall } from "lucide-react"
import { BrandMark } from "@/components/app/bits"
import { CallAlertsCard } from "@/components/app/call-alerts"
import { ForwardingCard } from "@/components/app/forwarding-card"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { FAIR_USE_LINE, formatPhone, LEAD_GUARANTEE, money, perCall } from "@/lib/format"
import { useMode } from "@/lib/mode"
import type { Activation, ApiDashboard, PlanId } from "@/lib/types"
import { cn, tapWidth } from "@/lib/utils"

// Three steps: Your shop (the signup form) · Your card · Forward your calls. Hours start at Mon–Fri 9–5 and change in Settings.
type Step = "card" | "forward" | "done"
const STEP_COUNT = 3
const STEPS: Array<{ id: Step; n: number; label: string }> = [
  { id: "card", n: 2, label: "Your card" },
  { id: "forward", n: 3, label: "Forward your calls" },
  { id: "done", n: 3, label: "All set" },
]

function firstStep(d: ApiDashboard): Step {
  if (!d.paid) return "card"
  if (!d.line.confirmedAt && !d.onboarding.completed) return "forward"
  return "done"
}

/**
 * New owner setup, after the signup form: card → (line turns on by itself) → forward calls → hours → done.
 * Each step is one screen with one obvious button.
 */
export function StartPage() {
  const { dashboard, reload } = useMode()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const [activation, setActivation] = useState<Activation | "running" | null>(null)
  const started = useRef(false)
  const sessionId = params.get("session_id")

  // Back from Stripe (or reopening setup after paying): turn the line on, no button.
  const activate = async () => {
    setActivation("running")
    try {
      const result = await api<ApiDashboard & { activation: Activation }>("/api/app/onboarding/activate", { method: "POST", body: sessionId ? { sessionId } : {} })
      // Refresh first, so the screen never flashes the card step after a payment went through.
      await reload().catch(() => undefined)
      setActivation(result.activation)
    } catch (error) {
      await reload().catch(() => undefined)
      setActivation({ status: "failed", message: error instanceof Error ? error.message : "That didn’t work. Please try again." })
    }
  }
  useEffect(() => {
    if (!dashboard || started.current) return
    const needsLine = dashboard.viewer.status !== "active" || !dashboard.line.number
    if ((sessionId || dashboard.paid) && needsLine) {
      started.current = true
      void activate()
    }
    // Run once per visit, as soon as the dashboard is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard])
  useEffect(() => { document.title = "Set up · Call Otto" }, [])
  // Pin the step once paid, so a background refresh (e.g. forwarding just confirmed) never jumps the screen.
  useEffect(() => {
    if (!dashboard?.paid || params.get("step")) return
    setParams((previous) => { const next = new URLSearchParams(previous); next.set("step", firstStep(dashboard)); return next }, { replace: true })
  }, [dashboard, params, setParams])

  if (!dashboard) return null
  if (dashboard.viewer.role !== "owner") return <Navigate to="/app" replace />
  const requested = params.get("step") as Step | null
  const computed = firstStep(dashboard)
  // Never skip past paying; otherwise the owner can move freely between steps.
  const step: Step = !dashboard.paid ? "card" : requested && STEPS.some((item) => item.id === requested) ? requested : computed
  const confirming = Boolean(sessionId) && (activation === null || activation === "running")
  const go = (next: Step) => setParams({ step: next })
  const current = STEPS.find((item) => item.id === step)!
  // A standard back arrow, top-left, on every step after paying: All set goes back to forwarding, and
  // forwarding (the card is already paid) goes back to Calls, where "Continue setup" brings the owner back.
  const back: Step | "calls" | null = step === "done" ? "forward" : step === "forward" ? "calls" : null
  // "All set" only once missed calls really reach Call Otto (or the line is still waiting on approval).
  const forwardingOn = Boolean(dashboard.line.confirmedAt) && (dashboard.line.check.status === "idle" || dashboard.line.check.status === "passed")
  const done = step === "done" && (forwardingOn || !dashboard.line.number)

  return (
    <div className="min-h-svh bg-brand-paper">
      <header className="pt-safe sticky top-0 z-20 border-b bg-brand-paper/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-xl items-center justify-between gap-3 px-4">
          <span className="flex min-w-0 items-center gap-1.5">
            {back ? (
              <button type="button" aria-label={back === "calls" ? "Back to Calls" : "Back"} onClick={() => (back === "calls" ? navigate("/app") : go(back))} className="-ml-2 grid size-11 shrink-0 place-items-center rounded-full text-brand-ink hover:bg-brand-ink/5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"><ArrowLeft className="size-6" /></button>
            ) : null}
            <span className="flex items-center gap-2.5"><BrandMark /><span className="text-lg font-semibold tracking-tight">Call <em className="font-serif italic">Otto</em></span></span>
          </span>
          <span className="truncate text-[13px] font-medium text-muted-foreground">{dashboard.shop.businessName}</span>
        </div>
        <div className="mx-auto grid max-w-xl gap-1.5 px-4 pb-3" aria-label={done ? "Setup complete" : `Step ${current.n} of ${STEP_COUNT}: ${current.label}`}>
          <span className={cn("flex items-center gap-1.5 text-[13px] font-semibold", done && "text-emerald-800")}>
            {done ? <><span className="grid size-[18px] place-items-center rounded-full bg-emerald-600 text-white"><Check className="size-3" strokeWidth={3.5} /></span>All set</> : step === "done" ? `Step ${STEP_COUNT} of ${STEP_COUNT} · Forwarding not on yet` : `Step ${current.n} of ${STEP_COUNT} · ${current.label}`}
          </span>
          <ol className="grid grid-cols-3 gap-1.5" aria-hidden>
            {Array.from({ length: STEP_COUNT }, (_, index) => index + 1).map((n) => <li key={n} className={cn("h-1.5 rounded-full", done ? "bg-emerald-600" : n <= current.n ? "bg-brand-ink" : "bg-brand-ink/15")} />)}
          </ol>
        </div>
      </header>
      <main className="mx-auto grid max-w-xl content-start gap-5 px-4 pt-7 pb-16">
        {step === "card" && <CardStep dashboard={dashboard} confirming={confirming} cancelled={params.get("checkout") === "cancelled"} note={activation && activation !== "running" && activation.status !== "live" ? activation.message : null} />}
        {step === "forward" && activation && <ActivationNote activation={activation} dashboard={dashboard} retry={() => void activate()} />}
        {step === "forward" && <ForwardStep dashboard={dashboard} next={() => go("done")} />}
        {step === "done" && <DoneStep dashboard={dashboard} activation={activation} toForward={() => go("forward")} />}
      </main>
    </div>
  )
}

function Heading({ title, children, oneLine = false }: { title: ReactNode; children?: ReactNode; oneLine?: boolean }) {
  return (
    <div className="grid gap-2">
      {/* oneLine: the title and subtitle shrink to fit a 390px phone instead of wrapping. */}
      <h1 className={cn("leading-tight font-semibold tracking-tight", oneLine ? "text-[min(30px,6vw)] whitespace-nowrap" : "text-[30px] text-balance")}>{title}</h1>
      {children && <p className={cn("text-muted-foreground", oneLine ? "text-[min(16px,3.45vw)] whitespace-nowrap" : "text-base")}>{children}</p>}
    </div>
  )
}

function CardStep({ dashboard, confirming, cancelled, note }: { dashboard: ApiDashboard; confirming: boolean; cancelled: boolean; note: string | null }) {
  const plans = dashboard.billing.plans
  // The plan picked at signup, or Solo: picking costs no extra tap.
  const [picked, setPicked] = useState<PlanId>(plans.some((plan) => plan.id === dashboard.billing.planId) ? dashboard.billing.planId : plans[0]?.id ?? "solo")
  const [showAll, setShowAll] = useState(false)
  // Unlimited calls: off unless the owner picked it (pricing page or signup). Solo without it is the default.
  const [unlimited, setUnlimited] = useState(dashboard.billing.unlimited)
  if (confirming) {
    return <Card><CardContent className="flex items-center gap-3 text-[15px] font-medium"><Loader2 className="size-5 animate-spin" />Confirming your card…</CardContent></Card>
  }
  const plan = plans.find((item) => item.id === picked) ?? null
  const others = plans.filter((item) => item.id !== picked)
  const withUnlimited = Boolean(unlimited && plan?.unlimited)
  const shown = withUnlimited && plan?.unlimited ? plan.unlimited : plan
  return (
    <>
      <Heading title={<span className="marker">Add a card to turn on your line</span>}>Your Call Otto line turns on the moment you’re back here. No extra button.</Heading>
      {note && !cancelled && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">{note}</p>}
      {cancelled && <p role="status" className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950">No charge was made. Add a card whenever you’re ready.</p>}
      <Card className="relative overflow-hidden border-brand-ink/15">
        <span aria-hidden className="absolute inset-x-0 top-0 h-1.5 bg-brand-yellow" />
        <CardContent className="grid gap-5 pt-2">
          {plan ? (
            <div className="grid gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <strong className="text-lg font-semibold">{plan.label}</strong>
                <span><strong className="tabular text-3xl font-semibold tracking-tight">{money(shown!.priceCents)}</strong><span className="text-sm text-muted-foreground">/month</span></span>
              </div>
              <span className="text-[14px] text-muted-foreground">{withUnlimited && plan.unlimited ? `Unlimited calls, fair use up to ${plan.unlimited.fairUseCalls.toLocaleString("en-US")} a month. Past that, ${perCall(plan.overageCentsPerCall)} each.` : `${plan.blurb}. Extra calls ${perCall(plan.overageCentsPerCall)} each.`}</span>
              {shown!.firstMonthCents < shown!.priceCents && <span className="text-[14px] font-semibold text-red-700">Limited time: first month half off</span>}
            </div>
          ) : null}
          {plan?.unlimited && (
            <div className="grid gap-1 rounded-lg border-2 border-brand-ink/15 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <label htmlFor="card-unlimited" className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[15px] font-semibold">
                  <Switch id="card-unlimited" checked={unlimited} onCheckedChange={setUnlimited} />
                  Unlimited calls
                </label>
                <span className="rounded border border-brand-ink/40 px-1.5 py-0.5 text-[13px] font-semibold">{FAIR_USE_LINE}</span>
              </div>
              <span className="text-[13px] text-muted-foreground">+{money(plan.unlimited.addOnCents)}/month. Turn it off anytime in Settings.</span>
            </div>
          )}
          {/* The picked plan is already chosen; bigger (or smaller) shops open one compact line. No extra tap for Solo. */}
          {others.length > 0 && (showAll ? (
            <div className="grid gap-2" role="radiogroup" aria-label="Other plans">
              {others.map((item) => (
                <button key={item.id} type="button" role="radio" aria-checked={false} onClick={() => { setPicked(item.id); setShowAll(false) }}
                  className="flex min-h-12 items-center justify-between gap-3 rounded-lg border-2 border-brand-ink/15 bg-card px-3 py-2 text-left text-sm transition hover:border-brand-ink focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
                  <span className="grid"><strong className="font-semibold">{item.label} <span className="font-medium text-muted-foreground">· {item.who}</span></strong><small className="text-[12.5px] text-muted-foreground">{item.includedCalls} answered calls a month</small></span>
                  <span className="tabular font-semibold">{money(item.priceCents)}<small className="text-[12px] font-medium text-muted-foreground">/mo</small></span>
                </button>
              ))}
            </div>
          ) : (
            <button type="button" onClick={() => setShowAll(true)} className="inline-flex min-h-11 w-fit items-center text-[15px] font-semibold text-brand-ink underline underline-offset-4">
              {picked === plans[0]?.id ? `Bigger shop? ${others.map((item) => item.label).join(", ")}` : "See other plans"}
            </button>
          ))}
          <ul className="grid gap-1.5 text-[15px]">
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4.5 shrink-0 text-emerald-700" />Keep your number</li>
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4.5 shrink-0 text-emerald-700" />Cancel anytime from your dashboard</li>
          </ul>
          {dashboard.checkoutConfigured ? (
            <form method="post" action="/app/billing/checkout" className="grid gap-2.5">
              <input type="hidden" name="csrf" value={dashboard.csrf} />
              <input type="hidden" name="from" value="start" />
              {plan && <input type="hidden" name="plan" value={plan.id} />}
              <input type="hidden" name="unlimited" value={withUnlimited ? "yes" : "no"} />
              <Button size="tap" variant="brand" className={cn(tapWidth, "h-14 text-base lg:h-12")}>Add card<ArrowRight /></Button>
              {((withUnlimited ? plan?.unlimited?.chargeNote : plan?.chargeNote) ?? dashboard.billing.chargeNote) && <p className="text-center text-[15px] font-semibold text-balance md:text-left">{(withUnlimited ? plan?.unlimited?.chargeNote : plan?.chargeNote) ?? dashboard.billing.chargeNote}</p>}
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">Checkout isn’t switched on yet. We’ll reach out to finish this with you.</p>
          )}
          <p className="border-l-4 border-brand-yellow pl-3 text-[13px] text-brand-ink"><strong className="font-semibold">Lead guarantee.</strong> {LEAD_GUARANTEE}</p>
          <p className="text-[13px] text-muted-foreground">Secure checkout by Stripe. We never see your card number. Team members are free.</p>
        </CardContent>
      </Card>
    </>
  )
}

function ActivationNote({ activation, dashboard, retry }: { activation: Activation | "running"; dashboard: ApiDashboard; retry: () => void }) {
  if (activation === "running") {
    return <p role="status" className="flex items-center gap-2.5 rounded-xl border bg-card px-4 py-3 text-[15px] font-medium"><Loader2 className="size-5 animate-spin" />Turning on your line…</p>
  }
  if (activation.status === "live" && dashboard.line.number) {
    return (
      <div role="status" className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-950">
        <PhoneCall className="mt-0.5 size-5 shrink-0" />
        <p className="grid text-[15px]"><strong className="text-base">Your line is on.</strong><span>{formatPhone(dashboard.line.number)} answers for {dashboard.shop.businessName}.</span></p>
      </div>
    )
  }
  if (activation.status === "waiting") {
    return (
      <div role="status" className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sky-950">
        <Clock3 className="mt-0.5 size-5 shrink-0" />
        <p className="text-[15px]">{activation.message}</p>
      </div>
    )
  }
  if (activation.status === "live") return null
  return (
    <div role="alert" className="grid gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950">
      <p className="text-[15px]">{activation.message ?? "We couldn’t turn your line on just now."}</p>
      <Button size="tap" variant="outline" className={cn(tapWidth, "bg-card")} onClick={retry}>Try again</Button>
    </div>
  )
}

function ForwardStep({ dashboard, next }: { dashboard: ApiDashboard; next: () => void }) {
  return (
    <>
      <Heading oneLine title="Send missed calls to Call Otto">Your phone still rings first. Only calls you miss come here.</Heading>
      <ForwardingCard
        dashboard={dashboard}
        footer={({ confirmed }) => (confirmed || (!dashboard.line.number && dashboard.line.business.number) ? (
          <div className="grid gap-2 border-t pt-4 md:flex md:items-center">
            <Button size="tap" variant="brand" className={cn(tapWidth, "h-14 text-base lg:h-12")} onClick={next}>Finish setup<ArrowRight /></Button>
          </div>
        ) : null)}
      />
      {/* Skipping is allowed but costs something; say what, in one line. */}
      {!(dashboard.line.confirmedAt || (!dashboard.line.number && dashboard.line.business.number)) && (
        <p className="px-1 text-sm text-muted-foreground">
          <button type="button" className="inline-flex min-h-11 items-center font-semibold text-brand-ink underline underline-offset-4" onClick={next}>Skip for now</button>
          <span className="block">Call Otto won’t get your missed calls until forwarding is on.</span>
        </p>
      )}
    </>
  )
}

function DoneStep({ dashboard, activation, toForward }: { dashboard: ApiDashboard; activation: Activation | "running" | null; toForward: () => void }) {
  const navigate = useNavigate()
  const { reload } = useMode()
  const [busy, setBusy] = useState(false)
  const finish = async () => {
    setBusy(true)
    await api("/api/app/onboarding/done", { method: "POST", body: {} }).catch(() => undefined)
    await reload().catch(() => undefined)
    navigate("/app")
  }
  const waiting = !dashboard.line.number
  // Skipped forwarding (or the last test failed): the line answers, but no missed call reaches it yet. Say so.
  const forwarding = Boolean(dashboard.line.confirmedAt) && (dashboard.line.check.status === "idle" || dashboard.line.check.status === "passed")
  const notForwarding = !waiting && !forwarding
  const trialEnds = dashboard.billing.trialEndsAt
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: dashboard.shop.timezone }).format(new Date(dashboard.billing.trialEndsAt))
    : null
  const rows: Array<{ icon: typeof Phone; label: string; value: ReactNode }> = [
    { icon: Phone, label: "Your line", value: waiting ? (activation !== "running" && activation?.status === "waiting" ? "On its way: carriers usually approve it in 1 to 3 business days" : "Turning on") : formatPhone(dashboard.line.number!) },
    { icon: MessageSquareText, label: "It answers", value: `“${dashboard.shop.greeting}”` },
    { icon: CalendarClock, label: "Jobs", value: <>{dashboard.shop.hours}. Callers pick a time; you confirm it. <Link className="font-semibold whitespace-nowrap text-brand-ink underline underline-offset-4" to="/app/settings">Change hours</Link></> },
    ...(trialEnds ? [{ icon: CheckCircle2, label: "Free trial", value: `Free until ${trialEnds}, then ${money(dashboard.shop.flatMonthlyPriceCents)}/month` }] : []),
  ]
  return (
    <>
      {notForwarding ? (
        <div className="grid justify-items-start gap-4">
          <span className="grid size-14 place-items-center rounded-full bg-amber-500 text-white shadow-[0_0_0_6px_rgba(245,158,11,.15)]"><PhoneCall className="size-7" strokeWidth={2.5} /></span>
          <Heading title="One step left">Your Call Otto line is on, but we haven’t seen one of your missed calls reach it yet. Turn on forwarding and test it to finish.</Heading>
          <Button size="tap" variant="brand" className={cn(tapWidth, "h-14 text-base lg:h-12")} onClick={toForward}>Turn on forwarding<ArrowRight /></Button>
        </div>
      ) : (
        <div className="grid justify-items-start gap-4">
          <span className="grid size-14 place-items-center rounded-full bg-emerald-600 text-white shadow-[0_0_0_6px_rgba(5,150,105,.15)]"><Check className="size-8" strokeWidth={3} /></span>
          <Heading title={<span className="marker">You’re set!</span>}>{waiting ? "Your setup is saved. We’ll turn your line on as soon as it’s approved and let you know." : "Missed calls now get answered. New jobs show up in Calls."}</Heading>
        </div>
      )}
      <Card>
        <CardContent className="grid gap-0 divide-y">
          {rows.map((row) => (
            <div key={row.label} className="flex gap-3 py-3.5 first:pt-0 last:pb-0">
              <row.icon className="mt-0.5 size-5 shrink-0 text-brand-ink/70" />
              <div className="grid gap-0.5">
                <small className="text-[13px] font-medium text-muted-foreground">{row.label}</small>
                <span className="text-[15px] font-medium">{row.value}</span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <CallAlertsCard />
      <Button size="tap" variant="brand" className={cn(tapWidth, "h-14 text-base lg:h-12")} disabled={busy} onClick={() => void finish()}>{busy ? <Loader2 className="animate-spin" /> : null}See my calls<ArrowRight /></Button>
      <p className="text-sm text-muted-foreground">Change your greeting, service area or hours anytime in <Link className="font-semibold underline underline-offset-4" to="/app/settings">Settings</Link>.</p>
    </>
  )
}
