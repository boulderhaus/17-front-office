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
import { evaluateServiceArea, isInServiceArea, slotWithinBookableHours } from "../domain/config.js";
import { slotTouchesDayOff } from "../domain/days-off.js";
import { triageEmergency } from "../domain/triage.js";
import { askedQuestions, callSteps, feeGate, mergeExtraAnswers, normalizeCustomQuestions, pairExtraAnswers } from "../domain/call-steps.js";
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

/**
 * The last resort: the call was closed with nothing from the provider (no transcript), and the owner and caller
 * were told so. Anything that arrives later only repairs the record; nobody is alerted or texted twice.
 */
export const BLIND_CLOSURE_FLAG = "call_ended_without_final_provider_payload";
/** The end-of-call callback never arrived, so the record was built from the provider's own conversation history. */
export const PROVIDER_HISTORY_FLAG = "finalized_from_provider_history";
/**
 * Kept on a call that was closed blind and later repaired: the owner already got the dropped-call alert and the
 * caller the disconnect text, so a callback that lands after the repair still only repairs the record.
 */
export const REPAIRED_BLIND_FLAG = "closed_blind_then_repaired";
/** A slot offered at the edge of the notice period stays bookable for the rest of the call (calls end by 7 minutes). */
const OFFER_GRACE_MINUTES = 10;
/** Per try; see checkAvailability. */
export const AVAILABILITY_TRY_TIMEOUT_MS = 1_700;
/** No calendar connected, or it failed: take the details, never a time. */
export const CALENDAR_UNAVAILABLE_MESSAGE = "No calendar time can be offered. Never suggest a time. Ask what day and time suits them, put it in save_intake access_notes (\"Prefers: ...\"), and say the owner will confirm it.";
export const NO_SLOTS_MESSAGE = "Nothing open then. If you have not yet, call check_availability once more with a window from the next day to a week out, and offer those. If still none, never suggest a time: ask what day and time suits them, put it in save_intake access_notes (\"Prefers: ...\"), and say the owner will confirm it.";

/** check_availability or book_slot for a shop that switched "Offer open times" off ("What Otto does on a call"). */
export const TIMES_OFF_MESSAGE = "This shop does not book over the phone. Never offer, suggest or confirm a time. Put when they'd like it in save_intake access_notes (\"Prefers: ...\") and say the owner will call back to set it up.";
/** Why a picked time waits for the owner when the fee question is on and "Give your prices" is off. */
const FEE_NOT_READ_REASON = "The service-call fee was not read on the call (prices are off); confirm the time and the fee with the caller";
/** The calendar event's place for a shop that takes no address: left empty, never a made-up one. */
const NO_ADDRESS_PLACE = "";

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

