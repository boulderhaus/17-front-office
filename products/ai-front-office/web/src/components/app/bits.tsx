import type { ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Tone } from "@/lib/derive"
import { useMediaQuery, useMode } from "@/lib/mode"

const TONES: Record<Tone, string> = {
  danger: "border-red-200 bg-red-50 text-red-700",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  good: "border-emerald-200 bg-emerald-50 text-emerald-700",
  neutral: "border-border bg-card text-foreground",
}

export function ToneBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <Badge variant="outline" className={cn("h-6 rounded-md px-2 font-semibold", TONES[tone], className)}>{children}</Badge>
}

export function ToneDot({ tone, label }: { tone: Tone; label: string }) {
  const colors: Record<Tone, string> = { danger: "bg-red-600", warn: "bg-amber-500", good: "bg-emerald-600", neutral: "bg-stone-300" }
  return <span aria-label={label} title={label} className={cn("inline-block size-2.5 shrink-0 rounded-full", colors[tone])} />
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg bg-brand-yellow text-[13px] font-black tracking-tight text-brand-ink", className)}>CO</span>
  )
}

export function SectionTitle({ title, count, action }: { title: string; count?: number; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
        {title}
        {count !== undefined && <span className="tabular grid h-6 min-w-6 place-items-center rounded-md border bg-secondary px-1.5 text-xs font-semibold">{count}</span>}
      </h2>
      {action}
    </div>
  )
}

/** On a phone a call opens its own screen; on wide screens it opens in the side panel. */
export function CallLink({ callId, className, children }: { callId: string; className?: string; children: ReactNode }) {
  const { base } = useMode()
  const wide = useMediaQuery("(min-width: 1024px)")
  const location = useLocation()
  const to = wide ? `${location.pathname}?call=${encodeURIComponent(callId)}` : `${base}/calls/${encodeURIComponent(callId)}`
  return <Link to={to} className={className}>{children}</Link>
}

export function Empty({ title, text, image }: { title: string; text: string; image?: boolean }) {
  return (
    <div className="grid justify-items-center gap-1.5 rounded-xl border border-dashed bg-card px-5 py-7 text-center">
      {image && <img src="/assets/front-office-mascot-flat.png" alt="" width={88} height={93} className="mb-1" />}
      <strong className="text-base font-semibold">{title}</strong>
      <span className="max-w-xs text-sm text-muted-foreground">{text}</span>
    </div>
  )
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="px-4 py-3 text-sm text-muted-foreground">{children}</p>
}
