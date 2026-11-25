/**
 * Day and Week: where each visit's block sits, so no block hides another. A block normally runs `span` minutes;
 * one that would run into the next visit ends where that visit starts, as long as it keeps `minSpan` minutes (room
 * for its time and name). Visits closer than that share the column side by side, Google Calendar style.
 * Input: start minutes, sorted. Output, in the same order: start/end minutes and the lane among `lanes`.
 */
export interface VisitSlot { start: number; end: number; lane: number; lanes: number }

export function layoutVisits(starts: number[], span: number, minSpan: number): VisitSlot[] {
  const slots: VisitSlot[] = starts.map((start, index) => {
    const next = starts.slice(index + 1).find((later) => later > start)
    const end = next !== undefined && next < start + span && next - start >= minSpan ? next : start + span
    return { start, end, lane: 0, lanes: 1 }
  })
  // Lanes: a group runs while blocks still overlap; each block takes the first lane free at its start.
  let group: VisitSlot[] = []
  let laneEnds: number[] = []
  const close = () => { for (const slot of group) slot.lanes = laneEnds.length; group = []; laneEnds = [] }
  for (const slot of slots) {
    if (group.length && slot.start >= Math.max(...group.map((item) => item.end))) close()
    const free = laneEnds.findIndex((end) => end <= slot.start)
    slot.lane = free === -1 ? laneEnds.length : free
    laneEnds[slot.lane] = slot.end
    group.push(slot)
  }
  close()
  return slots
}