/** save_intake's answer when the server's own triage finds an emergency (the owner alert is already queued). */
export const INTAKE_EMERGENCY_INSTRUCTION = "This is an emergency and the owner has been alerted. Stop booking. Tell the caller the owner will call back as soon as possible; never promise a time.";

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
    /** save_intake's extra_answer_1..3, by position: paired here with the questions this call started with. */
    extraAnswerSlots?: ReadonlyArray<string | null | undefined> | undefined;
    recordingDisclosureDeclined?: boolean;
    signal?: AbortSignal | undefined;
  }): Promise<{ status: "saved"; missing: string[]; wrap_up: boolean; emergency?: true; instruction?: string }> {
    input.signal?.throwIfAborted();
    await this.ensureCall(input.tenantId, input.providerCallId, input.fromNumber, this.clock.now().toISOString());
    const key = toolResultKey("save_intake", input.providerCallId, { fields: input.fields, declined: input.recordingDisclosureDeclined ?? null, ...(input.extraAnswerSlots ? { extraAnswerSlots: input.extraAnswerSlots.map((slot) => slot ?? null) } : {}) });
    return this.store.withLock(`call:${input.providerCallId}`, async () => {
      const prior = await this.claimToolWrite<{ status: "saved"; missing: string[]; emergency?: true; instruction?: string }>(input.providerCallId, key, input.signal);
      if (prior) {
        const call = await this.store.getCallByProviderId(input.providerCallId);
        return { ...prior.result, wrap_up: call ? this.wrapUpFor(call) : false };
      }
      let result: { status: "saved"; missing: string[]; wrap_up: boolean; emergency?: true; instruction?: string };
      try {
        result = await this.saveIntakeClaimed(input);
      } catch (error) {
        await this.store.releaseToolResult(input.providerCallId, key).catch(() => undefined);
        throw error;
      }
      // A retry after a lost answer replays the emergency fields too: the caller must still hear the safety words.
      await this.store.completeToolResult(input.providerCallId, key, { status: result.status, missing: result.missing, ...(result.emergency ? { emergency: result.emergency, instruction: result.instruction } : {}) }, this.clock.now().toISOString());
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

  /** A price or policy question the assistant looked up: a checkpoint on the call's path, nothing more. */
  async recordAnswerLookup(input: { tenantId: string; providerCallId: string; kind: "price" | "answer"; approved: boolean }): Promise<void> {
    const call = await this.store.getCallByProviderId(input.providerCallId).catch(() => null);
    if (!call || call.tenantId !== input.tenantId) return;
    await this.checkpoint(call, "answer.lookup", this.clock.now(), { kind: input.kind, approved: input.approved });
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

  private async saveIntakeClaimed(input: Parameters<CallService["saveIntake"]>[0]): Promise<{ status: "saved"; missing: string[]; wrap_up: boolean; emergency?: true; instruction?: string }> {
    const existing = await this.store.getCallByProviderId(input.providerCallId);
    if (!existing || existing.tenantId !== input.tenantId) throw new Error("Call no longer exists in this shop");
    const config = await this.store.getConfig(input.tenantId);
    const incoming = completePartialFields(input.fields);
    incoming.callbackNumber = normalizeCustomerNumber(incoming.callbackNumber);
    // The shop's own questions: answers by position, paired with the list this call started with (never the list
    // as the owner has since edited it).
    const asked = askedQuestions(existing.fields, config);
    const slotAnswers = input.extraAnswerSlots ? pairExtraAnswers(asked, input.extraAnswerSlots) : [];
    if (slotAnswers.length > 0) incoming.extraAnswers = mergeExtraAnswers(incoming.extraAnswers, slotAnswers);
    const fields = mergeCollectedFields(existing.fields, incoming);
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
    // The deterministic triage above runs on every intake, whether or not the model called triage_call first (a
    // speech-to-speech line skips it now and then). The first time it sees a problem, that is this call's triage step.
    if (fields.problemDescription.trim() && !(await this.store.listToolEvents(call.id).catch(() => [])).some((event) => event.tool === "call.triage")) {
      await this.checkpoint(call, "call.triage", this.clock.now(), { severity: emergency.severity, emergency: emergency.emergency, source: "intake" });
    }
    // Which checkpoints this intake covers, after any alert. Booleans only: the values live on the call record.
    await this.checkpoint(call, "call.intake", this.clock.now(), {
      problem: fields.problemDescription.trim().length > 0,
      name: Boolean(fields.callerName?.trim()),
      callback: /^\+[1-9]\d{7,14}$/.test(fields.callbackNumber ?? call.fromNumber),
      address: Boolean(fields.address?.trim()),
    });
    // "What Otto does on a call": a shop that takes no address is never told one is missing on a routine call (in an
    // emergency it is, so the owner's alert says where to go), and the shop's own questions ("Ask every caller")
    // count as missing until answered (never in an emergency).
    const steps = callSteps(config);
    const answered = new Set((fields.extraAnswers ?? []).map((item) => item.question));
    const missing = [
      !fields.callerName?.trim() ? "caller_name" : null,
      !/^\+[1-9]\d{7,14}$/.test(fields.callbackNumber ?? call.fromNumber) ? "callback_number" : null,
      (steps.askAddress || emergency.emergency) && !fields.address?.trim() ? "service_address" : null,
      !fields.problemDescription.trim() ? "problem_description" : null,
      !fields.serviceCategory?.trim() ? "service_category" : null,
      ...(emergency.emergency ? [] : asked.map((question, index) => (answered.has(question) ? null : `extra_answer_${index + 1}`))),
    ].filter((value): value is string => value !== null);
    // The model has no clock; the soft five-minute limit rides on tool results.
    return {
      status: "saved",
      missing,
      wrap_up: this.wrapUpFor((await this.store.getCallByProviderId(input.providerCallId)) ?? call),
      // An emergency the server found on its own: the model is told, so what it says matches what the owner got.
      ...(emergency.emergency ? { emergency: true as const, instruction: `${emergency.immediateInstruction ? `${emergency.immediateInstruction} ` : ""}${INTAKE_EMERGENCY_INSTRUCTION}` } : {}),
    };
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
    if (!callSteps(config).offerTimes) return { slots: [], status: "pending", message: TIMES_OFF_MESSAGE, spokenSummary: null, timezone: config.timezone };
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
          daysOff: config.daysOff,
        }, { signal }).then((found) => found.filter((slot) => !slotTouchesDayOff(new Date(slot.start), new Date(slot.end), config.timezone, config.daysOff))),
        // Both tries plus the backoff (2 x 1.7 s + 0.1 s) end before the 4 s tool deadline, so a slow calendar
        // still gets the take-a-message answer below instead of the deadline's wrap-up result.
        { attempts: 2, baseDelayMs: 50, maxDelayMs: 100, timeoutMs: AVAILABILITY_TRY_TIMEOUT_MS, shouldRetry: () => !signal?.aborted },
      );
      // Slots offered after the deadline were never heard by the caller: book_slot must not accept them.
      signal?.throwIfAborted();
      const spokenSummary = slots.length > 0 ? formatSpokenSlots(slots, config.timezone, this.clock.now()) : null;
      await this.audit(call, "calendar.availability", started, "success", { count: slots.length, offeredStarts: slots.map((slot) => slot.start) }, null);
      return slots.length > 0
        ? { slots, status: "available", message: "Read spokenSummary exactly once, then ask the caller to choose one of these exact slots.", spokenSummary, timezone: config.timezone }
        : { slots: [], status: "pending", message: NO_SLOTS_MESSAGE, spokenSummary: null, timezone: config.timezone };
    } catch (error) {
      signal?.throwIfAborted();
      await this.audit(call, "calendar.availability", started, "failed", {}, redactError(error));
      return { slots: [], status: "pending", message: CALENDAR_UNAVAILABLE_MESSAGE, spokenSummary: null, timezone: config.timezone };
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
    const started = this.clock.now();
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
    const triaged = await this.store.getCallByProviderId(input.providerCallId).catch(() => null);
    if (triaged?.tenantId === input.tenantId) await this.checkpoint(triaged, "call.triage", started, { severity: decision.severity, emergency: decision.emergency });
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
    /** Absent only for a shop that takes no address ("What Otto does on a call"). */
    address?: string | undefined;
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
    const steps = callSteps(config);
    // The shop switched booking off: nothing is saved as a requested time and nothing reaches the calendar.
    if (!steps.offerTimes) return { status: "pending", message: TIMES_OFF_MESSAGE };
    const address = input.address?.trim() ? input.address : null;
    // Already booked on this call (the model asking again, maybe for another time): one short, final line.
    const booked = await this.store.getBookingForCall(call.id);
    if (booked?.status === "confirmed" && booked.requestedStart) {
      return { status: "confirmed", message: `Already booked for ${formatLocalDateTime(booked.requestedStart, config.timezone)}. Do not book again.` };
    }
    input.signal?.throwIfAborted();
    call = {
      ...call,
      fields: {
        ...call.fields,
        callerName: input.callerName,
        callbackNumber: isAllowedCustomerNumber(input.callbackNumber) ? input.callbackNumber : call.fields.callbackNumber,
        address: address ?? call.fields.address,
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
    if (steps.askAddress && !address) return { status: "pending", message: "The service address is missing. Ask for it, then book again." };
    if (steps.checkServiceArea && !isInServiceArea(address, config)) return { status: "pending", message: "The address may be outside the service area. Queue owner confirmation." };
    const slotStart = Date.parse(input.slotStart);
    if (!Number.isFinite(slotStart) || slotStart < this.clock.now().getTime()) {
      return { status: "pending", message: "That time is invalid or in the past. Do not save or promise it; check current availability again." };
    }
    // Belt and braces on top of "offered on this call": the slot must still be inside the shop's hours and,
    // allowing for the few minutes the call has run since the offer, its notice period.
    const slotEnd = new Date(slotStart + config.defaultServiceDurationMinutes * 60_000);
    const noticeFloor = this.clock.now().getTime() + (config.minimumLeadTimeMinutes - OFFER_GRACE_MINUTES) * 60_000;
    // Team shops offer each teammate's own hours, so any enabled teammate's hours count.
    const hoursToCheck = [config.bookableHours, ...(config.schedulingCalendars ?? []).filter((member) => member.enabled).map((member) => member.hours)];
    // A day off is closed for everyone, like a time outside the hours.
    if (!hoursToCheck.some((hours) => slotWithinBookableHours(new Date(slotStart), slotEnd, config.timezone, hours)) || slotStart < noticeFloor
      || slotTouchesDayOff(new Date(slotStart), slotEnd, config.timezone, config.daysOff)) {
      return { status: "pending", message: "That time is outside the shop's hours or notice. Do not promise it; offer a returned slot or take a message." };
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
    // The owner's fee question is never skipped. With "Give your prices" off Otto can't read the fee, so nothing is
    // booked on the call: the time waits for the owner's OK, as it does for a shop with no fee saved.
    const gate = feeGate(config);
    if (gate === "owner") {
      await this.queuePendingBooking(call, input.slotStart, config, FEE_NOT_READ_REASON);
      return { status: "pending", message: "The requested time is saved for the owner to confirm. Do not say it is booked and never state a fee: say the owner will confirm the time." };
    }
    const feeRequired = gate === "ask";
    if (feeRequired && config.priceSnippets.length === 0) {
      await this.queuePendingBooking(call, input.slotStart, config, "No owner-approved diagnostic fee is configured");
      return { status: "pending", message: "No owner-approved diagnostic fee is configured. Queue owner confirmation instead of booking." };
    }
    if (feeRequired && !input.diagnosticFeeAccepted) {
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
        address: address ?? NO_ADDRESS_PLACE,
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
    /** Why request_human was called; only labels the call-path checkpoint. */
    reason?: "explicit_request" | "emergency";
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
    await this.checkpoint(call, "call.handoff", this.clock.now(), { reason: input.reason ?? (input.urgent ? "emergency" : "explicit_request") });
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

  /**
   * The end-of-call callback never arrived, so finish the call from the provider's conversation history through
   * the same path the callback takes. Needs no webhook claim: under the call's lock it runs only while the call
   * still needs it, so a callback that landed first (or a second replica) makes this a no-op.
   * - "recover": the call never got an end. Everything happens as if the callback had arrived.
   * - "repair": the call was already closed blind (BLIND_CLOSURE_FLAG). Only the stored record is repaired:
   *   no owner alert, no text to the caller, no calendar write.
   * Returns null when there was nothing to do.
   */
  async finalizeFromProviderHistory(input: CallSummaryInput, options: { mode: "recover" | "repair" }): Promise<CallRecord | null> {
    const call = await this.store.withLock(`call:${input.providerCallId}`, async () => {
      const current = await this.store.getCallByProviderId(input.providerCallId);
      if (!current || current.tenantId !== input.tenantId) return null;
      const needsIt = options.mode === "recover" ? current.endedAt === null : current.qualityFlags.includes(BLIND_CLOSURE_FLAG);
      // A backfill repairs days-old records: it never alerts anyone, not even about an emergency it uncovers.
      return needsIt ? this.finalizeClaimed(input, PROVIDER_HISTORY_FLAG, options.mode === "recover") : null;
    });
    // A repair tells the owner nothing new; the next finalized call checks usage.
    if (call && options.mode === "recover") await this.#usageAlerts.check(call.tenantId);
    return call;
  }

  /**
   * The provider says this call is over, though its final payload has not arrived. One call-path checkpoint, so
   * the owner's screen stops showing the call as live while the record is still being fetched.
   */
  async noteProviderCallEnded(providerCallId: string): Promise<void> {
    await this.store.withLock(`call:${providerCallId}`, async () => {
      const call = await this.store.getCallByProviderId(providerCallId);
      if (!call || call.endedAt !== null) return;
      if ((await this.store.listToolEvents(call.id)).some((event) => event.tool === "call.end")) return;
      await this.checkpoint(call, "call.end", this.clock.now(), {});
    });
  }

  private async finalizeClaimed(input: CallSummaryInput, provenance: string | null = null, alertNewEmergency = true): Promise<CallRecord> {
    if (await this.store.isProviderCallDeleted(input.providerCallId)) throw new Error("Provider call was deleted and cannot be recreated");
    const existing = await this.store.getCallByProviderId(input.providerCallId);
    if (existing && existing.tenantId !== input.tenantId) throw new Error("Provider call belongs to a different tenant");
    const config = await this.store.getConfig(input.tenantId);
    // Already closed blind: the owner was alerted and the caller texted then. This pass only repairs the record.
    const repair = existing?.qualityFlags.some((flag) => flag === BLIND_CLOSURE_FLAG || flag === REPAIRED_BLIND_FLAG) === true;
    // Where the record came from survives a later pass: a late real callback keeps the proof recovery ran.
    const provenanceFlags = [...new Set([
      ...(provenance ? [provenance] : []),
      ...(existing?.qualityFlags.includes(PROVIDER_HISTORY_FLAG) ? [PROVIDER_HISTORY_FLAG] : []),
      ...(repair ? [REPAIRED_BLIND_FLAG] : []),
    ])];
    let call = existing ?? await this.createCall(input.tenantId, input.providerCallId, input.fromNumber, input.startedAt, false);
    // Until the callback task and owner alerts are queued, the stored call keeps its old end and flags: a pass that
    // fails part-way leaves the call unfinished, so recovery (or a backfill) runs it again. Every step is idempotent.
    const priorEndedAt = call.endedAt;
    const priorFlags = call.qualityFlags;
    const saveUnfinished = (record: CallRecord): Promise<void> => this.store.saveCall({ ...record, endedAt: priorEndedAt, qualityFlags: priorFlags });
    // A callback number the model wrote its own way ("941-555-0110", "same number") must never replace the number
    // that called: keep it only when it is a real number, in the one form every screen and text can use.
    const steps = callSteps(config);
    // The shop's own questions: answers the provider's history shows (by position, against the list this call
    // started with) fill in only the questions no mid-call save answered. A saved answer is never replaced.
    const savedAnswers = new Set((call.fields.extraAnswers ?? []).map((item) => item.question));
    const slotAnswers = input.extraAnswerSlots
      ? pairExtraAnswers(askedQuestions(call.fields, config), input.extraAnswerSlots).filter((item) => !savedAnswers.has(item.question))
      : [];
    const fields = mergeCollectedFields(call.fields, {
      ...input.fields,
      callbackNumber: normalizeCustomerNumber(input.fields.callbackNumber),
      ...(slotAnswers.length > 0 || input.fields.extraAnswers ? { extraAnswers: mergeExtraAnswers(slotAnswers, input.fields.extraAnswers) } : {}),
    });
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
      // A shop that switched "End sales calls" off hears about every caller: only a mark made while it was on counts.
      && (call.billingDisposition === "spam_excluded" || (input.isSpam === true && steps.screenSalesCalls));
    call = {
      ...call,
      fromNumber: call.fromNumber === "unknown" && isAllowedCustomerNumber(input.fromNumber) ? input.fromNumber : call.fromNumber,
      startedAt: earlierIso(call.startedAt, input.startedAt),
      // A blind closure stamped the time it gave up, not the time the call ended.
      endedAt: call.endedAt && !repair ? laterIso(call.endedAt, input.endedAt) : input.endedAt,
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
      call = { ...call, outcome: "ignored_spam", qualityFlags: ["spam_excluded", ...provenanceFlags], updatedAt: this.clock.now().toISOString() };
      await this.store.saveCall(call);
      return call;
    }
    await saveUnfinished(call);
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
    const requestedMs = Date.parse(call.fields.requestedStart ?? "");
    const onDayOff = Number.isFinite(requestedMs)
      && slotTouchesDayOff(new Date(requestedMs), new Date(requestedMs + config.defaultServiceDurationMinutes * 60_000), config.timezone, config.daysOff);
    const gate = feeGate(config);
    const canAttemptDirectBooking = config.bookingMode === "direct"
      && steps.offerTimes
      && !emergency.emergency
      && !call.fields.humanRequested
      && Boolean(call.fields.requestedStart)
      && Date.parse(call.fields.requestedStart ?? "") >= this.clock.now().getTime()
      // Set as a day off after the offer (mid-call): the owner confirms instead.
      && !onDayOff
      && latestOffered
      && call.fields.explicitSlotConfirmation
      // The fee question on with prices off ("owner"): never booked from here either; the owner confirms.
      && (gate === "none" || (gate === "ask" && config.priceSnippets.length > 0 && call.fields.diagnosticFeeAccepted))
      && Boolean(call.fields.callerName?.trim())
      && isAllowedCustomerNumber(call.fields.callbackNumber ?? call.fromNumber)
      && (!steps.askAddress || Boolean(call.fields.address?.trim()))
      && (!steps.checkServiceArea || isInServiceArea(call.fields.address, config))
      && isConfiguredServiceCategory(call.fields.serviceCategory, config)
      && Boolean(call.fields.problemDescription.trim());
    if (!booking && canAttemptDirectBooking && !repair) {
      booking = await this.#booking.book({
        tenantId: input.tenantId,
        callId: call.id,
        providerCallId: input.providerCallId,
        requestedStart: call.fields.requestedStart!,
        durationMinutes: config.defaultServiceDurationMinutes,
        callerName: call.fields.callerName ?? "Caller",
        callbackNumber: call.fields.callbackNumber ?? call.fromNumber,
        address: call.fields.address ?? (steps.askAddress ? "Address not confirmed" : NO_ADDRESS_PLACE),
        problemDescription: call.fields.problemDescription,
      });
    } else if (!booking && steps.offerTimes && call.fields.requestedStart && call.fields.explicitSlotConfirmation && !emergency.emergency) {
      booking = await this.queuePendingBooking(call, call.fields.requestedStart, config,
        config.bookingMode === "confirm" ? "Owner confirmation mode is active"
          // A repair never writes to the calendar: the owner confirms the time the caller asked for.
          : repair && canAttemptDirectBooking ? "Recovered after the call; confirm the time with the caller"
            : onDayOff ? "That day is set as a day off; confirm a time with the caller"
            : gate === "owner" ? FEE_NOT_READ_REASON
            : "Booking requirements were incomplete");
    }

    let confirmationQueued = false;
    if (booking?.status === "confirmed" && config.customerSmsEnabled) {
      // A repair never texts the caller: it only counts a confirmation that already went out.
      const confirmation = repair
        ? (await this.store.listNotifications(call.id)).find((item) => item.idempotencyKey === `customer-confirmation:${call.id}`)?.id ?? null
        : await this.enqueueCustomerConfirmation(call, booking, config);
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
    // Where the record came from is kept on the call only: it is not a gap the owner has to resolve.
    call = { ...call, outcome, qualityFlags: [...qualityFlags, ...provenanceFlags], updatedAt: this.clock.now().toISOString() };
    await saveUnfinished(call);
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
    if (!repair) await this.enqueueOwnerNotifications(call, booking?.requestedStart ?? call.fields.requestedStart, config);
    // The blind closure only sent "call dropped". An emergency the transcript now shows still reaches the owner once.
    else if (alertNewEmergency && emergency.emergency && existing?.emergency?.emergency !== true) {
      await this.enqueueOwnerNotifications(call, booking?.requestedStart ?? call.fields.requestedStart, config, "repair-emergency");
    }
    await this.store.saveCall(call);
    return call;
  }

  /**
   * The last resort, for a call the provider has nothing on: 35 minutes with no end-of-call payload and no
   * conversation history to rebuild it from (see CallRecovery, which runs first and keeps the transcript).
   */
  async recoverStaleCalls(tenantId: string, staleAfterMs = 35 * 60_000, lastChance?: (call: CallRecord) => Promise<boolean>): Promise<number> {
    const config = await this.store.getConfig(tenantId);
    const cutoff = this.clock.now().getTime() - staleAfterMs;
    const candidates = (await this.store.listCalls(tenantId, 200))
      .filter((call) => call.outcome === "in_progress" && Date.parse(call.updatedAt) <= cutoff);
    let recovered = 0;
    for (const candidate of candidates) {
      // One more look at the provider's history first: a call it still has is finished properly, never closed blind.
      if (lastChance && await lastChance(candidate).catch(() => false)) continue;
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
          qualityFlags: [BLIND_CLOSURE_FLAG],
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
    // "What Otto does on a call": a step the shop switched off is never a gap in the call.
    const steps = callSteps(config);
    if (steps.askAddress && !call.fields.address?.trim()) flags.push("service_address_missing");
    if (!call.fields.problemDescription.trim()) flags.push("problem_description_missing");
    if (!call.fields.serviceCategory?.trim()) flags.push("service_category_missing");
    // Also while Otto gives no prices and so can't read the fee: the caller never said yes to it, so the owner asks.
    if (steps.offerTimes && feeGate(config) !== "none" && !call.fields.diagnosticFeeAccepted) flags.push("diagnostic_fee_not_accepted");
    if (steps.offerTimes && (booking?.status !== "confirmed" || !booking.writeVerifiedAt)) flags.push("system_write_not_verified");
    if (steps.offerTimes && config.customerSmsEnabled && !confirmationQueued) flags.push("customer_confirmation_not_queued");
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
      extraAnswers: call.fields.extraAnswers,
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
    // "Ask every caller": the questions as they are now stay with the call, so its answers (sent by position) are
    // paired with the questions that were asked even if the owner edits the list before the call is finished. A
    // config that can't be read keeps no list, and the call falls back to the shop's list when an answer arrives.
    const asked = normalizeCustomQuestions((await this.store.getConfig(tenantId).catch(() => null))?.customQuestions);
    const call: CallRecord = {
      id: randomUUID(),
      tenantId,
      providerCallId,
      fromNumber,
      fromNumberVerified,
      startedAt,
      endedAt: null,
      durationSeconds: null,
      fields: { ...structuredClone(EMPTY_FIELDS), ...(asked.length > 0 ? { askedQuestions: asked } : {}) },
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
    // Marks the call as one with a recorded path (older calls have none to show).
    await this.checkpoint(call, "call.start", this.clock.now(), {});
    return call;
  }

  /** A call-path checkpoint. Display only: a failed write must never block a tool reply or an owner alert. */
  private async checkpoint(call: CallRecord, tool: string, started: Date, metadata: Record<string, unknown>): Promise<void> {
    await this.audit(call, tool, started, "success", metadata, null).catch(() => undefined);
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
    // Only once a caller answered one of the shop's own questions; a call without any keeps no such field.
    ...(existing.extraAnswers?.length || incoming.extraAnswers?.length ? { extraAnswers: mergeExtraAnswers(existing.extraAnswers, incoming.extraAnswers) } : {}),
    // The questions the call started with never change once kept.
    ...(existing.askedQuestions ? { askedQuestions: existing.askedQuestions } : {}),
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
    ...(fields.extraAnswers?.length ? { extraAnswers: fields.extraAnswers } : {}),
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

/** A US callback number as +1XXXXXXXXXX however it was written ("941-555-0110", "1 (941) 555-0110"); anything else is null. */
function normalizeCustomerNumber(value: string | null): string | null {
  if (!value?.trim()) return null;
  if (isAllowedCustomerNumber(value)) return value.trim();
  // Words around the digits ("call after 5 at...") make it a note, not a number.
  if (/[a-z]/i.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  const candidate = `+1${digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits}`;
  return isAllowedCustomerNumber(candidate) ? candidate : null;
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

/** Caller lines from a readable transcript ("Caller: …" / "Otto: …", or "AI assistant: …" before the rename), including wrapped continuation lines. */
export function callerSpeech(transcript: string | null): string {
  let speaker: "caller" | "assistant" | null = null;
  const lines: string[] = [];
  for (const line of (transcript ?? "").split("\n")) {
    if (line.startsWith("Caller:")) { speaker = "caller"; lines.push(line.slice("Caller:".length).trim()); continue; }
    if (line.startsWith("Otto:") || line.startsWith("AI assistant:")) { speaker = "assistant"; continue; }
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
