/**
 * "What Otto does on a call" (Settings > How calls are answered): the rows of the card and the "Ask every caller"
 * questions, as plain data so they can be tested without a browser. The server holds the real rules
 * (src/domain/call-steps.ts); the names here are the settings API's.
 */

export interface StepRow {
  /** The settings value this switch saves. */
  field: string
  label: string
  /** One line: what the caller gets with the switch on, and with it off. */
  on: string
  off: string
}

/** Always on, shown with a lock and no switch. */
export const LOCKED_STEPS: Array<{ key: string; label: string; line: string }> = [
  { key: "safety", label: "Safety check", line: "For gas, smoke or carbon monoxide, Otto tells the caller to leave and call 911, and alerts you right away." },
  { key: "caller", label: "Name, number and problem", line: "Otto always takes these, so you can call back." },
]

export const STEP_ROWS: StepRow[] = [
  { field: "stepScreenSalesCalls", label: "End sales calls", on: "Otto says goodbye to sales calls, robocalls and wrong numbers.", off: "Otto takes a message from everyone." },
  { field: "stepAskAddress", label: "Ask for the address", on: "Otto asks where the job is.", off: "Otto never asks for an address." },
  { field: "stepCheckServiceArea", label: "Check your service area", on: "Otto checks the address against where you work.", off: "Otto takes a job at any address." },
  { field: "stepOfferTimes", label: "Offer appointment times", on: "Otto offers your open times.", off: "Otto takes the details and says you’ll call back." },
  { field: "stepQuotePrices", label: "Give your prices", on: "Otto reads the prices you saved, word for word.", off: "Otto never gives a price. It takes a message." },
  { field: "stepAnswerQuestions", label: "Answer common questions", on: "Otto answers from the answers you saved.", off: "Otto takes a message instead." },
]

/** Live transfer: shown only where it is turned on for this account. */
export const TRANSFER_ROW: StepRow = { field: "warmTransferEnabled", label: "Put callers through to you", on: "When a caller asks for a person, Otto rings your mobile and connects them.", off: "When a caller asks for a person, Otto says you’ll call back." }

export interface StepState { checked: boolean; disabled: boolean; hint: string }

/** The prices row, off, while the service-call fee question (Calendar > Booking) is on. */
export const PRICES_OFF_FEE_ON_HINT = "Otto never gives a price. Bookings wait for your OK while “Get a yes to your service-call fee” is on."

/**
 * A row as it shows: the service-area check needs the address, so it is off and locked while the address is off
 * (the saved choice comes back with the address). Prices off while the service-call fee question is on means
 * every booking waits for the owner's OK, and the row says so.
 */
export function stepState(row: StepRow, flag: (field: string) => boolean): StepState {
  if (row.field === "stepCheckServiceArea" && !flag("stepAskAddress")) return { checked: false, disabled: true, hint: "Off, because Otto isn’t asking for the address." }
  const checked = flag(row.field)
  // Prices off while the fee question is on (Calendar > Booking): Otto can't read the fee, so it books nothing itself.
  if (row.field === "stepQuotePrices" && !checked && flag("requireDiagnosticFeeAcceptance") && flag("stepOfferTimes")) return { checked, disabled: false, hint: PRICES_OFF_FEE_ON_HINT }
  return { checked, disabled: false, hint: checked ? row.on : row.off }
}

export const MAX_QUESTIONS = 3
export const MAX_QUESTION_LENGTH = 80

/** The saved questions (one per line) as rows to edit; always at least one row, so there is a box to type in. */
export function questionRows(stored: string): string[] {
  const rows = stored.split("\n").map((line) => line.trim()).filter(Boolean)
  return rows.length > 0 ? rows : [""]
}

/** Rows back to what is saved: trimmed, empty rows dropped. A line break can't be typed in a one-line box, but a paste could carry one. */
export function joinQuestions(rows: string[]): string {
  return rows.map((row) => row.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")
}

/** A question's length as the server counts it: trimmed, runs of spaces as one. */
export function questionLength(text: string): number {
  return text.replace(/\s+/g, " ").trim().length
}

/** The fix, when a question is too long to save; null when it fits. */
export function questionProblem(text: string, max: number = MAX_QUESTION_LENGTH): string | null {
  const length = questionLength(text)
  return length > max ? `That’s ${length} characters. Shorten it to ${max} or less.` : null
}

/** The card's one line of help: how many, and where in the call Otto asks them. */
export function questionsLine(max: number, asksAddress: boolean, offersTimes: boolean): string {
  return `Up to ${max} short questions. Otto asks them after ${asksAddress ? "the address" : "the callback number"}${offersTimes ? ", before offering times" : ""}.`
}
