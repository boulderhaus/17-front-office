import { describe, expect, it } from "vitest";
import { founderSlotAllowed, founderSlots, parseBookingWindows } from "../src/domain/founder-booking.js";
import { isUsHoliday, usHolidays } from "../src/domain/us-holidays.js";

const WINDOWS = parseBookingWindows("Mon-Fri 10:00-12:00,14:00-17:00");
const NY = "America/New_York";
const days = (slots: Array<{ start: string }>, timeZone = NY): string[] =>
  [...new Set(slots.map((slot) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(slot.start))))];

describe("US bank holidays, by rule", () => {
  it("2026: every federal holiday, the observed Friday for Saturday's July 4, and the extra days off", () => {
    expect([...usHolidays(2026)]).toEqual([
      "2026-01-01", // New Year's Day (Thu)
      "2026-01-19", // MLK Day
      "2026-02-16", // Presidents' Day
      "2026-05-25", // Memorial Day
      "2026-06-19", // Juneteenth (Fri)
      "2026-07-03", // Independence Day observed (Fri)
      "2026-07-04", // Independence Day (Sat)
      "2026-09-07", // Labor Day
      "2026-10-12", // Columbus / Indigenous Peoples' Day
      "2026-11-11", // Veterans Day (Wed)
      "2026-11-26", // Thanksgiving
      "2026-11-27", // the day after
      "2026-12-24", // Christmas Eve
      "2026-12-25", // Christmas (Fri)
      "2026-12-31", // New Year's Eve
    ]);
  });

  it("2027: weekend holidays count on the real date and the observed weekday", () => {
    expect([...usHolidays(2027)]).toEqual([
      "2027-01-01", // New Year's Day (Fri)
      "2027-01-18", // MLK Day
      "2027-02-15", // Presidents' Day
      "2027-05-31", // Memorial Day
      "2027-06-18", // Juneteenth observed (Fri)
      "2027-06-19", // Juneteenth (Sat)
      "2027-07-04", // Independence Day (Sun)
      "2027-07-05", // Independence Day observed (Mon)
      "2027-09-06", // Labor Day
      "2027-10-11", // Columbus / Indigenous Peoples' Day
      "2027-11-11", // Veterans Day (Thu)
      "2027-11-25", // Thanksgiving
      "2027-11-26", // the day after
      "2027-12-24", // Christmas Eve, and Christmas observed (Fri)
      "2027-12-25", // Christmas (Sat)
      "2027-12-31", // New Year's Eve, and Jan 1 2028 (Sat) observed
    ]);
  });

  it("a Saturday New Year's Day is observed on Dec 31 of the year before; a Sunday Christmas on the Monday after", () => {
    // Jan 1 2028 and Jan 1 2033 are Saturdays.
    expect(usHolidays(2028).has("2028-01-01")).toBe(true);
    expect(usHolidays(2028).has("2027-12-31")).toBe(false);
    expect(usHolidays(2027).has("2027-12-31")).toBe(true);
    expect(usHolidays(2032).has("2032-12-31")).toBe(true);
    // Dec 25 2033 is a Sunday: Monday Dec 26 is off too; Christmas Eve (Sat) stays as it is.
    expect(usHolidays(2033).has("2033-12-26")).toBe(true);
    expect(usHolidays(2033).has("2033-12-24")).toBe(true);
    // Every year: one Thanksgiving on the fourth Thursday, and the Friday after.
    for (let year = 2024; year <= 2040; year += 1) {
      const november = [...usHolidays(year)].filter((day) => day.startsWith(`${year}-11-`) && day !== `${year}-11-11` && day !== `${year}-11-10` && day !== `${year}-11-12`);
      expect(november, String(year)).toHaveLength(2);
      const [thursday, friday] = november.map((day) => new Date(`${day}T12:00:00Z`));
      expect(thursday!.getUTCDay(), String(year)).toBe(4);
      expect(thursday!.getUTCDate(), String(year)).toBeGreaterThanOrEqual(22);
      expect(thursday!.getUTCDate(), String(year)).toBeLessThanOrEqual(28);
      expect(friday!.getUTCDay(), String(year)).toBe(5);
    }
  });

  it("ordinary days are not holidays", () => {
    expect(isUsHoliday(2026, 11, 25)).toBe(false);
    expect(isUsHoliday(2026, 11, 30)).toBe(false);
    expect(isUsHoliday(2026, 12, 23)).toBe(false);
    expect(isUsHoliday(2026, 11, 26)).toBe(true);
    expect(isUsHoliday(2027, 1, 1)).toBe(true);
  });
});

describe("Brock's setup-call times skip holidays", () => {
  it("on Wednesday Nov 25 2026 after the last window, nothing on Thanksgiving or the day after: the first day is Monday Nov 30", () => {
    // 5:00 PM EST Wednesday.
    const slots = founderSlots({ now: new Date("2026-11-25T22:00:00Z"), windows: WINDOWS, timeZone: NY });
    expect(days(slots)).toEqual(["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"]);
    expect(slots).toHaveLength(15);
  });

  it("on Wednesday Nov 25 2026 in the morning, Wednesday is still open and the next day offered is Monday Nov 30", () => {
    // 9:00 AM EST Wednesday.
    const slots = founderSlots({ now: new Date("2026-11-25T14:00:00Z"), windows: WINDOWS, timeZone: NY });
    expect(days(slots)).toEqual(["2026-11-25", "2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03"]);
    expect(slots.some((slot) => slot.start.startsWith("2026-11-26") || slot.start.startsWith("2026-11-27"))).toBe(false);
  });

  it("across Christmas and New Year's: skips Dec 24, 25, 31 and Jan 1", () => {
    // Tuesday Dec 22 2026, 5:00 PM EST.
    const slots = founderSlots({ now: new Date("2026-12-22T22:00:00Z"), windows: WINDOWS, timeZone: NY, days: 6 });
    expect(days(slots)).toEqual(["2026-12-23", "2026-12-28", "2026-12-29", "2026-12-30", "2027-01-04", "2027-01-05"]);
  });

  it("reads the holiday on Brock's calendar, not UTC's: 7:00 PM Eastern on Wednesday is already Thursday in UTC", () => {
    // Evening windows that cross midnight UTC. Wednesday Nov 25 7:00-8:00 PM EST is 00:00-01:00 UTC on the 26th.
    const evenings = parseBookingWindows("Mon-Fri 19:00-20:00");
    const slots = founderSlots({ now: new Date("2026-11-25T14:00:00Z"), windows: evenings, timeZone: NY, days: 2 });
    expect(days(slots)).toEqual(["2026-11-25", "2026-11-30"]);
    expect(slots[0]!.start).toBe("2026-11-26T00:00:00.000Z");
  });

  it("a crafted start on a holiday is refused, even on the grid and inside the windows", () => {
    const now = new Date("2026-11-25T14:00:00Z");
    // Thursday Nov 26 10:00 AM EST and Friday Nov 27 2:00 PM EST.
    expect(founderSlotAllowed("2026-11-26T15:00:00.000Z", { now, windows: WINDOWS, timeZone: NY })).toBeNull();
    expect(founderSlotAllowed("2026-11-27T19:00:00.000Z", { now, windows: WINDOWS, timeZone: NY })).toBeNull();
    // The same times a week later are fine.
    expect(founderSlotAllowed("2026-12-01T15:00:00.000Z", { now, windows: WINDOWS, timeZone: NY })).toEqual({ start: "2026-12-01T15:00:00.000Z", end: "2026-12-01T15:10:00.000Z" });
  });
});
