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
    try {
      return await this.bookUnderLock(input);
    } catch (error) {
      // Another booking for this shop held the calendar past the wait limit: never fail the
      // caller's tool call; fall back to owner confirmation.
      if (error instanceof Error && error.message.startsWith("Lock wait timed out")) {
        return this.pending(input, "Calendar was busy with another booking; owner confirmation required", this.clock.now());
      }
      throw error;
    }
  }

  private async bookUnderLock(input: BookSlotInput): Promise<BookingRecord> {
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

      let created: { status: "confirmed" | "unknown"; providerEventId: string | null } | null = null;
      let createAttempted = false;
      try {
        const free = await withRetry(() => this.calendar.isFree({ tenantId: input.tenantId, slot }), {
          attempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          timeoutMs: 900,
        });
        if (!free) {
          const conflict = { ...booking, status: "conflict" as const, failureReason: "Requested slot is no longer free", updatedAt: this.clock.now().toISOString() };
          await this.store.saveBooking(conflict);
          await this.safeAudit(input.tenantId, input.callId, started, "failed", { status: "conflict", slot }, conflict.failureReason);
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
        createAttempted = true;
        created = await withRetry(() => this.calendar.createEvent(attempt), {
          attempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          timeoutMs: 1_500,
        });
        const createdEvent = created;
        const writeVerified = createdEvent.status === "confirmed" && createdEvent.providerEventId
          ? await withRetry(() => this.calendar.verifyEvent({ tenantId: input.tenantId, providerEventId: createdEvent.providerEventId!, slot }), {
              attempts: 1,
              baseDelayMs: 0,
              maxDelayMs: 0,
              timeoutMs: 1_200,
            })
          : false;
        const verifiedStatus = createdEvent.status === "confirmed" && writeVerified ? "confirmed" as const : "unknown" as const;
        const result: BookingRecord = {
          ...booking,
          status: verifiedStatus,
          providerEventId: createdEvent.providerEventId,
          writeVerifiedAt: writeVerified ? this.clock.now().toISOString() : null,
          verificationFailures: writeVerified ? [] : ["system_write_not_verified"],
          failureReason: writeVerified ? null : "Calendar write could not be read back; owner confirmation required",
          updatedAt: this.clock.now().toISOString(),
        };
        await this.store.saveBooking(result);
        await this.safeAudit(input.tenantId, input.callId, started, writeVerified ? "success" : "unknown", { status: verifiedStatus, slot, writeVerified }, result.failureReason);
        return result;
      } catch (error) {
        if (createAttempted) {
          // The event may exist even though we saw an error (timeout, failed read-back).
          // Keep its id and mark it unknown so a retry neither double-books nor reports a
          // conflict against the shop's own event; the owner confirms.
          const uncertain: BookingRecord = {
            ...booking,
            status: "unknown",
            providerEventId: created?.providerEventId ?? null,
            writeVerifiedAt: null,
            verificationFailures: ["system_write_not_verified"],
            failureReason: `Calendar write may have happened (${redactError(error)}); owner confirmation required`,
            updatedAt: this.clock.now().toISOString(),
          };
          await this.store.saveBooking(uncertain);
          await this.safeAudit(input.tenantId, input.callId, started, "unknown", { status: "unknown", slot }, uncertain.failureReason);
          return uncertain;
        }
        const pending = await this.pending(input, redactError(error), started, slot, booking);
        await this.safeAudit(input.tenantId, input.callId, started, "failed", { status: "pending", slot }, pending.failureReason);
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

  /** Audit is evidence, not control flow: a failed audit write must never change the booking outcome. */
  private async safeAudit(...args: Parameters<BookingCoordinator["audit"]>): Promise<void> {
    await this.audit(...args).catch(() => undefined);
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
