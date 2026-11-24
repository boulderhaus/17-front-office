import { useState, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Tone } from "@/lib/derive"
import { useMediaQuery, useMode } from "@/lib/mode"

const TONES: Record<Tone, string> = {
  danger: "bg-red-50 text-red-700 ring-red-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  good: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  neutral: "bg-secondary text-foreground/80 ring-border",
}

/** One status word per row: "Urgent", "Confirm time", "Booked", "Likely spam". */
export function ToneBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[13px] font-semibold whitespace-nowrap ring-1 ring-inset", TONES[tone], className)}>{children}</span>
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg bg-brand-yellow text-[13px] font-black tracking-tight text-brand-ink", className)}>CO</span>
  )
}

/** A section heading. The count is a solid pill so it reads at a glance. */
export function SectionTitle({ title, count, urgent, action, id }: { title: string; count?: number; urgent?: boolean; action?: ReactNode; id?: string }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3">
      <h2 id={id} className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
        {title}
        {count !== undefined && count > 0 && (
          <span className={cn("tabular grid h-6 min-w-6 place-items-center rounded-full px-2 text-[13px] font-bold text-white", urgent ? "bg-red-600" : "bg-brand-ink")}>{count}</span>
        )}
      </h2>
      {action}
    </div>
  )
}

/** A link that reads as a link: ink, semibold, a chevron, a 44px tap area. */
export function MoreLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="-mr-2 inline-flex min-h-11 items-center gap-0.5 rounded-lg px-2 text-[15px] font-semibold text-brand-ink hover:bg-muted">
      {children}<ChevronRight className="size-4" />
    </Link>
  )
}

/** One white surface with divided rows: the single container style for every list. */
export function ListBox({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("divide-y overflow-hidden rounded-xl border bg-card", className)}>{children}</div>
}

/** On a phone a call opens its own screen; on wide screens it opens in the side panel. */
export function CallLink({ callId, className, children, ...rest }: { callId: string; className?: string; children: ReactNode; "aria-current"?: boolean; style?: React.CSSProperties }) {
  const { base } = useMode()
  const wide = useMediaQuery("(min-width: 1024px)")
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  params.set("call", callId)
  const to = wide ? `${location.pathname}?${params.toString()}` : `${base}/calls/${encodeURIComponent(callId)}`
  return <Link to={to} className={className} {...rest}>{children}</Link>
}

export function Empty({ title, text, image }: { title: string; text: string; image?: boolean }) {
  return (
    <div className="grid justify-items-center gap-1.5 rounded-xl border border-dashed bg-card px-5 py-7 text-center">
      {image && <img src="/assets/front-office-mascot-flat.png" alt="" width={72} height={76} className="mb-1" />}
      <strong className="text-base font-semibold">{title}</strong>
      <span className="max-w-xs text-[15px] text-muted-foreground">{text}</span>
    </div>
  )
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="px-4 py-3.5 text-[15px] text-muted-foreground">{children}</p>
}

/** A page of a list: 10 rows, then Previous / Next with "1–10 of 23". Never an endless scroll. */
export function usePage<T>(items: T[], size = 10) {
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(items.length / size))
  const current = Math.min(page, pages - 1)
  return {
    rows: items.slice(current * size, current * size + size),
    pager: items.length > size ? <Pager page={current} pages={pages} size={size} total={items.length} onPage={setPage} /> : null,
  }
}

function Pager({ page, pages, size, total, onPage }: { page: number; pages: number; size: number; total: number; onPage: (page: number) => void }) {
  const from = page * size + 1
  const to = Math.min(total, from + size - 1)
  const button = "inline-flex h-11 items-center gap-1 rounded-lg border bg-card px-3 text-[15px] font-semibold disabled:opacity-40"
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3 pt-1">
      <button type="button" className={button} disabled={page === 0} onClick={() => onPage(page - 1)}><ChevronLeft className="size-4" />Previous</button>
      <span className="tabular text-sm text-muted-foreground">{from}–{to} of {total}</span>
      <button type="button" className={button} disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next<ChevronRight className="size-4" /></button>
    </nav>
  )
}
