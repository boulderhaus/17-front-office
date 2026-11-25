/**
 * The days Brock takes no setup calls: every US federal / Federal Reserve bank holiday, plus the day after
 * Thanksgiving, Christmas Eve and New Year's Eve. Worked out by rule for any year; no network, no list of years.
 *
 * Dates are calendar days ("2026-11-26"), read in the booking time zone by the caller. A fixed-date holiday that lands
 * on a weekend counts twice: the real date, and the weekday it's observed on (Saturday → the Friday before, Sunday →
 * the Monday after), so it's off whichever one a bank or an office closes.
 */

const cache = new Map<number, ReadonlySet<string>>();

/** Every day off that falls in `year`, as "YYYY-MM-DD". */
export function usHolidays(year: number): ReadonlySet<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const prefix = `${String(year).padStart(4, "0")}-`;
  // New Year's Day on a Saturday is observed on Dec 31 of the year before, so neighbouring years can reach into this one.
  const days = new Set([year - 1, year, year + 1].flatMap(holidaysOf).filter((day) => day.startsWith(prefix)).sort());
  cache.set(year, days);
  return days;
}

/** True when that calendar day is off. */
export function isUsHoliday(year: number, month: number, day: number): boolean {
  return usHolidays(year).has(dateKey(year, month, day));
}

function holidaysOf(year: number): string[] {
  const fixed = (month: number, day: number): string[] => {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const observed = weekday === 6 ? day - 1 : weekday === 0 ? day + 1 : day;
    return [dateKey(year, month, day), dateKey(year, month, observed)];
  };
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  return [
    ...fixed(1, 1), // New Year's Day
    dateKey(year, 1, nthWeekday(year, 1, 1, 3)), // Martin Luther King Jr. Day: third Monday of January
    dateKey(year, 2, nthWeekday(year, 2, 1, 3)), // Washington's Birthday (Presidents' Day): third Monday of February
    dateKey(year, 5, lastWeekday(year, 5, 1)), // Memorial Day: last Monday of May
    ...(year >= 2021 ? fixed(6, 19) : []), // Juneteenth, a federal holiday since 2021
    ...fixed(7, 4), // Independence Day
    dateKey(year, 9, nthWeekday(year, 9, 1, 1)), // Labor Day: first Monday of September
    dateKey(year, 10, nthWeekday(year, 10, 1, 2)), // Columbus Day / Indigenous Peoples' Day: second Monday of October
    ...fixed(11, 11), // Veterans Day
    dateKey(year, 11, thanksgiving), // Thanksgiving: fourth Thursday of November
    dateKey(year, 11, thanksgiving + 1), // the day after Thanksgiving
    dateKey(year, 12, 24), // Christmas Eve
    ...fixed(12, 25), // Christmas Day
    dateKey(year, 12, 31), // New Year's Eve
  ];
}

/** Day of the month of the `nth` `weekday` (0 = Sunday) in that month. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
}

/** Day of the month of the last `weekday` (0 = Sunday) in that month. */
function lastWeekday(year: number, month: number, weekday: number): number {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
}

/** "YYYY-MM-DD" for a calendar day; an out-of-range day (Dec 32, Jan 0) rolls into the next or previous month. */
function dateKey(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}
