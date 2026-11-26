import { useEffect, useRef } from "react"
import { Check, Clock, TriangleAlert } from "lucide-react"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { ApiCall, ApiCallPath, ApiCallPathStep } from "@/lib/types"

/** Minutes:seconds into the call, so the checks read like a path through it. */
function callClock(at: string, startedAt: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(at) - Date.parse(startedAt)) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

const STATE_WORDS: Record<ApiCallPathStep["state"], string> = {
  done: "done",
  waiting: "waiting on you",
  flagged: "needs attention",
  current: "happening now",
  todo: "not yet",
  skipped: "skipped",
}

function Mark({ step, index, live }: { step: ApiCallPathStep; index: number | null; live: boolean }) {
  const base = "grid size-[26px] shrink-0 place-items-center rounded-full border-[1.5px] text-xs font-bold"
  if (step.state === "done") return <span className={cn(base, "border-emerald-700 bg-emerald-700 text-white")}><Check className="size-3.5" strokeWidth={3} /></span>
  if (step.state === "waiting") return <span className={cn(base, "border-amber-600 bg-amber-600 text-white")}><Clock className="size-3.5" strokeWidth={2.5} /></span>
  if (step.state === "flagged") return <span className={cn(base, "border-red-600 bg-red-600 text-white")}><TriangleAlert className="size-3.5" strokeWidth={2.5} /></span>
  if (step.state === "current") return <span className={cn(base, "border-foreground bg-card")}><i className={cn("size-2 rounded-full", live ? "animate-pulse bg-red-600" : "bg-muted-foreground")} /></span>
  return <span className={cn(base, "border-border bg-card text-muted-foreground")}>{index === null ? "" : index + 1}</span>
}

function Row({ step, index, path }: { step: ApiCallPathStep; index: number | null; path: ApiCallPath }) {
  const reached = step.state === "done" || step.state === "waiting" || step.state === "flagged"
  return (
    <li className={cn("grid min-h-10 grid-cols-[28px_1fr_auto] items-center gap-2.5 rounded-lg px-1.5 py-1", step.state === "current" && path.live && "bg-lime-50")}>
      <Mark step={step} index={index} live={path.live} />
      <span className={cn("grid min-w-0", !reached && step.state !== "current" && "text-muted-foreground")}>
        <strong className={cn("text-sm", step.state === "skipped" ? "font-medium" : "font-semibold")}>{step.label}</strong>
        {step.note && <small className="text-xs text-muted-foreground">{step.note}</small>}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {reached && step.at ? <time dateTime={step.at}>{callClock(step.at, path.startedAt)}</time> : <span className="sr-only">{STATE_WORDS[step.state]}</span>}
      </span>
    </li>
  )
}

/** Otto's path: every checkpoint of the call, checked off from what the server recorded. */
export function CallPathCard({ path, stale, onRefresh }: { path: ApiCallPath; stale?: boolean; onRefresh?: () => void }) {
  return (
    <section aria-label="Otto's path through this call" className="grid gap-2 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold">Otto’s path</h3>
        {stale ? (
          <button type="button" onClick={onRefresh} className="min-h-11 rounded-md px-2 text-[13px] font-semibold text-primary underline-offset-2 hover:underline">Refresh for the latest</button>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
            {path.live && <i className="size-2 animate-pulse rounded-full bg-red-600" />}
            {path.live ? "Live · " : "Ended · "}{path.done} of {path.steps.length}
          </span>
        )}
      </div>
      <ol className="grid gap-0.5">{path.steps.map((step, index) => <Row key={step.key} step={step} index={index} path={path} />)}</ol>
      {path.extras.length > 0 && (
        <>
          <p className="pt-1 text-[11px] font-bold tracking-wider text-muted-foreground uppercase">Also came up</p>
          <ul className="grid gap-0.5">{path.extras.map((step) => <Row key={step.key} step={step} index={null} path={path} />)}</ul>
        </>
      )}
    </section>
  )
}

/**
 * While the call is live, poll its path every two seconds (paused while the page is hidden, backing off on
 * errors and 429s). When the call ends, onEnded reloads the full record once; if polling gives up,
 * onStopped drops the Live badge so it never claims to be live when it isn't.
 */
export function useLiveCallPath(callId: string, live: boolean, onPath: (path: ApiCallPath | null, call: ApiCall | null) => void, onEnded: () => void, onStopped: () => void) {
  const handlers = useRef({ onPath, onEnded, onStopped })
  handlers.current = { onPath, onEnded, onStopped }
  useEffect(() => {
    if (!live || !callId) return
    let stopped = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (ms: number) => {
      clearTimeout(timer)
      if (!stopped) timer = setTimeout(() => void tick(), ms)
    }
    const tick = async () => {
      if (stopped || document.hidden) return
      try {
        const { path, call } = await api<{ path: ApiCallPath | null; call?: ApiCall }>(`/api/app/calls/${encodeURIComponent(callId)}/path`)
        failures = 0
        handlers.current.onPath(path, call ?? null)
        if (!path?.live) {
          stopped = true
          handlers.current.onEnded()
          return
        }
        schedule(2000)
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
          stopped = true
          handlers.current.onStopped()
          return
        }
        // Too many requests is the server asking for room, not a failure: wait and carry on.
        if (error instanceof ApiError && error.status === 429) return schedule(10000)
        failures += 1
        if (failures >= 5) {
          stopped = true
          handlers.current.onStopped()
          return
        }
        schedule(Math.min(30000, 2000 * 2 ** failures))
      }
    }
    const onVisible = () => { if (!document.hidden) schedule(0) }
    document.addEventListener("visibilitychange", onVisible)
    schedule(2000)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [callId, live])
}
