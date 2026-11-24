import type { ReactNode } from "react"
import { MapPin, MessageSquare, Phone, ShieldAlert, TriangleAlert } from "lucide-react"
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
  /** A tile that opens a short menu (Later: 1 hour, 4 hours, tomorrow). */
  menu?: Array<{ label: string; onSelect: () => void }>
}

/**
 * Every call action in one row of equal tiles: same width, same height, icon over label, primary first.
 * Call back and Text never show for likely spam.
 */
export function ActionBar({ call, extra = [] }: { call: ApiCall; extra?: Action[] }) {
  const address = call.fields.address?.trim() || null
  const spam = call.outcome === "ignored_spam"
  const actions: Action[] = []
  if (call.phone && !spam) {
    actions.push({ key: "call", label: callLabel(call), icon: <Phone />, href: `tel:${call.phone}`, primary: true })
    actions.push({ key: "text", label: "Text", icon: <MessageSquare />, href: `sms:${call.phone}` })
  }
  if (address && !spam) actions.push({ key: "map", label: "Map", icon: <MapPin />, href: mapsUrl(address), external: true })
  actions.push(...extra)
  if (!actions.length) return null
  const tile = (action: Action) => cn(
    "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[14px] font-semibold transition-colors [&_svg]:size-5",
    action.primary ? "min-h-13 flex-row gap-2 bg-primary text-[17px] text-primary-foreground hover:bg-primary/90" : "border bg-card text-foreground hover:bg-muted",
    action.disabled && "pointer-events-none opacity-50",
  )
  const render = (action: Action) => action.menu ? (
    <DropdownMenu key={action.key}>
      <DropdownMenuTrigger asChild><button type="button" className={tile(action)} disabled={action.disabled}>{action.icon}{action.label}</button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {action.menu.map((item) => <DropdownMenuItem key={item.label} className="min-h-11 text-[15px]" onSelect={item.onSelect}>{item.label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : action.href
    ? <a key={action.key} href={action.href} className={tile(action)} {...(action.external ? { target: "_blank", rel: "noreferrer" } : {})}>{action.icon}{action.label}</a>
    : <button key={action.key} type="button" className={tile(action)} disabled={action.disabled} onClick={action.onClick}>{action.icon}{action.label}</button>
  const primary = actions.filter((action) => action.primary)
  const rest = actions.filter((action) => !action.primary)
  // One obvious primary (Call Linda) across the full width; every other action an equal tile below it.
  return (
    <div className="ph-no-capture grid gap-2">
      {primary.map(render)}
      {rest.length > 0 && <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${rest.length}, minmax(0, 1fr))` }}>{rest.map(render)}</div>}
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
