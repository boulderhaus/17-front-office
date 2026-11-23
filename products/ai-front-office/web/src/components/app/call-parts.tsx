import type { ReactNode } from "react"
import { MapPin, MessageSquare, Phone, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ToneBadge } from "./bits"
import type { Tone } from "@/lib/derive"
import { formatPhone, mapsUrl } from "@/lib/format"
import type { ApiCall } from "@/lib/types"

export function CallHeader({ call, tone, label }: { call: ApiCall; tone: Tone; label: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-2xl leading-tight font-semibold tracking-tight">{call.fields.callerName ?? "Unknown caller"}</h2>
        <p className="mt-1.5 text-[15px] text-foreground/85">{call.fields.problemDescription || "No problem summary captured"}</p>
      </div>
      <ToneBadge tone={tone} className="shrink-0">{label}</ToneBadge>
    </div>
  )
}

export function SafetyNote({ call }: { call: ApiCall }) {
  if (!call.emergency?.immediateInstruction) return null
  return (
    <p className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-800">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      {call.emergency.immediateInstruction}
    </p>
  )
}

export function ContactActions({ call, extra }: { call: ApiCall; extra?: ReactNode }) {
  const address = call.fields.address?.trim() || null
  return (
    <div className="flex flex-wrap gap-2">
      {call.phone && (
        <>
          <Button size="tap" className="min-w-36 flex-1" asChild><a href={`tel:${call.phone}`}><Phone />Call back</a></Button>
          <Button size="tap" variant="outline" asChild><a href={`sms:${call.phone}`}><MessageSquare />Text</a></Button>
        </>
      )}
      {address && <Button size="tap" variant="outline" asChild><a href={mapsUrl(address)} target="_blank" rel="noreferrer"><MapPin />Map</a></Button>}
      {extra}
    </div>
  )
}

export function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="divide-y overflow-hidden rounded-xl border bg-card">
      {rows.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[104px_1fr] gap-3 px-3.5 py-2.5">
          <dt className="text-[13px] font-semibold text-muted-foreground">{key}</dt>
          <dd className="text-sm break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function phoneFact(call: ApiCall): [string, string] {
  return ["Phone", call.phone ? formatPhone(call.phone) : "Not confirmed"]
}
