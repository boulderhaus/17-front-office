import { useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { CheckCircle2, Download, ExternalLink, LogOut } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { CallAlertsCard } from "@/components/app/call-alerts"
import { api } from "@/lib/api"
import { FAIR_USE_LINE, money, perCall } from "@/lib/format"
import { useMode } from "@/lib/mode"
import type { PlanId } from "@/lib/types"
import { ringChoicesWith } from "@/lib/dial"
import { cn } from "@/lib/utils"
import { useSettings } from "./settings"

const ZONES: Array<[string, string]> = [["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona"], ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"]]
const selectClass = "h-12 w-full rounded-lg border border-input bg-card px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:h-10 lg:text-[15px]"
const fieldClass = "h-12 bg-card text-base lg:h-10 lg:text-[15px]"
const areaClass = "bg-card text-base lg:text-[15px]"
/** Card actions: full width on a phone; on a computer every button in a card is the same width, left-aligned. */
const actionClass = "w-full sm:w-60"
// The server accepts any whole percent from 50 to 95; 75 (the default) and 90 are the easy picks.
const EASY_ALERT_PERCENTS = [75, 90]
const OTHER_ALERT_PERCENTS = [50, 55, 60, 65, 70, 80, 85, 95]
const unique = (list: number[]) => list.filter((value, index, all) => all.indexOf(value) === index).sort((left, right) => left - right)

/** One topic, one card. */
export function SettingsCard({ title, description, children, danger }: { title: string; description?: ReactNode; children: ReactNode; danger?: boolean }) {
  return (
    <section className={cn("grid gap-4 rounded-xl border bg-card p-4 md:p-5", danger && "border-red-200")}>
      <header className="grid gap-1">
        <h3 className={cn("text-[17px] font-semibold", danger && "text-red-700")}>{title}</h3>
        {description && <p className="text-[15px] text-muted-foreground">{description}</p>}
      </header>
      {children}
    </section>
  )
}

function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("grid gap-1.5", className)}>
      <span className="text-[15px] font-medium">{label}</span>
      {children}
      {hint && <span className="text-sm text-muted-foreground">{hint}</span>}
    </label>
  )
}

/** A switch on the right, its label and one line of help on the left. Rows sit on dividers, not in boxes. */
function ToggleRow({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t pt-4 first:border-t-0 first:pt-0">
      <Label htmlFor={id} className="grid gap-0.5 font-normal">
        <span className="text-[15px] font-medium">{label}</span>
        {hint && <span className="text-sm text-muted-foreground">{hint}</span>}
      </Label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </div>
  )
}

