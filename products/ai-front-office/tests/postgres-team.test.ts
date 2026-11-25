import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { TeamService } from "../src/application/team-service.js";
import { createDemoConfig } from "../src/domain/config.js";
import { CryptoBox } from "../src/security/crypto-box.js";
import type { OwnerAccount } from "../src/domain/models.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL team migration integration", () => {
  let store: PostgresStore;
  let pool: pg.Pool;
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    store = new PostgresStore(databaseUrl, new CryptoBox(Buffer.alloc(32, 7).toString("base64")));
    pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 3000 });
  });
  afterAll(async () => { await Promise.all([store?.close(), pool?.end()]); });

  it("keeps exactly one owner, admits isolated members, and encrypts their identity", async () => {
    const tenantId = `shop_${randomUUID()}`;
    const now = "2026-01-15T08:00:00.000Z";
    const owner: OwnerAccount = { id: randomUUID(), tenantId, email: `owner-${randomUUID()}@synthetic.example`, displayName: "Synthetic Owner", passwordHash: "synthetic-password-hash", role: "owner", status: "active", emailVerifiedAt: now, createdAt: now, updatedAt: now };
    expect(await store.createOwnerWorkspace({ account: owner, config: createDemoConfig(tenantId), ownerPhone: null })).toBe(true);
    const teams = new TeamService(store, { now: () => new Date(now) });
    const email = `member-${randomUUID()}@synthetic.example`;
    const token = await teams.invite(owner, email);
    const member = await teams.accept(tenantId, token, "Synthetic Teammate", "long-test-password-123");
    expect(await store.getOwnerAccountByEmail(email)).toMatchObject({ id: member.id, role: "member", tenantId });
    expect((await store.getOwnerAccountByTenant(tenantId))?.id).toBe(owner.id);
    expect(await store.listTeamAccounts(tenantId)).toHaveLength(2);
    expect(await store.listTeamAccounts(`shop_${randomUUID()}`)).toEqual([]);
    const raw = (await pool.query("SELECT email_ciphertext,display_name_ciphertext FROM owner_accounts WHERE id=$1", [member.id])).rows[0];
    expect(JSON.stringify(raw)).not.toContain(email);
    expect(JSON.stringify(raw)).not.toContain("Synthetic Teammate");
    const secondOwner = { ...owner, id: randomUUID(), email: `second-${randomUUID()}@synthetic.example` };
    expect(await store.createOwnerWorkspace({ account: secondOwner, config: createDemoConfig(tenantId), ownerPhone: null })).toBe(false);
    expect((await store.getOwnerAccountByTenant(tenantId))?.id).toBe(owner.id);
    await expect(teams.accept(tenantId, token, "Replay", "long-test-password-123")).rejects.toThrow();
  });
});
