import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { CallLengthGuard, type AssistantMessenger } from "../src/application/call-length.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { CallRecord, OwnerAccount } from "../src/domain/models.js";
import { CryptoBox } from "../src/security/crypto-box.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL call-length guard", () => {
  let first: PostgresStore;
  let second: PostgresStore;
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    const box = new CryptoBox(Buffer.alloc(32, 5).toString("base64"));
    first = new PostgresStore(databaseUrl, box);
    second = new PostgresStore(databaseUrl, box);
  });
  afterAll(async () => { await first?.close(); await second?.close(); });

  it("lists live calls across shops and nudges each once across replicas", async () => {
    // A start time no other test uses, so the cross-shop query only sees this test's calls in the window.
    const base = Date.parse("2997-01-01T00:00:00.000Z") + Math.floor(Math.random() * 1e9) * 1000;
    const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
    const tenants = [`shop_${randomUUID()}`, `shop_${randomUUID()}`];
    for (const tenantId of tenants) {
      const owner: OwnerAccount = { id: randomUUID(), tenantId, email: `owner-${randomUUID()}@synthetic.example`, displayName: "Synthetic Owner", passwordHash: "synthetic-password-hash", role: "owner", status: "active", createdAt: at(0), updatedAt: at(0) };
      expect(await first.createOwnerWorkspace({ account: owner, config: createDemoConfig(tenantId), ownerPhone: null })).toBe(true);
    }
    const call = (tenantId: string, startedAtSeconds: number, outcome: CallRecord["outcome"] = "in_progress"): CallRecord => ({
      id: randomUUID(), tenantId, providerCallId: `v3:${randomUUID()}`, fromNumber: "+15555550100", fromNumberVerified: true,
      startedAt: at(startedAtSeconds), endedAt: null, durationSeconds: null,
      fields: {
        callerName: null, companyName: null, callbackNumber: null, address: null, serviceCategory: null,
        serviceCategoryConfidence: 0, problemDescription: "", equipmentDetails: null, accessNotes: null, requestedStart: null,
        explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: false, confidence: 0,
      },
      emergency: null, outcome, transcript: null, recordingUrl: null, consentState: "unknown",
      billingDisposition: "not_billable", qualityFlags: [], createdAt: at(startedAtSeconds), updatedAt: at(startedAtSeconds),
    });
    const live = [call(tenants[0]!, 0), call(tenants[1]!, 10)];
    const ended = call(tenants[0]!, 5, "handoff_queued");
    const tooOld = call(tenants[1]!, -500);
    for (const record of [...live, ended, tooOld]) await first.saveCall(record);

    const listed = await second.listInProgressCalls(at(-420), 500);
    const ours = new Set([...live, ended, tooOld].map((record) => record.providerCallId));
    expect(listed.filter((record) => ours.has(record.providerCallId)).map((record) => record.providerCallId)).toEqual(live.map((record) => record.providerCallId));

    const sent: string[] = [];
    const messenger: AssistantMessenger = { addSystemMessage: async (callControlId, _content, commandId) => { if (ours.has(callControlId)) sent.push(`${callControlId} ${commandId}`); return "sent"; } };
    const clock = { now: () => new Date(base + 285_000) };
    const guards = [new CallLengthGuard(first, messenger, clock, () => undefined), new CallLengthGuard(second, messenger, clock, () => undefined)];
    await Promise.all([guards[0]!.runOnce(), guards[1]!.runOnce(), guards[0]!.runOnce(), guards[1]!.runOnce()]);
    expect(sent.sort()).toEqual(live.map((record) => `${record.providerCallId} front-office-call-length:finish`).sort());
  });
});
