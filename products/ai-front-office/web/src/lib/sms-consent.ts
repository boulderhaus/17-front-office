/**
 * The text-alert consent box in Settings › Alerts: the exact words the old setup page showed, split around its two
 * links so the page can render them as links. Carrier-reviewed wording: never edit a character here (a test
 * rebuilds the old label from these parts and compares it byte for byte). No imports, so the server tests read it.
 */
export const SMS_CONSENT_LEAD = "Text me account notifications from Call Otto by Dutchworks LLC, like new-call and urgent-call notifications. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase. We will not share mobile information with third parties for promotional or marketing purposes. See "
export const SMS_CONSENT_TERMS = { href: "/terms", label: "Terms" } as const
export const SMS_CONSENT_JOIN = " and "
export const SMS_CONSENT_PRIVACY = { href: "/privacy", label: "Privacy" } as const
export const SMS_CONSENT_END = "."
