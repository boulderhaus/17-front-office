/**
 * Which list row is tied to the open call on wide screens, and where the panel goes after Done or Later.
 * One row is lit at a time, in the list it was opened from (`?from=all` means the "All calls" list).
 */

/** The lit row: the yellow tint plus an ink bar on the edge facing the panel. Hover never changes it. */
export const SELECTED_ROW = "bg-accent shadow-[inset_-4px_0_0_var(--brand-ink)] hover:bg-accent"

/** The panel's matching ink edge, facing the lit row across the gap. */
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

/** A wide attention row carries one quiet Done, except the lit row: its Done lives once, in the panel. */
export function rowShowsDone(input: { wide: boolean; selected: boolean; preview: boolean }): boolean {
  return input.wide && !input.selected && !input.preview
}

/**
 * After Done or Later in the panel: the next caller waiting (below, else above), else the first other call.
 * The panel never stays on a call that just left the list.
 */
export function nextOpenCall(actionable: readonly string[], calls: readonly string[], doneId: string): string | null {
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
  return calls.find((id) => id !== doneId) ?? null
}
