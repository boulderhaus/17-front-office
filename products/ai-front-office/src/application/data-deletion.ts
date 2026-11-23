import type { Store } from "../ports.js";

export interface RecordingDeletionPort {
  deleteForCall(providerCallId: string): Promise<void>;
}

/**
 * Deletes call evidence we hold. Appointments already written to the owner's
 * calendar are real work and are never removed here.
 */
export class DataDeletionService {
  constructor(
    private readonly store: Store,
    private readonly recordings: RecordingDeletionPort | null,
  ) {}

  async deleteCall(tenantId: string, callId: string): Promise<boolean> {
    const call = await this.store.getCall(callId);
    if (!call || call.tenantId !== tenantId) return false;
    if (call.recordingUrl) {
      if (!this.recordings) throw new Error("Recording deletion is not configured");
      await this.recordings.deleteForCall(call.providerCallId);
    }
    return this.store.deleteCall(tenantId, callId);
  }

  /**
   * Delete a whole shop. Provider recordings go first: if any cannot be deleted,
   * nothing local is removed so the owner can retry. Calendar appointments stay.
   */
  async deleteWorkspace(tenantId: string): Promise<void> {
    const calls = await this.store.listCalls(tenantId, 100_000);
    for (const call of calls) {
      if (!call.recordingUrl) continue;
      if (!this.recordings) throw new Error("Recording deletion is not configured");
      await this.recordings.deleteForCall(call.providerCallId);
    }
    await this.store.deleteWorkspace(tenantId);
  }

  async deleteExpired(tenantId: string, endedBefore: string, limit = 100, now = new Date().toISOString()): Promise<{ deleted: number; failed: number }> {
    const calls = await this.store.listExpiredCalls(tenantId, endedBefore, limit, now);
    let deleted = 0;
    let failed = 0;
    for (const call of calls) {
      try {
        if (await this.deleteCall(tenantId, call.id)) deleted += 1;
      } catch {
        failed += 1;
        // Back off for 24 hours so one stuck call cannot block newer deletions.
        await this.store.markRetentionFailed(call.id, now);
      }
    }
    return { deleted, failed };
  }
}
