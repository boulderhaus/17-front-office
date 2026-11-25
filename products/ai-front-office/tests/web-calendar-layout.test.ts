import { describe, expect, it } from "vitest";
import { layoutVisits, VISIT_MIN_SPAN } from "../web/src/lib/calendar-layout.js";

const lanes = (starts: number[]) => layoutVisits(starts, 90, 45).map((slot) => `${slot.lane}/${slot.lanes}`);

describe("calendar blocks never cover each other", () => {
  it("ends a block where the next visit starts when there is room for its time and name", () => {
    // 9:47 and 10:47: the first block stops at 10:47 instead of running under the second.
    expect(layoutVisits([587, 647], 90, 45)).toEqual([
      { start: 587, end: 647, lane: 0, lanes: 1, group: 0 },
      { start: 647, end: 737, lane: 0, lanes: 1, group: 1 },
    ]);
  });

  it("keeps the full block when the next visit starts after it ends", () => {
    expect(layoutVisits([540, 700], 90, 45).map((slot) => slot.end)).toEqual([630, 790]);
  });

  it("puts visits too close to stack side by side, each in its own lane", () => {
    expect(lanes([600, 610])).toEqual(["0/2", "1/2"]);
    expect(lanes([600, 600, 630])).toEqual(["0/3", "1/3", "2/3"]);
  });

  it("starts a new group once the earlier blocks have ended", () => {
    expect(lanes([600, 600, 700])).toEqual(["0/2", "1/2", "0/1"]);
  });

  it("keeps a chain of close visits side by side for as long as their blocks overlap", () => {
    // 10:00, 10:40 and 11:20: each too close to the next to end there, so the three share the column.
    expect(lanes([600, 640, 680])).toEqual(["0/3", "1/3", "2/3"]);
    // ...and a visit 45 minutes or more after the last one stacks under it again.
    expect(lanes([600, 640, 690]).slice(2)).toEqual(["0/1"]);
  });

  it("keeps a block tall enough for its time and name: 45 minutes apart sit side by side", () => {
    // 45 minutes is 36px, which cut the caller's name; 50 is 40px, enough for both lines.
    expect(VISIT_MIN_SPAN).toBe(50);
    expect(layoutVisits([600, 645], 90, VISIT_MIN_SPAN).map((slot) => `${slot.lane}/${slot.lanes}`)).toEqual(["0/2", "1/2"]);
    expect(layoutVisits([600, 650], 90, VISIT_MIN_SPAN).map((slot) => slot.end)).toEqual([650, 740]);
  });

  it("numbers the groups that share a column, so a phone's week can show each as one block", () => {
    expect(layoutVisits([600, 610, 700, 900, 905], 72, VISIT_MIN_SPAN).map((slot) => slot.group)).toEqual([0, 0, 1, 2, 2]);
  });

  it("handles no visits", () => {
    expect(layoutVisits([], 90, 45)).toEqual([]);
  });
});
