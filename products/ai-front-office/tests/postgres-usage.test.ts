import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { CallRecord, OwnerAccount } from "../src/domain/models.js";
import { CryptoBox } from "../src/security/crypto-box.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL usage summary matches the in-memory store", () => {
  let store: PostgresStore;
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    store = new PostgresStore(databaseUrl, new CryptoBox(Buffer.alloc(32, 5).toString("base64")));
  });
  afterAll(async () => { await store?.close(); });

  it("leaves out spam and calls under 15 seconds exactly as the in-memory store does", async () => {
    const tenantId = `shop_${randomUUID()}`;
    const now = "2026-01-10T12:00:00.000Z";
    const owner: OwnerAccount = { id: randomUUID(), tenantId, email: `owner-${randomUUID()}@synthetic.example`, displayName: "Synthetic Owner", passwordHash: "synthetic-password-hash", role: "owner", status: "active", createdAt: now, updatedAt: now };
    expect(await store.createOwnerWorkspace({ account: owner, config: createDemoConfig(tenantId), ownerPhone: null })).toBe(true);
    const memory = new InMemoryStore();
    await memory.saveConfig(createDemoConfig(tenantId));
    const call = (overrides: Partial<CallRecord>): CallRecord => ({
      id: randomUUID(), tenantId, providerCallId: `v3:${randomUUID()}`, fromNumber: "+15555550100", fromNumberVerified: true,
      startedAt: "2026-01-10T12:00:00.000Z", endedAt: "2026-01-10T12:05:00.000Z", durationSeconds: 300,
      fields: {
        callerName: "Synthetic Caller", companyName: null, callbackNumber: "+15555550100", address: null, serviceCategory: null,
        serviceCategoryConfidence: 0, problemDescription: "", equipmentDetails: null, accessNotes: null, requestedStart: null,
        explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: false, confidence: 0,
      },
      emergency: null, outcome: "pending_confirmation", transcript: null, recordingUrl: null, consentState: "unknown",
      billingDisposition: "billable", qualityFlags: [], createdAt: now, updatedAt: now,
      ...overrides,
    });
    for (const record of [
      call({ durationSeconds: 61 }),
      call({ durationSeconds: 15 }),
      call({ durationSeconds: 14 }),
      call({ durationSeconds: null }),
      call({ billingDisposition: "spam_excluded", outcome: "ignored_spam", durationSeconds: 900 }),
      call({ outcome: "ignored_spam", durationSeconds: 120 }),
      call({ billingDisposition: "not_billable", outcome: "handoff_queued", durationSeconds: 400 }),
      call({ durationSeconds: 600, startedAt: "2026-02-01T00:00:00.000Z" }),
    ]) {
      await store.saveCall(record);
      await memory.saveCall(record);
    }
    const period = ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"] as const;
    const fromPostgres = await store.getUsageSummary(tenantId, ...period);
    expect(fromPostgres).toEqual(await memory.getUsageSummary(tenantId, ...period));
    expect(fromPostgres).toMatchObject({ billableCalls: 2, billedMinutes: 3, excludedSpamCalls: 2, excludedShortCalls: 2 });

    // The usage alert's idempotency key holds across replicas: a second insert is refused.
    const alert = {
      id: randomUUID(), tenantId, callId: null, channel: "sms" as const, destinationRef: "owner-primary", body: "Synthetic alert",
      priority: "normal" as const, state: "pending" as const, attempts: 0, nextAttemptAt: now,
      idempotencyKey: `usage-alert:${tenantId}:${period[0]}:75`, providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
    };
    expect(await store.enqueueNotification(alert)).toBe(true);
    expect(await store.enqueueNotification({ ...alert, id: randomUUID() })).toBe(false);
    await store.deleteWorkspace(tenantId);
  });
});
