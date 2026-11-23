import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import type { Store } from "../src/ports.js";
import { CryptoBox } from "../src/security/crypto-box.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;

function ledgerContract(name: string, stores: () => { a: Store; b: Store }) {
  describe(name, () => {
    it("counts every call atomically across replicas", async () => {
      const { a, b } = stores();
      const callId = `v3:${randomUUID()}`;
      const now = "2026-01-15T08:00:00.000Z";
      const counts = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? a : b).incrementToolCallCount(callId, "check_availability", now)));
      expect([...counts].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      // Another tool on the same call, and the same tool on another call, start fresh.
      expect(await a.incrementToolCallCount(callId, "book_slot", now)).toBe(1);
      expect(await b.incrementToolCallCount(`v3:${randomUUID()}`, "check_availability", now)).toBe(1);
    });

    it("keeps the first result for an idempotency key", async () => {
      const { a, b } = stores();
      const key = `book_slot:${randomUUID()}`;
      expect(await b.getToolResult(key)).toBeNull();
      await a.saveToolResult(key, "v3:call", JSON.stringify({ status: "confirmed" }), "2026-01-15T08:00:00.000Z");
      await b.saveToolResult(key, "v3:call", JSON.stringify({ status: "pending" }), "2026-01-15T08:00:01.000Z");
      expect(JSON.parse((await b.getToolResult(key))!)).toEqual({ status: "confirmed" });
    });

    it("purges budgets and results older than the cutoff", async () => {
      const { a } = stores();
      const oldCall = `v3:${randomUUID()}`;
      const freshCall = `v3:${randomUUID()}`;
      await a.incrementToolCallCount(oldCall, "check_availability", "2000-01-01T00:00:00.000Z");
      await a.saveToolResult(`save_intake:${oldCall}`, oldCall, "{}", "2000-01-01T00:00:00.000Z");
      await a.incrementToolCallCount(freshCall, "check_availability", "2999-01-01T00:00:00.000Z");
      expect(await a.purgeToolLedger("2001-01-01T00:00:00.000Z")).toBeGreaterThanOrEqual(2);
      expect(await a.getToolResult(`save_intake:${oldCall}`)).toBeNull();
      expect(await a.incrementToolCallCount(oldCall, "check_availability", "2999-01-01T00:00:00.000Z")).toBe(1);
      expect(await a.incrementToolCallCount(freshCall, "check_availability", "2999-01-01T00:00:00.000Z")).toBe(2);
    });
  });
}

const memory = new InMemoryStore();
ledgerContract("in-memory tool ledger", () => ({ a: memory, b: memory }));

describe.skipIf(!databaseUrl)("PostgreSQL tool ledger", () => {
  let first: PostgresStore;
  let second: PostgresStore;
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    const box = new CryptoBox(Buffer.alloc(32, 5).toString("base64"));
    first = new PostgresStore(databaseUrl, box);
    second = new PostgresStore(databaseUrl, box);
  });
  afterAll(async () => { await Promise.all([first?.close(), second?.close()]); });
  ledgerContract("shared by two store instances", () => ({ a: first, b: second }));
});
