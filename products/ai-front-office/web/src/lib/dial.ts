/**
 * How the owner dials a forwarding code on this device. Pure functions (no DOM), so tests can import them.
 *
 * - iPhone (any browser): never a tel: link at all. iOS 27 blocks forwarding codes in links ("Call Forwarding Link
 *   Blocked"), and a bare tel: shows an empty Call sheet whose Call does nothing (the Nov 26 walk). The button copies
 *   the code and one line says exactly where to paste it.
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

/**
 * Copy a code from a tap: the Clipboard API first, then the old hidden-textarea copy (`fallback`) for browsers that
 * refuse it. Never navigates anywhere. True when it was copied.
 */
export async function copyText(text: string, env: { clipboard: { writeText: (text: string) => Promise<void> } | undefined; fallback: (text: string) => boolean }): Promise<boolean> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text)
      return true
    } catch {
      // Denied or not allowed here: try the old way below.
    }
  }
  try {
    return env.fallback(text)
  } catch {
    return false
  }
}

/** Where to put a copied code, on this device, in one line. */
export function pasteLine(platform: DialPlatform): string {
  if (platform === "iphone") return "Open Phone, tap Keypad, press and hold the number line, tap Paste, then Call."
  if (platform === "desktop") return "On your phone: open Phone, tap Keypad, type the code, then Call."
  return "Open your Phone app’s keypad, paste the code, then Call."
}

/** What the phone shows once the code goes through, said right before they dial so it never looks like an error. */
export function afterDialLine(family: string | null | undefined, platform: DialPlatform): string {
  if (family === "verizon") return "You’ll hear a tone. Hang up and come back."
  if (platform === "iphone") return "Your carrier shows a gray box that says Succeeded. Tap Dismiss and come back."
  if (platform === "desktop") return "Your phone then shows a box that says it worked. Tap Dismiss or OK."
  return "Your phone shows a message that it worked. Close it and come back."
}
