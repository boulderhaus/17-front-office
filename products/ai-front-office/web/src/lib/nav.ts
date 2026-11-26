/**
 * The app's menu, as data: which items show, which one is lit, how a swipe closes the phone drawer and where
 * "‹ Settings" / "‹ Calls" goes. Pure functions, so the rules are tested without a browser.
 */

export type NavId = "calls" | "jobs" | "calendar" | "settings" | "start" | "team"

export interface NavEntry {
  id: NavId
  to: string
  label: string
  /** Calls is the home screen: lit on the home path and on a call opened from it, not on every /app path. */
  end: boolean
  badge: number
  external?: boolean
}

/**
 * Calls, Jobs, Calendar, then Settings (Start in the demo). Team members never see Settings: it is the owner's alone;
 * they get Team (their calendar and hours) in its place.
 */
export function navEntries(input: { base: string; preview: boolean; member: boolean; attention: number }): NavEntry[] {
  const { base, preview, member, attention } = input
  const entries: NavEntry[] = [
    { id: "calls", to: base, label: "Calls", end: true, badge: attention },
    { id: "jobs", to: `${base}/jobs`, label: "Jobs", end: false, badge: 0 },
    { id: "calendar", to: `${base}/calendar`, label: "Calendar", end: false, badge: 0 },
    preview
      ? { id: "start", to: "/signup", label: "Set up yours", end: false, badge: 0, external: true }
      : { id: "settings", to: `${base}/settings`, label: "Settings", end: false, badge: 0 },
  ]
  if (!member) return entries
  return [...entries.filter((entry) => entry.id !== "settings"), { id: "team", to: `${base}/team`, label: "Team", end: false, badge: 0 }]
}

/** The lit menu row for a path (no trailing slash). */
export function navActive(path: string, entry: { to: string; end: boolean }): boolean {
  if (entry.end) return path === entry.to || path.startsWith(`${entry.to}/calls/`)
  return path === entry.to || path.startsWith(`${entry.to}/`)
}

/** A swipe left on the drawer closes it: at least 60px, and mostly sideways (so scrolling the menu never closes it). */
export function swipeCloses(start: { x: number; y: number }, end: { x: number; y: number }): boolean {
  const dx = start.x - end.x
  return dx > 60 && dx > Math.abs(end.y - start.y) * 1.5
}

/**
 * Router state on links that jump into a sub-page from somewhere other than its parent list (the menu, the Alerts
 * bell, the line status). Its "‹ Settings" then goes to Settings, not back to wherever the jump started.
 */
export const JUMP = { jump: true } as const

/**
 * "‹ Calls" / "‹ Settings": one step back in history when the page was opened from its parent list (keeps the list's
 * scroll); the parent itself after a jump, or on a deep link (the first page of the visit has nowhere to go back to).
 */
export function backGoes(input: { key: string; state: unknown }): "history" | "parent" {
  if (input.key === "default") return "parent"
  const state = input.state as { jump?: unknown } | null | undefined
  return state && state.jump === true ? "parent" : "history"
}

/** The list a call was opened from: where its "‹ Jobs" goes (with the list's ?tab), and the name it shows. */
export interface CallOrigin { to: string; label: string }

/** A call opened from Jobs or Calendar says so; from anywhere else it came from Calls. */
export function callOrigin(input: { base: string; pathname: string; search: string }): CallOrigin {
  const rest = input.pathname.slice(input.base.length)
  const label = rest.startsWith("/jobs") ? "Jobs" : rest.startsWith("/calendar") ? "Calendar" : "Calls"
  return { to: `${input.pathname}${input.search}`, label }
}

/**
 * A call's back button: "‹ Jobs" back to Jobs when Jobs opened it, "‹ Calls" back to Calls when Calls did, one step
 * back in history so the list keeps its place. With no list behind it (a deep link, a text alert, a jump), Calls.
 */
export function callBack(input: { key: string; state: unknown; base: string }): CallOrigin & { history: boolean } {
  const origin = (input.state as { origin?: Partial<CallOrigin> } | null | undefined)?.origin
  if (input.key !== "default" && typeof origin?.to === "string" && typeof origin.label === "string") return { to: origin.to, label: origin.label, history: true }
  return { to: input.base, label: "Calls", history: false }
}

/** Unsaved settings stay with the settings area: moving between its pages keeps them; leaving it asks first. */
export function leavesSettings(next: { pathname: string }): boolean {
  return !/^\/app\/settings(\/|$)/.test(next.pathname)
}
