import type { ReactNode } from "react"
import { ChevronDown, MapPin, MessageSquare, Phone, ShieldAlert, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { useMode } from "@/lib/mode"
import { ToneBadge } from "./bits"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { Tone } from "@/lib/derive"
import { callerLabel, formatPhone, mapsUrl } from "@/lib/format"
import type { ApiCall } from "@/lib/types"
import { cn } from "@/lib/utils"

export const ASSISTANT_NAME = "Otto"

/** `page`: the call's own screen, where the caller's name is the page's one h1; in a panel beside a list it's an h2. */
export function CallHeader({ call, tone, label, page = false }: { call: ApiCall; tone: Tone; label: string; page?: boolean }) {
  const Heading = page ? "h1" : "h2"
  return (
    // ph-no-capture on every block that shows a caller's name, number or address: never sent to PostHog.
    <div className="ph-no-capture grid gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <Heading className="text-2xl leading-tight font-semibold tracking-tight">{callerLabel(call)}</Heading>
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
  /**
   * Reach out (Call, Text) and look up (Map) share the top row, each in its own color; status (Done, Later, Reopen)
   * sits below a divider, "After the call".
   */
  group: "reach" | "look" | "status"
  /** A save is in flight for this call (with `disabled`). */
  busy?: boolean
  /** A tile that opens a short menu (Later: 1 hour, 4 hours, tomorrow). */
  menu?: Array<{ label: string; onSelect: () => void }>
}

/**
 * Every call action, by kind. Top row: reach out (one filled Call Linda, a navy-outline Text) and look up (Map, a
 * beige tonal button). `reachNote` (what Call does) sits right under that row. Status below a divider, "After the
 * call": a gray-outline Done (or Reopen) and a quiet Later. Call back, Text and Map never show for likely spam.
 */
export function ActionBar({ call, extra = [], reachNote }: { call: ApiCall; extra?: Action[]; reachNote?: ReactNode }) {
  const { preview } = useMode()
  const address = call.fields.address?.trim() || null
  const spam = call.outcome === "ignored_spam"
  const actions: Action[] = []
  if (call.phone && !spam) {
    // The demo's numbers are made up: Call and Text say what they'd do instead of dialing a fake number.
    const demo = (what: string) => () => toast(`In your account, this ${what} ${call.fields.callerName?.split(" ")[0] ?? "the caller"} from your phone.`)
    actions.push({ key: "call", label: callLabel(call), icon: <Phone />, ...(preview ? { onClick: demo("calls") } : { href: `tel:${call.phone}` }), primary: true, group: "reach" })
    actions.push({ key: "text", label: "Text", icon: <MessageSquare />, ...(preview ? { onClick: demo("texts") } : { href: `sms:${call.phone}` }), group: "reach" })
  }
  if (address && !spam) actions.push({ key: "map", label: "Map", icon: <MapPin />, href: mapsUrl(address), external: true, group: "look" })
  actions.push(...extra)
  if (!actions.length) return null
  const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-ink"
  // Status buttons: the tap size (48px) on a phone or tablet, 40px with a mouse on a wide screen.
  const tile = (action: Action) => action.group === "status" ? cn(
    "inline-flex items-center justify-center transition-colors [&_svg]:size-4",
    action.menu
      ? "h-12 gap-1.5 rounded-lg px-3 text-[15px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground lg:pointer-fine:h-11"
      : "h-12 gap-2 rounded-lg border border-muted-foreground bg-card px-4 text-[15px] font-semibold hover:bg-muted lg:pointer-fine:h-11",
    focus,
    action.disabled && "pointer-events-none opacity-50",
  ) : cn(
    "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[14px] font-semibold transition-colors [&_svg]:size-5",
    action.primary
      ? "min-h-13 min-w-0 flex-1 flex-row gap-2 bg-primary text-[17px] text-primary-foreground hover:bg-primary/90"
      : action.group === "look"
        ? "min-h-13 shrink-0 flex-row gap-2 rounded-xl bg-secondary px-4 text-[15px] font-semibold text-foreground hover:bg-border"
        : "min-h-13 shrink-0 flex-row gap-2 rounded-xl border-2 border-primary bg-card px-4 text-[15px] font-semibold text-primary hover:bg-primary/5",
    focus,
    action.disabled && "pointer-events-none opacity-50",
  )
  const render = (action: Action) => action.menu ? (
    <DropdownMenu key={action.key}>
      <DropdownMenuTrigger asChild><button type="button" className={tile(action)} disabled={action.disabled} aria-busy={action.busy || undefined}>{action.icon}{action.label}{action.group === "status" && <ChevronDown />}</button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {action.menu.map((item) => <DropdownMenuItem key={item.label} className="min-h-11 text-[15px]" onSelect={item.onSelect}>{item.label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : action.href
    ? <a key={action.key} href={action.href} className={tile(action)} {...(action.external ? { target: "_blank", rel: "noreferrer" } : {})}>{action.icon}{action.label}</a>
    : <button key={action.key} type="button" className={tile(action)} disabled={action.disabled} aria-busy={action.busy || undefined} onClick={action.onClick}>{action.icon}{action.label}</button>
  const top = actions.filter((action) => action.group !== "status").sort((left, right) => Number(Boolean(right.primary)) - Number(Boolean(left.primary)))
  const status = actions.filter((action) => action.group === "status")
  return (
    <div className="ph-no-capture grid gap-3">
      {top.length > 0 && <div className="flex gap-2">{top.map(render)}</div>}
      {reachNote}
      {status.length > 0 && (
        <div className={cn("grid gap-2", top.length > 0 && "border-t pt-3")}>
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
