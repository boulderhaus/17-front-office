import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { CallService } from "../src/application/call-service.js";
import { createDemoConfig, normalizeBusinessConfig } from "../src/domain/config.js";
import type { CallRecord, CallSummaryInput, CollectedCallFields, OutboxNotification } from "../src/domain/models.js";
import { MIN_BILLABLE_CALL_SECONDS, currentBillingPeriod, dueUsageAlerts, usageClass } from "../src/domain/usage.js";
import type { Clock } from "../src/ports.js";

class MutableClock implements Clock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value); }
  set(value: string): void { this.value = new Date(value); }
}

const fields: CollectedCallFields = {
  callerName: "Test Caller", companyName: null, callbackNumber: "+15555550100", address: "100 Main St, Springfield, IL",
  serviceCategory: "HVAC maintenance", serviceCategoryConfidence: 0.95, problemDescription: "Routine maintenance",
  equipmentDetails: null, accessNotes: null, requestedStart: null, explicitSlotConfirmation: false,
  diagnosticFeeAccepted: true, humanRequested: false, confidence: 0.95,
};

function storedCall(overrides: Partial<CallRecord>): CallRecord {
  return {
    id: randomUUID(), tenantId: "demo", providerCallId: `v3:${randomUUID()}`, fromNumber: "+15555550100", fromNumberVerified: true,
    startedAt: "2026-01-10T12:00:00.000Z", endedAt: "2026-01-10T12:05:00.000Z", durationSeconds: 300,
    fields, emergency: null, outcome: "pending_confirmation", transcript: null, recordingUrl: null, consentState: "unknown",
    billingDisposition: "billable", qualityFlags: [], createdAt: "2026-01-10T12:00:00.000Z", updatedAt: "2026-01-10T12:05:00.000Z",
    ...overrides,
  };
}

describe("what counts against the owner's minutes", () => {
  it("never counts spam or calls under 15 seconds, and counts 15 seconds exactly", () => {
    expect(MIN_BILLABLE_CALL_SECONDS).toBe(15);
    expect(usageClass(storedCall({ durationSeconds: 15 }))).toBe("billable");
    expect(usageClass(storedCall({ durationSeconds: 14 }))).toBe("short");
    expect(usageClass(storedCall({ durationSeconds: null }))).toBe("short");
    expect(usageClass(storedCall({ billingDisposition: "spam_excluded", outcome: "ignored_spam", durationSeconds: 600 }))).toBe("spam");
    // A spam outcome is never billed, even if an older record carried a billable disposition.
    expect(usageClass(storedCall({ outcome: "ignored_spam", durationSeconds: 600 }))).toBe("spam");
    expect(usageClass(storedCall({ billingDisposition: "not_billable", outcome: "handoff_queued" }))).toBe("not_billable");
  });

  it("sums only real calls in the usage summary and reports what it skipped", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    for (const call of [
      storedCall({ durationSeconds: 61 }), // 2 minutes
      storedCall({ durationSeconds: 15 }), // 1 minute
      storedCall({ durationSeconds: 14 }), // short
      storedCall({ durationSeconds: 3 }), // short
      storedCall({ durationSeconds: null }), // short (never connected)
      storedCall({ billingDisposition: "spam_excluded", outcome: "ignored_spam", durationSeconds: 900 }),
      storedCall({ outcome: "ignored_spam", durationSeconds: 120 }),
      storedCall({ billingDisposition: "not_billable", outcome: "handoff_queued", durationSeconds: 400 }),
      storedCall({ durationSeconds: 600, startedAt: "2026-02-01T00:00:00.000Z" }), // next period
      storedCall({ durationSeconds: 600, tenantId: "other-shop" }),
    ]) await store.saveCall(call);
    expect(await store.getUsageSummary("demo", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")).toEqual({
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2026-02-01T00:00:00.000Z",
      billableCalls: 2,
      billedMinutes: 3,
      excludedSpamCalls: 2,
      excludedShortCalls: 3,
    });
  });

  it("keeps a short call's record but leaves it out of billed minutes", async () => {
    const { store, service, finish } = rig();
    const call = await finish("short-hangup", 9);
    expect(call.billingDisposition).toBe("billable");
    expect(call.durationSeconds).toBe(9);
    const usage = await store.getUsageSummary("demo", ...currentBillingPeriod(new Date("2026-01-15T08:00:00.000Z")));
    expect(usage).toMatchObject({ billableCalls: 0, billedMinutes: 0, excludedShortCalls: 1 });
    expect(service).toBeDefined();
  });
});

