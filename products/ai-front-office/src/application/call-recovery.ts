import type { CallRecord, CallSummaryInput } from "../domain/models.js";
import { lastClosedBillingPeriod, MIN_BILLABLE_CALL_SECONDS, usageClass } from "../domain/usage.js";
import type { Clock, Store } from "../ports.js";
import { CALL_TIME_LIMIT_SECONDS } from "../voice/system-prompt.js";
import { BLIND_CLOSURE_FLAG, type CallService } from "./call-service.js";
import { redactError } from "./retry.js";

/** What the voice provider can still tell us about a call whose end-of-call payload never arrived. */
export interface ProviderCallHistory {
  /**
   * "ended": the provider says so outright. "gone": it no longer knows the call, which it only forgets some
   * minutes after a call ends, so by itself that never proves a young call is over. "unknown": no answer.
   */
  callState(providerCallId: string): Promise<{ status: "alive" | "ended" | "gone" | "unknown"; durationSeconds: number | null; endedAt: string | null }>;
  /**
   * The call as the normal end-of-call path would have received it, built from the provider's stored
   * conversation; null when the provider has nothing (yet). `lastMessageAt` is when the conversation last moved.
   */
  summary(call: CallRecord, hints: { endedAt: string | null; durationSeconds: number | null }, now: Date): Promise<{ summary: CallSummaryInput; lastMessageAt: string | null; messages: number } | null>;
}

export interface CallRecordings {
  getDownloadUrl(providerCallId: string): Promise<string | null>;
  deleteForCall(providerCallId: string): Promise<void>;
}

/** Quiet this long (no tool write) before we ask the provider whether the call is still up. */
export const RECOVERY_IDLE_MS = 90_000;
/** The conversation must have been still this long: a live call keeps talking, and a late callback gets to land first. */
export const RECOVERY_QUIET_MS = 45_000;
/** Past the provider's hard time limit plus slack, a call cannot still be up, whatever the status lookup says. */
export const RECOVERY_CERTAIN_END_MS = (CALL_TIME_LIMIT_SECONDS + 120) * 1_000;
/** Calls without an end are looked at for a day (a request for the owner mid-call is never closed blind). */
export const RECOVERY_WINDOW_MS = 24 * 60 * 60_000;
const MAX_CALLS_PER_CYCLE = 200;
const ATTEMPT_KEY = "provider-history:attempt";
const CALL_LENGTH_KEYS = ["call-length:finish", "call-length:wrap_up", "call-length:forced_wrap_up"] as const;

/** One look per call per this long, across replicas: often while the call is fresh, rarely once it is old. */
export function recoveryRetryMs(ageMs: number): number {
  if (ageMs < 10 * 60_000) return 30_000;
  if (ageMs < 60 * 60_000) return 2 * 60_000;
  return 30 * 60_000;
}

export interface CallRecoveryResult {
  /** Calls finished from the provider's history. */
  recovered: number;
  /** Calls that are over but could not be finished yet (no conversation, or it only just went quiet). */
  waiting: number;
  failed: number;
}

/**
 * Keeps the call when its end-of-call callback never arrives. Every few seconds it looks at calls that never
 * got an end; once the provider says a call is over (or it cannot still be up), it reads the conversation back
 * from the provider and runs the normal finalize path, so the transcript, summary, outcome, usage, callback
 * task and owner alerts are the same as if the callback had arrived. The blind 35-minute closure stays as the
 * last resort for calls the provider has nothing on.
 *
 * Safe on every replica: each look is claimed in the shared ledger, and the finalize itself runs under the
 * call's lock only while the call still has no end.
 */
export class CallRecovery {
  constructor(
    private readonly store: Store,
    private readonly service: CallService,
    private readonly history: ProviderCallHistory,
    private readonly clock: Clock,
    private readonly options: {
      publicBaseUrl: string;
      recordings: CallRecordings | null;
      log: (entry: Record<string, unknown>) => void;
      onRecovered?: ((call: CallRecord) => void) | undefined;
    },
  ) {}

  async runOnce(): Promise<CallRecoveryResult> {
    const now = this.clock.now();
    const result: CallRecoveryResult = { recovered: 0, waiting: 0, failed: 0 };
    const startedAfter = new Date(now.getTime() - RECOVERY_WINDOW_MS).toISOString();
    for (const call of await this.store.listUnfinishedCalls(startedAfter, MAX_CALLS_PER_CYCLE)) {
      try {
        const outcome = await this.recover(call, now);
        if (outcome) result[outcome] += 1;
      } catch (error) {
        // One bad call (or a provider hiccup) never stops the others; the next look retries.
        result.failed += 1;
        this.options.log({ level: "warn", event: "call_recovery_failed", tenantId: call.tenantId, callId: call.id, error: redactError(error) });
      }
    }
    return result;
  }

