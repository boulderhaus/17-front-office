import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { CryptoBox } from "../src/security/crypto-box.js";
import { createSignInLinkToken } from "../src/security/owner-auth.js";

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
});