describe("usage alerts", () => {
  it("picks the first threshold below 100% and only the 100% alert once the plan is used up", () => {
    expect(dueUsageAlerts(149, 200, 75)).toEqual([]);
    expect(dueUsageAlerts(150, 200, 75)).toEqual([75]);
    expect(dueUsageAlerts(199, 200, 75)).toEqual([75]);
    expect(dueUsageAlerts(200, 200, 75)).toEqual([100]);
    expect(dueUsageAlerts(260, 200, 90)).toEqual([100]);
    expect(dueUsageAlerts(179, 200, 90)).toEqual([]);
    expect(dueUsageAlerts(180, 200, 90)).toEqual([90]);
    expect(dueUsageAlerts(50, 0, 75)).toEqual([]);
  });

  it("defaults to 75% and fills it in for shops saved before alerts existed", () => {
    expect(createDemoConfig().usageAlertPercent).toBe(75);
    const legacy = { ...createDemoConfig("legacy") } as Partial<ReturnType<typeof createDemoConfig>>;
    delete legacy.usageAlertPercent;
    expect(normalizeBusinessConfig({ ...legacy, tenantId: "legacy" }).usageAlertPercent).toBe(75);
  });

  let ctx: ReturnType<typeof rig>;
  beforeEach(() => { ctx = rig(); });

  it("texts the owner once at 75% and once at 100%, never twice, as calls finalize", async () => {
    const { finish, usageAlerts } = ctx;
    // 149 billed minutes: no alert yet.
    for (let index = 0; index < 149; index += 1) await finish(`c${index}`, 60);
    expect(await usageAlerts()).toHaveLength(0);
    await finish("c149", 45); // 150 minutes
    let alerts = await usageAlerts();
    expect(alerts).toHaveLength(1);
    const [periodStart] = currentBillingPeriod(new Date("2026-01-15T08:00:00.000Z"));
    expect(alerts[0]).toMatchObject({
      channel: "sms",
      destinationRef: "owner-primary",
      callId: null,
      idempotencyKey: `usage-alert:demo:${periodStart}:75`,
      body: "Front Office: you've used 75% of your 200 minutes this month (150). Change this alert in Settings.",
    });
    await finish("c150", 60); // 151 minutes, already alerted
    expect(await usageAlerts()).toHaveLength(1);
    for (let index = 151; index < 200; index += 1) await finish(`c${index}`, 60);
    alerts = await usageAlerts();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({ idempotencyKey: `usage-alert:demo:${periodStart}:100` });
    expect(alerts[1]!.body).toBe("Front Office: you've used all 200 of your minutes this month. Extra minutes are $0.20 each until they reset on Feb 1.");
    await finish("c200", 600);
    expect(await usageAlerts()).toHaveLength(2);
  });

  it("does not let spam or short calls push a shop over a threshold", async () => {
    const { store, finish, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedMinutes: 10 });
    await finish("real", 7 * 60); // 7 of 10 minutes
    await finish("spam", 30 * 60, { isSpam: true });
    for (let index = 0; index < 20; index += 1) await finish(`short${index}`, 14);
    expect(await usageAlerts()).toHaveLength(0);
    await finish("real-2", 60); // 8 of 10 = 80%
    expect((await usageAlerts()).map((item) => item.idempotencyKey.split(":").at(-1))).toEqual(["75"]);
  });

  it("sends only the 100% alert when one call jumps past both thresholds", async () => {
    const { store, finish, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedMinutes: 10 });
    await finish("long", 12 * 60);
    const alerts = await usageAlerts();
    expect(alerts.map((item) => item.idempotencyKey.split(":").at(-1))).toEqual(["100"]);
    await finish("after", 60);
    expect(await usageAlerts()).toHaveLength(1);
  });

  it("uses the owner's chosen threshold", async () => {
    const { store, finish, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedMinutes: 10, usageAlertPercent: 90 });
    await finish("a", 8 * 60);
    expect(await usageAlerts()).toHaveLength(0);
    await finish("b", 60);
    const alerts = await usageAlerts();
    expect(alerts.map((item) => item.idempotencyKey.split(":").at(-1))).toEqual(["90"]);
    expect(alerts[0]!.body).toBe("Front Office: you've used 90% of your 10 minutes this month (9). Change this alert in Settings.");
  });

  it("does not double-send when the final webhook is replayed or another replica checks too", async () => {
    const { store, service, finish, usageAlerts, summary } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedMinutes: 20 });
    await finish("over", 16 * 60); // 80%
    await service.finalize(summary("over", 16 * 60));
    // Two replicas finalizing different calls at the same moment (18 of 20 minutes, still under 100%).
    await Promise.all([finish("x", 30), finish("y", 30)]);
    expect((await usageAlerts()).map((item) => item.idempotencyKey.split(":").at(-1))).toEqual(["75"]);
  });

  it("alerts again in the next billing period", async () => {
    const { store, clock, finish, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedMinutes: 10 });
    await finish("jan", 8 * 60);
    clock.set("2026-02-03T08:00:00.000Z");
    await finish("feb", 8 * 60, { startedAt: "2026-02-03T07:50:00.000Z" });
    const keys = (await usageAlerts()).map((item) => item.idempotencyKey);
    expect(keys).toEqual(["usage-alert:demo:2026-01-01T00:00:00.000Z:75", "usage-alert:demo:2026-02-01T00:00:00.000Z:75"]);
  });

  it("follows the Stripe billing cycle when the shop has a subscription", async () => {
    const { store, finish, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedMinutes: 10 });
    await store.saveSubscription({
      tenantId: "demo", providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic", status: "active",
      currentPeriodEnd: "2026-01-20T15:00:00.000Z", providerEventCreatedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await finish("a", 8 * 60);
    expect((await usageAlerts()).map((item) => item.idempotencyKey)).toEqual(["usage-alert:demo:2025-12-20T15:00:00.000Z:75"]);
  });

  it("emails the owner when text alerts are off and email is set up", async () => {
    const { store, clock } = ctx;
    const service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example", { ownerEmailAvailable: true });
    await store.saveConfig({ ...await store.getConfig("demo"), includedMinutes: 10, ownerNotificationRefs: [] });
    await store.createOwnerWorkspace({
      account: { id: randomUUID(), tenantId: "demo", email: "owner@synthetic.example", displayName: "Synthetic Owner", passwordHash: "synthetic", role: "owner", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      config: { ...await store.getConfig("demo") },
      ownerPhone: null,
    });
    await finishWith(service, ctx, "a", 8 * 60);
    const alerts = await ctx.usageAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ channel: "email", destinationRef: "email:owner@synthetic.example" });
    expect(alerts[0]!.body).toContain("Subject: Front Office: you've used 80% of your minutes");
    expect(alerts[0]!.body).toContain("https://front-office.example/app/settings");
  });

  it("queues nothing it cannot deliver", async () => {
    const { store, finish, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedMinutes: 10, ownerNotificationRefs: [] });
    await finish("a", 8 * 60);
    expect(await usageAlerts()).toHaveLength(0);
  });
});

