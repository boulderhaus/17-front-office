import { createHash, randomUUID } from "node:crypto";
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
import { evaluateServiceArea, isInServiceArea } from "../domain/config.js";
import { triageEmergency } from "../domain/triage.js";
import { audioRecordingEnabled, WRAP_UP_AFTER_SECONDS } from "../voice/system-prompt.js";
import type { CalendarPort, Clock, Store } from "../ports.js";
import { BookingCoordinator } from "./booking-coordinator.js";
import { redactError, withRetry } from "./retry.js";
import { UsageAlertService } from "./usage-alerts.js";
import { callbackLinkToken, ownerCallSms, shortWhen, urgentReason } from "../domain/owner-sms.js";
import { hasOwnerCallConsent } from "../domain/owner-call-consent.js";
import { ownerCallEmailNotification, ownerCallPushMessage, ownerPushNotification, urgentCallSpeech, urgentOwnerCallNotification } from "./owner-alerts.js";
import { listPushSubscriptions } from "../adapters/web-push.js";

/** Sticky quality flag: a spam mark was refused or undone, so this call always counts and reaches the owner. */
const SPAM_REFUSED = "spam_refused";

type BookSlotResult = { status: "confirmed" | "pending" | "conflict" | "unknown"; message: string };

/** A claimed write whose owner has been quiet this long is presumed dead and may be taken over. */
const TOOL_CLAIM_STALE_MS = 30_000;

/** The same voice-tool write is in progress elsewhere; the HTTP layer answers a plain-English refusal. */
export class ToolWriteInProgressError extends Error {
  constructor() {
    super("The same tool write is already in progress");
  }
}

function appendFlag(flags: string[], flag: string): string[] {
  return flags.includes(flag) ? flags : [...flags, flag];
}

