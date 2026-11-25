/**
 * The recording notice, by the shop's state. In an all-party-consent state, recording a call needs everyone's OK, so
 * the notice should be on. Pure, no imports: the server picks a new shop's default with the same list.
 * Wording for Brock to sign off (NEEDS BROCK).
 */
export const ALL_PARTY_CONSENT_STATES: Readonly<Record<string, string>> = {
  CA: "California", CT: "Connecticut", DE: "Delaware", FL: "Florida", IL: "Illinois", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MT: "Montana", NV: "Nevada", NH: "New Hampshire", OR: "Oregon", PA: "Pennsylvania", WA: "Washington",
}

/** The first all-party state named in the service area ("Sarasota FL, 34236" → "FL"), or null. */
export function allPartyState(serviceArea: string): string | null {
  for (const match of serviceArea.toUpperCase().matchAll(/\b([A-Z]{2})\b/g)) if (ALL_PARTY_CONSENT_STATES[match[1]!]) return match[1]!
  return null
}

export function recordingHint(on: boolean, serviceArea: string): string {
  const state = allPartyState(serviceArea)
  if (state) {
    const name = ALL_PARTY_CONSENT_STATES[state]
    return on ? `On. ${name} needs everyone’s OK to record a call.` : `${name} needs everyone’s OK to record a call. Turn this on.`
  }
  return on ? "On: transcript only, no audio. Callers put through to you hear the notice first." : "Off: calls are saved with audio and no notice is played."
}
