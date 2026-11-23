import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { Check, Copy, LifeBuoy, Loader2, Phone, PhoneForwarded } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"
import { formatPhone } from "@/lib/format"
import { useMode } from "@/lib/mode"
import type { ApiDashboard, CarrierFamily } from "@/lib/types"
import { cn, tapWidth } from "@/lib/utils"

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent
const isAndroid = /Android/i.test(ua)
const isIphone = /iPhone|iPad|iPod/i.test(ua)

/** "*719415550123" → "*71  941 555 0123": the carrier code, then the number in readable chunks. */
export function spaced(code: string): string {
  const match = /^(.*?)(\d{3})(\d{3})(\d{4})(#?)$/.exec(code)
  return match ? `${match[1]} ${match[2]} ${match[3]} ${match[4]}${match[5]}` : code
}

/**
 * The one screen a non-technical owner needs: confirm your business number, dial one code,
 * tap Check. Everything else (carrier, which code, verification) is our job.
 * `footer` lets the setup flow add its own Next / Skip row under the card.
 */
export function ForwardingCard({ dashboard, footer }: { dashboard: ApiDashboard; footer?: (state: { confirmed: boolean }) => ReactNode }) {
  const { reload } = useMode()
  const line = dashboard.line
  const business = line.business
  const [editing, setEditing] = useState(!business.number && !business.suggested)
  const [busy, setBusy] = useState<"save" | "check" | "help" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const checking = line.check.status === "calling"

  // While a check call is out, refresh until it lands or times out.
  useEffect(() => {
    if (!checking) return
    const id = window.setInterval(() => void reload().catch(() => undefined), 3000)
    return () => window.clearInterval(id)
  }, [checking, reload])

  const post = async (kind: "save" | "check" | "help", path: string, body: unknown = {}) => {
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

  const confirmed = Boolean(line.confirmedAt) && line.check.status !== "calling" && line.check.status !== "not_reached"
  const plan = business.plan
  const helpAsked = Boolean(line.helpRequestedAt)
  const asking = !editing && !business.number && Boolean(business.suggested)

  return (
    <Card className="relative gap-0 overflow-hidden border-brand-ink/15 py-0">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1.5 bg-brand-yellow" />
      <div className="grid gap-4 px-5 py-5">
        <header className="flex items-start justify-between gap-3">
          <div className="grid gap-0.5">
            <small className="text-[13px] font-medium text-muted-foreground">Your new Front Office number</small>
            {line.number ? (
              <strong className="tabular text-xl font-semibold tracking-tight"><Phone className="mr-1.5 inline size-4 align-[-2px]" />{formatPhone(line.number)}</strong>
            ) : (
              <strong className="text-lg font-semibold tracking-tight text-muted-foreground">On its way</strong>
            )}
          </div>
          {confirmed && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800"><Check className="size-3.5" />Forwarding works</span>}
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
                {busy === "save" ? <><Loader2 className="animate-spin" />Looking up your phone company…</> : "Yes"}
              </Button>
              <Button size="tap" variant="outline" className={cn(tapWidth, "h-14 border-2 border-brand-ink bg-card text-base text-brand-ink lg:h-12")} disabled={busy === "save"} onClick={() => setEditing(true)}>No, it’s another number</Button>
            </div>
          </div>
        ) : editing ? (
          <form onSubmit={(event) => void saveNumber(event)} className="grid gap-2.5">
            <label htmlFor="business-number" className="text-[15px] font-semibold">Your current business number</label>
            <p className="-mt-1 text-sm text-muted-foreground">The one customers call today. You keep it.</p>
            <Input id="business-number" name="number" type="tel" inputMode="tel" autoComplete="tel" placeholder="Your business number" defaultValue={business.number ? formatPhone(business.number) : ""} className="h-12 text-lg md:max-w-[360px]" required autoFocus={Boolean(business.suggested)} />
            <Button size="tap" variant="brand" className={tapWidth} disabled={busy === "save"}>{busy === "save" ? <><Loader2 className="animate-spin" />Looking up your phone company…</> : "Next"}</Button>
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
              <ol className="grid gap-4">
                <li className="grid gap-2">
                  <p className="text-[15px] font-semibold">1. {plan.on ? "On that phone, dial this and press Call:" : "Turn on forwarding with your phone company:"}</p>
                  {plan.on ? (
                    <>
                      <div className="rounded-xl border-2 border-brand-ink bg-brand-yellow px-4 py-3 text-center font-mono text-2xl font-bold tracking-wide break-all select-all sm:text-3xl md:max-w-[420px]" aria-label={`Dial ${plan.on.split("").join(" ")}`}>{spaced(plan.on)}</div>
                      <div className="grid grid-cols-2 gap-2 md:flex">
                        {isAndroid && plan.dialLink ? (
                          <Button size="tap" variant="brand" asChild><a href={plan.dialLink}><PhoneForwarded />Tap to dial</a></Button>
                        ) : null}
                        <Button size="tap" variant="outline" className={cn(!(isAndroid && plan.dialLink) && "col-span-2", "md:min-w-44")} onClick={() => void navigator.clipboard?.writeText(plan.on!).then(() => toast.success("Copied. Paste it in your Phone app’s keypad."), () => toast("Type the code into your Phone app’s keypad."))}><Copy />Copy code</Button>
                      </div>
                      <p className="text-sm text-muted-foreground">{plan.what} You’ll hear a beep or see a “forwarding on” message.</p>
                    </>
                  ) : (
                    <p className="text-sm">{plan.what}</p>
                  )}
                  {isIphone && plan.iphoneTip && <p className="rounded-md border bg-muted/50 px-3 py-2 text-[13px]">{plan.iphoneTip}</p>}
                  {plan.tips.map((tip) => <p key={tip} className="text-[13px] text-muted-foreground">{tip}</p>)}
                </li>
                <li className="grid gap-2">
                  <p className="text-[15px] font-semibold">2. Check it</p>
                  {checking ? (
                    <p className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950" role="status">
                      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
                      {line.check.method === "auto"
                        ? "We’re calling your business phone now. Don’t answer. Let it ring, or tap Decline."
                        : `From another phone, call ${formatPhone(business.number!)} and don’t answer it. We’ll show a check mark when it reaches us.`}
                    </p>
                  ) : (
                    <>
                      {line.check.status === "not_reached" && (
                        <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">That call didn’t reach us. Dial the code again, then check again. Or tap “Set it up with me.”</p>
                      )}
                      <Button size="tap" variant="brand" className={tapWidth} disabled={busy === "check"} onClick={() => void post("check", "/api/app/line/check")}>{busy === "check" ? <><Loader2 className="animate-spin" />Starting…</> : "Check it for me"}</Button>
                    </>
                  )}
                </li>
              </ol>
            )}

            {confirmed && (
              <div className="grid gap-2 text-sm">
                <p>Calls you miss on {formatPhone(business.number!)} now come to Front Office.</p>
                {plan?.off && (
                  <details className="group">
                    <summary className="cursor-pointer font-semibold underline underline-offset-4">How to turn forwarding off</summary>
                    <div className="mt-2 grid gap-2">
                      <p>On {formatPhone(business.number!)}, dial <code className="rounded bg-muted px-1.5 py-0.5 font-mono font-semibold">{plan.off}</code> and press Call.</p>
                      {isAndroid && plan.offDialLink && <Button size="tap" variant="outline" className={tapWidth} asChild><a href={plan.offDialLink}>Tap to dial {plan.off}</a></Button>}
                    </div>
                  </details>
                )}
                <button type="button" className="w-fit font-semibold underline underline-offset-4" disabled={busy === "check"} onClick={() => void post("check", "/api/app/line/check")}>Check it again</button>
              </div>
            )}
          </>
        )}

        {error && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">{error}</p>}

        {!confirmed && line.number && (
          <div className="border-t pt-3">
            {helpAsked ? (
              <p className="flex items-center gap-2 text-sm"><Check className="size-4 text-emerald-700" />Got it. We’ll call you within one business hour to set this up together.</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                <button type="button" className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-brand-ink underline underline-offset-4 disabled:opacity-60" disabled={busy === "help"} onClick={() => void post("help", "/api/app/line/help")}><LifeBuoy className="size-4" />Set it up with me</button>
                <span className="block">We’ll call you and set it up together.</span>
              </p>
            )}
          </div>
        )}
        {footer?.({ confirmed })}
      </div>
    </Card>
  )
}