/** Undo a spam mark (emergency or human request surfaced) and make the refusal sticky. */
function withoutSpamMark(call: CallRecord): CallRecord {
  if (call.billingDisposition !== "spam_excluded" && call.outcome !== "ignored_spam") return call;
  return {
    ...call,
    billingDisposition: "not_billable",
    outcome: call.outcome === "ignored_spam" ? "in_progress" : call.outcome,
    qualityFlags: appendFlag(call.qualityFlags.filter((flag) => flag !== "spam_excluded"), SPAM_REFUSED),
  };
}

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
  readonly #usageAlerts: UsageAlertService;
  readonly #callbackLinkKey: string | null;
  readonly #ownerEmailAvailable: boolean;
  readonly #pushAvailable: boolean;
  readonly #urgentCallAvailable: boolean;

  constructor(
    private readonly store: Store,
    private readonly calendar: CalendarPort,
    private readonly clock: Clock,
    private readonly publicBaseUrl: string,
    /** ownerEmailAvailable: email delivery is configured, so owners without text alerts can be emailed. */
    /** pushAvailable: web push (VAPID) is configured, so phones with call alerts on get every lead. */
    /** urgentCallAvailable: urgent and life-safety calls ring the owner's mobile with a spoken summary. */
    options: { ownerEmailAvailable?: boolean; pushAvailable?: boolean; urgentCallAvailable?: boolean; callbackLinkKey?: string | null } = {},
  ) {
    this.#callbackLinkKey = options.callbackLinkKey ?? null;
    this.#ownerEmailAvailable = options.ownerEmailAvailable === true;
    this.#pushAvailable = options.pushAvailable === true;
    this.#urgentCallAvailable = options.urgentCallAvailable === true;
    this.#booking = new BookingCoordinator(store, calendar, clock);
    this.#usageAlerts = new UsageAlertService(store, clock, publicBaseUrl, options.ownerEmailAvailable === true);
  }

  async recordStarted(input: {
    eventId: string;
    tenantId: string;
    providerCallId: string;
    fromNumber: string;
    fromNumberVerified?: boolean;
    startedAt: string;
    /** "disclosed" only when the server itself supplied the greeting that contains the recording notice. */
    consentState?: CallRecord["consentState"];
  }): Promise<CallRecord> {
    const claimed = await this.store.claimWebhook(input.eventId);
    if (!claimed) {
      const duplicate = await this.store.getCallByProviderId(input.providerCallId);
      if (!duplicate) throw new Error("Duplicate start webhook refers to a deleted or unknown call");
      return duplicate;
    }
    return this.store.withLock(`call:${input.providerCallId}`, async () => {
      if (await this.store.isProviderCallDeleted(input.providerCallId)) throw new Error("Provider call was deleted and cannot be recreated");
      const existing = await this.store.getCallByProviderId(input.providerCallId);
      if (existing && existing.tenantId !== input.tenantId) throw new Error("Provider call belongs to a different tenant");
      return existing ?? this.createCall(input.tenantId, input.providerCallId, input.fromNumber, input.startedAt, input.fromNumberVerified === true, input.consentState ?? "unknown");
    });
  }

  /**
   * Idempotent on call + payload: a late or repeated identical save returns the first result and writes
   * nothing. `signal` is the voice tool deadline; nothing is written once it fires.
   */
  async saveIntake(input: {
    tenantId: string;
    providerCallId: string;
    fromNumber: string;
    fields: Partial<CollectedCallFields>;
    recordingDisclosureDeclined?: boolean;
    signal?: AbortSignal | undefined;
  }): Promise<{ status: "saved"; missing: string[]; wrap_up: boolean }> {
    input.signal?.throwIfAborted();
    await this.ensureCall(input.tenantId, input.providerCallId, input.fromNumber, this.clock.now().toISOString());
    const key = toolResultKey("save_intake", input.providerCallId, { fields: input.fields, declined: input.recordingDisclosureDeclined ?? null });
    return this.store.withLock(`call:${input.providerCallId}`, async () => {
      const prior = await this.claimToolWrite<{ status: "saved"; missing: string[] }>(input.providerCallId, key, input.signal);
      if (prior) {
        const call = await this.store.getCallByProviderId(input.providerCallId);
        return { ...prior.result, wrap_up: call ? this.wrapUpFor(call) : false };
      }
      let result: { status: "saved"; missing: string[]; wrap_up: boolean };
      try {
        result = await this.saveIntakeClaimed(input);
      } catch (error) {
        await this.store.releaseToolResult(input.providerCallId, key).catch(() => undefined);
        throw error;
      }
      await this.store.completeToolResult(input.providerCallId, key, { status: result.status, missing: result.missing }, this.clock.now().toISOString());
      return result;
    });
  }

  /**
   * Claim a voice-tool write before its side effect. Returns null when this caller won and must write (then
   * complete or release the claim), or the finished result of the write that already happened. A write still
   * in progress elsewhere gets a short wait, then ToolWriteInProgressError (a plain-English refusal).
   */
  private async claimToolWrite<T>(providerCallId: string, key: string, signal?: AbortSignal): Promise<{ result: T } | null> {
    const now = this.clock.now();
    const claim = await this.store.claimToolResult(providerCallId, key, now.toISOString(), new Date(now.getTime() - TOOL_CLAIM_STALE_MS).toISOString());
    if (claim.status === "claimed") return null;
    if (claim.status === "done") return { result: claim.result as T };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      signal?.throwIfAborted();
      const current = await this.store.getToolResult(providerCallId, key);
      if (current?.status === "done") return { result: current.result as T };
    }
    throw new ToolWriteInProgressError();
  }

  /**
   * The assistant decided this is a vendor, solicitor, recruiter, robocall or wrong number.
   * Marked calls are spam_excluded (never billed or counted, no owner alerts). Every guard must pass
   * first; otherwise the call is flagged spam_refused for good (so a hangup in the same turn still
   * counts and reaches the owner) and the assistant is told to keep helping. The tool's own
   * from_number is never trusted: only the caller ID Telnyx gave us at initialization.
   */
  async markSpam(input: {
    tenantId: string;
    providerCallId: string;
    /** Ignored: caller ID comes only from the provider-recorded call. */
    fromNumber: string;
    category: string;
    callerQuote: string;
  }): Promise<{ status: "marked" | "continue"; instruction: string }> {
    const keepGoing = { status: "continue" as const, instruction: "This caller may be a customer. Do not hang up; continue the normal intake." };
    return this.store.withLock(`call:${input.providerCallId}`, async () => {
      const started = this.clock.now();
      const existing = await this.store.getCallByProviderId(input.providerCallId);
      // No provider-recorded call (or another shop's): never mark, never create one from a tool call.
      if (!existing || existing.tenantId !== input.tenantId) return keepGoing;
      const config = await this.store.getConfig(input.tenantId);
      const { fields } = existing;
      const safetyText = [fields.problemDescription, fields.serviceCategory, fields.callerName, fields.callbackNumber, input.callerQuote].filter(Boolean).join("\n");
      const reason = existing.qualityFlags.includes(SPAM_REFUSED) ? "previously_refused"
        : existing.emergency?.emergency || triageEmergency(safetyText, config).emergency ? "emergency"
          : fields.humanRequested ? "human_requested"
            : fields.problemDescription.trim() || fields.serviceCategory?.trim() || fields.callerName?.trim() || fields.callbackNumber?.trim() || fields.address?.trim() ? "lead_details_captured"
              : !isAllowedCustomerNumber(existing.fromNumber) ? "caller_id_unknown"
                : await this.store.getBookingForCall(existing.id) ? "booking_exists"
                  : await this.store.isKnownCustomer(input.tenantId, existing.fromNumber) ? "existing_customer"
                    : null;
      if (reason) {
        const refused: CallRecord = { ...existing, qualityFlags: appendFlag(existing.qualityFlags, SPAM_REFUSED), updatedAt: this.clock.now().toISOString() };
        await this.store.saveCall(refused);
        await this.audit(refused, "call.mark_spam", started, "failed", { category: input.category, refused: reason }, null);
        return keepGoing;
      }
      const call: CallRecord = { ...existing, outcome: "ignored_spam", billingDisposition: "spam_excluded", qualityFlags: appendFlag(existing.qualityFlags, "spam_excluded"), updatedAt: this.clock.now().toISOString() };
      await this.store.saveCall(call);
      await this.audit(call, "call.mark_spam", started, "success", { category: input.category }, null);
      return { status: "marked", instruction: "Say the fixed service-calls-only goodbye and invoke hangup in the same turn." };
    });
  }

  /** True once the call passes the soft five-minute limit, unless an emergency or human handoff is under way. */
  async wrapUp(providerCallId: string): Promise<boolean> {
    const call = await this.store.getCallByProviderId(providerCallId);
    return call ? this.wrapUpFor(call) : false;
  }

  private wrapUpFor(call: CallRecord): boolean {
    if (call.emergency?.emergency || call.fields.humanRequested) return false;
    return this.clock.now().getTime() - Date.parse(call.startedAt) >= WRAP_UP_AFTER_SECONDS * 1000;
  }

  private async saveIntakeClaimed(input: Parameters<CallService["saveIntake"]>[0]): Promise<{ status: "saved"; missing: string[]; wrap_up: boolean }> {
    const existing = await this.store.getCallByProviderId(input.providerCallId);
    if (!existing || existing.tenantId !== input.tenantId) throw new Error("Call no longer exists in this shop");
    const incoming = completePartialFields(input.fields);
    if (incoming.callbackNumber && !isAllowedCustomerNumber(incoming.callbackNumber)) incoming.callbackNumber = null;
    const fields = mergeCollectedFields(existing.fields, incoming);
    const config = await this.store.getConfig(input.tenantId);
    const emergency = mergeEmergencyDecision(existing.emergency, triageEmergency(`${existing.fields.problemDescription}\n${fields.problemDescription}`, config));
    const updated: CallRecord = {
      ...existing,
      fromNumber: existing.fromNumber === "unknown" && isAllowedCustomerNumber(input.fromNumber) ? input.fromNumber : existing.fromNumber,
      fields,
      emergency,
      // The model may report an objection; it cannot assert that consent was given.
      consentState: input.recordingDisclosureDeclined ? "declined" : existing.consentState,
      updatedAt: this.clock.now().toISOString(),
    };
    // An emergency or a request for a person means this was never spam.
    const call = emergency.emergency || fields.humanRequested ? withoutSpamMark(updated) : updated;
    input.signal?.throwIfAborted();
    await this.store.saveCall(call);
    if (emergency.emergency) await this.queueHumanHandoffClaimed({ tenantId: input.tenantId, providerCallId: input.providerCallId, fromNumber: call.fromNumber, problemDescription: fields.problemDescription, urgent: emergency });
    const missing = [
      !fields.callerName?.trim() ? "caller_name" : null,
      !/^\+[1-9]\d{7,14}$/.test(fields.callbackNumber ?? call.fromNumber) ? "callback_number" : null,
      !fields.address?.trim() ? "service_address" : null,
      !fields.problemDescription.trim() ? "problem_description" : null,
      !fields.serviceCategory?.trim() ? "service_category" : null,
    ].filter((value): value is string => value !== null);
    // The model has no clock; the soft five-minute limit rides on tool results.
    return { status: "saved", missing, wrap_up: this.wrapUpFor((await this.store.getCallByProviderId(input.providerCallId)) ?? call) };
  }

  async checkAvailability(input: {
    tenantId: string;
    providerCallId: string;
    windowStart: string;
    windowEnd: string;
    signal?: AbortSignal | undefined;
  }): Promise<{ slots: AvailabilitySlot[]; status: "available" | "pending" | "invalid_window"; message: string; spokenSummary: string | null; timezone: string }> {
    const signal = input.signal;
    signal?.throwIfAborted();
    const config = await this.store.getConfig(input.tenantId);
    const call = await this.ensureCall(input.tenantId, input.providerCallId, "unknown", this.clock.now().toISOString());
    if (call.emergency?.emergency) return { slots: [], status: "pending", message: "Emergency escalation is active. Do not offer appointments; the owner has been alerted.", spokenSummary: null, timezone: config.timezone };
    const windowError = validateAvailabilityWindow(input.windowStart, input.windowEnd, this.clock.now());
    if (windowError) {
      return {
        slots: [],
        status: "invalid_window",
        message: `${windowError} Recalculate the window from the authoritative current date and call check_availability again. Do not offer a time yet.`,
        spokenSummary: null,
        timezone: config.timezone,
      };
    }
    const started = this.clock.now();
    try {
      const slots = await withRetry(
        () => this.calendar.listAvailableSlots({
          tenantId: input.tenantId,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          durationMinutes: config.defaultServiceDurationMinutes,
          timezone: config.timezone,
          bookableHours: config.bookableHours,
          minimumLeadTimeMinutes: config.minimumLeadTimeMinutes,
          now: this.clock.now().toISOString(),
        }, { signal }),
        { attempts: 2, baseDelayMs: 50, maxDelayMs: 100, timeoutMs: 2_500, shouldRetry: () => !signal?.aborted },
      );
      // Slots offered after the deadline were never heard by the caller: book_slot must not accept them.
      signal?.throwIfAborted();
      const spokenSummary = slots.length > 0 ? formatSpokenSlots(slots, config.timezone, this.clock.now()) : null;
      await this.audit(call, "calendar.availability", started, "success", { count: slots.length, offeredStarts: slots.map((slot) => slot.start) }, null);
      return slots.length > 0
        ? { slots, status: "available", message: "Read spokenSummary exactly once, then ask the caller to choose one of these exact slots.", spokenSummary, timezone: config.timezone }
        : { slots: [], status: "pending", message: "No confirmed slot is available. Tell the caller the owner will follow up.", spokenSummary: null, timezone: config.timezone };
    } catch (error) {
      signal?.throwIfAborted();
      await this.audit(call, "calendar.availability", started, "failed", {}, redactError(error));
      return { slots: [], status: "pending", message: "The calendar could not be confirmed. Tell the caller the owner will follow up.", spokenSummary: null, timezone: config.timezone };
    }
  }

  async checkServiceArea(input: {
    tenantId: string;
    providerCallId: string;
    address: string;
  }): Promise<{ status: "covered" | "outside" | "unconfigured" | "incomplete"; message: string }> {
    const config = await this.store.getConfig(input.tenantId);
    const call = await this.ensureCall(input.tenantId, input.providerCallId, "unknown", this.clock.now().toISOString());
    const started = this.clock.now();
    const result = evaluateServiceArea(input.address, config);
    await this.audit(call, "coverage.check", started, "success", { status: result.status, matched: Boolean(result.matchedTerm) }, null);
    const message = result.status === "covered"
      ? "The address is inside the owner-configured service area. Continue intake."
      : result.status === "unconfigured"
        ? "The owner has not configured a service area. Do not promise service or book; queue owner confirmation."
        : result.status === "incomplete"
          ? "The address is incomplete. Ask for the city or ZIP code, then check the service area again."
          : "The address is not inside the owner-configured service area. Do not promise service or book; queue owner confirmation.";
    return { status: result.status, message };
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
    /** The voice tool deadline: nothing is written once it fires, except the truth about a calendar write already sent. */
    signal?: AbortSignal | undefined;
  }): Promise<{ status: "confirmed" | "pending" | "conflict" | "unknown"; message: string }> {
    input.signal?.throwIfAborted();
    await this.ensureCall(input.tenantId, input.providerCallId, input.callbackNumber, this.clock.now().toISOString());
    return this.store.withLock(`call:${input.providerCallId}`, () => this.bookConfirmedSlotClaimed(input));
  }

  /**
   * Idempotent on call + slot once a booking is attempted (calendar write or owner-confirmation queue). The write
   * is claimed in the ledger before its side effect, so only one worker performs it; a late or repeated
   * book_slot for the same slot returns the first result and writes nothing, so it can never double-book.
   * Validation refusals are not stored, so the caller can still confirm and try again.
   */
  private async bookConfirmedSlotClaimed(input: Parameters<CallService["bookConfirmedSlot"]>[0]): Promise<BookSlotResult> {
    const key = toolResultKey("book_slot", input.providerCallId, Number.isFinite(Date.parse(input.slotStart)) ? new Date(input.slotStart).toISOString() : input.slotStart);
    const finished = await this.store.getToolResult(input.providerCallId, key);
    if (finished?.status === "done") return finished.result as BookSlotResult;
    const config = await this.store.getConfig(input.tenantId);
    let call = await this.store.getCallByProviderId(input.providerCallId);
    if (!call || call.tenantId !== input.tenantId) throw new Error("Call no longer exists in this shop");
    input.signal?.throwIfAborted();
    call = {
      ...call,
      fields: {
        ...call.fields,
        callerName: input.callerName,
        callbackNumber: isAllowedCustomerNumber(input.callbackNumber) ? input.callbackNumber : call.fields.callbackNumber,
        address: input.address,
        serviceCategory: input.serviceCategory,
        serviceCategoryConfidence: 1,
        problemDescription: input.problemDescription,
        requestedStart: call.fields.requestedStart,
        explicitSlotConfirmation: false,
        diagnosticFeeAccepted: input.diagnosticFeeAccepted,
      },
      updatedAt: this.clock.now().toISOString(),
    };
    await this.store.saveCall(call);
    const emergency = mergeEmergencyDecision(call.emergency, triageEmergency(input.problemDescription, config));
    if (call.fields.humanRequested || emergency.emergency) {
      if (emergency.emergency) {
        await this.queueHumanHandoffClaimed({
          tenantId: input.tenantId,
          providerCallId: input.providerCallId,
          fromNumber: input.callbackNumber,
          callerName: input.callerName,
          problemDescription: input.problemDescription,
          urgent: emergency,
        });
      }
      return { status: "pending", message: emergency.emergency ? "This is an emergency. Do not book it; follow the safety instruction and transfer or queue the owner now." : "A human callback was requested. Do not book automatically." };
    }
    if (!input.explicitConfirmation) return { status: "pending", message: "Do not book until the caller explicitly confirms the offered slot." };
    if (!isAllowedCustomerNumber(input.callbackNumber)) return { status: "pending", message: "The callback number is not confirmed. Queue owner follow-up instead of booking." };
    if (!isConfiguredServiceCategory(input.serviceCategory, config)) return { status: "pending", message: "The requested service is not an owner-approved category. Queue owner confirmation." };
    if (!isInServiceArea(input.address, config)) return { status: "pending", message: "The address may be outside the service area. Queue owner confirmation." };
    const slotStart = Date.parse(input.slotStart);
    if (!Number.isFinite(slotStart) || slotStart < this.clock.now().getTime()) {
      return { status: "pending", message: "That time is invalid or in the past. Do not save or promise it; check current availability again." };
    }
    const availabilityEvents = (await this.store.listToolEvents(call.id))
      .filter((event) => event.tool === "calendar.availability" && event.result === "success")
      .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
    const offeredStarts = Array.isArray(availabilityEvents[0]?.metadata.offeredStarts)
      ? availabilityEvents[0]!.metadata.offeredStarts.filter((value): value is string => typeof value === "string")
      : [];
    const wasOffered = offeredStarts.some((offered) => Date.parse(offered) === slotStart);
    if (!wasOffered) {
      return { status: "pending", message: "That time was not in the latest verified availability result. Check availability again and offer only returned slots." };
    }
    call = {
      ...call,
      fields: { ...call.fields, requestedStart: input.slotStart, explicitSlotConfirmation: input.explicitConfirmation },
      updatedAt: this.clock.now().toISOString(),
    };
    input.signal?.throwIfAborted();
    await this.store.saveCall(call);
    if (config.requireDiagnosticFeeAcceptance && config.priceSnippets.length === 0) {
      await this.queuePendingBooking(call, input.slotStart, config, "No owner-approved diagnostic fee is configured");
      return { status: "pending", message: "No owner-approved diagnostic fee is configured. Queue owner confirmation instead of booking." };
    }
    if (config.requireDiagnosticFeeAcceptance && !input.diagnosticFeeAccepted) {
      await this.queuePendingBooking(call, input.slotStart, config, "Diagnostic fee was not explicitly accepted");
      return { status: "pending", message: "Do not book until the caller explicitly accepts the owner-approved diagnostic fee." };
    }
    // Only the claim winner performs the write below; everyone else gets its result.
    const prior = await this.claimToolWrite<BookSlotResult>(input.providerCallId, key, input.signal);
    if (prior) return prior.result;
    const complete = async (result: BookSlotResult) => {
      await this.store.completeToolResult(input.providerCallId, key, result, this.clock.now().toISOString());
      return result;
    };
    let booking: BookingRecord;
    try {
      if (config.bookingMode === "confirm") {
        await this.queuePendingBooking(call, input.slotStart, config, "Owner confirmation mode is active");
        await this.ensureCallbackTask(call, config, "Confirm requested appointment", false);
        return await complete({ status: "pending", message: "The requested time is saved for owner confirmation. Do not say it is booked." });
      }
      booking = await this.#booking.book({
        tenantId: input.tenantId,
        callId: call.id,
        providerCallId: input.providerCallId,
        requestedStart: input.slotStart,
        durationMinutes: config.defaultServiceDurationMinutes,
        callerName: input.callerName,
        callbackNumber: input.callbackNumber,
        address: input.address,
        problemDescription: input.problemDescription,
      }, { signal: input.signal });
    } catch (error) {
      // Nothing was written (an abort after dispatch returns an "unknown" booking instead of throwing).
      await this.store.releaseToolResult(input.providerCallId, key).catch(() => undefined);
      throw error;
    }
    const message = booking.status === "confirmed"
      ? `The appointment is confirmed for ${formatLocalDateTime(booking.requestedStart!, config.timezone)}.`
      : booking.status === "conflict"
        ? "That time is no longer available. Do not promise it; offer another slot or queue owner follow-up."
        : "The calendar result could not be confirmed. Tell the caller the owner will follow up.";
    const result: BookSlotResult = { status: booking.status === "checking" ? "pending" : booking.status, message };
    if (booking.status === "pending" || booking.status === "checking") {
      // Nothing reached the calendar, so a retry may try again.
      await this.store.releaseToolResult(input.providerCallId, key).catch(() => undefined);
    } else {
      // A calendar write was attempted: record the outcome even past the deadline, so a write that landed late
      // is reported truthfully next time and never repeated.
      await complete(result);
    }
    if (booking.status === "confirmed" && booking.writeVerifiedAt) {
      await this.completeCallbackTask(call.id, "verified_booking");
    }
    return result;
  }

  async queueHumanHandoff(input: {
    tenantId: string;
    providerCallId: string;
    fromNumber: string;
    callerName?: string;
    problemDescription?: string;
    urgent?: EmergencyDecision;
  }): Promise<{ status: "handoff_queued"; transferAvailable: boolean; message: string }> {
    await this.ensureCall(input.tenantId, input.providerCallId, input.fromNumber, this.clock.now().toISOString());
    return this.store.withLock(`call:${input.providerCallId}`, () => this.queueHumanHandoffClaimed(input));
  }

  private async queueHumanHandoffClaimed(input: Parameters<CallService["queueHumanHandoff"]>[0]): Promise<{ status: "handoff_queued"; transferAvailable: boolean; message: string }> {
    const config = await this.store.getConfig(input.tenantId);
    const ownerPortal = await this.store.getOwnerAccountByTenant(input.tenantId) ? "/app" : "/admin";
    const existing = await this.store.getCallByProviderId(input.providerCallId);
    if (!existing || existing.tenantId !== input.tenantId) throw new Error("Call no longer exists in this shop");
    const now = this.clock.now().toISOString();
    const call: CallRecord = {
      // A person or an emergency was requested: never leave the call excluded as spam.
      ...withoutSpamMark(existing),
      fromNumber: existing.fromNumber === "unknown" && isAllowedCustomerNumber(input.fromNumber) ? input.fromNumber : existing.fromNumber,
      fields: {
        ...existing.fields,
        callerName: input.callerName ?? existing.fields.callerName,
        callbackNumber: isAllowedCustomerNumber(existing.fields.callbackNumber ?? "")
          ? existing.fields.callbackNumber
          : isAllowedCustomerNumber(input.fromNumber) ? input.fromNumber : null,
        problemDescription: input.problemDescription ?? existing.fields.problemDescription,
        humanRequested: true,
      },
      emergency: input.urgent ? mergeEmergencyDecision(existing.emergency, input.urgent) : existing.emergency,
      outcome: "handoff_queued",
      updatedAt: now,
    };
    await this.store.saveCall(call);
    await this.ensureCallbackTask(call, config, input.urgent ? `Urgent ${input.urgent.severity} call` : "Caller requested a human", true);
    const handoffBody = ownerCallSms({
      call,
      urgentReason: urgentReason(call, true),
      wants: this.wantsLine(call.fields.requestedStart, config.timezone),
      link: this.ownerCallLink(call, ownerPortal),
    });
    await this.enqueueOwnerCopies(call, handoffBody, true, `human-handoff:${call.id}`, true);
    for (const destinationRef of config.ownerNotificationRefs) {
      await this.store.enqueueNotification({
        id: randomUUID(),
        tenantId: call.tenantId,
        callId: call.id,
        channel: "sms",
        destinationRef,
        body: handoffBody,
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
    // Provider-native transfer is intentionally disabled until the server can
    // authorize the exact destination and call-control action itself.
    const transferAvailable = false;
    return {
      status: "handoff_queued",
      transferAvailable,
      message: "An immediate owner alert was queued. Tell the caller the owner will call back; do not promise an exact time.",
    };
  }

  async finalize(input: CallSummaryInput): Promise<CallRecord> {
    const claimed = await this.store.claimWebhook(input.webhookEventId);
    if (!claimed) {
      const duplicate = await this.store.getCallByProviderId(input.providerCallId);
      if (!duplicate) throw new Error("Duplicate final webhook refers to a deleted or unknown call");
      return duplicate;
    }
    const call = await this.store.withLock(`call:${input.providerCallId}`, () => this.finalizeClaimed(input));
    // Usage only changes when a call finalizes, so this is where the minutes alert is checked.
    // A missed check (crash between the two) is caught by the next finalized call.
    await this.#usageAlerts.check(call.tenantId);
    return call;
  }

  private async finalizeClaimed(input: CallSummaryInput): Promise<CallRecord> {
    if (await this.store.isProviderCallDeleted(input.providerCallId)) throw new Error("Provider call was deleted and cannot be recreated");
    const existing = await this.store.getCallByProviderId(input.providerCallId);
    if (existing && existing.tenantId !== input.tenantId) throw new Error("Provider call belongs to a different tenant");
    const config = await this.store.getConfig(input.tenantId);
    let call = existing ?? await this.createCall(input.tenantId, input.providerCallId, input.fromNumber, input.startedAt, false);
    const fields = mergeCollectedFields(call.fields, input.fields);
    // Triage what the caller said, never the assistant's own screening questions.
    const rawSafetyText = [fields.problemDescription, callerSpeech(input.transcript ?? call.transcript)].filter(Boolean).join("\n");
    const emergency = mergeEmergencyDecision(
      call.emergency,
      triageEmergency(rawSafetyText, config, input.llmEmergencyScore, input.llmEmergencyReason),
    );
    // An emergency, a request for a person, or a refused spam mark is never dropped as spam, whatever the classifier said.
    const spamExcluded = !emergency.emergency
      && !fields.humanRequested
      && !call.qualityFlags.includes(SPAM_REFUSED)
      && (call.billingDisposition === "spam_excluded" || input.isSpam === true);
    call = {
      ...call,
      fromNumber: call.fromNumber === "unknown" && isAllowedCustomerNumber(input.fromNumber) ? input.fromNumber : call.fromNumber,
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
    if (isAllowedCustomerNumber(customerPhone)) {
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
    const latestOffered = call.fields.requestedStart
      ? await this.wasLatestOffered(call.id, call.fields.requestedStart)
      : false;
    const canAttemptDirectBooking = config.bookingMode === "direct"
      && !emergency.emergency
      && !call.fields.humanRequested
      && Boolean(call.fields.requestedStart)
      && Date.parse(call.fields.requestedStart ?? "") >= this.clock.now().getTime()
      && latestOffered
      && call.fields.explicitSlotConfirmation
      && (!config.requireDiagnosticFeeAcceptance || (config.priceSnippets.length > 0 && call.fields.diagnosticFeeAccepted))
      && Boolean(call.fields.callerName?.trim())
      && isAllowedCustomerNumber(call.fields.callbackNumber ?? call.fromNumber)
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
    if (booking?.status === "confirmed" && config.customerSmsEnabled) {
      const confirmation = await this.enqueueCustomerConfirmation(call, booking, config);
      confirmationQueued = confirmation !== null;
      if (confirmation && booking.confirmationNotificationId !== confirmation) {
        booking = { ...booking, confirmationNotificationId: confirmation, updatedAt: this.clock.now().toISOString() };
        await this.store.saveBooking(booking);
      }
    }
    const qualityFlags = call.fields.humanRequested || emergency.emergency
      ? this.handoffQualityFlags(call, config)
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
    } else {
      await this.completeCallbackTask(call.id, "verified_booking");
    }
    await this.enqueueOwnerNotifications(call, booking?.requestedStart ?? call.fields.requestedStart, config);
    return call;
  }

  async recoverStaleCalls(tenantId: string, staleAfterMs = 35 * 60_000): Promise<number> {
    const config = await this.store.getConfig(tenantId);
    const cutoff = this.clock.now().getTime() - staleAfterMs;
    const candidates = (await this.store.listCalls(tenantId, 200))
      .filter((call) => call.outcome === "in_progress" && Date.parse(call.updatedAt) <= cutoff);
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
        if (config.customerSmsEnabled && isAllowedCustomerNumber(callerNumber)) {
          await this.store.enqueueNotification({
            id: randomUUID(), tenantId: call.tenantId, callId: call.id, channel: "sms", destinationRef: `tel:${callerNumber}`,
            body: `${config.businessName}: We may have been disconnected. Your request was saved and the owner will follow up. Reply STOP to opt out.`,
            priority: "normal", state: "pending", attempts: 0, nextAttemptAt: now,
            idempotencyKey: `missed-call-text:${call.id}`, providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
          });
        }
        await this.enqueueOwnerNotifications(call, call.fields.requestedStart, config, "recovery-summary");
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
    if (!call.recordingUrl && audioRecordingEnabled(config)) flags.push("recording_missing");
    if (!call.fields.callerName?.trim()) flags.push("caller_name_missing");
    if (!isAllowedCustomerNumber(call.fields.callbackNumber ?? call.fromNumber)) flags.push("callback_number_invalid");
    if (!call.fields.address?.trim()) flags.push("service_address_missing");
    if (!call.fields.problemDescription.trim()) flags.push("problem_description_missing");
    if (!call.fields.serviceCategory?.trim()) flags.push("service_category_missing");
    if (config.requireDiagnosticFeeAcceptance && !call.fields.diagnosticFeeAccepted) flags.push("diagnostic_fee_not_accepted");
    if (booking?.status !== "confirmed" || !booking.writeVerifiedAt) flags.push("system_write_not_verified");
    if (config.customerSmsEnabled && !confirmationQueued) flags.push("customer_confirmation_not_queued");
    return [...new Set(flags)];
  }

  private handoffQualityFlags(call: CallRecord, config: BusinessConfig): string[] {
    const flags: string[] = [];
    if (!call.transcript?.trim()) flags.push("transcript_missing");
    if (!call.recordingUrl && audioRecordingEnabled(config)) flags.push("recording_missing");
    if (!isAllowedCustomerNumber(call.fields.callbackNumber ?? call.fromNumber)) flags.push("callback_number_invalid");
    if (!call.fields.problemDescription.trim()) flags.push("problem_description_missing");
    return flags;
  }

  private async enqueueCustomerConfirmation(call: CallRecord, booking: BookingRecord, config: BusinessConfig): Promise<string | null> {
    const number = call.fields.callbackNumber ?? call.fromNumber;
    if (!isAllowedCustomerNumber(number) || !booking.requestedStart || booking.status !== "confirmed") return null;
    const existing = (await this.store.listNotifications(call.id)).find((item) => item.idempotencyKey === `customer-confirmation:${call.id}`);
    if (existing) return existing.id;
    const now = this.clock.now().toISOString();
    const id = randomUUID();
    const queued = await this.store.enqueueNotification({
      id, tenantId: call.tenantId, callId: call.id, channel: "sms", destinationRef: `tel:${number}`,
      body: `${config.businessName}: Your service visit is confirmed for ${formatLocalDateTime(booking.requestedStart, config.timezone)}. Reply to this message or call the business if anything changes. Reply STOP to opt out.`,
      priority: "normal", state: "pending", attempts: 0, nextAttemptAt: now,
      idempotencyKey: `customer-confirmation:${call.id}`, providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
    });
    return queued ? id : null;
  }

  private async ensureCallbackTask(call: CallRecord, config: BusinessConfig, reason: string, highPriority: boolean): Promise<CallbackTask | null> {
    const ownerRef = config.ownerNotificationRefs[0] ?? "shop-owner";
    const existing = await this.store.getCallbackTaskForCall(call.id);
    if (existing?.status === "completed") return existing;
    const now = this.clock.now();
    const proposedDue = new Date(now.getTime() + (highPriority ? 5 : 30) * 60_000).toISOString();
    const dueAt = existing && Date.parse(existing.dueAt) < Date.parse(proposedDue) ? existing.dueAt : proposedDue;
    const task: CallbackTask = {
      id: existing?.id ?? randomUUID(), tenantId: call.tenantId, callId: call.id, ownerRef,
      reason, priority: highPriority || existing?.priority === "high" ? "high" : "normal",
      status: existing?.status === "snoozed" && !highPriority && Date.parse(existing.dueAt) > now.getTime() ? "snoozed" : "open",
      dueAt,
      completedAt: null, completionSource: null,
      createdAt: existing?.createdAt ?? now.toISOString(), updatedAt: now.toISOString(),
    };
    await this.store.saveCallbackTask(task);
    return task;
  }

  private async completeCallbackTask(callId: string, source: "verified_booking"): Promise<void> {
    const existing = await this.store.getCallbackTaskForCall(callId);
    if (!existing || existing.status === "completed" || existing.status === "cancelled") return;
    const now = this.clock.now().toISOString();
    await this.store.saveCallbackTask({
      ...existing,
      status: "completed",
      completedAt: now,
      completionSource: source,
      updatedAt: now,
    });
  }

  private async enqueueOwnerNotifications(
    call: CallRecord,
    proposedTime: string | null,
    config: BusinessConfig,
    keyPrefix = "call-summary",
  ): Promise<void> {
    if (call.billingDisposition === "spam_excluded") return;
    const safetyAlert = call.emergency?.emergency === true
      || call.outcome === "handoff_queued"
      || call.outcome === "failed"
      || keyPrefix === "recovery-summary";
    const now = this.clock.now().toISOString();
    const ownerPortal = await this.store.getOwnerAccountByTenant(call.tenantId) ? "/app" : "/admin";
    const when = proposedTime ?? call.fields.requestedStart;
    const body = ownerCallSms({
      call,
      urgentReason: urgentReason(call, call.outcome === "handoff_queued" || call.fields.humanRequested),
      // A verified booking reads "Booked tomorrow 10a"; anything else says what the caller wants.
      booked: call.outcome === "booked" && when && !Number.isNaN(Date.parse(when)) ? shortWhen(when, this.clock.now(), config.timezone) : null,
      wants: this.wantsLine(when, config.timezone),
      link: this.ownerCallLink(call, ownerPortal),
    });
    // Phones with call alerts on hear about every lead; email and texts follow the instant-alerts switch for routine ones.
    const routineAllowed = safetyAlert || config.ownerRealtimeSmsEnabled;
    await this.enqueueOwnerCopies(call, body, call.emergency?.emergency === true, `${keyPrefix}:${call.id}`, routineAllowed);
    if (!routineAllowed) return;
    for (const destinationRef of config.ownerNotificationRefs) {
      const notification: OutboxNotification = {
        id: randomUUID(),
        tenantId: call.tenantId,
        callId: call.id,
        channel: "sms",
        destinationRef,
        body,
        priority: call.emergency?.emergency ? "high" : "normal",
        state: "pending",
        attempts: 0,
        nextAttemptAt: now,
        idempotencyKey: `${keyPrefix}:${call.id}:sms:${destinationRef}`,
        providerReceipt: null,
        lastError: null,
        createdAt: now,
        sentAt: null,
      };
      await this.store.enqueueNotification(notification);
    }
  }

  /**
   * The owner text's words, by email too: texts can't reach an owner before carrier approval (or one who never
   * opted in), so email is how every lead still reaches them. Only for owner-app shops with email configured.
   */
  private async enqueueOwnerCopies(call: CallRecord, smsBody: string, high: boolean, keyBase: string, emailAllowed: boolean): Promise<void> {
    const now = this.clock.now().toISOString();
    // Urgent or life-safety: ring the owner's mobile too, once per call (the handoff alert and the summary share it).
    if (this.#urgentCallAvailable && call.emergency?.emergency === true
      && await this.store.getOwnerAccountByTenant(call.tenantId)
      // TCPA: automated calls only with the owner's recorded consent for this mobile (signup or Settings; 9 stops it).
      && await hasOwnerCallConsent(this.store, call.tenantId, await this.store.getIntegrationSecret(call.tenantId, "notifications", "owner-primary"))) {
      const config = await this.store.getConfig(call.tenantId);
      const speech = urgentCallSpeech(call, this.wantsLine(call.fields.requestedStart, config.timezone));
      await this.store.enqueueNotification(urgentOwnerCallNotification({ tenantId: call.tenantId, callId: call.id, speech, now }));
    }
    if (this.#pushAvailable && (await listPushSubscriptions(this.store, call.tenantId)).length > 0) {
      await this.store.enqueueNotification(ownerPushNotification({ tenantId: call.tenantId, callId: call.id, message: ownerCallPushMessage(smsBody, call.id, high), keyBase, now }));
    }
    if (!this.#ownerEmailAvailable || !emailAllowed) return;
    const account = await this.store.getOwnerAccountByTenant(call.tenantId);
    if (!account?.email) return;
    await this.store.enqueueNotification(ownerCallEmailNotification({
      tenantId: call.tenantId, callId: call.id, email: account.email, smsBody,
      settingsUrl: `${this.publicBaseUrl.replace(/\/$/, "")}/app/settings`, high, keyBase, now,
    }));
  }

  /**
   * The link in an owner text. For an owner app shop it is a signed /c/ link (no sign-in, this shop only,
   * 7 days) to a page with a big Call button, because the caller's number never goes in the text itself.
   */
  private ownerCallLink(call: Pick<CallRecord, "id" | "tenantId">, ownerPortal: string): string {
    const base = this.publicBaseUrl.replace(/\/$/, "");
    if (this.#callbackLinkKey && ownerPortal === "/app" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(call.id)) {
      return `${base}/c/${callbackLinkToken({ tenantId: call.tenantId, callId: call.id, now: this.clock.now(), key: this.#callbackLinkKey })}`;
    }
    return `${base}${ownerPortal}/calls/${encodeURIComponent(call.id)}`;
  }

  /** "Wants someone today", or the time the caller asked for: "Wants Tue, Nov 24, 9:00 AM". */
  private wantsLine(requested: string | null, timeZone: string): string | null {
    if (!requested || Number.isNaN(Date.parse(requested))) return null;
    const day = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
    if (day(new Date(requested)) === day(this.clock.now())) return "Wants someone today";
    return `Wants ${shortWhen(requested, this.clock.now(), timeZone)}`;
  }

  private async ensureCall(tenantId: string, providerCallId: string, fromNumber: string, startedAt: string): Promise<CallRecord> {
    return this.store.withLock(`call:${providerCallId}`, async () => {
      if (await this.store.isProviderCallDeleted(providerCallId)) throw new Error("Provider call was deleted and cannot be recreated");
      const existing = await this.store.getCallByProviderId(providerCallId);
      if (existing && existing.tenantId !== tenantId) throw new Error("Provider call belongs to a different tenant");
      return existing ?? this.createCall(tenantId, providerCallId, fromNumber, startedAt, false);
    });
  }

  private async createCall(tenantId: string, providerCallId: string, fromNumber: string, startedAt: string, fromNumberVerified: boolean, consentState: CallRecord["consentState"] = "unknown"): Promise<CallRecord> {
    const now = this.clock.now().toISOString();
    const call: CallRecord = {
      id: randomUUID(),
      tenantId,
      providerCallId,
      fromNumber,
      fromNumberVerified,
      startedAt,
      endedAt: null,
      durationSeconds: null,
      fields: structuredClone(EMPTY_FIELDS),
      emergency: null,
      outcome: "in_progress",
      transcript: null,
      recordingUrl: null,
      consentState,
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

  private async wasLatestOffered(callId: string, requestedStart: string): Promise<boolean> {
    const latest = (await this.store.listToolEvents(callId))
      .filter((event) => event.tool === "calendar.availability" && event.result === "success")
      .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))[0];
    const offered = Array.isArray(latest?.metadata.offeredStarts)
      ? latest.metadata.offeredStarts.filter((value): value is string => typeof value === "string")
      : [];
    return offered.some((value) => Date.parse(value) === Date.parse(requestedStart));
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

function completePartialFields(fields: Partial<CollectedCallFields>): CollectedCallFields {
  return {
    callerName: fields.callerName ?? null,
    companyName: fields.companyName ?? null,
    callbackNumber: fields.callbackNumber ?? null,
    address: fields.address ?? null,
    serviceCategory: fields.serviceCategory ?? null,
    serviceCategoryConfidence: fields.serviceCategoryConfidence ?? 0,
    problemDescription: fields.problemDescription ?? "",
    equipmentDetails: fields.equipmentDetails ?? null,
    accessNotes: fields.accessNotes ?? null,
    requestedStart: fields.requestedStart ?? null,
    explicitSlotConfirmation: fields.explicitSlotConfirmation ?? false,
    diagnosticFeeAccepted: fields.diagnosticFeeAccepted ?? false,
    humanRequested: fields.humanRequested ?? false,
    confidence: fields.confidence ?? 0,
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

function validateAvailabilityWindow(windowStart: string, windowEnd: string, now: Date): string | null {
  const start = Date.parse(windowStart);
  const end = Date.parse(windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "The availability window is invalid.";
  if (start < now.getTime()) return "The availability window starts in the past.";
  if (end - start > 14 * 24 * 60 * 60_000) return "The availability window is longer than 14 days.";
  if (start > now.getTime() + 90 * 24 * 60 * 60_000) return "The availability window starts more than 90 days from now.";
  return null;
}

function isAllowedCustomerNumber(value: string): boolean {
  const match = /^\+1([2-9]\d{2})([2-9]\d{6})$/.exec(value.trim());
  return Boolean(match && match[1] !== "900");
}

function formatLocalDateTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function formatSpokenSlots(slots: AvailabilitySlot[], timeZone: string, now: Date): string {
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const date = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" });
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const groups = new Map<string, { label: string; times: string[]; zone: string }>();
  const today = dateKey.format(now);
  for (const slot of slots) {
    const value = new Date(slot.start);
    const key = dateKey.format(value);
    const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(value)
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
    const group = groups.get(key) ?? { label: key === today ? `Today, ${date.format(value)}` : date.format(value), times: [], zone };
    group.times.push(time.format(value));
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => `${group.label}: ${new Intl.ListFormat("en-US", { style: "long", type: "disjunction" }).format(group.times)} ${group.zone}`)
    .join("; ");
}

/** Caller lines from a readable transcript ("Caller: …" / "AI assistant: …"), including wrapped continuation lines. */
export function callerSpeech(transcript: string | null): string {
  let speaker: "caller" | "assistant" | null = null;
  const lines: string[] = [];
  for (const line of (transcript ?? "").split("\n")) {
    if (line.startsWith("Caller:")) { speaker = "caller"; lines.push(line.slice("Caller:".length).trim()); continue; }
    if (line.startsWith("AI assistant:")) { speaker = "assistant"; continue; }
    if (speaker === "caller") lines.push(line.trim());
  }
  return lines.filter(Boolean).join("\n");
}

/** Idempotency key for a voice-tool write: tool + provider call + a hash of what makes the write unique. */
export function toolResultKey(tool: string, providerCallId: string, payload: unknown): string {
  return `${tool}:${providerCallId}:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
