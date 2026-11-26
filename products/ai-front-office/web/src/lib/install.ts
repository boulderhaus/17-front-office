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
