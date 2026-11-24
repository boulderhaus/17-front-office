import type { ReactNode } from "react"
import { ChevronDown, MapPin, MessageSquare, Phone, ShieldAlert, TriangleAlert } from "lucide-react"
import { ToneBadge } from "./bits"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { Tone } from "@/lib/derive"
import { formatPhone, mapsUrl } from "@/lib/format"
import type { ApiCall } from "@/lib/types"
import { cn } from "@/lib/utils"

export const ASSISTANT_NAME = "Otto"

export function CallHeader({ call, tone, label }: { call: ApiCall; tone: Tone; label: string }) {
  return (
    // ph-no-capture on every block that shows a caller's name, number or address: never sent to PostHog.
    <div className="ph-no-capture grid gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-2xl leading-tight font-semibold tracking-tight">{call.fields.callerName ?? "Unknown caller"}</h2>
        <ToneBadge tone={tone} className="mt-0.5 h-7 px-2.5 text-sm">{label}</ToneBadge>
      </div>
      <p className="text-base text-foreground/85">{call.fields.problemDescription || (call.outcome === "ignored_spam" ? "Robocall or sales pitch. Nothing to do." : "No problem summary captured")}</p>
    </div>
  )
}

export function SafetyNote({ call }: { call: ApiCall }) {
  if (!call.emergency?.immediateInstruction) return null
  return (
    <p className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-[15px] font-semibold text-red-800 ring-1 ring-red-200 ring-inset">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      {call.emergency.immediateInstruction}
    </p>
  )
}

/** Likely spam: no Call back or Text, so a robocaller never gets a call back by accident. */
export function SpamNote() {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-secondary px-3 py-2.5 text-[15px] text-foreground/85">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <span>Call Otto flagged this as likely spam. It doesn’t count toward your calls and needs no call back.</span>
    </p>
  )
}

/** "Call Linda": who you're about to call, not a generic "Call back". */
export function callLabel(call: ApiCall): string {
  const first = call.fields.callerName?.trim().split(/\s+/)[0]
  return first && first.length <= 10 ? `Call ${first}` : "Call back"
}

/**
 * What the green button really does: a tel: link. On a phone it opens the dialer and the call goes out from
 * the owner's own phone, so the customer sees the owner's number. On a computer it hands off to the computer's
 * calling app (FaceTime / iPhone on a Mac, Phone Link on Windows) or does nothing if none is set up.
 */
export function CallBackNote({ call }: { call: ApiCall }) {
  if (!call.phone || call.outcome === "ignored_spam") return null
  const name = call.fields.callerName?.trim().split(/\s+/)[0] ?? "The caller"
  return (
    <p className="ph-no-capture -mt-1 text-sm text-muted-foreground">
      <span className="lg:hidden">Calls {formatPhone(call.phone)} from your phone. {name} sees your number.</span>
      <span className="max-lg:hidden">Dials {formatPhone(call.phone)} with your computer’s calling app, or call it from your phone. {name} sees your number.</span>
    </p>
  )
}

export interface Action {
  key: string; label: string; icon: ReactNode; href?: string; external?: boolean; onClick?: () => void; primary?: boolean; disabled?: boolean
  /** Reach out (Call, Text) sits on top; status (Done, Later, Reopen) sits below a divider, "After the call". */
  group: "reach" | "status"
  /** A tile that opens a short menu (Later: 1 hour, 4 hours, tomorrow). */
  menu?: Array<{ label: string; onSelect: () => void }>
}

/**
 * Every call action, in two groups. Reach out on top: one filled primary (Call Linda) with a navy-outline Text
 * beside it. Status below a divider: a gray-outline Done (or Reopen) and a quiet Later. Seeing where the caller
 * is lives in Address (the Map link), not here. Call back and Text never show for likely spam.
 */
