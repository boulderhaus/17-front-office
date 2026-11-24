import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { createDemoConfig } from "../src/domain/config.js";
import { CryptoBox } from "../src/security/crypto-box.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL grace-line lookups", () => {
  let store: PostgresStore;
  let pool: pg.Pool;
  const box = new CryptoBox(Buffer.alloc(32, 7).toString("base64"));
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    store = new PostgresStore(databaseUrl, box);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  });
  afterAll(async () => { await Promise.all([store?.close(), pool?.end()]); });

  it("finds a shop by the Call Otto number callers dial, and only while it owns it", async () => {
    const tenantId = `shop_${randomUUID()}`;
    const number = `+1555555${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
    await store.saveConfig(createDemoConfig(tenantId));
    await store.saveIntegrationSecret(tenantId, "telnyx", "inbound_number", number);
    expect(await store.getTenantIdByInboundNumber(number)).toBe(tenantId);
    await store.saveIntegrationSecret(tenantId, "telnyx", "pending_number", "+15555550111");
    expect(await store.getTenantIdByInboundNumber("+15555550111")).toBeNull();
    await store.deleteIntegrationSecret(tenantId, "telnyx", "inbound_number");
    expect(await store.getTenantIdByInboundNumber(number)).toBeNull();
  });

  it("cancels a queued or retrying notification only before it is claimed", async () => {
    const tenantId = `shop_${randomUUID()}`;
    await store.saveConfig(createDemoConfig(tenantId));
    const now = new Date().toISOString();
    const queue = async (key: string, state: "pending" | "retry" | "sent") => {
      const id = randomUUID();
      await store.enqueueNotification({
        id, tenantId, callId: null, channel: "sms", destinationRef: "owner-primary", body: "Synthetic", priority: "high",
        state: "pending", attempts: 0, nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString(), idempotencyKey: key,
        providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
      });
      if (state !== "pending") await pool.query("UPDATE notification_outbox SET state=$2 WHERE id=$1", [id, state]);
    };
    await queue(`voicemail-fallback:${tenantId}:call_1:owner-primary`, "pending");
    await queue(`voicemail-fallback:${tenantId}:call_2:owner-primary`, "retry");
    await queue(`voicemail-fallback:${tenantId}:call_3:owner-primary`, "sent");
    expect(await store.cancelPendingNotification(`voicemail-fallback:${tenantId}:call_1:owner-primary`)).toBe(true);
    expect(await store.cancelPendingNotification(`voicemail-fallback:${tenantId}:call_1:owner-primary`)).toBe(false);
    expect(await store.cancelPendingNotification(`voicemail-fallback:${tenantId}:call_2:owner-primary`)).toBe(true);
    expect(await store.cancelPendingNotification(`voicemail-fallback:${tenantId}:call_3:owner-primary`)).toBe(false);
  });

  it("backfills lookups for numbers saved before migration 012, once, and fails closed on a duplicate number", async () => {
    const first = `shop_${randomUUID()}`;
    const second = `shop_${randomUUID()}`;
    const number = `+1555555${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
    await store.saveConfig(createDemoConfig(first));
    await store.saveConfig(createDemoConfig(second));
    await store.saveIntegrationSecret(first, "telnyx", "inbound_number", number);
    await pool.query("UPDATE integration_secrets SET lookup_hash=NULL WHERE tenant_id=$1", [first]); // a pre-012 row
    expect(await store.getTenantIdByInboundNumber(number)).toBeNull();
    expect((await store.backfillInboundNumberLookups()).updated).toBeGreaterThanOrEqual(1);
    expect(await store.getTenantIdByInboundNumber(number)).toBe(first);
    expect((await store.backfillInboundNumberLookups()).updated).toBe(0);

    // One number can belong to one shop: a second live save is refused...
    await expect(store.saveIntegrationSecret(second, "telnyx", "inbound_number", number)).rejects.toThrow();
    // ...and a legacy duplicate row is left unindexed (unreachable) instead of hijacking the first shop's calls.
    await pool.query(
      "INSERT INTO integration_secrets(tenant_id,provider,secret_key,value_ciphertext,lookup_hash,updated_at) VALUES($1,'telnyx','inbound_number',$2,NULL,now())",
      [second, box.encrypt(number)],
    );
    expect((await store.backfillInboundNumberLookups()).conflicts).toBeGreaterThanOrEqual(1);
    expect(await store.getTenantIdByInboundNumber(number)).toBe(first);
  });
});
