import { describe, expect, it } from "vitest";
import {
  allCallsRowSelected,
  attentionRowSelected,
  nextOpenCall,
  PANEL_EDGE,
  rowShowsDone,
  SELECTED_ROW,
} from "../web/src/lib/selection.js";

// Synthetic ids only: two callers waiting (A first, B second), one call already handled (C).
const WAITING = ["call-a", "call-b"];
const ALL = ["call-a", "call-b", "call-c"];

/** Every lit row on the Calls page for one URL state: [list, callId]. */
function litRows(panelId: string | null, from: string | null, wide = true): Array<[string, string]> {
  const actionable = new Set(WAITING);
  return [
    ...WAITING.filter((callId) => attentionRowSelected({ wide, panelId, callId, from })).map((callId): [string, string] => ["attention", callId]),
    ...(wide ? ALL.filter((callId) => allCallsRowSelected({ panelId, callId, from, actionable })).map((callId): [string, string] => ["all", callId]) : []),
  ];
}

describe("Calls page: the open call lights exactly one row", () => {
  it("lights the first waiting caller in Needs your attention before anyone clicks, and not again in All calls", () => {
    expect(litRows("call-a", null)).toEqual([["attention", "call-a"]]);
  });

  it("lights only the row that was clicked when a waiting caller is opened from All calls", () => {
    expect(litRows("call-b", "all")).toEqual([["all", "call-b"]]);
    expect(litRows("call-b", null)).toEqual([["attention", "call-b"]]);
  });

  it("lights the All calls row for a call with nothing waiting, whichever list the link came from", () => {
    expect(litRows("call-c", null)).toEqual([["all", "call-c"]]);
    expect(litRows("call-c", "all")).toEqual([["all", "call-c"]]);
  });

  it("lights nothing on a phone, where a call opens its own screen", () => {
    expect(litRows("call-a", null, false)).toEqual([]);
  });

  it("ties the lit row to the panel with facing ink edges and the shared yellow", () => {
    expect(SELECTED_ROW.split(" ")).toEqual(expect.arrayContaining(["bg-accent", "shadow-[inset_-4px_0_0_var(--brand-ink)]", "hover:bg-accent"]));
    expect(PANEL_EDGE.split(" ")).toEqual(expect.arrayContaining(["border-l-4", "border-l-brand-ink"]));
  });
});

describe("Calls page: one Done per call", () => {
  it("never puts a row Done on the lit row, whose Done already lives in the panel", () => {
    expect(rowShowsDone({ wide: true, selected: true, preview: false })).toBe(false);
  });

  it("gives every other waiting row on a wide screen exactly one quiet Done", () => {
    const rowDones = WAITING.filter((callId) => rowShowsDone({ wide: true, selected: attentionRowSelected({ wide: true, panelId: "call-a", callId, from: null }), preview: false }));
    expect(rowDones).toEqual(["call-b"]);
  });

  it("shows no row Done in the read-only demo or on a phone (the phone row keeps its own buttons)", () => {
    expect(rowShowsDone({ wide: true, selected: false, preview: true })).toBe(false);
    expect(rowShowsDone({ wide: false, selected: false, preview: false })).toBe(false);
  });
});

describe("Calls page: after Done or Later the panel moves on", () => {
  it("opens the caller below, else the one above", () => {
    expect(nextOpenCall(["a", "b", "c"], ["a", "b", "c"], "a")).toBe("b");
    expect(nextOpenCall(["a", "b", "c"], ["a", "b", "c"], "b")).toBe("c");
    expect(nextOpenCall(["a", "b", "c"], ["a", "b", "c"], "c")).toBe("b");
  });

  it("falls back to the first other call when nobody else is waiting, never the finished one", () => {
    expect(nextOpenCall(["a"], ["a", "x", "y"], "a")).toBe("x");
    expect(nextOpenCall([], ["x", "y"], "z")).toBe("x");
    expect(nextOpenCall(["a"], ["a"], "a")).toBeNull();
  });

  it("opens the first waiting caller when the finished call wasn't in the list", () => {
    expect(nextOpenCall(["a", "b"], ["c", "a", "b"], "c")).toBe("a");
  });
});
