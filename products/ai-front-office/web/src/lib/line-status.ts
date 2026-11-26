/**
 * The line's state in plain words, for the menu's foot and the top of Calls. Pure, no imports, so the server tests
 * check it too. "Answering" only once a test proved calls reach Otto: picking a choice is not the same as forwarding.
 * Text alerts being off is shown separately, never folded into this label.
 */
export type LineTone = "on" | "pending" | "paused" | "warning"

export interface LineStatusInput {
  preview: boolean
  viewer: { status: string }
  shop: { paused: boolean; pausedForBilling: boolean }
  onboarding?: { completed: boolean }
  line?: LineInput
}

export interface LineInput {
  number: string | null
  mode?: string
  confirmedAt: string | null
  check: { status: string; choice?: string | null; code?: string | null }
  business: { everyCallOn: boolean; update: unknown; plan?: { on: string | null } | null }
}

/**
 * A finished test that was for another choice or code (the owner switched since): it says nothing about today's
 * setup, so it is neither shown nor counted as a failure. Tests from before choices were recorded are never stale.
 */
export function staleCheck(line: LineInput): boolean {
  const { status, choice, code } = line.check
  if (!choice || status === "calling" || status === "passed" || status === "idle") return false
  const today = line.mode === "always" ? "every-call" : "ring-first"
  return choice !== today || (code ?? null) !== (line.business.plan?.on ?? null)
}

/** The last test's result as it counts today: a stale one reads as no test. */
export function checkStatus(line: LineInput): string {
  return staleCheck(line) ? "idle" : line.check.status
}

export interface LineStatus { tone: LineTone; label: string; detail: string; to: string }

/** Forwarding is on: a test reached Otto and no later test failed (the same rule as the setup screens). */
export function forwardingOn(line: LineInput | undefined): boolean {
  return Boolean(line?.confirmedAt) && ["idle", "passed", "calling"].includes(checkStatus(line!))
}

export function lineStatus(data: LineStatusInput): LineStatus {
  const forward = "/app/start?step=forward"
  if (data.preview) return { tone: "on", label: "Answering every call", detail: "Call Otto answers every call to your business number.", to: "/demo" }
  if (data.viewer.status !== "active") return { tone: "pending", label: "Setting up your line", detail: "We turn it on as soon as it’s approved and let you know.", to: "/app/start" }
  if (data.shop.pausedForBilling) return { tone: "warning", label: "Paused for billing", detail: "Update your card in Plan and billing to turn answering back on.", to: "/app/settings/plan" }
  if (data.shop.paused) return { tone: "paused", label: "Answering paused", detail: "Call Otto isn’t answering. Turn it back on in How calls are answered.", to: "/app/settings/answering" }
  const line = data.line
  if (!line?.number) return { tone: "pending", label: "Setting up your line", detail: "We turn it on as soon as it’s approved and let you know.", to: "/app/start" }
  // Calls reach Otto, but not the way the owner picked: our test found every call forwarded, or the phone ringing first.
  const status = checkStatus(line)
  if (line.confirmedAt && status === "forwards_all") return { tone: "pending", label: "Dial your new code", detail: "Every call goes to Otto until you do.", to: forward }
  if (line.confirmedAt && status === "rings_first") return { tone: "pending", label: "Dial your new code", detail: "Your phone still rings first.", to: forward }
  if (!forwardingOn(line)) return { tone: "pending", label: "Not getting calls yet", detail: "Finish forwarding.", to: forward }
  if (line.business.update) return { tone: "pending", label: "Dial your new code", detail: "Your change is on once you dial it.", to: forward }
  if (line.business.everyCallOn) return { tone: "on", label: "Answering every call", detail: "Your phone won’t ring for these.", to: "/app/settings/answering" }
  return { tone: "on", label: "Answering calls you miss", detail: "Your phone rings first.", to: "/app/settings/answering" }
}
