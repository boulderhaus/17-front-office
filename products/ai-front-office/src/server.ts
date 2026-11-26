import { createServer } from "node:http";
import { resolve } from "node:path";
import { OutboxWorker } from "./application/outbox-worker.js";
import { CallService } from "./application/call-service.js";
import { DataDeletionService } from "./application/data-deletion.js";
import { GraceLineService } from "./application/grace-line.js";
import { OwnerSummaryService } from "./application/owner-summary-service.js";
import { CallLengthGuard } from "./application/call-length.js";
import { CallRecovery } from "./application/call-recovery.js";
import { LineHealthCheck } from "./application/line-health.js";
import { TelnyxAssistantMessenger, TelnyxProviderCallHistory, TelnyxRecordingClient } from "./adapters/telnyx.js";
import { loadEnvironment } from "./config/environment.js";
import { createRequestHandler, createStripeClient } from "./http/app.js";
import { OverageBillingService } from "./application/billing-jobs.js";
import { createTelemetry } from "./adapters/posthog.js";
import { systemClock } from "./ports.js";
import { createRuntime } from "./runtime.js";
import { urgentOwnerCallsConfigured } from "./adapters/telnyx-owner-call.js";
import { TOOL_LEDGER_RETENTION_MS } from "./voice/tool-results.js";

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
const recovery = new CallService(runtime.store, runtime.calendar, systemClock, env.PUBLIC_BASE_URL, { callbackLinkKey: env.SESSION_SIGNING_KEY ?? null, ownerEmailAvailable: Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL), pushAvailable: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY), urgentCallAvailable: urgentOwnerCallsConfigured(env) });
const deletion = new DataDeletionService(
  runtime.store,
  env.TELNYX_API_KEY ? new TelnyxRecordingClient(env.TELNYX_API_KEY) : null,
);
// A call whose end-of-call callback never arrives is finished from Telnyx's own conversation history, so its
// transcript, summary, usage count and callback task are kept. Claimed per call in the shared ledger and
// finalized under the call's lock, so every replica may run it.
const callRecovery = env.TELNYX_API_KEY && !env.DEMO_MODE
  ? new CallRecovery(runtime.store, recovery, new TelnyxProviderCallHistory(env.TELNYX_API_KEY), systemClock, {
      publicBaseUrl: env.PUBLIC_BASE_URL,
      recordings: new TelnyxRecordingClient(env.TELNYX_API_KEY),
      log: logger,
      // Outcome only, like the webhook path: never the caller's name, number, address or transcript.
      onRecovered: (call) => telemetry.capture("call_finalized", call.tenantId, call.tenantId, {
        channel: "provider_history", outcome: call.outcome, emergency: call.emergency?.emergency === true,
        duration_seconds: call.durationSeconds, consent_state: call.consentState, billing_disposition: call.billingDisposition,
      }),
    })
  : null;
// Every live line must post its end-of-call callback here (go-live sets it). Read-only; an error names the shop.
const lineHealth = env.TELNYX_API_KEY && !env.DEMO_MODE
  ? new LineHealthCheck(runtime.store, {
      apiKey: env.TELNYX_API_KEY, publicBaseUrl: env.PUBLIC_BASE_URL, log: logger,
      onMissing: (tenantId) => telemetry.captureException(new Error("A live line is missing its end-of-call callback"), { route: "job:line_health", tenantId }),
    })
  : null;