function Pair({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>
}

/* ---------------------------------------------------------------- Business details */

export function BusinessSection() {
  const { text, flag, set, bind } = useSettings()
  const zones = ZONES.some(([zone]) => zone === text("timezone")) ? ZONES : [[text("timezone"), text("timezone")] as [string, string], ...ZONES]
  return (
    <>
      <SettingsCard title="Your business">
        <Field label="Business name"><Input required className={fieldClass} {...bind("businessName")} /></Field>
        <Pair>
          <Field label="Time zone"><select className={selectClass} {...bind("timezone")}>{zones.map(([zone, label]) => <option key={zone} value={zone}>{label}</option>)}</select></Field>
          <Field label="Email callers can write to"><Input type="email" className={fieldClass} placeholder="office@yourshop.com" {...bind("supportEmail")} /></Field>
        </Pair>
      </SettingsCard>
      <SettingsCard title="Greeting">
        <Field label="What Call Otto says when it picks up"><Textarea required rows={2} className={areaClass} {...bind("greeting")} /></Field>
        <ToggleRow id="recordingNotice" label="Recording notice when a call is put through to you" checked={flag("recordingNotice")} onChange={(value) => set("recordingNotice", value)}
          hint={flag("recordingNotice") ? "On: you get a transcript only, no audio. Callers put through to you hear the notice first." : "Off: calls are saved with audio and no notice is played. Your state’s rules decide which is right."} />
      </SettingsCard>
      <SettingsCard title="Where you work" description="Call Otto checks each caller’s address against this list.">
        <Field label="Cities and ZIP codes" hint="A city with its state, like “Sarasota FL”, or a 5-digit ZIP."><Textarea rows={2} placeholder="Sarasota FL, 34236" className={areaClass} {...bind("serviceAreaTerms")} /></Field>
      </SettingsCard>
      <SettingsCard title="What you fix">
        <Field label="Services you offer" hint="Separate with commas."><Textarea rows={2} className={areaClass} {...bind("serviceCategories")} /></Field>
      </SettingsCard>
      <SettingsCard title="Names and words" description="Help Call Otto say your street names and brands right.">
        <Field label="Say these words like this" hint="One per line, like “Myakka: my-AK-uh”."><Textarea rows={2} className={areaClass} {...bind("pronunciations")} /></Field>
      </SettingsCard>
    </>
  )
}

/* ---------------------------------------------------------------- How calls are answered */

export function AnsweringSection() {
  const { text, flag, set, bind, settings } = useSettings()
  const { dashboard } = useMode()
  // With every call sent to Otto, pausing (which disconnects the line) leaves callers with nowhere to go.
  const everyCall = text("operationMode") === "always" || Boolean(dashboard?.line.business.everyCallOn)
  const off = dashboard?.line.business.plan?.off
  // Said when they pick Paused, not before: until the code is dialed, pausing stops nothing.
  const pauseHint = settings.status !== "active"
    ? "Your line turns on after it’s approved. Until then it stays paused."
    : everyCall && text("serviceState") === "paused"
      ? `Otto answers every call, so pausing stops all calls to your business number. Turn forwarding off first${off ? `: dial ${off} on that phone` : " with your phone company"}.`
      : undefined
  return (
    <>
      <SettingsCard title="Which calls">
        <Field label="Call Otto is" hint={pauseHint}>
          <select className={selectClass} {...bind("serviceState")}><option value="active">On, answering calls</option><option value="paused">Paused</option></select>
        </Field>
        <Pair>
          <Field label="Calls to your business number" hint={text("operationMode") === "always" ? "Your phone won’t ring for this number." : "Otto takes the calls you miss."}><select className={selectClass} {...bind("operationMode")}><option value="always">Otto answers every call</option><option value="overflow">Ring my phone first</option><option value="after_hours">After hours</option></select></Field>
          <RingFirstField rings={Number(text("answerAfterRings"))} onChange={(value) => set("answerAfterRings", value)} everyCall={text("operationMode") === "always"} family={dashboard?.line.business.carrier?.family ?? null} confirmed={Boolean(dashboard?.line.confirmedAt)} />
        </Pair>
        {dashboard?.line.business.update && (
          <p className="rounded-md border border-brand-ink/15 bg-accent px-3 py-2.5 text-sm text-accent-foreground" role="status">
            Dial your new code once to apply this. <Link className="font-semibold underline underline-offset-4" to={dashboard.onboarding.completed ? "/app" : "/app/start?step=forward"}>Show me the code</Link>
          </p>
        )}
      </SettingsCard>
      <SettingsCard title="After hours" description="When Call Otto answers every call, even ones you could pick up.">
        <Pair>
          <Field label="Starts at"><Input type="time" className={fieldClass} {...bind("weekdayStart")} /></Field>
          <Field label="Ends at"><Input type="time" className={fieldClass} {...bind("weekdayEnd")} /></Field>
        </Pair>
        <ToggleRow id="weekends" label="All weekend" checked={flag("weekends")} onChange={(value) => set("weekends", value)} />
        <Field label="Holidays" hint="Dates like 2026-12-25, separated by commas."><Input className={fieldClass} placeholder="2026-12-25, 2027-01-01" {...bind("holidayDates")} /></Field>
      </SettingsCard>
      <SettingsCard title="Emergencies" description="Urgent calls go to the top of Calls.">
        <Field label="Extra emergency words" hint="Separate with commas, like “no heat, water leak”."><Textarea rows={2} className={areaClass} {...bind("emergencyKeywords")} /></Field>
        <Field label="How quick to call it urgent">
          <select className={selectClass} value={String(([0.5, 0.6, 0.7, 0.8, 0.9].find((value) => Math.abs(value - Number(text("emergencyThreshold"))) < 0.001)) ?? text("emergencyThreshold"))} onChange={(event) => set("emergencyThreshold", event.target.value)}>
            {([[0.5, "Most cautious: flag anything that might be urgent"], [0.6, "Cautious"], [0.7, "Balanced"], [0.8, "Strict"], [0.9, "Strictest: only clear emergencies"]] as Array<[number, string]>).map(([value, label]) => <option key={value} value={String(value)}>{label}</option>)}
          </select>
        </Field>
      </SettingsCard>
      <SettingsCard title="Repeat callers" description="Stops one number from using up your calls.">
        <Field label="Most calls from one number in a day">
          <select className={selectClass} {...bind("maxCallsPerCallerPerDay")}>{unique([1, 2, 3, 5, 8, 10, 20, Number(text("maxCallsPerCallerPerDay"))]).map((value) => <option key={value} value={value}>{value}</option>)}</select>
        </Field>
      </SettingsCard>
    </>
  )
}

/**
 * "Ring my phone first", in what the owner gets: the GSM forwarding timer (about 6 s a ring, 5–30 s). Verizon's
 * timer is fixed, and in "every call" mode the phone never rings, so both show it locked with the reason.
 */
function RingFirstField({ rings, onChange, everyCall, family, confirmed }: { rings: number; onChange: (value: string) => void; everyCall: boolean; family: string | null; confirmed: boolean }) {
  const verizon = family === "verizon"
  const choices = ringChoicesWith(rings)
  const hint = verizon ? "Verizon rings about 30 seconds. They don’t let anyone change that."
    : everyCall ? "Only for Ring my phone first."
    : family === "gsm" && confirmed ? "After you save, dial the new code once to apply it."
    : family === "office" ? "For an office line, set the ring time in your phone company’s website or app."
    : undefined
  return (
    <Field label="Ring time" hint={hint}>
      {verizon ? (
        <select className={cn(selectClass, "disabled:cursor-not-allowed disabled:opacity-70")} disabled value="verizon" onChange={() => undefined}><option value="verizon">About 30 seconds (Verizon)</option></select>
      ) : (
        <select className={cn(selectClass, "disabled:cursor-not-allowed disabled:opacity-70")} name="answerAfterRings" disabled={everyCall} value={String(choices.find((choice) => choice.rings === rings)?.rings ?? 2.5)} onChange={(event) => onChange(event.target.value)}>
          {choices.map((choice) => <option key={choice.rings} value={String(choice.rings)}>{choice.label}</option>)}
        </select>
      )}
    </Field>
  )
}

/* ---------------------------------------------------------------- Prices and answers */

export function AnswersSection() {
  const { bind } = useSettings()
  return (
    <>
      <SettingsCard title="Prices and answers" description="Call Otto only says what’s written here. Leave a box empty and it takes a message instead.">
        <Field label="Prices" hint="One per line, like “Service call: Our service call is $89.”"><Textarea rows={3} placeholder="Service call: Our service call is $89." className={areaClass} {...bind("priceSnippets")} /></Field>
        <Field label="Answers" hint="One per line, like “Brands: We service all major brands.”"><Textarea rows={3} placeholder="Brands: We service all major brands." className={areaClass} {...bind("approvedKnowledge")} /></Field>
      </SettingsCard>
    </>
  )
}

/* ---------------------------------------------------------------- Alerts */

export function AlertsSection() {
  const { text, flag, set, bind, settings, urgentBusy, toggleUrgentCalls } = useSettings()
  const { integrations: i, plan } = settings
  return (
    <>
      <CallAlertsCard className="p-4 md:p-5" />
      <SettingsCard title="Your mobile">
        <Field label="Mobile number" hint="Emergency calls (if on) and text alerts (once texts are on) come here.">
          <Input type="tel" inputMode="tel" autoComplete="tel" className={fieldClass} placeholder={i.ownerPhoneConfigured ? "Saved. Type a new number to replace it" : "+1 941 555 0100"} {...bind("ownerPhone")} />
        </Field>
        {settings.urgentCalls?.available && (
          <ToggleRow id="urgentCalls" label="Call me about emergencies" checked={settings.urgentCalls.on} disabled={urgentBusy}
            hint={settings.urgentCalls.disclosure}
            onChange={(on) => void toggleUrgentCalls(on)} />
        )}
      </SettingsCard>
      <SettingsCard title="Texts">
        <ToggleRow id="ownerRealtimeSmsEnabled" label="A text for every new lead" hint="Sent the moment the call ends. Included in every plan." checked={flag("ownerRealtimeSmsEnabled")} onChange={(value) => set("ownerRealtimeSmsEnabled", value)} />
        <ToggleRow id="ownerDailySmsEnabled" label="Morning recap" hint="Follow-ups and appointments, once a day." checked={flag("ownerDailySmsEnabled")} onChange={(value) => set("ownerDailySmsEnabled", value)} />
        {flag("ownerDailySmsEnabled") && (
          <Field label="Recap time" className="sm:max-w-60">
            <select className={selectClass} {...bind("ownerDailySmsHour")}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, hour)))}</option>)}</select>
          </Field>
        )}
        {/* Shown only once email can actually be sent: never a switch that says "not available". */}
        {i.weeklyEmailAvailable && <ToggleRow id="ownerWeeklyEmailEnabled" label="Sunday email" hint="Open callbacks and the week ahead." checked={flag("ownerWeeklyEmailEnabled")} onChange={(value) => set("ownerWeeklyEmailEnabled", value)} />}
      </SettingsCard>
      <SettingsCard title="Running low on calls" description={plan.unlimited && plan.unlimitedOffer ? `One alert when you reach this share of your ${plan.unlimitedOffer.fairUseCalls.toLocaleString("en-US")} fair-use calls, and one if you use them all.` : `One alert when you reach this share of your ${plan.includedCalls} calls, and one if you use them all.`}>
        <Field label="Alert me" className="sm:max-w-60">
          <select className={selectClass} {...bind("usageAlertPercent")}>
            {EASY_ALERT_PERCENTS.map((percent) => <option key={percent} value={percent}>At {percent}% used</option>)}
            <optgroup label="Other">
              {unique([...OTHER_ALERT_PERCENTS, Number(text("usageAlertPercent"))]).filter((percent) => percent >= 50 && percent <= 95 && !EASY_ALERT_PERCENTS.includes(percent)).map((percent) => <option key={percent} value={percent}>At {percent}% used</option>)}
            </optgroup>
          </select>
        </Field>
      </SettingsCard>
    </>
  )
}

