import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { CheckCircle2, Download, LogOut, Users } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api, useApi } from "@/lib/api"
import { useMode } from "@/lib/mode"
import type { ApiSettings, SettingsValues } from "@/lib/types"
import { cn, tapWidth } from "@/lib/utils"

const ZONES: Array<[string, string]> = [["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona"], ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"]]
const selectClass = "h-12 w-full rounded-lg border border-input bg-card px-3 text-[16px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:h-10 lg:text-sm"
const fieldClass = "h-12 text-[16px] lg:h-10 lg:text-sm bg-card"
// The server accepts any whole percent from 50 to 95; 75 (the default) and 90 are the easy picks.
const EASY_ALERT_PERCENTS = [75, 90]
const OTHER_ALERT_PERCENTS = [50, 55, 60, 65, 70, 80, 85, 95]

function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("grid gap-1.5", className)}>
      <span className="text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="text-[13px] text-muted-foreground">{hint}</span>}
    </label>
  )
}

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  )
}

function Toggle({ id, label, hint, checked, disabled, onChange, extra }: { id: string; label: ReactNode; hint?: ReactNode; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; extra?: ReactNode }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 rounded-xl border bg-card p-3.5", disabled && "opacity-70")}>
      <Label htmlFor={id} className="grid gap-1 font-normal">
        <span className="text-[15px] font-semibold">{label}</span>
        {hint && <span className="text-[13px] text-muted-foreground">{hint}</span>}
        {extra}
      </Label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  )
}