  private async recover(call: CallRecord, now: Date): Promise<"recovered" | "waiting" | null> {
    const age = now.getTime() - Date.parse(call.startedAt);
    const idle = now.getTime() - Date.parse(call.updatedAt);
    if (!Number.isFinite(age) || !Number.isFinite(idle) || idle < RECOVERY_IDLE_MS) return null;
    const claim = await this.store.claimToolResult(call.providerCallId, ATTEMPT_KEY, now.toISOString(), new Date(now.getTime() - recoveryRetryMs(age)).toISOString());
    if (claim.status !== "claimed") return null;

    const state = await this.history.callState(call.providerCallId).catch(() => ({ status: "unknown" as const, durationSeconds: null, endedAt: null }));
    if (state.status === "alive") return null;
    // Anything short of "it ended": over only if the call-length nudge already found the call gone, or the call
    // cannot still be up.
    const certain = age >= RECOVERY_CERTAIN_END_MS;
    if (state.status !== "ended" && !certain && !await this.nudgeSawCallEnd(call)) return null;
    await this.service.noteProviderCallEnded(call.providerCallId);
    return await this.finalizeFromHistory(call, state, now, certain) ? "recovered" : "waiting";
  }

  /**
   * The last look before a call is closed blind: by then it has been silent far longer than any call can last.
   * True when the provider still had the conversation and the call was finished from it.
   */
  async lastChance(call: CallRecord): Promise<boolean> {
    return this.finalizeFromHistory(call, { durationSeconds: null, endedAt: null }, this.clock.now(), true);
  }

  private async finalizeFromHistory(call: CallRecord, state: { durationSeconds: number | null; endedAt: string | null }, now: Date, certainlyOver: boolean): Promise<boolean> {
    const found = await this.history.summary(call, { endedAt: state.endedAt, durationSeconds: state.durationSeconds }, now);
    if (!found) return false;
    // Nobody spoke (yet): only a call that is certainly over is finished as the empty call it was.
    if (found.messages === 0 && !certainlyOver) return false;
    // Still moving: either the call is not really over, or its own callback is about to land.
    if (found.lastMessageAt && now.getTime() - Date.parse(found.lastMessageAt) < RECOVERY_QUIET_MS) return false;
    const summary = found.summary;
    summary.recordingUrl = await recordingLink(this.store, this.options.recordings, this.options.publicBaseUrl, call);
    if ((summary.consentState === "declined" || call.consentState === "declined") && this.options.recordings) {
      await this.options.recordings.deleteForCall(call.providerCallId).catch((error) => {
        this.options.log({ level: "error", event: "declined_recording_delete_failed", tenantId: call.tenantId, callId: call.id, error: redactError(error) });
      });
      summary.recordingUrl = null;
    }
    const finalized = await this.service.finalizeFromProviderHistory(summary, { mode: "recover" });
    if (!finalized) return false;
    this.options.log({ level: "warn", event: "call_finalized_from_provider_history", tenantId: finalized.tenantId, callId: finalized.id, outcome: finalized.outcome, transcript: Boolean(finalized.transcript?.trim()) });
    this.options.onRecovered?.(finalized);
    return true;
  }

  /** The call-length guard already learned the call was over when its nudge had nowhere to land. */
  private async nudgeSawCallEnd(call: CallRecord): Promise<boolean> {
    for (const key of CALL_LENGTH_KEYS) {
      const entry = await this.store.getToolResult(call.providerCallId, key);
      if (entry?.status === "done" && (entry.result as { result?: unknown } | null)?.result === "call_ended") return true;
    }
    return false;
  }
}

/** The owner's recording link (the one the callback path stores), only when the provider really has a recording. */
export async function recordingLink(store: Store, recordings: CallRecordings | null, publicBaseUrl: string, call: Pick<CallRecord, "tenantId" | "providerCallId">): Promise<string | null> {
  if (!recordings) return null;
  const available = await recordings.getDownloadUrl(call.providerCallId).then(Boolean).catch(() => false);
  if (!available) return null;
  const ownerPortal = await store.getOwnerAccountByTenant(call.tenantId) ? "/app" : "/admin";
  return `${publicBaseUrl.replace(/\/$/, "")}${ownerPortal}/provider/telnyx/recordings/${encodeURIComponent(call.providerCallId)}`;
}