/* ---------------------------------------------------------------- Calendar */

export function CalendarSection() {
  const { text, flag, set, bind, settings } = useSettings()
  const i = settings.integrations
  const minutes = Number(text("minimumLeadTimeMinutes"))
  const notice: Array<[number, string]> = [[0, "No minimum"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [1440, "Next day"], [2880, "2 days"]]
  if (!notice.some(([value]) => value === minutes)) notice.push([minutes, `${minutes} minutes`])
  return (
    <>
      <SettingsCard title="Google Calendar">
        {i.googleConnected ? (
          <>
            <p className="flex items-center gap-2 text-[15px] font-semibold text-emerald-800"><CheckCircle2 className="size-5 shrink-0" />Connected. Call Otto checks when you’re busy, and confirmed jobs go on your calendar.</p>
            <Button size="tap" variant="outline" className={actionClass} asChild><a href="/app/integrations/google/start">Reconnect</a></Button>
          </>
        ) : i.googleAvailable ? (
          <>
            <p className="text-[15px]">Connect the calendar your jobs live on. Call Otto checks when you’re busy, and confirmed jobs land on it.</p>
            <Button size="tap" variant="brand" className={actionClass} asChild><a href="/app/integrations/google/start">Connect Google Calendar</a></Button>
          </>
        ) : (
          <p className="text-[15px]">Not available yet. Until it is, Call Otto takes the time the caller asks for and you confirm it. Those jobs show as <strong className="font-semibold">Confirm time</strong> in Calls.</p>
        )}
        {i.googleConnected || i.googleAvailable ? <a className="text-sm text-muted-foreground underline underline-offset-4" href="/privacy#google-calendar">How Call Otto uses Google Calendar data</a> : null}
      </SettingsCard>
      <SettingsCard title="Appointment hours" description="Times callers can ask for.">
        <Pair>
          <Field label="First appointment"><Input type="time" className={fieldClass} {...bind("bookableWeekdayStart")} /></Field>
          <Field label="Last one ends by"><Input type="time" className={fieldClass} {...bind("bookableWeekdayEnd")} /></Field>
        </Pair>
        <ToggleRow id="bookableWeekends" label="Weekend appointments" checked={flag("bookableWeekends")} onChange={(value) => set("bookableWeekends", value)} />
      </SettingsCard>
      <SettingsCard title="Booking">
        <Pair>
          <Field label="Typical job length">
            <select className={selectClass} {...bind("defaultServiceDurationMinutes")}>{unique([30, 45, 60, 90, 120, 180, 240, Number(text("defaultServiceDurationMinutes"))]).map((value) => <option key={value} value={value}>{value < 60 ? `${value} min` : `${value / 60} hr${value === 60 ? "" : "s"}`}</option>)}</select>
          </Field>
          <Field label="Notice you need"><select className={selectClass} {...bind("minimumLeadTimeMinutes")}>{notice.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        </Pair>
        {i.directBookingAvailable ? (
          <Field label="When a caller picks a time"><select className={selectClass} {...bind("bookingMode")}><option value="confirm">Take the details; I’ll confirm</option><option value="direct">Book it on my calendar</option></select></Field>
        ) : <p className="text-sm text-muted-foreground">Call Otto takes the time the caller wants. You confirm it.</p>}
        <ToggleRow id="requireDiagnosticFeeAcceptance" label="Caller must agree to your service-call fee" hint="Uses the service-call price in How calls are answered." checked={flag("requireDiagnosticFeeAcceptance")} onChange={(value) => set("requireDiagnosticFeeAcceptance", value)} />
      </SettingsCard>
      <SettingsCard title="Teammates’ calendars" description="Each teammate connects their own calendar and sets their own hours on the Team page.">
        <Button size="tap" variant="outline" className={actionClass} asChild><a href="/app/team">Open the Team page<ExternalLink /></a></Button>
      </SettingsCard>
    </>
  )
}

/* ---------------------------------------------------------------- Plan and billing */

function Price({ cents, size = "lg" }: { cents: number; size?: "lg" | "md" }) {
  return (
    <span className="flex items-baseline gap-1">
      <strong className={cn("tabular font-semibold tracking-tight", size === "lg" ? "text-[40px] leading-none" : "text-[28px] leading-none")}>{money(cents)}</strong>
      <span className="text-[15px] text-muted-foreground">/month</span>
    </span>
  )
}

export function PlanSection() {
  const { settings, reload } = useSettings()
  const { dashboard } = useMode()
  const plan = settings.plan
  const csrf = settings.csrf
  const [picked, setPicked] = useState<PlanId>(plan.id)
  const [busy, setBusy] = useState(false)
  const [unlimitedBusy, setUnlimitedBusy] = useState(false)
  const choice = plan.plans.find((item) => item.id === picked)
  const usage = dashboard?.usage
  const tz = dashboard?.shop.timezone ?? "America/New_York"
  const leads = dashboard?.guarantee.state === "watching" ? dashboard.guarantee.leads : null
  const monthly = plan.unlimited && plan.unlimitedOffer ? plan.unlimitedOffer.priceCents : plan.flatMonthlyPriceCents
  const toggleUnlimited = async (on: boolean) => {
    setUnlimitedBusy(true)
    try {
      await api("/api/app/billing/unlimited", { method: "POST", body: { on } })
      await reload()
      toast.success(on ? "Unlimited calls are on." : "Unlimited calls are off.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unlimited calls didn’t change. Please try again.")
    } finally {
      setUnlimitedBusy(false)
    }
  }
  const change = async () => {
    if (!choice) return
    setBusy(true)
    try {
      await api("/api/app/billing/plan", { method: "POST", body: { plan: choice.id } })
      await reload()
      toast.success(`You’re on ${choice.label}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Your plan didn’t change. Please try again.")
    } finally {
      setBusy(false)
    }
  }
  const facts: Array<[string, string]> = [
    [plan.unlimited ? "Fair-use calls" : "Answered calls included", (plan.unlimited && plan.unlimitedOffer ? plan.unlimitedOffer.fairUseCalls : plan.includedCalls).toLocaleString("en-US")],
    ["Each extra call", perCall(plan.overageCentsPerCall)],
    ...(usage ? [["Answered this period", usage.countedCalls.toLocaleString("en-US")] as [string, string], ["Period ends", new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(new Date(usage.periodEnd))] as [string, string]] : []),
    ...(leads !== null ? [["Real leads so far", String(leads)] as [string, string]] : []),
  ]
  return (
    <>
      <section className="grid gap-4 rounded-xl border-2 border-brand-ink bg-card p-4 md:p-5">
        <div className="grid gap-2">
          <span className="text-[15px] font-semibold text-muted-foreground">Your plan: {plan.label}{plan.unlimited ? " with Unlimited calls" : ""}</span>
          <Price cents={monthly} />
          {!plan.sold && <span className="text-sm text-muted-foreground">No longer offered. Yours to keep.</span>}
        </div>
        <dl className="divide-y border-t">
          {facts.map(([key, value]) => (
            <div key={key} className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-[15px] text-muted-foreground">{key}</dt>
              <dd className="tabular text-[15px] font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-muted-foreground">Spam and calls under 15 seconds are never counted.</p>
        {plan.unlimitedOffer && (
          <div className="grid gap-1 border-t pt-4">
            <label htmlFor="settings-unlimited" className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
              <span className="flex items-center gap-3 text-base font-semibold"><Switch id="settings-unlimited" checked={plan.unlimited} disabled={unlimitedBusy} onCheckedChange={(on) => void toggleUnlimited(on)} />Unlimited calls</span>
              <span className="tabular text-base font-semibold">+{money(plan.unlimitedOffer.addOnCents)}/mo</span>
            </label>
            <span className="text-sm text-muted-foreground">{FAIR_USE_LINE}</span>
          </div>
        )}
      </section>

      {plan.plans.length > 1 && (
        <SettingsCard title="Change plan" description={plan.paid ? "You pay or get credit for the difference right away. Teammates are always free." : "We’ll use this plan when you add your card."}>
          <div className="grid gap-2.5 md:grid-cols-3" role="radiogroup" aria-label="Plans">
            {plan.plans.map((item) => (
              <button key={item.id} type="button" role="radio" aria-checked={picked === item.id} onClick={() => setPicked(item.id)}
                className={cn("grid content-start gap-2 rounded-xl border-2 bg-card p-4 text-left transition focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none", picked === item.id ? "border-brand-ink" : "border-border hover:border-brand-ink/40")}>
                <span className="flex items-center justify-between gap-2">
                  <strong className="text-[17px] font-semibold">{item.label}</strong>
                  {item.id === plan.id && <span className="rounded-md bg-brand-yellow px-2 py-0.5 text-[13px] font-semibold text-brand-ink">Current</span>}
                </span>
                <Price cents={item.priceCents} size="md" />
                <span className="text-[15px]"><span className="tabular font-semibold">{item.includedCalls}</span> answered calls</span>
                <span className="text-sm text-muted-foreground">{item.who}</span>
              </button>
            ))}
          </div>
          {choice && choice.id !== plan.id && (
            <Button size="tap" variant="brand" className={actionClass} disabled={busy} onClick={() => void change()}>{busy ? "Switching…" : `Switch to ${choice.label}`}</Button>
          )}
        </SettingsCard>
      )}

      <SettingsCard title={plan.paid ? "Card, invoices, cancel" : "Start your plan"} description={plan.paid ? "Opens our billing page (Stripe) to change your card, see invoices or cancel." : "Add a card to start answering calls."}>
        <form method="post" action={plan.paid ? "/app/billing/portal" : "/app/billing/checkout"}>
          <input type="hidden" name="csrf" value={csrf} />
          <Button size="tap" variant={plan.paid ? "outline" : "brand"} className={actionClass}>{plan.paid ? "Manage billing or cancel" : "Start your plan"}</Button>
        </form>
      </SettingsCard>
    </>
  )
}

/* ---------------------------------------------------------------- Team */

export function TeamSection() {
  return (
    <SettingsCard title="Teammates" description="Invite people who handle calls with you. Each one signs in with their own email.">
      <dl className="divide-y border-y">
        {[
          ["They can", "See Calls, Jobs and Calendar, call customers back and mark jobs done."],
          ["They can’t", "Change billing, these settings, or delete calls."],
          ["Their calendar", "Each connects their own Google Calendar and sets their own hours."],
          ["Cost", "Free. Teammates never change your price."],
        ].map(([key, value]) => (
          <div key={key} className="grid gap-0.5 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
            <dt className="text-[15px] text-muted-foreground">{key}</dt>
            <dd className="text-[15px]">{value}</dd>
          </div>
        ))}
      </dl>
      <Button size="tap" variant="outline" className={actionClass} asChild><a href="/app/team">Invite or manage teammates<ExternalLink /></a></Button>
    </SettingsCard>
  )
}

/* ---------------------------------------------------------------- Your data */

function DownloadRow({ title, text, href }: { title: string; text: string; href: string }) {
  return (
    <div className="grid gap-3 border-t pt-4 first:border-t-0 first:pt-0 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6">
      <div className="grid gap-0.5">
        <strong className="text-[15px] font-semibold">{title}</strong>
        <span className="text-sm text-muted-foreground">{text}</span>
      </div>
      <Button size="tap" variant="outline" className="w-full sm:w-40" asChild><a href={href} download><Download />Download</a></Button>
    </div>
  )
}

export function DataSection() {
  const { settings, text, bind } = useSettings()
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Signed up with Google, Microsoft or an email link: no password to type, a fresh sign-in instead.
  const hasPassword = settings.signIn?.hasPassword ?? true
  const needsFreshSignIn = !hasPassword && !settings.signIn?.recent
  return (
    <>
      <SettingsCard title="Download your data" description="Files save straight to this phone or computer. Nothing is emailed.">
        <DownloadRow title="Calls spreadsheet (.csv)" text="Every call: date, caller, callback number, address, problem and outcome. Opens in Excel or Google Sheets." href={`/api/app/shops/${encodeURIComponent(settings.shopId)}/calls.csv`} />
        <DownloadRow title="Everything (.json)" text="Settings, calls, transcripts, follow-ups and appointments in one file, for moving to another system. Recordings aren’t included." href="/app/account/export" />
      </SettingsCard>
      <SettingsCard title="Keep call records for" description="Older calls, transcripts and recordings are deleted for good. Jobs on your calendar stay.">
        <Field label="Keep for" className="sm:max-w-60">
          <select className={selectClass} {...bind("dataRetentionDays")}>{unique([30, 60, 90, 180, 365, Number(text("dataRetentionDays"))]).map((days) => <option key={days} value={days}>{days} days</option>)}</select>
        </Field>
      </SettingsCard>
      <SettingsCard title="Sign out">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6">
          <span className="text-[15px]">Sign out of this phone or computer.</span>
          <Button size="tap" variant="outline" className="w-full sm:w-52" asChild><a href="/logout"><LogOut />Sign out</a></Button>
        </div>
        <form method="post" action="/app/account/sign-out-everywhere" className="grid gap-3 border-t pt-4 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6">
          <input type="hidden" name="csrf" value={settings.csrf} />
          <span className="text-[15px]">Sign out of every phone and computer, this one too. Use it if a phone is lost.</span>
          <Button size="tap" variant="outline" className="w-full sm:w-52">Sign out everywhere</Button>
        </form>
      </SettingsCard>
      <SettingsCard danger title="Delete your account" description="Cancel your plan first. This disconnects your line and deletes every call, transcript, recording, follow-up and setting. Jobs on your calendar stay there.">
        {!confirmDelete ? (
          <Button size="tap" variant="outline" className={cn(actionClass, "border-red-200 text-red-700 hover:bg-red-50")} type="button" onClick={() => setConfirmDelete(true)}>Delete my account…</Button>
        ) : needsFreshSignIn ? (
          <div className="grid gap-3">
            <p className="text-[15px]">For your safety, sign in again first. Then you have 10 minutes to delete.</p>
            <Button size="tap" variant="outline" className={actionClass} asChild><a href="/login?next=%2Fapp%2Fsettings%2Fdata">Sign in again</a></Button>
          </div>
        ) : (
          <form method="post" action="/app/account/delete" className="grid gap-4">
            <input type="hidden" name="csrf" value={settings.csrf} />
            <Pair>
              <Field label="Type DELETE"><Input name="confirm" autoComplete="off" required className={fieldClass} /></Field>
              {hasPassword ? <Field label="Your password"><Input name="password" type="password" autoComplete="current-password" required className={fieldClass} /></Field> : null}
            </Pair>
            <Button size="tap" className={cn(actionClass, "bg-red-600 text-white hover:bg-red-700")}>Delete my account for good</Button>
          </form>
        )}
      </SettingsCard>
    </>
  )
}
