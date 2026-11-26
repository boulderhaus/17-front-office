import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react"
import { Check, Copy, LifeBuoy, Loader2, Mail, Phone, PhoneCall, PhoneForwarded } from "lucide-react"
import { QrCode } from "@/components/app/qr-code"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import { afterDialLine, codeChunks, copyText, dialHref, dialPlatform, pasteLine, spokenCode, VERIZON_RING_LINE } from "@/lib/dial"
import { formatPhone } from "@/lib/format"
import { checkStatus } from "@/lib/line-status"
import { useMode } from "@/lib/mode"
import type { ApiDashboard, CarrierFamily, ForwardingPlan } from "@/lib/types"
import { cn } from "@/lib/utils"

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent
const platform = dialPlatform(ua)
const isAndroid = /Android/i.test(ua)
const isIphone = platform === "iphone"
/** A computer is clicked, a phone is tapped. */
const tapWord = platform === "desktop" ? "Click" : "Tap"
/** A text link that is a real button: 44px tall, underlined, with a solid focus ring (the default ring is faint). */
const linkButton = "h-auto min-h-11 w-fit justify-start px-0 text-left text-sm font-semibold whitespace-normal text-brand-ink underline focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:ring-offset-2"
/** Every button in the card's column: the card's full width, one height. */
const fullButton = "h-14 w-full text-base lg:h-12"
const outlineButton = "border-2 border-brand-ink bg-card text-brand-ink"

type Status = ApiDashboard["line"]["check"]["status"]
/** "Otto answers every call" (forward-all) or "Ring my phone first" (any other mode: missed calls or after hours). */
type Choice = "always" | "ring"

/**
 * The one screen a non-technical owner needs, as three numbered steps: 1 pick how calls work, 2 dial the one code
 * for it, 3 test it. Carrier, code and proof are our job. One code on screen at a time: the clear-it code shows only
 * when our test found every call still forwarded, then the shop's code again.
 * `footer` lets the setup flow add its own row under the card; `inApp` is the Settings version (no setup wording).
 */
