/**
 * The recording notice, by the shop's state. In an all-party-consent state, recording a phone call may need everyone's
 * OK, so the notice is the safe choice. Pure, no imports: the server picks a new shop's default with the same list
 * and the same matching rule (src/domain/area-codes.ts; a test keeps them equal).
 * Oregon is one-party for phone calls (ORS 165.540), so it isn't listed; Michigan and Delaware are unsettled, so the
 * hint says "may". Wording for Brock to sign off (NEEDS BROCK).
 */
export const ALL_PARTY_CONSENT_STATES: Readonly<Record<string, string>> = {
  CA: "California", CT: "Connecticut", DE: "Delaware", FL: "Florida", IL: "Illinois", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MT: "Montana", NV: "Nevada", NH: "New Hampshire", PA: "Pennsylvania", WA: "Washington",
}

/**
 * The server's rule on the typed service area: the first place that ends in a two-letter state ("Sarasota FL",
 * "Sarasota, FL") names the state. A state after a ZIP only qualifies the ZIP, and a word inside a town's name
 * ("De Pere WI") is never a state.
 */
export function serviceAreaStateCode(serviceArea: string): string | null {
  const terms = serviceArea.split(/[,;\n]+/).map((term) => term.trim()).filter(Boolean)
  for (const [index, term] of terms.entries()) {
    if (/^[A-Za-z]{2}$/.test(term) && /^\d{5}$/.test(terms[index - 1] ?? "")) continue
    const match = /(?:^|\s)([A-Za-z]{2})$/.exec(term)
    if (match) return match[1]!.toUpperCase()
  }
  return null
}

/** The shop's state when it's an all-party-consent state ("Sarasota FL, 34236" → "FL"), or null. */
export function allPartyState(serviceArea: string): string | null {
  const state = serviceAreaStateCode(serviceArea)
  return state && ALL_PARTY_CONSENT_STATES[state] ? state : null
}

export function recordingHint(on: boolean, serviceArea: string): string {
  const state = allPartyState(serviceArea)
  if (state) {
    const name = ALL_PARTY_CONSENT_STATES[state]
    return on ? `On: transcript only, no audio. Safest in ${name}, where recording may need everyone’s OK.` : `${name} may need everyone’s OK to record a call. To be safe, turn this on: transcript only, no audio.`
  }
  return on ? "On: transcript only, no audio. Callers put through to you hear the notice first." : "Off: calls are saved with audio and no notice is played."
}
