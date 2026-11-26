import type { ReactNode } from "react"
import { Switch } from "@/components/ui/switch"
import { money, perCall } from "@/lib/format"
import type { ApiPlan, PlanId } from "@/lib/types"
import { cn } from "@/lib/utils"

/** "$50.00": exact cents, for amounts that are charged (dialogs, totals that must match the button). */
export function cents(value: number): string {
  return `$${(value / 100).toFixed(2)}`
}

/** "Dec 26" in the shop's time zone. */
export function shortDay(iso: string, timezone: string): string {
  // A no-break space keeps "Dec 26" together at the end of a line.
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric" }).format(new Date(iso)).replace(" ", "\u00a0")
}

/** The plan plus the add-on, monthly (mirrors monthlyCents in src/domain/plans.ts). */
export function monthlyOf(plan: ApiPlan, unlimited: boolean): number {
  return unlimited && plan.unlimited ? plan.unlimited.priceCents : plan.priceCents
}

/**
 * Solo, Team and Fleet, all in plain view: price, answered calls a month and about how many people.
 * A radio group of real buttons; the picked card has the dark border.
 */
export function PlanCards({ plans, picked, onPick, currentId, disabled, columns = false }: { plans: ApiPlan[]; picked: PlanId; onPick: (id: PlanId) => void; currentId?: PlanId; disabled?: boolean; columns?: boolean }) {
  return (
    <div className={cn("grid gap-2.5", columns && "lg:grid-cols-3")} role="radiogroup" aria-label="Plans">
      {plans.map((plan) => {
        const on = picked === plan.id
        const price = <span className="tabular text-[18px] font-semibold whitespace-nowrap">{money(plan.priceCents)}<small className="text-[13px] font-medium text-muted-foreground">/mo</small></span>
        return (
          <button key={plan.id} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onPick(plan.id)}
            className={cn("grid min-h-11 content-start gap-1 rounded-xl border-2 bg-card px-4 py-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
              on ? "border-brand-ink shadow-[0_2px_0_rgba(11,37,69,.18)]" : "border-border hover:border-brand-ink/40")}>
            <span className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2.5">
                <span aria-hidden className={cn("grid size-5 shrink-0 place-items-center rounded-full border-2", on ? "border-brand-ink" : "border-brand-ink/30")}>{on && <span className="size-2.5 rounded-full bg-brand-ink" />}</span>
                <strong className="text-[17px] font-semibold">{plan.label}</strong>
                {currentId === plan.id && <span className="rounded-md bg-brand-yellow px-2 py-0.5 text-[13px] font-semibold text-brand-ink">Current</span>}
              </span>
              <span className={cn(columns && "lg:hidden")}>{price}</span>
            </span>
            {columns && <span className="hidden pl-7.5 lg:block">{price}</span>}
            <span className="grid pl-7.5 text-[15px] text-muted-foreground">
              <span className="whitespace-nowrap"><span className="tabular font-semibold text-brand-ink">{plan.includedCalls}</span> {columns ? "calls a month" : "answered calls a month"}</span>
              <span>{plan.who}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Unlimited calls: an add-on box under the plans, with a real switch, its price and one plain line. */
export function UnlimitedAddOn({ plan, checked, onCheckedChange, id, disabled }: { plan: ApiPlan; checked: boolean; onCheckedChange: (on: boolean) => void; id: string; disabled?: boolean }) {
  if (!plan.unlimited) return null
  return (
    <div className={cn("grid gap-1 rounded-xl border-2 border-dashed px-4 py-3 transition-colors", checked ? "border-brand-ink bg-brand-yellow/15" : "border-brand-ink/25")}>
      <span className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Add-on</span>
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
        <span className="flex items-center gap-3 text-[16px] font-semibold">
          <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} aria-describedby={`${id}-hint`} />
          Unlimited calls
        </span>
        <span className="tabular text-[16px] font-semibold whitespace-nowrap">+{money(plan.unlimited.addOnCents)}/mo</span>
      </label>
      <span id={`${id}-hint`} className="text-[14px] text-balance text-muted-foreground">No extra-call charges up to {plan.unlimited.fairUseCalls.toLocaleString("en-US")} calls a month. Past that, {perCall(plan.overageCentsPerCall)} each.</span>
    </div>
  )
}

/**
 * The one price summary, pinned at the bottom of the screen above its button on a phone and in the same spot on
 * a computer: the big number, the full price struck through beside it, and one line under it. It changes with
 * every pick; the button lives inside it, so the two can never disagree.
 */
export function PriceSummary({ label, big, struck, line, children, live = true, pinned = true }: { label: ReactNode; big: ReactNode; struck?: string | null; line: ReactNode; children?: ReactNode; live?: boolean; pinned?: boolean }) {
  return (
    <div className="data-[pinned=true]:sticky data-[pinned=true]:bottom-0 md:data-[pinned=true]:bottom-4 z-10 -mx-4 border-t-2 border-brand-ink/10 bg-brand-paper/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur md:mx-0 md:rounded-xl md:border-2 md:border-brand-ink/15 md:bg-card md:px-5 md:py-4 md:backdrop-blur-none" data-pinned={pinned}>
      <div className="mx-auto grid max-w-xl gap-3 md:max-w-none md:grid-cols-[1fr_auto] md:items-center md:gap-6">
        <div className="grid gap-0.5" aria-live={live ? "polite" : undefined}>
          <span className="text-[13px] font-semibold text-muted-foreground">{label}</span>
          <span className="flex flex-wrap items-baseline gap-x-2.5">
            <strong className="tabular text-[32px] leading-none font-semibold tracking-tight">{big}</strong>
            {struck && <s className="tabular text-[18px] font-medium text-muted-foreground decoration-2">{struck}</s>}
          </span>
          <span className="text-[15px] font-medium text-pretty text-brand-ink">{line}</span>
        </div>
        {children}
      </div>
    </div>
  )
}
