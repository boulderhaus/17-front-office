import { randomUUID } from "node:crypto";
import type {
  AvailabilitySlot,
  BookingRecord,
  BusinessConfig,
  CallbackTask,
  CallRecord,
  CallSummaryInput,
  CollectedCallFields,
  EmergencyDecision,
  OutboxNotification,
} from "../domain/models.js";
import { isInServiceArea } from "../domain/config.js";
import { triageEmergency } from "../domain/triage.js";
import type { CalendarPort, Clock, Store } from "../ports.js";
import { BookingCoordinator } from "./booking-coordinator.js";
import { redactError, withRetry } from "./retry.js";

const EMPTY_FIELDS: CollectedCallFields = {
  callerName: null,
  companyName: null,
  callbackNumber: null,
  address: null,
  serviceCategory: null,
  serviceCategoryConfidence: 0,
  problemDescription: "",
  equipmentDetails: null,
  accessNotes: null,
  requestedStart: null,
  explicitSlotConfirmation: false,
  diagnosticFeeAccepted: false,
  humanRequested: false,
  confidence: 0,
};

export class CallService {
  readonly #booking: BookingCoordinator;

  constructor(
    private readonly store: Store,
    private readonly calendar: CalendarPort,
    private readonly clock: Clock,
    private readonly publicBaseUrl: string,
  ) {
    this.#booking = new BookingCoordinator(store, calendar, clock);
  }

  async recordStarted(input: {
    eventId: string;
    tenantId: string;
    providerCallId: string;
    fromNumber: string;
    startedAt: string;
  }): Promise<CallRecord> {
    await this.store.claimWebhook(input.eventId);
    return this.store.withLock(`call:${input.providerCallId}`, async () => {
      const existing = await this.store.getCallByProviderId(input.providerCallId);
      return existing ?? this.createCall(input.tenantId, input.providerCallId, input.fromNumber, input.startedAt);
    });
  }

  async checkAvailability(input: {
    tenantId: string;
    providerCallId: string;
    windowStart: string;
    windowEnd: string;
  }): Promise<{ slots: AvailabilitySlot[]; status: "available" | "pending"; message: string }> {
    const config = await this.store.getConfig(input.tenantId);
    const call = await this.ensureCall(input.tenantId, input.providerCallId, "unknown", this.clock.now().toISOString());
    const started = this.clock.now();
    try {
      const slots = await withRetry(
        () => this.calendar.listAvailableSlots({
          tenantId: input.tenantId,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          durationMinutes: config.defaultServiceDurationMinutes,
          timezone: config.timezone,
        }),
        { attempts: 2, baseDelayMs: 50, maxDelayMs: 100, timeoutMs: 2_500 },
      );
      await this.audit(call, "calendar.availability", started, "success", { count: slots.length }, null);
      return slots.length > 0
        ? { slots, status: "available", message: "Offer one of these exact slots and ask the caller to confirm it." }
        : { slots: [], status: "pending", message: "No confirmed slot is available. Tell the caller the owner will follow up." };
    } catch (error) {
      await this.audit(call, "calendar.availability", started, "failed", {}, redactError(error));
      return { slots: [], status: "pending", message: "The calendar could not be confirmed. Tell the caller the owner will follow up." };
    }
  }

  async triageCall(input: {
    tenantId: string;
    providerCallId: string;
    fromNumber: string;
    callerName?: string;
    problemDescription: string;
    llmScore?: number;
    llmReason?: string;
  }): Promise<{ severity: "routine" | "urgent" | "life_safety"; emergency: boolean; instruction: string }> {
    const config = await this.store.getConfig(input.tenantId);
    const decision = triageEmergency(input.problemDescription, config, input.llmScore, input.llmReason);
    if (decision.emergency) {
      await this.queueHumanHandoff({
        tenantId: input.tenantId,
        providerCallId: input.providerCallId,
        fromNumber: input.fromNumber,
        ...(input.callerName === undefined ? {} : { callerName: input.callerName }),
        problemDescription: input.problemDescription,
        urgent: decision,
      });
    }
    return {
      severity: decision.severity,
      emergency: decision.emergency,
      instruction: decision.immediateInstruction
        ?? (decision.emergency ? "Stop booking and transfer or queue the owner now." : "Continue the normal intake flow."),
    };
  }

