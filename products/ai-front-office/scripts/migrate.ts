import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const migrationPath = resolve(process.cwd(), "migrations/001_initial.sql");
const sql = await readFile(migrationPath, "utf8");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
try {
  await pool.query(sql);
  console.log("Applied migrations/001_initial.sql");
} finally {
  await pool.end();
}