export function ActionBar({ call, extra = [] }: { call: ApiCall; extra?: Action[] }) {
  const spam = call.outcome === "ignored_spam"
  const actions: Action[] = []
  if (call.phone && !spam) {
    actions.push({ key: "call", label: callLabel(call), icon: <Phone />, href: `tel:${call.phone}`, primary: true, group: "reach" })
    actions.push({ key: "text", label: "Text", icon: <MessageSquare />, href: `sms:${call.phone}`, group: "reach" })
  }
  actions.push(...extra)
  if (!actions.length) return null
  const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-ink"
  const tile = (action: Action) => action.group === "status" ? cn(
    "inline-flex items-center justify-center transition-colors [&_svg]:size-4",
    action.menu
      ? "h-10 gap-1.5 rounded-lg px-3 text-[15px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
      : "h-10 gap-2 rounded-lg border border-muted-foreground bg-card px-4 text-[15px] font-semibold hover:bg-muted",
    focus,
    action.disabled && "pointer-events-none opacity-50",
  ) : cn(
    "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[14px] font-semibold transition-colors [&_svg]:size-5",
    action.primary
      ? "min-h-13 flex-row gap-2 bg-primary text-[17px] text-primary-foreground hover:bg-primary/90"
      : "min-h-13 flex-row gap-2 rounded-xl border-2 border-primary bg-card px-5 text-[15px] font-semibold text-primary hover:bg-primary/5",
    focus,
    action.disabled && "pointer-events-none opacity-50",
  )
  const render = (action: Action) => action.menu ? (
    <DropdownMenu key={action.key}>
      <DropdownMenuTrigger asChild><button type="button" className={tile(action)} disabled={action.disabled}>{action.icon}{action.label}{action.group === "status" && <ChevronDown />}</button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {action.menu.map((item) => <DropdownMenuItem key={item.label} className="min-h-11 text-[15px]" onSelect={item.onSelect}>{item.label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : action.href
    ? <a key={action.key} href={action.href} className={tile(action)} {...(action.external ? { target: "_blank", rel: "noreferrer" } : {})}>{action.icon}{action.label}</a>
    : <button key={action.key} type="button" className={tile(action)} disabled={action.disabled} onClick={action.onClick}>{action.icon}{action.label}</button>
  const reach = actions.filter((action) => action.group === "reach").sort((left, right) => Number(Boolean(right.primary)) - Number(Boolean(left.primary)))
  const status = actions.filter((action) => action.group === "status")
  return (
    <div className="ph-no-capture grid gap-3">
      {reach.length > 0 && <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">{reach.map(render)}</div>}
      {status.length > 0 && (
        <div className={cn("grid gap-2", reach.length > 0 && "border-t pt-3")}>
          <p className="text-xs font-medium text-muted-foreground">After the call</p>
          <div className="flex gap-2">{status.map(render)}</div>
        </div>
      )}
    </div>
  )
}

/** Label / value pairs. Long values wrap; nothing is joined with dots. */
export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="ph-no-capture divide-y overflow-hidden rounded-xl border bg-card">
      {rows.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[108px_1fr] gap-3 px-4 py-3">
          <dt className="text-sm text-muted-foreground">{key}</dt>
          <dd className="text-[15px] break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function phoneFact(call: ApiCall): [string, string] {
  return ["Phone", call.phone ? formatPhone(call.phone) : "Not confirmed"]
}

/** The address, then a Map link: looking up where the caller is sits with the address, not with the call buttons. */
export function addressFact(call: ApiCall): [string, ReactNode] {
  const address = call.fields.address?.trim() || null
  if (!address) return ["Address", "Not confirmed"]
  if (call.outcome === "ignored_spam") return ["Address", address]
  return ["Address", (
    <>
      {address}{" "}
      <a href={mapsUrl(address)} target="_blank" rel="noreferrer" className="-my-2.5 ml-1 inline-flex items-center gap-1 py-2.5 font-semibold text-brand-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-ink [&_svg]:size-4"><MapPin />Map</a>
    </>
  )]
}

interface Turn { speaker: "assistant" | "caller" | "other"; label: string; text: string }

const SPEAKERS: Array<[RegExp, Turn["speaker"]]> = [
  [/^(otto|ai assistant|assistant|agent|ai|call otto|front office|receptionist)\s*:\s*/i, "assistant"],
  [/^(caller|customer|user|client)\s*:\s*/i, "caller"],
]

/** "Assistant: …\nCaller: …" into turns; lines without a speaker continue the turn before them. */
export function parseTranscript(transcript: string, callerName: string | null): Turn[] {
  const turns: Turn[] = []
  for (const raw of transcript.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const match = SPEAKERS.find(([pattern]) => pattern.test(line))
    if (match) {
      const [pattern, speaker] = match
      turns.push({ speaker, label: speaker === "assistant" ? ASSISTANT_NAME : callerName ?? "Caller", text: line.replace(pattern, "") })
    } else if (turns.length) {
      turns[turns.length - 1]!.text += `\n${line}`
    } else {
      turns.push({ speaker: "other", label: "", text: line })
    }
  }
  return turns
}

/** The call, turn by turn: who spoke on its own line, clear space between speakers. */
export function Transcript({ call }: { call: ApiCall }) {
  if (!call.transcript) return <p className="text-[15px] text-muted-foreground">Transcript unavailable.</p>
  const turns = parseTranscript(call.transcript, call.fields.callerName)
  return (
    <ol className="ph-no-capture grid gap-5">
      {turns.map((turn, index) => (
        <li key={index} className={cn("grid gap-1 border-l-2 pl-3", turn.speaker === "assistant" ? "border-brand-yellow" : turn.speaker === "caller" ? "border-brand-ink/70" : "border-transparent")}>
          {turn.label && <span className={cn("text-[13px] font-semibold", turn.speaker === "assistant" ? "text-muted-foreground" : "text-foreground")}>{turn.label}</span>}
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{turn.text}</p>
        </li>
      ))}
    </ol>
  )
}
