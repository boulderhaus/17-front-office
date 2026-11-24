/**
 * Done, Later and Undo for a caller's follow-up: the save, the panel move and the toast, in one fixed order.
 * Pure (no React, no fetch): the page hands in how to post, reload and toast, so the order is tested with fakes.
 */

export type TaskAction = "complete" | "reopen" | "snooze"

/**
 * Where the open call goes when a follow-up changes: `leave` runs once Done or Later saves (the panel moves on
 * before the list refreshes), `back` once Undo has reopened it (the panel returns to it), and `settle` once the
 * list has refreshed (the lit row is brought into sight if it isn't).
 */
export interface TaskMoves { leave?: () => void; back?: () => void; settle?: () => void }

export interface TaskToast {
  success: (message: string, options: { duration: number; action: { label: string; onClick: () => void } }) => void
  message: (message: string) => void
  error: (message: string) => void
}

/** One save at a time, and nothing in the moment right after one: a double-click's second half is dropped. */
export interface TaskGate { enter: () => boolean; leave: () => void }

export interface TaskDeps {
  post: (callId: string, action: TaskAction, minutes?: number) => Promise<unknown>
  reload: () => Promise<unknown>
  toast: TaskToast
  gate: TaskGate
}

/** 8 seconds: long enough to read "Marked done." and reach Undo. */
export const UNDO_MS = 8000

/** A click this soon after a save is the second half of a double-click, not a new decision about the next caller. */
export const QUIET_MS = 400

export function createTaskGate(now: () => number = Date.now, quietMs = QUIET_MS): TaskGate {
  let busy = false
  let quietUntil = 0
  return {
    enter: () => {
      if (busy || now() < quietUntil) return false
      busy = true
      return true
    },
    leave: () => {
      busy = false
      quietUntil = now() + quietMs
    },
  }
}

/**
 * Save, then move: Done and Later move the panel on (leave) before the list reloads, so it never shows the finished
 * call; Undo reloads first, then returns the panel to the call (back). Nothing moves when the save fails.
 * Resolves true when the save went through, false when it failed or was dropped by the gate.
 */
export async function runTaskAction(deps: TaskDeps, callId: string, action: TaskAction, minutes?: number, moves: TaskMoves = {}): Promise<boolean> {
  if (!deps.gate.enter()) return false
  try {
    await deps.post(callId, action, minutes)
    if (action !== "reopen") moves.leave?.()
    await deps.reload()
    if (action === "reopen") moves.back?.()
    moves.settle?.()
    if (action === "complete") {
      const undo: TaskMoves = { ...(moves.back ? { back: moves.back } : {}), ...(moves.settle ? { settle: moves.settle } : {}) }
      deps.toast.success("Marked done.", { duration: UNDO_MS, action: { label: "Undo", onClick: () => void runTaskAction(deps, callId, "reopen", undefined, undo) } })
    } else if (action === "snooze") {
      deps.toast.message("Moved to Waiting.")
    }
    return true
  } catch (error) {
    deps.toast.error(error instanceof Error ? error.message : "That didn’t save. Please try again.")
    return false
  } finally {
    deps.gate.leave()
  }
}
