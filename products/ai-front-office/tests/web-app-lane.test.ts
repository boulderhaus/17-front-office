import { describe, expect, it } from "vitest";
import { buildAlerts, unseenAlerts } from "../web/src/lib/alerts.js";
import { smsDraft, smsHref } from "../web/src/lib/sms-draft.js";
import { installHelp } from "../web/src/lib/install.js";
import { opensAtTop } from "../web/src/lib/scroll.js";
import { usageTile } from "../web/src/lib/usage-tile.js";
import { jobColumns, jobTab } from "../web/src/lib/jobs.js";

const NOW = Date.parse("2026-11-26T15:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
function call(id: string, minutesAgo: number, over: Partial<{ outcome: string; name: string | null; problem: string; seconds: number | null; urgent: boolean }> = {}) {
  return {
    id, startedAt: at(minutesAgo), endedAt: at(minutesAgo - 2), durationSeconds: over.seconds === undefined ? 120 : over.seconds, outcome: over.outcome ?? "handoff_queued",
    fields: { callerName: over.name === undefined ? "Pat Example" : over.name, problemDescription: over.problem ?? "Leaky faucet", requestedStart: null },
    emergency: { emergency: over.urgent === true },
  };
}

describe("the bell's alerts (APP-04)", () => {
  it("lists urgent calls, people waiting, new bookings and hang-ups, newest first, each tied to its call", () => {
    const calls = [
      call("a", 50, { urgent: true }), call("b", 10), call("c", 30, { outcome: "booked" }), call("d", 5, { seconds: 8, name: null }),
      call("spam", 1, { outcome: "ignored_spam" }), call("done", 2),
    ];
    const tasks = [
      { callId: "a", status: "open", priority: "high", dueAt: at(40) }, { callId: "b", status: "open", priority: "normal", dueAt: at(1) },
      { callId: "done", status: "completed", priority: "normal", dueAt: at(1) },
    ];
    const alerts = buildAlerts({ calls, tasks, nowMs: NOW });
    expect(alerts.map((alert) => [alert.callId, alert.kind])).toEqual([["d", "short"], ["b", "callback"], ["c", "booked"], ["a", "urgent"]]);
    expect(alerts[0]!.title).toBe("Hung up early: Unknown caller");
    expect(alerts[3]!.title).toBe("Urgent: Pat Example");
  });
  it("is empty for a new shop, and counts only what came in since the bell was opened", () => {
    expect(buildAlerts({ calls: [], tasks: [], nowMs: NOW })).toEqual([]);
    const alerts = buildAlerts({ calls: [call("b", 10), call("c", 60, { outcome: "booked" })], tasks: [{ callId: "b", status: "open", priority: "normal", dueAt: at(1) }], nowMs: NOW });
    expect(unseenAlerts(alerts, null)).toBe(2);
    expect(unseenAlerts(alerts, at(30))).toBe(1);
  });
});

describe("the bell's alerts, timing and limits (APP-04)", () => {
  it("dates an alert from when it appeared, so a call back that comes due after the bell was read gets the dot", () => {
    const alerts = buildAlerts({ calls: [call("s", 120)], tasks: [{ callId: "s", status: "snoozed", priority: "normal", dueAt: at(5), updatedAt: at(100) }], nowMs: NOW });
    expect(alerts[0]!.at).toBe(at(5));
    expect(unseenAlerts(alerts, at(60))).toBe(1);
  });
  it("calls a long failed call a dropped call, not a hang-up", () => {
    const alerts = buildAlerts({ calls: [call("f", 10, { outcome: "failed", seconds: 240 }), call("h", 20, { outcome: "failed", seconds: 6 })], tasks: [], nowMs: NOW });
    expect(alerts.map((alert) => alert.title)).toEqual(["Call dropped: Pat Example", "Hung up early: Pat Example"]);
  });
  it("never lets newer bookings push an open urgent call off the list", () => {
    const calls = [call("old", 600, { urgent: true }), ...Array.from({ length: 25 }, (_, index) => call(`b${index}`, index + 1, { outcome: "booked" }))];
    const alerts = buildAlerts({ calls, tasks: [{ callId: "old", status: "open", priority: "high", dueAt: at(590) }], nowMs: NOW });
    expect(alerts).toHaveLength(20);
    expect(alerts[alerts.length - 1]).toMatchObject({ callId: "old", kind: "urgent" });
  });
});

describe("the Text button's draft (CALL-10)", () => {
  it("greets the caller by first name, names the shop and the problem", () => {
    expect(smsDraft({ callerName: "Morgan Sample", problem: "Kitchen sink drains slowly.", shop: "Synthetic Plumbing" }))
      .toBe("Hi Morgan, this is Synthetic Plumbing. Saw you called about kitchen sink drains slowly. When's a good time for us to come by?");
    expect(smsDraft({ callerName: "Lee", problem: "AC not cooling", shop: "Cool Co" })).toContain("about AC not cooling.");
  });
  it("still reads right with no name, no problem or no shop name", () => {
    expect(smsDraft({ callerName: null, problem: "", shop: null })).toBe("Hi. Saw you called. When's a good time for us to come by?");
    expect(smsDraft({ callerName: "  ", problem: null, shop: "Cool Co" })).toBe("Hi, this is Cool Co. Saw you called. When's a good time for us to come by?");
  });
  it("keeps a real summary short and sayable: names keep their capital, long ones are cut, third-person ones are left out", () => {
    expect(smsDraft({ callerName: "Linda", problem: "Linda's AC stopped cooling", shop: "Cool Co" })).toContain("about Linda's AC stopped cooling.")
    expect(smsDraft({ callerName: "Linda Example", problem: "Linda needs a new filter", shop: null })).toContain("about Linda needs a new filter.")
    const long = smsDraft({ callerName: "Lee", problem: "Water heater is leaking from the bottom and the pilot light keeps going out every night since Tuesday. Also wants a quote.", shop: "Cool Co" })
    expect(long).toBe("Hi Lee, this is Cool Co. Saw you called about water heater is leaking from the bottom and the pilot light. When's a good time for us to come by?")
    expect(smsDraft({ callerName: "Lee", problem: "Caller reports no hot water", shop: "Cool Co" })).toBe("Hi Lee, this is Cool Co. Saw you called. When's a good time for us to come by?")
  });
  it("puts the body where each phone reads it: & on iPhone, ? elsewhere", () => {
    expect(smsHref("+15555550100", "Hi Lee", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) CriOS/131")).toBe("sms:+15555550100&body=Hi%20Lee");
    expect(smsHref("+15555550100", "Hi Lee", "Mozilla/5.0 (Linux; Android 14) Chrome/131 Mobile")).toBe("sms:+15555550100?body=Hi%20Lee");
  });
});

describe("Home Screen help (APP-13)", () => {
  const iphoneChrome = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1";
  const iphoneSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
  it("gives Chrome on iPhone its own steps, not Safari's", () => {
    expect(installHelp({ userAgent: iphoneChrome, standalone: false, canPrompt: false })).toBe("iphone-chrome");
    expect(installHelp({ userAgent: iphoneSafari, standalone: false, canPrompt: false })).toBe("iphone-safari");
  });
  it("offers one tap where the browser allows it, and nothing once installed", () => {
    expect(installHelp({ userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/131 Mobile", standalone: false, canPrompt: true })).toBe("prompt");
    expect(installHelp({ userAgent: iphoneSafari, standalone: true, canPrompt: false })).toBe("installed");
  });
});

describe("a new page opens at its top (APP-10)", () => {
  it("scrolls up when the page changes, not on Back or a changed ?query", () => {
    expect(opensAtTop({ from: "/app/settings/business", to: "/app/calendar", type: "PUSH" })).toBe(true);
    expect(opensAtTop({ from: "/app/calendar", to: "/app/calendar", type: "REPLACE" })).toBe(false);
    expect(opensAtTop({ from: "/app/calendar", to: "/app/jobs", type: "POP" })).toBe(false);
  });
});

describe("the third number on Calls (CALL-13)", () => {
  it("means calls Otto answered with or without Unlimited", () => {
    expect(usageTile({ countedCalls: 2, includedCalls: 60, fairUseCalls: null, unlimited: false })).toEqual({ label: "Otto answered", value: 2, note: "58 of 60 left" });
    expect(usageTile({ countedCalls: 2, includedCalls: 60, fairUseCalls: 180, unlimited: true })).toEqual({ label: "Otto answered", value: 2, note: "this month" });
  });
});


describe("the Jobs board (APP-08)", () => {
  const c = (id: string, minutesAgo: number, requested: string | null = null, outcome = "handoff_queued") => ({ id, startedAt: at(minutesAgo), outcome, fields: { requestedStart: requested } });
  const task = (callId: string, priority = "normal", completedMinutesAgo = 5) => ({ callId, priority, dueAt: at(0), completedAt: at(completedMinutesAgo), updatedAt: at(completedMinutesAgo) });
  const build = (calls: ReturnType<typeof c>[], tasks: { actionable?: ReturnType<typeof task>[]; snoozed?: ReturnType<typeof task>[]; handled?: ReturnType<typeof task>[] }) =>
    jobColumns({ callsById: new Map(calls.map((one) => [one.id, one])), actionable: tasks.actionable ?? [], snoozed: tasks.snoozed ?? [], handled: tasks.handled ?? [], nowMs: NOW, due: () => "Due now", date: () => "Nov 27" });
  it("has four columns in the order a job moves, each card with when and one next step", () => {
    const columns = build([c("a", 1), c("b", 2, at(-60)), c("s", 3), c("k", 4, at(-120), "booked"), c("d", 5)], { actionable: [task("a", "high"), task("b")], snoozed: [task("s")], handled: [task("d")] });
    expect(columns.map((column) => [column.title, column.cards.length])).toEqual([["Needs reply", 2], ["Waiting", 1], ["Booked", 1], ["Done", 1]]);
    expect(columns[0]!.cards.map((card) => [card.label, card.when, card.action])).toEqual([["Urgent", "Now", "call"], ["Confirm time", "Now", "call"]]);
    expect(columns[2]!.cards[0]!.action).toBeNull();
  });
  it("puts every job in exactly one column: far-off visits in Booked, past visits in Done, open follow-ups first", () => {
    const columns = build([
      c("far", 10, at(-60 * 24 * 30), "booked"), c("past", 20, at(60 * 24 * 2), "booked"), c("both", 30, at(-60), "booked"), c("old", 40), c("new", 50),
    ], { actionable: [task("both")], handled: [task("old", "normal", 300), task("new", "normal", 1)] });
    const ids = columns.map((column) => column.cards.map((card) => card.call.id));
    expect(ids).toEqual([["both"], [], ["far"], ["new", "old", "past"]]);
  });
  it("says plainly when a column is empty, and maps old tab links", () => {
    const columns = build([], {});
    expect(columns[0]!.empty).toBe("Nobody is waiting on you.");
    expect(columns[2]!.empty).toBe("Nothing booked yet.");
    expect([jobTab(null), jobTab("handled"), jobTab("all"), jobTab("booked")]).toEqual(["reply", "done", "reply", "booked"]);
  });
});