  async bookConfirmedSlot(input: {
    tenantId: string;
    providerCallId: string;
    slotStart: string;
    callerName: string;
    callbackNumber: string;
    address: string;
    serviceCategory: string;
    problemDescription: string;
    explicitConfirmation: boolean;
    diagnosticFeeAccepted: boolean;
  }): Promise<{ status: "confirmed" | "pending" | "conflict" | "unknown"; message: string }> {
    const config = await this.store.getConfig(input.tenantId);
    let call = await this.ensureCall(input.tenantId, input.providerCallId, input.callbackNumber, this.clock.now().toISOString());
    call = {
      ...call,
      fromNumber: input.callbackNumber,
      fields: {
        ...call.fields,
        callerName: input.callerName,
        callbackNumber: input.callbackNumber,
        address: input.address,
        serviceCategory: input.serviceCategory,
        serviceCategoryConfidence: 1,
        problemDescription: input.problemDescription,
        requestedStart: input.slotStart,
        explicitSlotConfirmation: input.explicitConfirmation,
        diagnosticFeeAccepted: input.diagnosticFeeAccepted,
      },
      updatedAt: this.clock.now().toISOString(),
    };
    await this.store.saveCall(call);
    const emergency = triageEmergency(input.problemDescription, config);
    if (emergency.emergency) {
      await this.queueHumanHandoff({
        tenantId: input.tenantId,
        providerCallId: input.providerCallId,
        fromNumber: input.callbackNumber,
        callerName: input.callerName,
        problemDescription: input.problemDescription,
        urgent: emergency,
      });
      return { status: "pending", message: "This is an emergency. Do not book it; follow the safety instruction and transfer or queue the owner now." };
    }
    if (!input.explicitConfirmation) return { status: "pending", message: "Do not book until the caller explicitly confirms the offered slot." };
    if (config.requireDiagnosticFeeAcceptance && config.priceSnippets.length === 0) {
      await this.queuePendingBooking(call, input.slotStart, config, "No owner-approved diagnostic fee is configured");
      return { status: "pending", message: "No owner-approved diagnostic fee is configured. Queue owner confirmation instead of booking." };
    }
    if (config.requireDiagnosticFeeAcceptance && !input.diagnosticFeeAccepted) {
      await this.queuePendingBooking(call, input.slotStart, config, "Diagnostic fee was not explicitly accepted");
      return { status: "pending", message: "Do not book until the caller explicitly accepts the owner-approved diagnostic fee." };
    }
    if (!/^\+[1-9]\d{7,14}$/.test(input.callbackNumber)) return { status: "pending", message: "The callback number is not confirmed. Queue owner follow-up instead of booking." };
    if (!isConfiguredServiceCategory(input.serviceCategory, config)) return { status: "pending", message: "The requested service is not an owner-approved category. Queue owner confirmation." };
    if (!isInServiceArea(input.address, config)) return { status: "pending", message: "The address may be outside the service area. Queue owner confirmation." };
    if (config.bookingMode === "confirm") {
      await this.queuePendingBooking(call, input.slotStart, config, "Owner confirmation mode is active");
      await this.ensureCallbackTask(call, config, "Confirm requested appointment", false);
      return { status: "pending", message: "The requested time is saved for owner confirmation. Do not say it is booked." };
    }
    const booking = await this.#booking.book({
      tenantId: input.tenantId,
      callId: call.id,
      providerCallId: input.providerCallId,
      requestedStart: input.slotStart,
      durationMinutes: config.defaultServiceDurationMinutes,
      callerName: input.callerName,
      callbackNumber: input.callbackNumber,
      address: input.address,
      problemDescription: input.problemDescription,
    });
    const message = booking.status === "confirmed"
      ? `The appointment is confirmed for ${booking.requestedStart}.`
      : booking.status === "conflict"
        ? "That time is no longer available. Do not promise it; offer another slot or queue owner follow-up."
        : "The calendar result could not be confirmed. Tell the caller the owner will follow up.";
    return { status: booking.status === "checking" ? "pending" : booking.status, message };
  }

  async queueHumanHandoff(input: {
    tenantId: string;
    providerCallId: string;
    fromNumber: string;
    callerName?: string;
    problemDescription?: string;
    urgent?: EmergencyDecision;
  }): Promise<{ status: "handoff_queued"; transferAvailable: boolean; message: string }> {
    const config = await this.store.getConfig(input.tenantId);
    const existing = await this.ensureCall(input.tenantId, input.providerCallId, input.fromNumber, this.clock.now().toISOString());
    const now = this.clock.now().toISOString();
    const call: CallRecord = {
      ...existing,
      fromNumber: input.fromNumber,
      fields: {
        ...existing.fields,
        callerName: input.callerName ?? existing.fields.callerName,
        callbackNumber: input.fromNumber,
        problemDescription: input.problemDescription ?? existing.fields.problemDescription,
        humanRequested: true,
      },
      outcome: "handoff_queued",
      updatedAt: now,
    };
    await this.store.saveCall(call);
    await this.ensureCallbackTask(call, config, input.urgent ? `Urgent ${input.urgent.severity} call` : "Caller requested a human", true);
    for (const destinationRef of config.ownerNotificationRefs) {
      await this.store.enqueueNotification({
        id: randomUUID(),
        tenantId: call.tenantId,
        callId: call.id,
        channel: "sms",
        destinationRef,
        body: [
          input.urgent?.severity === "life_safety" ? "LIFE-SAFETY CALL" : input.urgent?.emergency ? "URGENT CALL" : "CALLER REQUESTED A HUMAN",
          `${call.fields.callerName ?? "Unknown caller"} · ${input.fromNumber}`,
          `Problem: ${call.fields.problemDescription || "not captured"}`,
          ...(input.urgent?.immediateInstruction ? [`Safety: ${input.urgent.immediateInstruction}`] : []),
          `Review: ${this.publicBaseUrl.replace(/\/$/, "")}/admin/calls/${encodeURIComponent(call.id)}`,
        ].join("\n"),
        priority: "high",
        state: "pending",
        attempts: 0,
        nextAttemptAt: now,
        idempotencyKey: `human-handoff:${call.id}:sms:${destinationRef}`,
        providerReceipt: null,
        lastError: null,
        createdAt: now,
        sentAt: null,
      });
    }
    const transferAvailable = config.ownerTransferNumberRef !== null;
    return {
      status: "handoff_queued",
      transferAvailable,
      message: transferAvailable
        ? "An immediate owner alert was queued. Use the configured provider transfer tool now; if it fails, promise only a callback."
        : "An immediate owner alert was queued. Tell the caller the owner will call back; do not promise an exact time.",
    };
  }

  async finalize(input: CallSummaryInput): Promise<CallRecord> {
    await this.store.claimWebhook(input.webhookEventId);
    const existing = await this.store.getCallByProviderId(input.providerCallId);
    const config = await this.store.getConfig(input.tenantId);
    let call = existing ?? await this.ensureCall(input.tenantId, input.providerCallId, input.fromNumber, input.startedAt);
    const fields = mergeCollectedFields(call.fields, input.fields);
    const emergency = mergeEmergencyDecision(
      call.emergency,
      triageEmergency(fields.problemDescription, config, input.llmEmergencyScore, input.llmEmergencyReason),
    );
    const spamExcluded = call.billingDisposition === "spam_excluded" || input.isSpam === true;
    call = {
      ...call,
      fromNumber: input.fromNumber === "unknown" ? call.fromNumber : input.fromNumber,
      startedAt: earlierIso(call.startedAt, input.startedAt),
      endedAt: call.endedAt ? laterIso(call.endedAt, input.endedAt) : input.endedAt,
      durationSeconds: Math.max(call.durationSeconds ?? 0, input.durationSeconds ?? 0) || null,
      fields,
      emergency,
      transcript: input.transcript?.trim() ? input.transcript : call.transcript,
      recordingUrl: input.recordingUrl ?? call.recordingUrl,
      consentState: input.consentState === "unknown" ? call.consentState : input.consentState,
      billingDisposition: spamExcluded ? "spam_excluded" : "billable",
      qualityFlags: [],
      updatedAt: this.clock.now().toISOString(),
    };
    if (spamExcluded) {
      call = { ...call, outcome: "ignored_spam", qualityFlags: ["spam_excluded"], updatedAt: this.clock.now().toISOString() };
      await this.store.saveCall(call);
      return call;
    }
    await this.store.saveCall(call);
    const customerPhone = call.fields.callbackNumber ?? call.fromNumber;
    if (customerPhone !== "unknown") {
      await this.store.upsertCustomer({
        id: randomUUID(),
        tenantId: call.tenantId,
        phone: customerPhone,
        name: call.fields.callerName,
        address: call.fields.address,
        lastCallId: call.id,
        createdAt: call.createdAt,
        updatedAt: call.updatedAt,
      });
    }

    let booking = await this.store.getBookingForCall(call.id);
    const canAttemptDirectBooking = config.bookingMode === "direct"
      && !emergency.emergency
      && !call.fields.humanRequested
      && Boolean(call.fields.requestedStart)
      && call.fields.explicitSlotConfirmation
      && (!config.requireDiagnosticFeeAcceptance || (config.priceSnippets.length > 0 && call.fields.diagnosticFeeAccepted))
      && Boolean(call.fields.callerName?.trim())
      && /^\+[1-9]\d{7,14}$/.test(call.fields.callbackNumber ?? call.fromNumber)
      && Boolean(call.fields.address?.trim())
      && isInServiceArea(call.fields.address, config)
      && isConfiguredServiceCategory(call.fields.serviceCategory, config)
      && Boolean(call.fields.problemDescription.trim());
    if (!booking && canAttemptDirectBooking) {
      booking = await this.#booking.book({
        tenantId: input.tenantId,
        callId: call.id,
        providerCallId: input.providerCallId,
        requestedStart: call.fields.requestedStart!,
        durationMinutes: config.defaultServiceDurationMinutes,
        callerName: call.fields.callerName ?? "Caller",
        callbackNumber: call.fields.callbackNumber ?? call.fromNumber,
        address: call.fields.address ?? "Address not confirmed",
        problemDescription: call.fields.problemDescription,
      });
    } else if (!booking && call.fields.requestedStart && call.fields.explicitSlotConfirmation && !emergency.emergency) {
      booking = await this.queuePendingBooking(call, call.fields.requestedStart, config,
        config.bookingMode === "confirm" ? "Owner confirmation mode is active" : "Booking requirements were incomplete");
    }

    let confirmationQueued = false;
    if (booking?.status === "confirmed") {
      const confirmation = await this.enqueueCustomerConfirmation(call, booking, config);
      confirmationQueued = confirmation !== null;
      if (confirmation && booking.confirmationNotificationId !== confirmation) {
        booking = { ...booking, confirmationNotificationId: confirmation, updatedAt: this.clock.now().toISOString() };
        await this.store.saveBooking(booking);
      }
    }
    const qualityFlags = call.fields.humanRequested || emergency.emergency
      ? this.handoffQualityFlags(call)
      : this.bookingQualityFlags(call, booking, config, confirmationQueued);
    if (booking) {
      booking = { ...booking, verificationFailures: qualityFlags, updatedAt: this.clock.now().toISOString() };
      await this.store.saveBooking(booking);
    }
    const outcome = call.fields.humanRequested || emergency.emergency
      ? "handoff_queued"
      : booking?.status === "confirmed" && qualityFlags.length === 0
        ? "booked"
        : "pending_confirmation";
    call = { ...call, outcome, qualityFlags, updatedAt: this.clock.now().toISOString() };
    await this.store.saveCall(call);
    if (outcome !== "booked") {
      await this.ensureCallbackTask(
        call,
        config,
        emergency.emergency ? `Urgent ${emergency.severity} call` : qualityFlags.length > 0 ? `Resolve: ${qualityFlags.join(", ")}` : "Confirm requested service",
        emergency.emergency || call.fields.humanRequested,
      );
    }
    await this.enqueueOwnerNotifications(call, booking?.requestedStart ?? call.fields.requestedStart, config);
    return call;
  }

  async recoverStaleCalls(tenantId: string, staleAfterMs = 15 * 60_000): Promise<number> {
    const config = await this.store.getConfig(tenantId);
    const cutoff = this.clock.now().getTime() - staleAfterMs;
    const candidates = (await this.store.listCalls(tenantId, 200))
      .filter((call) => call.outcome === "in_progress" && Date.parse(call.startedAt) <= cutoff);
    let recovered = 0;
    for (const candidate of candidates) {
      await this.store.withLock(`call:${candidate.providerCallId}`, async () => {
        const current = await this.store.getCall(candidate.id);
        if (!current || current.outcome !== "in_progress") return;
        const emergency = triageEmergency(current.fields.problemDescription, config);
        const now = this.clock.now().toISOString();
        const call: CallRecord = {
          ...current,
          endedAt: now,
          emergency,
          outcome: "handoff_queued",
          billingDisposition: "not_billable",
          qualityFlags: ["call_ended_without_final_provider_payload"],
          updatedAt: now,
        };
        await this.store.saveCall(call);
        await this.ensureCallbackTask(call, config, "Provider call ended without a final payload", emergency.emergency);
        const callerNumber = call.fields.callbackNumber ?? call.fromNumber;
        if (/^\+[1-9]\d{7,14}$/.test(callerNumber)) {
          await this.store.enqueueNotification({
            id: randomUUID(), tenantId: call.tenantId, callId: call.id, channel: "sms", destinationRef: `tel:${callerNumber}`,
            body: `${config.businessName}: We may have been disconnected. Your request was saved and the owner will follow up. Reply STOP to opt out.`,
            priority: "normal", state: "pending", attempts: 0, nextAttemptAt: now,
            idempotencyKey: `missed-call-text:${call.id}`, providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
          });
        }
        await this.enqueueOwnerNotifications(call, call.fields.requestedStart, config);
        recovered += 1;
      });
    }
    return recovered;
  }

  private async queuePendingBooking(call: CallRecord, requestedStart: string, config: BusinessConfig, reason: string): Promise<BookingRecord> {
    const existing = await this.store.getBookingForCall(call.id);
    if (existing?.status === "confirmed" || existing?.status === "unknown") return existing;
    const start = new Date(requestedStart);
    const end = Number.isNaN(start.getTime()) ? null : new Date(start.getTime() + config.defaultServiceDurationMinutes * 60_000).toISOString();
    const now = this.clock.now().toISOString();
    const booking: BookingRecord = {
      id: existing?.id ?? randomUUID(), tenantId: call.tenantId, callId: call.id,
      requestedStart, requestedEnd: end, status: "pending", providerEventId: null,
      writeVerifiedAt: null, confirmationNotificationId: null,
      verificationFailures: ["system_write_not_verified"], failureReason: reason,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    await this.store.saveBooking(booking);
    return booking;
  }

  private bookingQualityFlags(call: CallRecord, booking: BookingRecord | null, config: BusinessConfig, confirmationQueued: boolean): string[] {
    const flags: string[] = [];
    if (!call.transcript?.trim()) flags.push("transcript_missing");
    if (!call.recordingUrl) flags.push("recording_missing");
    if (!call.fields.callerName?.trim()) flags.push("caller_name_missing");
    if (!/^\+[1-9]\d{7,14}$/.test(call.fields.callbackNumber ?? call.fromNumber)) flags.push("callback_number_invalid");
    if (!call.fields.address?.trim()) flags.push("service_address_missing");
    if (!call.fields.problemDescription.trim()) flags.push("problem_description_missing");
    if (!call.fields.serviceCategory?.trim()) flags.push("service_category_missing");
    if (config.requireDiagnosticFeeAcceptance && !call.fields.diagnosticFeeAccepted) flags.push("diagnostic_fee_not_accepted");
    if (booking?.status !== "confirmed" || !booking.writeVerifiedAt) flags.push("system_write_not_verified");
    if (!confirmationQueued) flags.push("customer_confirmation_not_queued");
    return [...new Set(flags)];
  }

  private handoffQualityFlags(call: CallRecord): string[] {
    const flags: string[] = [];
    if (!call.transcript?.trim()) flags.push("transcript_missing");
    if (!call.recordingUrl) flags.push("recording_missing");
    if (!/^\+[1-9]\d{7,14}$/.test(call.fields.callbackNumber ?? call.fromNumber)) flags.push("callback_number_invalid");
    if (!call.fields.problemDescription.trim()) flags.push("problem_description_missing");
    return flags;
  }

  private async enqueueCustomerConfirmation(call: CallRecord, booking: BookingRecord, config: BusinessConfig): Promise<string | null> {
    const number = call.fields.callbackNumber ?? call.fromNumber;
    if (!/^\+[1-9]\d{7,14}$/.test(number) || !booking.requestedStart || booking.status !== "confirmed") return null;
    const existing = (await this.store.listNotifications(call.id)).find((item) => item.idempotencyKey === `customer-confirmation:${call.id}`);
    if (existing) return existing.id;
    const now = this.clock.now().toISOString();
    const id = randomUUID();
    const queued = await this.store.enqueueNotification({
      id, tenantId: call.tenantId, callId: call.id, channel: "sms", destinationRef: `tel:${number}`,
      body: `${config.businessName}: Your service visit is confirmed for ${booking.requestedStart}. Reply to this message or call the business if anything changes. Reply STOP to opt out.`,
      priority: "normal", state: "pending", attempts: 0, nextAttemptAt: now,
      idempotencyKey: `customer-confirmation:${call.id}`, providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
    });
    return queued ? id : null;
  }

  private async ensureCallbackTask(call: CallRecord, config: BusinessConfig, reason: string, highPriority: boolean): Promise<CallbackTask | null> {
    const ownerRef = config.ownerNotificationRefs[0];
    if (!ownerRef) return null;
    const existing = await this.store.getCallbackTaskForCall(call.id);
    if (existing?.status === "completed") return existing;
    const now = this.clock.now();
    const proposedDue = new Date(now.getTime() + (highPriority ? 5 : 30) * 60_000).toISOString();
    const dueAt = existing && Date.parse(existing.dueAt) < Date.parse(proposedDue) ? existing.dueAt : proposedDue;
    const task: CallbackTask = {
      id: existing?.id ?? randomUUID(), tenantId: call.tenantId, callId: call.id, ownerRef,
      reason, priority: highPriority || existing?.priority === "high" ? "high" : "normal", status: "open",
      dueAt,
      createdAt: existing?.createdAt ?? now.toISOString(), updatedAt: now.toISOString(),
    };
    await this.store.saveCallbackTask(task);
    return task;
  }

  private async enqueueOwnerNotifications(call: CallRecord, proposedTime: string | null, config: BusinessConfig): Promise<void> {
    if (call.billingDisposition === "spam_excluded") return;
    const now = this.clock.now().toISOString();
    const link = `${this.publicBaseUrl.replace(/\/$/, "")}/admin/calls/${encodeURIComponent(call.id)}`;
    const summary = call.fields.problemDescription.trim() || "Problem details were not captured; review the call.";
    const lines = [
      call.emergency?.emergency ? "URGENT CALL" : "New call",
      `${call.fields.callerName ?? "Unknown caller"} · ${call.fields.callbackNumber ?? call.fromNumber}`,
      `Address: ${call.fields.address ?? "not confirmed"}`,
      `Problem: ${summary}`,
      `Emergency: ${call.emergency?.severity ?? "unknown"}`,
      `Outcome: ${call.outcome}${proposedTime ? ` · ${proposedTime}` : ""}`,
      ...(call.qualityFlags.length > 0 ? [`Needs attention: ${call.qualityFlags.join(", ")}`] : []),
      `Review: ${link}`,
    ];
    for (const destinationRef of config.ownerNotificationRefs) {
      const notification: OutboxNotification = {
        id: randomUUID(),
        tenantId: call.tenantId,
        callId: call.id,
        channel: "sms",
        destinationRef,
        body: lines.join("\n"),
        priority: call.emergency?.emergency ? "high" : "normal",
        state: "pending",
        attempts: 0,
        nextAttemptAt: now,
        idempotencyKey: `call-summary:${call.id}:sms:${destinationRef}`,
        providerReceipt: null,
        lastError: null,
        createdAt: now,
        sentAt: null,
      };
      await this.store.enqueueNotification(notification);
    }
  }

  private async ensureCall(tenantId: string, providerCallId: string, fromNumber: string, startedAt: string): Promise<CallRecord> {
    return this.store.withLock(`call:${providerCallId}`, async () => {
      const existing = await this.store.getCallByProviderId(providerCallId);
      return existing ?? this.createCall(tenantId, providerCallId, fromNumber, startedAt);
    });
  }

  private async createCall(tenantId: string, providerCallId: string, fromNumber: string, startedAt: string): Promise<CallRecord> {
    const now = this.clock.now().toISOString();
    const call: CallRecord = {
      id: randomUUID(),
      tenantId,
      providerCallId,
      fromNumber,
      startedAt,
      endedAt: null,
      durationSeconds: null,
      fields: structuredClone(EMPTY_FIELDS),
      emergency: null,
      outcome: "in_progress",
      transcript: null,
      recordingUrl: null,
      consentState: "unknown",
      billingDisposition: "not_billable",
      qualityFlags: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveCall(call);
    return call;
  }

  private async audit(
    call: CallRecord,
    tool: string,
    started: Date,
    result: "success" | "failed" | "unknown",
    metadata: Record<string, unknown>,
    error: string | null,
  ): Promise<void> {
    const completed = this.clock.now();
    await this.store.addToolEvent({
      id: randomUUID(),
      tenantId: call.tenantId,
      callId: call.id,
      tool,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      latencyMs: Math.max(0, completed.getTime() - started.getTime()),
      result,
      metadata,
      redactedError: error,
    });
  }
}

function isConfiguredServiceCategory(value: string | null, config: BusinessConfig): boolean {
  if (!value?.trim()) return false;
  const normalized = value.trim().toLowerCase();
  return config.serviceCategories.some((category) => category.trim().toLowerCase() === normalized);
}

function mergeCollectedFields(existing: CollectedCallFields, incoming: CollectedCallFields): CollectedCallFields {
  const text = (next: string | null, previous: string | null): string | null => next?.trim() ? next : previous;
  return {
    callerName: text(incoming.callerName, existing.callerName),
    companyName: text(incoming.companyName, existing.companyName),
    callbackNumber: text(incoming.callbackNumber, existing.callbackNumber),
    address: text(incoming.address, existing.address),
    serviceCategory: text(incoming.serviceCategory, existing.serviceCategory),
    serviceCategoryConfidence: Math.max(existing.serviceCategoryConfidence, incoming.serviceCategoryConfidence),
    problemDescription: incoming.problemDescription.trim() || existing.problemDescription,
    equipmentDetails: text(incoming.equipmentDetails, existing.equipmentDetails),
    accessNotes: text(incoming.accessNotes, existing.accessNotes),
    requestedStart: text(incoming.requestedStart, existing.requestedStart),
    explicitSlotConfirmation: existing.explicitSlotConfirmation || incoming.explicitSlotConfirmation,
    diagnosticFeeAccepted: existing.diagnosticFeeAccepted || incoming.diagnosticFeeAccepted,
    humanRequested: existing.humanRequested || incoming.humanRequested,
    confidence: Math.max(existing.confidence, incoming.confidence),
  };
}

function earlierIso(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function mergeEmergencyDecision(existing: EmergencyDecision | null, incoming: EmergencyDecision): EmergencyDecision {
  if (!existing) return incoming;
  const rank = { routine: 0, urgent: 1, life_safety: 2 } as const;
  const strongest = rank[incoming.severity] >= rank[existing.severity] ? incoming : existing;
  return {
    ...strongest,
    emergency: existing.emergency || incoming.emergency,
    score: Math.max(existing.score, incoming.score),
    evidence: [...new Set([...existing.evidence, ...incoming.evidence])],
    immediateInstruction: incoming.immediateInstruction ?? existing.immediateInstruction,
  };
}
