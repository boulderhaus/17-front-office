import { describe, expect, it } from "vitest";
import {
  allCallsRowSelected,
  attentionRowSelected,
  nextOpenCall,
  panelSearch,
  revealDelta,
  rowShowsDone,
  stillOpenCalls,
} from "../web/src/lib/selection.js";
import { createTaskGate, QUIET_MS, runTaskAction, UNDO_MS, type TaskAction, type TaskDeps, type TaskMoves } from "../web/src/lib/task-action.js";

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

/** Every Done on the page for one call: its row Done in "Needs your attention" (wide), plus the panel's when it is open. */
function donesFor(callId: string, panelId: string, preview = false): number {
  const row = WAITING.includes(callId) && rowShowsDone({ wide: true, open: panelId === callId, preview }) ? 1 : 0;
  const panel = !preview && panelId === callId ? 1 : 0;
  return row + panel;
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
});

describe("Calls page: one Done per call", () => {
  it("puts no row Done on the open call's row, whose Done already lives in the panel", () => {
    expect(rowShowsDone({ wide: true, open: true, preview: false })).toBe(false);
  });

  it("gives every other waiting row on a wide screen exactly one quiet Done", () => {
    expect(WAITING.filter((callId) => rowShowsDone({ wide: true, open: callId === "call-a", preview: false }))).toEqual(["call-b"]);
  });

  it("shows each call's Done exactly once whichever list it was opened from, including All calls", () => {
    for (const from of [null, "all"]) {
      for (const panelId of ALL) {
        for (const callId of WAITING) expect({ from, panelId, callId, dones: donesFor(callId, panelId) }).toEqual({ from, panelId, callId, dones: 1 });
      }
    }
    // The case that once showed two: call B open from All calls, its attention row unlit but still open.
    expect(attentionRowSelected({ wide: true, panelId: "call-b", callId: "call-b", from: "all" })).toBe(false);
    expect(rowShowsDone({ wide: true, open: true, preview: false })).toBe(false);
  });

  it("shows no row Done in the read-only demo or on a phone (the phone row keeps its own buttons)", () => {
    expect(rowShowsDone({ wide: true, open: false, preview: true })).toBe(false);
    expect(rowShowsDone({ wide: false, open: false, preview: false })).toBe(false);
  });
});

describe("Calls page: after Done or Later the panel moves on", () => {
  it("opens the caller below, else the one above", () => {
    expect(nextOpenCall(["a", "b", "c"], ["a", "b", "c"], "a")).toBe("b");
    expect(nextOpenCall(["a", "b", "c"], ["a", "b", "c"], "b")).toBe("c");
    expect(nextOpenCall(["a", "b", "c"], ["a", "b", "c"], "c")).toBe("b");
  });

  it("falls back to the newest call still open, never the finished one", () => {
    expect(nextOpenCall(["a"], ["a", "x", "y"], "a")).toBe("x");
    expect(nextOpenCall([], ["x", "y"], "z")).toBe("x");
  });

  it("says caught up (null) when no call is left open", () => {
    expect(nextOpenCall(["a"], ["a"], "a")).toBeNull();
    expect(nextOpenCall(["a"], [], "a")).toBeNull();
  });

  it("opens the first waiting caller when the finished call wasn't in the list", () => {
    expect(nextOpenCall(["a", "b"], ["c", "a", "b"], "c")).toBe("a");
  });

  it("never lands on likely spam or a call whose follow-up is finished", () => {
    const calls = [
      { id: "robocall", outcome: "ignored_spam" },
      { id: "handled", outcome: "handoff_queued" },
      { id: "booked", outcome: "booked" },
      { id: "waiting-later", outcome: "handoff_queued" },
      { id: "no-follow-up", outcome: "info_only" },
    ];
    const status: Record<string, string> = { handled: "completed", booked: "completed", "waiting-later": "snoozed" };
    const open = stillOpenCalls(calls, (id) => status[id]);
    expect(open).toEqual(["waiting-later", "no-follow-up"]);
    // The last waiting caller is done: the newest real call opens, not the newer robocall or finished calls.
    expect(nextOpenCall(["last"], ["last", ...open], "last")).toBe("waiting-later");
    expect(nextOpenCall(["last"], stillOpenCalls([{ id: "robocall", outcome: "ignored_spam" }, { id: "handled", outcome: "x" }], (id) => status[id]), "last")).toBeNull();
  });

  it("keeps the list the call was opened from, and clears it with the call", () => {
    expect(panelSearch("?call=a&from=all", "b")).toBe("?call=b&from=all");
    expect(panelSearch("?call=a", "b")).toBe("?call=b");
    expect(panelSearch("?page=2&call=a&from=all", null)).toBe("?page=2");
    expect(panelSearch("?call=a", null)).toBe("");
  });

  it("scrolls only when the lit row is out of sight, and just enough to show it under the top bar", () => {
    const view = { top: 64, bottom: 900 };
    expect(revealDelta({ top: 300, bottom: 400 }, view)).toBe(0);
    expect(revealDelta({ top: 40, bottom: 140 }, view)).toBe(40 - 64 - 8);
    expect(revealDelta({ top: 1200, bottom: 1300 }, view)).toBe(1300 - 900 + 8);
    expect(revealDelta({ top: 880, bottom: 980 }, view)).toBe(980 - 900 + 8);
  });
});