export interface BackfillChange {
  /** Last six characters only: enough to match a call by eye, never the whole id. */
  call: string;
  tenant: string;
  status: "repaired" | "would_repair" | "no_history" | "skipped" | "failed";
  /** What the repair changes (booleans and plain words only; never caller words or numbers). */
  changes?: {
    transcript: boolean;
    callerName: boolean;
    address: boolean;
    problem: boolean;
    durationSeconds: number | null;
    counted: boolean;
    /** The call falls in a billing period that already closed: its extra-call invoice will not change. */
    closedPeriod: boolean;
    outcome?: string;
    callbackTask?: string;
  };
  error?: string;
}

/**
 * Repairs calls that were closed blind (BLIND_CLOSURE_FLAG) in the last `days` days, from the provider's
 * conversation history. It only fixes the stored record (transcript, fields, outcome, billing, callback task):
 * no text to the caller, no owner alert, no calendar write. A dry run reads and reports only.
 */
export async function backfillBlindClosures(input: {
  store: Store;
  service: CallService;
  history: ProviderCallHistory;
  clock: Clock;
  publicBaseUrl: string;
  recordings: CallRecordings | null;
  days: number;
  dryRun: boolean;
}): Promise<BackfillChange[]> {
  const now = input.clock.now();
  const from = new Date(now.getTime() - input.days * 24 * 60 * 60_000).toISOString();
  const report: BackfillChange[] = [];
  for (const tenantId of (await input.store.listTenantIds()).sort()) {
    const calls = (await input.store.listCallsStartedBetween(tenantId, from, new Date(now.getTime() + 60_000).toISOString(), 5_000))
      .filter((call) => call.qualityFlags.includes(BLIND_CLOSURE_FLAG));
    const subscription = calls.length > 0 ? await input.store.getSubscription(tenantId) : null;
    const closed = lastClosedBillingPeriod(now, subscription?.currentPeriodEnd);
    for (const call of calls) {
      const row = { call: call.id.slice(-6), tenant: tenantId.slice(-6) };
      try {
        const found = await input.history.summary(call, { endedAt: null, durationSeconds: null }, now);
        if (!found || found.messages === 0) {
          report.push({ ...row, status: "no_history" });
          continue;
        }
        const summary = found.summary;
        const durationSeconds = Math.max(call.durationSeconds ?? 0, summary.durationSeconds ?? 0) || null;
        const changes: NonNullable<BackfillChange["changes"]> = {
          transcript: Boolean(summary.transcript?.trim()),
          callerName: Boolean(summary.fields.callerName?.trim() || call.fields.callerName?.trim()),
          address: Boolean(summary.fields.address?.trim() || call.fields.address?.trim()),
          problem: Boolean(summary.fields.problemDescription.trim() || call.fields.problemDescription.trim()),
          durationSeconds,
          // Counts against the plan once repaired: answered, not spam, 15 seconds or longer.
          counted: call.billingDisposition !== "spam_excluded" && (durationSeconds ?? 0) >= MIN_BILLABLE_CALL_SECONDS,
          closedPeriod: closed !== null && Date.parse(call.startedAt) < Date.parse(closed[1]),
        };
        if (input.dryRun) {
          report.push({ ...row, status: "would_repair", changes });
          continue;
        }
        summary.recordingUrl = await recordingLink(input.store, input.recordings, input.publicBaseUrl, call);
        // The caller declined recording: the audio goes. A failed delete is reported, never swallowed.
        let deleteError: string | null = null;
        if ((summary.consentState === "declined" || call.consentState === "declined") && input.recordings) {
          await input.recordings.deleteForCall(call.providerCallId).catch((error) => { deleteError = `declined recording not deleted: ${redactError(error)}`; });
          summary.recordingUrl = null;
        }
        const repaired = await input.service.finalizeFromProviderHistory(summary, { mode: "repair" });
        if (!repaired) {
          report.push({ ...row, status: "skipped" });
          continue;
        }
        const task = await input.store.getCallbackTaskForCall(repaired.id);
        report.push({ ...row, status: "repaired", changes: {
          ...changes,
          callerName: Boolean(repaired.fields.callerName?.trim()),
          address: Boolean(repaired.fields.address?.trim()),
          problem: Boolean(repaired.fields.problemDescription.trim()),
          durationSeconds: repaired.durationSeconds,
          counted: usageClass(repaired) === "billable",
          outcome: repaired.outcome,
          callbackTask: task?.status ?? "none",
        }, ...(deleteError ? { error: deleteError } : {}) });
      } catch (error) {
        report.push({ ...row, status: "failed", error: redactError(error) });
      }
    }
  }
  return report;
}
