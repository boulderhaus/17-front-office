import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { TelnyxOwnerCallSender } from "../src/adapters/telnyx-owner-call.js";
import { setupInstructions } from "../src/adapters/telnyx-setup-call.js";
import { dialsBackToOtto } from "../src/application/forwarding-loop.js";
import { urgentOwnerCallNotification } from "../src/application/owner-alerts.js";
import { approvedTransferTargets } from "../src/application/transfer-policy.js";
import { createDemoConfig } from "../src/domain/config.js";
import { carrierFamily, forwardingChoice, forwardingOffInstruction, forwardingPlan, forwardsBackToOtto, isForwardAllCode, mayForwardAll, parseTestedFor, RING_CHOICES, ringChoicesWith, ringSeconds, type TestedFor } from "../src/domain/forwarding.js";
import { forwardingCheckStatus, forwardingUpdate } from "../src/http/owner-api-model.js";
import { NotificationHeldError } from "../src/ports.js";
import { codeChunks, copyAndOpenPhone, dialHref, dialPlatform, OPEN_PHONE_WAIT_MS, RING_CHOICES as WEB_RING_CHOICES, ringChoicesWith as webRingChoicesWith, ringSeconds as webRingSeconds, spokenCode, VERIZON_RING_LINE } from "../web/src/lib/dial.js";
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
    expect(parseTestedFor(JSON.stringify(tested("every-call", all.on)))).toEqual(tested("every-call", all.on));
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
    expect(text).toContain("For Otto answers every call, the code is **21*19415550123#");
    expect(text).toContain("For Ring my phone first, the code is **004*19415550123**15#");
    // The one iPhone prerequisite for ring first; nothing to change for every call.
    expect(text).toContain("On iPhone they first turn off Live Voicemail in Settings, then Apps, then Phone");
    expect(text).toContain("With every call, their phone won't ring, and they'll see a green check in a few seconds.");
    expect(text).toContain("With ring first, they tap Decline when it rings");
    expect(text).toContain("let it ring (about 15 seconds)");
    expect(text).toContain("Call Forwarding Link Blocked");
    expect(text).toContain("tap Copy code & open Phone on their screen (if the Phone app doesn't open, they open Phone, then Keypad)");
    expect(text).toContain("Don't ask them to change phone settings unless they pick Ring my phone first on an iPhone, or their phone picked up our test call by itself.");
    expect(text).toContain("To turn forwarding off later, they dial ##002#");
    expect(text).toContain("With every call, they do that before they ever pause Call Otto");
    expect(text.match(/##002#/g)).toHaveLength(1);
    expect(text).toContain("tap Call me now (or Test again)");
    expect(text).not.toContain("first ring");
    expect(text).toContain("their phone doesn't ring for those. Calls they make and texts work like before.");
    // The founder-email promise stays.
    expect(text).toContain("Brock, our founder, will email them a link to book a 10-minute call");
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
    expect(text).toContain("switch to Otto answers every call (tap it on the screen, then dial the new code, **21*19415550123#");
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

describe("iPhone: Copy code & open Phone", () => {
  function fakeIphone(options: { clipboard?: boolean; leaves?: boolean; failCopy?: boolean } = {}) {
    const events: string[] = [];
    let visibility: "visible" | "hidden" = "visible";
    const listeners = new Set<() => void>();
    let timer: (() => void) | null = null;
    let waited = 0;
    const location = { href: "https://app.callotto.example/app/start?step=forward" };
    const env = {
      clipboard: options.clipboard === false ? undefined : { writeText: async (text: string) => { events.push(`copy:${text}`); if (options.failCopy) throw new Error("denied"); } },
      location,
      document: {
        get visibilityState() { return visibility; },
        addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
        removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
      },
      setTimeout: (run: () => void, ms: number) => { timer = run; waited = ms; },
      onCopied: (copied: boolean) => events.push(copied ? "copied" : "not-copied"),
      onStayed: () => events.push("stayed"),
    };
    const leave = () => { visibility = "hidden"; for (const listener of listeners) listener(); };
    return { env, events, location, leave, fire: () => timer?.(), waited: () => waited, listeners };
  }
  const code = "**21*19415550123#";

  it("copies the code, then once it's copied opens Phone with a bare tel:, never the code itself", async () => {
    const phone = fakeIphone();
    await copyAndOpenPhone(code, phone.env);
    expect(phone.location.href).toBe("tel:");
    expect(phone.location.href).not.toContain("21");
    expect(phone.events.slice(0, 2)).toEqual([`copy:${code}`, "copied"]);
    expect(phone.waited()).toBe(OPEN_PHONE_WAIT_MS);
    expect(OPEN_PHONE_WAIT_MS).toBe(1_200);
  });

  it("Phone opened (the page went to the background): no instruction line", async () => {
    const phone = fakeIphone();
    await copyAndOpenPhone(code, phone.env);
    phone.leave();
    phone.fire();
    expect(phone.events).not.toContain("stayed");
    expect(phone.listeners.size).toBe(0);
  });

  it("still on the page after the wait: shows 'Paste it in Phone › Keypad and tap Call.'", async () => {
    const phone = fakeIphone();
    await copyAndOpenPhone(code, phone.env);
    phone.fire();
    expect(phone.events).toContain("stayed");
  });

  it("the copy failed: never leaves the page (nothing to paste, and the message would hide behind Phone), says to type it", async () => {
    const phone = fakeIphone({ failCopy: true });
    await copyAndOpenPhone(code, phone.env);
    expect(phone.location.href).not.toBe("tel:");
    expect(phone.events).toEqual([`copy:${code}`, "not-copied"]);
    expect(phone.waited()).toBe(0);
  });

  it("no clipboard: never leaves the page, says to type it", async () => {
    const phone = fakeIphone({ clipboard: false });
    await copyAndOpenPhone(code, phone.env);
    expect(phone.location.href).not.toBe("tel:");
    expect(phone.events).toEqual(["not-copied"]);
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
