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

    it("lets exactly one worker claim a write, binds the key to its call, and returns the stored result", async () => {
      const { a, b } = stores();
      const callId = `v3:${randomUUID()}`;
      const key = `book_slot:${randomUUID()}`;
      const t0 = "2026-01-15T08:00:00.000Z";
      const stale = "2026-01-15T07:59:30.000Z";
      expect(await b.getToolResult(callId, key)).toBeNull();
      const claims = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? a : b).claimToolResult(callId, key, t0, stale)));
      expect(claims.filter((claim) => claim.status === "claimed")).toHaveLength(1);
      expect(claims.filter((claim) => claim.status === "pending")).toHaveLength(9);
      expect(await a.getToolResult(callId, key)).toEqual({ status: "pending" });
      // The same key on another call is a different write.
      expect(await a.claimToolResult(`v3:${randomUUID()}`, key, t0, stale)).toEqual({ status: "claimed" });

      const result = { status: "confirmed", message: "Booked", nested: { count: 2, flags: ["a", "b"] } };
      await a.completeToolResult(callId, key, result, t0);
      await b.completeToolResult(callId, key, { status: "pending" }, t0);
      expect(await b.getToolResult(callId, key)).toEqual({ status: "done", result });
      expect(await b.claimToolResult(callId, key, t0, stale)).toEqual({ status: "done", result });
      // Releasing a finished write does nothing.
      await a.releaseToolResult(callId, key);
      expect(await a.getToolResult(callId, key)).toEqual({ status: "done", result });
    });

    it("stores any JSON value the same way, including a plain string", async () => {
      const { a, b } = stores();
      const callId = `v3:${randomUUID()}`;
      expect((await a.claimToolResult(callId, "plain", "2026-01-15T08:00:00.000Z", "2026-01-15T07:59:30.000Z")).status).toBe("claimed");
      await a.completeToolResult(callId, "plain", "just text", "2026-01-15T08:00:00.000Z");
      expect(await b.getToolResult(callId, "plain")).toEqual({ status: "done", result: "just text" });
    });

    it("frees a released claim and lets a stale one be taken over", async () => {
      const { a, b } = stores();
      const callId = `v3:${randomUUID()}`;
      expect((await a.claimToolResult(callId, "released", "2026-01-15T08:00:00.000Z", "2026-01-15T07:59:30.000Z")).status).toBe("claimed");
      await a.releaseToolResult(callId, "released");
      expect(await b.getToolResult(callId, "released")).toBeNull();
      expect((await b.claimToolResult(callId, "released", "2026-01-15T08:00:01.000Z", "2026-01-15T07:59:31.000Z")).status).toBe("claimed");

      expect((await a.claimToolResult(callId, "crashed", "2026-01-15T08:00:00.000Z", "2026-01-15T07:59:30.000Z")).status).toBe("claimed");
      expect((await b.claimToolResult(callId, "crashed", "2026-01-15T08:00:05.000Z", "2026-01-15T07:59:35.000Z")).status).toBe("pending");
      expect((await b.claimToolResult(callId, "crashed", "2026-01-15T08:00:31.000Z", "2026-01-15T08:00:01.000Z")).status).toBe("claimed");
    });

    it("purges budgets and results older than the cutoff", async () => {
      const { a } = stores();
      const oldCall = `v3:${randomUUID()}`;
      const freshCall = `v3:${randomUUID()}`;
      await a.incrementToolCallCount(oldCall, "check_availability", "2000-01-01T00:00:00.000Z");
      await a.claimToolResult(oldCall, "save_intake", "2000-01-01T00:00:00.000Z", "1999-12-31T23:59:30.000Z");
      await a.completeToolResult(oldCall, "save_intake", {}, "2000-01-01T00:00:00.000Z");
      await a.incrementToolCallCount(freshCall, "check_availability", "2999-01-01T00:00:00.000Z");
      expect(await a.purgeToolLedger("2001-01-01T00:00:00.000Z")).toBeGreaterThanOrEqual(2);
      expect(await a.getToolResult(oldCall, "save_intake")).toBeNull();
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
