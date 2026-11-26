import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { createDemoConfig } from "../src/domain/config.js";
import { CryptoBox } from "../src/security/crypto-box.js";

// Explicit opt-in and localhost-only: never run this against a customer database.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("PostgreSQL Say it clips (migration 019)", () => {
  let store: PostgresStore;
  let pool: pg.Pool;
  const box = new CryptoBox(Buffer.alloc(32, 7).toString("base64"));
  beforeAll(() => {
    if (!databaseUrl || !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)) throw new Error("Use a disposable local test database");
    store = new PostgresStore(databaseUrl, box);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  });
  afterAll(async () => { await Promise.all([store?.close(), pool?.end()]); });

  it("keeps one encrypted clip per shop and word, apart from other shops, and deletes them with the shop", async () => {
    const tenantId = `shop_${randomUUID()}`;
    const other = `shop_${randomUUID()}`;
    await store.saveConfig(createDemoConfig(tenantId));
    await store.saveConfig(createDemoConfig(other));
    const audio = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("synthetic-clip-bytes")]);
    await store.saveWordClip({ tenantId, term: "Myakka", mimeType: "audio/webm", audio, heard: null, createdAt: "2026-11-26T15:00:00.000Z" });
    await store.saveWordClip({ tenantId, term: "myakka", mimeType: "audio/mp4", audio, heard: "my AK uh", createdAt: "2026-11-26T15:01:00.000Z" });
    const clip = await store.getWordClip(tenantId, "MYAKKA");
    expect(clip).toMatchObject({ term: "myakka", mimeType: "audio/mp4", heard: "my AK uh", createdAt: "2026-11-26T15:01:00.000Z" });
    expect(clip!.audio.equals(audio)).toBe(true);
    const stored = await pool.query("SELECT audio_ciphertext FROM word_clips WHERE tenant_id=$1", [tenantId]);
    expect(stored.rowCount).toBe(1);
    expect(String(stored.rows[0]?.audio_ciphertext)).not.toContain(audio.toString("base64"));
    expect(await store.getWordClip(other, "Myakka")).toBeNull();
    expect(await store.listWordClips(other)).toEqual([]);
    expect((await store.listWordClips(tenantId)).map((item) => item.term)).toEqual(["myakka"]);
    expect(await store.deleteWordClip(other, "Myakka")).toBe(false);
    await store.saveWordClip({ tenantId, term: "Venice", mimeType: "audio/ogg", audio, heard: null, createdAt: "2026-11-26T15:02:00.000Z" });
    expect(await store.deleteWordClip(tenantId, "venice")).toBe(true);
    await store.deleteWorkspace(tenantId);
    expect((await pool.query("SELECT 1 FROM word_clips WHERE tenant_id=$1", [tenantId])).rowCount).toBe(0);
    await store.deleteWorkspace(other);
  });
});
