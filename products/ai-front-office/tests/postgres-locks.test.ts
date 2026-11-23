import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { CryptoBox } from "../src/security/crypto-box.js";
import { randomUUID } from "node:crypto";
import { createDemoConfig } from "../src/domain/config.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!databaseUrl)("PostgreSQL advisory locks under overlapping calls", () => {
  let store: PostgresStore;
  let pool: pg.Pool;
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    store = new PostgresStore(databaseUrl, new CryptoBox(Buffer.alloc(32, 9).toString("base64")));
    pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  });
  afterAll(async () => { await Promise.all([store?.close(), pool?.end()]); });

  it("serves six overlapping bookings for six shops on one replica", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      store.withLock(`call:lock-test-${index}`, () => store.withLock(`calendar:lock-shop-${index}`, async () => { await sleep(300); return index; }))));
    expect(results.map((result) => result.status)).toEqual(Array(6).fill("fulfilled"));
  });

  it("bounds the wait for a busy shop calendar instead of hanging", async () => {
    const started = Date.now();
    const results = await Promise.allSettled([0, 1, 2].map((index) =>
      store.withLock(`call:busy-${index}`, () => store.withLock("calendar:busy-shop", () => sleep(1_800)))));
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  it("re-enters a lock already held by the same operation and leaves no locks behind", async () => {
    expect(await store.withLock("config:reentry", () => store.withLock("config:reentry", async () => "ok"))).toBe("ok");
    const held = await pool.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory'");
    expect(held.rows[0].count).toBe(0);
  });

  it("skips a call whose retention deletion failed in the last 24 hours, then retries it", async () => {
    const tenantId = `retention_${randomUUID()}`;
    await store.saveConfig(createDemoConfig(tenantId));
    const id = randomUUID();
    const base = { id, tenantId, providerCallId: `retention-${id}`, fromNumber: "+12175550100", fromNumberVerified: false, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:05:00.000Z", durationSeconds: 300,
      fields: { callerName: null, companyName: null, callbackNumber: null, address: null, serviceCategory: null, serviceCategoryConfidence: 0, problemDescription: "", equipmentDetails: null, accessNotes: null, requestedStart: null, explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: false, confidence: 0 },
      emergency: null, outcome: "pending_confirmation" as const, transcript: null, recordingUrl: null, consentState: "unknown" as const, billingDisposition: "billable" as const, qualityFlags: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:05:00.000Z" };
    await store.saveCall(base);
    expect((await store.listExpiredCalls(tenantId, "2026-02-01T00:00:00Z", 10, "2026-02-01T00:00:00Z")).map((call) => call.id)).toEqual([id]);
    await store.markRetentionFailed(id, "2026-02-01T00:00:00Z");
    expect(await store.listExpiredCalls(tenantId, "2026-02-01T00:00:00Z", 10, "2026-02-01T12:00:00Z")).toEqual([]);
    expect((await store.listExpiredCalls(tenantId, "2026-02-01T00:00:00Z", 10, "2026-02-02T01:00:00Z")).map((call) => call.id)).toEqual([id]);
  });

  it("deletes a whole workspace and keeps tombstones so late webhooks cannot recreate calls", async () => {
    const tenantId = `workspace_${randomUUID()}`;
    await store.saveConfig(createDemoConfig(tenantId));
    await store.saveIntegrationSecret(tenantId, "notifications", "owner-primary", "+12175550199");
    const id = randomUUID();
    await store.saveCall({ id, tenantId, providerCallId: `ws-${id}`, fromNumber: "+12175550100", fromNumberVerified: false, startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, durationSeconds: null,
      fields: { callerName: null, companyName: null, callbackNumber: null, address: null, serviceCategory: null, serviceCategoryConfidence: 0, problemDescription: "", equipmentDetails: null, accessNotes: null, requestedStart: null, explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: false, confidence: 0 },
      emergency: null, outcome: "in_progress", transcript: null, recordingUrl: null, consentState: "unknown", billingDisposition: "billable", qualityFlags: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    await store.deleteWorkspace(tenantId);
    expect(await store.getCall(id)).toBeNull();
    expect(await store.getIntegrationSecret(tenantId, "notifications", "owner-primary")).toBeNull();
    await expect(store.getConfig(tenantId)).rejects.toThrow();
    expect(await store.isProviderCallDeleted(`ws-${id}`)).toBe(true);
  });
});

