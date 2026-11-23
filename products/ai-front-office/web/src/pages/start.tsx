import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom"
import { ArrowRight, CalendarClock, CheckCircle2, Clock3, Loader2, MessageSquareText, Phone, PhoneCall } from "lucide-react"
import { BrandMark } from "@/components/app/bits"
import { ForwardingCard } from "@/components/app/forwarding-card"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import { formatPhone } from "@/lib/format"
import { useMode } from "@/lib/mode"
import type { Activation, ApiDashboard } from "@/lib/types"
import { cn, tapWidth } from "@/lib/utils"

type Step = "card" | "forward" | "hours" | "done"
const STEPS: Array<{ id: Step; n: number; label: string }> = [
  { id: "card", n: 2, label: "Card" },
  { id: "forward", n: 3, label: "Forward calls" },
  { id: "hours", n: 4, label: "Hours" },
  { id: "done", n: 4, label: "All set" },
]

function firstStep(d: ApiDashboard): Step {
  if (!d.paid) return "card"
  if (!d.onboarding.hoursSet && !d.line.confirmedAt) return "forward"
  if (!d.onboarding.hoursSet) return "hours"
  return "done"
}

/**
 * New owner setup, after the signup form: card → (line turns on by itself) → forward calls → hours → done.
 * Each step is one screen with one obvious button.
 */
export function StartPage() {
  const { dashboard, reload } = useMode()
  const [params, setParams] = useSearchParams()
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
  useEffect(() => { document.title = "Set up · Front Office" }, [])
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

  return (
    <div className="min-h-svh bg-brand-paper">
      <header className="pt-safe sticky top-0 z-20 border-b bg-brand-paper/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-xl items-center justify-between gap-3 px-4">
          <span className="flex items-center gap-2.5"><BrandMark /><span className="text-lg font-semibold tracking-tight">Front <em className="font-serif italic">Office</em></span></span>
          <span className="truncate text-[13px] font-medium text-muted-foreground">{dashboard.shop.businessName}</span>
        </div>
        <div className="mx-auto grid max-w-xl gap-1.5 px-4 pb-3" aria-label={step === "done" ? "Setup complete" : `Step ${current.n} of 4: ${current.label}`}>
          <span className="text-[13px] font-semibold">{step === "done" ? "All set" : `Step ${current.n} of 4 · ${current.label}`}</span>
          <ol className="grid grid-cols-4 gap-1.5" aria-hidden>
            {[1, 2, 3, 4].map((n) => <li key={n} className={cn("h-1.5 rounded-full", n <= (step === "done" ? 4 : current.n) ? "bg-brand-ink" : "bg-brand-ink/15")} />)}
          </ol>
        </div>
      </header>
      <main className="mx-auto grid max-w-xl gap-4 px-4 pt-5 pb-16">
        {step === "card" && <CardStep dashboard={dashboard} confirming={confirming} cancelled={params.get("checkout") === "cancelled"} note={activation && activation !== "running" && activation.status !== "live" ? activation.message : null} />}
        {step === "forward" && activation && <ActivationNote activation={activation} dashboard={dashboard} retry={() => void activate()} />}
        {step === "forward" && <ForwardStep dashboard={dashboard} next={() => go("hours")} />}
        {step === "hours" && <HoursStep next={() => go("done")} back={() => go("forward")} />}
        {step === "done" && <DoneStep dashboard={dashboard} activation={activation} />}
      </main>
    </div>
  )
}

function Heading({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{title}</h1>
      {children && <p className="text-[15px] text-muted-foreground">{children}</p>}
    </div>
  )
}

