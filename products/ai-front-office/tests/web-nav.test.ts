import { describe, expect, it } from "vitest";
import { backGoes, callBack, callOrigin, JUMP, leavesSettings, navActive, navEntries, swipeCloses } from "../web/src/lib/nav.js";

const labels = (input: { base: string; preview: boolean; member: boolean; attention: number }) => navEntries(input).map((entry) => entry.label);

describe("owner app menu", () => {
  it("shows Calls, Jobs, Calendar and Settings to the owner, with the callers waiting on Calls", () => {
    const entries = navEntries({ base: "/app", preview: false, member: false, attention: 2 });
    expect(entries.map((entry) => entry.label)).toEqual(["Calls", "Jobs", "Calendar", "Settings"]);
    expect(entries.map((entry) => entry.badge)).toEqual([2, 0, 0, 0]);
    expect(entries.find((entry) => entry.id === "settings")?.to).toBe("/app/settings");
  });

  it("never shows Settings to a team member", () => {
    expect(labels({ base: "/app", preview: false, member: true, attention: 0 })).toEqual(["Calls", "Jobs", "Calendar"]);
  });

  it("shows Start (the sign-up page, a full page load) in the demo instead of Settings", () => {
    const entries = navEntries({ base: "/demo", preview: true, member: false, attention: 1 });
    expect(entries.map((entry) => entry.label)).toEqual(["Calls", "Jobs", "Calendar", "Set up yours"]);
    expect(entries[3]).toMatchObject({ to: "/signup", external: true });
    expect(entries[0]?.to).toBe("/demo");
  });

  it("lights Calls on the home path and on a call, and nothing else on a call", () => {
    const entries = navEntries({ base: "/app", preview: false, member: false, attention: 0 });
    const lit = (path: string) => entries.filter((entry) => navActive(path, entry)).map((entry) => entry.label);
    expect(lit("/app")).toEqual(["Calls"]);
    expect(lit("/app/calls/call-1")).toEqual(["Calls"]);
    expect(lit("/app/jobs")).toEqual(["Jobs"]);
    expect(lit("/app/calendar")).toEqual(["Calendar"]);
    expect(lit("/app/settings")).toEqual(["Settings"]);
    expect(lit("/app/settings/alerts")).toEqual(["Settings"]);
    expect(lit("/app/start")).toEqual([]);
  });
});

describe("phone drawer swipe", () => {
  it("closes on a swipe left of more than 60px that is mostly sideways", () => {
    expect(swipeCloses({ x: 250, y: 400 }, { x: 150, y: 420 })).toBe(true);
    expect(swipeCloses({ x: 250, y: 400 }, { x: 200, y: 400 })).toBe(false); // too short
    expect(swipeCloses({ x: 250, y: 400 }, { x: 150, y: 500 })).toBe(false); // a scroll, not a swipe
    expect(swipeCloses({ x: 150, y: 400 }, { x: 250, y: 400 })).toBe(false); // to the right
  });
});

describe("the top bar's back button", () => {
  it("steps back in history when the page was opened from its parent list", () => {
    expect(backGoes({ key: "k1", state: null })).toBe("history");
    expect(backGoes({ key: "k1", state: { from: "all" } })).toBe("history");
  });

  it("goes to the parent after a jump from the menu, the Alerts bell or the line status", () => {
    // Calendar -> menu -> Alerts: "‹ Settings" must land on Settings, not on Calendar.
    expect(backGoes({ key: "k2", state: JUMP })).toBe("parent");
  });

  it("goes to the parent on a deep link, the first page of the visit", () => {
    expect(backGoes({ key: "default", state: null })).toBe("parent");
  });
});

describe("a call's back button", () => {
  const opened = (pathname: string, search = "") => ({ key: "k3", state: { origin: callOrigin({ base: "/app", pathname, search }) }, base: "/app" });

  it("goes back to Jobs, by name, when Jobs opened the call", () => {
    expect(callBack(opened("/app/jobs", "?tab=all"))).toEqual({ to: "/app/jobs?tab=all", label: "Jobs", history: true });
  });

  it("goes back to Calls when Calls opened the call, whatever page came before Calls", () => {
    expect(callBack(opened("/app"))).toEqual({ to: "/app", label: "Calls", history: true });
    expect(callBack(opened("/app/calendar", "?view=day"))).toMatchObject({ label: "Calendar", history: true });
  });

  it("names the demo's lists the same way", () => {
    expect(callOrigin({ base: "/demo", pathname: "/demo/jobs", search: "" }).label).toBe("Jobs");
    expect(callOrigin({ base: "/demo", pathname: "/demo", search: "" }).label).toBe("Calls");
  });

  it("goes to Calls on a deep link, a text alert or a link with no list behind it", () => {
    expect(callBack({ key: "default", state: null, base: "/app" })).toEqual({ to: "/app", label: "Calls", history: false });
    expect(callBack({ key: "k4", state: null, base: "/demo" })).toEqual({ to: "/demo", label: "Calls", history: false });
    expect(callBack({ key: "default", state: { origin: { to: "/app/jobs", label: "Jobs" } }, base: "/app" })).toMatchObject({ label: "Calls", history: false });
    expect(callBack({ key: "k5", state: { origin: { to: 5 } }, base: "/app" })).toMatchObject({ label: "Calls", history: false });
  });
});

describe("unsaved settings", () => {
  it("only asks when the owner leaves the settings area", () => {
    expect(leavesSettings({ pathname: "/app/settings/alerts" })).toBe(false);
    expect(leavesSettings({ pathname: "/app/settings" })).toBe(false);
    expect(leavesSettings({ pathname: "/app/jobs" })).toBe(true);
    expect(leavesSettings({ pathname: "/app" })).toBe(true);
    expect(leavesSettings({ pathname: "/app/settingsx" })).toBe(true);
  });
});
