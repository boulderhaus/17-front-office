import { describe, expect, it } from "vitest";
import { buildAlerts, unseenAlerts } from "../web/src/lib/alerts.js";
import { smsDraft, smsHref } from "../web/src/lib/sms-draft.js";
import { installHelp } from "../web/src/lib/install.js";
import { opensAtTop } from "../web/src/lib/scroll.js";
import { usageTile } from "../web/src/lib/usage-tile.js";
import { withinTime, SlowCheck } from "../web/src/lib/install.js";
import { groupedPost } from "../web/src/lib/task-action.js";
import { agoLabel, BOARD_CAP, cappedCards, jobColumns, jobTab, oneJobPerCaller, PHONE_CAP } from "../web/src/lib/jobs.js";

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
  it("says one caller is waiting once, however many times they called (urgent first)", () => {
    const dana = (id: string, minutesAgo: number, urgent = false) => ({ ...call(id, minutesAgo, { urgent }), phone: "+15555550110" });
    const open = (callId: string, priority = "normal") => ({ callId, status: "open", priority, dueAt: at(1) });
    const alerts = buildAlerts({ calls: [dana("d1", 10), dana("d2", 60, true), dana("d3", 90), { ...call("s", 20), phone: "+15555550111" }], tasks: [open("d1"), open("d2", "high"), open("d3"), open("s")], nowMs: NOW });
    expect(alerts.map((alert) => [alert.callId, alert.kind])).toEqual([["s", "callback"], ["d2", "urgent"]]);
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
    jobColumns({ callsById: new Map(calls.map((one) => [one.id, one])), actionable: tasks.actionable ?? [], snoozed: tasks.snoozed ?? [], handled: tasks.handled ?? [], nowMs: NOW, date: () => "Nov 27" });
  it("has four columns in the order a job moves, each card with when and one next step", () => {
    const columns = build([c("a", 1), c("b", 2, at(-60)), c("s", 3), c("k", 4, at(-120), "booked"), c("d", 5)], { actionable: [task("a", "high"), task("b")], snoozed: [task("s")], handled: [task("d")] });
    expect(columns.map((column) => [column.title, column.cards.length])).toEqual([["Needs reply", 2], ["Waiting", 1], ["Booked", 1], ["Done", 1]]);
    expect(columns[0]!.cards.map((card) => [card.label, card.when, card.action])).toEqual([["Urgent", "1m ago", "call"], ["Confirm time", "2m ago", "call"]]);
    expect(columns[2]!.cards[0]!.action).toBeNull();
  });
  it("puts every job in exactly one column: far-off visits in Booked, past visits in Done, open follow-ups first", () => {
    const columns = build([
      c("far", 10, at(-60 * 24 * 30), "booked"), c("past", 20, at(60 * 24 * 2), "booked"), c("both", 30, at(-60), "booked"), c("old", 40), c("new", 50),
    ], { actionable: [task("both")], handled: [task("old", "normal", 300), task("new", "normal", 1)] });
    const ids = columns.map((column) => column.cards.map((card) => card.call.id));
    expect(ids).toEqual([["both"], [], ["far"], ["new", "old", "past"]]);
  });
  it("puts urgent first, then the newest call, so a busy Needs reply column reads top-down", () => {
    const columns = build([c("old", 300), c("new", 3), c("mid", 40), c("hot", 500)], { actionable: [task("old"), task("hot", "high"), task("mid"), task("new")] });
    expect(columns[0]!.cards.map((card) => [card.call.id, card.when])).toEqual([["hot", "8h ago"], ["new", "3m ago"], ["mid", "40m ago"], ["old", "5h ago"]]);
  });
  it("tells each card apart by how long ago they called, even when the call back isn't due yet (one meaning per column)", () => {
    const columns = jobColumns({ callsById: new Map([["a", c("a", 10)], ["b", c("b", 90)]]), actionable: [task("a"), { ...task("b"), dueAt: at(-60) }], snoozed: [], handled: [], nowMs: NOW, date: () => "Nov 27" });
    expect(columns[0]!.cards.map((card) => [card.whenLabel, card.when])).toEqual([["Called", "10m ago"], ["Called", "1h ago"]]);
  });
  it("orders Waiting by the soonest back", () => {
    const later = { ...task("late"), dueAt: at(-600) }, sooner = { ...task("soon"), dueAt: at(-60) };
    const columns = build([c("late", 5), c("soon", 50)], { snoozed: [later, sooner] });
    expect(columns[1]!.cards.map((card) => card.call.id)).toEqual(["soon", "late"]);
  });
  it("counts every card but shows the first few until Show all", () => {
    const calls = Array.from({ length: 30 }, (_, index) => c(`n${index}`, index + 1));
    const columns = build(calls, { actionable: calls.map((one) => task(one.id)) });
    expect(columns[0]!.cards).toHaveLength(30);
    expect(cappedCards(columns[0]!.cards, PHONE_CAP, false)).toMatchObject({ hidden: 25 });
    expect(cappedCards(columns[0]!.cards, PHONE_CAP, false).shown.map((card) => card.call.id)).toEqual(["n0", "n1", "n2", "n3", "n4"]);
    expect(cappedCards(columns[0]!.cards, PHONE_CAP, true)).toMatchObject({ hidden: 0 });
    expect(cappedCards(columns[0]!.cards, BOARD_CAP, false).hidden).toBe(5);
    expect(cappedCards(columns[0]!.cards.slice(0, 3), PHONE_CAP, false)).toMatchObject({ hidden: 0 });
  });
  it("says how long ago in the fewest words", () => {
    expect([0, 0.5, 12, 59, 60, 23 * 60, 30 * 60, 72 * 60].map((minutes) => agoLabel(at(minutes), NOW))).toEqual(["Just now", "Just now", "12m ago", "59m ago", "1h ago", "23h ago", "1d ago", "3d ago"]);
    expect(agoLabel(at(-5), NOW)).toBe("Just now");
    expect(agoLabel(at(25 * 60), NOW)).toBe("1d ago");
    expect(agoLabel(at(47 * 60), NOW)).toBe("1d ago");
  });
  it("says plainly when a column is empty, and maps old tab links", () => {
    const columns = build([], {});
    expect(columns[0]!.empty).toBe("Nobody is waiting on you.");
    expect(columns[2]!.empty).toBe("Nothing booked yet.");
    expect([jobTab(null), jobTab("handled"), jobTab("all"), jobTab("booked")]).toEqual(["reply", "done", "reply", "booked"]);
  });
});

