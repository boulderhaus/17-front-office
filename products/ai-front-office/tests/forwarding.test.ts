import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { TelnyxOwnerCallSender } from "../src/adapters/telnyx-owner-call.js";
import { setupInstructions } from "../src/adapters/telnyx-setup-call.js";
import { dialsBackToOtto } from "../src/application/forwarding-loop.js";
import { urgentOwnerCallNotification } from "../src/application/owner-alerts.js";
import { approvedTransferTargets } from "../src/application/transfer-policy.js";
import { createDemoConfig } from "../src/domain/config.js";
import { carrierFamily, everyCallProven, forwardingChoice, forwardingOffInstruction, forwardingPlan, forwardsBackToOtto, isForwardAllCode, mayForwardAll, parseTestedFor, RING_CHOICES, ringChoicesWith, ringSeconds, type TestedFor } from "../src/domain/forwarding.js";
import { forwardingCheckStatus, forwardingUpdate } from "../src/http/owner-api-model.js";
import { NotificationHeldError } from "../src/ports.js";
import { afterDialLine, CODE_FAILED_LINK as WEB_CODE_FAILED_LINK, codeChunks, copyText, dialHref, dialPlatform, EVERY_CALL_FIX_LINE, forwardingSteps as webForwardingSteps, IPHONE_PHONE_SETTINGS, keepRingFirstLine, pasteLine, RING_CHOICES as WEB_RING_CHOICES, ringChoicesWith as webRingChoicesWith, ringSeconds as webRingSeconds, spokenCode, VERIZON_RING_LINE } from "../web/src/lib/dial.js";
import { BACK_TO_CODE_LINK, CODE_FAILED_LINK, CODE_FAILED_LINK_DESKTOP, forwardingSteps, forwardToDigits, RETRY_CODE_LINE, SETTINGS_OFF_LINE, SETTINGS_ON_STEPS, SWITCH_INSTEAD_LINE, type SetupDevice } from "../src/domain/forwarding-steps.js";
import { pauseHint } from "../web/src/lib/pause-hint.js";
import { loginReturningHere } from "../web/src/lib/login-next.js";
import { safeNext } from "../src/http/owner-sign-in.js";

describe("carrier family from a number lookup", () => {
  it.each([
    ["Verizon Wireless", "mobile", "verizon"],
    ["Cellco Partnership dba Verizon Wireless", "mobile", "verizon"],
    ["Xfinity Mobile", "mobile", "verizon"],
    ["AT&T Mobility", "mobile", "gsm"],
    ["New Cingular Wireless PCS", "mobile", "gsm"],
    ["T-Mobile USA", "mobile", "gsm"],
    ["Cricket Wireless", "mobile", "gsm"],
    ["Comcast IP Phone", "voip", "office"],
    ["Verizon Business", "fixed line", "office"],
    ["Some Regional Wireless", "mobile", "unknown"],
    [null, null, "unknown"],
  ])("%s / %s → %s", (name, type, family) => {
    expect(carrierFamily(name, type)).toBe(family);
  });
});

describe("one code per phone company", () => {
  it("always-forward uses the unconditional codes", () => {
    expect(forwardingPlan("verizon", "+19415550123", "always").on).toBe("*729415550123");
    expect(forwardingPlan("gsm", "+19415550123", "always")).toMatchObject({ on: "**21*19415550123#", off: "##002#" });
  });
  it("office lines get portal steps and human help, never a code", () => {
    const plan = forwardingPlan("office", "+19415550123", "overflow");
    expect(plan.on).toBeNull();
    expect(plan.what).toContain("(941) 555-0123");
  });
  it("the off instruction names the exact code when we know the carrier", () => {
    expect(forwardingOffInstruction("verizon")).toContain("*73");
    expect(forwardingOffInstruction("gsm")).toContain("##002#");
    expect(forwardingOffInstruction(null)).toContain("*73");
  });
});

describe("ring time before Call Otto answers", () => {
  it("turns 'Ring my phone first' into the GSM timer: about 6 s a ring, to the nearest 5, kept to 5–30 s", () => {
    expect([2, 2.5, 3, 4, 5, 8, 12].map((rings) => ringSeconds(rings))).toEqual([10, 15, 20, 25, 30, 30, 30]);
    expect(ringSeconds(1)).toBe(5);
    expect(ringSeconds(undefined)).toBe(10);
    expect(ringSeconds(Number.NaN)).toBe(10);
    expect(RING_CHOICES.map((choice) => [choice.rings, ringSeconds(choice.rings)])).toEqual(RING_CHOICES.map((choice) => [choice.rings, choice.seconds]));
    // New shops start at 10 seconds (the owner gets about 7–12 s to pick up); the 10-second choice comes first.
    expect(createDemoConfig().answerAfterRings).toBe(2);
    expect(ringSeconds(createDemoConfig().answerAfterRings)).toBe(10);
    expect(RING_CHOICES[0]).toMatchObject({ rings: 2, seconds: 10 });
  });

  it("puts the timer in the one GSM code, 10 seconds unless the owner picked another time", () => {
    expect(forwardingPlan("gsm", "+19415550123", "overflow")).toMatchObject({ on: "**004*19415550123**10#", off: "##002#", ringSeconds: 10, forwardsAll: false });
    expect(forwardingPlan("gsm", "+19415550123", "overflow", createDemoConfig().answerAfterRings).on).toBe("**004*19415550123**10#");
    expect(forwardingPlan("gsm", "+19415550123", "overflow", 2).on).toBe("**004*19415550123**10#");
    expect(forwardingPlan("gsm", "+19415550123", "after_hours", 5).on).toBe("**004*19415550123**30#");
    expect(forwardingPlan("gsm", "+19415550123", "overflow", 4).what).toContain("25 seconds");
    expect(forwardingPlan("gsm", "+19415550123", "overflow", 2).dialLink).toBe("tel:%2A%2A004%2A19415550123%2A%2A10%23");
  });

  it("leaves Verizon alone: *71 rings about 30 seconds whatever the setting says", () => {
    for (const rings of [2, 2.5, 5]) {
      expect(forwardingPlan("verizon", "+19415550123", "overflow", rings)).toMatchObject({ on: "*719415550123", off: "*73", ringSeconds: 30 });
    }
    expect(forwardingPlan("verizon", "+19415550123", "overflow").what).toContain("about 30 seconds");
  });

  it("keeps the forward-all codes and says the phone won't ring", () => {
    expect(forwardingPlan("gsm", "+19415550123", "always", 2)).toMatchObject({ on: "**21*19415550123#", forwardsAll: true, ringSeconds: null });
    expect(forwardingPlan("verizon", "+19415550123", "always")).toMatchObject({ on: "*729415550123", forwardsAll: true });
    expect(forwardingPlan("gsm", "+19415550123", "always").what).toContain("won’t ring");
    expect(isForwardAllCode("**21*19415550123#")).toBe(true);
    expect(isForwardAllCode("*729415550123")).toBe(true);
    expect(isForwardAllCode("**004*19415550123**15#")).toBe(false);
    expect(isForwardAllCode("*719415550123")).toBe(false);
  });

  it("never carries an up-front iPhone settings tip", () => {
    for (const family of ["gsm", "verizon", "office", "unknown"] as const) expect(forwardingPlan(family, "+19415550123", "overflow")).not.toHaveProperty("iphoneTip");
  });

  it("keeps a saved value from the old 2–12 ring list selectable", () => {
    expect(ringChoicesWith(2)).toHaveLength(RING_CHOICES.length);
    expect(ringChoicesWith(2.5)).toHaveLength(RING_CHOICES.length);
    expect(ringChoicesWith(8).find((choice) => choice.rings === 8)).toMatchObject({ seconds: 30, label: "30 seconds (the longest carriers allow)" });
  });
});

