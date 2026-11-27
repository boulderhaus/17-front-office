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

// The code by default, the iPhone switch only behind a quiet link: one decision and one set of words, shared with the
// phone page, the emailed steps and the setup helper (src/domain/forwarding-steps.ts).
export { forwardingClear, forwardingSteps, forwardToDigits, ringFirstNext, BACK_TO_CODE_LINK, CODE_FAILED_LINK, CODE_FAILED_LINK_DESKTOP, OLDER_IPHONE_LINE, RETRY_CODE_LINE, SETTINGS_OFF_LINE, SETTINGS_ON_STEPS, SWITCH_INSTEAD_LINE, type ForwardingSteps, type RingFirstNext } from "../../../src/domain/forwarding-steps.js"

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

/** The phone in the owner's hand, for advice about the phone's own answering. */
export type AnswerDevice = "iphone" | "android" | "other"

/**
 * Ring first, and the phone itself (or its voicemail) took our test call: the fix that needs no phone settings, said
 * first, right above the "Switch to Otto answers every call" button.
 */
export const EVERY_CALL_FIX_LINE = "Easiest fix: let Otto answer every call."

/** Where the iPhone's two answering settings live, kept on one line (no-break spaces) so a "›" never starts a line. */
export const IPHONE_PHONE_SETTINGS = "Settings\u00a0›\u00a0Apps\u00a0›\u00a0Phone"

/**
 * The phone setting that keeps ring first after such a test, in one line. Always last: under the every-call button
 * (and, for voicemail, after "dial the code again"). Never shown before a test says so. null: nothing to say here
 * (an iPhone that picked up the test gets its two settings as a short list instead).
 */
export function keepRingFirstLine(status: "phone_answers" | "voicemail", device: AnswerDevice): string | null {
  if (status === "voicemail") {
    if (device === "android") return null
    return device === "iphone" ? `Still voicemail? Turn Live Voicemail off in ${IPHONE_PHONE_SETTINGS}.` : `Still voicemail? On iPhone, turn Live Voicemail off in ${IPHONE_PHONE_SETTINGS}.`
  }
  if (device === "iphone") return null
  if (device === "android") return "To keep Ring my phone first, turn off call screening in your Phone app’s settings."
  return `To keep Ring my phone first: on iPhone, ${IPHONE_PHONE_SETTINGS}, Live Voicemail off and Screen Unknown Callers Never. On Android, call screening off.`
}

/** What the phone shows once the code goes through, said right before they dial so it never looks like an error. */
export function afterDialLine(family: string | null | undefined, platform: DialPlatform): string {
  if (family === "verizon") return "You’ll hear a tone. Hang up and come back."
  if (platform === "iphone") return "Your carrier shows a gray box that says Succeeded. Tap Dismiss and come back."
  if (platform === "desktop") return "Your phone then shows a box that says it worked. Tap Dismiss or OK."
  return "Your phone shows a message that it worked. Close it and come back."
}
