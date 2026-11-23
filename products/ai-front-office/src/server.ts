import { createServer } from "node:http";
import { resolve } from "node:path";
import { OutboxWorker } from "./application/outbox-worker.js";
import { CallService } from "./application/call-service.js";
import { DataDeletionService } from "./application/data-deletion.js";
import { GraceLineService } from "./application/grace-line.js";
import { OwnerSummaryService } from "./application/owner-summary-service.js";
import { TelnyxRecordingClient } from "./adapters/telnyx.js";
import { loadEnvironment } from "./config/environment.js";
import { createRequestHandler } from "./http/app.js";
import { createTelemetry } from "./adapters/posthog.js";
import { systemClock } from "./ports.js";
import { createRuntime } from "./runtime.js";

const env = loadEnvironment(process.env);
const runtime = await createRuntime(env);
const logger = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
const telemetry = createTelemetry(env);
const handler = createRequestHandler({ env, store: runtime.store, calendar: runtime.calendar, clock: systemClock, integrations: runtime.integrations, logger, telemetry, ownerWeb: { dir: resolve(process.cwd(), "web/dist") } });
const server = createServer(handler);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;

const worker = new OutboxWorker(runtime.store, runtime.sender, systemClock);
const recovery = new CallService(runtime.store, runtime.calendar, systemClock, env.PUBLIC_BASE_URL);
const deletion = new DataDeletionService(
  runtime.store,
  env.TELNYX_API_KEY ? new TelnyxRecordingClient(env.TELNYX_API_KEY) : null,
);
const summaries = new OwnerSummaryService(runtime.store, systemClock, env.PUBLIC_BASE_URL);
const graceLine = new GraceLineService({ store: runtime.store, env, clock: systemClock, log: logger });
let workerActive = false;
let nextRecoveryAt = 0;
let nextRetentionAt = 0;
let nextSummaryAt = 0;
let nextGraceAt = 0;
const runWorker = async (): Promise<void> => {
  if (workerActive) return;
  workerActive = true;
  try {
    const result = await worker.runOnce();
    if (result.sent + result.retried + result.dead > 0) logger({ level: "info", event: "outbox_cycle", ...result });
    if (Date.now() >= nextRecoveryAt) {
      nextRecoveryAt = Date.now() + 30_000;
      for (const tenantId of await runtime.store.listTenantIds()) {
        try {
          const recovered = await recovery.recoverStaleCalls(tenantId);
          if (recovered > 0) logger({ level: "warn", event: "stale_calls_recovered", tenantId, recovered });
        } catch (error) {
          logger({ level: "error", event: "stale_call_recovery_failed", tenantId, error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
          telemetry.captureException(error, { route: "job:stale_call_recovery", tenantId });
        }
      }
    }
    if (Date.now() >= nextRetentionAt) {
      nextRetentionAt = Date.now() + 60 * 60_000;
      for (const tenantId of await runtime.store.listTenantIds()) {
        try {
          const config = await runtime.store.getConfig(tenantId);
          const cutoff = new Date(Date.now() - config.dataRetentionDays * 24 * 60 * 60_000).toISOString();
          const result = await deletion.deleteExpired(tenantId, cutoff);
          if (result.deleted > 0 || result.failed > 0) logger({ level: result.failed > 0 ? "error" : "info", event: "retention_cycle", tenantId, ...result, retentionDays: config.dataRetentionDays });
        } catch (error) {
          logger({ level: "error", event: "retention_cycle_failed", tenantId, error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
          telemetry.captureException(error, { route: "job:retention", tenantId });
        }
      }
      const purgedWebhooks = await runtime.store.purgeWebhookEvents(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString());
      if (purgedWebhooks > 0) logger({ level: "info", event: "webhook_retention_cycle", purged: purgedWebhooks });
    }
    if (Date.now() >= nextSummaryAt) {
      nextSummaryAt = Date.now() + 60_000;
      const queued = await summaries.runOnce();
      if (queued.smsQueued + queued.emailQueued > 0) logger({ level: "info", event: "owner_summaries_queued", ...queued });
    }
    if (Date.now() >= nextGraceAt) {
      // Billing grace line: day-23 reminder and day-30 release. Locked and idempotent, so every replica may run it.
      nextGraceAt = Date.now() + 10 * 60_000;
      const grace = await graceLine.runOnce();
      if (grace.reminded + grace.released > 0) logger({ level: "info", event: "grace_line_cycle", ...grace });
    }
  } catch (error) {
    logger({ level: "error", event: "outbox_failed", error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
    telemetry.captureException(error, { route: "job:outbox" });
  } finally {
    workerActive = false;
  }
};
const interval = setInterval(() => void runWorker(), 1_000);
interval.unref();

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(env.PORT, env.HOST, () => resolve());
});
logger({ level: "info", event: "server_started", host: env.HOST, port: env.PORT, demoMode: env.DEMO_MODE, analytics: telemetry.enabled });
void runWorker();

const shutdown = async (signal: string): Promise<void> => {
  logger({ level: "info", event: "shutdown_started", signal });
  clearInterval(interval);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  // Deliver queued analytics and errors before the container stops.
  await telemetry.shutdown().catch(() => undefined);
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