function rig() {
  const store = new InMemoryStore();
  const clock = new MutableClock(new Date("2026-01-15T08:00:00.000Z"));
  const service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example");
  void store.saveConfig({ ...createDemoConfig(), ownerRealtimeSmsEnabled: false });
  const summary = (providerCallId: string, durationSeconds: number, extra: Partial<CallSummaryInput> = {}): CallSummaryInput => ({
    webhookEventId: `end:${providerCallId}`, tenantId: "demo", providerCallId, fromNumber: "+15555550100",
    startedAt: "2026-01-15T07:50:00.000Z", endedAt: clock.now().toISOString(), durationSeconds,
    fields, transcript: "Synthetic transcript", recordingUrl: "https://example.invalid/recording", consentState: "disclosed",
    ...extra,
  });
  // The outbox map keeps insertion order, so this is the order alerts were queued.
  const usageAlerts = async (): Promise<OutboxNotification[]> => [...store.notifications.values()]
    .filter((item) => item.idempotencyKey.startsWith("usage-alert:"));
  const ctx = {
    store, clock, service, summary, usageAlerts,
    finish: (providerCallId: string, durationSeconds: number, extra: Partial<CallSummaryInput> = {}) => service.finalize(summary(providerCallId, durationSeconds, extra)),
  };
  return ctx;
}

async function finishWith(service: CallService, ctx: ReturnType<typeof rig>, providerCallId: string, durationSeconds: number): Promise<CallRecord> {
  return service.finalize(ctx.summary(providerCallId, durationSeconds));
}