describe("what the owner was set up for when a test last passed", () => {
  const at = "2026-11-23T15:00:00Z";
  const ring15 = forwardingPlan("gsm", "+19415550123", "overflow", 2.5);
  const all = forwardingPlan("gsm", "+19415550123", "always");
  const tested = (mode: TestedFor["mode"], code: string | null): TestedFor => ({ mode, code, at });

  it("is the owner's choice, stored as written, never worked out from timing", () => {
    expect(forwardingChoice("always")).toBe("every-call");
    expect(forwardingChoice("overflow")).toBe("ring-first");
    expect(forwardingChoice("after_hours")).toBe("ring-first");
    expect(parseTestedFor(JSON.stringify(tested("every-call", all.on)))).toEqual({ ...tested("every-call", all.on), rangSeconds: null });
    expect(parseTestedFor(JSON.stringify({ mode: "office", code: null }))).toBeNull();
    expect(parseTestedFor("not json")).toBeNull();
    expect(parseTestedFor(null)).toBeNull();
  });

  it("asks for nothing until a test passes, or while today's choice and code match the last passed test", () => {
    expect(forwardingUpdate(ring15, "overflow", null)).toBeNull();
    expect(forwardingUpdate(ring15, "overflow", tested("ring-first", ring15.on))).toBeNull();
    // After hours rings first too: same choice, same code.
    expect(forwardingUpdate(ring15, "after_hours", tested("ring-first", ring15.on))).toBeNull();
    expect(forwardingUpdate(all, "always", tested("every-call", all.on))).toBeNull();
    expect(forwardingUpdate(forwardingPlan("unknown", "+19415550123", "overflow"), "overflow", tested("every-call", null))).toBeNull();
  });

  it("shows the new code after a ring-time or every-call change, turning forwarding off first when leaving every call", () => {
    expect(forwardingUpdate(ring15, "overflow", tested("ring-first", "**004*19415550123**25#"))).toEqual({ clearFirst: null, leavingEveryCall: false });
    expect(forwardingUpdate(all, "always", tested("ring-first", ring15.on))).toEqual({ clearFirst: null, leavingEveryCall: false });
    expect(forwardingUpdate(ring15, "overflow", tested("every-call", all.on))).toEqual({ clearFirst: "##002#", leavingEveryCall: true });
    expect(forwardingUpdate(forwardingPlan("verizon", "+19415550123", "overflow"), "overflow", tested("every-call", "*729415550123"))).toEqual({ clearFirst: "*73", leavingEveryCall: true });
  });

  it("office lines: a change of choice shows the website step; leaving every call says to turn forward-all off there first", () => {
    const officeRing = forwardingPlan("office", "+19415550123", "overflow");
    expect(forwardingUpdate(officeRing, "overflow", tested("ring-first", null))).toBeNull();
    expect(forwardingUpdate(officeRing, "overflow", tested("every-call", null))).toEqual({ clearFirst: null, leavingEveryCall: true });
    expect(forwardingUpdate(forwardingPlan("office", "+19415550123", "always"), "always", tested("ring-first", null))).toEqual({ clearFirst: null, leavingEveryCall: false });
  });
});