describe("one job per caller (walk 11-26 iOS walk: Dana's four calls were four cards)", () => {
  const call = (id: string, phone: string | null, minutesAgo: number, outcome = "handoff_queued") => [id, { phone, startedAt: at(minutesAgo), outcome }] as const;
  const calls = new Map([call("d1", "+15555550110", 30), call("s1", "+15555550111", 60), call("d2", "+15555550110", 200), call("d3", "+15555550110", 900), call("x1", null, 10), call("x2", null, 20), call("p1", "+15555550199", 5, "ignored_spam"), call("p2", "+15555550199", 6, "ignored_spam")]);
  const task = (callId: string, priority = "normal") => ({ callId, priority });
  it("keeps one job per number, the newest call, in the order given, and lists the others", () => {
    const { jobs, earlier } = oneJobPerCaller([task("d3"), task("s1"), task("d2"), task("d1"), task("x1"), task("x2"), task("p1"), task("p2")], calls);
    expect(jobs.map((one) => one.callId)).toEqual(["s1", "d1", "x1", "x2", "p1", "p2"]);
    expect([...earlier]).toEqual([["d1", ["d3", "d2"]]]);
  });
  it("lets an urgent call lead the caller's job even when a newer call is routine", () => {
    const { jobs, earlier } = oneJobPerCaller([task("d2", "high"), task("d1")], calls);
    expect(jobs.map((one) => one.callId)).toEqual(["d2"]);
    expect(earlier.get("d2")).toEqual(["d1"]);
  });
});

describe("Done, Later and Undo on one caller's job (review of the walk 11-26 fix)", () => {
  const server = (fail: string[] = []) => {
    const status = new Map([["d1", "open"], ["d2", "open"], ["d3", "open"]])
    const one = async (callId: string, action: string) => {
      if (fail.includes(callId)) throw new Error("That didn't save.")
      if (action === "reopen" && status.get(callId) !== "completed") throw new Error("Completed task not found")
      status.set(callId, action === "complete" ? "completed" : action === "snooze" ? "snoozed" : "open")
    }
    return { status, one }
  }
  const othersOf = (callId: string) => (callId === "d1" ? ["d2", "d3"] : [])
  it("Done closes the whole job and Undo reopens the same calls", async () => {
    const { status, one } = server()
    const post = groupedPost(one, othersOf, new Map())
    await post("d1", "complete")
    expect([...status.values()]).toEqual(["completed", "completed", "completed"])
    await post("d1", "reopen")
    expect([...status.values()]).toEqual(["open", "open", "open"])
  })
  it("Later moves the whole job, and a later Undo of an old Done doesn't replay it", async () => {
    const { status, one } = server()
    const closedWith = new Map<string, string[]>()
    const post = groupedPost(one, othersOf, closedWith)
    await post("d1", "snooze", 60)
    expect([...status.values()]).toEqual(["snoozed", "snoozed", "snoozed"])
    expect(closedWith.has("d1")).toBe(false)
  })
  it("a sibling that fails leaves the job's own save standing (it shows as its own job), and the job's failure is the error", async () => {
    const flaky = server(["d3"])
    await expect(groupedPost(flaky.one, othersOf, new Map())("d1", "complete")).resolves.toBeUndefined()
    expect([...flaky.status.values()]).toEqual(["completed", "completed", "open"])
    const broken = server(["d1"])
    await expect(groupedPost(broken.one, othersOf, new Map())("d1", "complete")).rejects.toThrow("didn't save")
  })
})

describe("a phone check that never answers (walk 11-26 iOS walk: Checking this phone... forever)", () => {
  it("gives up after the time limit with SlowCheck, and passes answers and errors through", async () => {
    await expect(withinTime(new Promise(() => undefined), 5)).rejects.toBeInstanceOf(SlowCheck);
    await expect(withinTime(Promise.resolve(7), 50)).resolves.toBe(7);
    await expect(withinTime(Promise.reject(new Error("no")), 50)).rejects.toThrow("no");
  });
});
