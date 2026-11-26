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
  it("has four columns in the order a job moves, each card with when and one next step", () => {
    const c = (id: string, requested: string | null = null) => ({ id, startedAt: at(Number(id.length)), fields: { requestedStart: requested } });
    const callsById = new Map([["a", c("a")], ["b", c("bb", at(-60))], ["s", c("sss")], ["k", c("k", at(-120))], ["d", c("dd")]]);
    const task = (callId: string, priority = "normal") => ({ callId, priority, dueAt: at(0), completedAt: at(5), updatedAt: at(5) });
    const columns = jobColumns({ callsById, actionable: [task("a", "high"), task("b")], snoozed: [task("s")], booked: [callsById.get("k")!], handled: [task("d")], due: () => "Due now", date: () => "Nov 27" });
    expect(columns.map((column) => [column.title, column.cards.length])).toEqual([["Needs reply", 2], ["Waiting", 1], ["Booked", 1], ["Done", 1]]);
    expect(columns[0]!.cards.map((card) => [card.label, card.when, card.action])).toEqual([["Urgent", "Now", "call"], ["Confirm time", "Now", "call"]]);
    expect(columns[2]!.cards[0]!.action).toBeNull();
  });
  it("says plainly when a column is empty, and maps old tab links", () => {
    const columns = jobColumns({ callsById: new Map(), actionable: [], snoozed: [], booked: [], handled: [], due: () => "", date: () => "" });
    expect(columns[0]!.empty).toBe("Nobody is waiting on you.");
    expect([jobTab(null), jobTab("handled"), jobTab("all"), jobTab("booked")]).toEqual(["reply", "done", "reply", "booked"]);
  });
});
