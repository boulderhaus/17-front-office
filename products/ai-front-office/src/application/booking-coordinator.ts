import { randomUUID } from "node:crypto";
import type { BookingAttempt, BookingRecord } from "../domain/models.js";
import type { CalendarPort, CallOptions, Clock, Store } from "../ports.js";
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

  /**
   * `options.signal` is the voice tool deadline. Nothing is written once it fires, except the truth about a
   * calendar write that was already sent: that is recorded as unknown so a retry can never book twice.
   */
  async book(input: BookSlotInput, options: CallOptions = {}): Promise<BookingRecord> {
    try {
      return await this.bookUnderLock(input, options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      // Another booking for this shop held the calendar past the wait limit: never fail the
      // caller's tool call; fall back to owner confirmation.
      if (error instanceof Error && error.message.startsWith("Lock wait timed out")) {
        return this.pending(input, "Calendar was busy with another booking; owner confirmation required", this.clock.now());
      }
      throw error;
    }
  }

  private async bookUnderLock(input: BookSlotInput, signal?: AbortSignal): Promise<BookingRecord> {
    return this.store.withLock(`calendar:${input.tenantId}`, async () => {
      const existing = await this.store.getBookingForCall(input.callId);
      if (existing?.status === "confirmed") return existing;

      const started = this.clock.now();
      const start = new Date(input.requestedStart);
      if (Number.isNaN(start.getTime())) {
        if (existing?.status === "unknown") return existing;
        signal?.throwIfAborted();
        return this.pending(input, "Invalid requested start time", started, undefined, existing);
      }
      const end = new Date(start.getTime() + input.durationMinutes * 60_000);
      const slot = { start: start.toISOString(), end: end.toISOString() };
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

      if (existing) {
        // A retry. An earlier insert for this exact slot may have landed (late, after an abort, or before a
        // crash), so look for its deterministic event before free/busy (which would call it a conflict) and
        // before inserting again.
        const found = await this.findEarlierEvent(attempt, signal);
        if (found) return this.recordFoundEvent(booking, found, slot, started, signal);
        // Still not visible: the earlier insert may yet land. Never insert a second time; the owner confirms.
        if (existing.status === "unknown") return existing;
      }

      signal?.throwIfAborted();
      await this.store.saveBooking(booking);

      let created: { status: "confirmed" | "unknown"; providerEventId: string | null } | null = null;
      let createAttempted = false;
      let dispatchedEventId: string | null = null;
      try {
        const free = await withRetry(() => this.calendar.isFree({ tenantId: input.tenantId, slot }, { signal }), {
          attempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          timeoutMs: 900,
        });
        if (!free) {
          signal?.throwIfAborted();
          const conflict = { ...booking, status: "conflict" as const, failureReason: "Requested slot is no longer free", updatedAt: this.clock.now().toISOString() };
          await this.store.saveBooking(conflict);
          await this.safeAudit(input.tenantId, input.callId, started, "failed", { status: "conflict", slot }, conflict.failureReason);
          return conflict;
        }

        signal?.throwIfAborted();
        createAttempted = true;
        created = await withRetry(() => this.calendar.createEvent(attempt, { signal, onDispatch: (eventId) => { dispatchedEventId = eventId; } }), {
          attempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          timeoutMs: 1_500,
        });
        const createdEvent = created;
        const writeVerified = createdEvent.status === "confirmed" && createdEvent.providerEventId
          ? await withRetry(() => this.calendar.verifyEvent({ tenantId: input.tenantId, providerEventId: createdEvent.providerEventId!, slot }, { signal }), {
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
        // Once the insert is dispatched the event may exist whatever we saw (abort, timeout, failed read-back).
        // Record it as unknown with its deterministic id, even past the deadline, and return that row: a retry
        // then finds the event instead of inserting again, and the owner confirms.
        if (createAttempted) {
          const uncertain: BookingRecord = {
            ...booking,
            status: "unknown",
            providerEventId: created?.providerEventId ?? dispatchedEventId,
            writeVerifiedAt: null,
            verificationFailures: ["system_write_not_verified"],
            failureReason: `Calendar write may have happened (${redactError(error)}); owner confirmation required`,
            updatedAt: this.clock.now().toISOString(),
          };
          await this.store.saveBooking(uncertain);
          await this.safeAudit(input.tenantId, input.callId, started, "unknown", { status: "unknown", slot }, uncertain.failureReason);
          return uncertain;
        }
        // Past the deadline with nothing sent to the calendar: write nothing more.
        signal?.throwIfAborted();
        const pending = await this.pending(input, redactError(error), started, slot, booking);
        await this.safeAudit(input.tenantId, input.callId, started, "failed", { status: "pending", slot }, pending.failureReason);
        return pending;
      }
    });
  }

  /** The event an earlier attempt for this key created; null if none or if the lookup itself failed. */
  private async findEarlierEvent(attempt: BookingAttempt, signal?: AbortSignal): Promise<string | null> {
    try {
      return await withRetry(() => this.calendar.findEvent(attempt, { signal }), { attempts: 1, baseDelayMs: 0, maxDelayMs: 0, timeoutMs: 1_200 });
    } catch {
      signal?.throwIfAborted();
      // Unsure: inserting with the same deterministic id is still safe (the calendar refuses a duplicate id).
      return null;
    }
  }

  /** An earlier attempt's event exists: record it truthfully (confirmed once read back) and never insert again. */
  private async recordFoundEvent(booking: BookingRecord, providerEventId: string, slot: { start: string; end: string }, started: Date, signal?: AbortSignal): Promise<BookingRecord> {
    let verified = false;
    try {
      verified = await withRetry(() => this.calendar.verifyEvent({ tenantId: booking.tenantId, providerEventId, slot }, { signal }), { attempts: 1, baseDelayMs: 0, maxDelayMs: 0, timeoutMs: 1_200 });
    } catch {
      verified = false;
    }
    const now = this.clock.now().toISOString();
    const result: BookingRecord = {
      ...booking,
      status: verified ? "confirmed" : "unknown",
      providerEventId,
      writeVerifiedAt: verified ? now : null,
      verificationFailures: verified ? [] : ["system_write_not_verified"],
      failureReason: verified ? null : "Calendar event exists but could not be read back; owner confirmation required",
      updatedAt: now,
    };
    await this.store.saveBooking(result);
    await this.safeAudit(booking.tenantId, booking.callId, started, verified ? "success" : "unknown", { status: result.status, slot, writeVerified: verified, foundEarlierEvent: true }, result.failureReason);
    return result;
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
