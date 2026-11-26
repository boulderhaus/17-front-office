import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryCalendar } from "../src/adapters/in-memory.js";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { CallRecovery, type ProviderCallHistory } from "../src/application/call-recovery.js";
import { CallService, PROVIDER_HISTORY_FLAG } from "../src/application/call-service.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { CallRecord, CallSummaryInput, OwnerAccount } from "../src/domain/models.js";
import { CryptoBox } from "../src/security/crypto-box.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL call recovery", () => {
  let first: PostgresStore;
  let second: PostgresStore;
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    const box = new CryptoBox(Buffer.alloc(32, 5).toString("base64"));
    first = new PostgresStore(databaseUrl, box);
    second = new PostgresStore(databaseUrl, box);
  });
  afterAll(async () => { await first?.close(); await second?.close(); });

  it("lists calls without an end whatever their outcome, and two replicas finish one from history exactly once", async () => {
    // A start time no other test uses, so the cross-shop query only sees this test's calls in the window.
    const base = Date.parse("2996-01-01T00:00:00.000Z") + Math.floor(Math.random() * 1e9) * 1000;
    const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
    const tenantId = `shop_${randomUUID()}`;
    const owner: OwnerAccount = { id: randomUUID(), tenantId, email: `owner-${randomUUID()}@synthetic.example`, displayName: "Synthetic Owner", passwordHash: "synthetic-password-hash", role: "owner", status: "active", createdAt: at(0), updatedAt: at(0) };
    expect(await first.createOwnerWorkspace({ account: owner, config: { ...createDemoConfig(tenantId), ownerNotificationRefs: ["owner-primary"] }, ownerPhone: null })).toBe(true);
    const call = (startedAtSeconds: number, outcome: CallRecord["outcome"], endedAt: string | null): CallRecord => ({
      id: randomUUID(), tenantId, providerCallId: `v3:${randomUUID()}`, fromNumber: "+15555550110", fromNumberVerified: true,
      startedAt: at(startedAtSeconds), endedAt, durationSeconds: null,
      fields: {
        callerName: null, companyName: null, callbackNumber: null, address: null, serviceCategory: null,
        serviceCategoryConfidence: 0, problemDescription: "", equipmentDetails: null, accessNotes: null, requestedStart: null,
        explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: false, confidence: 0,
      },
      emergency: null, outcome, transcript: null, recordingUrl: null, consentState: "unknown",
      billingDisposition: "not_billable", qualityFlags: [], createdAt: at(startedAtSeconds), updatedAt: at(startedAtSeconds),
    });
    const unanswered = call(0, "in_progress", null);
    const askedForOwner = call(10, "handoff_queued", null);
    const finished = call(20, "pending_confirmation", at(60));
    const tooOld = call(-90_000, "in_progress", null);
    for (const record of [unanswered, askedForOwner, finished, tooOld]) await first.saveCall(record);

    const ours = new Set([unanswered, askedForOwner, finished, tooOld].map((record) => record.providerCallId));
    const listed = (await second.listUnfinishedCalls(at(-86_400), 500)).filter((record) => ours.has(record.providerCallId));
    expect(listed.map((record) => record.providerCallId)).toEqual([unanswered.providerCallId, askedForOwner.providerCallId]);

    const clock = { now: () => new Date(base + 200_000) };
    const lookups: string[] = [];
    const history: ProviderCallHistory = {
      callState: async () => ({ status: "ended", durationSeconds: 40, endedAt: at(40) }),
      summary: async (record) => {
        if (!ours.has(record.providerCallId)) return null;
        lookups.push(record.providerCallId);
        const summary: CallSummaryInput = {
          webhookEventId: `provider-history:${record.providerCallId}`, tenantId: record.tenantId, providerCallId: record.providerCallId, fromNumber: "unknown",
          startedAt: record.startedAt, endedAt: at(40), durationSeconds: 40,
          fields: { ...record.fields, callerName: "Dana Miller", problemDescription: "AC stopped cooling" },
          transcript: "Otto: How can I help?\nCaller: My AC stopped cooling.", recordingUrl: null, consentState: "unknown",
        };
        return { summary, lastMessageAt: at(38), messages: 2 };
      },
    };
    const recoveries = [first, second].map((store) => new CallRecovery(store, new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example"), history, clock, { publicBaseUrl: "https://front-office.example", recordings: null, log: () => undefined }));
    const results = await Promise.all([recoveries[0]!.runOnce(), recoveries[1]!.runOnce(), recoveries[0]!.runOnce()]);
    // Other tests' leftovers may sit in the window; ours are finished exactly once between the replicas.
    expect(lookups.sort()).toEqual([unanswered.providerCallId, askedForOwner.providerCallId].sort());
    expect(results.reduce((total, result) => total + result.recovered, 0)).toBeGreaterThanOrEqual(2);
    for (const record of [unanswered, askedForOwner]) {
      const stored = (await first.getCallByProviderId(record.providerCallId))!;
      expect(stored).toMatchObject({ endedAt: at(40), durationSeconds: 40, billingDisposition: "billable", fields: { callerName: "Dana Miller" } });
      expect(stored.qualityFlags).toContain(PROVIDER_HISTORY_FLAG);
      expect(stored.transcript).toContain("Caller: My AC stopped cooling.");
      expect((await first.listNotifications(stored.id)).filter((item) => item.idempotencyKey.startsWith("call-summary:"))).toHaveLength(1);
    }
    expect((await second.listUnfinishedCalls(at(-86_400), 500)).filter((record) => ours.has(record.providerCallId))).toEqual([]);
    const usage = await first.getUsageSummary(tenantId, at(-1), at(100));
    expect(usage.billableCalls).toBe(2);
  });
});
