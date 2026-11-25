import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { createDemoConfig } from "../src/domain/config.js";
import { PLATFORM_TENANT_ID } from "../src/ports.js";
import { CryptoBox } from "../src/security/crypto-box.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL platform secrets (migration 017)", () => {
  let store: PostgresStore;
  let pool: pg.Pool;
  const box = new CryptoBox(Buffer.alloc(32, 7).toString("base64"));
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    store = new PostgresStore(databaseUrl, box);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  });
  afterAll(async () => { await Promise.all([store?.close(), pool?.end()]); });

  it("saves, reads, replaces and deletes tenant \"platform\" secrets with no shop row, encrypted, apart from shop secrets", async () => {
    const provider = `google-founder-${randomUUID()}`;
    expect((await pool.query("SELECT 1 FROM business_configs WHERE tenant_id=$1", [PLATFORM_TENANT_ID])).rowCount).toBe(0);
    await store.saveIntegrationSecret(PLATFORM_TENANT_ID, provider, "token:a", "refresh-synthetic-1");
    expect(await store.getIntegrationSecret(PLATFORM_TENANT_ID, provider, "token:a")).toBe("refresh-synthetic-1");
    await store.saveIntegrationSecret(PLATFORM_TENANT_ID, provider, "token:a", "refresh-synthetic-2");
    expect(await store.getIntegrationSecret(PLATFORM_TENANT_ID, provider, "token:a")).toBe("refresh-synthetic-2");
    const stored = await pool.query("SELECT value_ciphertext FROM platform_secrets WHERE provider=$1 AND secret_key=$2", [provider, "token:a"]);
    expect(String(stored.rows[0]?.value_ciphertext)).not.toContain("refresh-synthetic");
    expect((await pool.query("SELECT 1 FROM integration_secrets WHERE provider=$1", [provider])).rowCount).toBe(0);

    // A shop's secret under the same provider and key stays its own.
    const tenantId = `shop_${randomUUID()}`;
    await store.saveConfig(createDemoConfig(tenantId));
    await store.saveIntegrationSecret(tenantId, provider, "token:a", "shop-value");
    expect(await store.getIntegrationSecret(tenantId, provider, "token:a")).toBe("shop-value");
    expect(await store.getIntegrationSecret(PLATFORM_TENANT_ID, provider, "token:a")).toBe("refresh-synthetic-2");

    await store.deleteIntegrationSecret(PLATFORM_TENANT_ID, provider, "token:a");
    expect(await store.getIntegrationSecret(PLATFORM_TENANT_ID, provider, "token:a")).toBeNull();
    expect(await store.getIntegrationSecret(tenantId, provider, "token:a")).toBe("shop-value");
  });
});
