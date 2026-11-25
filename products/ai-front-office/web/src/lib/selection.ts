/**
 * Which list row is tied to the open call on wide screens, and where the panel goes after Done or Later.
 * One row is lit at a time, in the list it was opened from (`?from=all` means the "All calls" list).
 */

/** The lit row: the yellow tint plus an ink bar on the edge facing the panel. Hover never changes it. */
export const SELECTED_ROW = "bg-accent shadow-[inset_-4px_0_0_var(--brand-ink)] hover:bg-accent"

/** The panel's matching ink edge, facing the lit row across the gap (Calls only: `linked`). */
export const PANEL_EDGE = "border-l-4 border-l-brand-ink"

/** A visible ink focus ring drawn inside a list row. */
export const ROW_FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-ink"

/** A row in "Needs your attention" is lit when its call is open and it wasn't opened from "All calls". */
export function attentionRowSelected(input: { wide: boolean; panelId: string | null | undefined; callId: string; from: string | null }): boolean {
  return input.wide && input.panelId === input.callId && input.from !== "all"
}

/** A row in "All calls" is lit when it was opened from there, or when its call has no row in "Needs your attention". */
export function allCallsRowSelected(input: { panelId: string | null | undefined; callId: string; from: string | null; actionable: ReadonlySet<string> }): boolean {
  return input.panelId === input.callId && (input.from === "all" || !input.actionable.has(input.callId))
}

/**
 * A wide attention row carries one quiet Done, except the row whose call is open in the panel (lit or not, whichever
 * list it was opened from): that call's Done lives once, in the panel.
 */
export function rowShowsDone(input: { wide: boolean; open: boolean; preview: boolean }): boolean {
  return input.wide && !input.open && !input.preview
}

/**
 * Where the panel may land when nobody is left waiting: newest first, never likely spam and never a call whose
 * follow-up is already finished.
 */
export function stillOpenCalls(calls: ReadonlyArray<{ id: string; outcome: string }>, statusOf: (callId: string) => string | undefined): string[] {
  return calls.filter((call) => {
    if (call.outcome === "ignored_spam") return false
    const status = statusOf(call.id)
    return status !== "completed" && status !== "cancelled"
  }).map((call) => call.id)
}

/**
 * After Done or Later in the panel: the next caller waiting (below, else above), else the newest call still open
 * (`open`, from stillOpenCalls). Null when nothing is left: the panel says "You’re all caught up." instead of
 * showing a finished call or a robocall.
 */
export function nextOpenCall(actionable: readonly string[], open: readonly string[], doneId: string): string | null {
  const index = actionable.indexOf(doneId)
  if (index >= 0) {
    const below = actionable[index + 1]
    if (below) return below
    const above = actionable[index - 1]
    if (above) return above
  } else {
    const waiting = actionable.find((id) => id !== doneId)
    if (waiting) return waiting
  }
  return open.find((id) => id !== doneId) ?? null
}

/**
 * The Calls URL with another call open. `from` stays as it was, so someone working down "All calls" keeps seeing
 * "All calls" rows lit as the panel moves on. No call (`null`) clears `?call=`.
 */
export function panelSearch(search: string, callId: string | null): string {
  const params = new URLSearchParams(search)
  if (callId) {
    params.set("call", callId)
  } else {
    params.delete("call")
    params.delete("from")
  }
  const next = params.toString()
  return next ? `?${next}` : ""
}

/**
 * How far to scroll so a lit row sits fully between the sticky top bar and the bottom of the window.
 * Zero when it is already in view: the page only moves when the lit row would otherwise be out of sight.
 */
export function revealDelta(row: { top: number; bottom: number }, view: { top: number; bottom: number }, margin = 8): number {
  if (row.top >= view.top && row.bottom <= view.bottom) return 0
  if (row.top < view.top || row.bottom - row.top > view.bottom - view.top) return row.top - view.top - margin
  return row.bottom - view.bottom + margin
}
