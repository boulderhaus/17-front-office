import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react"
import { Check, Copy, LifeBuoy, Loader2, Phone, PhoneCall, PhoneForwarded } from "lucide-react"
import { toast } from "sonner"
import { QrCode } from "@/components/app/qr-code"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import { codeChunks, copyAndOpenPhone, dialHref, dialPlatform, spokenCode, VERIZON_RING_LINE } from "@/lib/dial"
import { formatPhone } from "@/lib/format"
import { checkStatus } from "@/lib/line-status"
import { useMode } from "@/lib/mode"
import type { ApiDashboard, CarrierFamily, ForwardingPlan } from "@/lib/types"
import { cn, tapWidth } from "@/lib/utils"

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent
const platform = dialPlatform(ua)
const isAndroid = /Android/i.test(ua)
const isIphone = platform === "iphone"
/** A computer is clicked, a phone is tapped. */
const tapWord = platform === "desktop" ? "Click" : "Tap"
/** A text link that is a real button: 44px tall, underlined, with a solid focus ring (the default ring is faint). */
const linkButton = "h-auto min-h-11 w-fit justify-start px-0 text-left text-sm font-semibold whitespace-normal text-brand-ink underline focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:ring-offset-2"

type Status = ApiDashboard["line"]["check"]["status"]
/** "Otto answers every call" (forward-all) or "Ring my phone first" (any other mode: missed calls or after hours). */
type Choice = "always" | "ring"

/**
 * The one screen a non-technical owner needs: pick how calls work (every call is the default, nothing to change
 * on the phone), dial the one code for that choice, tap Call me now. Carrier, code and proof are our job.
 * `footer` lets the setup flow add its own Next / Skip row under the card.
 */