describe("what the test call result says", () => {
  const startedAt = "2026-11-23T15:00:00.000Z";
  const at = (seconds: number) => new Date(Date.parse(startedAt) + seconds * 1_000).toISOString();
  it("the phone's own screener answering is 'phone answers' at once, before the call even ends", () => {
    expect(forwardingCheckStatus({ startedAt, method: "auto", answeredAt: at(2), screenedAt: at(5) }, null, at(6))).toBe("phone_answers");
    expect(forwardingCheckStatus({ startedAt, method: "auto", answeredAt: at(2) }, null, at(6))).toBe("calling");
  });
  it("uses Premium AMD's verdict when the call ends: a greeting is voicemail, a person is someone picking up", () => {
    expect(forwardingCheckStatus({ startedAt, method: "auto", answeredAt: at(3), amdResult: "machine", endedAt: at(20) }, null, at(21))).toBe("voicemail");
    // A person answered and nothing screened it: most likely the owner, not the phone answering itself.
    expect(forwardingCheckStatus({ startedAt, method: "auto", answeredAt: at(4), amdResult: "human_residence", endedAt: at(16) }, null, at(17))).toBe("you_answered");
    expect(forwardingCheckStatus({ startedAt, method: "auto", answeredAt: at(25), amdResult: "human_business", endedAt: at(40) }, null, at(41))).toBe("you_answered");
    // Apple's screener: "machine" first, then the screening signal, which wins.
    expect(forwardingCheckStatus({ startedAt, method: "auto", answeredAt: at(2), amdResult: "machine", screenedAt: at(7), endedAt: at(14) }, null, at(15))).toBe("phone_answers");
    expect(forwardingCheckStatus({ startedAt, method: "auto", answeredAt: at(2), endedAt: at(14) }, null, at(15))).toBe("phone_answers");
    expect(forwardingCheckStatus({ startedAt, method: "auto", answeredAt: at(25), endedAt: at(40) }, null, at(41))).toBe("voicemail");
  });
  it("a forward that reached Call Otto wins over everything", () => {
    expect(forwardingCheckStatus({ startedAt, method: "auto", answeredAt: at(2), screenedAt: at(4) }, at(3), at(6))).toBe("passed");
  });
});

describe("Otto never rings a number that forwards every call back to Otto", () => {
  const everyCall: TestedFor = { mode: "every-call", code: "**21*19415550123#", at: "2026-11-23T15:00:00Z" };
  const ringFirst: TestedFor = { mode: "ring-first", code: "**004*19415550123**10#", at: "2026-11-23T15:00:00Z" };
  it("while every call is picked or the last passed test was for every call, and only the business number itself", () => {
    expect(forwardsBackToOtto({ mode: "always", businessNumber: "+19415550177", phone: "+19415550177" })).toBe(true);
    // Every call picked, but the last passed test was for ring first: the code may be dialed already, so still guarded.
    expect(forwardsBackToOtto({ mode: "always", businessNumber: "+19415550177", phone: "+19415550177", testedFor: ringFirst })).toBe(true);
    expect(forwardsBackToOtto({ mode: "always", businessNumber: "+19415550177", phone: "+19415550199" })).toBe(false);
    expect(forwardsBackToOtto({ mode: "overflow", businessNumber: "+19415550177", phone: "+19415550177" })).toBe(false);
    expect(forwardsBackToOtto({ mode: "always", businessNumber: null, phone: "+19415550177" })).toBe(false);
    // Switched back to ring first, no ring-first test passed yet: forward-all may still be on.
    expect(forwardsBackToOtto({ mode: "overflow", businessNumber: "+19415550177", phone: "+19415550177", testedFor: everyCall })).toBe(true);
    expect(forwardsBackToOtto({ mode: "after_hours", businessNumber: "+19415550177", phone: "+19415550177", testedFor: everyCall })).toBe(true);
    // Office lines have no code; the recorded choice is enough.
    expect(forwardsBackToOtto({ mode: "overflow", businessNumber: "+19415550177", phone: "+19415550177", testedFor: { ...everyCall, code: null } })).toBe(true);
    expect(forwardsBackToOtto({ mode: "overflow", businessNumber: "+19415550177", phone: "+19415550177", testedFor: ringFirst })).toBe(false);
    expect(forwardsBackToOtto({ mode: "overflow", businessNumber: "+19415550177", phone: "+19415550199", testedFor: everyCall })).toBe(false);
    expect(mayForwardAll({ mode: "overflow", testedFor: everyCall })).toBe(true);
    expect(mayForwardAll({ mode: "overflow", testedFor: null })).toBe(false);
  });

  it("reads the shop's choice, business number and last passed test from the store", async () => {
    const store = new InMemoryStore();
    await store.saveConfig({ ...createDemoConfig("shop"), operationMode: "always" });
    await store.saveIntegrationSecret("shop", "forwarding", "business_number", "+19415550177");
    expect(await dialsBackToOtto(store, "shop", "+19415550177")).toBe(true);
    expect(await dialsBackToOtto(store, "shop", "+19415550199")).toBe(false);
    expect(await dialsBackToOtto(store, "shop", null)).toBe(false);
    await store.saveConfig({ ...createDemoConfig("shop"), operationMode: "overflow" });
    expect(await dialsBackToOtto(store, "shop", "+19415550177")).toBe(false);
    await store.saveIntegrationSecret("shop", "forwarding", "tested_for", JSON.stringify(everyCall));
    expect(await dialsBackToOtto(store, "shop", "+19415550177")).toBe(true);
    await store.saveIntegrationSecret("shop", "forwarding", "tested_for", JSON.stringify(ringFirst));
    expect(await dialsBackToOtto(store, "shop", "+19415550177")).toBe(false);
  });

  it("urgent owner calls to a forwarded-all number are held (push and email still go), never dialed", async () => {
    const posted: string[] = [];
    const fetcher = (async (url: string) => { posted.push(String(url)); return new Response(JSON.stringify({ data: { call_control_id: "v3:x" } }), { status: 200 }); }) as unknown as typeof fetch;
    const claims = new InMemoryStore();
    const options = { apiKey: "KEY", connectionId: "check-connection", from: "+15555550199", webhookUrl: "https://front-office.example/webhooks/telnyx", clock: { now: () => new Date("2026-11-23T15:00:00Z") }, fetcher, resolveDestination: async () => "+19415550177", claimDial: (key: string) => claims.claimWebhook(key), hasConsent: async () => true };
    const notification = urgentOwnerCallNotification({ tenantId: "shop", callId: "call-1", speech: "Otto here: urgent call from Maria, no AC. Check your Call Otto app.", now: "2026-11-23T15:00:00Z" });
    await expect(new TelnyxOwnerCallSender({ ...options, forwardsToOtto: async () => true }).send(notification)).rejects.toThrow(/forwards every call to Call Otto/);
    await expect(new TelnyxOwnerCallSender({ ...options, forwardsToOtto: async () => true }).send(notification)).rejects.toBeInstanceOf(NotificationHeldError);
    expect(posted).toHaveLength(0);
    // A lookup that fails is retried later (a plain error, not held), and never dials blind.
    const failed = new TelnyxOwnerCallSender({ ...options, forwardsToOtto: async () => { throw new Error("database unavailable"); } }).send(notification);
    await expect(failed).rejects.toThrow("database unavailable");
    await expect(failed).rejects.not.toBeInstanceOf(NotificationHeldError);
    expect(posted).toHaveLength(0);
    // A separate mobile (or missed-calls-only forwarding) still rings.
    expect((await new TelnyxOwnerCallSender({ ...options, forwardsToOtto: async () => false }).send(notification)).providerReceipt).toBe("owner-call:v3:x");
  });

  it("warm transfers skip the owner's business number in every-call mode", async () => {
    const store = new InMemoryStore();
    const config = { ...createDemoConfig(), warmTransferEnabled: true, operationMode: "always" as const };
    await store.saveIntegrationSecret("demo", "notifications", "owner-primary", "+15555550101");
    await store.saveIntegrationSecret("demo", "forwarding", "business_number", "+15555550101");
    expect(await approvedTransferTargets(store, config, "+15555550100", undefined)).toEqual([]);
    expect(await approvedTransferTargets(store, { ...config, operationMode: "overflow" }, "+15555550100", undefined)).toEqual([{ name: "Owner", to: "+15555550101" }]);
    // Back on "ring me first", but the last passed test was for every call: still no transfer there.
    await store.saveIntegrationSecret("demo", "forwarding", "tested_for", JSON.stringify({ mode: "every-call", code: "**21*15555550123#", at: "2026-11-23T15:00:00Z" }));
    expect(await approvedTransferTargets(store, { ...config, operationMode: "overflow" }, "+15555550100", undefined)).toEqual([]);
    // A ring-first test passed: transfers there again.
    await store.saveIntegrationSecret("demo", "forwarding", "tested_for", JSON.stringify({ mode: "ring-first", code: "**004*15555550123**10#", at: "2026-11-23T15:05:00Z" }));
    expect(await approvedTransferTargets(store, { ...config, operationMode: "overflow" }, "+15555550100", undefined)).toEqual([{ name: "Owner", to: "+15555550101" }]);
  });
});