const summaries = new OwnerSummaryService(runtime.store, systemClock, env.PUBLIC_BASE_URL);
const graceLine = new GraceLineService({ store: runtime.store, env, clock: systemClock, log: logger });
// Period-end overage: extra answered calls in a closed billing period, billed once as a Stripe invoice.
const overage = new OverageBillingService(runtime.store, createStripeClient(env, fetch), systemClock, logger);
// Numbers saved before the lookup column existed: hash them so their grace-period voicemail can find the shop.
try {
  const backfill = await runtime.store.backfillInboundNumberLookups();
  if (backfill.updated > 0 || backfill.conflicts > 0) logger({ level: backfill.conflicts > 0 ? "error" : "info", event: "inbound_number_lookup_backfill", ...backfill });
} catch (error) {
  logger({ level: "error", event: "inbound_number_lookup_backfill_failed", error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
}
let workerActive = false;
let nextRecoveryAt = 0;
let nextRetentionAt = 0;
let nextSummaryAt = 0;
let nextGraceAt = 0;
let nextOverageAt = 0;
let nextActivationAt = 0;
let nextFounderAt = 0;
let nextLineHealthAt = 0;
const runWorker = async (): Promise<void> => {
  if (workerActive) return;
  workerActive = true;
  try {
    const result = await worker.runOnce();
    if (result.sent + result.retried + result.dead + result.held > 0) logger({ level: "info", event: "outbox_cycle", ...result });
    if (Date.now() >= nextRecoveryAt) {
      nextRecoveryAt = Date.now() + 30_000;
      for (const tenantId of await runtime.store.listTenantIds()) {
        try {
          // The blind closure is the last resort: a call Telnyx still has the conversation for is finished from it.
          const recovered = await recovery.recoverStaleCalls(tenantId, undefined, callRecovery ? (call) => callRecovery.lastChance(call) : undefined);
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
      const purgedToolLedger = await runtime.store.purgeToolLedger(new Date(Date.now() - TOOL_LEDGER_RETENTION_MS).toISOString());
      if (purgedToolLedger > 0) logger({ level: "info", event: "tool_ledger_retention_cycle", purged: purgedToolLedger });
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
    if (Date.now() >= nextActivationAt) {
      // Waiting paid shops go live once prerequisites clear; opted-in owners get the opt-in text once texting is approved.
      nextActivationAt = Date.now() + 10 * 60_000;
      const activation = await handler.runActivationJobs();
      if (activation.activated + activation.blocked + activation.optInConfirmations > 0) logger({ level: "info", event: "activation_cycle", ...activation });
    }
    if (Date.now() >= nextFounderAt) {
      // Brock's email when forwarding still isn't confirmed 20 minutes after "Set it up with me". Locked per shop
      // and keyed in the outbox, so every replica may run it.
      nextFounderAt = Date.now() + 60_000;
      const founder = await handler.runFounderFollowups();
      if (founder.queued > 0) logger({ level: "info", event: "founder_followup_cycle", ...founder });
    }
    if (lineHealth && Date.now() >= nextLineHealthAt) {
      // At startup and every six hours: two reads per shop.
      nextLineHealthAt = Date.now() + 6 * 60 * 60_000;
      const health = await lineHealth.runOnce();
      logger({ level: health.missing + health.failed > 0 ? "error" : "info", event: "line_health_cycle", ...health });
    }
    if (Date.now() >= nextOverageAt) {
      // Hourly: a period closes at most once a month per shop; locked and idempotent across replicas.
      nextOverageAt = Date.now() + 60 * 60_000;
      const billed = await overage.runOnce();
      if (billed.billed + billed.failed > 0) logger({ level: billed.failed > 0 ? "error" : "info", event: "overage_cycle", ...billed });
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

// Graceful call length: system messages to the live assistant at 4:30 and 5:30. Its own loop, so a slow job above
// never delays a nudge. Claimed per call in the shared ledger, so every replica may run it.
const callLength = env.TELNYX_API_KEY && !env.DEMO_MODE
  ? new CallLengthGuard(runtime.store, new TelnyxAssistantMessenger(env.TELNYX_API_KEY), systemClock, logger)
  : null;
let callLengthActive = false;
const runCallLength = async (): Promise<void> => {
  if (!callLength || callLengthActive) return;
  callLengthActive = true;
  try {
    await callLength.runOnce();
  } catch (error) {
    logger({ level: "error", event: "call_length_cycle_failed", error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
    telemetry.captureException(error, { route: "job:call_length" });
  } finally {
    callLengthActive = false;
  }
};
const callLengthInterval = setInterval(() => void runCallLength(), 5_000);
callLengthInterval.unref();

// Call recovery: its own loop, so a slow job above never delays a call's record.
let callRecoveryActive = false;
const runCallRecovery = async (): Promise<void> => {
  if (!callRecovery || callRecoveryActive) return;
  callRecoveryActive = true;
  try {
    const result = await callRecovery.runOnce();
    if (result.recovered + result.failed > 0) logger({ level: result.failed > 0 ? "warn" : "info", event: "call_recovery_cycle", ...result });
  } catch (error) {
    logger({ level: "error", event: "call_recovery_cycle_failed", error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
    telemetry.captureException(error, { route: "job:call_recovery" });
  } finally {
    callRecoveryActive = false;
  }
};
const callRecoveryInterval = setInterval(() => void runCallRecovery(), 15_000);
callRecoveryInterval.unref();

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(env.PORT, env.HOST, () => resolve());
});
logger({ level: "info", event: "server_started", host: env.HOST, port: env.PORT, demoMode: env.DEMO_MODE, analytics: telemetry.enabled });
void runWorker();

const shutdown = async (signal: string): Promise<void> => {
  logger({ level: "info", event: "shutdown_started", signal });
  clearInterval(interval);
  clearInterval(callLengthInterval);
  clearInterval(callRecoveryInterval);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  // Deliver queued analytics and errors before the container stops.
  await telemetry.shutdown().catch(() => undefined);
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
