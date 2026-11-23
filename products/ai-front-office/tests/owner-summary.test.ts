import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { ResendEmailAdapter } from "../src/adapters/resend.js";
import { OwnerSummaryService } from "../src/application/owner-summary-service.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { CallRecord, CallbackTask, OutboxNotification } from "../src/domain/models.js";
import type { Clock } from "../src/ports.js";

class FixedClock implements Clock {
  constructor(private readonly value: Date) {}
  now(): Date { return new Date(this.value); }
}

describe("owner summaries", () => {
  it("queues one idempotent daily SMS and Sunday week-ahead email", async () => {
    const store = new InMemoryStore();
    const now = new Date("2026-11-22T13:05:00.000Z");
    const config = {
      ...createDemoConfig("shop-summary"),
      timezone: "America/New_York",
      ownerDailySmsEnabled: true,
      ownerDailySmsHour: 7,
      ownerWeeklyEmailEnabled: true,
    };
    await store.createOwnerWorkspace({
      config,
      ownerPhone: "+15555550100",
      account: {
        id: "00000000-0000-4000-8000-000000000001", tenantId: config.tenantId,
        email: "owner@synthetic.example", displayName: "Synthetic Owner", passwordHash: "synthetic",
        status: "active", createdAt: now.toISOString(), updatedAt: now.toISOString(),
      },
    });
    const call = syntheticCall(config.tenantId, now);
    await store.saveCall(call);
    await store.saveCallbackTask(syntheticTask(config.tenantId, call.id, now));
    const service = new OwnerSummaryService(store, new FixedClock(now), "https://front-office.example");

    expect(await service.runOnce()).toEqual({ smsQueued: 1, emailQueued: 1 });
    expect(await service.runOnce()).toEqual({ smsQueued: 0, emailQueued: 0 });
    const notifications = [...store.notifications.values()];
    expect(notifications.map((item) => item.channel).sort()).toEqual(["email", "sms"]);
    expect(notifications.find((item) => item.channel === "sms")?.body).toContain("1 follow-up");
    expect(notifications.find((item) => item.channel === "email")?.body).toContain("your week ahead");
  });

  it("sends a plain-text Resend email with provider idempotency", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ id: "email_synthetic" }), { status: 200, headers: { "content-type": "application/json" } }));
    const fetcher = fetchMock as unknown as typeof fetch;
    const sender = new ResendEmailAdapter({ apiKey: "re_synthetic_key", from: "Front Office <updates@example.com>", fetcher });
    const notification: OutboxNotification = {
      id: "00000000-0000-4000-8000-000000000005", tenantId: "shop-summary", callId: null,
      channel: "email", destinationRef: "email:owner@synthetic.example",
      body: "Subject: Week ahead\n\nTwo appointments.", priority: "normal", state: "pending", attempts: 0,
      nextAttemptAt: "2026-11-22T13:05:00.000Z", idempotencyKey: "weekly:synthetic",
      providerReceipt: null, lastError: null, createdAt: "2026-11-22T13:05:00.000Z", sentAt: null,
    };
    await expect(sender.send(notification)).resolves.toEqual({ providerReceipt: "email_synthetic" });
    const [, options] = fetchMock.mock.calls[0]!;
    expect(options?.headers).toMatchObject({ "idempotency-key": "weekly:synthetic" });
    expect(JSON.parse(String(options?.body))).toMatchObject({ to: ["owner@synthetic.example"], subject: "Week ahead", text: "Two appointments." });
  });
});

function syntheticCall(tenantId: string, now: Date): CallRecord {
  return {
    id: "00000000-0000-4000-8000-000000000002", tenantId, providerCallId: "provider-summary",
    fromNumber: "+15555550101", fromNumberVerified: true, startedAt: now.toISOString(), endedAt: now.toISOString(), durationSeconds: 90,
    fields: {
      callerName: "Synthetic Caller", companyName: null, callbackNumber: "+15555550101",
      address: "100 Main St, Springfield, IL 62701", serviceCategory: "HVAC repair", serviceCategoryConfidence: 0.98,
      problemDescription: "No cooling", equipmentDetails: null, accessNotes: null,
      requestedStart: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(), explicitSlotConfirmation: true,
      diagnosticFeeAccepted: true, humanRequested: false, confidence: 0.98,
    },
    emergency: null, outcome: "booked", transcript: "Synthetic", recordingUrl: "https://example.invalid/recording",
    consentState: "disclosed", billingDisposition: "billable", qualityFlags: [], createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}

function syntheticTask(tenantId: string, callId: string, now: Date): CallbackTask {
  return {
    id: "00000000-0000-4000-8000-000000000003", tenantId, callId, ownerRef: "owner-primary",
    reason: "Confirm access details", priority: "normal", status: "open", dueAt: now.toISOString(),
    completedAt: null, completionSource: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}
