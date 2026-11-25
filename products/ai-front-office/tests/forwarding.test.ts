import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { TelnyxOwnerCallSender } from "../src/adapters/telnyx-owner-call.js";
import { setupInstructions } from "../src/adapters/telnyx-setup-call.js";
import { dialsBackToOtto } from "../src/application/forwarding-loop.js";
import { urgentOwnerCallNotification } from "../src/application/owner-alerts.js";
import { approvedTransferTargets } from "../src/application/transfer-policy.js";
import { createDemoConfig } from "../src/domain/config.js";
import { carrierFamily, codeProvenByTest, forwardingOffInstruction, forwardingPlan, forwardsBackToOtto, isForwardAllCode, RING_CHOICES, ringChoicesWith, ringSeconds } from "../src/domain/forwarding.js";
import { forwardingCheckStatus, forwardingUpdate } from "../src/http/owner-api-model.js";
import { NotificationHeldError } from "../src/ports.js";
import { codeChunks, dialHref, dialPlatform, RING_CHOICES as WEB_RING_CHOICES, ringChoicesWith as webRingChoicesWith, ringSeconds as webRingSeconds, spokenCode } from "../web/src/lib/dial.js";

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
    expect(ringSeconds(undefined)).toBe(15);
    expect(ringSeconds(Number.NaN)).toBe(15);
    expect(RING_CHOICES.map((choice) => [choice.rings, ringSeconds(choice.rings)])).toEqual(RING_CHOICES.map((choice) => [choice.rings, choice.seconds]));
    // New shops start at 15 seconds.
    expect(ringSeconds(createDemoConfig().answerAfterRings)).toBe(15);
  });

  it("puts the timer in the one GSM code, 15 seconds unless the owner picked another time", () => {
    expect(forwardingPlan("gsm", "+19415550123", "overflow")).toMatchObject({ on: "**004*19415550123**15#", off: "##002#", ringSeconds: 15, forwardsAll: false });
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
    expect(ringChoicesWith(2.5)).toHaveLength(RING_CHOICES.length);
    expect(ringChoicesWith(8).find((choice) => choice.rings === 8)).toMatchObject({ seconds: 30, label: "30 seconds (the longest carriers allow)" });
  });
});

describe("after a settings change, the one new code to dial", () => {
  const gsm15 = forwardingPlan("gsm", "+19415550123", "overflow", 2.5);
  it("asks for nothing when forwarding isn't confirmed or the dialed code still matches", () => {
    expect(forwardingUpdate(gsm15, null, "**004*19415550123**25#")).toBeNull();
    expect(forwardingUpdate(gsm15, "2026-11-23T15:00:00Z", gsm15.on)).toBeNull();
    expect(forwardingUpdate(gsm15, "2026-11-23T15:00:00Z", null)).toBeNull();
  });
  it("shows the new code after a ring-time or every-call change, clearing every-call first when leaving it", () => {
    expect(forwardingUpdate(gsm15, "2026-11-23T15:00:00Z", "**004*19415550123**25#")).toEqual({ clearFirst: null });
    expect(forwardingUpdate(forwardingPlan("gsm", "+19415550123", "always"), "2026-11-23T15:00:00Z", gsm15.on)).toEqual({ clearFirst: null });
    expect(forwardingUpdate(gsm15, "2026-11-23T15:00:00Z", "**21*19415550123#")).toEqual({ clearFirst: "##002#" });
    expect(forwardingUpdate(forwardingPlan("verizon", "+19415550123", "overflow"), "2026-11-23T15:00:00Z", "*729415550123")).toEqual({ clearFirst: "*73" });
  });
});

