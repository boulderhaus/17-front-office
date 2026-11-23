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

describe("what counts against the owner's calls", () => {
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

  it("keeps a short call's record but never counts it", async () => {
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
    expect(dueUsageAlerts(44, 60, 75)).toEqual([]);
    expect(dueUsageAlerts(45, 60, 75)).toEqual([75]);
    expect(dueUsageAlerts(59, 60, 75)).toEqual([75]);
    expect(dueUsageAlerts(60, 60, 75)).toEqual([100]);
    expect(dueUsageAlerts(80, 60, 90)).toEqual([100]);
    expect(dueUsageAlerts(53, 60, 90)).toEqual([]);
    expect(dueUsageAlerts(54, 60, 90)).toEqual([90]);
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
  const calls = async (prefix: string, count: number, seconds = 60) => {
    for (let index = 0; index < count; index += 1) await ctx.finish(`${prefix}${index}`, seconds);
  };

  it("texts the owner once at 75% and once at 100% of their answered calls, never twice", async () => {
    const { finish, usageAlerts } = ctx;
    // Solo: 60 answered calls. 44 answered: no alert yet.
    await calls("c", 44);
    expect(await usageAlerts()).toHaveLength(0);
    await finish("c44", 20); // 45 of 60: a 20-second call counts like a long one
    let alerts = await usageAlerts();
    expect(alerts).toHaveLength(1);
    const [periodStart] = currentBillingPeriod(new Date("2026-01-15T08:00:00.000Z"));
    expect(alerts[0]).toMatchObject({
      channel: "sms",
      destinationRef: "owner-primary",
      callId: null,
      idempotencyKey: `usage-alert:demo:${periodStart}:75`,
      body: "Front Office: you've answered 45 of your 60 calls this month. Extra calls are 75¢ each. Change plans in Settings.",
    });
    await finish("c45", 60); // 46, already alerted
    expect(await usageAlerts()).toHaveLength(1);
    await calls("d", 14);
    alerts = await usageAlerts();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({ idempotencyKey: `usage-alert:demo:${periodStart}:100` });
    expect(alerts[1]!.body).toBe("Front Office: you've answered 60 of your 60 calls this month. Extra calls are 75¢ each. Change plans in Settings.");
    await finish("over", 600);
    expect(await usageAlerts()).toHaveLength(2);
  });

  it("does not let spam or short calls push a shop over a threshold", async () => {
    const { store, finish, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedCalls: 10 });
    await calls("real", 7); // 7 of 10
    await finish("spam", 30 * 60, { isSpam: true });
    for (let index = 0; index < 20; index += 1) await finish(`short${index}`, 14);
    expect(await usageAlerts()).toHaveLength(0);
    await finish("real-8", 60); // 8 of 10 = 80%
    expect((await usageAlerts()).map((item) => item.idempotencyKey.split(":").at(-1))).toEqual(["75"]);
  });

  it("sends only the 100% alert when the same call reaches the threshold and the plan's last call", async () => {
    const { store, finish, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedCalls: 4, usageAlertPercent: 90 });
    await calls("a", 3); // 75%, under the 90% alert
    expect(await usageAlerts()).toHaveLength(0);
    await finish("last", 60);
    expect((await usageAlerts()).map((item) => item.idempotencyKey.split(":").at(-1))).toEqual(["100"]);
    await finish("after", 60);
    expect(await usageAlerts()).toHaveLength(1);
  });

  it("uses the owner's chosen threshold", async () => {
    const { store, finish, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedCalls: 10, usageAlertPercent: 90 });
    await calls("a", 8);
    expect(await usageAlerts()).toHaveLength(0);
    await finish("b", 60);
    const alerts = await usageAlerts();
    expect(alerts.map((item) => item.idempotencyKey.split(":").at(-1))).toEqual(["90"]);
    expect(alerts[0]!.body).toBe("Front Office: you've answered 9 of your 10 calls this month. Extra calls are 75¢ each. Change plans in Settings.");
  });

  it("does not double-send when the final webhook is replayed or another replica checks too", async () => {
    const { store, service, finish, usageAlerts, summary } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedCalls: 20 });
    await calls("a", 15);
    await finish("over", 60); // 16 of 20 = 80%
    await service.finalize(summary("over", 60));
    // Two replicas finalizing different calls at the same moment (18 of 20, still under 100%).
    await Promise.all([finish("x", 30), finish("y", 30)]);
    expect((await usageAlerts()).map((item) => item.idempotencyKey.split(":").at(-1))).toEqual(["75"]);
  });

  it("alerts again in the next billing period", async () => {
    const { store, clock, finish, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedCalls: 4 });
    await calls("jan", 3);
    clock.set("2026-02-03T08:00:00.000Z");
    for (let index = 0; index < 3; index += 1) await finish(`feb${index}`, 60, { startedAt: "2026-02-03T07:50:00.000Z" });
    const keys = (await usageAlerts()).map((item) => item.idempotencyKey);
    expect(keys).toEqual(["usage-alert:demo:2026-01-01T00:00:00.000Z:75", "usage-alert:demo:2026-02-01T00:00:00.000Z:75"]);
  });

  it("follows the Stripe billing cycle when the shop has a subscription", async () => {
    const { store, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedCalls: 4 });
    await store.saveSubscription({
      tenantId: "demo", providerCustomerId: "cus_synthetic", providerSubscriptionId: "sub_synthetic", status: "active",
      currentPeriodEnd: "2026-01-20T15:00:00.000Z", providerEventCreatedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await calls("a", 3);
    expect((await usageAlerts()).map((item) => item.idempotencyKey)).toEqual(["usage-alert:demo:2025-12-20T15:00:00.000Z:75"]);
  });

  it("emails the owner when text alerts are off and email is set up", async () => {
    const { store, clock } = ctx;
    const service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example", { ownerEmailAvailable: true });
    await store.saveConfig({ ...await store.getConfig("demo"), includedCalls: 10, ownerNotificationRefs: [] });
    await store.createOwnerWorkspace({
      account: { id: randomUUID(), tenantId: "demo", email: "owner@synthetic.example", displayName: "Synthetic Owner", passwordHash: "synthetic", role: "owner", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      config: { ...await store.getConfig("demo") },
      ownerPhone: null,
    });
    for (let index = 0; index < 8; index += 1) await finishWith(service, ctx, `a${index}`, 60);
    const alerts = await ctx.usageAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ channel: "email", destinationRef: "email:owner@synthetic.example" });
    expect(alerts[0]!.body).toContain("Subject: Front Office: you've answered 8 of your 10 calls");
    expect(alerts[0]!.body).toContain("https://front-office.example/app/settings");
  });

  it("queues nothing it cannot deliver", async () => {
    const { store, usageAlerts } = ctx;
    await store.saveConfig({ ...await store.getConfig("demo"), includedCalls: 10, ownerNotificationRefs: [] });
    await calls("a", 8);
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