function CardStep({ dashboard, confirming, cancelled, note }: { dashboard: ApiDashboard; confirming: boolean; cancelled: boolean; note: string | null }) {
  if (confirming) {
    return <Card><CardContent className="flex items-center gap-3 text-[15px] font-medium"><Loader2 className="size-5 animate-spin" />Confirming your card…</CardContent></Card>
  }
  const dollars = Math.round(dashboard.shop.flatMonthlyPriceCents / 100)
  return (
    <>
      <Heading title={<span className="marker">Add a card to turn on your line</span>}>Your Front Office line turns on the moment you’re back here. No extra button.</Heading>
      {note && !cancelled && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">{note}</p>}
      {cancelled && <p role="status" className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950">No charge was made. Add a card whenever you’re ready.</p>}
      <Card className="relative overflow-hidden border-brand-ink/15">
        <span aria-hidden className="absolute inset-x-0 top-0 h-1.5 bg-brand-yellow" />
        <CardContent className="grid gap-4">
          <div className="flex items-baseline justify-between gap-3">
            <strong className="text-lg font-semibold">Solo plan</strong>
            <span><strong className="tabular text-3xl font-semibold tracking-tight">${dollars}</strong><span className="text-sm text-muted-foreground">/month</span></span>
          </div>
          <ul className="grid gap-1.5 text-[15px]">
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4.5 shrink-0 text-emerald-700" />{dashboard.shop.includedMinutes} AI minutes a month</li>
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4.5 shrink-0 text-emerald-700" />Keep your number</li>
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4.5 shrink-0 text-emerald-700" />Cancel anytime from your dashboard</li>
          </ul>
          {dashboard.billing.chargeNote && <p className="rounded-md bg-brand-paper px-3 py-2.5 text-[15px] font-medium">{dashboard.billing.chargeNote}</p>}
          {dashboard.checkoutConfigured ? (
            <form method="post" action="/app/billing/checkout">
              <input type="hidden" name="csrf" value={dashboard.csrf} />
              <input type="hidden" name="from" value="start" />
              <Button size="tap" variant="brand" className={tapWidth}>Add card<ArrowRight /></Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">Checkout isn’t switched on yet. We’ll reach out to finish this with you.</p>
          )}
          <p className="text-[13px] text-muted-foreground">Secure checkout by Stripe. We never see your card number.</p>
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
        <p className="text-[15px]"><strong>Your line is on.</strong> {formatPhone(dashboard.line.number)} answers for {dashboard.shop.businessName}.</p>
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
      <Heading title="Send missed calls to Front Office">Your phone still rings first. Only calls you miss come here.</Heading>
      <ForwardingCard
        dashboard={dashboard}
        footer={({ confirmed }) => (
          <div className="grid gap-2 border-t pt-3 md:flex md:items-center">
            {confirmed || (!dashboard.line.number && dashboard.line.business.number) ? (
              <Button size="tap" variant="brand" className={tapWidth} onClick={next}>Next: your hours<ArrowRight /></Button>
            ) : (
              <Button size="tap" variant="ghost" className={tapWidth} onClick={next}>Skip for now</Button>
            )}
          </div>
        )}
      />
    </>
  )
}

const PRESETS = [
  { id: "weekdays", label: "Weekdays 8–5", detail: "Monday to Friday, 8 AM to 5 PM" },
  { id: "mon_sat", label: "Mon–Sat 8–6", detail: "Monday to Saturday, 8 AM to 6 PM" },
  { id: "every_day", label: "Every day 7–7", detail: "Seven days, 7 AM to 7 PM" },
] as const

function HoursStep({ next, back }: { next: () => void; back: () => void }) {
  const { reload } = useMode()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [custom, setCustom] = useState(false)
  const [start, setStart] = useState("08:00")
  const [end, setEnd] = useState("17:00")
  const [days, setDays] = useState<"weekdays" | "mon_sat" | "every_day">("weekdays")
  const save = async (body: Record<string, string>) => {
    setBusy(body.preset ?? "custom")
    setError(null)
    try {
      await api("/api/app/onboarding/hours", { method: "POST", body })
      await reload().catch(() => undefined)
      next()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That didn’t save. Please try again.")
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <Heading title="When can you take jobs?">Front Office offers callers times inside these hours. You confirm every job before it’s booked.</Heading>
      <div className="grid gap-2.5">
        {PRESETS.map((preset) => (
          <button key={preset.id} type="button" disabled={Boolean(busy)} onClick={() => void save({ preset: preset.id })}
            className="flex min-h-[72px] items-center justify-between gap-3 rounded-xl border-2 border-brand-ink/15 bg-card px-4 py-3 text-left shadow-xs transition hover:border-brand-ink focus-visible:border-brand-ink focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60 md:max-w-[480px]">
            <span className="grid gap-0.5">
              <strong className="text-xl font-semibold tracking-tight">{preset.label}</strong>
              <small className="text-[13px] text-muted-foreground">{preset.detail}</small>
            </span>
            {busy === preset.id ? <Loader2 className="size-5 animate-spin" /> : <ArrowRight className="size-5 text-muted-foreground" />}
          </button>
        ))}
        {!custom ? (
          <Button size="tap" variant="ghost" className={cn(tapWidth, "justify-start md:justify-center")} onClick={() => setCustom(true)}><CalendarClock />Custom hours</Button>
        ) : (
          <Card className="md:max-w-[480px]">
            <CardContent className="grid gap-3">
              <div className="grid grid-cols-2 gap-2.5">
                <label className="grid gap-1 text-sm font-semibold">First job<Input type="time" value={start} onChange={(event) => setStart(event.target.value)} className="h-12 text-lg" /></label>
                <label className="grid gap-1 text-sm font-semibold">Done by<Input type="time" value={end} onChange={(event) => setEnd(event.target.value)} className="h-12 text-lg" /></label>
              </div>
              <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Days you work">
                {([["weekdays", "Mon–Fri"], ["mon_sat", "Mon–Sat"], ["every_day", "Every day"]] as const).map(([id, label]) => (
                  <button key={id} type="button" role="radio" aria-checked={days === id} onClick={() => setDays(id)}
                    className={cn("min-h-12 rounded-lg border text-[15px] font-semibold", days === id ? "border-brand-ink bg-brand-yellow text-brand-ink" : "bg-card")}>{label}</button>
                ))}
              </div>
              <Button size="tap" variant="brand" className={tapWidth} disabled={Boolean(busy)} onClick={() => void save({ preset: "custom", start, end, days })}>{busy === "custom" ? <><Loader2 className="animate-spin" />Saving…</> : "Save hours"}</Button>
            </CardContent>
          </Card>
        )}
        {error && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">{error}</p>}
      </div>
      <button type="button" className="w-fit text-sm font-semibold underline underline-offset-4" onClick={back}>Back to forwarding</button>
    </>
  )
}

function DoneStep({ dashboard, activation }: { dashboard: ApiDashboard; activation: Activation | "running" | null }) {
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
  const trialEnds = dashboard.billing.trialEndsAt
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: dashboard.shop.timezone }).format(new Date(dashboard.billing.trialEndsAt))
    : null
  const rows: Array<{ icon: typeof Phone; label: string; value: ReactNode }> = [
    { icon: Phone, label: "Your line", value: waiting ? (activation !== "running" && activation?.status === "waiting" ? "On its way: carriers usually approve it in 1 to 3 business days" : "Turning on") : formatPhone(dashboard.line.number!) },
    { icon: MessageSquareText, label: "It answers", value: `“${dashboard.shop.greeting}”` },
    { icon: CalendarClock, label: "Jobs", value: `${dashboard.shop.hours}. Callers pick a time; you confirm it.` },
    ...(trialEnds ? [{ icon: CheckCircle2, label: "Free trial", value: `Free until ${trialEnds}, then $${Math.round(dashboard.shop.flatMonthlyPriceCents / 100)}/month` }] : []),
  ]
  return (
    <>
      <Heading title={<span className="marker">You’re set.</span>}>{waiting ? "Your setup is saved. Your line turns on by itself once it’s approved." : "Missed calls now get answered. New jobs show up on Today."}</Heading>
      <Card>
        <CardContent className="grid gap-0 divide-y">
          {rows.map((row) => (
            <div key={row.label} className="flex gap-3 py-3 first:pt-0 last:pb-0">
              <row.icon className="mt-0.5 size-5 shrink-0 text-brand-ink/70" />
              <div className="grid gap-0.5">
                <small className="text-[13px] font-medium text-muted-foreground">{row.label}</small>
                <span className="text-[15px] font-medium">{row.value}</span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Button size="tap" variant="brand" className={tapWidth} disabled={busy} onClick={() => void finish()}>{busy ? <Loader2 className="animate-spin" /> : null}Go to Today<ArrowRight /></Button>
      <p className="text-sm text-muted-foreground">Change your greeting, service area or hours anytime in <Link className="font-semibold underline underline-offset-4" to="/app/settings">Settings</Link>.</p>
    </>
  )
}
