/**
 * Only the newest request may land: reloads overlap (a save's reload, a poll, activation's reload), and an older
 * response arriving last must never put back what a newer one replaced (the "Ring my phone first" snap-back).
 */
export function latestOnly(): { next: () => number; isLatest: (ticket: number) => boolean } {
  let latest = 0
  return { next: () => (latest += 1), isLatest: (ticket) => ticket === latest }
}
