import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react"
import { Check, Copy, LifeBuoy, Loader2, Phone, PhoneCall, PhoneForwarded } from "lucide-react"
import { toast } from "sonner"
import { QrCode } from "@/components/app/qr-code"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import { codeChunks, dialHref, dialPlatform, spokenCode } from "@/lib/dial"
import { formatPhone } from "@/lib/format"
import { useMode } from "@/lib/mode"
import type { ApiDashboard, CarrierFamily, ForwardingPlan } from "@/lib/types"
import { cn, tapWidth } from "@/lib/utils"

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent
const platform = dialPlatform(ua)
const isAndroid = /Android/i.test(ua)
const isIphone = platform === "iphone"

/**
 * The one screen a non-technical owner needs: confirm your business number, dial one code,
 * tap Check. Everything else (carrier, which code, verification) is our job. No phone settings up front:
 * only if our test call shows the phone answers calls itself do we offer the two ways around it.
 * `footer` lets the setup flow add its own Next / Skip row under the card.
 */
export function ForwardingCard({ dashboard, footer }: { dashboard: ApiDashboard; footer?: (state: { confirmed: boolean }) => ReactNode }) {
  const { reload } = useMode()
  const line = dashboard.line
  const business = line.business
  const [editing, setEditing] = useState(!business.number && !business.suggested)
  const [busy, setBusy] = useState<"save" | "check" | "help" | "mode" | null>(null)
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

  // "Let Otto answer every call" / "Keep my phone ringing first": switch the code, then bring the new one into view.
  const setMode = async (mode: "always" | "overflow") => {
    // "Ring me first" is any mode but every call (missed calls or after hours): only leaving every call changes it.
    if (line.mode === mode || (mode === "overflow" && line.mode !== "always")) return true
    const ok = await post("mode", "/api/app/line/mode", { mode })
    if (ok && mode === "always") {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      window.setTimeout(() => codeRef.current?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }), 50)
    }
    return ok
  }

  const confirmed = Boolean(line.confirmedAt) && (line.check.status === "idle" || line.check.status === "passed")
  const plan = business.plan
  const helpAsked = Boolean(line.helpRequestedAt)
  // The setup call rings for up to 30 s and can run 15 min; show "calling now" for the first 2 minutes.
  const helpCalling = Boolean(line.helpCall) && Date.parse(dashboard.now) - Date.parse(line.helpCall!.startedAt) < 2 * 60_000
  const asking = !editing && !business.number && Boolean(business.suggested)
  const startTest = () => void post("check", "/api/app/line/check")

  return (
    <Card className="relative gap-0 overflow-hidden border-brand-ink/15 py-0">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1.5 bg-brand-yellow" />
      <div className="grid gap-4 px-5 py-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-0.5">
            <small className="text-[13px] font-medium text-muted-foreground">Your new Call Otto number</small>
            {line.number ? (
              <strong className="tabular text-xl font-semibold tracking-tight whitespace-nowrap"><Phone className="mr-1.5 inline size-4 align-[-2px]" />{formatPhone(line.number)}</strong>
            ) : (
              <strong className="text-lg font-semibold tracking-tight text-muted-foreground">On its way</strong>
            )}
          </div>
          {confirmed && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 whitespace-nowrap py-1 text-xs font-semibold text-emerald-800"><Check className="size-3.5" />Forwarding works</span>}
        </header>

        {asking ? (
          <div className="grid gap-4 border-t pt-4">
            <p className="text-[17px] leading-snug font-semibold">Is this your current business number—the one customers call?</p>
            {/* A plain read-out, not a box: only the two buttons below are tappable. */}
            <div className="grid gap-0.5">
              <small className="text-[13px] font-medium text-muted-foreground">Your current business number</small>
              <strong className="tabular text-[28px] leading-tight font-semibold tracking-tight">{formatPhone(business.suggested!)}</strong>
            </div>
            <div className="grid gap-2.5 md:flex">
              <Button size="tap" variant="brand" className={cn(tapWidth, "h-14 text-base lg:h-12")} disabled={busy === "save"} onClick={() => void post("save", "/api/app/line/business-number", { number: business.suggested })}>
                {busy === "save" ? <><Loader2 className="motion-safe:animate-spin" />Looking up your phone company…</> : "Yes"}
              </Button>
              <Button size="tap" variant="outline" className={cn(tapWidth, "h-14 border-2 border-brand-ink bg-card text-base text-brand-ink lg:h-12")} disabled={busy === "save"} onClick={() => setEditing(true)}>No, it’s another number</Button>
            </div>
          </div>
        ) : editing ? (
          <form onSubmit={(event) => void saveNumber(event)} className="grid gap-2.5">
            <label htmlFor="business-number" className="text-[15px] font-semibold">Your current business number</label>
            <p className="-mt-1 text-sm text-muted-foreground">The one customers call today. You keep it.</p>
            <Input id="business-number" name="number" type="tel" inputMode="tel" autoComplete="tel" placeholder="Your business number" defaultValue={business.number ? formatPhone(business.number) : ""} className="h-12 text-lg md:max-w-[360px]" required autoFocus={Boolean(business.suggested)} />
            <Button size="tap" variant="brand" className={tapWidth} disabled={busy === "save"}>{busy === "save" ? <><Loader2 className="motion-safe:animate-spin" />Looking up your phone company…</> : "Next"}</Button>
          </form>
        ) : (
          <>
            <p className="text-sm">
              Forward <strong className="tabular">{formatPhone(business.number!)}</strong>
              {business.carrier?.name && business.carrier.family !== "unknown" ? <> · <span className="text-muted-foreground">{business.carrier.name}</span></> : null}
              {" "}<button type="button" className="font-semibold underline underline-offset-4" onClick={() => setEditing(true)}>Change</button>
            </p>

            {!line.number && (
              <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950" role="status">Saved. As soon as your line is on, the one code to dial shows up right here.</p>
            )}

            {line.number && (!plan || plan.family === "unknown") && (
              <div className="grid gap-2">
                <p className="text-[15px] font-semibold">Which phone company do you pay for this number?</p>
                {business.choices.map((choice) => (
                  <Button key={choice.family} type="button" size="tap" variant="outline" className={cn(tapWidth, "h-auto min-h-12 justify-start py-3 text-left whitespace-normal")} disabled={busy === "save"}
                    onClick={() => void post("save", "/api/app/line/business-number", { number: business.number, family: choice.family satisfies CarrierFamily })}>
                    {choice.label}
                  </Button>
                ))}
              </div>
            )}

            {plan && plan.family !== "unknown" && !confirmed && (
              <ol className="grid gap-5">
                <li className="grid gap-2">
                  <p className="text-[15px] font-semibold">{step(1)} {plan.on ? (plan.forwardsAll ? "On that phone, dial this code to send every call to Call Otto:" : "On that phone, dial this code:") : "Turn on forwarding with your phone company:"}</p>
                  {plan.on ? (
                    <>
                      <DialCode code={plan.on} dialLink={plan.dialLink} codeRef={codeRef} />
                      {plan.confirm && <p className="text-sm font-medium">{plan.confirm}</p>}
                      <p className="text-sm text-muted-foreground">{plan.what}</p>
                    </>
                  ) : (
                    <p className="text-sm">{plan.what}</p>
                  )}
                  {plan.tips.map((tip) => <p key={tip} className="text-[13px] text-muted-foreground">{tip}</p>)}
                </li>
                <li className="grid gap-2">
                  <p className="text-[15px] font-semibold">{step(2)} Test it</p>
                  {checking ? (
                    <p className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950" role="status">
                      <Loader2 className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin" />
                      {line.check.method === "auto"
                        ? <span><strong>Calling your phone now{callerId ? <> from <span className="whitespace-nowrap">{callerId}</span></> : null}.</strong> {plan.forwardsAll ? "Your phone shouldn’t ring. Otto picks up the test call right away." : `When it rings, tap Decline. ${declineFallback(plan)}`}</span>
                        : `From another phone, call ${formatPhone(business.number!)}, then decline it on your phone (or let it ring). We’ll show a check mark when it reaches us.`}
                    </p>
                  ) : (
                    <>
                      <CheckResult status={line.check.status} afterSec={line.check.answeredAfterSec} plan={plan} />
                      {showChoices(line.check.status, plan) && (
                        <PhoneAnswersChoices busy={busy === "mode"} onEveryCall={() => void setMode("always")} onRingFirst={() => setMode("overflow")} />
                      )}
                      {plan.forwardsAll ? (
                        <p className="text-[15px] font-semibold">Your phone shouldn’t ring. Otto picks up the test call right away.</p>
                      ) : (
                        <div className="grid gap-0.5">
                          <p className="text-[15px] font-semibold">When it rings, tap Decline. Otto should pick it up in a few seconds.</p>
                          <p className="text-sm text-muted-foreground">{declineFallback(plan)}</p>
                        </div>
                      )}
                      <Button size="tap" variant="brand" className={tapWidth} disabled={busy === "check"} onClick={startTest}>{busy === "check" ? <><Loader2 className="motion-safe:animate-spin" />Starting…</> : line.check.status === "idle" ? "Call me now" : "Test again"}</Button>
                      <p className="text-[13px] text-muted-foreground">{callerId ? `We’ll call this phone from ${callerId}. ` : "We’ll call this phone. "}When the call comes to Call Otto, you’ll see a green check.</p>
                      {line.check.status === "phone_answers" && plan.forwardsAll && (
                        <button type="button" className="inline-flex min-h-11 w-fit items-center text-left text-sm font-semibold text-brand-ink underline underline-offset-4 disabled:opacity-60" disabled={busy === "mode"} onClick={() => void setMode("overflow")}>Changed your mind? Keep my phone ringing first</button>
                      )}
                    </>
                  )}
                </li>
              </ol>
            )}

            {confirmed && (
              <div className="grid gap-2 text-sm">
                <p>{plan?.forwardsAll
                  ? `Every call to ${formatPhone(business.number!)} now goes to Call Otto. Your phone won’t ring for these; we alert you right away.`
                  : `Calls you miss on ${formatPhone(business.number!)} now come to Call Otto.${plan?.ringSeconds && !business.update ? ` Your phone rings about ${plan.ringSeconds} seconds first.` : ""}`}</p>
                {business.update && plan?.on && (
                  <div className="grid gap-2.5 border-t pt-3">
                    <p className="text-[15px] font-semibold">Dial this once to apply your new setting</p>
                    {business.update.clearFirst && <p>First dial <code className="rounded bg-muted px-1.5 py-0.5 font-mono font-semibold">{business.update.clearFirst}</code> and press Call, so your phone rings first again. Then dial:</p>}
                    <DialCode code={plan.on} dialLink={plan.dialLink} codeRef={codeRef} />
                    <p className="text-muted-foreground">{plan.what}</p>
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
                {!business.update && <button type="button" className="inline-flex min-h-11 w-fit items-center font-semibold underline underline-offset-4" disabled={busy === "check"} onClick={startTest}>Check it again</button>}
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
                <span><strong>Otto is calling you now at <span className="whitespace-nowrap">{formatPhone(line.helpCall!.to)}</span>.</strong> Pick up{callerId ? <> (it’s from <span className="whitespace-nowrap">{callerId}</span>)</> : null}. Otto, our AI setup helper, walks you through it and answers your questions.</span>
              </p>
            ) : helpAsked && !line.helpCall ? (
              <p className="flex items-center gap-2 text-sm"><Check className="size-4 text-emerald-700" />Brock, our founder, just emailed you a link to book a 10-minute call.</p>
            ) : null}
            {!helpCalling && (
              <p className="text-sm text-muted-foreground">
                <button type="button" className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-brand-ink underline underline-offset-4 disabled:opacity-60" disabled={busy === "help"} onClick={() => void post("help", "/api/app/line/help", { device: isIphone ? "iphone" : isAndroid ? "android" : "other" })}><LifeBuoy className="size-4" />{line.helpCall ? "Have Otto call me again" : "Set it up with me"}</button>
                <span className="block">Otto, our AI setup helper, calls you right now and walks you through it.</span>
              </p>
            )}
          </div>
        )}
        {footer?.({ confirmed })}
      </div>
    </Card>
  )
}

function step(n: number) {
  return <span className="tabular">{n}.</span>
}

/** The second line under "tap Decline": how long a call rings before Otto answers, honestly per carrier. */
function declineFallback(plan: ForwardingPlan): string {
  return plan.ringSeconds ? `No Decline button? Just let it ring (about ${plan.ringSeconds} seconds).` : "No Decline button? Just let it ring until it stops."
}

/** The phone answered our test itself and forwarding is still "ring me first": offer the two ways around it. */
function showChoices(status: ApiDashboard["line"]["check"]["status"], plan: ForwardingPlan): boolean {
  if (!plan.on || plan.forwardsAll) return false
  return status === "phone_answers" || (status === "voicemail" && isIphone)
}

/**
 * The code to dial, the way this device can dial it.
 * iPhone: never a tel: link (iOS blocks forwarding links with a "Call Forwarding Link Blocked" alert): copy and paste.
 * Android (not Firefox): Tap to dial opens the keypad with the code filled in. A computer: a QR code to this page.
 */
function DialCode({ code, dialLink, codeRef }: { code: string; dialLink: string | null; codeRef?: Ref<HTMLDivElement> }) {
  const href = dialHref(platform, dialLink)
  const copy = () => void navigator.clipboard?.writeText(code).then(
    () => toast.success(isIphone ? "Copied. Open Phone › Keypad, touch and hold above the numbers, tap Paste, then Call." : "Copied. Open your Phone app’s keypad, paste it, then tap Call."),
    () => toast("Type the code into your Phone app’s keypad."),
  )
  const box = (
    <div ref={codeRef} className="scroll-mt-24 rounded-xl border-2 border-brand-ink bg-brand-yellow px-2 py-3 text-center font-mono text-[17px] leading-snug font-bold select-all min-[400px]:text-xl sm:text-2xl md:max-w-[480px]">
      <span className="sr-only">{spokenCode(code)}</span>
      {/* Wrap only between chunks, never inside one ("060 / 4#" read as two numbers). */}
      <span aria-hidden>{codeChunks(code).map((chunk, index) => <Fragment key={index}>{index ? " " : ""}<span className="whitespace-nowrap">{chunk}</span></Fragment>)}</span>
    </div>
  )
  if (platform === "desktop") {
    // A computer can't dial. The QR opens this page on the phone, which shows its own way to dial.
    const here = typeof window === "undefined" ? "" : `${window.location.origin}${window.location.pathname}${window.location.search}`
    return (
      <div className="grid gap-3">
        {box}
        <div className="flex items-center gap-4 rounded-lg border bg-muted/40 p-3 md:max-w-[480px]">
          <QrCode value={here} size={132} label="QR code that opens this setup page on your phone" />
          <div className="grid gap-1 text-sm">
            <strong className="text-[15px] font-semibold">Scan with your phone’s camera</strong>
            <span className="text-muted-foreground">It opens this page on your business phone, ready to dial. Or type the code into that phone’s keypad and tap Call.</span>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="grid gap-2.5">
      {box}
      {href ? (
        <>
          <div className="grid grid-cols-2 gap-2 md:flex">
            <Button size="tap" variant="brand" className="h-14 text-base md:min-w-44 lg:h-12" asChild><a href={href}><PhoneForwarded />Tap to dial</a></Button>
            <Button size="tap" variant="outline" className="h-14 text-base md:min-w-44 lg:h-12" onClick={copy}><Copy />Copy code</Button>
          </div>
          <p className="text-sm">Your Phone app opens with the code filled in. Tap Call. Android may ask you to confirm. That’s expected.</p>
        </>
      ) : (
        <>
          <Button size="tap" variant={isIphone ? "brand" : "outline"} className={cn(tapWidth, "h-14 text-base lg:h-12")} onClick={copy}><Copy />Copy code</Button>
          {isIphone ? (
            <div className="grid gap-1 text-sm">
              <p className="font-medium">Open Phone › Keypad, touch and hold above the numbers, tap Paste, then tap Call right away.</p>
              <p className="text-muted-foreground">Or type it in.</p>
              <p className="text-[13px] text-muted-foreground">See “Call Forwarding Link Blocked”? Close the Phone app and type the code.</p>
            </div>
          ) : (
            <p className="text-sm">Open your Phone app’s keypad, paste or type the code, then tap Call.</p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Our test call was answered by the phone itself, so carrier forwarding never got a chance. Two ways out,
 * the one with no phone settings first: Otto answers every call, or turn off the phone's own answering.
 */
function PhoneAnswersChoices({ busy, onEveryCall, onRingFirst }: { busy: boolean; onEveryCall: () => void; onRingFirst: () => Promise<boolean> }) {
  const [ringFirst, setRingFirst] = useState(false)
  const settings = isIphone
    ? "Your iPhone answers unknown callers itself. Turn off Live Voicemail in Settings › Apps › Phone (and set Screen Unknown Callers to Never if it’s on), then test again."
    : isAndroid
      ? "Your phone answers unknown callers itself. Turn off automatic call screening in your Phone app’s settings, then test again."
      : "Your phone answers unknown callers itself. On iPhone: turn off Live Voicemail in Settings › Apps › Phone (and set Screen Unknown Callers to Never if it’s on). On Android: turn off automatic call screening in the Phone app’s settings. Then test again."
  return (
    <div className="grid gap-3 rounded-lg border-2 border-brand-ink/15 bg-card px-3 py-3">
      <p className="text-[15px] font-semibold">Pick one:</p>
      <div className="grid gap-1.5">
        <Button size="tap" variant="brand" className={cn(tapWidth, "h-14 text-base lg:h-12")} disabled={busy} onClick={onEveryCall}>{busy ? <Loader2 className="motion-safe:animate-spin" /> : null}Let Otto answer every call</Button>
        <p className="text-sm"><strong className="font-semibold">Best if this number is only for work. No settings to change.</strong> Your phone won’t ring for calls to this number. Otto answers every call and alerts you right away, and you call back with one tap. Calls you make and texts work like before.</p>
      </div>
      <div className="grid gap-1.5 border-t pt-3">
        <Button size="tap" variant="outline" className={cn(tapWidth, "h-14 border-2 border-brand-ink bg-card text-base text-brand-ink lg:h-12")} disabled={busy} aria-expanded={ringFirst}
          onClick={() => void onRingFirst().then((ok) => { if (ok) setRingFirst(true) })}>Keep my phone ringing first</Button>
        {ringFirst && <p className="text-sm" role="status">{settings}</p>}
      </div>
    </div>
  )
}

/** What happened to the last test call, in plain words, with the one fix that matches it. */
function CheckResult({ status, afterSec, plan }: { status: ApiDashboard["line"]["check"]["status"]; afterSec: number | null; plan: ForwardingPlan }) {
  const family = plan.family
  const redial = family === "verizon"
    ? "Dial the code again and wait for the tone, then test again."
    : family === "gsm"
      ? "Dial the code again and wait for “Setting Registration Succeeded”, then test again."
      : "In your phone company’s website or app, check forwarding is on for calls you don’t answer, then test again."
  if (status === "phone_answers" && plan.forwardsAll) {
    // They just picked "Let Otto answer every call": the new code isn't dialed yet.
    return <p role="status" className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950"><strong className="font-semibold">Now dial the new code above.</strong> Then tap Test again.</p>
  }
  const who = isIphone ? "On iPhone that’s usually Live Voicemail or call screening." : isAndroid ? "Usually that’s call screening." : "Usually that’s Live Voicemail or call screening."
  const lines: string[] | null =
    status === "phone_answers"
      ? [`Your phone answered our test call itself${afterSec !== null ? ` (in ${afterSec} second${afterSec === 1 ? "" : "s"})` : ""}, so it couldn’t forward.`, who, "Answered it yourself? Test again and tap Decline."]
      : status === "voicemail"
        ? ["Our test call went to voicemail, so it didn’t reach Call Otto.", redial, ...(isIphone ? ["If that was your iPhone’s Live Voicemail, pick one of the two fixes below."] : [])]
        : status === "declined"
          ? ["You declined the test call, but it didn’t forward.", redial]
          : status === "not_reached"
            ? ["Our test call rang and never reached Call Otto, so forwarding isn’t on yet.", redial]
            : null
  if (!lines) return null
  return (
    <div role="alert" className="grid gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
      <strong className="font-semibold">{lines[0]}</strong>
      {lines.slice(1).map((line) => <span key={line}>{line}</span>)}
    </div>
  )
}
