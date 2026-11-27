/** Settings > Names and words: the saved "Word: sounds like" lines as rows, and back (walk 11-26, SET-05). */
export interface WordRow { id: string; term: string; soundsLike: string }

export const wordKey = (term: string) => term.trim().replace(/\s+/g, " ").toLowerCase()

let next = 0
const newId = () => `word-${++next}`

/** One row per saved line, then one per said word that has no line yet (its "sounds like" still empty). */
export function rowsFrom(text: string, clipTerms: string[] = []): WordRow[] {
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [term, ...rest] = line.split(":")
    return { id: newId(), term: term!.trim(), soundsLike: rest.join(":").trim() }
  })
  const known = new Set(rows.map((row) => wordKey(row.term)))
  for (const term of clipTerms) if (!known.has(wordKey(term))) { rows.push({ id: newId(), term, soundsLike: "" }); known.add(wordKey(term)) }
  return rows
}

/** The lines Otto gets: only rows with both a word and how it sounds (the server drops the rest). */
export function textFrom(rows: WordRow[]): string {
  return rows.filter((row) => row.term.trim() && row.soundsLike.trim()).map((row) => `${row.term.trim()}: ${row.soundsLike.trim()}`).join("\n")
}

export const blankRow = (): WordRow => ({ id: newId(), term: "", soundsLike: "" })

/** This word's "sounds like" set in typed lines (an unsaved edit elsewhere in the list stays). */
export function withLine(text: string, term: string, soundsLike: string): string {
  const rows = rowsFrom(text)
  const row = rows.find((item) => wordKey(item.term) === wordKey(term))
  if (row) row.soundsLike = soundsLike
  else rows.push({ id: newId(), term, soundsLike })
  return textFrom(rows)
}

/** This word's "sounds like" set on its row, or a new row at the end when no row has the word any more. */
export function withHeard(rows: WordRow[], term: string, heard: string): WordRow[] {
  const at = rows.findIndex((row) => wordKey(row.term) === wordKey(term))
  if (at >= 0) return rows.map((row, index) => (index === at ? { ...row, soundsLike: heard } : row))
  return [...rows.filter((row) => row.term.trim() || row.soundsLike.trim()), { id: newId(), term, soundsLike: heard }]
}

/**
 * Rows for a saved value from outside (Save, Discard, a said word): each row keeps its id when its word is still
 * there (so a box being typed in keeps focus), and a row still being typed (no "sounds like" yet) stays.
 */
export function mergeRows(current: WordRow[], text: string, clipTerms: string[] = []): WordRow[] {
  const fresh = rowsFrom(text, clipTerms)
  const used = new Set<string>()
  const rows = fresh.map((row) => {
    const old = current.find((item) => !used.has(item.id) && item.term.trim() && wordKey(item.term) === wordKey(row.term))
    if (!old) return row
    used.add(old.id)
    return { ...row, id: old.id }
  })
  const keys = new Set(rows.map((row) => wordKey(row.term)))
  for (const row of current) if (!used.has(row.id) && !row.soundsLike.trim() && !keys.has(wordKey(row.term))) rows.push(row)
  return rows
}