/** Fakes that record the order things happen in. */
function harness(options: { post?: (callId: string, action: TaskAction) => Promise<unknown>; now?: () => number } = {}) {
  const log: string[] = [];
  let undo: (() => void) | undefined;
  const toasts: Array<{ kind: string; message: string; duration?: number }> = [];
  const deps: TaskDeps = {
    post: async (callId, action) => {
      log.push(`post ${action} ${callId}`);
      if (options.post) await options.post(callId, action);
    },
    reload: async () => { log.push("reload"); },
    toast: {
      success: (message, opts) => { log.push(`toast ${message}`); toasts.push({ kind: "success", message, duration: opts.duration }); undo = opts.action.onClick; },
      message: (message) => { log.push(`toast ${message}`); toasts.push({ kind: "message", message }); },
      error: (message) => { log.push(`error ${message}`); toasts.push({ kind: "error", message }); },
    },
    gate: createTaskGate(options.now ?? (() => 0), 0),
  };
  const moves: TaskMoves = { leave: () => log.push("leave"), back: () => log.push("back"), settle: () => log.push("settle") };
  return { deps, log, toasts, moves, undo: () => undo?.() };
}

describe("Done, Later and Undo: save first, then move", () => {
  it("moves the panel on after Done saves and before the list reloads, then offers Undo for 8 seconds", async () => {
    const h = harness();
    expect(await runTaskAction(h.deps, "call-a", "complete", undefined, h.moves)).toBe(true);
    expect(h.log).toEqual(["post complete call-a", "leave", "reload", "settle", "toast Marked done."]);
    expect(h.toasts[0]).toEqual({ kind: "success", message: "Marked done.", duration: UNDO_MS });
  });

  it("moves nothing and reports failure when the save is rejected", async () => {
    const h = harness({ post: async () => { throw new Error("That didn’t save. Please try again."); } });
    expect(await runTaskAction(h.deps, "call-a", "complete", undefined, h.moves)).toBe(false);
    expect(h.log).toEqual(["post complete call-a", "error That didn’t save. Please try again."]);
  });

  it("returns the panel to a reopened call only after the list has it again", async () => {
    const h = harness();
    expect(await runTaskAction(h.deps, "call-a", "reopen", undefined, h.moves)).toBe(true);
    expect(h.log).toEqual(["post reopen call-a", "reload", "back", "settle"]);
  });

  it("Undo on the toast reopens the call and brings the panel back to it, without moving on again", async () => {
    const h = harness();
    await runTaskAction(h.deps, "call-a", "complete", undefined, h.moves);
    h.log.length = 0;
    h.undo();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.log).toEqual(["post reopen call-a", "reload", "back", "settle"]);
  });

  it("Later moves the panel on the same way and says where the call went", async () => {
    const h = harness();
    expect(await runTaskAction(h.deps, "call-a", "snooze", 60, h.moves)).toBe(true);
    expect(h.log).toEqual(["post snooze call-a", "leave", "reload", "settle", "toast Moved to Waiting."]);
  });
});

describe("Done, Later and Undo: a double-click never reaches the next caller", () => {
  it("drops a second click while the first save is still in flight", async () => {
    let finish: () => void = () => undefined;
    const h = harness({ post: (_, action) => (action === "complete" ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve()) });
    const first = runTaskAction(h.deps, "call-a", "complete", undefined, h.moves);
    expect(await runTaskAction(h.deps, "call-b", "complete", undefined, h.moves)).toBe(false);
    finish();
    expect(await first).toBe(true);
    expect(h.log.filter((line) => line.startsWith("post"))).toEqual(["post complete call-a"]);
  });

  it("drops a click that lands just after a save, then takes the next deliberate one", async () => {
    let clock = 1_000;
    const gate = createTaskGate(() => clock, QUIET_MS);
    expect(gate.enter()).toBe(true);
    gate.leave();
    clock += QUIET_MS - 1;
    expect(gate.enter()).toBe(false);
    clock += 1;
    expect(gate.enter()).toBe(true);
  });
});
