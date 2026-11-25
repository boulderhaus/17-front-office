import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { createDemoConfig } from "../src/domain/config.js";
import { CryptoBox } from "../src/security/crypto-box.js";
import { createSignInLinkToken, PASSWORDLESS_HASH, SIGN_IN_LINK_OUTBOX_TENANT } from "../src/security/owner-auth.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL email sign-in links", () => {
  let store: PostgresStore;
  let pool: pg.Pool;
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    store = new PostgresStore(databaseUrl, new CryptoBox(Buffer.alloc(32, 7).toString("base64")));
    pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 3000 });
  });
  afterAll(async () => { await Promise.all([store?.close(), pool?.end()]); });

  it("stores only a hash and an encrypted email, and each link works once before it expires", async () => {
    const email = `link-${randomUUID()}@synthetic.example`;
    const now = "2026-03-02T15:00:00.000Z";
    const { token, tokenHash } = createSignInLinkToken();
    await store.createSignInLink(tokenHash, email, "2026-03-02T15:15:00.000Z", now);
    const raw = (await pool.query("SELECT * FROM owner_sign_in_tokens WHERE token_hash=$1", [tokenHash])).rows[0];
    expect(JSON.stringify(raw)).not.toContain(email);
    expect(JSON.stringify(raw)).not.toContain(token);
    const [first, second] = await Promise.all([store.consumeSignInLink(tokenHash, now), store.consumeSignInLink(tokenHash, now)]);
    expect([first, second].filter(Boolean)).toEqual([email]);

    const late = createSignInLinkToken();
    await store.createSignInLink(late.tokenHash, email, "2026-03-02T15:15:00.000Z", now);
    expect(await store.consumeSignInLink(late.tokenHash, "2026-03-02T15:15:00.000Z")).toBeNull();
    expect(await store.consumeSignInLink(createSignInLinkToken().tokenHash, now)).toBeNull();
  });

  it("records the first proof of an email, dropping an unproven password and its sessions in the same write", async () => {
    const tenantId = `shop_${randomUUID()}`;
    const accountId = randomUUID();
    const now = "2026-03-02T15:00:00.000Z";
    const email = `squat-${randomUUID()}@synthetic.example`;
    expect(await store.createOwnerWorkspace({ account: { id: accountId, tenantId, email, displayName: "Synthetic", passwordHash: "scrypt-v1:x:y", status: "pending_activation", emailVerifiedAt: null, createdAt: now, updatedAt: now }, config: createDemoConfig(tenantId), ownerPhone: null })).toBe(true);
    const before = (await store.getOwnerAccountByEmail(email))!;
    expect(before.emailVerifiedAt).toBeNull();
    await store.markOwnerEmailVerified(accountId, "2026-03-02T15:05:00.000Z", PASSWORDLESS_HASH);
    const after = (await store.getOwnerAccountByEmail(email))!;
    expect(after.emailVerifiedAt).toBe("2026-03-02T15:05:00.000Z");
    expect(after.passwordHash).toBe(PASSWORDLESS_HASH);
    expect(after.sessionVersion).toBe((before.sessionVersion ?? 0) + 1);
    await store.markOwnerEmailVerified(accountId, "2026-03-02T16:00:00.000Z", null);
    const again = (await store.getOwnerAccountByEmail(email))!;
    expect(again.sessionVersion).toBe(after.sessionVersion);
    expect(again.passwordHash).toBe(PASSWORDLESS_HASH);
  });

  it("purges sign-in emails to addresses with no shop after a day", async () => {
    const queue = async (tenantId: string, createdAt: string): Promise<string> => {
      const id = randomUUID();
      expect(await store.enqueueNotification({ id, tenantId, callId: null, channel: "email", destinationRef: "email:someone@synthetic.example", body: "link", priority: "high", state: "sent", attempts: 1, nextAttemptAt: createdAt, idempotencyKey: `sign-in-link:${id}`, providerReceipt: null, lastError: null, createdAt, sentAt: createdAt })).toBe(true);
      return id;
    };
    const shop = `shop_${randomUUID()}`;
    const old = await queue(SIGN_IN_LINK_OUTBOX_TENANT, "2026-03-01T10:00:00.000Z");
    const recent = await queue(SIGN_IN_LINK_OUTBOX_TENANT, "2026-03-02T10:00:00.000Z");
    const shops = await queue(shop, "2026-03-01T10:00:00.000Z");
    await store.createSignInLink(createSignInLinkToken().tokenHash, "someone@synthetic.example", "2026-03-02T15:15:00.000Z", "2026-03-02T15:00:00.000Z");
    const ids = (await pool.query("SELECT id FROM notification_outbox WHERE id = ANY($1::uuid[])", [[old, recent, shops]])).rows.map((row) => String(row.id)).sort();
    expect(ids).toEqual([recent, shops].sort());
  });
});
