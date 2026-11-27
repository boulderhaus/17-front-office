/**
 * "Add Call Otto to your Home Screen", in the words that fit this phone. Android's Chrome can install in one tap
 * (beforeinstallprompt). iPhone can't: Apple allows no install button, so the help names the two taps, in Safari's
 * words or Chrome's (Chrome on iPhone has Add to Home Screen in its Share menu since 2023).
 */
export type InstallHelp = "installed" | "prompt" | "iphone-safari" | "iphone-chrome" | "iphone-other" | "none"

export function installHelp(input: { userAgent: string; touchMac?: boolean; standalone: boolean; canPrompt: boolean }): InstallHelp {
  if (input.standalone) return "installed"
  if (input.canPrompt) return "prompt"
  const iphone = /iPhone|iPad|iPod/.test(input.userAgent) || input.touchMac === true
  if (!iphone) return "none"
  if (/CriOS\//.test(input.userAgent)) return "iphone-chrome"
  if (/FxiOS\/|EdgiOS\/|OPiOS\/|GSA\//.test(input.userAgent)) return "iphone-other"
  return "iphone-safari"
}

/** The phone's push service didn't answer in time. */
export class SlowCheck extends Error {}
export const CHECK_MS = 8_000

/** The answer, or SlowCheck after `ms`: a browser call that never settles can't leave the card spinning. */
export function withinTime<T>(work: Promise<T>, ms = CHECK_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SlowCheck("slow")), ms)
    work.then((value) => { clearTimeout(timer); resolve(value) }, (error: unknown) => { clearTimeout(timer); reject(error) })
  })
}
