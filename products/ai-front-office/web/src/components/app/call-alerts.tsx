import { useEffect, useState } from "react"
import { BellRing, CheckCircle2, Loader2, Share } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { useMode } from "@/lib/mode"
import { cn } from "@/lib/utils"

type State = "checking" | "unsupported" | "iphone-install" | "blocked" | "off" | "on"

const SCOPE = "/app"

function isIphone(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
}

function isInstalled(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** A computer or a phone, for the words on the card ("on this computer", "on this phone"). */
function deviceWord(): "computer" | "phone" {
  return /iPhone|iPad|iPod|Android|Mobi/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "phone" : "computer"
}

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  return bytes
}

/**
 * "Turn on call alerts on this phone": a web push the moment Call Otto takes a call, with a tap that opens it.
 * iPhone needs the app on the Home Screen first (iOS 16.4 or newer); Android and computers are one tap.
 */
export function CallAlertsCard({ className }: { className?: string }) {
  const { dashboard, preview } = useMode()
  const publicKey = dashboard?.push?.publicKey ?? null
  const [state, setState] = useState<State>("checking")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!publicKey || preview) return
    let cancelled = false
    const check = async () => {
      if (!supported()) return setState(isIphone() && !isInstalled() ? "iphone-install" : "unsupported")
      if (Notification.permission === "denied") return setState("blocked")
      // Registered up front so the tap below can ask for permission straight away (iPhone requires that).
      const registration = await navigator.serviceWorker.register("/app/sw.js", { scope: SCOPE })
      const existing = await registration.pushManager.getSubscription()
      if (!cancelled) setState(existing && Notification.permission === "granted" ? "on" : "off")
    }
    check().catch(() => { if (!cancelled) setState("unsupported") })
    return () => { cancelled = true }
  }, [publicKey, preview])

  if (!publicKey || preview) return null
  const device = deviceWord()

  const turnOn = async () => {
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off")
        return
      }
      const registration = await navigator.serviceWorker.getRegistration(SCOPE) ?? await navigator.serviceWorker.register("/app/sw.js", { scope: SCOPE })
      await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) })
      await api("/api/app/push/subscribe", { method: "POST", body: subscription.toJSON() })
      setState("on")
      toast.success(`Call alerts are on for this ${deviceWord()}.`)
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "Call alerts didn’t turn on. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const turnOff = async () => {
    setBusy(true)
    try {
      const registration = await navigator.serviceWorker.getRegistration(SCOPE)
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        await api("/api/app/push/unsubscribe", { method: "POST", body: { endpoint: subscription.endpoint } })
        await subscription.unsubscribe()
      }
      setState("off")
      toast.success(`Call alerts are off for this ${deviceWord()}.`)
    } catch {
      toast.error("That didn’t work. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cn("grid gap-3 rounded-xl border bg-card p-4", className)}>
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 size-5 shrink-0 text-brand-ink" />
        <div className="grid gap-1">
          <strong className="text-[15px] font-semibold">Call alerts on this {device}</strong>
          <span className="text-[14px] text-muted-foreground">{device === "phone" ? "Your phone buzzes the moment Call Otto takes a call. Tap the alert to see who called." : "An alert pops up the moment Call Otto takes a call. Click it to see who called."}</span>
        </div>
      </div>
      {state === "checking" && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Checking this phone…</p>}
      {state === "off" && (
        <>
          {/* The browser asks right after the tap; say so first, so its box isn't a surprise. */}
          <p className="text-[14px]">Your browser will ask to show notifications. {device === "phone" ? "Tap" : "Click"} <strong className="font-semibold">Allow</strong>.</p>
          <Button type="button" size="tap" variant="outline" className="h-12 w-full bg-card text-base" disabled={busy} onClick={() => void turnOn()}>{busy ? <Loader2 className="animate-spin" /> : <BellRing />}Turn on call alerts on this {device}</Button>
        </>
      )}
      {state === "on" && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-emerald-800"><CheckCircle2 className="size-5" />Call alerts are on for this {device}</p>
          <Button type="button" variant="link" className="h-11 px-0" disabled={busy} onClick={() => void turnOff()}>Turn off</Button>
        </div>
      )}
      {state === "iphone-install" && (
        <div className="grid gap-2 rounded-lg bg-brand-paper px-3 py-3 text-[15px]">
          <strong className="font-semibold">On iPhone, add Call Otto to your Home Screen first:</strong>
          <ol className="grid list-decimal gap-1.5 pl-5">
            <li>In Safari, tap the Share button <Share className="inline size-4 align-[-2px]" aria-label="Share" /> at the bottom of the screen.</li>
            <li>Tap <strong className="font-semibold">Add to Home Screen</strong>, then <strong className="font-semibold">Add</strong>.</li>
            <li>Open Call Otto from your Home Screen and tap <strong className="font-semibold">Turn on call alerts</strong> here.</li>
          </ol>
          <span className="text-[13px] text-muted-foreground">Needs iPhone software 16.4 or newer.</span>
        </div>
      )}
      {state === "blocked" && <p className="rounded-lg bg-amber-50 px-3 py-2.5 text-[14px] text-amber-950">Alerts are blocked for Call Otto on this phone. Turn on notifications for it in your phone’s Settings, then come back here.</p>}
      {state === "unsupported" && <p className="text-[14px] text-muted-foreground">This browser can’t show call alerts. On Android, use Chrome. On iPhone, use Safari and add Call Otto to your Home Screen.</p>}
    </div>
  )
}
