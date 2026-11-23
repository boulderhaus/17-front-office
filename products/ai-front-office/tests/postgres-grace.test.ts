import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { createDemoConfig } from "../src/domain/config.js";
import { CryptoBox } from "../src/security/crypto-box.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL grace-line lookups", () => {
  let store: PostgresStore;
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    store = new PostgresStore(databaseUrl, new CryptoBox(Buffer.alloc(32, 7).toString("base64")));
  });
  afterAll(async () => { await store?.close(); });

  it("finds a shop by the Front Office number callers dial, and only while it owns it", async () => {
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

  it("cancels a queued notification only before it is claimed", async () => {
    const tenantId = `shop_${randomUUID()}`;
    await store.saveConfig(createDemoConfig(tenantId));
    const key = `voicemail-fallback:${tenantId}:call_1:owner-primary`;
    const now = new Date().toISOString();
    await store.enqueueNotification({
      id: randomUUID(), tenantId, callId: null, channel: "sms", destinationRef: "owner-primary", body: "Synthetic", priority: "high",
      state: "pending", attempts: 0, nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString(), idempotencyKey: key,
      providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
    });
    expect(await store.cancelPendingNotification(key)).toBe(true);
    expect(await store.cancelPendingNotification(key)).toBe(false);
  });
});