export function SettingsPage() {
  const { reload: reloadDashboard } = useMode()
  const settings = useApi<ApiSettings>("/api/app/settings")
  const [values, setValues] = useState<SettingsValues | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (settings.data) setValues(settings.data.values) }, [settings.data])
  if (settings.error) return <Card><CardContent>{settings.error}</CardContent></Card>
  if (!settings.data || !values) return <div className="grid gap-4">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-48 w-full rounded-xl" />)}</div>
  const { integrations: i, plan, csrf } = settings.data
  const text = (name: string) => String(values[name] ?? "")
  const flag = (name: string) => values[name] === true
  const set = (name: string, value: string | boolean) => setValues({ ...values, [name]: value })
  const bind = (name: string) => ({ name, value: text(name), onChange: (event: { target: { value: string } }) => set(name, event.target.value) })
  const zones = ZONES.some(([zone]) => zone === text("timezone")) ? ZONES : [[text("timezone"), text("timezone")] as [string, string], ...ZONES]
  const unique = (list: number[]) => list.filter((value, index, all) => all.indexOf(value) === index).sort((left, right) => left - right)
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const next = await api<ApiSettings>("/api/app/settings", { method: "PUT", body: values })
      settings.setData(next)
      setValues(next.values)
      await reloadDashboard()
      toast.success("Saved.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn’t save. Please try again.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <form className="grid min-w-0 gap-4" onSubmit={save}>
        <Group title="Answering">
          <Field label="Front Office is" hint={settings.data.status === "active" ? undefined : "Your line turns on after activation. Until then it stays paused."}>
            <select className={selectClass} {...bind("serviceState")}><option value="active">On, answering calls</option><option value="paused">Paused</option></select>
          </Field>
          <Field label="Answer">
            <select className={selectClass} {...bind("operationMode")}><option value="overflow">Only calls I miss</option><option value="after_hours">After hours</option><option value="always">Every call</option></select>
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Ring my phone first">
              <select className={selectClass} {...bind("answerAfterRings")}>{[2, 3, 4, 5, 6, 8, 10, 12].map((rings) => <option key={rings} value={rings}>{rings} rings</option>)}</select>
            </Field>
            <Toggle id="weekends" label="Answer all weekend" checked={flag("weekends")} onChange={(value) => set("weekends", value)} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="After hours start"><Input type="time" className={fieldClass} {...bind("weekdayStart")} /></Field>
            <Field label="After hours end"><Input type="time" className={fieldClass} {...bind("weekdayEnd")} /></Field>
          </div>
          <Field label="Holidays to cover" hint="YYYY-MM-DD, comma separated"><Input className={fieldClass} placeholder="2026-12-25" {...bind("holidayDates")} /></Field>
        </Group>

        <Group title="Your shop">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Business name"><Input required className={fieldClass} {...bind("businessName")} /></Field>
            <Field label="Time zone"><select className={selectClass} {...bind("timezone")}>{zones.map(([zone, label]) => <option key={zone} value={zone}>{label}</option>)}</select></Field>
          </div>
          <Field label="Greeting"><Textarea required rows={2} className="bg-card text-[16px] lg:text-sm" {...bind("greeting")} /></Field>
          <Toggle id="recordingNotice" label="Recording notice on transfers" checked={flag("recordingNotice")} onChange={(value) => set("recordingNotice", value)}
            hint="Off: just your greeting, calls saved with audio. On: nothing extra up front, transcript only (no audio), and callers hear “Calls may be recorded.” only if they’re put through to you. Your state’s rules, your call." />
        </Group>

        <Group title="Where and what you work on">
          <Field label="Cities and ZIP codes" hint="A city with its state (“Sarasota FL”) or a 5-digit ZIP. No guessed radius."><Textarea rows={2} placeholder="Sarasota FL, 34236" className="bg-card text-[16px] lg:text-sm" {...bind("serviceAreaTerms")} /></Field>
          <Field label="Services you offer"><Textarea rows={2} className="bg-card text-[16px] lg:text-sm" {...bind("serviceCategories")} /></Field>
        </Group>

        <Group title="Appointments">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="First appointment"><Input type="time" className={fieldClass} {...bind("bookableWeekdayStart")} /></Field>
            <Field label="Last one ends by"><Input type="time" className={fieldClass} {...bind("bookableWeekdayEnd")} /></Field>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Job length">
              <select className={selectClass} {...bind("defaultServiceDurationMinutes")}>{unique([30, 45, 60, 90, 120, 180, 240, Number(text("defaultServiceDurationMinutes"))]).map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} min` : `${minutes / 60} hr${minutes === 60 ? "" : "s"}`}</option>)}</select>
            </Field>
            <Field label="Notice needed">
              <select className={selectClass} {...bind("minimumLeadTimeMinutes")}>
                {([[0, "No minimum"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [1440, "Next day"], [2880, "2 days"]] as Array<[number, string]>).concat([[0, "No minimum"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [1440, "Next day"], [2880, "2 days"]].some(([value]) => value === Number(text("minimumLeadTimeMinutes"))) ? [] : [[Number(text("minimumLeadTimeMinutes")), `${text("minimumLeadTimeMinutes")} minutes`]]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          </div>
          <Toggle id="bookableWeekends" label="Offer weekend appointments" checked={flag("bookableWeekends")} onChange={(value) => set("bookableWeekends", value)} />
          {i.directBookingAvailable ? (
            <Field label="Booking"><select className={selectClass} {...bind("bookingMode")}><option value="confirm">Take the details; I’ll confirm</option><option value="direct">Book open times on my calendar</option></select></Field>
          ) : <p className="text-[13px] text-muted-foreground">Front Office takes the time the caller wants. You confirm it.</p>}
          <Toggle id="requireDiagnosticFeeAcceptance" label="Caller must accept your service-call fee" checked={flag("requireDiagnosticFeeAcceptance")} onChange={(value) => set("requireDiagnosticFeeAcceptance", value)} />
        </Group>

        <Group title="What callers can be told" description="Leave blank and Front Office won’t quote a price; it takes a message.">
          <Field label="Prices" hint="One per line, “Name: exact wording”"><Textarea rows={3} placeholder="Service call: Our service call is $89." className="bg-card text-[16px] lg:text-sm" {...bind("priceSnippets")} /></Field>
          <Field label="Answers" hint="One per line, “Topic: exact wording”"><Textarea rows={3} placeholder="Brands: We service all major brands." className="bg-card text-[16px] lg:text-sm" {...bind("approvedKnowledge")} /></Field>
        </Group>

        <Group title="Alerts to your phone">
          <Field label="Mobile number" hint="Emergencies and “call me back” requests are always texted here.">
            <Input type="tel" inputMode="tel" autoComplete="tel" className={fieldClass} placeholder={i.ownerPhoneConfigured ? "Saved. Enter a new number to replace it" : "+1 941 555 0100"} {...bind("ownerPhone")} />
          </Field>
          <Toggle id="ownerDailySmsEnabled" label={<>Daily text recap <em className="ml-1 not-italic text-brand-ink/70">+$5/mo</em></>} hint="Follow-ups and appointments, once each morning." checked={flag("ownerDailySmsEnabled")} disabled={!i.dailySmsAvailable} onChange={(value) => set("ownerDailySmsEnabled", value)} extra={i.dailySmsAvailable ? undefined : <span className="text-[13px] text-amber-700">Not available yet.</span>} />
          <Field label="Recap time">
            <select className={selectClass} {...bind("ownerDailySmsHour")}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, hour)))}</option>)}</select>
          </Field>
          <Toggle id="ownerRealtimeSmsEnabled" label={<>Instant lead texts <em className="ml-1 not-italic text-brand-ink/70">+$10/mo</em></>} hint="Every routine new lead the moment the call ends." checked={flag("ownerRealtimeSmsEnabled")} disabled={!i.realtimeSmsAvailable} onChange={(value) => set("ownerRealtimeSmsEnabled", value)} extra={i.realtimeSmsAvailable ? undefined : <span className="text-[13px] text-amber-700">Not available yet.</span>} />
          <Toggle id="ownerWeeklyEmailEnabled" label={<>Sunday week-ahead email <em className="ml-1 not-italic text-brand-ink/70">Included</em></>} hint="Open callbacks and the next seven days." checked={flag("ownerWeeklyEmailEnabled")} disabled={!i.weeklyEmailAvailable} onChange={(value) => set("ownerWeeklyEmailEnabled", value)} extra={i.weeklyEmailAvailable ? undefined : <span className="text-[13px] text-amber-700">Not available yet.</span>} />
          <Field label="Minutes alert" hint={`We’ll tell you once when you reach this share of your ${plan.includedMinutes} minutes, and again if you use them all.`}>
            <select className={selectClass} {...bind("usageAlertPercent")}>
              {EASY_ALERT_PERCENTS.map((percent) => <option key={percent} value={percent}>When I’ve used {percent}%</option>)}
              <optgroup label="Other">
                {unique([...OTHER_ALERT_PERCENTS, Number(text("usageAlertPercent"))]).filter((percent) => percent >= 50 && percent <= 95 && !EASY_ALERT_PERCENTS.includes(percent)).map((percent) => <option key={percent} value={percent}>When I’ve used {percent}%</option>)}
              </optgroup>
            </select>
          </Field>
        </Group>

        <Card>
          <CardContent>
            <details>
              <summary className="flex min-h-10 cursor-pointer items-center text-base font-semibold">Advanced</summary>
              <div className="mt-4 grid gap-4">
                <Field label="Extra emergency words" hint="Comma separated"><Textarea rows={2} className="bg-card text-[16px] lg:text-sm" {...bind("emergencyKeywords")} /></Field>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Emergency sensitivity">
                    <select className={selectClass} value={String(([0.5, 0.6, 0.7, 0.8, 0.9].find((value) => Math.abs(value - Number(text("emergencyThreshold"))) < 0.001)) ?? text("emergencyThreshold"))} onChange={(event) => set("emergencyThreshold", event.target.value)}>
                      {([[0.5, "Most cautious"], [0.6, "Cautious"], [0.7, "Balanced"], [0.8, "Strict"], [0.9, "Strictest"]] as Array<[number, string]>).map(([value, label]) => <option key={value} value={String(value)}>{label}</option>)}
                    </select>
                  </Field>
                  <Field label="Calls per number per day">
                    <select className={selectClass} {...bind("maxCallsPerCallerPerDay")}>{unique([1, 2, 3, 5, 8, 10, 20, Number(text("maxCallsPerCallerPerDay"))]).map((value) => <option key={value} value={value}>{value}</option>)}</select>
                  </Field>
                </div>
                <Field label="Say these words like this" hint="One per line, “Word: sounds like”"><Textarea rows={2} className="bg-card text-[16px] lg:text-sm" {...bind("pronunciations")} /></Field>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Keep call records for">
                    <select className={selectClass} {...bind("dataRetentionDays")}>{unique([30, 60, 90, 180, 365, Number(text("dataRetentionDays"))]).map((days) => <option key={days} value={days}>{days} days</option>)}</select>
                  </Field>
                  <Field label="Support email for your callers"><Input type="email" className={fieldClass} {...bind("supportEmail")} /></Field>
                </div>
              </div>
            </details>
          </CardContent>
        </Card>

        <div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] z-10 -mx-1 bg-gradient-to-t from-background via-background/95 to-transparent px-1 pt-4 pb-2 lg:bottom-0">
          <Button size="tap" type="submit" className={cn(tapWidth, "shadow-md")} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
        </div>
      </form>

      <aside className="grid gap-4 lg:sticky lg:top-20">
        <Card>
          <CardHeader><CardTitle className="text-base">Calendar</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            {i.googleConnected ? (
              <>
                <p className="flex items-center gap-2 font-semibold text-emerald-700"><CheckCircle2 className="size-4" />Google Calendar connected</p>
                <Button size="tap" variant="outline" asChild><a href="/app/integrations/google/start">Reconnect</a></Button>
              </>
            ) : i.googleAvailable ? (
              <>
                <p className="text-sm">Connect the calendar your jobs live on so Front Office can offer real open times.</p>
                <Button size="tap" variant="brand" asChild><a href="/app/integrations/google/start">Connect Google Calendar</a></Button>
              </>
            ) : <p className="text-sm text-muted-foreground">Calendar connection isn’t available yet.</p>}
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden">
          <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-brand-yellow" />
          <CardHeader><CardTitle className="text-base">Plan</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-sm"><strong className="text-2xl font-semibold tracking-tight">${Math.round(plan.flatMonthlyPriceCents / 100)}</strong>/month · {plan.includedMinutes} minutes · ${(plan.overageCentsPerMinute / 100).toFixed(2)}/min after</p>
            <form method="post" action={plan.paid ? "/app/billing/portal" : "/app/billing/checkout"}>
              <input type="hidden" name="csrf" value={csrf} />
              <Button size="tap" variant={plan.paid ? "outline" : "brand"} className={tapWidth}>{plan.paid ? "Manage billing or cancel" : "Start your plan"}</Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Team</CardTitle></CardHeader>
          <CardContent><Button size="tap" variant="outline" className={tapWidth} asChild><a href="/app/team"><Users />Teammates &amp; calendars</a></Button></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Your data</CardTitle></CardHeader>
          <CardContent className="grid gap-2.5">
            <Button size="tap" variant="outline" asChild><a href="/app/account/export"><Download />Download everything</a></Button>
            <form method="post" action="/app/account/sign-out-everywhere">
              <input type="hidden" name="csrf" value={csrf} />
              <Button size="tap" variant="outline" className={tapWidth}>Sign out on every device</Button>
            </form>
            <Button variant="link" className="h-10 w-fit px-0" asChild><a href="/logout"><LogOut />Sign out</a></Button>
            <details>
              <summary className="flex min-h-10 cursor-pointer items-center font-semibold text-red-700">Delete your account</summary>
              <form method="post" action="/app/account/delete" className="mt-3 grid gap-3">
                <input type="hidden" name="csrf" value={csrf} />
                <p className="text-sm text-muted-foreground">Cancel your plan first. This disconnects your line and permanently deletes every call record, transcript, recording, task and setting. Appointments on your calendar stay there.</p>
                <Field label="Type DELETE to confirm"><Input name="confirm" autoComplete="off" required className={fieldClass} /></Field>
                <Field label="Your password"><Input name="password" type="password" autoComplete="current-password" required className={fieldClass} /></Field>
                <Button size="tap" className="bg-red-600 text-white hover:bg-red-700">Delete my account</Button>
              </form>
            </details>
          </CardContent>
        </Card>
        <p className="px-1 text-xs text-muted-foreground"><Link to="/app">Back to Today</Link></p>
      </aside>
    </div>
  )
}
