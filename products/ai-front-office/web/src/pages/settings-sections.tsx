import { useEffect, useState, type ReactNode } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { CheckCircle2, ChevronRight, Download, Loader2, LogOut } from "lucide-react"
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
import { ringChoicesWith, VERIZON_RING_LINE } from "@/lib/dial"
import { pauseHint } from "@/lib/pause-hint"
import { recordingHint } from "@/lib/recording-hint"
import { SMS_CONSENT_END, SMS_CONSENT_JOIN, SMS_CONSENT_LEAD, SMS_CONSENT_PRIVACY, SMS_CONSENT_TERMS } from "@/lib/sms-consent"
import { forwardingOn } from "@/lib/line-status"
import type { ApiSettings } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useSettings } from "./settings"

const ZONES: Array<[string, string]> = [["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona"], ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"]]
/** Fields read easily (DESIGN): 17px, weight 500, dark ink on white, 48px tall, a solid ink focus edge. */
const selectClass = "h-12 w-full rounded-lg border border-input bg-card px-3 text-[17px] font-medium text-foreground outline-none focus-visible:border-brand-ink focus-visible:ring-[3px] focus-visible:ring-brand-ink/20"
const fieldClass = "h-12 bg-card"
const areaClass = "bg-card"
/** Card actions: full width on a phone; on a computer every button in a card is the same width, left-aligned. */
const actionClass = "w-full sm:w-60"
// The server accepts any whole percent from 50 to 95; 75 (the default) and 90 are the easy picks.
const EASY_ALERT_PERCENTS = [75, 90]
const OTHER_ALERT_PERCENTS = [50, 55, 60, 65, 70, 80, 85, 95]
const unique = (list: number[]) => list.filter((value, index, all) => all.indexOf(value) === index).sort((left, right) => left - right)

/** One topic, one card. */
export function SettingsCard({ title, description, children, danger, id }: { title: string; description?: ReactNode; children: ReactNode; danger?: boolean; id?: string }) {
  return (
    <section id={id} className={cn("grid scroll-mt-24 gap-4 rounded-xl border bg-card p-4 md:p-5", danger && "border-red-200")}>
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
  const { text, flag, set, bind, settings } = useSettings()
  const zones = ZONES.some(([zone]) => zone === text("timezone")) ? ZONES : [[text("timezone"), text("timezone")] as [string, string], ...ZONES]
  // Renamed the business while the greeting still says the old name: offer to change it there too, in one tap.
  const savedName = String(settings.values.businessName ?? "").trim()
  const newName = text("businessName").trim()
  const staleGreeting = savedName.length > 1 && newName.length > 1 && newName !== savedName && text("greeting").includes(savedName)
  return (
    <>
      <SettingsCard title="Your business">
        <Field label="Business name"><Input required className={fieldClass} {...bind("businessName")} /></Field>
        {staleGreeting && (
          <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-brand-ink/15 bg-accent px-3 py-2 text-sm text-accent-foreground">
            <span>Your greeting still says “{savedName}”.</span>
            <button type="button" className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4" onClick={() => set("greeting", text("greeting").split(savedName).join(newName))}>Use “{newName}” there too</button>
          </p>
        )}
        <Pair>
          <Field label="Time zone"><select className={selectClass} {...bind("timezone")}>{zones.map(([zone, label]) => <option key={zone} value={zone}>{label}</option>)}</select></Field>
          <Field label="Email callers can write to"><Input type="email" className={fieldClass} placeholder="office@yourshop.com" {...bind("supportEmail")} /></Field>
        </Pair>
      </SettingsCard>
      <SettingsCard title="Greeting">
        <Field label="What Call Otto says when it picks up"><Textarea required rows={2} className={areaClass} {...bind("greeting")} /></Field>
        <ToggleRow id="recordingNotice" label="Recording notice when a call is put through to you" checked={flag("recordingNotice")} onChange={(value) => set("recordingNotice", value)}
          hint={recordingHint(flag("recordingNotice"), text("serviceAreaTerms"))} />
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
  const { text, set, bind, settings } = useSettings()
  const { dashboard } = useMode()
  // Said when they pick Paused, and only when every call may go to Otto (the saved choice or the last passed test).
  const business = dashboard?.line.business
  const hint = pauseHint({ active: settings.status === "active", paused: text("serviceState") === "paused", mayForwardAll: Boolean(business?.mayForwardAll), off: business?.plan?.off })
  // Two ways calls work. A shop saved as "after hours" works like ring first today (forwarding sends Otto only the
  // calls nobody picks up, at any hour), so it shows as Ring my phone first.
  const everyCall = text("operationMode") === "always"
  const mode = everyCall ? "always" : "overflow"
  const forwarding = dashboard?.line.number ? (forwardingOn(dashboard.line) ? (dashboard.line.business.update ? "Dial your new code" : "Forwarding works") : "Not on yet") : null
  return (
    <>
      <SettingsCard title="Which calls">
        <Field label="Call Otto is" hint={hint}>
          <select className={selectClass} {...bind("serviceState")}><option value="active">On, answering calls</option><option value="paused">Paused</option></select>
        </Field>
        <Pair>
          <Field label="Calls to your business number" hint={everyCall ? "Your phone won’t ring for this number." : "Your phone rings first. Otto takes the calls you miss."}>
            <select className={selectClass} name="operationMode" value={mode} onChange={(event) => set("operationMode", event.target.value === "overflow" && text("operationMode") === "after_hours" ? "after_hours" : event.target.value)}>
              <option value="always">Otto answers every call</option><option value="overflow">Ring my phone first</option>
            </select>
          </Field>
          {/* Ring time only matters when the phone rings first. */}
          {!everyCall && <RingFirstField rings={Number(text("answerAfterRings"))} onChange={(value) => set("answerAfterRings", value)} family={dashboard?.line.business.carrier?.family ?? null} confirmed={Boolean(dashboard?.line.confirmedAt)} />}
        </Pair>
        {dashboard?.line.business.update && (
          <p className="rounded-md border border-brand-ink/15 bg-accent px-3 py-2.5 text-sm text-accent-foreground" role="status">
            Dial your new code once to apply this. <Link className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4" to="/app/start?step=forward">Show me the code</Link>
          </p>
        )}
        {forwarding && (
          <Link to="/app/start?step=forward" className="group flex min-h-12 items-center justify-between gap-3 border-t pt-3 text-[15px]">
            <span className="grid"><strong className="font-semibold group-hover:underline">Your forwarding code</strong><span className="text-sm text-muted-foreground">{forwarding}. See the code, test it, or turn it off.</span></span>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
          </Link>
        )}
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
function RingFirstField({ rings, onChange, family, confirmed }: { rings: number; onChange: (value: string) => void; family: string | null; confirmed: boolean }) {
  const verizon = family === "verizon"
  const choices = ringChoicesWith(rings)
  const hint = verizon ? VERIZON_RING_LINE
    : family === "gsm" && confirmed ? "After you save, dial the new code once to apply it."
    : family === "office" ? "For an office line, set the ring time in your phone company’s website or app."
    : undefined
  return (
    <Field label="Ring time" hint={hint}>
      {verizon ? (
        <select className={cn(selectClass, "disabled:cursor-not-allowed disabled:opacity-70")} disabled value="verizon" onChange={() => undefined}><option value="verizon">About 30 seconds (Verizon)</option></select>
      ) : (
        <select className={selectClass} name="answerAfterRings" value={String(choices.find((choice) => choice.rings === rings)?.rings ?? 2)} onChange={(event) => onChange(event.target.value)}>
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
      <SettingsCard title="What Otto may say" description="Call Otto only says what’s written here. Leave a box empty and it takes a message instead.">
        <Field label="Prices" hint="One per line: a name, a colon, then the exact words."><Textarea rows={3} placeholder="Service call: Our service call is $89." className={areaClass} {...bind("priceSnippets")} /></Field>
        <Field label="Answers" hint="One per line, the same way."><Textarea rows={3} placeholder="Brands: We service all major brands." className={areaClass} {...bind("approvedKnowledge")} /></Field>
      </SettingsCard>
    </>
  )
}

/* ---------------------------------------------------------------- Alerts */

export function AlertsSection() {
  const { text, flag, set, bind, settings, urgentBusy, toggleUrgentCalls, patchSettings } = useSettings()
  const { reload: reloadDashboard } = useMode()
  const { integrations: i } = settings
  const { hash } = useLocation()
  // Texts: kept here (not in the form), so turning them on never throws away an unsaved edit on this page.
  const [texts, setTexts] = useState<NonNullable<ApiSettings["texts"]>>(settings.texts ?? { live: false, on: false, mobile: i.ownerPhoneMasked ?? null })
  useEffect(() => { if (settings.texts) setTexts(settings.texts) }, [settings.texts])
  const [textsBusy, setTextsBusy] = useState(false)
  const [textsError, setTextsError] = useState<string | null>(null)
  const mobile = texts.mobile ?? i.ownerPhoneMasked ?? null
  const [editingMobile, setEditingMobile] = useState(!mobile)
  useEffect(() => { setEditingMobile(!i.ownerPhoneMasked) }, [i.ownerPhoneMasked])
  // "Turn on" from the banner lands on the consent box.
  useEffect(() => { if (hash === "#texts") requestAnimationFrame(() => document.getElementById("texts")?.scrollIntoView({ block: "start" })) }, [hash])
  const toggleTexts = async (on: boolean) => {
    const typed = text("ownerPhone").trim()
    setTextsError(null)
    if (on && !mobile && !typed) {
      setTextsError("Add your mobile number above first.")
      setEditingMobile(true)
      requestAnimationFrame(() => document.getElementById("owner-phone")?.focus())
      return
    }
    setTextsBusy(true)
    // The box shows the tap at once; it goes back if the server says no.
    const before = texts
    setTexts({ ...texts, on })
    try {
      const result = await api<{ texts: NonNullable<ApiSettings["texts"]> }>("/api/app/alerts/texts", { method: "POST", body: { on, ...(on && typed ? { phone: typed } : {}) } })
      setTexts(result.texts)
      // The saved settings learn it too, so another settings page and back (and the Settings list) show it.
      patchSettings((current) => ({
        ...current,
        texts: result.texts,
        integrations: { ...current.integrations, ownerPhoneConfigured: current.integrations.ownerPhoneConfigured || Boolean(result.texts.mobile), ownerPhoneMasked: result.texts.mobile ?? current.integrations.ownerPhoneMasked ?? null },
      }))
      if (on && typed) { set("ownerPhone", ""); setEditingMobile(false) }
      await reloadDashboard()
      toast.success(on ? (result.texts.live ? "Text alerts are on." : "Saved. Texts start once approved.") : "Text alerts are off.")
    } catch (error) {
      setTexts(before)
      setTextsError(error instanceof Error ? error.message : "That didn’t change. Please try again.")
    } finally {
      setTextsBusy(false)
    }
  }
  // The text switches work only once texts can send and the owner said yes; until then they read off, with why.
  const textsReady = texts.live && texts.on
  const switchHint = (on: string) => (!texts.live ? "Texts start once approved." : !texts.on ? "Check the box above first." : on)
  return (
    <>
      <CallAlertsCard className="p-4 md:p-5" />
      <SettingsCard title="Your mobile">
        {mobile && !editingMobile ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-0.5">
              <span className="text-[15px] font-medium">Mobile number</span>
              <strong className="tabular text-[17px] font-semibold">{mobile}</strong>
              <span className="text-sm text-muted-foreground">Emergency calls (if on) and text alerts come here.</span>
            </div>
            <Button type="button" size="tap" variant="outline" onClick={() => { setEditingMobile(true); requestAnimationFrame(() => document.getElementById("owner-phone")?.focus()) }}>Change</Button>
          </div>
        ) : (
          <Field label="Mobile number" hint="Emergency calls (if on) and text alerts come here.">
            <Input id="owner-phone" type="tel" inputMode="tel" autoComplete="tel" className={fieldClass} placeholder="(941) 555-0100" {...bind("ownerPhone")} />
          </Field>
        )}
        {mobile && editingMobile && <button type="button" className="-mt-2 inline-flex min-h-11 w-fit items-center text-sm font-semibold underline underline-offset-4" onClick={() => { set("ownerPhone", ""); setEditingMobile(false) }}>Keep {mobile}</button>}
        {settings.urgentCalls?.available && (
          <ToggleRow id="urgentCalls" label="Call me about emergencies" checked={settings.urgentCalls.on} disabled={urgentBusy}
            hint={settings.urgentCalls.disclosure}
            onChange={(on) => void toggleUrgentCalls(on)} />
        )}
        {/* The urgent number is the business number and may send every call to Otto: Otto skips those calls. */}
        {settings.urgentCalls?.available && settings.urgentCalls.on && settings.urgentCalls.held && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">Emergency calls paused: this number may send every call to Otto. You still get a push and an email.</p>
        )}
      </SettingsCard>
      <SettingsCard id="texts" title="Texts">
        {/* The consent box: its words are carrier-reviewed and never change (see lib/sms-consent). */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
          <input id="sms-consent" type="checkbox" checked={texts.on} disabled={textsBusy} aria-describedby={textsError ? "sms-consent-error" : undefined} onChange={(event) => void toggleTexts(event.target.checked)} className="mt-1 size-5 cursor-pointer accent-brand-ink disabled:cursor-wait" />
          <label htmlFor="sms-consent" className="block cursor-pointer text-[15px] leading-relaxed">{SMS_CONSENT_LEAD}<a className="font-semibold underline underline-offset-4" href={SMS_CONSENT_TERMS.href}>{SMS_CONSENT_TERMS.label}</a>{SMS_CONSENT_JOIN}<a className="font-semibold underline underline-offset-4" href={SMS_CONSENT_PRIVACY.href}>{SMS_CONSENT_PRIVACY.label}</a>{SMS_CONSENT_END}</label>
        </div>
        {textsBusy && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 motion-safe:animate-spin" />Saving…</p>}
        {textsError && <p id="sms-consent-error" role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">{textsError}</p>}
        <ToggleRow id="ownerRealtimeSmsEnabled" label="A text for every new lead" hint={switchHint("Sent the moment the call ends. Included in every plan.")} checked={textsReady && flag("ownerRealtimeSmsEnabled")} disabled={!textsReady} onChange={(value) => set("ownerRealtimeSmsEnabled", value)} />
        <ToggleRow id="ownerDailySmsEnabled" label="Morning recap" hint={switchHint("Follow-ups and appointments, once a day.")} checked={textsReady && flag("ownerDailySmsEnabled")} disabled={!textsReady} onChange={(value) => set("ownerDailySmsEnabled", value)} />
        {textsReady && flag("ownerDailySmsEnabled") && (
          <Field label="Recap time" className="sm:max-w-60">
            <select className={selectClass} {...bind("ownerDailySmsHour")}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, hour)))}</option>)}</select>
          </Field>
        )}
        {/* Shown only once email can actually be sent: never a switch that says "not available". */}
        {i.weeklyEmailAvailable && <ToggleRow id="ownerWeeklyEmailEnabled" label="Sunday email" hint="Open callbacks and the week ahead." checked={flag("ownerWeeklyEmailEnabled")} onChange={(value) => set("ownerWeeklyEmailEnabled", value)} />}
      </SettingsCard>
      <SettingsCard title="Running low on calls" description={settings.plan.unlimited && settings.plan.unlimitedOffer ? `One alert when you reach this share of your ${settings.plan.unlimitedOffer.fairUseCalls.toLocaleString("en-US")} fair-use calls, and one if you use them all.` : `One alert when you reach this share of your ${settings.plan.includedCalls} calls, and one if you use them all.`}>
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
        <ToggleRow id="requireDiagnosticFeeAcceptance" label="Caller must agree to your service-call fee" hint="Uses the service-call price in Prices and answers." checked={flag("requireDiagnosticFeeAcceptance")} onChange={(value) => set("requireDiagnosticFeeAcceptance", value)} />
      </SettingsCard>
      <SettingsCard title="Teammates’ calendars" description="Each teammate connects their own calendar and sets their own hours on the Team page.">
        <Button size="tap" variant="outline" className={actionClass} asChild><a href="/app/team">Open the Team page</a></Button>
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
  // Back from "Manage billing" when it couldn't open: say so here, in one line.
  const [params] = useSearchParams()
  const billing = params.get("billing")
  const choice = plan.plans.find((item) => item.id === picked)
  const usage = dashboard?.usage
  const comp = dashboard?.billing.status === "comp"
  const billingNote = billing === "comp" || (comp && billing) ? "This is a complimentary account. There’s no billing to manage." : billing === "none" ? "There’s no paid plan to manage yet." : billing === "unavailable" ? "Billing couldn’t open just now. Nothing changed. Try again in a minute." : null
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

      {/* A complimentary shop (the Google review account) has no card or Stripe billing to open. */}
      {comp && billingNote && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">{billingNote}</p>}
      {!comp && (
        <SettingsCard title={plan.paid ? "Card, invoices, cancel" : "Start your plan"} description={plan.paid ? "Opens our billing page (Stripe) to change your card, see invoices or cancel." : "Add a card to start answering calls."}>
          {billingNote && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">{billingNote}</p>}
          <form method="post" action={plan.paid ? "/app/billing/portal" : "/app/billing/checkout"}>
            <input type="hidden" name="csrf" value={csrf} />
            <Button size="tap" variant={plan.paid ? "outline" : "brand"} className={actionClass}>{plan.paid ? "Manage billing or cancel" : "Start your plan"}</Button>
          </form>
        </SettingsCard>
      )}
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
      <Button size="tap" variant="outline" className={actionClass} asChild><a href="/app/team">Invite or manage teammates</a></Button>
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

/** Back from a refused delete: what went wrong, said next to the form. */
const DELETE_PROBLEMS: Record<string, string> = {
  confirm: "Type DELETE in the first box.",
  password: "That password isn’t right. Try again, or sign in again with Google or an email link instead.",
  slow: "Too many tries. Wait 15 minutes, or sign in again with Google or an email link.",
  plan: "Cancel your plan first. You can delete once it has ended.",
  line: "We couldn’t disconnect your line, so nothing was deleted. Try again.",
  recording: "A call recording couldn’t be deleted, so nothing else was removed. Try again.",
}
/** Re-sign-in lands back here with the delete form open. */
const SIGN_IN_TO_DELETE = `/login?next=${encodeURIComponent("/app/settings/data?delete=open")}`

export function DataSection() {
  const { settings, text, bind } = useSettings()
  const [params] = useSearchParams()
  const deleteBack = params.get("delete")
  const [confirmDelete, setConfirmDelete] = useState(Boolean(deleteBack))
  // Signed in within the last 10 minutes (any way): that proves it's the owner, no password needed.
  // Otherwise a password account types its password; Google, Microsoft or email-link accounts sign in again.
  const hasPassword = settings.signIn?.hasPassword ?? true
  const recent = settings.signIn?.recent ?? false
  const needsFreshSignIn = !hasPassword && !recent
  const askPassword = hasPassword && !recent
  const problem = deleteBack === "signin"
    ? (hasPassword ? "It’s been over 10 minutes since you signed in. Enter your password, or sign in again." : null)
    : deleteBack ? DELETE_PROBLEMS[deleteBack] ?? null : null
  const badPassword = deleteBack === "password"
  useEffect(() => {
    if (!deleteBack) return
    document.getElementById("delete-account")?.scrollIntoView({ block: "center" })
    if (badPassword) document.getElementById("delete-password")?.focus()
  }, [deleteBack, badPassword])
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
      <SettingsCard danger id="delete-account" title="Delete your account" description="Cancel your plan first. This disconnects your line and deletes every call, transcript, recording, follow-up and setting. Jobs on your calendar stay there.">
        {!confirmDelete ? (
          <Button size="tap" variant="outline" className={cn(actionClass, "border-red-200 text-red-700 hover:bg-red-50")} type="button" onClick={() => setConfirmDelete(true)}>Delete my account…</Button>
        ) : needsFreshSignIn ? (
          <div className="grid gap-3">
            <p className="text-[15px]">For your safety, sign in again first. Then you have 10 minutes to delete.</p>
            <Button size="tap" variant="outline" className={actionClass} asChild><a href={SIGN_IN_TO_DELETE}>Sign in again</a></Button>
          </div>
        ) : (
          <form method="post" action="/app/account/delete" className="grid gap-4">
            <input type="hidden" name="csrf" value={settings.csrf} />
            {problem && <p role="alert" id="delete-problem" className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">{problem}</p>}
            <Pair>
              <Field label="Type DELETE"><Input name="confirm" autoComplete="off" required defaultValue={deleteBack && deleteBack !== "confirm" && deleteBack !== "open" ? "DELETE" : undefined} aria-invalid={deleteBack === "confirm" || undefined} className={fieldClass} /></Field>
              {askPassword ? (
                <Field label="Your password">
                  <Input id="delete-password" name="password" type="password" autoComplete="current-password" required aria-invalid={badPassword || undefined} aria-describedby={badPassword ? "delete-problem" : undefined} className={fieldClass} />
                </Field>
              ) : null}
            </Pair>
            {askPassword && <p className="text-sm text-muted-foreground">Forgot it? <a className="font-medium text-foreground underline underline-offset-4" href={SIGN_IN_TO_DELETE}>Sign in again with Google or an email link</a>, then delete here within 10 minutes.</p>}
            <Button size="tap" className={cn(actionClass, "bg-red-600 text-white hover:bg-red-700")}>Delete my account for good</Button>
          </form>
        )}
      </SettingsCard>
    </>
  )
}
