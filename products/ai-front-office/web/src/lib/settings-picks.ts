/**
 * Tick boxes over plain word lists. The shop stores its services and emergency words as comma lists (the voice
 * agent and triage read those); Settings shows them as boxes plus an "Other" text box. No imports, so the server
 * tests can check these too.
 */

const items = (value: string): string[] => value.split(",").map((item) => item.trim()).filter(Boolean)
const has = (list: string[], word: string): boolean => list.some((item) => item.toLowerCase() === word.toLowerCase())
const unique = (list: string[]): string[] => list.filter((item, index) => list.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index)

export interface Picks { picked: string[]; other: string; hidden: string[] }

/**
 * "What you fix": a trade is ticked when all its services are in the list (trades share some, like "Repairs").
 * "other" (the agent's catch-all) is kept, never shown; anything else goes in the Other box.
 */
export function splitServices(value: string, trades: Array<{ key: string; services: string[] }>): Picks {
  const list = items(value)
  // A trade's first service, when no other trade offers it ("Plumbing repair"), is enough to tick it: a shop set up
  // before the boxes existed opens on its own trade, not on Other (walk 11-26, SET-04).
  const ownFirst = (trade: { key: string; services: string[] }): boolean => {
    const first = trade.services[0]
    return Boolean(first) && has(list, first!) && !trades.some((other) => other.key !== trade.key && has(other.services, first!))
  }
  const picked = trades.filter((trade) => ownFirst(trade) || trade.services.every((service) => has(list, service))).map((trade) => trade.key)
  const covered = trades.filter((trade) => picked.includes(trade.key)).flatMap((trade) => trade.services)
  const hidden = list.filter((item) => item.toLowerCase() === "other")
  const other = list.filter((item) => !has(covered, item) && !has(hidden, item))
  return { picked, other: other.join(", "), hidden }
}

export function joinServices(picks: Picks, trades: Array<{ key: string; services: string[] }>): string {
  const services = trades.filter((trade) => picks.picked.includes(trade.key)).flatMap((trade) => trade.services)
  return unique([...services, ...items(picks.other), ...picks.hidden]).join(", ")
}

/**
 * "What counts as an emergency": a box is ticked when any of its words is in the list (no word is in two boxes).
 * The always-on words (gas, carbon monoxide, burning smell) are kept, never shown; the rest go in the Other box.
 */
export function splitEmergencies(value: string, choices: Array<{ key: string; words: string[]; label?: string }>, alwaysOn: string[]): Picks {
  const list = items(value)
  // A word that is a box's own name ("flooding", "no water", typed before the boxes existed) ticks that box and is
  // kept as typed, never left in Other (walk 11-26, SET-07).
  const named = (choice: { label?: string }): boolean => Boolean(choice.label) && has(list, choice.label!)
  const picked = choices.filter((choice) => named(choice) || choice.words.some((word) => has(list, word))).map((choice) => choice.key)
  const labels = choices.filter(named).map((choice) => choice.label!)
  const hidden = list.filter((item) => has(alwaysOn, item) || has(labels, item))
  const covered = choices.filter((choice) => picked.includes(choice.key)).flatMap((choice) => choice.words)
  const other = list.filter((item) => !has(covered, item) && !has(hidden, item))
  return { picked, other: other.join(", "), hidden }
}

export function joinEmergencies(picks: Picks, choices: Array<{ key: string; words: string[]; label?: string }>): string {
  const words = choices.filter((choice) => picks.picked.includes(choice.key)).flatMap((choice) => choice.words)
  // A box's own name goes when its box is unticked.
  const unticked = choices.filter((choice) => choice.label && !picks.picked.includes(choice.key)).map((choice) => choice.label!)
  return unique([...words, ...picks.hidden.filter((item) => !has(unticked, item)), ...items(picks.other)]).join(", ")
}

/** The boxes to show: the ones for the shop's trades, plus any already ticked; every box when no trade is picked. */
export function emergencyChoicesFor<T extends { key: string; trades: string[] }>(choices: T[], trades: string[], picked: string[]): T[] {
  if (trades.length === 0) return choices
  return choices.filter((choice) => picked.includes(choice.key) || choice.trades.some((trade) => trades.includes(trade)))
}

// Same rule as the server (src/domain/owner-inputs.ts; a test keeps them equal).
const NOT_A_SERVICE = /\b(?:hitm[ae]n|hit ?m[ae]n|assassination|murders?|kidnap\w*|drugs?|cocaine|heroin|fentanyl|escorts?|prostitut\w*|sex|porn\w*|weapons?|firearms?|explosives?|bombs?|launder\w*|fake ids?|counterfeit\w*|stolen)\b/i

/** One problem with the "Other" services, in words the owner can act on; null when they're fine. */
export function otherServiceProblem(list: string[]): string | null {
  if (list.length > 12) return "Keep Other to 12 services or fewer."
  for (const item of list) {
    const text = item.trim()
    if (text.length < 2 || text.length > 40) return `“${text.slice(0, 40)}” should be 2 to 40 letters, like “Pool repair”.`
    if (!/[a-z]{2}/i.test(text) || /[@<>{}[\]\\|]|https?:|www\.|\.com\b/i.test(text)) return `“${text}” doesn’t look like a service. Try something like “Pool repair”.`
    if (NOT_A_SERVICE.test(text)) return `“${text}” isn’t a service Otto can take calls for.`
  }
  return null
}

export function otherServicesProblem(other: string): string | null {
  return otherServiceProblem(items(other))
}
