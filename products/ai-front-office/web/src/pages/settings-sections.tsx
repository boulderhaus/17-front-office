import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { Check, CheckCircle2, ChevronDown, ChevronRight, Download, Loader2, LogOut, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { CallAlertsCard } from "@/components/app/call-alerts"
import { cents, monthlyOf, PlanCards, PriceSummary, shortDay, UnlimitedAddOn } from "@/components/app/plan-picker"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { api, ApiError } from "@/lib/api"
import { money, perCall } from "@/lib/format"
import { useMode } from "@/lib/mode"
import type { ApiPlan, BillingQuote, BillingSummary, PlanId } from "@/lib/types"
import { ringChoicesWith, VERIZON_RING_LINE } from "@/lib/dial"
import { pauseHint } from "@/lib/pause-hint"
import { recordingHint } from "@/lib/recording-hint"
import { emergencyChoicesFor, joinEmergencies, joinServices, otherServicesProblem, splitEmergencies, splitServices, type Picks } from "@/lib/settings-picks"
import { SMS_CONSENT_END, SMS_CONSENT_JOIN, SMS_CONSENT_LEAD, SMS_CONSENT_PRIVACY, SMS_CONSENT_TERMS } from "@/lib/sms-consent"
import { forwardingOn } from "@/lib/line-status"
import type { ApiSettings } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useSettings } from "./settings"

const ZONES: Array<[string, string]> = [["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona"], ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"]]
/** Fields read easily (DESIGN): 17px, weight 500, dark ink on white, 48px tall, a solid ink focus edge. The arrow sits inside (see NativeSelect). */
const selectClass = "h-12 w-full min-w-0 appearance-none truncate rounded-lg border border-input bg-card pr-10 pl-3 text-[17px] font-medium text-foreground outline-none focus-visible:border-brand-ink focus-visible:ring-[3px] focus-visible:ring-brand-ink/20"
const fieldClass = "h-12 bg-card"
const areaClass = "bg-card"
/** Card actions: full width on a phone; on a computer every button in a card is the same width, left-aligned. */
const actionClass = "w-full sm:w-60"
// The server accepts any whole percent from 50 to 95; 75 (the default) and 90 are the easy picks.
const EASY_ALERT_PERCENTS = [75, 90]
const OTHER_ALERT_PERCENTS = [50, 55, 60, 65, 70, 80, 85, 95]
const unique = (list: number[]) => list.filter((value, index, all) => all.indexOf(value) === index).sort((left, right) => left - right)

/**
 * One topic: a heading, one grey line, then plain rows. Topics sit one under another on dividers (the page draws
 * them), never as boxes inside boxes.
 */
export function SettingsCard({ title, description, children, danger, id, action }: { title: string; description?: ReactNode; children?: ReactNode; danger?: boolean; id?: string; action?: ReactNode }) {
  return (
    <section id={id} className="grid scroll-mt-24 content-start gap-4 py-6 first:pt-2 lg:first:pt-6">
      <header className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <h3 className={cn("text-[17px] font-semibold text-balance", danger && "text-red-700")}>{title}</h3>
          {description && <p className="text-[15px] text-muted-foreground text-pretty">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

function Field({ label, hint, children, className, error }: { label: string; hint?: ReactNode; children: ReactNode; className?: string; error?: string | null }) {
  return (
    <label className={cn("grid min-w-0 gap-1.5", className)}>
      <span className="text-[15px] font-medium">{label}</span>
      {children}
      {error ? <span role="alert" className="text-sm font-medium text-red-700">{error}</span> : hint && <span className="text-sm text-muted-foreground text-pretty">{hint}</span>}
    </label>
  )
}

/** A native select (the phone's own picker) with its arrow inside the box, at the usual padding. */
function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <span className="relative block min-w-0">
      <select className={cn(selectClass, className)} {...props}>{children}</select>
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 size-5 -translate-y-1/2 text-muted-foreground" />
    </span>
  )
}

/** "Saved" for a control that saves on its own: shows for two seconds after each save, beside the control. */
function useSavedMark(): [ReactNode, () => void] {
  const [shown, setShown] = useState(0)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const flash = () => {
    setShown(Date.now())
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setShown(0), 2200)
  }
  const mark = <span role="status" aria-live="polite" className={cn("inline-flex items-center gap-1 text-sm font-semibold text-emerald-800 transition-opacity duration-200", shown ? "opacity-100" : "opacity-0")}>{shown ? <><Check className="size-4" />Saved</> : null}</span>
  return [mark, flash]
}

/** A switch on the right, its label and one line of help on the left. */
function ToggleRow({ id, label, hint, checked, onChange, disabled, saved }: { id: string; label: string; hint?: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; saved?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <Label htmlFor={id} className="grid min-w-0 gap-0.5 leading-normal font-normal">
        <span className="text-[15px] font-medium text-balance">{label}</span>
        {hint && <span className="text-sm text-muted-foreground text-pretty">{hint}</span>}
      </Label>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
        {saved}
      </span>
    </div>
  )
}

function Pair({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>
}

/** Tick boxes in a grid, each a full 44px row to tap. */
function TickGrid({ legend, options, picked, onChange, children }: { legend: string; options: Array<{ key: string; label: string }>; picked: string[]; onChange: (picked: string[]) => void; children?: ReactNode }) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1.5 text-[15px] font-medium">{legend}</legend>
      <div className="grid gap-x-4 sm:grid-cols-2">
        {options.map((option) => (
          <label key={option.key} className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
            <Checkbox className="size-5 bg-card" checked={picked.includes(option.key)} onCheckedChange={(on) => onChange(on === true ? [...picked, option.key] : picked.filter((key) => key !== option.key))} />
            <span>{option.label}</span>
          </label>
        ))}
        {children}
      </div>
    </fieldset>
  )
}

/**
 * Boxes plus "Other" over one stored comma list. The Other text is kept as typed while the owner types (the stored
 * list drops a trailing comma), and reset whenever the stored list changes from outside (save, discard).
 */
