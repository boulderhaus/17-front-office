import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query("SELECT pg_advisory_lock(hashtextextended('ai-front-office:migrations', 0))");
  try {
    const directory = resolve(process.cwd(), "migrations");
    const filenames = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    for (const filename of filenames) {
      const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE filename=$1", [filename]);
      if (applied.rowCount === 1) continue;
      const sql = await readFile(resolve(directory, filename), "utf8");
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations(filename) VALUES($1) ON CONFLICT DO NOTHING", [filename]);
      console.log(`Applied migrations/${filename}`);
    }
  } finally {
    await pool.query("SELECT pg_advisory_unlock(hashtextextended('ai-front-office:migrations', 0))");
  }
} finally {
  await pool.end();
}
