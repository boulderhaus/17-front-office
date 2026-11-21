import type { CalendarPort, Store } from "../ports.js";

export interface RecordingDeletionPort {
  deleteForCall(providerCallId: string): Promise<void>;
}

export class DataDeletionService {
  constructor(
    private readonly store: Store,
    private readonly calendar: CalendarPort,
    private readonly recordings: RecordingDeletionPort | null,
  ) {}

  async deleteCall(tenantId: string, callId: string): Promise<boolean> {
    const call = await this.store.getCall(callId);
    if (!call || call.tenantId !== tenantId) return false;
    const booking = await this.store.getBookingForCall(call.id);
    if (call.recordingUrl) {
      if (!this.recordings) throw new Error("Recording deletion is not configured");
      await this.recordings.deleteForCall(call.providerCallId);
    }
    if (booking?.providerEventId) {
      await this.calendar.deleteEvent({ tenantId, providerEventId: booking.providerEventId });
    }
    return this.store.deleteCall(tenantId, callId);
  }

  async deleteExpired(tenantId: string, endedBefore: string, limit = 100): Promise<{ deleted: number; failed: number }> {
    const calls = await this.store.listExpiredCalls(tenantId, endedBefore, limit);
    let deleted = 0;
    let failed = 0;
    for (const call of calls) {
      try {
        if (await this.deleteCall(tenantId, call.id)) deleted += 1;
      } catch {
        failed += 1;
      }
    }
    return { deleted, failed };
  }
}
