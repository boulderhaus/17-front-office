import { createServer } from "node:http";
import { OutboxWorker } from "./application/outbox-worker.js";
import { CallService } from "./application/call-service.js";
import { DataDeletionService } from "./application/data-deletion.js";
import { TelnyxRecordingClient } from "./adapters/telnyx.js";
import { loadEnvironment } from "./config/environment.js";
import { createRequestHandler } from "./http/app.js";
import { systemClock } from "./ports.js";
import { createRuntime } from "./runtime.js";

const env = loadEnvironment(process.env);
const runtime = await createRuntime(env);
const logger = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
const handler = createRequestHandler({ env, store: runtime.store, calendar: runtime.calendar, clock: systemClock, integrations: runtime.integrations, logger });
const server = createServer(handler);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;

const worker = new OutboxWorker(runtime.store, runtime.sender, systemClock);
const recovery = new CallService(runtime.store, runtime.calendar, systemClock, env.PUBLIC_BASE_URL);
const deletion = new DataDeletionService(
  runtime.store,
  runtime.calendar,
  env.TELNYX_API_KEY ? new TelnyxRecordingClient(env.TELNYX_API_KEY) : null,
);
let workerActive = false;
let nextRecoveryAt = 0;
let nextRetentionAt = 0;
const runWorker = async (): Promise<void> => {
  if (workerActive) return;
  workerActive = true;
  try {
    const result = await worker.runOnce();
    if (result.sent + result.retried + result.dead > 0) logger({ level: "info", event: "outbox_cycle", ...result });
    if (Date.now() >= nextRecoveryAt) {
      nextRecoveryAt = Date.now() + 30_000;
      const recovered = await recovery.recoverStaleCalls(env.DEFAULT_TENANT_ID);
      if (recovered > 0) logger({ level: "warn", event: "stale_calls_recovered", recovered });
    }
    if (Date.now() >= nextRetentionAt) {
      nextRetentionAt = Date.now() + 60 * 60_000;
      const config = await runtime.store.getConfig(env.DEFAULT_TENANT_ID);
      const cutoff = new Date(Date.now() - config.dataRetentionDays * 24 * 60 * 60_000).toISOString();
      const result = await deletion.deleteExpired(env.DEFAULT_TENANT_ID, cutoff);
      if (result.deleted > 0 || result.failed > 0) logger({ level: result.failed > 0 ? "error" : "info", event: "retention_cycle", ...result, retentionDays: config.dataRetentionDays });
      const purgedWebhooks = await runtime.store.purgeWebhookEvents(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString());
      if (purgedWebhooks > 0) logger({ level: "info", event: "webhook_retention_cycle", purged: purgedWebhooks });
    }
  } catch (error) {
    logger({ level: "error", event: "outbox_failed", error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
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
logger({ level: "info", event: "server_started", host: env.HOST, port: env.PORT, demoMode: env.DEMO_MODE });
void runWorker();

const shutdown = async (signal: string): Promise<void> => {
  logger({ level: "info", event: "shutdown_started", signal });
  clearInterval(interval);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
