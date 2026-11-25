/**
 * How the owner dials a forwarding code on this device. Pure functions (no DOM), so tests can import them.
 *
 * - iPhone (any browser): never the code in a tel: link. iOS 27 blocks forwarding codes in links with a scary
 *   "Call Forwarding Link Blocked" alert, so the owner copies the code, we try to open the Phone keypad with a bare
 *   tel: (no number), and they paste it (or type it) there.
 * - Android Chrome / Samsung Internet: a tel: link opens the dialer with the code filled in (# must be %23).
 * - Firefox on Android blocks tel: links with * or #: copy instead.
 * - A computer can't dial: show the code and a QR code that opens this page on their phone.
 */
export type DialPlatform = "iphone" | "android" | "phone" | "desktop"

export function dialPlatform(userAgent: string): DialPlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "iphone"
  if (/Android/i.test(userAgent)) return /Firefox|FxiOS|Focus/i.test(userAgent) ? "phone" : "android"
  if (/Mobi|Phone/i.test(userAgent)) return "phone"
  return "desktop"
}

/** The tel: link to render for a forwarding code on this platform, or null: only Android browsers that dial it. */
export function dialHref(platform: DialPlatform, dialLink: string | null): string | null {
  return platform === "android" && dialLink ? dialLink : null
}

/**
 * The code in chunks for reading off a screen: "**004*1 941 555 0123 **15#", "*71 941 555 0123".
 * Wrap only between chunks, never inside one.
 */
export function codeChunks(code: string): string[] {
  const match = /^(.*?)(\d{3})(\d{3})(\d{4})(\*\*\d{1,2}#|#)?$/.exec(code)
  if (!match) return [code]
  const [, prefix, area, exchange, line, suffix] = match
  const chunks = [prefix!, area!, exchange!, `${line}${suffix === "#" ? "#" : ""}`]
  if (suffix && suffix !== "#") chunks.push(suffix)
  return chunks.filter(Boolean)
}

/** The code spelled out for screen readers: "star star zero zero four ...". */
export function spokenCode(code: string): string {
  return code.split("").map((char) => (char === "*" ? "star" : char === "#" ? "pound" : char)).join(" ")
}

/** Same as the server's ringSeconds: about 6 s a ring, to the nearest 5, kept to 5–30 s (10 s when unset). */
export function ringSeconds(rings: number): number {
  if (!Number.isFinite(rings) || rings <= 0) return 10
  return Math.min(30, Math.max(5, Math.round((rings * 6) / 5) * 5))
}

/** Verizon's no-answer timer is fixed: said wherever a Verizon owner picks "Ring my phone first". */
export const VERIZON_RING_LINE = "Verizon rings about 30 seconds first. Verizon doesn’t allow less."

/** "Ring my phone first", in what the owner actually gets. Mirrors RING_CHOICES on the server (a test keeps them equal). */
export const RING_CHOICES: ReadonlyArray<{ rings: number; seconds: number; label: string }> = [
  { rings: 2, seconds: 10, label: "About 10 seconds (2 rings)" },
  { rings: 2.5, seconds: 15, label: "15 seconds (2–3 rings)" },
  { rings: 3, seconds: 20, label: "About 20 seconds (3 rings)" },
  { rings: 4, seconds: 25, label: "About 25 seconds (4 rings)" },
  { rings: 5, seconds: 30, label: "30 seconds (5 rings)" },
]

/** The choices plus a saved value from before them (6–12 rings all mean the 30-second most), so a select never drops it. */
export function ringChoicesWith(current: number): Array<{ rings: number; seconds: number; label: string }> {
  if (!Number.isFinite(current) || RING_CHOICES.some((choice) => choice.rings === current)) return [...RING_CHOICES]
  const seconds = ringSeconds(current)
  const label = seconds === 30 ? "30 seconds (the longest carriers allow)" : `About ${seconds} seconds`
  return [...RING_CHOICES, { rings: current, seconds, label }].sort((left, right) => left.rings - right.rings)
}

/** How long the page may stay in front after we ask iOS to open Phone before we say how to open it by hand. */
export const OPEN_PHONE_WAIT_MS = 1_200

/**
 * iPhone "Copy code & open Phone", all inside the one tap: copy the code, then open the Phone app's keypad with a bare
 * `tel:` (never the code itself: iOS blocks forwarding codes in links). If the page is still showing after
 * OPEN_PHONE_WAIT_MS (no visibilitychange to hidden), Phone didn't open: `onStayed` shows the one-line instruction.
 *
 * NEEDS A REAL-IPHONE CHECK: a bare tel: opened the dialer from an app (Apple forums thread 749906), but nobody has
 * confirmed it from Safari. If Safari shows an error instead, drop the tel: step and keep copy + the line.
 */
export function copyAndOpenPhone(code: string, env: {
  clipboard: { writeText: (text: string) => Promise<void> } | undefined
  location: { href: string }
  document: { readonly visibilityState: string; addEventListener: (type: "visibilitychange", listener: () => void) => void; removeEventListener: (type: "visibilitychange", listener: () => void) => void }
  setTimeout: (run: () => void, ms: number) => unknown
  onCopied: (copied: boolean) => void
  onStayed: () => void
}): void {
  if (!env.clipboard) {
    env.onCopied(false)
    env.onStayed()
    return
  }
  void env.clipboard.writeText(code).then(() => env.onCopied(true), () => env.onCopied(false))
  let left = false
  const hidden = () => { if (env.document.visibilityState === "hidden") left = true }
  env.document.addEventListener("visibilitychange", hidden)
  env.location.href = "tel:"
  env.setTimeout(() => {
    env.document.removeEventListener("visibilitychange", hidden)
    if (!left && env.document.visibilityState === "visible") env.onStayed()
  }, OPEN_PHONE_WAIT_MS)
}
