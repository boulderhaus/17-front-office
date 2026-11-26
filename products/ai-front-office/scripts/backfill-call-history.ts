import { pathToFileURL } from "node:url";
import { TelnyxProviderCallHistory, TelnyxRecordingClient } from "../src/adapters/telnyx.js";
import { backfillBlindClosures } from "../src/application/call-recovery.js";
import { CallService } from "../src/application/call-service.js";
import { loadEnvironment } from "../src/config/environment.js";
import { systemClock } from "../src/ports.js";

/**
 * Repairs calls that were closed blind (quality flag call_ended_without_final_provider_payload: no transcript,
 * not counted) from Telnyx's own conversation history, for every shop.
 *
 *   node --import tsx scripts/backfill-call-history.ts --dry-run          # what would change, nothing written
 *   node --import tsx scripts/backfill-call-history.ts                    # repair the last 3 days
 *   node --import tsx scripts/backfill-call-history.ts --days 7
 *   (in the production image: node dist/scripts/backfill-call-history.js ...)
 *
 * It only repairs the stored record (transcript, fields, outcome, billing disposition, usage, callback task).
 * It never texts a caller, never alerts an owner and never writes to a calendar. Safe to run twice: a repaired
 * call no longer carries the flag. Output is id and shop suffixes, booleans and statuses only: never a name,
 * number, address or anything a caller said.
 */
export function parseBackfillArgs(argv: string[]): { days: number; dryRun: boolean } {
  let days = 3;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--days" || arg.startsWith("--days=")) {
      const value = arg === "--days" ? argv[index += 1] : arg.slice("--days=".length);
      days = Number(value);
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("--days takes a whole number from 1 to 30");
    } else throw new Error(`Unknown argument ${arg}. Use --dry-run and --days N.`);
  }
  return { days, dryRun };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { days, dryRun } = parseBackfillArgs(process.argv.slice(2));
  const env = loadEnvironment(process.env);
  if (!env.TELNYX_API_KEY) throw new Error("TELNYX_API_KEY is required");
  const { createRuntime } = await import("../src/runtime.js");
  const runtime = await createRuntime(env);
  try {
    const report = await backfillBlindClosures({
      store: runtime.store,
      service: new CallService(runtime.store, runtime.calendar, systemClock, env.PUBLIC_BASE_URL, { callbackLinkKey: env.SESSION_SIGNING_KEY ?? null }),
      history: new TelnyxProviderCallHistory(env.TELNYX_API_KEY),
      clock: systemClock,
      publicBaseUrl: env.PUBLIC_BASE_URL,
      recordings: new TelnyxRecordingClient(env.TELNYX_API_KEY),
      days,
      dryRun,
    });
    for (const row of report) console.log(JSON.stringify(row));
    const count = (status: string) => report.filter((row) => row.status === status).length;
    console.log(JSON.stringify({ mode: dryRun ? "dry_run" : "applied", days, calls: report.length, repaired: count("repaired"), would_repair: count("would_repair"), no_history: count("no_history"), skipped: count("skipped"), failed: count("failed") }));
    if (count("failed") > 0 || report.some((row) => row.error)) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}
