import type { BusinessConfig } from "./models.js";

export const HOURS_PRESETS = {
  weekdays: { label: "Weekdays 8–5", start: "08:00", end: "17:00", days: "weekdays" },
  mon_sat: { label: "Mon–Sat 8–6", start: "08:00", end: "18:00", days: "mon_sat" },
  every_day: { label: "Every day 7–7", start: "07:00", end: "19:00", days: "every_day" },
} as const;

export type HoursPreset = keyof typeof HOURS_PRESETS | "custom";
type Days = "weekdays" | "mon_sat" | "every_day";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * "When can you take jobs?" as the two settings it drives: the hours the assistant may offer
 * appointments, and the after-hours window (the rest of the week) for after-hours coverage.
 */
export function hoursFromChoice(input: { preset?: unknown; start?: unknown; end?: unknown; days?: unknown }): {
  preset: HoursPreset;
  bookableHours: BusinessConfig["bookableHours"];
  afterHours: Pick<BusinessConfig["afterHours"], "weekdayStart" | "weekdayEnd" | "weekends" | "workSaturday">;
} {
  const preset = input.preset;
  let start: string;
  let end: string;
  let days: Days;
  if (preset === "weekdays" || preset === "mon_sat" || preset === "every_day") {
    ({ start, end, days } = HOURS_PRESETS[preset]);
  } else if (preset === "custom") {
    if (typeof input.start !== "string" || !TIME.test(input.start) || typeof input.end !== "string" || !TIME.test(input.end)) throw new Error("Pick a start and end time");
    if (input.start >= input.end) throw new Error("The end time must be after the start time");
    if (input.days !== "weekdays" && input.days !== "mon_sat" && input.days !== "every_day") throw new Error("Pick which days you work");
    start = input.start;
    end = input.end;
    days = input.days;
  } else {
    throw new Error("Pick when you take jobs");
  }
  return {
    preset: preset as HoursPreset,
    bookableHours: { weekdayStart: start, weekdayEnd: end, weekends: days === "every_day", saturday: days === "mon_sat" },
    // After hours is everything outside the working day: nights, plus the days off.
    afterHours: { weekdayStart: end, weekdayEnd: start, weekends: days !== "every_day", workSaturday: days === "mon_sat" },
  };
}

/** "Mon–Sat 8 AM–6 PM" for the done screen and Today. */
export function describeHours(hours: BusinessConfig["bookableHours"]): string {
  const days = hours.weekends ? "Every day" : hours.saturday ? "Mon–Sat" : "Mon–Fri";
  const clock = (value: string): string => {
    const [h = 0, m = 0] = value.split(":").map(Number);
    const suffix = h < 12 ? "AM" : "PM";
    const hour = h % 12 === 0 ? 12 : h % 12;
    return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
  };
  return `${days} ${clock(hours.weekdayStart)}–${clock(hours.weekdayEnd)}`;
}
