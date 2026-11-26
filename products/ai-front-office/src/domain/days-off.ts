/**
 * Days off: whole calendar days ("2026-12-24") in the shop's own time zone when Otto offers and books no visits.
 * A holiday is one day; a week away is one entry from its first day to its last (both included).
 * Emergencies, owner alerts and the owner's own calendar entries are not affected.
 */
export interface DayOff {
  start: string;
  end: string;
}

/** Most entries a shop keeps at once, and the longest single stretch. */
export const MAX_DAYS_OFF = 30;
export const MAX_DAYS_OFF_SPAN = 92;
/** How far ahead a day off may be set. */
const MAX_AHEAD_DAYS = 2 * 366;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isCivilDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The calendar day `at` falls on in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function dayNumber(value: string): number {
  return Math.round(Date.parse(`${value}T00:00:00.000Z`) / 86_400_000);
}

export function isDayOffDate(date: string, daysOff: readonly DayOff[] | undefined): boolean {
  return (daysOff ?? []).some((entry) => entry.start <= date && date <= entry.end);
}

/** True when the shop is off on the local day `at` falls on. */
export function isDayOff(at: Date, timeZone: string, daysOff: readonly DayOff[] | undefined): boolean {
  if (!daysOff?.length) return false;
  return isDayOffDate(localDate(at, timeZone), daysOff);
}

/** True when any part of a visit from start to end (end exclusive) lands on a day off. */
export function slotTouchesDayOff(start: Date, end: Date, timeZone: string, daysOff: readonly DayOff[] | undefined): boolean {
  if (!daysOff?.length) return false;
  return isDayOff(start, timeZone, daysOff) || isDayOff(new Date(Math.max(start.getTime(), end.getTime() - 1)), timeZone, daysOff);
}

/** The entries that are today or later, sorted. Past ones drop off on their own. */
export function upcomingDaysOff(daysOff: readonly DayOff[] | undefined, today: string): DayOff[] {
  return (daysOff ?? []).filter((entry) => entry.end >= today).map((entry) => ({ ...entry })).sort((left, right) => left.start.localeCompare(right.start) || left.end.localeCompare(right.end));
}

/** "2026-12-24" or "2026-12-24..2026-12-26", one per line: how the Settings form carries the list. */
export function formatDaysOff(daysOff: readonly DayOff[]): string {
  return daysOff.map((entry) => (entry.start === entry.end ? entry.start : `${entry.start}..${entry.end}`)).join("\n");
}

/**
 * Reads the Settings list and checks it. Entries already in the past are dropped quietly (the page could have been
 * open over midnight); anything malformed, backwards, too long or too far ahead is refused with words an owner reads.
 */
export function parseDaysOff(raw: string, today: string): DayOff[] {
  const lines = raw.split(/[\r\n,]+/).map((line) => line.trim()).filter(Boolean);
  const entries: DayOff[] = [];
  for (const line of lines) {
    const [start = "", end = start, extra] = line.split("..").map((part) => part.trim());
    if (extra !== undefined || !isCivilDate(start) || !isCivilDate(end)) throw new Error("A day off isn’t a real date. Pick it again.");
    if (end < start) throw new Error("A day off ends before it starts. Pick the dates again.");
    if (dayNumber(end) - dayNumber(start) + 1 > MAX_DAYS_OFF_SPAN) throw new Error(`Days off can be up to ${MAX_DAYS_OFF_SPAN} days in a row.`);
    if (end < today) continue;
    if (dayNumber(start) - dayNumber(today) > MAX_AHEAD_DAYS) throw new Error("Days off can be set up to two years ahead.");
    entries.push({ start, end });
  }
  const unique = [...new Map(entries.map((entry) => [`${entry.start}..${entry.end}`, entry])).values()];
  if (unique.length > MAX_DAYS_OFF) throw new Error(`You can keep up to ${MAX_DAYS_OFF} days off. Remove one first.`);
  return upcomingDaysOff(unique, today);
}