describe("the AI setup helper's script", () => {
  const base = { businessName: "Gulf Air", businessNumber: "+19415550177", carrierName: "T-Mobile USA", family: "gsm" as const, code: "**21*19415550123#", offCode: "##002#", confirm: "You’ll see “Setting Registration Succeeded.”", ottoNumber: "+19415550123", ringSeconds: null, forwardsAll: true, everyCallCode: "**21*19415550123#", ringFirstCode: "**004*19415550123**15#", ringFirstSeconds: 15 };
  it("asks which they want, one sentence each, every call first and suggested", () => {
    const text = setupInstructions({ ...base, device: "iphone" });
    expect(text).not.toMatch(/before anything else/i);
    const everyCall = text.indexOf("Otto answers every call: no phone settings to change, Otto answers right away");
    const ringFirst = text.indexOf("Ring my phone first: their phone rings for 15 seconds first");
    expect(everyCall).toBeGreaterThan(0);
    expect(ringFirst).toBeGreaterThan(everyCall);
    expect(text).toContain("Suggest every call unless they want their phone to ring.");
    expect(text).toContain("Picked on their screen now: Otto answers every call.");
    // Both codes, so whichever they pick, the helper can read it.
    // Every call on an AT&T or T-Mobile iPhone is the Call Forwarding switch (forwardingSteps), code only as fallback.
    expect(text).toContain("For Otto answers every call, on this iPhone they use the Call Forwarding switch, no code. They can do it while on this call: open Settings, then Apps, then Phone.");
    expect(text).toContain("Tap Forward To and enter Otto's number, 9 4 1 5 5 5 0 1 2 3.");
    expect(text).toContain("If they don't see Call Forwarding, the code is **21*19415550123#");
    expect(text).toContain("For Ring my phone first, the code is **004*19415550123**15#");
    // The one iPhone prerequisite for ring first; nothing to change for every call.
    expect(text).toContain("On iPhone they first turn off Live Voicemail in Settings, then Apps, then Phone");
    expect(text).toContain("With every call, their phone won't ring, and they'll see a green check in a few seconds.");
    expect(text).toContain("With ring first, their phone rings and they don't answer or decline it");
    expect(text).toContain("let it ring (about 15 seconds)");
    expect(text).toContain("Call Forwarding Link Blocked");
    expect(text).toContain("tap Copy code & open Phone on their screen (if the Phone app doesn't open, they open Phone, then Keypad)");
    expect(text).toContain("Don't ask them to change phone settings unless they pick Ring my phone first on an iPhone, or their phone picked up our test call by itself.");
    expect(text).toContain("To turn forwarding off later, they dial ##002#");
    expect(text).toContain("With every call, they do that before they ever pause Call Otto");
    expect(text.match(/##002#/g)).toHaveLength(1);
    expect(text).toContain("tap Test it (or Test again)");
    expect(text).not.toContain("tap Call me now (or");
    expect(text).not.toContain("first ring");
    expect(text).toContain("their phone doesn't ring for those. Calls they make and texts work like before.");
    // Not solved: a time with our team, never a person's name.
    expect(text).toContain("offer a quick 10-minute call with our team (get_open_times, then book_time)");
    expect(text).not.toMatch(/Brock|founder/);
  });
  it("Android has nothing extra for ring first", () => {
    const text = setupInstructions({ ...base, device: "android" });
    expect(text).toContain("On Android there's nothing else to change.");
    expect(text).not.toContain("On iPhone they first turn off Live Voicemail");
    expect(text).toContain("Tap to dial");
  });
  it("a phone that answered the test itself: switch to every call, or turn off its own answering", () => {
    const text = setupInstructions({ ...base, code: "**004*19415550123**15#", forwardsAll: false, ringSeconds: 15, device: "iphone", phoneAnswersTest: true });
    expect(text).toContain("Their last test: their phone picked up our test call by itself.");
    expect(text).toContain("Picked on their screen now: Ring my phone first.");
    // On this iPhone every call is the switch, so there's no new code to dial.
    expect(text).toContain("switch to Otto answers every call (tap it on the screen), or keep ring first");
    // Android still dials the every-call code.
    expect(setupInstructions({ ...base, code: "**004*19415550123**15#", forwardsAll: false, ringSeconds: 15, device: "android", phoneAnswersTest: true })).toContain("switch to Otto answers every call (tap it on the screen, then dial the new code, **21*19415550123#");
    expect(text).toContain("Screen Unknown Callers set to Never");
    expect(text).toContain("Right now their phone rings first.");
  });
  it("leaving every call: the off code first, then the ring-first code, since forward-all wins otherwise", () => {
    const leaving = setupInstructions({ ...base, code: "**004*19415550123**15#", forwardsAll: false, ringSeconds: 15, device: "android", everyCallOn: true });
    expect(leaving).toContain("For Ring my phone first, every call may still be on, so they first turn forwarding off: dial ##002# (say it as: pound pound 0 0 2 pound) and press Call. Then they dial the ring-first code, **004*19415550123**15#");
    expect(leaving.indexOf("turn forwarding off: dial ##002#")).toBeLessThan(leaving.indexOf("Then they dial the ring-first code"));
    // Not on: just the code.
    expect(setupInstructions({ ...base, device: "android" })).not.toContain("every call may still be on");
    const verizon = setupInstructions({ ...base, family: "verizon", code: "*719415550123", offCode: "*73", everyCallCode: "*729415550123", ringFirstCode: "*719415550123", ringFirstSeconds: 30, forwardsAll: false, device: "iphone", everyCallOn: true });
    expect(verizon).toContain("turn forwarding off: dial *73 (say it as: star 7 3) and press Call. Then they dial the ring-first code, *719415550123");
    const office = setupInstructions({ ...base, family: "office", code: null, offCode: null, confirm: null, everyCallCode: null, ringFirstCode: null, ringFirstSeconds: null, device: "other", everyCallOn: true });
    expect(office).toContain("Every call may still be on: for Ring my phone first, they turn off forward all calls there first, then set calls not answered.");
  });

  it("Verizon rings about 30 seconds and nobody can change it", () => {
    const text = setupInstructions({ ...base, family: "verizon", code: "*729415550123", offCode: "*73", everyCallCode: "*729415550123", ringFirstCode: "*719415550123", ringFirstSeconds: 30, device: "android" });
    expect(text).toContain("rings for about 30 seconds (Verizon sets that; nobody can change it) first");
    expect(text).toContain("For Ring my phone first, the code is *719415550123");
  });
  it("office lines get the same choice, set in the phone company's website", () => {
    const text = setupInstructions({ ...base, family: "office", code: null, offCode: null, confirm: null, everyCallCode: null, ringFirstCode: null, ringFirstSeconds: null, device: "other" });
    expect(text).toContain("Otto answers every call (their phones won't ring for this number), or Ring my phone first");
    expect(text).toContain("forward all calls (for every call) or calls not answered");
  });
});

describe("dialing a code on this device", () => {
  const ua = {
    iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Mobile/15E148 Safari/604.1",
    iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
    androidChrome: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    androidFirefox: "Mozilla/5.0 (Android 15; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0",
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  };
  it("never renders a tel: link on an iPhone (iOS blocks forwarding links), only on Android browsers that dial it", () => {
    const link = "tel:%2A%2A004%2A19415550123%2A%2A15%23";
    expect(dialPlatform(ua.iphoneSafari)).toBe("iphone");
    expect(dialPlatform(ua.iphoneChrome)).toBe("iphone");
    expect(dialHref(dialPlatform(ua.iphoneSafari), link)).toBeNull();
    expect(dialHref(dialPlatform(ua.iphoneChrome), link)).toBeNull();
    expect(dialHref(dialPlatform(ua.androidChrome), link)).toBe(link);
    expect(dialHref(dialPlatform(ua.androidFirefox), link)).toBeNull();
    expect(dialPlatform(ua.mac)).toBe("desktop");
    expect(dialHref("desktop", link)).toBeNull();
  });
  it("reads the code in chunks and spells it out for screen readers", () => {
    expect(codeChunks("**004*19415550123**15#")).toEqual(["**004*1", "941", "555", "0123", "**15#"]);
    expect(codeChunks("*719415550123")).toEqual(["*71", "941", "555", "0123"]);
    expect(codeChunks("**21*19415550123#")).toEqual(["**21*1", "941", "555", "0123#"]);
    expect(spokenCode("*71#")).toBe("star 7 1 pound");
  });
  it("offers the same ring choices as the server, and says Verizon's 30 seconds can't be shortened", () => {
    expect(WEB_RING_CHOICES).toEqual(RING_CHOICES);
    expect(webRingSeconds(Number.NaN)).toBe(ringSeconds(undefined));
    expect(VERIZON_RING_LINE).toBe("Verizon rings about 30 seconds first. Verizon doesn’t allow less.");
    expect([2, 2.5, 3, 4, 5, 8].map(webRingSeconds)).toEqual([2, 2.5, 3, 4, 5, 8].map((rings) => ringSeconds(rings)));
    expect(webRingChoicesWith(10)).toEqual(ringChoicesWith(10));
  });
});

describe("iPhone: copy the code, then paste it in Phone", () => {
  const code = "**21*19415550123#";

  it("copies with the Clipboard API and never opens a tel: link (the empty Call sheet on the walk)", async () => {
    const copied: string[] = [];
    const ok = await copyText(code, { clipboard: { writeText: async (text) => { copied.push(text); } }, fallback: () => { throw new Error("not needed"); } });
    expect(ok).toBe(true);
    expect(copied).toEqual([code]);
  });

  it("falls back to the old copy when the Clipboard API refuses, and says no when both fail", async () => {
    const denied = { writeText: async () => { throw new Error("denied"); } };
    expect(await copyText(code, { clipboard: denied, fallback: () => true })).toBe(true);
    expect(await copyText(code, { clipboard: undefined, fallback: () => true })).toBe(true);
    expect(await copyText(code, { clipboard: denied, fallback: () => false })).toBe(false);
    expect(await copyText(code, { clipboard: undefined, fallback: () => { throw new Error("no DOM"); } })).toBe(false);
  });

  it("says exactly where to paste on each device, and what the carrier shows before they dial", () => {
    expect(pasteLine("iphone")).toBe("Open Phone, tap Keypad, press and hold the number line, tap Paste, then Call.");
    expect(pasteLine("desktop")).toContain("On your phone");
    expect(afterDialLine("gsm", "iphone")).toBe("Your carrier shows a gray box that says Succeeded. Tap Dismiss and come back.");
    expect(afterDialLine("verizon", "iphone")).toBe("You’ll hear a tone. Hang up and come back.");
    expect(afterDialLine("gsm", "android")).not.toContain("gray box");
  });
});

describe("signed out on an owner-app page", () => {
  it("signs in, then comes back to the same page (the setup QR code on a phone)", () => {
    expect(loginReturningHere({ pathname: "/app/start", search: "?step=forward" })).toBe("/login?next=%2Fapp%2Fstart%3Fstep%3Dforward");
    expect(safeNext(decodeURIComponent(loginReturningHere({ pathname: "/app/start", search: "?step=forward" }).slice("/login?next=".length)))).toBe("/app/start?step=forward");
    expect(loginReturningHere({ pathname: "/app", search: "" })).toBe("/login");
    expect(loginReturningHere({ pathname: "/pricing", search: "" })).toBe("/login");
    expect(loginReturningHere({ pathname: "/application", search: "" })).toBe("/login");
  });
});

describe("the pause warning in Settings", () => {
  it("shows only when they pick Paused and every call may go to Otto (same rule that stops Otto dialing the number)", () => {
    expect(pauseHint({ active: true, paused: true, mayForwardAll: true, off: "##002#" })).toBe("Otto answers every call, so pausing stops all calls to your business number. Turn forwarding off first: dial ##002# on that phone.");
    expect(pauseHint({ active: true, paused: true, mayForwardAll: true, off: null })).toContain("Turn forwarding off first with your phone company.");
    expect(pauseHint({ active: true, paused: false, mayForwardAll: true, off: "##002#" })).toBeUndefined();
    expect(pauseHint({ active: true, paused: true, mayForwardAll: false, off: "##002#" })).toBeUndefined();
    expect(pauseHint({ active: false, paused: true, mayForwardAll: true, off: "##002#" })).toBe("Your line turns on after it’s approved. Until then it stays paused.");
  });
});

describe("timing a ring-first test", () => {
  it("under about 8 seconds never rang (every call still forwarded); about 8 or more rang first", async () => {
    const { ringFirstVerdict, rangSeconds, RING_FIRST_AT_ONCE_MS, NOT_FORWARDING_AFTER_MS } = await import("../src/domain/forwarding.js");
    expect(RING_FIRST_AT_ONCE_MS).toBe(8_000);
    expect(ringFirstVerdict(1_500)).toBe("at_once");
    expect(ringFirstVerdict(3_900)).toBe("at_once");
    // A slow forward-all (two phone legs plus Otto starting up) is still "never rang".
    expect(ringFirstVerdict(7_000)).toBe("at_once");
    expect(ringFirstVerdict(RING_FIRST_AT_ONCE_MS - 1)).toBe("at_once");
    expect(ringFirstVerdict(RING_FIRST_AT_ONCE_MS)).toBe("rang");
    expect(ringFirstVerdict(12_000)).toBe("rang");
    expect(ringFirstVerdict(Number.NaN)).toBe("at_once");
    // Call setup (about 2 s) is left out of "it rang about N seconds".
    expect(rangSeconds(12_400)).toBe(10);
    expect(rangSeconds(200)).toBe(1);
    expect(NOT_FORWARDING_AFTER_MS).toBe(45_000);
  });

  it("every call picked: a quick arrival is right; 12 seconds or more means the phone rang first", async () => {
    const { everyCallVerdict, EVERY_CALL_RANG_MS } = await import("../src/domain/forwarding.js");
    expect(everyCallVerdict(2_000)).toBe("at_once");
    expect(everyCallVerdict(9_000)).toBe("at_once");
    expect(everyCallVerdict(EVERY_CALL_RANG_MS)).toBe("rang");
    expect(everyCallVerdict(30_000)).toBe("rang");
  });
});

describe("the code by default, the iPhone switch only behind a link (forwardingSteps)", () => {
  const steps = (device: SetupDevice, family: string | null, everyCall: boolean, leavingProvenEveryCall = false) => forwardingSteps({ device, family, everyCall, leavingProvenEveryCall });
  const devices: SetupDevice[] = ["iphone", "android", "phone", "desktop"];
  const families = ["gsm", "verizon", "office", "unknown", null];

  it("the default way to turn forwarding on, clear it and turn it off is the code: every device, carrier and choice", () => {
    for (const device of devices) for (const family of families) for (const everyCall of [true, false]) for (const leaving of [true, false]) {
      expect(steps(device, family, everyCall, leaving)).toMatchObject({ on: "code", clear: "code", off: "code" });
    }
  });

  it("every call on an iPhone with a GSM-family or unknown carrier: the switch is the other way, on and off", () => {
    expect(steps("iphone", "gsm", true)).toEqual({ on: "code", clear: "code", off: "code", iphoneSwitch: { on: true, clear: true, off: true }, clearFirst: false });
    expect(steps("iphone", "unknown", true).iphoneSwitch).toEqual({ on: true, clear: true, off: true });
    expect(steps("iphone", null, true).iphoneSwitch).toEqual({ on: true, clear: true, off: true });
  });

  it("ring first on that iPhone has no switch (code only), but clearing every call can be the switch", () => {
    expect(steps("iphone", "gsm", false)).toEqual({ on: "code", clear: "code", off: "code", iphoneSwitch: { on: false, clear: true, off: false }, clearFirst: false });
    expect(steps("iphone", "unknown", false).iphoneSwitch).toEqual({ on: false, clear: true, off: false });
  });

  it("clears first only when leaving an every call a test proved on; unproven, the ring-first code comes first", () => {
    expect(steps("iphone", "gsm", false, true).clearFirst).toBe(true);
    expect(steps("desktop", "gsm", false, true).clearFirst).toBe(true);
    expect(steps("iphone", "gsm", false, false).clearFirst).toBe(false);
    expect(forwardingSteps({ device: "iphone", family: "gsm", everyCall: false }).clearFirst).toBe(false);
    // Never while every call is the choice.
    expect(steps("iphone", "gsm", true, true).clearFirst).toBe(false);
  });

  it("proven means our own timed test for every call: a choice only picked, or a test from another phone, isn't", () => {
    const at = "2026-11-27T15:00:00.000Z";
    expect(everyCallProven({ mode: "every-call", code: "**21*19415550123#", at, timed: true })).toBe(true);
    // Left every call untested (rememberLegacyTestedFor), or a ring-first test found every call still on.
    expect(everyCallProven({ mode: "every-call", code: "**21*19415550123#", at })).toBe(false);
    expect(everyCallProven({ mode: "every-call", code: null, at })).toBe(false);
    expect(everyCallProven({ mode: "ring-first", code: "**004*19415550123**10#", at, timed: true, rangSeconds: 10 })).toBe(false);
    expect(everyCallProven(null)).toBe(false);
  });

  it("Verizon family (no switch on those iPhones), office lines and Android have no other way, in both modes", () => {
    for (const [device, family] of [["iphone", "verizon"], ["iphone", "office"], ["android", "gsm"], ["android", "verizon"], ["android", "unknown"], ["phone", "gsm"]] as const) {
      for (const everyCall of [true, false]) expect(steps(device, family, everyCall, true)).toEqual({ on: "code", clear: "code", off: "code", iphoneSwitch: { on: false, clear: false, off: false }, clearFirst: false });
    }
  });

  it("a computer offers the iPhone switch behind the link for every call on GSM family (the owner then picks up the phone)", () => {
    expect(steps("desktop", "gsm", true).iphoneSwitch).toEqual({ on: true, clear: true, off: true });
    expect(steps("desktop", "gsm", false).iphoneSwitch).toEqual({ on: false, clear: true, off: false });
    expect(steps("desktop", "verizon", true).iphoneSwitch).toEqual({ on: false, clear: false, off: false });
  });

  it("the owner app uses the very same decision and words", () => {
    expect(webForwardingSteps).toBe(forwardingSteps);
    expect(WEB_CODE_FAILED_LINK).toBe(CODE_FAILED_LINK);
  });

  it("the quiet link names no Settings, and behind it the code comes first, then the switch", () => {
    expect(CODE_FAILED_LINK).toBe("Code didn’t work?");
    expect(CODE_FAILED_LINK_DESKTOP).toBe("Code didn’t work on your iPhone?");
    expect(RETRY_CODE_LINE).toBe("First try the code once more, typed by hand.");
    expect(SWITCH_INSTEAD_LINE).toBe("Or use the switch on your iPhone:");
    expect(BACK_TO_CODE_LINK).toBe("Back to the code");
    for (const line of [CODE_FAILED_LINK, CODE_FAILED_LINK_DESKTOP, RETRY_CODE_LINE, SWITCH_INSTEAD_LINE, BACK_TO_CODE_LINK]) expect(line).not.toMatch(/Settings|Live Voicemail|Screen Unknown|—/);
  });

  it("copies Otto's number as the 10 digits Forward To takes", () => {
    expect(forwardToDigits("+13125550144")).toBe("3125550144");
    expect(forwardToDigits("(312) 555-0144")).toBe("3125550144");
    expect(SETTINGS_ON_STEPS).toEqual(["Open Settings › Apps › Phone.", "Tap Call Forwarding and turn it on.", "Tap Forward To and paste the number."]);
    expect(SETTINGS_OFF_LINE).toBe("Open Settings › Apps › Phone. Tap Call Forwarding and turn it off.");
    // The switch path never mentions the gray box: there is none.
    expect([...SETTINGS_ON_STEPS, SETTINGS_OFF_LINE].join(" ")).not.toMatch(/gray|Dismiss/i);
  });

  it("the plan names the code that turns every call off, whatever today's choice", () => {
    // T-Mobile family ring first clears missed-call rules with ##004#; forward-all (a code or the switch) needs ##002#.
    expect(forwardingPlan("gsm", "+19415550123", "overflow", 2, { carrierName: "T-Mobile USA" })).toMatchObject({ off: "##004#", everyCallOff: "##002#" });
    expect(forwardingPlan("gsm", "+19415550123", "overflow", 2, { carrierName: "AT&T Mobility" })).toMatchObject({ off: "##002#", everyCallOff: "##002#" });
    expect(forwardingPlan("gsm", "+19415550123", "always")).toMatchObject({ off: "##002#", everyCallOff: "##002#" });
    expect(forwardingPlan("verizon", "+19415550123", "overflow")).toMatchObject({ off: "*73", everyCallOff: "*73" });
    expect(forwardingPlan("office", "+19415550123", "overflow").everyCallOff ?? null).toBeNull();
  });

  it("keeps the gray-box heads-up for every code dialed on an iPhone (iOS draws the box; nothing hides it)", () => {
    expect(afterDialLine("gsm", "iphone")).toBe("Your carrier shows a gray box that says Succeeded. Tap Dismiss and come back.");
  });
});

describe("after a test the phone took itself: every call first, the phone's settings last", () => {
  it("leads with the fix that needs no phone settings", () => {
    expect(EVERY_CALL_FIX_LINE).toBe("Easiest fix: let Otto answer every call.");
    expect(EVERY_CALL_FIX_LINE).not.toMatch(/Settings|Live Voicemail|Screen Unknown/);
  });

  it("the phone picked up the test: an iPhone gets its two settings as a list, others one line to keep ring first", () => {
    expect(keepRingFirstLine("phone_answers", "iphone")).toBeNull();
    expect(keepRingFirstLine("phone_answers", "android")).toBe("To keep Ring my phone first, turn off call screening in your Phone app’s settings.");
    expect(keepRingFirstLine("phone_answers", "other")).toBe(`To keep Ring my phone first: on iPhone, ${IPHONE_PHONE_SETTINGS}, Live Voicemail off and Screen Unknown Callers Never. On Android, call screening off.`);
  });

  it("voicemail answered: Live Voicemail is the last thing said, and never on Android", () => {
    // The path stays on one line (no-break spaces), so a "›" never starts a line on a phone.
    expect(IPHONE_PHONE_SETTINGS.replace(/\u00a0/g, " ")).toBe("Settings › Apps › Phone");
    expect(IPHONE_PHONE_SETTINGS).not.toContain(" ");
    expect(keepRingFirstLine("voicemail", "iphone")).toBe(`Still voicemail? Turn Live Voicemail off in ${IPHONE_PHONE_SETTINGS}.`);
    expect(keepRingFirstLine("voicemail", "other")).toBe(`Still voicemail? On iPhone, turn Live Voicemail off in ${IPHONE_PHONE_SETTINGS}.`);
    expect(keepRingFirstLine("voicemail", "android")).toBeNull();
  });

  it("the card shows those settings only under the every-call button of a failed test, never in step 1", () => {
    const card = readFileSync(new URL("../web/src/components/app/forwarding-card.tsx", import.meta.url), "utf8");
    const stepOne = card.slice(card.indexOf('<Step n={1}'), card.indexOf('<Step n={2}'));
    expect(stepOne).toContain("<ModeChoice");
    expect(stepOne).not.toMatch(/IphoneSettings|KeepRingFirst|Settings|Live Voicemail/);
    // One place renders the two-settings box: KeepRingFirst, after a phone_answers test.
    expect(card.match(/<IphoneSettings \/>/g)).toHaveLength(1);
    expect(card).toContain('if (status === "phone_answers" && isIphone) return <IphoneSettings />');
    expect(card.match(/<KeepRingFirst /g)).toHaveLength(1);
    const stepThree = card.slice(card.indexOf('<Step n={3}'), card.indexOf("</ol>"));
    const button = stepThree.indexOf("Switch to Otto answers every call");
    const keep = stepThree.indexOf('{fixOffer && (status === "phone_answers" || status === "voicemail") && <KeepRingFirst status={status} />}');
    expect(stepThree.indexOf("<CheckResult")).toBeLessThan(button);
    expect(keep).toBeGreaterThan(button);
    // The result itself: every call first for a phone that picked up; the code again first for voicemail.
    const result = card.slice(card.indexOf("function CheckResult"), card.indexOf("function redial"));
    expect(result).toContain('? ["Your phone picked up the test itself.", everyCallOffer ? EVERY_CALL_FIX_LINE : settingsFix()]');
    expect(result).toContain('? ["Your voicemail answered the test.", redial(plan.family), ...(isAndroid || everyCallOffer ? [] : ["iPhone: turn Live Voicemail off (Settings › Apps › Phone)."])]');
  });

  it("the card's step 2 is the code by default; the switch shows only after the quiet link, and every new code starts on the code", () => {
    const card = readFileSync(new URL("../web/src/components/app/forwarding-card.tsx", import.meta.url), "utf8");
    expect(card).toContain("const [switchWay, setSwitchWay] = useState(false)");
    expect(card).toContain("const viaSettings = hasSwitch && switchWay");
    expect(card).toContain("useEffect(() => { setSwitchWay(false) }, [dialCode])");
    expect(card).toContain("{switchWay ? BACK_TO_CODE_LINK : codeFailedLink}");
    expect(card).not.toMatch(/NO_SWITCH_LINK|Use iPhone Settings instead|codeWay/);
    // Behind the link the code again comes first, then the switch; never the QR to the code page next to switch steps.
    for (const name of ["function SettingsSwitch", "function SwitchOff"]) {
      const block = card.slice(card.indexOf(name), card.indexOf("\n}\n", card.indexOf(name)));
      expect(block.indexOf("{RETRY_CODE_LINE}")).toBeGreaterThan(0);
      expect(block.indexOf("{SWITCH_INSTEAD_LINE}")).toBeGreaterThan(block.indexOf("{RETRY_CODE_LINE}"));
      expect(block).not.toContain("<PhoneHandoff");
    }
    // Leaving a proven every call: the code that turns every call off, before any ring-first test.
    expect(card).toContain("leavingProvenEveryCall: Boolean(business.update?.leavingEveryCall) && business.everyCallProven === true");
    expect(card).toContain("const clearCode = forwardsAll ? plan?.off ?? null : plan?.everyCallOff ?? plan?.off ?? null");
  });
});