describe("which code a passing test proves", () => {
  const all = "**21*19415550123#";
  const ring15 = "**004*19415550123**15#";
  it("the code on screen when the test started, never today's settings", () => {
    expect(codeProvenByTest({ code: ring15, previous: null, passMs: 9_000 })).toBe(ring15);
    expect(codeProvenByTest({ code: ring15, previous: "**004*19415550123**25#", passMs: 20_000 })).toBe(ring15);
    expect(codeProvenByTest({ code: null, previous: null, passMs: 9_000 })).toBeNull();
  });
  it("every call: only a pass that came straight through (the phone never rang)", () => {
    expect(codeProvenByTest({ code: all, previous: ring15, passMs: 4_000 })).toBe(all);
    expect(codeProvenByTest({ code: "*729415550123", previous: null, passMs: 10_000 })).toBe("*729415550123");
    // 14 s: the phone rang and was declined, so **21 isn't dialed yet.
    expect(codeProvenByTest({ code: all, previous: ring15, passMs: 14_000 })).toBeNull();
  });
  it("leaving every call: a pass that came straight through means forward-all is still on", () => {
    expect(codeProvenByTest({ code: ring15, previous: all, passMs: 3_000 })).toBeNull();
    expect(codeProvenByTest({ code: ring15, previous: all, passMs: 8_000 })).toBe(ring15);
    expect(codeProvenByTest({ code: "*719415550123", previous: "*729415550123", passMs: 2_000 })).toBeNull();
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
  it("in every-call mode, or while a forward-all code is still dialed in, and only the business number itself", () => {
    expect(forwardsBackToOtto({ mode: "always", businessNumber: "+19415550177", phone: "+19415550177" })).toBe(true);
    expect(forwardsBackToOtto({ mode: "always", businessNumber: "+19415550177", phone: "+19415550199" })).toBe(false);
    expect(forwardsBackToOtto({ mode: "overflow", businessNumber: "+19415550177", phone: "+19415550177" })).toBe(false);
    expect(forwardsBackToOtto({ mode: "always", businessNumber: null, phone: "+19415550177" })).toBe(false);
    // Switched back to "ring me first", but the off code isn't dialed yet: **21 / *72 still sends everything to Otto.
    expect(forwardsBackToOtto({ mode: "overflow", businessNumber: "+19415550177", phone: "+19415550177", dialedCode: "**21*19415550123#" })).toBe(true);
    expect(forwardsBackToOtto({ mode: "after_hours", businessNumber: "+19415550177", phone: "+19415550177", dialedCode: "*729415550123" })).toBe(true);
    expect(forwardsBackToOtto({ mode: "overflow", businessNumber: "+19415550177", phone: "+19415550177", dialedCode: "**004*19415550123**15#" })).toBe(false);
    expect(forwardsBackToOtto({ mode: "overflow", businessNumber: "+19415550177", phone: "+19415550199", dialedCode: "**21*19415550123#" })).toBe(false);
  });

  it("reads the shop's mode and business number from the store", async () => {
    const store = new InMemoryStore();
    await store.saveConfig({ ...createDemoConfig("shop"), operationMode: "always" });
    await store.saveIntegrationSecret("shop", "forwarding", "business_number", "+19415550177");
    expect(await dialsBackToOtto(store, "shop", "+19415550177")).toBe(true);
    expect(await dialsBackToOtto(store, "shop", "+19415550199")).toBe(false);
    expect(await dialsBackToOtto(store, "shop", null)).toBe(false);
    await store.saveConfig({ ...createDemoConfig("shop"), operationMode: "overflow" });
    expect(await dialsBackToOtto(store, "shop", "+19415550177")).toBe(false);
    await store.saveIntegrationSecret("shop", "forwarding", "dialed_code", "**21*19415550123#");
    expect(await dialsBackToOtto(store, "shop", "+19415550177")).toBe(true);
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
    // Back on "ring me first" but **21 still dialed in: still no transfer there.
    await store.saveIntegrationSecret("demo", "forwarding", "dialed_code", "**21*15555550123#");
    expect(await approvedTransferTargets(store, { ...config, operationMode: "overflow" }, "+15555550100", undefined)).toEqual([]);
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
  it("offers the same ring choices as the server", () => {
    expect(WEB_RING_CHOICES).toEqual(RING_CHOICES);
    expect([2, 2.5, 3, 4, 5, 8].map(webRingSeconds)).toEqual([2, 2.5, 3, 4, 5, 8].map((rings) => ringSeconds(rings)));
    expect(webRingChoicesWith(10)).toEqual(ringChoicesWith(10));
  });
});
