import type { CallRecord } from "../domain/models.js";
import type { Clock, Store } from "../ports.js";
import {
  buildFinishNudge,
  buildWrapUpNudge,
  CALL_TIME_LIMIT_SECONDS,
  FINISH_NUDGE_AFTER_SECONDS,
  WRAP_UP_NUDGE_AFTER_SECONDS,
} from "../voice/system-prompt.js";
import { redactError } from "./retry.js";

/** Sends one system message to the assistant on a live call. */
export interface AssistantMessenger {
  addSystemMessage(callControlId: string, content: string, commandId: string): Promise<"sent" | "call_ended">;
}

export type CallLengthStage = "finish" | "wrap_up";

/** A claim not completed within this long (its send failed, or its replica died mid-send) may be taken over and retried. */
const CLAIM_STALE_MS = 20_000;
/** Bounds one cycle; far above any real number of simultaneous calls. */
const MAX_ACTIVE_CALLS = 500;

/** The nudge due now for a call this many seconds old, or null. A call already past 5:30 skips the 4:30 nudge. */
export function dueCallLengthStage(elapsedSeconds: number): CallLengthStage | null {
  if (elapsedSeconds >= CALL_TIME_LIMIT_SECONDS) return null;
  if (elapsedSeconds >= WRAP_UP_NUDGE_AFTER_SECONDS) return "wrap_up";
  if (elapsedSeconds >= FINISH_NUDGE_AFTER_SECONDS) return "finish";
  return null;
}

export function callLengthNudge(stage: CallLengthStage, call: CallRecord): string {
  return stage === "finish" ? buildFinishNudge() : buildWrapUpNudge({ emergency: call.emergency?.emergency === true });
}

/**
 * Keeps calls near six minutes without cutting anyone off. Every few seconds it finds calls still in progress
 * (start time from the database, so restarts and extra replicas don't matter) and adds a system message to the
 * live assistant at 4:30 and 5:30. Each message is claimed in the shared tool ledger before it is sent, so it goes
 * out once across replicas; Telnyx's command_id dedupes a send retried after a crash. A failed send is only
 * logged: the Telnyx time limit still ends the call.
 */
export class CallLengthGuard {
  constructor(
    private readonly store: Store,
    private readonly messenger: AssistantMessenger,
    private readonly clock: Clock,
    private readonly log: (entry: Record<string, unknown>) => void,
  ) {}

  async runOnce(): Promise<{ sent: number; ended: number; failed: number }> {
    const now = this.clock.now();
    const totals = { sent: 0, ended: 0, failed: 0 };
    const startedAfter = new Date(now.getTime() - CALL_TIME_LIMIT_SECONDS * 1000).toISOString();
    for (const call of await this.store.listInProgressCalls(startedAfter, MAX_ACTIVE_CALLS)) {
      const startedAt = Date.parse(call.startedAt);
      if (!Number.isFinite(startedAt)) continue;
      const stage = dueCallLengthStage((now.getTime() - startedAt) / 1000);
      if (!stage) continue;
      const outcome = await this.send(call, stage);
      if (outcome) totals[outcome] += 1;
    }
    return totals;
  }

  private async send(call: CallRecord, stage: CallLengthStage): Promise<"sent" | "ended" | "failed" | null> {
    const key = `call-length:${stage}`;
    const now = this.clock.now();
    const claim = await this.store.claimToolResult(call.providerCallId, key, now.toISOString(), new Date(now.getTime() - CLAIM_STALE_MS).toISOString());
    if (claim.status !== "claimed") return null;
    try {
      const result = await this.messenger.addSystemMessage(call.providerCallId, callLengthNudge(stage, call), `front-office-${key}`);
      await this.store.completeToolResult(call.providerCallId, key, { result }, this.clock.now().toISOString());
      this.log({ level: "info", event: "call_length_nudge", stage, result, tenantId: call.tenantId, callId: call.id });
      return result === "sent" ? "sent" : "ended";
    } catch (error) {
      // The claim stays pending, so another cycle retries once it goes stale (every CLAIM_STALE_MS, not every tick);
      // command_id keeps a retry from doubling a message Telnyx already took.
      this.log({ level: "warn", event: "call_length_nudge_failed", stage, tenantId: call.tenantId, callId: call.id, error: redactError(error) });
      return "failed";
    }
  }
}