function usePicks(value: string, split: (value: string) => Picks, join: (picks: Picks) => string, onChange: (value: string) => void) {
  const parsed = split(value)
  const [otherText, setOtherText] = useState(parsed.other)
  const [otherOpen, setOtherOpen] = useState(parsed.other !== "")
  useEffect(() => {
    const now = split(value)
    const typed = otherText.split(",").map((item) => item.trim()).filter(Boolean).join(", ")
    if (typed !== now.other) setOtherText(now.other)
    if (now.other !== "") setOtherOpen(true)
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return {
    picked: parsed.picked,
    otherText,
    otherOpen,
    setPicked: (picked: string[]) => onChange(join({ ...parsed, picked, other: otherText })),
    setOther: (text: string) => { setOtherText(text); onChange(join({ ...parsed, other: text })) },
    setOtherOpen: (open: boolean) => { setOtherOpen(open); if (!open) { setOtherText(""); onChange(join({ ...parsed, other: "" })) } },
  }
}

/* ---------------------------------------------------------------- Business details */

export function BusinessSection() {
  const { text, flag, set, bind, settings } = useSettings()
  const zones = ZONES.some(([zone]) => zone === text("timezone")) ? ZONES : [[text("timezone"), text("timezone")] as [string, string], ...ZONES]
  // Renamed the business while the greeting still says the old name: offer to change it there too, in one tap.
  const savedName = String(settings.values.businessName ?? "").trim()
  const newName = text("businessName").trim()
  const staleGreeting = savedName.length > 1 && newName.length > 1 && newName !== savedName && text("greeting").includes(savedName)
  // Only a whole state ("FL") so far: offer the owner's own area, from their mobile's area code.
  const suggestion = settings.areaSuggestion && /^\s*[A-Za-z]{2}(\s*,\s*[A-Za-z]{2})*\s*$/.test(text("serviceAreaTerms")) ? settings.areaSuggestion : null
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
          <Field label="Time zone"><NativeSelect {...bind("timezone")}>{zones.map(([zone, label]) => <option key={zone} value={zone}>{label}</option>)}</NativeSelect></Field>
          <Field label="Email callers can write to"><Input type="email" className={fieldClass} placeholder="office@yourshop.com" spellCheck={false} autoCapitalize="none" {...bind("supportEmail")} /></Field>
        </Pair>
        <Field label="What Otto says when it picks up"><Textarea required rows={2} className={areaClass} {...bind("greeting")} /></Field>
      </SettingsCard>
      <SettingsCard title="Recording notice">
        <ToggleRow id="recordingNotice" label="Play a recording notice when a call is put through to you" checked={flag("recordingNotice")} onChange={(value) => set("recordingNotice", value)}
          hint={recordingHint(flag("recordingNotice"), text("serviceAreaTerms"))} />
      </SettingsCard>
      <SettingsCard title="Where you work" description="Otto checks each caller’s address against this list.">
        <Field label="Cities and ZIP codes" hint="A city with its state, like “Sarasota FL”, or a 5-digit ZIP."><Textarea rows={2} placeholder="Sarasota FL, 34236" className={areaClass} {...bind("serviceAreaTerms")} /></Field>
        {suggestion && (
          <div role="status" className="grid gap-2 rounded-lg bg-accent px-3 py-2.5 text-[15px] text-accent-foreground sm:flex sm:items-center sm:justify-between sm:gap-4">
            <span>Your area, from your phone number: <strong className="font-semibold">{suggestion}</strong></span>
            <Button type="button" size="tap" variant="outline" className="bg-card" onClick={() => set("serviceAreaTerms", suggestion)}>Use these</Button>
          </div>
        )}
      </SettingsCard>
      <ServicesPicker />
      <SettingsCard title="Names and words" description="Help Otto say your street names and brands right.">
        <Field label="Say these words like this" hint="One per line, like “Myakka: my-AK-uh”."><Textarea rows={2} className={areaClass} {...bind("pronunciations")} /></Field>
      </SettingsCard>
    </>
  )
}

/** "What you fix": the trades on the website as tick boxes, plus Other with a short text box. */
function ServicesPicker() {
  const { text, set, settings } = useSettings()
  const trades = settings.catalog?.trades ?? []
  const picks = usePicks(text("serviceCategories"), (value) => splitServices(value, trades), (value) => joinServices(value, trades), (value) => set("serviceCategories", value))
  const problem = picks.otherOpen ? otherServicesProblem(picks.otherText) : null
  const nothing = picks.picked.length === 0 && !picks.otherText.trim()
  return (
    <SettingsCard title="What you fix" description="Otto takes calls for these and offers times for them.">
      <TickGrid legend="Pick all that apply" options={trades} picked={picks.picked} onChange={picks.setPicked}>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
          <Checkbox className="size-5 bg-card" checked={picks.otherOpen} onCheckedChange={(on) => picks.setOtherOpen(on === true)} />
          <span>Other</span>
        </label>
      </TickGrid>
      {picks.otherOpen && (
        <Field label="Other services" hint="Separate with commas, like “Pool repair, Septic”." error={problem}>
          <Input className={fieldClass} value={picks.otherText} onChange={(event) => picks.setOther(event.target.value)} aria-invalid={problem ? true : undefined} placeholder="Pool repair" />
        </Field>
      )}
      {nothing && <p role="alert" className="text-sm font-medium text-red-700">Pick at least one, so Otto knows which calls are yours.</p>}
    </SettingsCard>
  )
}

/* ---------------------------------------------------------------- How calls are answered */

// The same names as setup.
const MODES: Array<[string, string, string]> = [
  ["always", "Otto answers every call", "Your phone won’t ring for these."],
  ["overflow", "Ring my phone first", "Otto takes the calls you miss."],
]
// How sure Otto must be about anything not ticked. Saved values in between show as the nearest choice.
const URGENCY: Array<[number, string, string]> = [
  [0.5, "Anything that might be urgent", "More alerts. Some turn out to be routine."],
  [0.7, "Likely emergencies", "Otto’s best judgment. Most shops pick this."],
  [0.9, "Only sure emergencies", "Fewest alerts."],
]
const urgencyChoice = (value: number) => (value < 0.6 ? 0.5 : value <= 0.8 ? 0.7 : 0.9)

export function AnsweringSection() {
  const { text, set, settings } = useSettings()
  const { dashboard } = useMode()
  // Said when they pick Paused, and only when every call may go to Otto (the saved choice or the last passed test).
  const business = dashboard?.line.business
  const paused = text("serviceState") === "paused"
  const hint = pauseHint({ active: settings.status === "active", paused, mayForwardAll: Boolean(business?.mayForwardAll), off: business?.plan?.off })
  // Two ways calls work. A shop saved as "after hours" works like ring first today (forwarding sends Otto only the
  // calls nobody picks up, at any hour), so it shows as Ring my phone first.
  const everyCall = text("operationMode") === "always"
  const mode = everyCall ? "always" : "overflow"
  const forwarding = dashboard?.line.number ? (forwardingOn(dashboard.line) ? (dashboard.line.business.update ? "Dial your new code" : "Works") : "Not on yet") : null
  return (
    <>
      <SettingsCard title="Answering">
        <ToggleRow id="serviceState" label="Otto answers calls" checked={!paused} onChange={(on) => set("serviceState", on ? "active" : "paused")}
          hint={hint ?? (paused ? "Paused. Otto isn’t taking calls." : "Turn off to pause Otto.")} />
        <div className="border-t pt-4"><fieldset className="grid gap-2">
          <legend className="mb-1.5 text-[15px] font-medium">When customers call</legend>
          <RadioGroup value={mode} onValueChange={(value) => set("operationMode", value === "overflow" && text("operationMode") === "after_hours" ? "after_hours" : value)} className="gap-1">
            {MODES.map(([value, label, line]) => (
              <label key={value} className="flex min-h-11 cursor-pointer items-start gap-3 py-1.5">
                <RadioGroupItem value={value} className="mt-0.5 size-5 bg-card" />
                <span className="grid gap-0.5"><span className="text-[15px] font-medium">{label}</span><span className="text-sm text-muted-foreground">{line}</span></span>
              </label>
            ))}
          </RadioGroup>
        </fieldset></div>
        {/* Ring time only matters when the phone rings first. */}
        {!everyCall && <div className="sm:max-w-80"><RingFirstField rings={Number(text("answerAfterRings"))} onChange={(value) => set("answerAfterRings", value)} family={dashboard?.line.business.carrier?.family ?? null} confirmed={Boolean(dashboard?.line.confirmedAt)} /></div>}
        {dashboard?.line.business.update && (
          <p className="rounded-md border border-brand-ink/15 bg-accent px-3 py-2.5 text-sm text-accent-foreground" role="status">
            Dial your new code once to apply this. <Link className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4" to="/app/start?step=forward&from=settings">Show me the code</Link>
          </p>
        )}
        {forwarding && (
          <Link to="/app/start?step=forward&from=settings" className="group flex min-h-12 items-center justify-between gap-3 border-t pt-3 text-[15px]">
            <span className="grid"><strong className="font-semibold group-hover:underline">Call forwarding</strong><span className="text-sm text-muted-foreground">{forwarding}. See, test or turn off the code.</span></span>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
          </Link>
        )}
      </SettingsCard>
      <EmergenciesSection />
    </>
  )
}

function EmergenciesSection() {
  const { text, set, settings } = useSettings()
  const catalog = settings.catalog
  const choices = catalog?.emergencies ?? []
  const alwaysOn = catalog?.alwaysOnWords ?? []
  const picks = usePicks(text("emergencyKeywords"), (value) => splitEmergencies(value, choices, alwaysOn), (value) => joinEmergencies(value, choices), (value) => set("emergencyKeywords", value))
  const trades = splitServices(text("serviceCategories"), catalog?.trades ?? []).picked
  const shown = emergencyChoicesFor(choices, trades, picks.picked)
  const level = urgencyChoice(Number(text("emergencyThreshold")))
  return (
    <SettingsCard title="Emergencies" description="Otto puts these calls at the top of Calls and alerts you right away.">
      <TickGrid legend="What counts as an emergency" options={shown} picked={picks.picked} onChange={picks.setPicked}>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
          <Checkbox className="size-5 bg-card" checked={picks.otherOpen} onCheckedChange={(on) => picks.setOtherOpen(on === true)} />
          <span>Other</span>
        </label>
      </TickGrid>
      {picks.otherOpen && (
        <Field label="Other emergency words" hint="Words a caller would say, like “basement flooding”. Separate with commas.">
          <Input className={fieldClass} value={picks.otherText} onChange={(event) => picks.setOther(event.target.value)} placeholder="basement flooding" />
        </Field>
      )}
      {catalog?.alwaysOnLine && <p className="text-sm text-muted-foreground">{catalog.alwaysOnLine}</p>}
      <div className="border-t pt-4"><fieldset className="grid gap-2">
        <legend className="mb-1.5 text-[15px] font-medium">For everything else, flag</legend>
        <RadioGroup value={String(level)} onValueChange={(value) => set("emergencyThreshold", value)} className="gap-1">
          {URGENCY.map(([value, label, line]) => (
            <label key={value} className="flex min-h-11 cursor-pointer items-start gap-3 py-1.5">
              <RadioGroupItem value={String(value)} className="mt-0.5 size-5 bg-card" />
              <span className="grid gap-0.5"><span className="text-[15px] font-medium">{label}</span><span className="text-sm text-muted-foreground">{line}</span></span>
            </label>
          ))}
        </RadioGroup>
      </fieldset></div>
      <Link className="group flex min-h-12 items-center justify-between gap-3 border-t pt-3 text-[15px]" to="/app/settings/alerts">
        <span className="grid"><strong className="font-semibold group-hover:underline">Want a phone call too?</strong><span className="text-sm text-muted-foreground">Turn on emergency calls in Alerts.</span></span>
        <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
      </Link>
    </SettingsCard>
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
        <NativeSelect className="disabled:cursor-not-allowed disabled:opacity-70" disabled value="verizon" onChange={() => undefined}><option value="verizon">About 30 seconds (Verizon)</option></NativeSelect>
      ) : (
        <NativeSelect name="answerAfterRings" value={String(choices.find((choice) => choice.rings === rings)?.rings ?? 2)} onChange={(event) => onChange(event.target.value)}>
          {choices.map((choice) => <option key={choice.rings} value={String(choice.rings)}>{choice.label}</option>)}
        </NativeSelect>
      )}
    </Field>
  )
}