export function ForwardingCard({ dashboard, footer }: { dashboard: ApiDashboard; footer?: (state: { confirmed: boolean }) => ReactNode }) {
  const { reload } = useMode()
  const line = dashboard.line
  const business = line.business
  const [editing, setEditing] = useState(!business.number && !business.suggested)
  const [busy, setBusy] = useState<"save" | "check" | "help" | "mode" | null>(null)
  const [picking, setPicking] = useState<Choice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const codeRef = useRef<HTMLDivElement>(null)
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
  // A finished test for another choice or code says nothing about today's: it isn't shown (and isn't a failure).
  const status = checkStatus(line) as Status
  const confirmed = Boolean(line.confirmedAt) && (status === "idle" || status === "passed")
  const family = business.carrier?.family ?? null
  // "Set it up with me" was tapped in the last day (older requests are done with).
  const helpAsked = Boolean(line.helpRequestedAt) && Date.parse(dashboard.now) - Date.parse(line.helpRequestedAt!) < 24 * 60 * 60_000
  // The setup call rings for up to 30 s and can run 15 min; show "calling now" for its first 2 minutes, until it ends.
  const helpCalling = Boolean(line.helpCall && !line.helpCall.endedAt) && Date.parse(dashboard.now) - Date.parse(line.helpCall!.startedAt) < 2 * 60_000
  // What really happened: Brock's email once it's gone (a missed setup call queues it too), our team when the request
  // reached them by email, and otherwise that it didn't go anywhere. Never "we'll email you" when nothing was sent.
  const helpLine = !helpAsked || helpCalling || line.helpCall ? null
    : line.founderEmail ? founderEmailLine(line.founderEmail, dashboard.now)
      : line.helpTeam ? "Got it. We’ll get back to you within one business day."
        : null
  const helpFailed = helpAsked && !helpCalling && !line.helpCall && !line.founderEmail && !line.helpTeam
  // One tap is enough: once it reached someone, the button goes (after a setup call, "Have Otto call me again" stays).
  const helpDone = Boolean(helpLine)
  const asking = !editing && !business.number && Boolean(business.suggested)
  const startTest = () => void post("check", "/api/app/line/check")
  const cancelTest = () => void post("check", "/api/app/line/check/cancel")
  const testLabel = status === "idle" ? "Test it" : "Test again"
  const fixOffer = plan ? showFix(status, plan) : false
  const changeButton = (label: string) => <button type="button" aria-label="Change your business number" className="inline-flex min-h-11 min-w-11 items-center font-semibold whitespace-nowrap text-brand-ink underline underline-offset-4 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-brand-ink focus-visible:outline-none" onClick={() => setEditing(true)}>{label}</button>
  const change = changeButton("Change")
  // Office line leaving every call: "forward all calls" goes off in the same website, then calls not answered on.
  const officeLeaving = Boolean(business.update?.leavingEveryCall && plan && !plan.on && plan.family === "office")
  const what = plan && officeLeaving && line.number
    ? `In your phone company’s website or app, turn off forward all calls. Then forward calls you don’t answer to ${formatPhone(line.number)}.`
    : plan?.what ?? ""

  return (
    <Card className="relative gap-0 overflow-hidden border-brand-ink/15 py-0">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1.5 bg-brand-yellow" />
      <div className="grid gap-4 px-5 py-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-0.5">
            <small className="text-[13px] font-medium text-muted-foreground">Your Call Otto number</small>
            {line.number ? (
              <strong className="tabular text-xl font-semibold tracking-tight whitespace-nowrap"><Phone className="mr-1.5 inline size-4 align-[-2px]" />{formatPhone(line.number)}</strong>
            ) : (
              <strong className="text-lg font-semibold tracking-tight text-muted-foreground">On its way</strong>
            )}
          </div>
          {confirmed && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 whitespace-nowrap py-1 text-xs font-semibold text-emerald-800"><Check className="size-3.5" />Forwarding works</span>}
        </header>

        {!confirmed && <ModeChoice choice={choice} busy={busy === "mode"} locked={checking} family={family} ringFirstSeconds={business.ringFirstSeconds ?? null} onPick={(next) => { if (busy !== "mode") void setMode(next) }} />}

        {asking ? (
          <div className="grid gap-3 border-t pt-4">
            <p className="text-[17px] leading-snug font-semibold">Is this the number customers call?</p>
            <strong className="tabular text-[28px] leading-tight font-semibold tracking-tight">{formatPhone(business.suggested!)}</strong>
            {/* Two equal halves of the card on a computer, never wider than it. */}
            <div className="grid gap-2.5 md:grid-cols-2">
              <Button size="tap" variant="brand" className="h-14 w-full text-base lg:h-12" disabled={busy === "save"} onClick={() => void post("save", "/api/app/line/business-number", { number: business.suggested })}>
                {busy === "save" ? <><Loader2 className="motion-safe:animate-spin" />Looking up your phone company…</> : "Yes"}
              </Button>
              <Button size="tap" variant="outline" className="h-14 w-full border-2 border-brand-ink bg-card text-base text-brand-ink lg:h-12" disabled={busy === "save"} onClick={() => setEditing(true)}>No, it’s another number</Button>
            </div>
          </div>
        ) : editing ? (
          <form onSubmit={(event) => void saveNumber(event)} className="grid gap-2.5 border-t pt-4">
            <label htmlFor="business-number" className="text-[15px] font-semibold">The number customers call</label>
            <Input id="business-number" name="number" type="tel" inputMode="tel" autoComplete="tel" placeholder="e.g. (941) 555-0123" aria-describedby="business-number-hint" defaultValue={business.number ? formatPhone(business.number) : ""} className="h-12 text-lg md:max-w-[360px]" required autoFocus={Boolean(business.suggested)} />
            <p id="business-number-hint" className="-mt-1 text-sm text-muted-foreground">You keep it.</p>
            <Button size="tap" variant="brand" className={tapWidth} disabled={busy === "save"}>{busy === "save" ? <><Loader2 className="motion-safe:animate-spin" />Looking up your phone company…</> : "Next"}</Button>
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

            {plan && plan.family !== "unknown" && !confirmed && (
              <>
                <section className="grid gap-2.5 border-t pt-4" aria-label="Turn it on">
                  <p className="text-[15px] font-semibold">
                    {plan.on ? "Dial this on " : "For "}<span className="tabular whitespace-nowrap">{formatPhone(business.number!)}</span> · {change}
                  </p>
                  {business.update?.clearFirst && <ClearFirst code={business.update.clearFirst} dialLink={business.update.clearFirst === plan.off ? plan.offDialLink : null} />}
                  {plan.on
                    ? <DialCode code={plan.on} dialLink={plan.dialLink} codeRef={codeRef} />
                    : <p className="text-sm">{what}</p>}
                </section>

                <section className="grid gap-2.5 border-t pt-4" aria-label="Test it">
                  {checking ? (
                    <div className="grid gap-2">
                      <p className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950" role="status">
                        <Loader2 className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
                        {line.check.method === "auto"
                          ? <span><strong>Calling {formatPhone(business.number!)} now{callerId ? <> from <span className="whitespace-nowrap">{callerId}</span></> : null}.</strong> {plan.forwardsAll ? "Your phone shouldn’t ring." : "Tap Decline when it rings."}</span>
                          // Our call couldn't be placed: say so first, then the one thing to do instead.
                          : <span>{line.check.autoFailed ? <strong>We couldn’t call you. </strong> : null}Call {formatPhone(business.number!)} from another phone.{plan.forwardsAll ? " Your phone shouldn’t ring." : " Decline it on your phone."}</span>}
                      </p>
                      <Button type="button" variant="link" className={linkButton} disabled={busy === "check"} onClick={cancelTest}>Cancel</Button>
                    </div>
                  ) : (
                    <>
                      <CheckResult status={status} plan={plan} />
                      {fixOffer && (
                        <Button size="tap" variant="brand" className={cn(tapWidth, "h-14 text-base lg:h-12")} disabled={busy === "mode"} onClick={() => void switchToEveryCall()}>
                          {busy === "mode" ? <Loader2 className="motion-safe:animate-spin" /> : null}Switch to Otto answers every call
                        </Button>
                      )}
                      {plan.forwardsAll ? (
                        <p className="text-[15px] font-semibold">{tapWord} {testLabel}. Your phone won’t ring; you’ll see a green check in a few seconds.</p>
                      ) : (
                        <p className="text-[15px] font-semibold">{tapWord} {testLabel}, then tap Decline when your phone rings.</p>
                      )}
                      <div className="grid gap-1.5 md:flex md:items-center md:gap-3">
                        <Button size="tap" variant={fixOffer ? "outline" : "brand"} className={cn(tapWidth, "h-14 text-base lg:h-12", fixOffer && "border-2 border-brand-ink bg-card text-brand-ink")} disabled={busy === "check"} onClick={startTest}>
                          {busy === "check" ? <><Loader2 className="motion-safe:animate-spin" />Starting…</> : testLabel}
                        </Button>
                        {callerId && <span className="text-center text-[13px] text-muted-foreground md:text-left">From <span className="tabular whitespace-nowrap">{callerId}</span></span>}
                      </div>
                    </>
                  )}
                </section>
              </>
            )}

            {confirmed && (
              <div className="grid gap-2 text-sm">
                {/* Only what the last passed test was set up for: every call, or ring first with today's ring time.
                    Otherwise (no test recorded, or a change not tested yet) only that calls get here. */}
                <p>{business.everyCallOn
                  ? `Every call to ${formatPhone(business.number!)} now goes to Otto. Your phone won’t ring for these.`
                  : business.codeApplied
                    ? `Calls you miss on ${formatPhone(business.number!)} now go to Otto.${plan?.ringSeconds ? ` Your phone rings about ${plan.ringSeconds} seconds first.` : ""}`
                    : `Calls to ${formatPhone(business.number!)} now reach Otto.`} {changeButton("Change number")}</p>
                {business.update && plan && (
                  <div className="grid gap-2.5 border-t pt-3">
                    {/* Stays until a test passes for today's choice: the owner's choice is the source of truth. */}
                    <p className="text-[15px] font-semibold">{plan.on ? "Dial this once to apply your change" : "Apply your change"}</p>
                    {business.update.clearFirst && <ClearFirst code={business.update.clearFirst} dialLink={business.update.clearFirst === plan.off ? plan.offDialLink : null} />}
                    {plan.on ? <DialCode code={plan.on} dialLink={plan.dialLink} codeRef={codeRef} /> : <p>{what}</p>}
                    <Button size="tap" variant="outline" className={tapWidth} disabled={busy === "check"} onClick={startTest}>{busy === "check" ? <><Loader2 className="motion-safe:animate-spin" />Starting…</> : "Then test it"}</Button>
                  </div>
                )}
                {plan?.off && (
                  <details className="group">
                    <summary className="cursor-pointer font-semibold underline underline-offset-4">How to turn forwarding off</summary>
                    <div className="mt-2 grid gap-2">
                      <p>On {formatPhone(business.number!)}, dial <code className="rounded bg-muted px-1.5 py-0.5 font-mono font-semibold">{plan.off}</code> and press Call.</p>
                      {dialHref(platform, plan.offDialLink) && <Button size="tap" variant="outline" className={tapWidth} asChild><a href={dialHref(platform, plan.offDialLink)!}>Tap to dial {plan.off}</a></Button>}
                    </div>
                  </details>
                )}
                {!business.update && <Button type="button" variant="link" className={linkButton} disabled={busy === "check"} onClick={startTest}>Check it again</Button>}
              </div>
            )}
          </>
        )}

        {error && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">{error}</p>}

        {!confirmed && line.number && (
          <div className="grid gap-1.5 border-t pt-3">
            {helpCalling ? (
              <p className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950" role="status">
                <PhoneCall className="mt-0.5 size-4 shrink-0" />
                <span><strong>Otto is calling you now at <span className="whitespace-nowrap">{formatPhone(line.helpCall!.to)}</span>.</strong> Pick up{callerId ? <> (it’s from <span className="whitespace-nowrap">{callerId}</span>)</> : null}.</span>
              </p>
            ) : helpLine ? (
              <p className="flex items-start gap-2 text-sm" role="status"><Check className="mt-0.5 size-4 shrink-0 text-emerald-700" />{helpLine}</p>
            ) : helpFailed ? (
              <p className="text-sm" role="status">That didn’t reach us. Please try again.</p>
            ) : null}
            {!helpCalling && !helpDone && (
              <Button type="button" variant="link" className={linkButton} disabled={busy === "help"} onClick={() => void post("help", "/api/app/line/help", { device: isIphone ? "iphone" : isAndroid ? "android" : "other" })}>
                <LifeBuoy className="size-4" />{line.helpCall ? "Have Otto call me again" : "Set it up with me"}
              </Button>
            )}
          </div>
        )}
        {footer?.({ confirmed })}
      </div>
    </Card>
  )
}

/**
 * Leaving every call for ring first: forward-all wins over the ring-first code, so it goes off first. Said as a
 * condition (a new owner who never dialed the every-call code can skip it), with the same one-tap control as the code.
 */
function ClearFirst({ code, dialLink }: { code: string; dialLink: string | null }) {
  return (
    <div className="grid gap-2 rounded-lg border border-brand-ink/15 bg-muted/40 p-3">
      <p className="text-sm">Dialed the every-call code before? First dial <code className="rounded bg-card px-1.5 py-0.5 font-mono font-semibold">{code}</code> to clear it. Then the code below.</p>
      <DialAction code={code} dialLink={dialLink} label={code} />
    </div>
  )
}

/** What Brock's follow-up email actually was: a booking link, or (no calendar connected yet) a note asking for a reply. */
function founderEmailLine(email: { sentAt: string; link: boolean }, now: string): string {
  const just = Date.parse(now) - Date.parse(email.sentAt) < 10 * 60_000 ? "just emailed" : "emailed"
  return email.link ? `Brock, our founder, ${just} you a link to book a 10-minute call.` : `Brock, our founder, ${just} you to set up a quick call.`
}

/**
 * The two ways calls can work, every call first (the default for new shops). One short line each; the only
 * catch for each is said inline: every call means the phone won't ring, ring first on iPhone needs Live Voicemail off.
 */
function ModeChoice({ choice, busy, locked, family, ringFirstSeconds, onPick }: { choice: Choice; busy: boolean; locked: boolean; family: CarrierFamily | null; ringFirstSeconds: number | null; onPick: (choice: Choice) => void }) {
  // Verizon's timer is fixed at about 30 seconds: said plainly, since we'd rather they picked up sooner.
  const after = family === "office" ? "." : family === "verizon" ? `. ${VERIZON_RING_LINE}` : ringFirstSeconds ? ` after ${ringFirstSeconds} seconds.` : " (after 10 seconds; Verizon about 30)."
  // The business phone may be an iPhone even when this page is open on a computer; Android needs nothing extra.
  const iphoneNote = !isAndroid && family !== "office"
  const options: Array<{ id: Choice; title: string; line: string; note: string | null }> = [
    // There's still the one code to dial below; nothing else changes on the phone. An office line is set in a website.
    { id: "always", title: "Otto answers every call", line: family === "office" ? "Otto picks up right away." : "Nothing else to change on your phone.", note: "Your phone won’t ring for this number." },
    // The iPhone step shows once ring first is picked: it's the one thing to do before dialing that code.
    { id: "ring", title: "Ring my phone first", line: `Otto takes the calls you miss${after}`, note: iphoneNote && choice === "ring" ? "iPhone: turn off Live Voicemail first (Settings › Apps › Phone)." : null },
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
              {option.note && <span className="text-sm font-medium">{option.note}</span>}
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}

/**
 * Ring first, and our test call was picked up by the phone itself (or went to voicemail, which Live Voicemail can
 * look like): offer the switch to every call. On any device: the business phone may be an iPhone even when this
 * page is open on a computer.
 */
function showFix(status: Status, plan: ForwardingPlan): boolean {
  if (!plan.on || plan.forwardsAll) return false
  return status === "phone_answers" || status === "voicemail"
}

/**
 * The code to dial, the way this device can dial it: the big code, then one action and one line (DialAction).
 * A computer also gets a QR code that opens the code on the phone, signed in or not.
 */
function DialCode({ code, dialLink, codeRef }: { code: string; dialLink: string | null; codeRef?: Ref<HTMLDivElement> }) {
  const box = (
    <div ref={codeRef} className="scroll-mt-24 rounded-xl border-2 border-brand-ink bg-brand-yellow px-2 py-3 text-center font-mono text-[17px] leading-snug font-bold select-all min-[400px]:text-xl sm:text-2xl md:max-w-[480px]">
      <span className="sr-only">{spokenCode(code)}</span>
      {/* Wrap only between chunks, never inside one ("060 / 4#" read as two numbers). */}
      <span aria-hidden>{codeChunks(code).map((chunk, index) => <Fragment key={index}>{index ? " " : ""}<span className="whitespace-nowrap">{chunk}</span></Fragment>)}</span>
    </div>
  )
  return (
    <div className="grid gap-2.5">
      {box}
      <DialAction code={code} dialLink={dialLink} />
      {platform === "desktop" && <PhoneHandoff />}
    </div>
  )
}

/**
 * One tap that dials (or copies) a code, and the one line that says what's next.
 * iPhone: never the code in a tel: link (iOS blocks forwarding links with a "Call Forwarding Link Blocked" alert):
 * one tap copies it and opens the Phone keypad with a bare tel:, and they paste it there (see copyAndOpenPhone).
 * Android (not Firefox): Tap to dial opens the keypad with the code filled in. A computer: copy it.
 * `label`: a short code (##002#) names itself on the button.
 */
function DialAction({ code, dialLink, label }: { code: string; dialLink: string | null; label?: string }) {
  const href = dialHref(platform, dialLink)
  // iPhone: "type" when the copy failed; otherwise paste.
  const [stayed, setStayed] = useState<"paste" | "type" | null>(null)
  const copy = () => void navigator.clipboard?.writeText(code).then(
    () => toast.success(platform === "desktop" ? "Copied. Scan the QR, or type it on your phone." : "Copied. Paste it in your Phone app’s keypad, then tap Call."),
    () => toast(platform === "desktop" ? "Type the code on your phone’s keypad." : "Type the code into your Phone app’s keypad."),
  )
  const size = label ? "w-full md:w-fit md:min-w-44" : cn(tapWidth, "h-14 text-base lg:h-12")
  if (platform === "desktop") {
    return <Button size="tap" variant="outline" className={cn(tapWidth, "md:w-fit md:min-w-44")} onClick={copy}><Copy />{label ? `Copy ${label}` : "Copy code"}</Button>
  }
  if (href) {
    return (
      <>
        <Button size="tap" variant={label ? "outline" : "brand"} className={size} asChild><a href={href}><PhoneForwarded />{label ? `Tap to dial ${label}` : "Tap to dial"}</a></Button>
        {!label && <p className="text-sm font-medium">Then tap Call.</p>}
      </>
    )
  }
  if (isIphone) {
    // NEEDS A REAL-IPHONE CHECK (bare tel: from Safari, after the copy resolves): see copyAndOpenPhone.
    // A failed copy never leaves the page: the line below says to type it (a toast would sit behind Phone).
    const copyAndOpen = () => void copyAndOpenPhone(code, {
      clipboard: navigator.clipboard,
      location: window.location,
      document,
      setTimeout: (run, ms) => window.setTimeout(run, ms),
      onCopied: (copied) => { if (copied) toast.success("Copied."); else setStayed("type") },
      onStayed: () => setStayed("paste"),
    })
    return (
      <>
        <Button size="tap" variant={label ? "outline" : "brand"} className={size} onClick={copyAndOpen}><Copy />{label ? `Copy ${label} & open Phone` : "Copy code & open Phone"}</Button>
        {(!label || stayed) && <p className="text-sm font-medium" role="status">{stayed === "type" ? "Type it in Phone › Keypad and tap Call." : "Paste it in Phone › Keypad and tap Call."}</p>}
      </>
    )
  }
  return (
    <>
      <Button size="tap" variant={label ? "outline" : "brand"} className={size} onClick={copy}><Copy />{label ? `Copy ${label}` : "Copy code"}</Button>
      {!label && <p className="text-sm font-medium">Paste it in your Phone app’s keypad and tap Call.</p>}
    </>
  )
}

/**
 * A computer can't dial. The QR opens a short-lived signed page on the phone that shows this shop's code, with no
 * sign-in in the way. Asked for when shown, so the link is fresh.
 */
function PhoneHandoff() {
  const [link, setLink] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void api<{ url: string }>("/api/app/line/handoff", { method: "POST", body: {} }).then((result) => { if (live) setLink(result.url) }).catch(() => undefined)
    return () => { live = false }
  }, [])
  if (!link) return null
  return (
    <div className="flex items-center gap-4 rounded-lg border bg-muted/40 p-3 md:max-w-[480px]">
      <QrCode value={link} size={112} label="QR code that shows this code on your phone" />
      <p className="text-sm font-semibold">Scan with your phone’s camera to dial it there.</p>
    </div>
  )
}

/** What happened to the last test call, in a line or two, with the one fix that matches it. */
function CheckResult({ status, plan }: { status: Status; plan: ForwardingPlan }) {
  if (status === "idle" || status === "passed" || status === "calling") return null
  if (plan.forwardsAll && status === "phone_answers") {
    // Most often they just switched to every call after the phone picked up a ring-first test: not a new failure.
    return <p role="status" className="rounded-md border border-brand-ink/15 bg-accent px-3 py-2.5 text-sm text-accent-foreground"><strong className="font-semibold">Now dial the new code above,</strong> then test again.</p>
  }
  // Every call: any test that didn't reach Otto means the code isn't on yet (or they just switched to it).
  const lines: string[] = plan.forwardsAll
    ? ["That test didn’t reach Otto.", plan.on ? "Dial the code above, then test again." : "Check forwarding is on with your phone company, then test again."]
    : status === "phone_answers"
      ? ["Your phone picked up the test itself.", settingsFix()]
      : status === "voicemail"
        ? ["The test went to voicemail.", redial(plan.family), ...(isAndroid ? [] : ["iPhone: Live Voicemail on? Turn it off (Settings › Apps › Phone)."])]
        : status === "you_answered"
          ? ["Someone picked up the test.", "Test again and tap Decline."]
          : status === "declined"
            ? ["You declined, but it didn’t forward.", redial(plan.family)]
            : ["That test didn’t reach Otto.", redial(plan.family)]
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
      ? "Dial the code again, wait for “Setting Registration Succeeded,” then test again."
      : "Check forwarding is on in your phone company’s website, then test again."
}

/** The phone's own answering, by device: Live Voicemail and Screen Unknown Callers on iPhone, call screening on Android. */
function settingsFix(): string {
  if (isIphone) return "In Settings › Apps › Phone: Live Voicemail off, Screen Unknown Callers Never. Then test again."
  if (isAndroid) return "Turn off call screening in your Phone app’s settings, then test again."
  return "iPhone: turn off Live Voicemail (Settings › Apps › Phone). Android: turn off call screening. Then test again."
}
