import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { CryptoBox } from "../src/security/crypto-box.js";

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
});