/* ---------------------------------------------------------------- Your prices and answers */

/** Lines of "Name: words" as rows of two boxes, with Add and Remove. Empty rows are kept while editing. */
function PairList({ name, columns, placeholders, addLabel }: { name: string; columns: [string, string]; placeholders: [string, string]; addLabel: string }) {
  const { text, set } = useSettings()
  const parse = (value: string): Array<[string, string]> => value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [first = "", ...rest] = line.split(":")
    return [first.trim(), rest.join(":").trim()]
  })
  const stored = text(name)
  const [rows, setRows] = useState<Array<[string, string]>>(() => { const list = parse(stored); return list.length ? list : [["", ""]] })
  const serialize = (list: Array<[string, string]>) => list.filter(([left, right]) => left.trim() || right.trim()).map(([left, right]) => `${left.trim()}: ${right.trim()}`).join("\n")
  // Saved or discarded from outside: show what's stored.
  useEffect(() => { if (serialize(rows) !== stored) { const list = parse(stored); setRows(list.length ? list : [["", ""]]) } }, [stored]) // eslint-disable-line react-hooks/exhaustive-deps
  const update = (next: Array<[string, string]>) => { setRows(next); set(name, serialize(next)) }
  return (
    <div className="grid gap-3">
      <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2.75rem] gap-3 text-[15px] font-medium sm:grid">
        <span>{columns[0]}</span><span>{columns[1]}</span><span />
      </div>
      {rows.map(([left, right], index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_2.75rem] gap-x-3 gap-y-2 border-b pb-3 last:border-b-0 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2.75rem] sm:border-b-0 sm:pb-0">
          <Input aria-label={columns[0]} className={cn(fieldClass, "col-start-1 row-start-1")} placeholder={index === 0 ? placeholders[0] : undefined} value={left} onChange={(event) => update(rows.map((row, at) => (at === index ? [event.target.value.replace(/:/g, ""), row[1]] : row)))} />
          <Input aria-label={columns[1]} className={cn(fieldClass, "col-span-2 col-start-1 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1")} placeholder={index === 0 ? placeholders[1] : undefined} value={right} onChange={(event) => update(rows.map((row, at) => (at === index ? [row[0], event.target.value] : row)))} />
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${left || "this row"}`} className="col-start-2 row-start-1 size-11 text-muted-foreground sm:col-start-3" onClick={() => update(rows.length > 1 ? rows.filter((_, at) => at !== index) : [["", ""]])}><X className="size-5" /></Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="tap" className={actionClass} onClick={() => setRows([...rows, ["", ""]])}><Plus />{addLabel}</Button>
    </div>
  )
}

export function AnswersSection() {
  return (
    <>
      <SettingsCard title="Your prices" description="What you charge your customers. Otto says these word for word.">
        <PairList name="priceSnippets" columns={["Service", "Price"]} placeholders={["Service call", "$89"]} addLabel="Add a price" />
      </SettingsCard>
      <SettingsCard title="Your answers" description="Questions callers ask, and what Otto should say. Anything not here, Otto takes a message.">
        <PairList name="approvedKnowledge" columns={["Question", "Answer"]} placeholders={["Brands", "We service all major brands."]} addLabel="Add an answer" />
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
  const [textsSaved, flashTextsSaved] = useSavedMark()
  const [urgentSaved, flashUrgentSaved] = useSavedMark()
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
      flashTextsSaved()
      toast.success(on ? (result.texts.live ? "Text alerts are on." : "Saved. Texts start as soon as texting turns on.") : "Text alerts are off.")
    } catch (error) {
      setTexts(before)
      setTextsError(error instanceof Error ? error.message : "That didn’t change. Please try again.")
    } finally {
      setTextsBusy(false)
    }
  }
  // The text switches work once the owner ticked the box; before texting turns on, their picks wait.
  const switchHint = (on: string) => (!texts.on ? "Tick the box above first." : on)
  const urgent = settings.urgentCalls
  return (
    <>
      <CallAlertsCard className="p-4 md:p-5" />
      <SettingsCard title="Your mobile">
        {mobile && !editingMobile ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-0.5">
              <span className="text-[15px] font-medium">Mobile number</span>
              <strong className="tabular text-[17px] font-semibold">{mobile}</strong>
              <span className="text-sm text-muted-foreground">Emergency calls and texts come here.</span>
            </div>
            <Button type="button" size="tap" variant="outline" onClick={() => { setEditingMobile(true); requestAnimationFrame(() => document.getElementById("owner-phone")?.focus()) }}>Change</Button>
          </div>
        ) : (
          <Field label="Mobile number" hint="Emergency calls and texts come here.">
            <Input id="owner-phone" type="tel" inputMode="tel" autoComplete="tel" className={fieldClass} placeholder="(555) 555-0100" {...bind("ownerPhone")} />
          </Field>
        )}
        {mobile && editingMobile && <button type="button" className="-mt-2 inline-flex min-h-11 w-fit items-center text-sm font-semibold underline underline-offset-4" onClick={() => { set("ownerPhone", ""); setEditingMobile(false) }}>Keep {mobile}</button>}
      </SettingsCard>
      {urgent?.available && (
        <SettingsCard title="Emergency calls">
          <ToggleRow id="urgentCalls" label="Call me about emergencies" checked={urgent.on} disabled={urgentBusy} saved={urgentSaved}
            hint={<>
              {urgent.disclosure}
              {/* The mobile is the business number and may send every call to Otto: Otto can't ring it, so it says why. */}
              {urgent.on && urgent.held && <span className="mt-1 block font-medium text-amber-900">Otto can’t ring this number while it sends every call to Otto. You still get an alert and an email.</span>}
            </>}
            onChange={(on) => void toggleUrgentCalls(on).then(flashUrgentSaved)} />
        </SettingsCard>
      )}
      <SettingsCard id="texts" title="Texts" action={textsSaved}>
        {/* The consent box: its words are carrier-reviewed and never change (see lib/sms-consent). */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
          <input id="sms-consent" type="checkbox" checked={texts.on} disabled={textsBusy} aria-describedby={textsError ? "sms-consent-error" : undefined} onChange={(event) => void toggleTexts(event.target.checked)} className="mt-0.5 size-5 cursor-pointer accent-brand-ink disabled:cursor-wait" />
          <label htmlFor="sms-consent" className="block cursor-pointer text-sm leading-normal text-muted-foreground"><span className="font-medium text-foreground">{SMS_CONSENT_LEAD.split(".")[0]}.</span>{SMS_CONSENT_LEAD.slice(SMS_CONSENT_LEAD.indexOf(".") + 1)}<a className="font-semibold text-foreground underline underline-offset-4" href={SMS_CONSENT_TERMS.href}>{SMS_CONSENT_TERMS.label}</a>{SMS_CONSENT_JOIN}<a className="font-semibold text-foreground underline underline-offset-4" href={SMS_CONSENT_PRIVACY.href}>{SMS_CONSENT_PRIVACY.label}</a>{SMS_CONSENT_END}</label>
        </div>
        {textsBusy && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 motion-safe:animate-spin" />Saving…</p>}
        {textsError && <p id="sms-consent-error" role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">{textsError}</p>}
        {!texts.live && texts.on && <p className="rounded-md bg-accent px-3 py-2.5 text-sm text-accent-foreground">Texting turns on soon. Your picks below are saved and start then.</p>}
        <ToggleRow id="ownerRealtimeSmsEnabled" label="A text for every new lead" hint={switchHint("Sent the moment the call ends.")} checked={texts.on && flag("ownerRealtimeSmsEnabled")} disabled={!texts.on} onChange={(value) => set("ownerRealtimeSmsEnabled", value)} />
        <ToggleRow id="ownerDailySmsEnabled" label="Morning recap" hint={switchHint("Follow-ups and appointments, once a day.")} checked={texts.on && flag("ownerDailySmsEnabled")} disabled={!texts.on} onChange={(value) => set("ownerDailySmsEnabled", value)} />
        {texts.on && flag("ownerDailySmsEnabled") && (
          <Field label="Recap time" className="sm:max-w-60">
            <NativeSelect {...bind("ownerDailySmsHour")}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, hour)))}</option>)}</NativeSelect>
          </Field>
        )}
        {/* Shown only once email can actually be sent: never a switch that says "not available". */}
        {i.weeklyEmailAvailable && <ToggleRow id="ownerWeeklyEmailEnabled" label="Sunday email" hint="Open callbacks and the week ahead." checked={flag("ownerWeeklyEmailEnabled")} onChange={(value) => set("ownerWeeklyEmailEnabled", value)} />}
      </SettingsCard>
      <SettingsCard title="Running low on calls" description={settings.plan.unlimited && settings.plan.unlimitedOffer ? `One alert when you reach this share of your ${settings.plan.unlimitedOffer.fairUseCalls.toLocaleString("en-US")} fair-use calls, and one if you use them all.` : `One alert when you reach this share of your ${settings.plan.includedCalls} calls, and one if you use them all.`}>
        <Field label="Alert me" className="sm:max-w-60">
          <NativeSelect {...bind("usageAlertPercent")}>
            {EASY_ALERT_PERCENTS.map((percent) => <option key={percent} value={percent}>At {percent}% used</option>)}
            <optgroup label="Other">
              {unique([...OTHER_ALERT_PERCENTS, Number(text("usageAlertPercent"))]).filter((percent) => percent >= 50 && percent <= 95 && !EASY_ALERT_PERCENTS.includes(percent)).map((percent) => <option key={percent} value={percent}>At {percent}% used</option>)}
            </optgroup>
          </NativeSelect>
        </Field>
      </SettingsCard>
    </>
  )
}

/* ---------------------------------------------------------------- Calendar */

/** Half-hour times, 5 AM to 11 PM, plus a saved time off the grid. */
function timeChoices(current: string): Array<[string, string]> {
  const values = Array.from({ length: 37 }, (_, index) => { const minutes = 300 + index * 30; return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` })
  if (/^\d{2}:\d{2}$/.test(current) && !values.includes(current)) values.push(current)
  return values.sort().map((value) => {
    const [hours, minutes] = value.split(":").map(Number) as [number, number]
    return [value, new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, hours, minutes)))]
  })
}

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
          <div className="grid gap-1">
            <p className="flex items-center gap-2 text-[17px] font-semibold text-emerald-800"><CheckCircle2 className="size-5 shrink-0" />Connected</p>
            <p className="text-[15px] text-muted-foreground">Otto checks when you’re busy, and confirmed jobs go on your calendar.</p>
            <p className="flex flex-wrap items-center gap-x-5 text-sm">
              <a className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4" href="/app/integrations/google/start">Reconnect</a>
              <a className="inline-flex min-h-11 items-center text-muted-foreground underline underline-offset-4" href="/privacy#google-calendar">How Otto uses your calendar</a>
            </p>
          </div>
        ) : i.googleAvailable ? (
          <>
            <p className="text-[15px]">Connect the calendar your jobs live on. Otto checks when you’re busy, and confirmed jobs land on it.</p>
            <Button size="tap" variant="brand" className={actionClass} asChild><a href="/app/integrations/google/start">Connect Google Calendar</a></Button>
            <a className="inline-flex min-h-11 w-fit items-center text-sm text-muted-foreground underline underline-offset-4" href="/privacy#google-calendar">How Otto uses your calendar</a>
          </>
        ) : (
          <p className="text-[15px]">Not available yet. Until it is, Otto takes the time the caller asks for and you confirm it. Those jobs show as <strong className="font-semibold">Confirm time</strong> in Calls.</p>
        )}
      </SettingsCard>
      <SettingsCard title="Appointment hours" description="Times callers can ask for.">
        <Pair>
          <Field label="First appointment"><NativeSelect name="bookableWeekdayStart" value={text("bookableWeekdayStart")} onChange={(event) => set("bookableWeekdayStart", event.target.value)}>{timeChoices(text("bookableWeekdayStart")).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></Field>
          <Field label="Last one ends by"><NativeSelect name="bookableWeekdayEnd" value={text("bookableWeekdayEnd")} onChange={(event) => set("bookableWeekdayEnd", event.target.value)}>{timeChoices(text("bookableWeekdayEnd")).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></Field>
        </Pair>
        <ToggleRow id="bookableWeekends" label="Weekend appointments" hint={flag("bookableWeekends") ? "Saturdays and Sundays, same hours." : "Weekdays only."} checked={flag("bookableWeekends")} onChange={(value) => set("bookableWeekends", value)} />
      </SettingsCard>
      <SettingsCard title="Booking">
        <Pair>
          <Field label="Typical job length">
            <NativeSelect {...bind("defaultServiceDurationMinutes")}>{unique([30, 45, 60, 90, 120, 180, 240, Number(text("defaultServiceDurationMinutes"))]).map((value) => <option key={value} value={value}>{value < 60 ? `${value} min` : `${value / 60} hr${value === 60 ? "" : "s"}`}</option>)}</NativeSelect>
          </Field>
          <Field label="Notice you need" hint="From the call to the start of the job. Drive time included."><NativeSelect {...bind("minimumLeadTimeMinutes")}>{notice.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></Field>
        </Pair>
        {i.directBookingAvailable ? (
          <Field label="When a caller picks a time"><NativeSelect {...bind("bookingMode")}><option value="confirm">Take the details; I’ll confirm</option><option value="direct">Book it on my calendar</option></NativeSelect></Field>
        ) : <p className="text-sm text-muted-foreground">Otto takes the time the caller wants. You confirm it.</p>}
        <ToggleRow id="requireDiagnosticFeeAcceptance" label="Get a yes to your service-call fee" hint="Otto tells the caller your fee (from Your prices) and books only if they say yes." checked={flag("requireDiagnosticFeeAcceptance")} onChange={(value) => set("requireDiagnosticFeeAcceptance", value)} />
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

/** "You paid $24.99 on Nov 26. $49.99 a month from Dec 26." from Stripe, or null while it loads. */
function paidLine(summary: BillingSummary | null, tz: string): string | null {
  if (!summary) return null
  const paid = summary.lastPaid ? `You paid ${cents(summary.lastPaid.amountCents)} on ${shortDay(summary.lastPaid.paidAt, tz)}.` : null
  if (summary.endsAt) return [paid, `Your plan ends ${shortDay(summary.endsAt, tz)}.`].filter(Boolean).join(" ")
  if (!summary.next) return paid
  const day = shortDay(summary.next.at, tz)
  const next = summary.next.amountCents === summary.monthlyCents
    ? `${cents(summary.monthlyCents)} a month from ${day}.`
    : `Next bill ${day}: ${cents(summary.next.amountCents)}${summary.next.amountCents < summary.monthlyCents ? " after your credit" : ""}. Then ${cents(summary.monthlyCents)} a month.`
  return paid ? `${paid} ${next}` : next
}

/** What the confirm dialog says: the exact amount and when, in one or two plain sentences. */
function confirmWords(input: { quote: BillingQuote; from: { label: string; unlimited: boolean }; to: ApiPlan; tz: string }): { title: string; body: string; action: string } {
  const { quote, from, to, tz } = input
  const about = quote.estimated ? "about " : ""
  const day = quote.renewsAt ? shortDay(quote.renewsAt, tz) : "your next bill"
  const planChanged = from.label !== to.label
  const today = quote.todayCents > 0
    ? `${about}${cents(quote.todayCents)} is charged to your card today for the days left until ${day}.`
    : quote.creditCents > 0
      ? `Nothing is charged today. The unused ${about}${cents(quote.creditCents)} comes off your next bill on ${day}.`
      : "Nothing is charged today."
  if (!planChanged && quote.unlimited && to.unlimited) {
    return { title: "Add Unlimited calls?", body: `Add Unlimited calls for ${cents(to.unlimited.addOnCents)} a month. ${today}`, action: quote.todayCents > 0 ? `Add for ${about}${cents(quote.todayCents)}` : "Add Unlimited calls" }
  }
  if (!planChanged && !quote.unlimited) {
    return { title: "Turn off Unlimited calls?", body: `You go back to ${cents(quote.monthlyCents)} a month. ${today}`, action: "Turn off" }
  }
  return { title: `Switch to ${to.label}?`, body: `${to.label}${quote.unlimited ? " with Unlimited calls" : ""} is ${cents(quote.monthlyCents)} a month. ${today}`, action: quote.todayCents > 0 ? `Switch for ${about}${cents(quote.todayCents)}` : `Switch to ${to.label}` }
}

export function PlanSection() {
  const { settings, reload } = useSettings()
  const { dashboard } = useMode()
  const plan = settings.plan
  const csrf = settings.csrf
  // What the owner is looking at: the switch and the plan cards move at once, and nothing is charged until confirmed.
  const [proposal, setProposal] = useState<{ plan: PlanId; unlimited: boolean }>({ plan: plan.id, unlimited: plan.unlimited })
  const [quote, setQuote] = useState<BillingQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<BillingSummary | null>(null)
  // Bumped on every new pick or cancel, so a slow price reply for an old pick never overwrites the new one.
  const quoteGeneration = useRef(0)
  // Back from Stripe's billing page, or it couldn't open: say so here, in one line.
  const [params] = useSearchParams()
  const billing = params.get("billing")
  const usage = dashboard?.usage
  const comp = dashboard?.billing.status === "comp"
  const billingNote = billing === "comp" || (comp && billing) ? "This is a complimentary account. There’s no billing to manage." : billing === "none" ? "There’s no paid plan to manage yet." : billing === "unavailable" ? "Billing couldn’t open just now. Nothing changed. Try again in a minute." : null
  const tz = dashboard?.shop.timezone ?? "America/New_York"
  const leads = dashboard?.guarantee.state === "watching" ? dashboard.guarantee.leads : null
  const monthly = plan.unlimited && plan.unlimitedOffer ? plan.unlimitedOffer.priceCents : plan.flatMonthlyPriceCents
  const target = plan.plans.find((item) => item.id === proposal.plan) ?? null
  const proposalUnlimited = Boolean(proposal.unlimited && target?.unlimited)
  const changed = proposal.plan !== plan.id || proposalUnlimited !== plan.unlimited
  const shownUnlimitedPlan = target ?? plan.plans.find((item) => item.id === plan.id) ?? null

  useEffect(() => { setProposal({ plan: plan.id, unlimited: plan.unlimited }) }, [plan.id, plan.unlimited])
  useEffect(() => {
    if (!plan.paid || comp) return
    let alive = true
    api<BillingSummary>("/api/app/billing/summary")
      .then((value) => { if (alive) setSummary(value) })
      // Couldn't read it: show no top line rather than a placeholder that never ends.
      .catch(() => { if (alive) setSummary({ lastPaid: null, next: null, endsAt: null, monthlyCents: 0 }) })
    return () => { alive = false }
  }, [plan.paid, comp, plan.id, plan.unlimited])
  // The live total: Stripe's own price for the change on screen, refreshed on every pick.
  useEffect(() => {
    const generation = ++quoteGeneration.current
    setQuote(null)
    setQuoteError(null)
    if (!changed || !target) return
    let alive = true
    const timer = window.setTimeout(() => {
      api<BillingQuote>("/api/app/billing/preview", { method: "POST", body: { plan: proposal.plan, unlimited: proposalUnlimited } })
        .then((value) => { if (alive && generation === quoteGeneration.current) setQuote(value) })
        .catch((error) => { if (alive && generation === quoteGeneration.current) setQuoteError(error instanceof Error ? error.message : "We couldn’t get the price. Try again.") })
    }, 150)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [changed, target, proposal.plan, proposalUnlimited])

  const revert = () => { quoteGeneration.current++; setProposal({ plan: plan.id, unlimited: plan.unlimited }); setConfirmOpen(false) }
  const flipUnlimited = (on: boolean) => {
    setProposal((current) => ({ ...current, unlimited: on }))
    // A paying shop confirms the exact amount first; before paying, the pick is just remembered (below).
    if (plan.paid) setConfirmOpen(true)
  }
  const apply = async () => {
    if (!target) return
    setBusy(true)
    try {
      const confirm = quote && quote.prorationDate !== null ? { prorationDate: quote.prorationDate, todayCents: quote.todayCents, creditCents: quote.creditCents, estimated: quote.estimated } : undefined
      await api("/api/app/billing/change", { method: "POST", body: { plan: target.id, unlimited: proposalUnlimited, confirm } })
      setConfirmOpen(false)
      await reload()
      toast.success(quote && quote.todayCents > 0 ? `Done. ${cents(quote.todayCents)} charged.` : proposalUnlimited !== plan.unlimited && proposal.plan === plan.id ? (proposalUnlimited ? "Unlimited calls are on." : "Unlimited calls are off.") : `You’re on ${target.label}.`)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // The price moved (or went stale): show the new one in the same dialog. Nothing was charged.
        setQuote(null)
        const generation = ++quoteGeneration.current
        api<BillingQuote>("/api/app/billing/preview", { method: "POST", body: { plan: target.id, unlimited: proposalUnlimited } })
          .then((value) => { if (generation === quoteGeneration.current) setQuote(value) })
          .catch(() => undefined)
      } else {
        revert()
      }
      toast.error(error instanceof Error ? error.message : "Nothing changed. Please try again.")
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
  const topLine = plan.paid && !comp ? paidLine(summary, tz) : null
  const words = quote && target ? confirmWords({ quote, from: { label: plan.label, unlimited: plan.unlimited }, to: target, tz }) : null
  const newMonthly = target ? monthlyOf(target, proposalUnlimited) : monthly
  const todayLine = !plan.paid ? "Charged when you add your card" : quoteError ? quoteError : !quote ? "Checking the price…"
    : quote.todayCents > 0 ? `${quote.estimated ? "About " : ""}${cents(quote.todayCents)} charged today`
    : quote.creditCents > 0 ? `${quote.estimated ? "About " : ""}${cents(quote.creditCents)} off your next bill` : "Nothing charged today"
  return (
    <>
      {billing === "back" && <p role="status" className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[15px] text-emerald-950"><CheckCircle2 className="size-4.5 shrink-0" />You’re back from billing. Your plan below is up to date.</p>}
      <section className="grid gap-4 rounded-xl border-2 border-brand-ink bg-card p-4 md:p-5">
        {plan.paid && !comp && (
          topLine
            ? <p className="text-[16px] font-semibold text-brand-ink text-balance">{topLine}</p>
            : !summary && <span aria-hidden className="h-6 w-4/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        )}
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
      </section>

      {plan.plans.length > 0 && (
        <SettingsCard title="Change plan" description={plan.paid ? "Your team shares the plan’s calls. You see the price before anything is charged." : "Your team shares the plan’s calls. We’ll use this plan when you add your card."}>
          <PlanCards columns plans={plan.plans} picked={proposal.plan} currentId={plan.id} disabled={busy} onPick={(id) => setProposal((current) => ({ ...current, plan: id }))} />
          {shownUnlimitedPlan?.unlimited && <UnlimitedAddOn id="settings-unlimited" plan={shownUnlimitedPlan} checked={proposalUnlimited} disabled={busy} onCheckedChange={flipUnlimited} />}
          {changed && <PriceSummary label="New price" big={<>{cents(newMonthly)}<span className="text-[15px] font-medium text-muted-foreground"> a month</span></>} line={todayLine}>
            <span className="grid gap-2 sm:flex sm:items-center">
              <Button size="tap" variant="brand" className={actionClass} disabled={busy || (plan.paid && !quote)} onClick={() => (plan.paid ? setConfirmOpen(true) : void apply())}>
                {target && target.id !== plan.id ? `Switch to ${target.label}` : proposalUnlimited ? "Add Unlimited calls" : "Turn off Unlimited calls"}
              </Button>
              <Button size="tap" variant="ghost" className="sm:w-auto" disabled={busy} onClick={revert}>Keep my plan</Button>
            </span>
          </PriceSummary>}
        </SettingsCard>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!open && !busy) revert() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{words?.title ?? "Checking the price…"}</AlertDialogTitle>
            <AlertDialogDescription className="text-[16px] text-pretty text-brand-ink">
              {words?.body ?? (quoteError ?? "One moment. Nothing is charged until you confirm.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} onClick={revert}>Cancel</AlertDialogCancel>
            <Button size="tap" variant="brand" disabled={busy || !quote} onClick={() => void apply()}>{busy ? <Loader2 className="animate-spin" /> : null}{words?.action ?? "Confirm"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* A complimentary shop (the Google review account) has no card or Stripe billing to open. */}
      {comp && billingNote && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">{billingNote}</p>}
      {!comp && (
        <SettingsCard title={plan.paid ? "Card, invoices, cancel" : "Start your plan"} description={plan.paid ? "Opens our billing page (Stripe) to change your card, see invoices or cancel." : "Add a card to start answering calls."}>
          {billingNote && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">{billingNote}</p>}
          <form method="post" action={plan.paid ? "/app/billing/portal" : "/app/billing/checkout"}>
            <input type="hidden" name="csrf" value={csrf} />
            {/* Paying from here continues setup, where the line turns on the moment the owner is back. */}
            {!plan.paid && <input type="hidden" name="from" value="start" />}
            {/* The plan and add-on picked above, so Stripe opens on exactly that price. */}
            {!plan.paid && <input type="hidden" name="plan" value={proposal.plan} />}
            {!plan.paid && <input type="hidden" name="unlimited" value={proposalUnlimited ? "yes" : "no"} />}
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
          ["Calls", "Your team shares your plan’s calls."],
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
  recording: "A call recording couldn’t be deleted. Your line is paused and nothing else was removed. Try again.",
}
/** Re-sign-in lands back here with the delete form open. */
const SIGN_IN_TO_DELETE = `/login?next=${encodeURIComponent("/app/settings/data?delete=open")}`

export function DataSection() {
  const { settings } = useSettings()
  const [params] = useSearchParams()
  const deleteParam = params.get("delete")
  const deleteBack = deleteParam === "open" || deleteParam === "signin" || (deleteParam && Object.prototype.hasOwnProperty.call(DELETE_PROBLEMS, deleteParam)) ? deleteParam : null
  const [confirmDelete, setConfirmDelete] = useState(Boolean(deleteBack))
  // Signed in within the last 10 minutes (any way): that proves it's the owner, no password needed.
  // Otherwise a password account types its password; Google, Microsoft or email-link accounts sign in again.
  const hasPassword = settings.signIn?.hasPassword ?? true
  const recent = settings.signIn?.recent ?? false
  const needsFreshSignIn = !hasPassword && !recent
  const askPassword = hasPassword && !recent
  const problem = deleteBack === "signin"
    ? (hasPassword ? "It’s been over 10 minutes since you signed in. Enter your password, or sign in again." : null)
    : deleteBack && Object.prototype.hasOwnProperty.call(DELETE_PROBLEMS, deleteBack) ? DELETE_PROBLEMS[deleteBack]! : null
  const badPassword = deleteBack === "password" || deleteBack === "signin"
  const badConfirm = deleteBack === "confirm"
  useEffect(() => {
    if (!deleteBack) return
    document.getElementById("delete-account")?.scrollIntoView({ block: "center" })
    document.getElementById(badConfirm ? "delete-confirm" : badPassword && askPassword ? "delete-password" : "delete-problem")?.focus()
  }, [deleteBack, badPassword, badConfirm, askPassword])
  return (
    <>
      <SettingsCard title="Download your data" description="We keep every call until you delete it. Files save straight to this phone or computer.">
        <DownloadRow title="Calls spreadsheet (.csv)" text="Every call: date, caller, callback number, address, problem and outcome. Opens in Excel or Google Sheets." href={`/api/app/shops/${encodeURIComponent(settings.shopId)}/calls.csv`} />
        <DownloadRow title="Everything (.json)" text="Settings, calls, transcripts, follow-ups and appointments in one file, for moving to another system. Recordings aren’t included." href="/app/account/export" />
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
            <p className="text-[15px]">This deletes <strong>{settings.businessName || "this shop"}</strong> for good.</p>
            {problem && <p role="alert" id="delete-problem" tabIndex={-1} className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">{problem}</p>}
            <Pair>
              <Field label="Type DELETE"><Input id="delete-confirm" name="confirm" autoComplete="off" required defaultValue={problem && !badConfirm && askPassword ? "DELETE" : undefined} aria-invalid={badConfirm || undefined} aria-describedby={badConfirm ? "delete-problem" : undefined} className={fieldClass} /></Field>
              {askPassword ? (
                <Field label="Your password">
                  <Input id="delete-password" name="password" type="password" autoComplete="current-password" required aria-invalid={deleteBack === "password" || undefined} aria-describedby={badPassword && problem ? "delete-problem" : undefined} className={fieldClass} />
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
