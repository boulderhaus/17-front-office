/**
 * A new page opens at its top. React Router keeps the window where the last page left it, so Calendar opened
 * from the bottom of Settings showed its hours with the title and date row scrolled away. Back and Forward (POP)
 * are left alone, and so is a change to the same page's ?query (a picked job, a calendar day).
 */
export function opensAtTop(input: { from: string | null; to: string; type: "POP" | "PUSH" | "REPLACE" }): boolean {
  if (input.type === "POP" || input.from === null) return false
  return input.from.replace(/\/$/, "") !== input.to.replace(/\/$/, "")
}