export function ForwardingCard({ dashboard, footer, inApp = false }: { dashboard: ApiDashboard; footer?: (state: { confirmed: boolean }) => ReactNode; inApp?: boolean }) {
  const { reload } = useMode()
  const line = dashboard.line
  const business = line.business
  const [editing, setEditing] = useState(!business.number && !business.suggested)
  const [busy, setBusy] = useState<"save" | "check" | "help" | "mode" | null>(null)
  const [picking, setPicking] = useState<Choice | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Codes copied (or dialed) on this visit: that step shows done. A clear code dialed moves on to the shop's code.
  const [copied, setCopied] = useState<string | null>(null)
  const [cleared, setCleared] = useState<string | null>(null)
  const codeRef = useRef<HTMLDivElement>(null)
  const testRef = useRef<HTMLButtonElement>(null)
  const checking = line.check.status === "calling"
  const callerId = line.check.callerId ? formatPhone(line.check.callerId) : null

  // While a check call is out, refresh until it lands or times out.
  useEffect(() => {
    if (!checking) return
    const id = window.setInterval(() => void reload().catch(() => undefined), 3000)
    return () => window.clearInterval(id)
  }, [checking, reload])

  const post = async (kind: "save" | "check" | "help" | "mode", path: string, body: unknown = {}) => {
    setBusy(kind)
    setError(null)
    try {
      await api(path, { method: "POST", body })
      await reload().catch(() => undefined)
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That didn’t work. Please try again.")
      return false
    } finally {
      setBusy(null)
    }
  }

  const saveNumber = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const number = new FormData(event.currentTarget).get("number")
    if (await post("save", "/api/app/line/business-number", { number })) setEditing(false)
  }

  const saved: Choice = line.mode === "always" ? "always" : "ring"
  const choice: Choice = picking ?? saved
  // Picking a choice saves the tenant's mode; the server brings back "ring first" as it was (after hours stays).
  const setMode = async (next: Choice) => {
    if (next === saved) return true
    setPicking(next)
    const ok = await post("mode", "/api/app/line/mode", { mode: next === "always" ? "always" : "overflow" })
    setPicking(null)
    return ok
  }
  const switchToEveryCall = async () => {
    if (!await setMode("always")) return
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    window.setTimeout(() => codeRef.current?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }), 50)
  }

  const plan = business.plan
  // A finished test for another choice or code is not shown (and isn't a failure).
  const status = checkStatus(line) as Status
  const forwardsAll = status === "forwards_all"
  const confirmed = Boolean(line.confirmedAt) && (status === "idle" || status === "passed")
  // Proven for today's choice: nothing left to dial or test.
  const current = confirmed && !business.update
  const family = business.carrier?.family ?? null
  // The clear code until it's dialed, then the shop's own code again. Never both on one screen.
  const clearing = forwardsAll && Boolean(plan?.off) && cleared !== plan?.off
  const dialCode = clearing ? plan!.off! : plan?.on ?? null
  const dialLink = clearing ? plan!.offDialLink : plan?.dialLink ?? null
  const dialed = Boolean(dialCode) && copied === dialCode

  // Back on this page after dialing in the Phone app: the next step is the test, so bring it into view.
  useEffect(() => {
    if (!dialed) return
    const back = () => {
      if (document.visibilityState !== "visible") return
      if (clearing) { setCleared(dialCode); return }
      testRef.current?.scrollIntoView({ block: "center" })
      testRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener("visibilitychange", back)
    return () => document.removeEventListener("visibilitychange", back)
  }, [dialed, clearing, dialCode])

  // "Set it up with me" was tapped in the last day (older requests are done with).
  const helpAsked = Boolean(line.helpRequestedAt) && Date.parse(dashboard.now) - Date.parse(line.helpRequestedAt!) < 24 * 60 * 60_000
  // The setup call rings for up to 30 s and can run 15 min; show "calling now" for its first 2 minutes, until it ends.
  const helpCalling = Boolean(line.helpCall && !line.helpCall.endedAt) && Date.parse(dashboard.now) - Date.parse(line.helpCall!.startedAt) < 2 * 60_000
  // Only what really went out: our team's email to the owner, or the request in our team's inbox. Never a check
  // mark for something that wasn't sent.
  const helpLine = !helpAsked || helpCalling ? null
    : line.founderEmail ? teamEmailLine(line.founderEmail)
      : line.helpCall ? null
        : line.helpTeam ? "Our team has your request. We’ll get back to you within one business day."
          : null
  const helpFailed = helpAsked && !helpCalling && !line.helpCall && !line.founderEmail && !line.helpTeam
  // One tap is enough: once it reached someone, the button goes (after a setup call, "Have Otto call me again" stays).
  const helpDone = Boolean(helpLine) && !line.helpCall
  const asking = !editing && !business.number && Boolean(business.suggested)
  const startTest = () => void post("check", "/api/app/line/check")
  const cancelTest = () => void post("check", "/api/app/line/check/cancel")
  const testLabel = status === "idle" ? "Test it" : "Test again"
  const fixOffer = plan ? showFix(status, plan) : false
  const changeButton = (label: string) => <button type="button" aria-label="Change your business number" className="inline-flex min-h-11 min-w-11 items-center font-semibold whitespace-nowrap text-brand-ink underline underline-offset-4 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:outline-none" onClick={() => setEditing(true)}>{label}</button>
  const change = changeButton("Change")
  // Office line leaving every call (or still forwarding every call): "forward all calls" goes off in the same website.
  const officeLeaving = Boolean((business.update?.leavingEveryCall || forwardsAll) && plan && !plan.on && plan.family === "office")
  const what = plan && officeLeaving && line.number
    ? `In your phone company’s website or app, turn off forward all calls. Then forward calls you don’t answer to ${formatPhone(line.number)}.`
    : plan?.what ?? ""
  const ringFirst = choice === "ring"
  const showSteps = Boolean(plan && plan.family !== "unknown" && !current)

  return (
    <Card className="relative gap-0 overflow-hidden border-brand-ink/15 py-0">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1.5 bg-brand-yellow" />
      <div className="grid gap-4 px-5 py-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-0.5">
            <small className="text-[13px] font-medium text-muted-foreground">Otto’s line</small>
            {line.number ? (
              <strong className="tabular text-xl font-semibold tracking-tight whitespace-nowrap"><Phone className="mr-1.5 inline size-4 align-[-2px]" />{formatPhone(line.number)}</strong>
            ) : (
              <strong className="text-lg font-semibold tracking-tight text-muted-foreground">On its way</strong>
            )}
            {line.number && <p className="text-sm text-muted-foreground">Customers keep calling your number. You never need to save or share this one.</p>}
          </div>
          {current && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-emerald-800"><Check className="size-3.5" />Forwarding works</span>}
        </header>

        {asking ? (
          <div className="grid gap-3 border-t pt-4">
            <p className="text-[17px] leading-snug font-semibold">Is this the number customers call?</p>
            <strong className="tabular text-[28px] leading-tight font-semibold tracking-tight">{formatPhone(business.suggested!)}</strong>
            <div className="grid gap-2.5">
              <Button size="tap" variant="brand" className={fullButton} disabled={busy === "save"} onClick={() => void post("save", "/api/app/line/business-number", { number: business.suggested })}>
                {busy === "save" ? <><Loader2 className="motion-safe:animate-spin" />Looking up your phone company…</> : "Yes"}
              </Button>
              <Button size="tap" variant="outline" className={cn(fullButton, outlineButton)} disabled={busy === "save"} onClick={() => setEditing(true)}>No, it’s another number</Button>
            </div>
          </div>
        ) : editing ? (
          <form onSubmit={(event) => void saveNumber(event)} className="grid gap-2.5 border-t pt-4">
            <label htmlFor="business-number" className="text-[15px] font-semibold">The number customers call</label>
            <Input id="business-number" name="number" type="tel" inputMode="tel" autoComplete="tel" placeholder="e.g. (941) 555-0123" aria-describedby="business-number-hint" defaultValue={business.number ? formatPhone(business.number) : ""} className="h-12 text-lg" required autoFocus={Boolean(business.suggested)} />
            <p id="business-number-hint" className="-mt-1 text-sm text-muted-foreground">You keep it.</p>
            <Button size="tap" variant="brand" className={fullButton} disabled={busy === "save"}>{busy === "save" ? <><Loader2 className="motion-safe:animate-spin" />Looking up your phone company…</> : "Next"}</Button>
          </form>
        ) : (
          <>
            {!line.number && (
              <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950" role="status">Saved. Your code shows up here when your line is on.</p>
            )}

            {line.number && (!plan || plan.family === "unknown") && (
              <div className="grid gap-2 border-t pt-4">
                <p className="text-[15px] font-semibold">Who’s the phone company for <span className="tabular whitespace-nowrap">{formatPhone(business.number!)}</span>? {change}</p>
                {business.choices.map((item) => (
                  <Button key={item.family} type="button" size="tap" variant="outline" className="h-auto min-h-12 w-full justify-start py-3 text-left whitespace-normal" disabled={busy === "save"}
                    onClick={() => void post("save", "/api/app/line/business-number", { number: business.number, family: item.family satisfies CarrierFamily })}>
                    {item.label}
                  </Button>
                ))}
              </div>
            )}

            {showSteps && plan && (
              <ol className="grid gap-0">
                <Step n={1} done title="How should calls work?">
                  <ModeChoice choice={choice} busy={busy === "mode"} locked={checking} family={family} ringFirstSeconds={business.ringFirstSeconds ?? null} onPick={(next) => { if (busy !== "mode") void setMode(next) }} />
                  {ringFirst && !isAndroid && family !== "office" && <IphoneSettings />}
                </Step>

                <Step n={2} done={dialed && !clearing} title={<>{clearing ? "Clear the old forwarding on " : plan.on ? "Dial this on " : "Set it up for "}<span className="tabular whitespace-nowrap">{formatPhone(business.number!)}</span> · {change}</>}>
                  {forwardsAll && (
                    <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
                      <strong className="font-semibold">Your phone never rang.</strong> Otto answered {line.check.forwardedAfterSec != null ? `in ${Math.max(1, line.check.forwardedAfterSec)} seconds` : "right away"}, so every call is still being forwarded.{" "}
                      {plan.off ? (clearing ? "Dial this code to clear it." : "Now dial your code again.") : "Turn off forward all calls in your phone company’s website."}
                    </p>
                  )}
                  {dialCode
                    ? <DialCode key={dialCode} code={dialCode} dialLink={dialLink} family={family} codeRef={codeRef} copied={copied === dialCode} onCopied={() => setCopied(dialCode)} />
                    : <p className="text-sm">{what}</p>}
                  {clearing && dialed && (
                    <Button type="button" size="tap" variant="outline" className={cn(fullButton, outlineButton)} onClick={() => setCleared(dialCode)}>Next: your code</Button>
                  )}
                </Step>

                <Step n={3} last done={status === "passed"} title="Test it">
                  {checking ? (
                    <div className="grid gap-2">
                      <p className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950" role="status">
                        <Loader2 className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
                        {line.check.method === "auto"
                          ? <span><strong>Calling {formatPhone(business.number!)}{callerId ? <> from <span className="whitespace-nowrap">{callerId}</span></> : null}.</strong> {plan.forwardsAll ? "Your phone shouldn’t ring." : "Your phone will ring. Don’t answer it."}</span>
                          // Our call couldn't be placed: say so first, then the one thing to do instead.
                          : <span>{line.check.autoFailed ? <strong>We couldn’t call you. </strong> : null}Call {formatPhone(business.number!)} from another phone.{plan.forwardsAll ? " Your phone shouldn’t ring." : " Let it ring. Don’t answer it."}</span>}
                      </p>
                      <Button type="button" variant="link" className={linkButton} disabled={busy === "check"} onClick={cancelTest}>Cancel</Button>
                    </div>
                  ) : (
                    <>
                      {!forwardsAll && <CheckResult status={status} plan={plan} />}
                      {fixOffer && (
                        <Button size="tap" variant="brand" className={fullButton} disabled={busy === "mode"} onClick={() => void switchToEveryCall()}>
                          {busy === "mode" ? <Loader2 className="motion-safe:animate-spin" /> : null}Switch to Otto answers every call
                        </Button>
                      )}
                      <p className="text-[15px] font-semibold">{plan.forwardsAll ? `${tapWord} ${testLabel}. Your phone won’t ring.` : `${tapWord} ${testLabel}. Your phone will ring. Don’t answer it.`}</p>
                      <Button ref={testRef} size="tap" variant={fixOffer || clearing ? "outline" : "brand"} className={cn(fullButton, (fixOffer || clearing) && outlineButton)} disabled={busy === "check" || clearing} onClick={startTest}>
                        {busy === "check" ? <><Loader2 className="motion-safe:animate-spin" />Starting…</> : testLabel}
                      </Button>
                      {callerId && <span className="text-center text-[13px] text-muted-foreground">Our test call comes from <span className="tabular whitespace-nowrap">{callerId}</span></span>}
                    </>
                  )}
                </Step>
              </ol>
            )}

            {current && (
              <div className="grid gap-3 text-sm">
                <p className="text-[15px]">{proofLine(business, dashboard.shop.timezone)}</p>
                <span className="-mt-2">{changeButton("Change number")}</span>
                {inApp && <ModeChoice choice={choice} busy={busy === "mode"} locked={checking} family={family} ringFirstSeconds={business.ringFirstSeconds ?? null} onPick={(next) => { if (busy !== "mode") void setMode(next) }} />}
                {plan?.off && (
                  <details className="group">
                    <summary className="cursor-pointer font-semibold underline underline-offset-4">How to turn forwarding off</summary>
                    <div className="mt-2 grid gap-2">
                      <p>On {formatPhone(business.number!)}, dial <code className="rounded bg-muted px-1.5 py-0.5 font-mono font-semibold">{plan.off}</code> and press Call.</p>
                      {dialHref(platform, plan.offDialLink) && <Button size="tap" variant="outline" className={fullButton} asChild><a href={dialHref(platform, plan.offDialLink)!}>Tap to dial {plan.off}</a></Button>}
                    </div>
                  </details>
                )}
                <Button type="button" variant="link" className={linkButton} disabled={busy === "check"} onClick={startTest}>Test it again</Button>
              </div>
            )}
          </>
        )}

        {error && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">{error}</p>}

        {!current && line.number && (
          <div className="grid gap-1.5 border-t pt-3">
            {helpCalling ? (
              <p className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950" role="status">
                <PhoneCall className="mt-0.5 size-4 shrink-0" />
                <span><strong>Otto is calling you now at <span className="whitespace-nowrap">{formatPhone(line.helpCall!.to)}</span>.</strong> Pick up{callerId ? <> (it’s from <span className="whitespace-nowrap">{callerId}</span>)</> : null}.</span>
              </p>
            ) : helpLine ? (
              <p className="flex items-start gap-2 text-sm" role="status"><Check className="mt-0.5 size-4 shrink-0 text-emerald-700" />{helpLine}</p>
            ) : helpFailed ? (
              // Nothing could carry it (no setup call, no email): say where to write, never "try again" forever.
              <p className="text-sm" role="status">That didn’t reach us. {line.helpEmail ? <>Email <a className="font-semibold underline underline-offset-4" href={`mailto:${line.helpEmail}`}>{line.helpEmail}</a> and we’ll help.</> : "Please try again."}</p>
            ) : null}
            {!helpCalling && !helpDone && (
              <Button type="button" variant="link" className={linkButton} disabled={busy === "help"} onClick={() => void post("help", "/api/app/line/help", { device: isIphone ? "iphone" : isAndroid ? "android" : "other" })}>
                {busy === "help" ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <LifeBuoy className="size-4" />}{busy === "help" ? "Sending…" : line.helpCall ? "Have Otto call me again" : "Set it up with me"}
              </Button>
            )}
          </div>
        )}
        {footer?.({ confirmed: current })}
      </div>
    </Card>
  )
}

/** One numbered step: a number in a circle, a green check once it's done. */
function Step({ n, title, done = false, last = false, children }: { n: number; title: ReactNode; done?: boolean; last?: boolean; children: ReactNode }) {
  return (
    <li className={cn("grid gap-3 border-t pt-4", !last && "pb-4")}>
      {/* The number sits with the title; what's under it gets the card's full width (the code never wraps on a phone). */}
      <div className="flex items-center gap-3">
        <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-full text-sm font-bold", done ? "bg-emerald-600 text-white" : "border-2 border-brand-ink text-brand-ink")}>
          {done ? <Check className="size-4" strokeWidth={3} /> : n}
        </span>
        <p className="text-base leading-snug font-semibold"><span className="sr-only">Step {n}{done ? ", done" : ""}: </span>{title}</p>
      </div>
      <div className="grid min-w-0 gap-2.5">{children}</div>
    </li>
  )
}

/** What our team's email to the owner was: a booking link, or (no calendar connected yet) a note asking for a reply. */
function teamEmailLine(email: { sentAt: string; link: boolean }): string {
  return email.link ? "Our team emailed you a link to book a 10‑minute call." : "Our team emailed you to set up a quick call."
}

/** What the last passed test proved, and when: for ring first, how long the phone rang before Otto answered. */
function proofLine(business: ApiDashboard["line"]["business"], timeZone: string): string {
  const test = business.lastTest
  const number = formatPhone(business.number!)
  if (!test) return `Calls to ${number} reach Otto.`
  const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(test.at))
  if (test.mode === "every-call") return `Tested ${when}: Otto answered every call to ${number}. Your phone won’t ring for these.`
  return test.rangSeconds
    ? `Tested ${when}: your phone rang about ${test.rangSeconds} seconds, then Otto answered.`
    : `Tested ${when}: calls you miss on ${number} go to Otto.`
}

/**
 * The two ways calls can work, every call first (the default for new shops). One short line each, with the same
 * ring time everywhere: the carrier's own (GSM timer, Verizon's fixed ~30 s).
 */
function ModeChoice({ choice, busy, locked, family, ringFirstSeconds, onPick }: { choice: Choice; busy: boolean; locked: boolean; family: CarrierFamily | null; ringFirstSeconds: number | null; onPick: (choice: Choice) => void }) {
  const ringLine = family === "office" ? "Otto takes the calls you miss." : family === "verizon" ? VERIZON_RING_LINE : `Rings ${ringFirstSeconds ?? 10} seconds, then Otto answers.`
  const options: Array<{ id: Choice; title: string; line: string }> = [
    { id: "always", title: "Otto answers every call", line: family === "office" ? "Otto picks up right away." : "Your phone won’t ring for this number." },
    { id: "ring", title: "Ring my phone first", line: ringLine },
  ]
  return (
    // Locked while a test call is out: the test proves the code that was on screen when it started. While a pick
    // saves, the radios stay enabled (aria-busy) so the arrow keys never drop focus to the page.
    <fieldset className="grid gap-2" disabled={locked} aria-busy={busy || undefined}>
      <legend className="sr-only">How calls to your business number work</legend>
      {options.map((option) => {
        const on = choice === option.id
        return (
          <label key={option.id} className={cn(
            "flex cursor-pointer items-start gap-3 rounded-lg border-2 px-3 py-3 transition-colors has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-ink has-[:disabled]:cursor-wait",
            on ? "border-brand-ink bg-accent" : "border-brand-ink/15 bg-card hover:border-brand-ink/40",
          )}>
            <input type="radio" name="forward-mode" value={option.id} checked={on} onChange={() => onPick(option.id)} className="mt-0.5 size-5 shrink-0 accent-brand-ink focus-visible:outline-none" />
            <span className="grid min-w-0 gap-0.5">
              <span className="flex items-center gap-2 text-base leading-snug font-semibold">{option.title}{busy && on ? <Loader2 className="size-4 motion-safe:animate-spin" aria-label="Saving" /> : null}</span>
              <span className="text-sm text-muted-foreground">{option.line}</span>
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}

/**
 * Ring first on an iPhone: two settings answer or silence calls before the carrier can forward them to Otto.
 * Shown only when ring first is picked, as exact Settings paths (iOS 26 and later).
 */
function IphoneSettings() {
  return (
    <div className="grid gap-2 rounded-lg border border-brand-ink/15 bg-muted/40 px-3 py-3 text-sm">
      <p className="font-semibold">On iPhone, change two settings:</p>
      <ol className="grid list-decimal gap-1.5 pl-5">
        <li>Open <strong className="font-semibold">Settings › Apps › Phone</strong>.</li>
        <li>Turn <strong className="font-semibold">Live Voicemail</strong> off.</li>
        <li>Set <strong className="font-semibold">Screen Unknown Callers</strong> to <strong className="font-semibold">Never</strong>.</li>
      </ol>
      <p className="text-muted-foreground">Otherwise your iPhone answers or silences calls before Otto can.</p>
    </div>
  )
}

/**
 * Ring first, and our test call was picked up by the phone itself (or went to voicemail, which Live Voicemail can
 * look like): offer the switch to every call.
 */
function showFix(status: Status, plan: ForwardingPlan): boolean {
  if (!plan.on || plan.forwardsAll) return false
  return status === "phone_answers" || status === "voicemail"
}

/** Copy from a tap: the Clipboard API, or the old hidden-textarea copy where it's refused. */
function copyNow(code: string): Promise<boolean> {
  return copyText(code, {
    clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined,
    fallback: (text) => {
      const area = document.createElement("textarea")
      area.value = text
      area.setAttribute("readonly", "")
      area.style.position = "fixed"
      area.style.opacity = "0"
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand("copy")
      area.remove()
      return ok
    },
  })
}

/**
 * The code to dial, the way this device can dial it: the big code, one button, and two short lines (where to paste
 * it, and what the carrier shows). A computer also gets the QR and "Email me these steps".
 */
function DialCode({ code, dialLink, family, codeRef, copied, onCopied }: { code: string; dialLink: string | null; family: CarrierFamily | null; codeRef?: Ref<HTMLDivElement>; copied: boolean; onCopied: () => void }) {
  const href = dialHref(platform, dialLink)
  const [failed, setFailed] = useState(false)
  const copy = () => void copyNow(code).then((ok) => { if (ok) { setFailed(false); onCopied() } else setFailed(true) })
  return (
    <div className="grid gap-2.5">
      <div ref={codeRef} className="scroll-mt-24 rounded-xl border-2 border-brand-ink bg-brand-yellow px-2 py-3 text-center font-mono text-[17px] leading-snug font-bold select-all min-[400px]:text-xl sm:text-2xl">
        <span className="sr-only">{spokenCode(code)}</span>
        {/* Wrap only between chunks, never inside one ("060 / 4#" read as two numbers). */}
        <span aria-hidden>{codeChunks(code).map((chunk, index) => <Fragment key={index}>{index ? " " : ""}<span className="whitespace-nowrap">{chunk}</span></Fragment>)}</span>
      </div>
      {href ? (
        // Android: the dialer opens with the code filled in. Tapping it counts as dialed.
        <Button size="tap" variant={copied ? "outline" : "brand"} className={cn(fullButton, copied && outlineButton)} asChild>
          <a href={href} onClick={onCopied}>{copied ? <Check /> : <PhoneForwarded />}{copied ? "Opened in Phone" : "Tap to dial"}</a>
        </Button>
      ) : (
        <Button type="button" size="tap" variant={copied ? "outline" : "brand"} className={cn(fullButton, copied && outlineButton)} onClick={copy} aria-live="polite">
          {copied ? <><Check />Copied</> : <><Copy />Copy code</>}
        </Button>
      )}
      {failed ? (
        <p className="text-sm font-medium" role="status">Couldn’t copy. {platform === "desktop" ? "Type it on your phone’s keypad, then Call." : "Type it in your Phone app’s keypad, then Call."}</p>
      ) : (
        <p className="text-sm font-medium">{href ? "Then tap Call." : pasteLine(platform)}</p>
      )}
      <p className="text-sm text-muted-foreground">{afterDialLine(family, platform)}</p>
      {platform === "desktop" && <PhoneHandoff />}
    </div>
  )
}

/** The QR's link works for 15 minutes: a fresh one every 10, and whenever the page comes back into view. */
const HANDOFF_REFRESH_MS = 10 * 60_000

/**
 * A computer can't dial. The QR opens a short-lived page on the phone that shows this shop's code, with no sign-in
 * in the way; "Email me these steps" sends the same page to the owner's own email (texting waits on carrier approval).
 */
function PhoneHandoff() {
  const [link, setLink] = useState<string | null>(null)
  const [mail, setMail] = useState<{ state: "idle" | "sending" | "sent" | "failed"; text?: string }>({ state: "idle" })
  useEffect(() => {
    let live = true
    let fetchedAt = 0
    const refresh = () => {
      fetchedAt = Date.now()
      void api<{ url: string }>("/api/app/line/handoff", { method: "POST", body: {} }).then((result) => { if (live) setLink(result.url) }).catch(() => undefined)
    }
    // Back on this tab or window after a while: the old link may be close to expiring.
    const onVisible = () => { if (document.visibilityState === "visible" && Date.now() - fetchedAt > 60_000) refresh() }
    refresh()
    const id = window.setInterval(refresh, HANDOFF_REFRESH_MS)
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      live = false
      window.clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
    }
  }, [])
  const email = async () => {
    setMail({ state: "sending" })
    try {
      const result = await api<{ sentTo: string }>("/api/app/line/handoff/email", { method: "POST", body: {} })
      setMail({ state: "sent", text: result.sentTo })
    } catch (caught) {
      setMail({ state: "failed", text: caught instanceof Error ? caught.message : "That didn’t send. Please try again." })
    }
  }
  return (
    <div className="grid gap-3 rounded-lg border bg-muted/40 p-3">
      <p className="text-[15px] font-semibold">Easier on your phone</p>
      {link && (
        <div className="flex flex-wrap items-center gap-4">
          <div className="rounded-md bg-white p-2"><QrCode value={link} size={184} label="QR code that opens this code on your phone" /></div>
          <p className="min-w-40 flex-1 text-sm">Point your phone’s camera here. Tap the link that pops up to see this code there.</p>
        </div>
      )}
      <Button type="button" size="tap" variant="outline" className={cn(fullButton, outlineButton)} disabled={mail.state === "sending" || mail.state === "sent"} onClick={() => void email()}>
        {mail.state === "sending" ? <><Loader2 className="motion-safe:animate-spin" />Sending…</> : mail.state === "sent" ? <><Check />Sent</> : <><Mail />Email me these steps</>}
      </Button>
      {mail.state === "sent" && <p className="text-sm" role="status">Sent to {mail.text}. Open it on your phone.</p>}
      {mail.state === "failed" && <p className="text-sm" role="alert">{mail.text}</p>}
    </div>
  )
}

/** What happened to the last test call, in a line or two, with the one fix that matches it. */
function CheckResult({ status, plan }: { status: Status; plan: ForwardingPlan }) {
  if (status === "idle" || status === "passed" || status === "calling" || status === "forwards_all") return null
  if (plan.forwardsAll && status === "phone_answers") {
    // Most often they just switched to every call after the phone picked up a ring-first test: not a new failure.
    return <p role="status" className="rounded-md border border-brand-ink/15 bg-accent px-3 py-2.5 text-sm text-accent-foreground"><strong className="font-semibold">Now dial the new code above,</strong> then test again.</p>
  }
  const lines: string[] = plan.forwardsAll
    ? ["That test didn’t reach Otto.", plan.on ? "Dial the code above, then test again." : "Check forwarding is on with your phone company, then test again."]
    : status === "phone_answers"
      ? ["Your phone picked up the test itself.", settingsFix()]
      : status === "voicemail"
        ? ["Your voicemail answered the test.", redial(plan.family), ...(isAndroid ? [] : ["iPhone: turn Live Voicemail off (Settings › Apps › Phone)."])]
        : status === "you_answered"
          ? ["Someone picked up the test.", "Test again and let it ring."]
          : status === "declined"
            ? ["The test was declined and didn’t reach Otto.", redial(plan.family)]
            : ["Nothing reached Otto, so forwarding isn’t on yet.", redial(plan.family)]
  return (
    <div role="alert" className="grid gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
      <strong className="font-semibold">{lines[0]}</strong>
      {lines.slice(1).map((text) => <span key={text}>{text}</span>)}
    </div>
  )
}

function redial(family: CarrierFamily): string {
  return family === "verizon"
    ? "Dial the code again, wait for the tone, then test again."
    : family === "gsm"
      ? "Dial the code again, wait for “Succeeded,” then test again."
      : "Check forwarding is on in your phone company’s website, then test again."
}

/** The phone's own answering, by device: Live Voicemail and Screen Unknown Callers on iPhone, call screening on Android. */
function settingsFix(): string {
  if (isIphone) return "In Settings › Apps › Phone: Live Voicemail off, Screen Unknown Callers Never. Then test again."
  if (isAndroid) return "Turn off call screening in your Phone app’s settings, then test again."
  return "iPhone: Settings › Apps › Phone, Live Voicemail off, Screen Unknown Callers Never. Android: call screening off. Then test again."
}
