import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { OutboxWorker } from "../src/application/outbox-worker.js";
import type { Store } from "../src/ports.js";
import { CryptoBox } from "../src/security/crypto-box.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;

function stopNoticeContract(name: string, stores: () => { a: Store; b: Store }) {
  describe(name, () => {
    it("gives a number's STOP notice to exactly one notification, keeps it for that notification's retries, and frees it on reset", async () => {
      const { a, b } = stores();
      const phone = `+1941555${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
      await a.resetSmsStopNotice(phone);
      const ids = Array.from({ length: 10 }, () => randomUUID());
      const now = "2026-11-23T12:00:00.000Z";
      const claims = await Promise.all(ids.map((id, index) => (index % 2 ? a : b).claimSmsStopNotice(phone, id, now)));
      expect(claims.filter(Boolean)).toHaveLength(1);
      const winner = ids[claims.indexOf(true)]!;
      expect(await b.claimSmsStopNotice(phone, winner, now)).toBe(true);
      expect(await a.claimSmsStopNotice(phone, randomUUID(), now)).toBe(false);
      await b.resetSmsStopNotice(phone);
      const next = randomUUID();
      expect(await a.claimSmsStopNotice(phone, next, now)).toBe(true);
      expect(await b.claimSmsStopNotice(phone, winner, now)).toBe(false);
      // The holder went dead: the notice goes back, only that holder's.
      await b.releaseSmsStopNotice(winner);
      expect(await a.claimSmsStopNotice(phone, randomUUID(), now)).toBe(false);
      await b.releaseSmsStopNotice(next);
      const after = randomUUID();
      expect(await a.claimSmsStopNotice(phone, after, now)).toBe(true);
      await a.resetSmsStopNotice(phone);
    });
  });
}

describe("outbox dead letters", () => {
  it("gives back the STOP notice of an owner text that will never be sent", async () => {
    const store = new InMemoryStore();
    const clock = { now: () => new Date("2026-11-23T12:00:00.000Z") };
    const id = randomUUID();
    await store.enqueueNotification({
      id, tenantId: "demo", callId: null, channel: "sms", destinationRef: "owner-primary", body: "New call: Maria",
      priority: "normal", state: "pending", attempts: 5, nextAttemptAt: "2026-11-23T11:00:00.000Z",
      idempotencyKey: `dead:${id}`, providerReceipt: null, lastError: null, createdAt: "2026-11-23T11:00:00.000Z", sentAt: null,
    });
    await store.claimSmsStopNotice("+19415550142", id, clock.now().toISOString());
    const worker = new OutboxWorker(store, { send: async () => { throw new Error("carrier rejected"); } }, clock);
    expect((await worker.runOnce()).dead).toBe(1);
    expect(store.smsStopNotices.has("+19415550142")).toBe(false);
  });
});

const memory = new InMemoryStore();
stopNoticeContract("in-memory STOP notices", () => ({ a: memory, b: memory }));

describe.skipIf(!databaseUrl)("PostgreSQL STOP notices", () => {
  let first: PostgresStore;
  let second: PostgresStore;
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    const box = new CryptoBox(Buffer.alloc(32, 5).toString("base64"));
    first = new PostgresStore(databaseUrl, box);
    second = new PostgresStore(databaseUrl, box);
  });
  afterAll(async () => { await Promise.all([first?.close(), second?.close()]); });
  stopNoticeContract("shared by two store instances", () => ({ a: first, b: second }));
});
