import { randomUUID } from "node:crypto";
import type { BookingAttempt, BookingRecord } from "../domain/models.js";
import type { CalendarPort, Clock, Store } from "../ports.js";
import { redactError, withRetry } from "./retry.js";

export interface BookSlotInput {
  tenantId: string;
  callId: string;
  providerCallId: string;
  requestedStart: string;
  durationMinutes: number;
  callerName: string;
  callbackNumber: string;
  address: string;
  problemDescription: string;
}

export class BookingCoordinator {
  constructor(
    private readonly store: Store,
    private readonly calendar: CalendarPort,
    private readonly clock: Clock,
  ) {}

  async book(input: BookSlotInput): Promise<BookingRecord> {
    return this.store.withLock(`calendar:${input.tenantId}`, async () => {
      const existing = await this.store.getBookingForCall(input.callId);
      if (existing?.status === "confirmed" || existing?.status === "unknown") return existing;

      const started = this.clock.now();
      const start = new Date(input.requestedStart);
      if (Number.isNaN(start.getTime())) return this.pending(input, "Invalid requested start time", started, undefined, existing);
      const end = new Date(start.getTime() + input.durationMinutes * 60_000);
      const slot = { start: start.toISOString(), end: end.toISOString() };
      const booking: BookingRecord = {
        id: existing?.id ?? randomUUID(),
        tenantId: input.tenantId,
        callId: input.callId,
        requestedStart: slot.start,
        requestedEnd: slot.end,
        status: "checking",
        providerEventId: null,
        writeVerifiedAt: null,
        confirmationNotificationId: null,
        verificationFailures: [],
        failureReason: null,
        createdAt: existing?.createdAt ?? started.toISOString(),
        updatedAt: started.toISOString(),
      };
      await this.store.saveBooking(booking);

      try {
        const free = await withRetry(() => this.calendar.isFree({ tenantId: input.tenantId, slot }), {
          attempts: 2,
          baseDelayMs: 50,
          maxDelayMs: 100,
          timeoutMs: 2_500,
        });
        if (!free) {
          const conflict = { ...booking, status: "conflict" as const, failureReason: "Requested slot is no longer free", updatedAt: this.clock.now().toISOString() };
          await this.store.saveBooking(conflict);
          await this.audit(input.tenantId, input.callId, started, "failed", { status: "conflict", slot }, conflict.failureReason);
          return conflict;
        }

        const attempt: BookingAttempt = {
          tenantId: input.tenantId,
          callId: input.callId,
          providerCallId: input.providerCallId,
          slot,
          callerName: input.callerName,
          callbackNumber: input.callbackNumber,
          address: input.address,
          problemDescription: input.problemDescription,
          idempotencyKey: `calendar:${input.tenantId}:${input.callId}:${slot.start}`,
        };
        const created = await withRetry(() => this.calendar.createEvent(attempt), {
          attempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 250,
          timeoutMs: 4_000,
        });
        const writeVerified = created.status === "confirmed" && created.providerEventId
          ? await withRetry(() => this.calendar.verifyEvent({ tenantId: input.tenantId, providerEventId: created.providerEventId!, slot }), {
              attempts: 2,
              baseDelayMs: 100,
              maxDelayMs: 250,
              timeoutMs: 4_000,
            })
          : false;
        const verifiedStatus = created.status === "confirmed" && writeVerified ? "confirmed" as const : "unknown" as const;
        const result: BookingRecord = {
          ...booking,
          status: verifiedStatus,
          providerEventId: created.providerEventId,
          writeVerifiedAt: writeVerified ? this.clock.now().toISOString() : null,
          verificationFailures: writeVerified ? [] : ["system_write_not_verified"],
          failureReason: writeVerified ? null : "Calendar write could not be read back; owner confirmation required",
          updatedAt: this.clock.now().toISOString(),
        };
        await this.store.saveBooking(result);
        await this.audit(input.tenantId, input.callId, started, writeVerified ? "success" : "unknown", { status: verifiedStatus, slot, writeVerified }, result.failureReason);
        return result;
      } catch (error) {
        const pending = await this.pending(input, redactError(error), started, slot, booking);
        await this.audit(input.tenantId, input.callId, started, "failed", { status: "pending", slot }, pending.failureReason);
        return pending;
      }
    });
  }

  private async pending(
    input: BookSlotInput,
    reason: string,
    started: Date,
    slot?: { start: string; end: string },
    existing?: BookingRecord | null,
  ): Promise<BookingRecord> {
    const now = this.clock.now().toISOString();
    const pending: BookingRecord = {
      id: existing?.id ?? randomUUID(),
      tenantId: input.tenantId,
      callId: input.callId,
      requestedStart: slot?.start ?? input.requestedStart,
      requestedEnd: slot?.end ?? null,
      status: "pending",
      providerEventId: null,
      writeVerifiedAt: null,
      confirmationNotificationId: null,
      verificationFailures: ["system_write_not_verified"],
      failureReason: reason,
      createdAt: existing?.createdAt ?? started.toISOString(),
      updatedAt: now,
    };
    await this.store.saveBooking(pending);
    return pending;
  }

  private async audit(
    tenantId: string,
    callId: string,
    started: Date,
    result: "success" | "failed" | "unknown",
    metadata: Record<string, unknown>,
    error: string | null,
  ): Promise<void> {
    const completed = this.clock.now();
    await this.store.addToolEvent({
      id: randomUUID(),
      tenantId,
      callId,
      tool: "calendar.book",
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      latencyMs: Math.max(0, completed.getTime() - started.getTime()),
      result,
      metadata,
      redactedError: error,
    });
  }
}
