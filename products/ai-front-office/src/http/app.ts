import { randomBytes, randomUUID } from "node:crypto";
import { continueOwnerAlertCall, ownerAlertState, urgentOwnerCallsConfigured } from "../adapters/telnyx-owner-call.js";
import { grantOwnerCallConsent, hasOwnerCallConsent, OWNER_CALL_CONSENT_SETTINGS_DETAIL, OWNER_CALL_CONSENT_SETTINGS_VERSION, revokeOwnerCallConsent } from "../domain/owner-call-consent.js";
import { deviceId, listPushSubscriptions, parsePushSubscription, removePushSubscriptions, savePushSubscription } from "../adapters/web-push.js";
import { lineLiveNotifications, ownerPushNotification } from "../application/owner-alerts.js";
import { SERVICE_WORKER, WEB_MANIFEST } from "./pwa.js";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { z } from "zod";
import { renderAdminResetLink, renderCallbackLink, renderForgotPassword, renderResetPassword, renderCallDetail, renderConfig, renderDashboard, renderLanding, renderLogin, renderOwnerAccounts, renderOwnerDashboard, renderOwnerLogin, renderOwnerSignup, renderPilotSignups, renderPrivacy, renderPrompt, renderReadiness, renderSimulator, renderStart, renderStartReceived, renderTerms, PASSWORD_MIN_LENGTH, SIGNUP_EMAIL_TAKEN, type SignupFieldErrors } from "../admin/render.js";
import { buildActivationReport, shopActivationBlockers, type ActivationReport } from "../application/readiness.js";
import { runAllSimulations, runSimulation, SIMULATION_SCENARIOS, type SimulationScenarioId } from "../application/simulator.js";
import { CallService, ToolWriteInProgressError } from "../application/call-service.js";
import { approvedTransferTargets } from "../application/transfer-policy.js";
import { joinTeam, teamApi } from "./team-routes.js";
import { CALL_PATH_SCRIPT, renderCallPath, renderOwnerCallRecord, renderOwnerSettings } from "../admin/owner-app.js";
import { buildCallPath, type CallPath } from "../domain/call-path.js";
import { chargeSentence, hasPlanAccess, isCompStatus, isPaidStatus } from "../domain/billing.js";
import { addOneMonth, billedPlan, currentPlan, oneMonthBefore, hasUnlimitedPrice, introCouponId, knownPlans, legacyPlanPriceIds, monthlyCents, normalizePlanId, pickPlan, planCatalog, planForPriceIds, planPriceIds, priceQuote, prorationEstimateCents, unlimitedPriceIds, type Plan, type PlanId } from "../domain/plans.js";
import { GuaranteeError, LeadGuaranteeService, recordFirstPaid, recordUnlimitedObservation, type UnlimitedItem } from "../application/billing-jobs.js";
import { callbackLinkMatches, OWNER_SMS_OPT_IN_CONFIRMATION, readCallbackLinkToken } from "../domain/owner-sms.js";
import { callsCsv, callsCsvFileName } from "./calls-csv.js";
import { hoursFromChoice } from "../domain/hours.js";
import { SMS_CONSENT_VERSION } from "../admin/footer.js";
import { renderDialHandoff, renderErrorPage } from "../admin/error-page.js";
import { EMAILED_HANDOFF_TTL_MS, HANDOFF_PROVIDER, isShortHandoffId, readDialHandoffToken, readShortHandoff, SHORT_HANDOFF_PREFIX, shortHandoffId, shortHandoffRecord } from "../domain/dial-handoff.js";

import { ALL_PARTY_CONSENT_STATES, serviceAreaState, stateForPhone, timezoneForState } from "../domain/area-codes.js";
import { areaForPhone } from "../domain/area-cities.js";
import { ALWAYS_ON_LINE, ALWAYS_ON_WORDS, EMERGENCY_CHOICES } from "../domain/emergency-choices.js";
import { otherServiceProblem, REPEAT_CALLER_DAILY_LIMIT } from "../domain/owner-inputs.js";
import { MAX_USAGE_ALERT_PERCENT, MIN_USAGE_ALERT_PERCENT, currentBillingPeriod, isValidUsageAlertPercent } from "../domain/usage.js";

export { currentBillingPeriod };
import { localDate, parseDaysOff } from "../domain/days-off.js";
import { apiCall, apiDashboard, apiSettings, apiTask, maskedPhone, settingsForm, textsOn, type ApiCallDetail, type ApiPlan } from "./owner-api-model.js";
import { approvedAnswer } from "../domain/approved-answer.js";
import { isExplicitHumanRequest } from "../domain/human-request.js";
import { saveAssistantConfig } from "../adapters/assistant-config.js";
import { DataDeletionService } from "../application/data-deletion.js";
import { TeamService } from "../application/team-service.js";
import { formatEmailBody } from "../adapters/resend.js";
import { anyGoogleClient, clientForAttempt, clientForNewConnections, encodeGoogleConnection, GOOGLE_CALENDAR_SCOPES, missingCalendarPermissions, oauthAttemptKey, type GoogleOAuthClient } from "../adapters/google-oauth-clients.js";
import { redactError, withTimeout } from "../application/retry.js";
import type { Environment } from "../config/environment.js";
import { createDemoConfig, normalizeServiceAreaInput } from "../domain/config.js";
import { TRADES, tradeForShopName, tradeShortLabel } from "../domain/trades.js";
import type { BusinessConfig, CallbackTask, CallRecord, OwnerAccount, PilotSignup, SubscriptionRecord, UsageSummary } from "../domain/models.js";
import type { OwnerSession } from "../security/owner-auth.js";
import { clearOwnerSessionCookie, createPasswordResetToken, hasUsablePassword, hashOwnerPassword, isPasswordless, hashPasswordResetToken, mintOwnerSession, ownerSessionCookie, ownerSessionIssuedAt, PASSWORDLESS_HASH, sessionMatchesAccount, verifyOwnerCsrf, verifyOwnerPassword, verifyOwnerSession } from "../security/owner-auth.js";
import { createOwnerSignIn, GOOGLE_SIGN_IN_CALLBACK, isSignInState, safeNext, verifiedSignupEmail, type PendingSignup } from "./owner-sign-in.js";
import { buildTelnyxAssistantUpdate, buildTelnyxGreeting, SPAM_CATEGORIES, TRANSFER_RECORDING_NOTICE } from "../voice/system-prompt.js";
import { MAX_PROVIDER_CALL_ID_LENGTH, TOOL_DEADLINE_MS, TOOL_ROUTES, toolFailure, toolLimitReached, withinToolBudget, type ToolLimitReason, type VoiceToolName } from "../voice/tool-results.js";
import { callScreeningSetting, ensureCallEndCallback, ensureInboundCallScreening, NumberUnavailableError, TelnyxProvisioner } from "../adapters/telnyx-provisioning.js";
import { AMD_ENDED_EVENT, FORWARDING_CHECK_SPEECH, forwardingCheckState, GREETING_ENDED_EVENT, SCREENING_DETECTED_EVENT, TelnyxForwardingClient } from "../adapters/telnyx-forwarding.js";
import { SETUP_CALL_TIME_LIMIT_SECS, SETUP_CALLS_PER_DAY, SETUP_HELP_TOOL_NAMES, SETUP_HELP_TOOL_PREFIX, setupHelpState, setupSorrySpeech, TelnyxSetupCaller, type SetupCallFacts, type SetupHelpToolName, type SetupTestSummary } from "../adapters/telnyx-setup-call.js";
import { FOUNDER_GOOGLE_SCOPES, FounderCalendarReadError, FounderCalendars, FounderConnectError } from "../adapters/founder-calendar.js";
import { FounderFollowup, type FounderBookingFacts } from "../application/founder-followup.js";
import { founderBookingToken, founderCallIcs, founderConnectTokenValid, ownerFirstName, prettyPhone, readFounderBookingToken, slotFullLabel } from "../domain/founder-booking.js";
import { renderFounderBooking, renderFounderCalendars } from "../admin/founder.js";
import { ensureReviewAccount, isLinkPreview, REVIEW_NO_LINE, ReviewAccountError, reviewAccountTokenValid } from "../application/review-account.js";
import { renderReviewAccount } from "../admin/review-account.js";
import { dialsBackToOtto } from "../application/forwarding-loop.js";
import { carrierFamily, forwardingChoice, forwardingOffInstruction, forwardsBackToOtto, parseTestedFor, everyCallVerdict, rangSeconds, ringFirstVerdict, SETUP_CALL_STALE_MS, type CarrierFamily, type CarrierInfo, forwardingPlan, type ForwardingMode, type TestedFor } from "../domain/forwarding.js";
import { forwardingSteps, forwardToDigits, settingsStepsText } from "../domain/forwarding-steps.js";
import { FORWARDING_CHECK_WINDOW_MS, forwardingCheckStatus, forwardingUpdate, type ForwardingCheckRecord, type ForwardingState } from "./owner-api-model.js";
import {
  clearGrace,
  describeCaller,
  GRACE_DAYS,
  GRACE_PROVIDER,
  GRACE_STARTED_KEY,
  graceStartedAt,
  lowerFirst,
  queueOwnerMessage,
  releaseProvisionedLine as releaseLine,
  renderHangupTexml,
  renderVoicemailTexml,
  transcriptSnippet,
  VOICEMAIL_FALLBACK_DELAY_MS,
  voicemailToken,
  voicemailTokenMatches,
  type GraceContext,
} from "../application/grace-line.js";
import { PLATFORM_TENANT_ID, type CalendarPort, type Clock, type Store } from "../ports.js";
import {
  asTelnyxConversationEnded,
  asTelnyxInitialization,
  callerReputation,
  asTelnyxMessageFinalized,
  asTelnyxMessageReceived,
  parseTelnyxEnvelope,
  parseTelnyxTexmlCallback,
  TelnyxRecordingClient,
  TelnyxVoiceRoutingClient,
  telnyxEventId,
  toTelnyxCallSummary,
  toTelnyxTexmlCallSummary,
  verifyTelnyxWebhook,
} from "../adapters/telnyx.js";
import { CARD_UPDATE_TAG, firstChargeFromEvent, StripeBillingClient, subscriptionFromStripeEvent, verifyStripeWebhook, type BillLine, type CardOnFile } from "../adapters/stripe.js";
import { noopTelemetry, type Telemetry } from "../adapters/posthog.js";
import { TelnyxTranscriber, type Transcriber } from "../adapters/telnyx-transcribe.js";
import { cleanHeard, parseClipUpload, withPronunciation, WORD_CLIP_MAX_BYTES } from "../domain/word-clips.js";
import { injectAnalytics, POSTHOG_PROXY_PREFIX, proxyToPostHog } from "./posthog-proxy.js";
import {
  adminCookie,
  bearerMatches,
  clearGoogleOAuthCookie,
  createGoogleOAuthAttempt,
  csrfForSession,
  HttpError,
  isCrossSiteFormPost,
  mintAdminSession,
  parseForm,
  parseJson,
  RateLimiter,
  readBody,
  readCookie,
  requestIp,
  redirect,
  sendHtml,
  sendJson,
  setSecurityHeaders,
  verifyAdminSession,
  verifyCsrf,
  verifyGoogleOAuthAttempt,
} from "./security.js";

/** Brock's founder-calendar connect: its own cookie on the shared Google redirect path, never the owner's. */
const FOUNDER_OAUTH_COOKIE = "afo_google_founder";
/** The signed link (k) the connect started with, carried to Google's return so it goes back with that same link (or FOUNDER_RETURN_ADMIN). */
const FOUNDER_RETURN_COOKIE = "afo_google_founder_k";
const FOUNDER_OAUTH_PATH = "/app/integrations/google";
/** The return cookie of a connect started with admin access: no link, just "go back to the admin page". */
const FOUNDER_RETURN_ADMIN = "admin";

/** Otto's AI setup helper's call to an owner, as the help endpoint and the call's webhooks write it. */
interface SetupCallRecord {
  startedAt?: string;
  callControlId?: string;
  device?: SetupCallFacts["device"];
  to?: string;
  answeredAt?: string;
  endedAt?: string;
  hangupCause?: string | null;
  /** How it ended, for the screen and the log. */
  outcome?: SetupCallOutcome;
  /** A time with our team was booked on this call. */
  bookedAt?: string;
}

/** done: they talked; missed: never picked up; voicemail: a machine answered; looped: their phone sent it to Otto. */
type SetupCallOutcome = "done" | "missed" | "voicemail" | "looped" | "failed";
/**
 * A forwarding test as the setup helper reads it (from the same status the screen shows): passed, failed with one
 * plain reason, or still calling. `say` is what it reads to the owner.
 */
const SETUP_TEST_WORDS: Partial<Record<ReturnType<typeof forwardingCheckStatus>, SetupTestSummary & { say: string }>> = {
  idle: { status: "not_run", detail: "No test yet.", say: "There's no test yet." },
  calling: { status: "not_run", detail: "A test is calling their business phone now.", say: "The test is calling your business phone now." },
  passed: { status: "passed", detail: "Calls reach Call Otto.", say: "It worked. Calls to your business number reach Otto." },
  forwards_all: { status: "failed", detail: "Ring first is picked, but every call still goes to Otto with no ring: turn forwarding off first, then dial the ring-first code.", say: "Calls reach Otto, but your phone didn't ring first. Every call is still forwarded." },
  rings_first: { status: "failed", detail: "Every call is picked, but their phone rang first: the every-call setting isn't on yet.", say: "Your phone rang first, so every call isn't on yet." },
  phone_answers: { status: "failed", detail: "Their phone picked up the test itself (Live Voicemail or call screening).", say: "Your phone picked up the test by itself, so forwarding never got a chance." },
  voicemail: { status: "failed", detail: "The test went to their voicemail: forwarding isn't on.", say: "The test went to your voicemail, so forwarding isn't on yet." },
  you_answered: { status: "failed", detail: "Someone answered the test call.", say: "Someone answered the test. Don't answer it next time." },
  declined: { status: "failed", detail: "The test was declined and didn't reach Otto.", say: "The test was declined and didn't reach Otto." },
  not_reached: { status: "failed", detail: "The test didn't reach Otto: forwarding isn't on yet.", say: "The test didn't reach Otto, so forwarding isn't on yet." },
};

/** The helper's tools: callControlId -> tenantId, on the platform tenant. */
const SETUP_HELP_PROVIDER = "setup-help";

function parseTimes(value: string | null): string[] {
  try {
    const parsed = value ? JSON.parse(value) as unknown : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && Number.isFinite(Date.parse(item))) : [];
  } catch {
    return [];
  }
}

/** Ringing or on the call: not ended, inside the ring window or (answered) the call's hard cap plus a minute. */
function setupCallLive(call: SetupCallRecord, nowMs: number): boolean {
  if (call.endedAt || typeof call.startedAt !== "string") return false;
  if (!call.answeredAt) return setupCallRinging(call, nowMs);
  return nowMs - Date.parse(call.answeredAt) < (SETUP_CALL_TIME_LIMIT_SECS + 60) * 1_000;
}

function readSetupCall(value: string | null): SetupCallRecord | null {
  try {
    const parsed = value ? JSON.parse(value) as unknown : null;
    return parsed && typeof parsed === "object" ? parsed as SetupCallRecord : null;
  } catch {
    return null;
  }
}

/** Still ringing: not picked up or ended, inside the 2 minutes the app shows "calling now" (it rings up to 30 s). */
function setupCallRinging(call: SetupCallRecord, nowMs: number): boolean {
  return !call.answeredAt && !call.endedAt && typeof call.startedAt === "string" && nowMs - Date.parse(call.startedAt) < 2 * 60_000;
}

/** Telnyx hang-up causes that mean the owner never picked up: rang out, busy, declined, or the number didn't ring. */
const SETUP_CALL_MISSED_CAUSES = new Set(["timeout", "no_answer", "user_busy", "call_rejected", "not_found"]);

const dateTime = z.string().datetime({ offset: true });
const baseToolSchema = z.object({
  provider_call_id: z.string().min(1),
});
/** The call record's value when the caller's number isn't known. */
const UNKNOWN_CALLER = "unknown";
/** Why the provider's caller number can't be used, or null when it can. A kind for the log, never the value. */
function fromNumberProblem(value: unknown): string | null {
  if (value === undefined) return "missing";
  if (isNotGiven(value)) return "null";
  if (typeof value !== "string") return typeof value;
  const text = value.trim();
  if (text.length < 3) return text ? "too_short" : "empty";
  if (text.length > 40) return "too_long";
  return text.includes("{{") ? "placeholder" : null;
}
/**
 * The provider fills this in, not the model. A missing, non-text or unresolved value must never fail a tool
 * (triage is the safety check): it reads as unknown, and the tool uses the number the call started with.
 */
const providerFromNumber = z.string().refine((value) => fromNumberProblem(value) === null).transform((value) => value.trim()).catch(UNKNOWN_CALLER);
/** An optional field the model got wrong is dropped, not fatal: the tool still runs on its required fields. */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const FLAG_TEXT: ReadonlyMap<string, boolean> = new Map([["true", true], ["yes", true], ["false", false], ["no", false]]);
/**
 * A yes/no the caller's rights hang on (wants a person, objects to recording, accepts a fee). The model may
 * send it as text; it is read, never dropped: empty text means not given, and an unreadable value fails the
 * call instead of losing it.
 */
const flag = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const text = value.trim().toLowerCase();
  return text === "" ? undefined : FLAG_TEXT.get(text) ?? value;
}, z.boolean().optional()).optional();
/**
 * The model's own emergency score. It alone can tip triage to urgent, so it is read from text when sent that
 * way and never dropped: empty text means not given, and an unreadable or out-of-range score fails the call
 * (the model is then told triage is unavailable and to follow the safety rules itself).
 */
const emergencyScore = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const text = value.trim();
  return text === "" ? undefined : Number.isFinite(Number(text)) ? Number(text) : value;
}, z.number().min(0).max(1).optional()).optional();
const availabilitySchema = baseToolSchema.extend({
  window_start: dateTime,
  window_end: dateTime,
});
const serviceAreaSchema = baseToolSchema.extend({
  address: z.string().min(3).max(500),
});
const triageSchema = baseToolSchema.extend({
  from_number: providerFromNumber,
  caller_name: lenient(z.string().max(120)),
  problem_description: z.string().min(1).max(2_000),
  llm_score: emergencyScore,
  llm_reason: lenient(z.string().max(500)),
});
const bookingSchema = baseToolSchema.extend({
  slot_start: dateTime,
  caller_name: z.string().min(1).max(120),
  callback_number: z.string().min(3).max(40),
  address: z.string().min(3).max(500),
  service_category: z.string().min(1).max(120),
  problem_description: z.string().min(1).max(2_000),
  explicit_confirmation: z.boolean(),
  diagnostic_fee_accepted: z.boolean(),
});
const handoffSchema = baseToolSchema.extend({
  from_number: providerFromNumber,
  reason: z.enum(["explicit_request", "emergency"]),
  caller_quote: z.string().min(1).max(500),
  caller_name: lenient(z.string().max(120)),
  problem_description: lenient(z.string().max(2_000)),
});
const intakeSchema = baseToolSchema.extend({
  from_number: providerFromNumber,
  caller_name: lenient(z.string().max(120)),
  company_name: lenient(z.string().max(120)),
  callback_number: lenient(z.string().max(40)),
  service_address: lenient(z.string().max(500)),
  service_category: lenient(z.string().max(120)),
  service_category_confidence: lenient(z.number().min(0).max(1)),
  problem_description: z.string().min(1).max(2_000),
  equipment_details: lenient(z.string().max(1_000)),
  access_notes: lenient(z.string().max(1_000)),
  diagnostic_fee_accepted: flag,
  human_requested: flag,
  confidence: lenient(z.number().min(0).max(1)),
  recording_disclosure_given: lenient(z.boolean()),
  recording_disclosure_declined: flag,
});
const pilotSignupSchema = z.object({
  ownerName: z.string().trim().min(2).max(120),
  businessName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().min(7).max(30),
  website: z.string().trim().max(300).optional(),
  trade: z.enum(["hvac", "plumbing", "electrical", "other"]),
  serviceArea: z.string().trim().min(2).max(500),
  desiredMode: z.enum(["after_hours", "overflow", "always"]),
  missedCallsPerWeek: z.string().trim().max(4).optional(),
  calendarProvider: z.enum(["google", "none", "other"]),
  notes: z.string().trim().max(1_500).optional(),
  consent: z.literal("yes"),
});
const ownerSignupSchema = z.object({
  displayName: z.string().trim().min(2).max(120).default("Shop owner"),
  businessName: z.string().trim().min(2).max(120).default("Your service business"),
  email: z.string().trim().toLowerCase().email().max(254),
  // Required unless Google, Microsoft or an email link already verified the email (checked in the handler).
  password: z.string().min(PASSWORD_MIN_LENGTH).max(200).optional(),
  phone: z.string().trim().max(30).optional(),
  timezone: z.string().trim().max(100).optional(),
  serviceAreaTerms: z.string().trim().max(800).default(""),
  // New shops start on "Otto answers every call": nothing to change on the phone. "Ring my phone first" is one tap away.
  operationMode: z.enum(["after_hours", "overflow", "always"]).default("always"),
  greeting: z.string().trim().min(5).max(500).default("Thanks for calling. How can I help?"),
  weekdayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("17:00"),
  weekdayEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
  bookableWeekdayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
  bookableWeekdayEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("17:00"),
  serviceCategories: z.string().trim().min(2).max(800).default("HVAC repair, HVAC maintenance"),
  emergencyKeywords: z.string().trim().min(2).max(800).default("gas smell, carbon monoxide, no heat, frozen pipes"),
  // Sent by old links and forms; ignored. The shop name picks the starting services and urgent words.
  trade: z.string().trim().max(40).optional(),
  weekends: z.string().optional(),
  ownerSmsConsent: z.literal("yes").optional(),
  ownerCallConsent: z.literal("yes").optional(),
  founderSmsConsent: z.literal("yes").optional(),
  // Agreement to the terms is the notice beside the button; an old form may still send the box.
  consent: z.literal("yes").optional(),
});
const ownerLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

export interface AppDependencies {
  env: Environment;
  store: Store;
  calendar: CalendarPort;
  clock: Clock;
  integrations: Record<string, boolean>;
  logger?: (entry: Record<string, unknown>) => void;
  /** Outbound HTTP for Stripe and Telnyx routing; tests inject a fake. */
  fetcher?: typeof fetch;
  /** The built React owner app (web/dist). When absent, /app and /demo stay server-rendered. */
  ownerWeb?: { dir: string };
  /** PostHog product analytics + error tracking; a no-op when POSTHOG_KEY is unset. */
  telemetry?: Telemetry;
  /** How long a voice tool may run before it is aborted and answers take-a-message (tests shorten it). */
  toolDeadlineMs?: number;
  /** Speech-to-text for "Say it" clips; tests inject a fake. Defaults to Telnyx when its key is set (never in demo or test mode). */
  transcriber?: Transcriber | null;
}

/** An authenticated voice tool call whose budget is already charged, before its arguments are parsed. */
interface ToolRequest {
  name: VoiceToolName;
  rawBody: string;
  /** The provider call id the budget was charged to. */
  callId: string;
  /** Fires at the tool deadline; passed to provider HTTP calls and checked before every write. */
  signal: AbortSignal;
}

/** A voice tool must not run (budget spent, no call id, rate limit, deadline): answer 200 take-a-message. */
class ToolLimitError extends Error {
  constructor(readonly tool: VoiceToolName, readonly reason: ToolLimitReason) {
    super(`${tool} stopped: ${reason}`);
  }
}

function publicOwnerDemo(now: Date): {
  account: OwnerAccount;
  config: BusinessConfig;
  calls: CallRecord[];
  tasks: CallbackTask[];
  usage: UsageSummary;
  subscription: SubscriptionRecord;
} {
  const tenantId = "public-dashboard-demo";
  const stamp = (minutesAgo: number): string => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const config: BusinessConfig = {
    ...createDemoConfig(tenantId),
    paused: false,
    businessName: "Suncoast Heating Demo",
    timezone: "America/New_York",
    serviceAreaTerms: ["Sarasota FL", "34236"],
    operationMode: "overflow",
  };
  const urgentCall: CallRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId,
    providerCallId: "synthetic-urgent-demo",
    fromNumber: "+15555550111",
    fromNumberVerified: true,
    startedAt: stamp(18),
    endedAt: stamp(14),
    durationSeconds: 241,
    fields: {
      callerName: "Jamie R.", companyName: null, callbackNumber: "+15555550111",
      address: "100 Bay Street, Sarasota, FL 34236", serviceCategory: "HVAC repair",
      serviceCategoryConfidence: 0.96, problemDescription: "No cooling; elderly resident in the home",
      equipmentDetails: "Outdoor unit is not starting", accessNotes: null, requestedStart: null,
      explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: true, confidence: 0.93,
    },
    emergency: { emergency: true, severity: "urgent", score: 0.91, evidence: ["no cooling", "elderly resident"], immediateInstruction: null },
    outcome: "handoff_queued",
    transcript: "Otto: Thanks for calling Suncoast Heating. This is Otto. How can I help?\nCaller: Our AC stopped and my mom is home. She's 84 and it's getting hot.\nOtto: I'm sorry. Let's get someone to you fast. What's the address?\nCaller: 100 Bay Street, Sarasota.\nOtto: Is the outdoor unit running at all?\nCaller: No, it's silent.\nOtto: Got it. I'm marking this urgent, and the owner will call you right back at this number.",
    recordingUrl: null,
    consentState: "disclosed",
    billingDisposition: "billable",
    qualityFlags: [],
    createdAt: stamp(18),
    updatedAt: stamp(14),
  };
  const routineCall: CallRecord = {
    id: "22222222-2222-4222-8222-222222222222",
    tenantId,
    providerCallId: "synthetic-routine-demo",
    fromNumber: "+15555550122",
    fromNumberVerified: true,
    startedAt: stamp(126),
    endedAt: stamp(123),
    durationSeconds: 188,
    fields: {
      callerName: "Morgan L.", companyName: null, callbackNumber: "+15555550122",
      address: "200 Palm Avenue, Sarasota, FL 34236", serviceCategory: "HVAC maintenance",
      serviceCategoryConfidence: 0.98, problemDescription: "Seasonal maintenance before travel",
      equipmentDetails: null, accessNotes: "Gate code required", requestedStart: stamp(-1_440),
      explicitSlotConfirmation: false, diagnosticFeeAccepted: true, humanRequested: false, confidence: 0.95,
    },
    emergency: { emergency: false, severity: "routine", score: 0.08, evidence: [], immediateInstruction: null },
    outcome: "pending_confirmation",
    transcript: "Otto: Thanks for calling Suncoast Heating. This is Otto. How can I help?\nCaller: I'd like a maintenance visit before we leave on a trip.\nOtto: Happy to help. What's the address?\nCaller: 200 Palm Avenue. There's a gate code.\nOtto: When works for you?\nCaller: Tomorrow morning if you can.\nOtto: I've asked for tomorrow at that time. The owner will confirm it with you.",
    recordingUrl: null,
    consentState: "disclosed",
    billingDisposition: "billable",
    qualityFlags: [],
    createdAt: stamp(126),
    updatedAt: stamp(123),
  };
  const bookedCall: CallRecord = {
    id: "66666666-6666-4666-8666-666666666666",
    tenantId,
    providerCallId: "synthetic-booked-demo",
    fromNumber: "+15555550133",
    fromNumberVerified: true,
    startedAt: stamp(310),
    endedAt: stamp(306),
    durationSeconds: 226,
    fields: {
      callerName: "Taylor S.", companyName: null, callbackNumber: "+15555550133",
      address: "300 Orange Avenue, Sarasota, FL 34236", serviceCategory: "HVAC repair",
      serviceCategoryConfidence: 0.97, problemDescription: "Thermostat is blank",
      equipmentDetails: null, accessNotes: null, requestedStart: stamp(-1_500),
      explicitSlotConfirmation: true, diagnosticFeeAccepted: true, humanRequested: false, confidence: 0.96,
    },
    emergency: { emergency: false, severity: "routine", score: 0.05, evidence: [], immediateInstruction: null },
    outcome: "booked",
    transcript: "Otto: Thanks for calling Suncoast Heating. This is Otto. How can I help?\nCaller: My thermostat is blank and nothing's coming on.\nOtto: Sorry about that. What's the address?\nCaller: 300 Orange Avenue, Sarasota.\nOtto: I can book you for tomorrow afternoon. Our service call is $89. Does that work?\nCaller: Yes, that works.\nOtto: You're booked. You'll get a confirmation shortly.",
    recordingUrl: null,
    consentState: "disclosed",
    billingDisposition: "billable",
    qualityFlags: [],
    createdAt: stamp(310),
    updatedAt: stamp(306),
  };
  const tasks: CallbackTask[] = [
    {
      id: "33333333-3333-4333-8333-333333333333", tenantId, callId: urgentCall.id,
      ownerRef: "owner-primary", reason: "Urgent callback requested", priority: "high", status: "open",
      dueAt: stamp(9), completedAt: null, completionSource: null, createdAt: stamp(14), updatedAt: stamp(14),
    },
    {
      id: "44444444-4444-4444-8444-444444444444", tenantId, callId: routineCall.id,
      ownerRef: "owner-primary", reason: "Confirm the proposed maintenance window", priority: "normal", status: "open",
      dueAt: stamp(-45), completedAt: null, completionSource: null, createdAt: stamp(123), updatedAt: stamp(123),
    },
    {
      id: "77777777-7777-4777-8777-777777777777", tenantId, callId: bookedCall.id,
      ownerRef: "owner-primary", reason: "Confirm requested appointment", priority: "normal", status: "completed",
      dueAt: stamp(280), completedAt: stamp(306), completionSource: "verified_booking", createdAt: stamp(310), updatedAt: stamp(306),
    },
  ];
  const [periodStart, periodEnd] = currentBillingPeriod(now);
  return {
    account: {
      id: "55555555-5555-4555-8555-555555555555", tenantId, email: "owner@demo.invalid",
      displayName: "Demo Owner", passwordHash: "synthetic-read-only", status: "active",
      createdAt: stamp(43_200), updatedAt: stamp(14),
    },
    config,
    calls: [urgentCall, routineCall, bookedCall],
    tasks,
    usage: { periodStart, periodEnd, billableCalls: 22, excludedSpamCalls: 5, excludedShortCalls: 3, billedMinutes: 87 },
    subscription: {
      tenantId, providerCustomerId: null, providerSubscriptionId: null, status: "active",
      currentPeriodEnd: periodEnd, providerEventCreatedAt: stamp(43_200), createdAt: stamp(43_200), updatedAt: stamp(43_200),
    },
  };
}

const OWNER_APP_PATH = /^\/app(?:\/(?:start|jobs|calendar|team|settings|settings\/[a-z-]{1,40}|calls|calls\/[0-9a-f-]{36}))?\/?$/i;
const DEMO_APP_PATH = /^\/demo(?:\/(?:jobs|calendar|calls|calls\/[A-Za-z0-9-]{1,64}))?\/?$/;
function isOwnerAppPath(pathname: string): boolean { return OWNER_APP_PATH.test(pathname); }
/** Signed out on an owner-app page (say, a phone that scanned the setup QR code): sign in, then land back on it. */
function loginReturningTo(url: URL): string {
  const next = isOwnerAppPath(url.pathname) || url.pathname === "/app/confirm-email" ? safeNext(`${url.pathname}${url.search}`) : null;
  return next && next !== "/app" ? `/login?next=${encodeURIComponent(next)}` : "/login";
}
function isDemoAppPath(pathname: string): boolean { return DEMO_APP_PATH.test(pathname); }

function ownerDashboardView(value: string | null): "today" | "pipeline" | "calendar" {
  return value === "pipeline" || value === "calendar" ? value : "today";
}

export type FrontOfficeHandler = RequestListener & {
  /** Background activation: waiting paid shops go live, and opted-in owners get the opt-in text once texting is approved. */
  runActivationJobs(): Promise<{ activated: number; blocked: number; optInConfirmations: number }>;
  /** Brock's follow-up email for shops whose forwarding still isn't confirmed 20 minutes after asking for setup help. */
  runFounderFollowups(): Promise<{ queued: number }>;
};

export function createRequestHandler(dependencies: AppDependencies): FrontOfficeHandler {
  const service = new CallService(dependencies.store, dependencies.calendar, dependencies.clock, dependencies.env.PUBLIC_BASE_URL, {
    callbackLinkKey: dependencies.env.SESSION_SIGNING_KEY ?? null,
    ownerEmailAvailable: Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL),
    pushAvailable: Boolean(dependencies.env.VAPID_PUBLIC_KEY && dependencies.env.VAPID_PRIVATE_KEY),
    urgentCallAvailable: urgentOwnerCallsConfigured(dependencies.env),
  });
  const vapid = dependencies.env.VAPID_PUBLIC_KEY && dependencies.env.VAPID_PRIVATE_KEY ? { publicKey: dependencies.env.VAPID_PUBLIC_KEY } : null;
  /** Automated emergency calls to the owner: offered when configured; on only with recorded consent. */
  const urgentCallsState = async (tenantId: string): Promise<{ available: boolean; on: boolean; disclosure: string; held: boolean }> => {
    const phone = await dependencies.store.getIntegrationSecret(tenantId, "notifications", "owner-primary");
    return {
      available: urgentOwnerCallsConfigured(dependencies.env),
      on: await hasOwnerCallConsent(dependencies.store, tenantId, phone),
      disclosure: OWNER_CALL_CONSENT_SETTINGS_DETAIL,
      // The urgent number is the business number and it may send every call to Otto: urgent calls are held (the
      // owner-call sender skips them), so Settings says so instead of a switch that looks on and does nothing.
      held: await dialsBackToOtto(dependencies.store, tenantId, phone),
    };
  };
  /** Owner texts: live (carrier approval recorded), on (consent on file and a mobile), and the mobile they go to. */
  const textsState = async (tenantId: string): Promise<{ live: boolean; on: boolean; mobile: string | null }> => {
    const [config, consent, phone] = await Promise.all([
      dependencies.store.getConfig(tenantId),
      dependencies.store.getIntegrationSecret(tenantId, "notifications", "owner_sms_consent"),
      dependencies.store.getIntegrationSecret(tenantId, "notifications", "owner-primary"),
    ]);
    return { live: dependencies.env.TELNYX_MESSAGING_APPROVED, on: textsOn(config, Boolean(consent)) && Boolean(phone), mobile: phone ? maskedPhone(phone) : null };
  };
  const recordingClient = dependencies.env.TELNYX_API_KEY ? new TelnyxRecordingClient(dependencies.env.TELNYX_API_KEY, dependencies.fetcher ?? fetch) : null;
  const routingClient = dependencies.env.TELNYX_API_KEY && dependencies.env.TELNYX_FROM_NUMBER && dependencies.env.TELNYX_ASSISTANT_ID
    ? new TelnyxVoiceRoutingClient({ apiKey: dependencies.env.TELNYX_API_KEY, phoneNumber: dependencies.env.TELNYX_FROM_NUMBER, assistantId: dependencies.env.TELNYX_ASSISTANT_ID })
    : null;
  const stripeClient = createStripeClient(dependencies.env, dependencies.fetcher ?? fetch);
  const guarantee = new LeadGuaranteeService(dependencies.store, stripeClient, dependencies.clock, (entry) => (dependencies.logger ?? ((value) => console.log(JSON.stringify(value))))(entry));
  const deletionService = new DataDeletionService(dependencies.store, recordingClient);
  const dummyOwnerPasswordHash = hashOwnerPassword(`unregistered:${randomUUID()}`);
  const limiter = new RateLimiter();
  const transcriber: Transcriber | null = dependencies.transcriber !== undefined ? dependencies.transcriber
    : dependencies.env.TELNYX_API_KEY && !dependencies.env.PROVIDER_TEST_MODE && !dependencies.env.DEMO_MODE
      ? new TelnyxTranscriber(dependencies.env.TELNYX_API_KEY, dependencies.env.TELNYX_STT_MODEL, dependencies.fetcher ?? fetch) : null;
  const log = dependencies.logger ?? ((entry) => console.log(JSON.stringify(entry)));
  const signIn = createOwnerSignIn({ env: dependencies.env, store: dependencies.store, clock: dependencies.clock, fetcher: (input, init) => (dependencies.fetcher ?? globalThis.fetch)(input, init), limiter, log });
  /** A passwordless account re-confirms risky changes by having signed in within this long. */
  const RECENT_SIGN_IN_MS = 10 * 60_000;
  const signedInRecently = (session: OwnerSession): boolean => {
    const age = dependencies.clock.now().getTime() - ownerSessionIssuedAt(session);
    return age >= 0 && age <= RECENT_SIGN_IN_MS;
  };
  const telemetry = dependencies.telemetry ?? noopTelemetry;
  /** Brock's Google calendars and his personal follow-up when the AI setup helper can't finish. */
  const founderCalendars = new FounderCalendars({ store: dependencies.store, env: dependencies.env, clock: dependencies.clock, fetcher: dependencies.fetcher, log });
  const founder = new FounderFollowup({ store: dependencies.store, env: dependencies.env, clock: dependencies.clock, calendars: founderCalendars, log });
  const graceContext: GraceContext = { store: dependencies.store, env: dependencies.env, clock: dependencies.clock, fetcher: dependencies.fetcher, log };
  const analyticsPage = (html: string, loader = true): string => injectAnalytics(html, { key: dependencies.env.POSTHOG_KEY, ingestionHost: dependencies.env.POSTHOG_HOST, loader });
  let ownerWebIndex: Promise<string | null> | null = null;
  const WEB_TYPES: Record<string, string> = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", woff2: "font/woff2", woff: "font/woff", svg: "image/svg+xml", png: "image/png" };
  const recordingUrls = new Map<string, { url: string | null; expiresAt: number }>();
  const trialDays = dependencies.env.STRIPE_TRIAL_DAYS;
  /** The plans for sale, Solo first; prices, labels and included calls come from config so they can change without a deploy. */
  const plans = planCatalog(dependencies.env);
  /** Plans for sale plus legacy Pro: what an existing subscription can be on. Never offered. */
  const known = knownPlans(dependencies.env);
  const couponId = introCouponId(dependencies.env);
  /** The line under the card button, for a plan with or without the Unlimited add-on (the coupon covers both). */
  const planCharge = (plan: Plan, timezone?: string, unlimited = false): string => {
    const total = unlimited && plan.unlimited ? plan.unlimited : plan;
    return chargeSentence({ now: dependencies.clock.now(), trialDays, priceCents: total.priceCents, firstMonthCents: total.firstMonthCents, ...(timezone ? { timezone } : {}) });
  };
  /** The plans as the owner app shows them; empty without Stripe (nothing to buy). */
  const apiPlans = (timezone?: string): ApiPlan[] => stripeClient ? plans.map((plan) => ({
    id: plan.id, label: plan.label, priceCents: plan.priceCents, firstMonthCents: plan.firstMonthCents, includedCalls: plan.includedCalls,
    overageCentsPerCall: plan.overageCentsPerCall, blurb: plan.blurb, who: plan.who, chargeNote: planCharge(plan, timezone),
    quote: priceQuote({ plan, unlimited: false, now: dependencies.clock.now(), trialDays }),
    unlimited: plan.unlimited ? { addOnCents: plan.unlimited.addOnCents, priceCents: plan.unlimited.priceCents, firstMonthCents: plan.unlimited.firstMonthCents, fairUseCalls: plan.unlimited.fairUseCalls, chargeNote: planCharge(plan, timezone, true), quote: priceQuote({ plan, unlimited: true, now: dependencies.clock.now(), trialDays }) } : null,
  })) : [];
  const signupPage = (request: IncomingMessage, error = "", values: Record<string, string> = {}, identity: PendingSignup | null = null, fieldErrors: SignupFieldErrors = {}): string => renderOwnerSignup(error, values, {
    fieldErrors,
    supportEmail: dependencies.env.SUPPORT_EMAIL ?? null,
    providers: signIn.providersFor(request),
    emailLink: signIn.loginOptions(request).emailLink === true,
    verified: verifiedSignupEmail(identity),
    chargeNote: stripeClient ? planCharge(plans[0]!) : null,
    plans: stripeClient ? plans.map((plan) => ({ ...plan, chargeNote: planCharge(plan), unlimitedChargeNote: plan.unlimited ? planCharge(plan, undefined, true) : null, quote: priceQuote({ plan, unlimited: false, now: dependencies.clock.now(), trialDays }), unlimitedQuote: plan.unlimited ? priceQuote({ plan, unlimited: true, now: dependencies.clock.now(), trialDays }) : null })) : [],
  });
  /** The owner this browser is signed in as, if any (a live session for an account that still matches it). */
  const signedInOwner = async (request: IncomingMessage): Promise<OwnerAccount | null> => {
    const session = verifyOwnerSession(readCookie(request, "afo_owner"), dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
    if (!session) return null;
    const account = await dependencies.store.getOwnerAccountById(session.accountId);
    return account && account.tenantId === session.tenantId && account.status !== "suspended" && sessionMatchesAccount(session, account) ? account : null;
  };
  /** The add-on can be bought only where this plan's Unlimited price exists. */
  const wantsUnlimited = (plan: Plan, value: unknown): boolean => Boolean(plan.unlimited) && (value === "yes" || value === "1" || value === "on" || value === true);

  const listener: RequestListener = (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const requestId = response.getHeader("x-request-id") ?? request.headers["x-request-id"] ?? "unassigned";
      const tool = request.method === "POST" ? toolForPath(new URL(request.url ?? "/", "http://localhost").pathname) : null;
      if (tool) return answerToolError(tool, error, response, String(requestId));
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
      const message = error instanceof HttpError || error instanceof z.ZodError ? error.message : "Internal server error";
      log({ level: status >= 500 ? "error" : "warn", event: "request_failed", requestId, status, error: safeError(error) });
      if (status >= 500) {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        telemetry.captureException(error, { route: routeKey(pathname), method: request.method ?? "GET", status, requestId: String(requestId) });
      }
      if (response.headersSent) response.end();
      else if (wantsPage(request)) sendHtml(response, status, errorPage(status, message, new URL(request.url ?? "/", "http://localhost").pathname));
      else sendJson(response, status, { error: message, request_id: requestId });
    });
  };
  return Object.assign(listener, { runActivationJobs, runFounderFollowups: () => founder.runOnce() });

  /**
   * The provider only hands a tool's body to the model on 2xx, so every voice tool failure answers 200 with
   * the fixed plain-English result; anything else reads as unreadable and the model retries. The real status
   * is logged here only. Error text (validation messages can quote the caller) never reaches the model.
   */
  function answerToolError(tool: VoiceToolName, error: unknown, response: ServerResponse, requestId: string): void {
    if (error instanceof ToolLimitError) {
      log({ level: "warn", event: "tool_call_limited", requestId, tool, reason: error.reason });
    } else {
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : error instanceof ToolWriteInProgressError ? 409 : 500;
      log({ level: status >= 500 ? "error" : "warn", event: "tool_request_failed", requestId, tool, status, error: safeError(error), ...(error instanceof z.ZodError ? { fields: invalidFields(error) } : {}) });
      if (status >= 500) telemetry.captureException(error, { route: `tool:${tool}`, method: "POST", status, requestId });
    }
    if (response.headersSent) {
      response.end();
      return;
    }
    sendJson(response, 200, error instanceof ToolLimitError ? toolLimitReached(tool) : toolFailure(tool));
  }

  /**
   * Run a voice tool under a deadline just inside the provider's webhook timeout. When it fires, in-flight
   * provider HTTP calls are aborted, no further writes happen, and the model gets the terminal take-a-message
   * result (not an "unavailable" that invites a retry).
   */
  async function runTool(tool: VoiceToolName, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new ToolLimitError(tool, "deadline"));
        resolve("timeout");
      }, dependencies.toolDeadlineMs ?? TOOL_DEADLINE_MS);
    });
    const running = handleToolRoute(tool, request, response, url, controller.signal);
    try {
      if (await Promise.race([running.then(() => "done" as const), deadline]) === "done") return;
    } finally {
      clearTimeout(timer);
    }
    // The late handler can no longer answer; it stops at its next abort check.
    running.catch((error: unknown) => {
      if (!(error instanceof ToolLimitError)) log({ level: "warn", event: "tool_late_failure", tool, error: safeError(error) });
    });
    throw new ToolLimitError(tool, "deadline");
  }

  /**
   * The call id the budget is charged to, from the provider header (never the unparsed body) in production.
   * Demo bearer requests without the header fall back to the body's provider_call_id.
   */
  function toolCallId(request: IncomingMessage, rawBody: string): string | null {
    const usable = (value: unknown): string | null =>
      typeof value === "string" && value.trim().length > 0 && value.length <= MAX_PROVIDER_CALL_ID_LENGTH ? value : null;
    const header = singleHeader(request.headers["x-telnyx-call-control-id"]);
    if (header !== undefined) return usable(header);
    if (!(dependencies.env.DEMO_MODE && bearerMatches(request, dependencies.env.TOOL_TOKEN))) return null;
    try {
      const payload = unwrapToolPayload(JSON.parse(rawBody));
      return payload && typeof payload === "object" ? usable((payload as Record<string, unknown>).provider_call_id) : null;
    } catch {
      return null;
    }
  }

  /** Charge one call against the durable per-call budget. Fails closed: no count, no tool. */
  async function spendToolBudget(providerCallId: string, tool: VoiceToolName): Promise<void> {
    let count: number;
    try {
      count = await dependencies.store.incrementToolCallCount(providerCallId, tool, dependencies.clock.now().toISOString());
    } catch (error) {
      log({ level: "error", event: "tool_budget_unavailable", tool, error: safeError(error) });
      throw new ToolLimitError(tool, "budget_unavailable");
    }
    if (!withinToolBudget(tool, count)) throw new ToolLimitError(tool, "budget");
  }

  /**
   * An owner just opted in to texts: the next owner text carries the STOP line again, and once production
   * messaging is approved they get the registered opt-in confirmation (a failed enqueue is logged, not fatal).
   */
  async function queueOwnerOptInConfirmation(tenantId: string, phone: string | null, idempotencyKey: string): Promise<void> {
    // Not swallowed: a stale notice would leave every later text to this number without the STOP line.
    if (phone) await dependencies.store.resetSmsStopNotice(phone);
    if (!dependencies.env.TELNYX_MESSAGING_APPROVED) return;
    await dependencies.store.withLock(`optin-confirm:${tenantId}`, () => enqueueOptInConfirmation(tenantId, idempotencyKey))
      .catch((error) => log({ level: "warn", event: "owner_optin_confirmation_failed", tenantId, error: safeError(error) }));
  }

  /** Callers hold the optin-confirm lock for the shop, so the approval job and a fresh opt-in never both send it. */
  async function enqueueOptInConfirmation(tenantId: string, idempotencyKey: string): Promise<void> {
    try {
      const now = dependencies.clock.now().toISOString();
      await dependencies.store.enqueueNotification({
        id: randomUUID(), tenantId, callId: null, channel: "sms", destinationRef: "owner-primary",
        body: OWNER_SMS_OPT_IN_CONFIRMATION,
        priority: "normal", state: "pending", attempts: 0, nextAttemptAt: now,
        idempotencyKey, providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
      });
      // The texting-approval job sends this to everyone who opted in before approval; this marks it done.
      await dependencies.store.saveIntegrationSecret(tenantId, "notifications", "optin_confirmation_queued_at", now);
    } catch (error) {
      log({ level: "warn", event: "owner_optin_confirmation_failed", tenantId, error: safeError(error) });
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    // Stripe's embedded card form only ever runs inside the owner app, and only once a publishable key is set.
    setSecurityHeaders(response, { stripeEmbed: Boolean(dependencies.env.STRIPE_PUBLISHABLE_KEY) && (url.pathname === "/app" || url.pathname.startsWith("/app/")) });
    const requestId = typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : randomUUID();
    response.setHeader("x-request-id", requestId);
    const started = Date.now();
    const method = request.method ?? "GET";
    const route = routeKey(url.pathname);
    const ip = requestIp(request);
    if (url.pathname.startsWith(`${POSTHOG_PROXY_PREFIX}/`)) {
      // Analytics traffic is chatty (replay chunks), so it skips the request log and has its own limit.
      if (!dependencies.env.POSTHOG_KEY) throw new HttpError(404, "Not found");
      if (!limiter.allow(`${ip}:ingest`, 600, 60_000)) throw new HttpError(429, "Too many requests");
      return proxyToPostHog(request, response, { ingestionHost: dependencies.env.POSTHOG_HOST, clientIp: ip, fetcher: dependencies.fetcher ?? fetch });
    }
    response.once("finish", () => {
      log({ level: "info", event: "request_completed", requestId, method, route, status: response.statusCode, latencyMs: Date.now() - started });
    });
    // The live call path polls every two seconds from every open call page, so several viewers behind one
    // office IP share this; its real limit is per account and call, in the handler.
    if (!route.startsWith("webhook") && !route.startsWith("tool:") && !limiter.allow(`${ip}:${route}`, route === "owner:call-path" ? 600 : 90, 60_000)) {
      throw new HttpError(429, "Too many requests");
    }

    if (method === "GET" && url.pathname === "/app/sw.js") {
      // Allowed to cover /app itself (the Calls screen), not only /app/..., so a tap can move an open app window.
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/app" });
      response.end(SERVICE_WORKER);
      return;
    }
    if (method === "GET" && url.pathname === "/app/call-path.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" });
      response.end(CALL_PATH_SCRIPT);
      return;
    }
    if (method === "GET" && url.pathname === "/app/manifest.webmanifest") {
      response.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600" });
      response.end(WEB_MANIFEST);
      return;
    }
    if (method === "GET" && (url.pathname === "/assets/front-office-mascot-flat.png" || url.pathname === "/assets/stripe-product.png" || url.pathname === "/assets/icon-192.png" || url.pathname === "/assets/icon-512.png" || url.pathname === "/assets/apple-touch-icon.png" || url.pathname === "/assets/sms-opt-in.png")) {
      const asset = await readFile(resolve(process.cwd(), "public" + url.pathname));
      response.statusCode = 200;
      response.setHeader("content-type", "image/png");
      response.setHeader("cache-control", "public, max-age=86400");
      response.end(asset);
      return;
    }
    if (method === "GET" && url.pathname === "/assets/analytics.js") {
      if (!dependencies.env.POSTHOG_KEY) throw new HttpError(404, "Not found");
      const asset = await readFile(resolve(process.cwd(), "public/assets/analytics.js"));
      response.statusCode = 200;
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.setHeader("cache-control", "public, max-age=3600");
      response.end(asset);
      return;
    }
    if (method === "GET" && url.pathname === "/assets/copy-number.js") {
      const asset = await readFile(resolve(process.cwd(), "public/assets/copy-number.js"));
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.setHeader("cache-control", "public, max-age=86400");
      response.end(asset);
      return;
    }
    if (method === "GET" && url.pathname === "/assets/faq.js") {
      const asset = await readFile(resolve(process.cwd(), "public/assets/faq.js"));
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.setHeader("cache-control", "public, max-age=86400");
      response.end(asset);
      return;
    }
    if (method === "GET" && url.pathname === "/assets/signup-wizard.js") {
      const asset = await readFile(resolve(process.cwd(), "public/assets/signup-wizard.js"));
      response.statusCode = 200;
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.setHeader("cache-control", "public, max-age=86400");
      response.end(asset);
      return;
    }
    if (method === "GET" && url.pathname === "/") {
      const config = await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID);
      return sendHtml(response, 200, analyticsPage(renderLanding(config, undefined, { supportEmail: dependencies.env.SUPPORT_EMAIL ?? null, trialDays: stripeClient ? trialDays : 0, plans, textsLive: dependencies.env.TELNYX_MESSAGING_APPROVED })));
    }
    if (method === "GET" && url.pathname.startsWith("/web/assets/")) return serveWebAsset(response, url.pathname.slice("/web/assets/".length));
    // The demo account is closed to visitors (founder decision 2026-11-26): its pages send them to the homepage
    // and its data answers 404. Only a request with the admin bearer token still reaches the demo below.
    if (url.pathname === "/demo" || url.pathname.startsWith("/demo/") || url.pathname.startsWith("/api/demo/")) {
      const admin = bearerMatches(request, dependencies.env.ADMIN_TOKEN);
      if (!admin && url.pathname.startsWith("/api/demo/")) throw new HttpError(404, "Not found");
      if (!admin) return redirect(response, "/");
    }
    if (url.pathname.startsWith("/api/demo/")) return handleDemoApi(request, response, url);
    if (url.pathname.startsWith("/api/app/")) return handleOwnerApi(request, response, url);
    if (method === "GET" && isDemoAppPath(url.pathname) && await sendOwnerWeb(response)) return;
    if (method === "GET" && url.pathname === "/demo") {
      const demo = publicOwnerDemo(dependencies.clock.now());
      return sendHtml(response, 200, renderOwnerDashboard({
        ...demo,
        googleConnected: true,
        csrf: "",
        checkoutConfigured: false,
        checkoutUrl: null,
        now: dependencies.clock.now().toISOString(),
        selectedCallId: url.searchParams.get("call"),
        view: ownerDashboardView(url.searchParams.get("view")),
        preview: true,
      }));
    }
    // The "Call back" link from an owner text: signed for this call in this shop, 7 days, no sign-in needed.
    const callbackLink = /^\/c\/([A-Za-z0-9_.-]{20,80})$/.exec(url.pathname);
    if (method === "GET" && callbackLink?.[1]) {
      response.setHeader("cache-control", "private, no-store");
      response.setHeader("referrer-policy", "no-referrer");
      const parsed = readCallbackLinkToken(callbackLink[1], dependencies.clock.now());
      const call = parsed ? await dependencies.store.getCall(parsed.callId) : null;
      if (!parsed || !call || !dependencies.env.SESSION_SIGNING_KEY || !callbackLinkMatches(parsed, call.tenantId, dependencies.env.SESSION_SIGNING_KEY)) {
        return sendHtml(response, 404, renderCallbackLink(null));
      }
      const config = await dependencies.store.getConfig(call.tenantId);
      const phone = [call.fields.callbackNumber, call.fromNumber].find((value) => value && /^\+[1-9]\d{7,14}$/.test(value)) ?? null;
      return sendHtml(response, 200, renderCallbackLink({ shop: config.businessName, callerName: call.fields.callerName, problem: call.fields.problemDescription, address: call.fields.address, phone, urgent: call.emergency?.emergency === true, callId: call.id }));
    }
    // The link in Brock's follow-up email: book a 10-minute setup call with him. Signed for this shop, 7 days.
    if (url.pathname === "/book-setup" && (method === "GET" || method === "POST")) return handleFounderBooking(request, response, url);
    if (method === "GET" && url.pathname.startsWith("/dial/")) return handleDialHandoff(request, response, url);
    if (method === "GET" && url.pathname.startsWith(SHORT_HANDOFF_PREFIX)) return handleDialHandoff(request, response, url);
    if (url.pathname === "/join" && (method === "GET" || method === "POST")) {
      if (!limiter.allow(`${ip}:team-join`, 12, 60 * 60_000)) throw new HttpError(429, "Too many invitation attempts");
      return joinTeam(request, response, url, dependencies);
    }
    if (method === "GET" && url.pathname === "/signup") {
      if (url.searchParams.get("fresh") === "1") {
        response.setHeader("set-cookie", signIn.clearPendingIdentity());
        return redirect(response, "/signup");
      }
      // Already in (Back after sign-up, or a second tab): their shop, never a second workspace.
      if (await signedInOwner(request)) return redirect(response, "/app");
      // The pricing page's picks carry over: ?unlimited=1 and ?plan=team preselect the form. ?trade= is ignored.
      const preset: Record<string, string> = {};
      if (url.searchParams.get("unlimited") === "1") preset.unlimited = "yes";
      const presetPlan = normalizePlanId(url.searchParams.get("plan"));
      if (presetPlan && plans.some((plan) => plan.id === presetPlan)) preset.plan = presetPlan;
      return sendHtml(response, 200, analyticsPage(signupPage(request, "", preset, signIn.pendingIdentity(request))));
    }
    if (method === "POST" && url.pathname === "/signup") {
      // Another site must not be able to start a sign-up in this browser (a planted pending account would collect the
      // owner's shop, mobile and consent under someone else's email and password).
      if (isCrossSiteFormPost(request, dependencies.env.PUBLIC_BASE_URL)) throw new HttpError(403, "Forbidden");
      const form = parseForm(await readBody(request, 48_000));
      // The account screen and the shop screen are counted apart, so a normal two-screen sign-up uses one of each.
      if (!limiter.allow(`${ip}:owner-signup${form.get("step") === "account" ? "-account" : ""}`, 5, 60 * 60_000)) throw new HttpError(429, "Too many signup attempts from this connection");
      // Sign-up's first screen (Google, Microsoft, an email link, or email and password) left this browser a pending
      // sign-up: its email is the account email. Google, Microsoft and the link verified it; a password sign-up did not.
      let identity = signIn.pendingIdentity(request);
      if (form.get("faxNumber")?.trim()) return sendHtml(response, 200, signupPage(request, "", {}, identity));
      const values = Object.fromEntries(form.entries());
      const keepPicks = (): Record<string, string> => ({ ...(values.plan ? { plan: values.plan } : {}), ...(values.unlimited === "yes" ? { unlimited: "yes" } : {}) });
      if (values.step === "account") {
        // Screen 1, email and password: nothing is stored yet. A good pair waits in a short-lived cookie while they
        // fill in the shop; leaving now leaves no account and no workspace behind.
        const account = ownerSignupSchema.pick({ email: true, password: true }).safeParse({ email: values.email ?? "", password: values.password ?? "" });
        const errors = signupFieldErrors(account.success ? [] : account.error.issues, { email: values.email ?? "", password: values.password ?? "" }, false, ["email", "password"]);
        // A good email and no password yet: open the password box (the no-script path; the page reveals it as they type).
        if (!values.password && !errors.email) return sendHtml(response, 200, signupPage(request, "", { ...keepPicks(), email: account.success ? account.data.email : values.email ?? "" }));
        if (!account.success || Object.keys(errors).length > 0) return sendHtml(response, 400, signupPage(request, "", { ...keepPicks(), email: values.email ?? "" }, null, errors));
        if (await dependencies.store.getOwnerAccountByEmail(account.data.email)) return sendHtml(response, 409, signupPage(request, "", { ...keepPicks(), email: account.data.email }, null, { email: SIGNUP_EMAIL_TAKEN }));
        response.setHeader("set-cookie", signIn.startPasswordSignup(account.data.email, await hashOwnerPassword(account.data.password!)));
        const picks = new URLSearchParams(keepPicks().plan ? { plan: values.plan! } : {});
        if (values.unlimited === "yes") picks.set("unlimited", "1");
        return redirect(response, picks.toString() ? `/signup?${picks.toString()}` : "/signup");
      }
      if (identity) {
        values.email = identity.email;
        delete values.password;
      } else if (!values.email && !values.password && (values.businessName || values.phone)) {
        // The shop screen sent after the pending sign-up ran out: say so once, without errors for fields they never saw.
        return sendHtml(response, 400, signupPage(request, SIGNUP_TIMED_OUT, keepPicks(), null));
      }
      const parsed = ownerSignupSchema.safeParse(values);
      // Every problem at once, each under its own field and naming the fix.
      const fieldErrors = signupFieldErrors(parsed.success ? [] : parsed.error.issues, values, identity !== null);
      if (!parsed.success || Object.keys(fieldErrors).length > 0) {
        const message = Object.keys(fieldErrors).length > 0 ? "" : "Check the form and try again.";
        // A one-piece post (old form) with a good email and password but a shop problem: hold the account like screen 1
        // would, so the owner fixes the shop on the shop screen instead of retyping everything.
        if (!identity && !fieldErrors.email && !fieldErrors.password && values.email && values.password && !await dependencies.store.getOwnerAccountByEmail(values.email.trim().toLowerCase())) {
          const held = ownerSignupSchema.pick({ email: true, password: true }).safeParse({ email: values.email, password: values.password });
          if (held.success && held.data.password) {
            identity = { provider: "password", email: held.data.email, name: null, passwordHash: await hashOwnerPassword(held.data.password) };
            response.setHeader("set-cookie", signIn.startPasswordSignup(identity.email, identity.passwordHash));
          }
        }
        if (!identity) delete values.password;
        return sendHtml(response, 400, signupPage(request, message, values, identity, fieldErrors));
      }
      const phoneInput = parsed.data.phone?.trim() ?? "";
      const phone = phoneInput ? normalizeUsPhone(phoneInput) : null;
      // Defaults from the owner's mobile: their state is the starting service area and timezone.
      // The browser's timezone wins when the page sent one. Both are refined later in Settings.
      const homeState = stateForPhone(phone);
      let timezone = timezoneForState(homeState);
      if (parsed.data.timezone) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.timezone }).format();
          timezone = parsed.data.timezone;
        } catch {
          // An unknown browser zone falls back to the state's; the owner can change it in Settings.
        }
      }
      const now = dependencies.clock.now().toISOString();
      const tenantId = `shop_${randomUUID()}`;
      const account: OwnerAccount = {
        id: randomUUID(),
        tenantId,
        email: parsed.data.email,
        displayName: identity?.name && !form.has("displayName") ? identity.name : parsed.data.displayName,
        passwordHash: identity?.provider === "password" ? identity.passwordHash : identity || !parsed.data.password ? PASSWORDLESS_HASH : await hashOwnerPassword(parsed.data.password),
        // A password sign-up proves nothing about the email; the first Google, Microsoft, email or reset link does.
        emailVerifiedAt: identity && identity.provider !== "password" ? now : null,
        status: "pending_activation",
        createdAt: now,
        updatedAt: now,
      };
      const splitList = (value: string): string[] => value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 100);
      // The owner's own area from the mobile's area code ("Sarasota FL, Bradenton FL…"), else their state.
      const serviceArea = normalizeServiceAreaInput(parsed.data.serviceAreaTerms || areaForPhone(phone)?.join(", ") || homeState || "");
      if (serviceArea.errors.length > 0) return sendHtml(response, 400, signupPage(request, serviceAreaMessage(serviceArea.errors), values, identity));
      // The plan picked above the button; Solo when nothing was sent.
      const plan = pickPlan(plans, form.get("plan"));
      // No trade question: the shop name says it ("Gulf Plumbing"), else general home services. Changed in Settings.
      const trade = tradeForShopName(parsed.data.businessName);
      const config: BusinessConfig = {
        ...createDemoConfig(tenantId),
        paused: true,
        planId: plan.id,
        // Off unless the owner turned it on (pricing page or this form).
        unlimitedCalls: wantsUnlimited(plan, form.get("unlimited")),
        includedCalls: plan.includedCalls,
        overageCentsPerCall: plan.overageCentsPerCall,
        flatMonthlyPriceCents: plan.priceCents,
        businessName: parsed.data.businessName,
        greeting: form.has("greeting") ? parsed.data.greeting : `Thanks for calling ${parsed.data.businessName}. How can I help?`,
        // In a state where recording a call needs everyone's OK (Florida, California...), the notice starts on.
        recordingDisclosure: ALL_PARTY_CONSENT_STATES.has(serviceAreaState(serviceArea.terms) ?? homeState ?? "") ? RECORDING_NOTICE : "",
        timezone,
        serviceAreaTerms: serviceArea.terms,
        // An explicit list wins; otherwise the trade's from the shop name.
        emergencyKeywords: form.has("emergencyKeywords") ? splitList(parsed.data.emergencyKeywords) : [...trade.urgentWords],
        serviceCategories: form.has("serviceCategories") ? splitList(parsed.data.serviceCategories) : [...trade.services],
        requireDiagnosticFeeAcceptance: false,
        operationMode: parsed.data.operationMode,
        ownerNotificationRefs: parsed.data.ownerSmsConsent === "yes" ? ["owner-primary"] : [],
        ownerTransferNumberRef: phone ? "owner-primary" : null,
        supportEmail: parsed.data.email,
        // Default Mon–Fri 9 AM–5 PM (no hours step in onboarding; changed in Settings). Outside that, weekends included, is after hours.
        afterHours: {
          weekdayStart: parsed.data.weekdayStart,
          weekdayEnd: parsed.data.weekdayEnd,
          weekends: form.has("weekends") ? parsed.data.weekends === "on" : true,
          holidayDates: [],
        },
        bookableHours: {
          weekdayStart: parsed.data.bookableWeekdayStart,
          weekdayEnd: parsed.data.bookableWeekdayEnd,
          weekends: parsed.data.weekends === "on",
        },
      };
      const created = await dependencies.store.createOwnerWorkspace({ account, config, ownerPhone: phone });
      if (!created) {
        // A second tap, a refresh or a retry of this same sign-up: the account it made is theirs, so sign them in to
        // it rather than show an error or make another. Anyone else's account with this email: sign in instead.
        const existing = await dependencies.store.getOwnerAccountByEmail(parsed.data.email);
        const sameSignup = existing && existing.status !== "suspended" && identity && dependencies.clock.now().getTime() - Date.parse(existing.createdAt) < 30 * 60_000
          && (identity.provider === "password" ? existing.passwordHash === identity.passwordHash : existing.emailVerifiedAt !== null && isPasswordless(existing.passwordHash));
        if (existing && sameSignup) {
          const again = mintOwnerSession(existing, dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
          response.setHeader("set-cookie", [ownerSessionCookie(again, dependencies.env.NODE_ENV === "production"), signIn.clearPendingIdentity()]);
          // A double tap on the last button: land where the first tap did (the card), not past it.
          if (stripeClient && existing.status === "pending_activation") {
            const target = await startCheckout(existing, "start", plan.id).catch(() => null);
            if (target) return redirect(response, target);
          }
          return redirect(response, "/app/start");
        }
        if (identity) response.setHeader("set-cookie", signIn.clearPendingIdentity());
        delete values.password;
        return sendHtml(response, 409, signupPage(request, "", { ...keepPicks(), email: parsed.data.email }, null, { email: SIGNUP_EMAIL_TAKEN }));
      }
      if (parsed.data.founderSmsConsent === "yes") {
        const welcomeConfigured = dependencies.env.FOUNDER_WELCOME_ENABLED
          && dependencies.env.TELNYX_MESSAGING_APPROVED
          && dependencies.env.FOUNDER_WELCOME_FROM_NUMBER
          && dependencies.env.FOUNDER_WELCOME_NAME;
        if (welcomeConfigured) {
          try {
            const queued = await dependencies.store.enqueueNotification({
              id: randomUUID(), tenantId, callId: null, channel: "sms", senderRef: "founder", destinationRef: "owner-primary",
              body: renderFounderWelcome(dependencies.env.FOUNDER_WELCOME_TEMPLATE, dependencies.env.FOUNDER_WELCOME_NAME!, config.businessName),
              priority: "normal", state: "pending", attempts: 0, nextAttemptAt: now,
              idempotencyKey: `founder-welcome:${tenantId}`,
              providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
            });
            log({ level: "info", event: queued ? "founder_welcome_queued" : "founder_welcome_duplicate", tenantId });
          } catch (error) {
            log({ level: "warn", event: "founder_welcome_queue_failed", tenantId, error: safeError(error) });
          }
        } else {
          log({ level: "info", event: "founder_welcome_unconfigured", tenantId });
        }
      }
      if (parsed.data.ownerCallConsent === "yes" && phone) {
        // TCPA: prior express consent to automated emergency calls, with the exact wording version shown.
        await grantOwnerCallConsent(dependencies.store, tenantId, { at: now, source: "signup", ip, phone });
      }
      if (parsed.data.ownerSmsConsent === "yes") {
        // Proof of opt-in for the carrier: when, from where, and the exact wording version shown.
        await dependencies.store.saveIntegrationSecret(tenantId, "notifications", "owner_sms_consent", JSON.stringify({ at: now, source: "signup", wording: SMS_CONSENT_VERSION, ip }));
        await queueOwnerOptInConfirmation(tenantId, phone!, `owner-optin:${tenantId}:signup`);
      }
      const session = mintOwnerSession(account, dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
      const sessionCookie = ownerSessionCookie(session, dependencies.env.NODE_ENV === "production");
      response.setHeader("set-cookie", identity ? [sessionCookie, signIn.clearPendingIdentity()] : sessionCookie);
      log({ level: "info", event: "owner_workspace_created", accountId: account.id, tenantId, ...(identity ? { signInMethod: identity.provider } : {}) });
      telemetry.capture("owner_signed_up", account.id, tenantId, { operation_mode: config.operationMode });
      // Straight to the card: one tap from "Continue" to Stripe. If Stripe is slow, the next screen has the button.
      if (stripeClient) {
        const target = await startCheckout(account, "start", plan.id).catch((error) => {
          log({ level: "warn", event: "signup_checkout_failed", tenantId, error: safeError(error) });
          return null;
        });
        if (target) return redirect(response, target);
      }
      return redirect(response, "/app/start");
    }
    if (method === "GET" && url.pathname === "/login") return sendHtml(response, 200, renderOwnerLogin("", signIn.loginOptions(request, { next: safeNext(url.searchParams.get("next")) })));
    if (method === "POST" && url.pathname === "/login") {
      // Another site can't post its own email and password here to sign this browser into its shop.
      if (isCrossSiteFormPost(request, dependencies.env.PUBLIC_BASE_URL)) throw new HttpError(403, "Forbidden");
      if (!limiter.allow(`${ip}:owner-login`, 10, 15 * 60_000)) throw new HttpError(429, "Too many sign-in attempts");
      const form = parseForm(await readBody(request, 16_000));
      const next = safeNext(form.get("next"));
      const parsed = ownerLoginSchema.safeParse({ email: form.get("email") ?? "", password: form.get("password") ?? "" });
      // A good email and no password yet: open the password box with the cursor in it (the no-script path).
      if (!form.get("password") && z.string().trim().email().safeParse(form.get("email") ?? "").success) {
        return sendHtml(response, 200, renderOwnerLogin("", signIn.loginOptions(request, { passwordOpen: true, email: (form.get("email") ?? "").trim(), next })));
      }
      if (!parsed.success) {
        // A malformed email the browser let through points at the email, not the password.
        const badEmail = parsed.error.issues.some((issue) => issue.path[0] === "email");
        return sendHtml(response, 400, renderOwnerLogin(badEmail ? "Enter an email like you@yourshop.com." : "Enter your password.", signIn.loginOptions(request, { errorField: badEmail ? "passwordEmail" : "password", email: form.get("email") ?? "", next })));
      }
      // Per-account limit so guesses spread across many addresses still stop.
      if (!limiter.allow(`owner-login-email:${parsed.data.email}`, 10, 15 * 60_000)) throw new HttpError(429, "Too many sign-in attempts");
      const account = await dependencies.store.getOwnerAccountByEmail(parsed.data.email);
      // An account made with Google, Microsoft or an email link has no password: no password ever matches it,
      // and it takes as long to say so as for a wrong password.
      const passwordHash = account && hasUsablePassword(account.passwordHash) ? account.passwordHash : null;
      const valid = await verifyOwnerPassword(parsed.data.password, passwordHash ?? await dummyOwnerPasswordHash) && passwordHash !== null;
      if (!account || !valid || account.status === "suspended") return sendHtml(response, 401, renderOwnerLogin("Email or password is incorrect.", signIn.loginOptions(request, { errorField: "password", email: parsed.data.email, next })));
      const session = mintOwnerSession(account, dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
      response.setHeader("set-cookie", ownerSessionCookie(session, dependencies.env.NODE_ENV === "production"));
      return redirect(response, next ?? "/app");
    }
    if (await signIn.route(request, response, url, method, ip)) return;
    if (url.pathname === "/forgot" && (method === "GET" || method === "POST")) {
      const emailEnabled = Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL);
      if (method === "GET") return sendHtml(response, 200, renderForgotPassword({ emailEnabled, supportEmail: dependencies.env.SUPPORT_EMAIL ?? null }));
      if (!emailEnabled) return sendHtml(response, 200, renderForgotPassword({ emailEnabled, supportEmail: dependencies.env.SUPPORT_EMAIL ?? null }));
      if (!limiter.allow(`${ip}:forgot`, 5, 60 * 60_000)) throw new HttpError(429, "Too many reset requests");
      const typed = parseForm(await readBody(request, 4_000)).get("email") ?? "";
      const parsed = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).safeParse({ email: typed });
      if (!parsed.success) return sendHtml(response, 400, renderForgotPassword({ emailEnabled, supportEmail: dependencies.env.SUPPORT_EMAIL ?? null, error: "Enter the email on your account, like you@yourshop.com.", email: typed.slice(0, 254) }));
      const resetAccount = limiter.allow(`forgot-email:${parsed.data.email}`, 3, 60 * 60_000) ? await dependencies.store.getOwnerAccountByEmail(parsed.data.email) : null;
      if (resetAccount && resetAccount.status !== "suspended") {
        const { token, tokenHash } = createPasswordResetToken();
        const now = dependencies.clock.now();
        await dependencies.store.createPasswordReset(resetAccount.id, tokenHash, new Date(now.getTime() + 30 * 60_000).toISOString());
        const link = `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/reset?token=${encodeURIComponent(token)}`;
        await dependencies.store.enqueueNotification({
          id: randomUUID(), tenantId: resetAccount.tenantId, callId: null, channel: "email", destinationRef: `email:${resetAccount.email}`,
          body: formatEmailBody("Reset your Call Otto password", `Use this link within 30 minutes to choose a new password:\n\n${link}\n\nIf you didn't ask for this, ignore this email. Your password has not changed.`),
          priority: "high", state: "pending", attempts: 0, nextAttemptAt: now.toISOString(),
          idempotencyKey: `password-reset:${tokenHash}`, providerReceipt: null, lastError: null, createdAt: now.toISOString(), sentAt: null,
        });
      }
      // Same answer whether or not the account exists.
      return sendHtml(response, 200, renderForgotPassword({ emailEnabled, sent: true, supportEmail: dependencies.env.SUPPORT_EMAIL ?? null }));
    }
    if (url.pathname === "/reset" && method === "GET") return sendHtml(response, 200, renderResetPassword(url.searchParams.get("token") ?? "", "", dependencies.env.SUPPORT_EMAIL ?? null));
    if (url.pathname === "/reset" && method === "POST") {
      if (!limiter.allow(`${ip}:reset`, 10, 60 * 60_000)) throw new HttpError(429, "Too many attempts");
      const form = parseForm(await readBody(request, 4_000));
      const token = form.get("token") ?? "";
      const password = form.get("password") ?? "";
      if (password.length < PASSWORD_MIN_LENGTH || password.length > 200) return sendHtml(response, 400, renderResetPassword(token, `Make your password at least ${PASSWORD_MIN_LENGTH} characters.`, dependencies.env.SUPPORT_EMAIL ?? null, "password"));
      if (password !== form.get("confirm")) return sendHtml(response, 400, renderResetPassword(token, "The two passwords don’t match. Type the same one twice.", dependencies.env.SUPPORT_EMAIL ?? null, "confirm"));
      const accountId = token ? await dependencies.store.consumePasswordReset(hashPasswordResetToken(token), dependencies.clock.now().toISOString()) : null;
      if (!accountId) return sendHtml(response, 400, renderForgotPassword({ emailEnabled: Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL), supportEmail: dependencies.env.SUPPORT_EMAIL ?? null, error: "That reset link is expired or already used. Ask for a new one." }));
      const before = await dependencies.store.getOwnerAccountById(accountId);
      // The first proof: whoever signed up with this email before loses the teammates and invitations they made.
      // Before the email counts as proved, so a failure here leaves it unproved and the next proof runs it again.
      if (before && !before.emailVerifiedAt && before.role !== "member") {
        log({ level: "info", event: "owner_unproven_team_revoked", method: "reset", accountId, removed: await new TeamService(dependencies.store, dependencies.clock).reclaim(before.tenantId) });
      }
      await dependencies.store.updateOwnerPassword(accountId, await hashOwnerPassword(password), dependencies.clock.now().toISOString());
      // The reset link reached the account email, so the owner controls it: this password stays when they later use Google.
      await dependencies.store.markOwnerEmailVerified(accountId, dependencies.clock.now().toISOString(), null);
      log({ level: "info", event: "owner_password_reset", accountId });
      response.setHeader("set-cookie", clearOwnerSessionCookie(dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/login");
    }
    if (method === "GET" && url.pathname === "/logout") {
      response.setHeader("set-cookie", clearOwnerSessionCookie(dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/");
    }
    // Google sign-in returns to the calendar-connect callback (its one registered redirect URI); its signed state routes it here.
    if (method === "GET" && url.pathname === GOOGLE_SIGN_IN_CALLBACK && isSignInState(url.searchParams.get("state"))) return signIn.googleCallback(request, response, url);
    // Founder calendar connect returns to the one registered Google redirect URI. Handled here, before the owner
    // session gate, only with its own cookie and a founder-signed state; anything else falls through unchanged.
    if (method === "GET" && url.pathname === "/app/integrations/google/callback" && readCookie(request, FOUNDER_OAUTH_COOKIE) && await finishFounderConnect(request, response, url)) return;
    if (url.pathname.startsWith("/app")) return handleOwner(request, response, url);
    // Retire the old qualification form without breaking saved links.
    if (url.pathname === "/start") return redirect(response, "/signup");
    if (method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, { status: "ok" });
    if (method === "GET" && url.pathname === "/readyz") {
      await dependencies.store.ping();
      return sendJson(response, 200, { status: "ready" });
    }
    if (method === "GET" && url.pathname === "/activationz") {
      const report = await getActivationReport();
      return sendJson(response, report.go ? 200 : 503, { status: report.go ? "go" : "no_go", mode: report.mode, blocking_count: report.blocking.length });
    }
    if (method === "GET" && url.pathname === "/privacy") {
      return sendHtml(response, 200, renderPrivacy(await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID)));
    }
    if (method === "GET" && url.pathname === "/terms") {
      return sendHtml(response, 200, renderTerms(await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID), plans));
    }
    if (method === "POST" && url.pathname === "/webhooks/telnyx") return handleTelnyx(request, response);
    if (url.pathname.startsWith("/texml/voicemail")) return handleVoicemail(request, response, url);
    if (method === "POST" && url.pathname === "/webhooks/stripe") return handleStripe(request, response);
    if (method === "POST" && url.pathname.startsWith(SETUP_HELP_TOOL_PREFIX)) return handleSetupHelpTool(request, response, url.pathname.slice(SETUP_HELP_TOOL_PREFIX.length));
    const tool = method === "POST" ? toolForPath(url.pathname) : null;
    if (tool) return runTool(tool, request, response, url);
    if (url.pathname.startsWith("/admin")) return handleAdmin(request, response, url);
    throw new HttpError(404, "Not found");
  }

  /**
   * Order matters: authenticate, take the call id from the provider header, rate-limit and charge the durable
   * per-call budget, and only then parse. Invalid arguments therefore count toward the cap, and a call with no
   * id never runs a tool or shares a bucket with other shops.
   */
  async function handleToolRoute(tool: VoiceToolName, request: IncomingMessage, response: ServerResponse, url: URL, signal: AbortSignal): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    const callId = toolCallId(request, rawBody);
    if (!callId) throw new ToolLimitError(tool, "missing_call_id");
    // Per call, never per IP: Telnyx sends every shop's tool calls from the same addresses.
    if (!limiter.allow(`provider:${callId}:${tool}`, 240, 60_000)) throw new ToolLimitError(tool, "rate_limited");
    await spendToolBudget(callId, tool);
    signal.throwIfAborted();
    const context: ToolRequest = { name: tool, rawBody, callId, signal };
    const result = await toolResult(url.pathname, context);
    signal.throwIfAborted();
    if (!response.headersSent) sendJson(response, 200, result);
  }

  async function toolResult(pathname: string, tool: ToolRequest): Promise<unknown> {
    if (pathname === "/tools/save-intake") return handleIntake(tool);
    if (pathname === "/tools/approved-answer") {
      const input = parseTool(tool, baseToolSchema.extend({ kind: z.enum(["price", "answer"]), key: z.string().max(120) }).strict());
      requireToolCallId(tool, input.provider_call_id);
      const tenantId = await tenantForCall(input.provider_call_id);
      await requireOperational(tenantId);
      const answer = approvedAnswer(await dependencies.store.getConfig(tenantId), input.kind, input.key);
      await service.recordAnswerLookup({ tenantId, providerCallId: input.provider_call_id, kind: input.kind, approved: answer.status === "approved" });
      return { ...answer, wrap_up: await service.wrapUp(input.provider_call_id) };
    }
    if (pathname === "/tools/check-service-area") return handleServiceArea(tool);
    if (pathname === "/tools/check-availability") return handleAvailability(tool);
    if (pathname === "/tools/triage") return handleTriage(tool);
    if (pathname === "/tools/book") return handleBooking(tool);
    if (pathname === "/tools/request-human") return handleHandoff(tool);
    if (pathname === "/tools/mark-spam") {
      const input = parseTool(tool, baseToolSchema.extend({ from_number: providerFromNumber, category: z.enum(SPAM_CATEGORIES), caller_quote: z.string().min(1).max(500) }));
      requireToolCallId(tool, input.provider_call_id);
      const tenantId = await tenantForCall(input.provider_call_id);
      await requireOperational(tenantId);
      return service.markSpam({ tenantId, providerCallId: input.provider_call_id, fromNumber: await callerNumber(input.provider_call_id, input.from_number), category: input.category, callerQuote: input.caller_quote });
    }
    throw new HttpError(404, "Not found");
  }

  /**
   * Validate a tool body. Whatever had to be tolerated to get there (nulls, a dropped optional field, an
   * unusable caller number) is logged by kind and field name, so a broken provider preset never hides.
   */
  function parseTool<S extends z.ZodObject>(tool: ToolRequest, schema: S): z.infer<S> {
    const sent = unwrapToolPayload(parseJson<unknown>(tool.rawBody));
    const input = schema.parse(withoutNullFields(sent));
    const repairs = inputRepairs(schema, sent, input);
    if (repairs) log({ level: "warn", event: "tool_input_repaired", tool: tool.name, ...repairs });
    return input;
  }

  /** The caller's number for a tool: the provider's value when usable, otherwise the number the call started with. */
  async function callerNumber(providerCallId: string, provided: string): Promise<string> {
    if (provided !== UNKNOWN_CALLER) return provided;
    return (await dependencies.store.getCallByProviderId(providerCallId))?.fromNumber ?? UNKNOWN_CALLER;
  }

  /** The signed payload must name the call the budget was charged to. */
  function requireToolCallId(tool: ToolRequest, providerCallId: string): void {
    if (providerCallId !== tool.callId) throw new HttpError(401, "Telnyx call identifier does not match the signed tool payload");
  }

  // ---- React owner app (web/dist) ----------------------------------------------
  function loadOwnerWebIndex(): Promise<string | null> {
    if (!dependencies.ownerWeb) return Promise.resolve(null);
    ownerWebIndex ??= readFile(resolve(dependencies.ownerWeb.dir, "index.html"), "utf8").then((html) => analyticsPage(html, false)).catch(() => null);
    return ownerWebIndex;
  }
  async function sendOwnerWeb(response: ServerResponse, microphone = false): Promise<boolean> {
    const html = await loadOwnerWebIndex();
    if (!html) return false;
    // Only the signed-in owner app may use the microphone ("Say it" in Names and words); every other page sends microphone=().
    if (microphone) response.setHeader("permissions-policy", "camera=(), microphone=(self), geolocation=()");
    sendHtml(response, 200, html);
    return true;
  }
  async function serveWebAsset(response: ServerResponse, name: string): Promise<void> {
    const extension = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.([a-z0-9]+)$/.exec(name)?.[1];
    if (!dependencies.ownerWeb || !extension || !WEB_TYPES[extension]) throw new HttpError(404, "Not found");
    const body = await readFile(resolve(dependencies.ownerWeb.dir, "assets", name)).catch(() => null);
    if (!body) throw new HttpError(404, "Not found");
    response.writeHead(200, { "content-type": WEB_TYPES[extension]!, "content-length": body.length, "cache-control": "public, max-age=31536000, immutable" });
    response.end(body);
  }

  // ---- Recordings: look up once, then stream from our origin so playback starts at once ----
  async function recordingDownloadUrl(providerCallId: string): Promise<string | null> {
    const now = Date.now();
    const cached = recordingUrls.get(providerCallId);
    if (cached && cached.expiresAt > now) return cached.url;
    const url = await recordingClient!.getDownloadUrl(providerCallId);
    // A miss is remembered too (5 minutes), so a call with no recording never waits on Telnyx at every view.
    if (recordingUrls.size > 500) recordingUrls.delete(recordingUrls.keys().next().value!);
    recordingUrls.set(providerCallId, { url, expiresAt: now + (url ? 4 : 5) * 60_000 });
    return url;
  }
  async function streamRecording(request: IncomingMessage, response: ServerResponse, providerCallId: string, downloadUrl: string): Promise<void> {
    const range = typeof request.headers.range === "string" && /^bytes=\d*-\d*$/.test(request.headers.range) ? request.headers.range : null;
    // Abort the download if Telnyx's storage is slow or the listener leaves.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    request.once("close", () => controller.abort());
    const upstream = await (dependencies.fetcher ?? fetch)(downloadUrl, { signal: controller.signal, ...(range ? { headers: { range } } : {}) })
      .catch(() => null)
      .finally(() => clearTimeout(timer));
    const contentType = upstream?.headers.get("content-type") ?? "";
    const audioLike = contentType.startsWith("audio/") || contentType.startsWith("application/octet-stream") || contentType === "";
    if (upstream?.status === 416) {
      await upstream.body?.cancel().catch(() => undefined);
      response.writeHead(416, { "content-range": upstream.headers.get("content-range") ?? "bytes */*", "cache-control": "no-store" });
      response.end();
      return;
    }
    if (!upstream || (upstream.status !== 200 && upstream.status !== 206) || !upstream.body || (upstream.url !== "" && !upstream.url.startsWith("https://")) || !audioLike) {
      await upstream?.body?.cancel().catch(() => undefined);
      // An expired or revoked link is looked up again next time.
      if (!upstream || [401, 403, 404].includes(upstream.status)) recordingUrls.delete(providerCallId);
      throw new HttpError(502, "The recording could not be loaded. Please try again.");
    }
    const headers: Record<string, string> = {
      "content-type": contentType.startsWith("audio/") ? contentType : "audio/mpeg",
      "accept-ranges": "bytes",
      // Signed-in audio: never kept in any cache, not even this browser's.
      "cache-control": "private, no-store",
    };
    for (const name of ["content-length", "content-range"]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    response.writeHead(upstream.status, headers);
    await pipeline(Readable.fromWeb(upstream.body as never), response).catch(() => controller.abort());
  }

  // ---- Owner JSON API ------------------------------------------------------------
  async function authenticateOwner(request: IncomingMessage): Promise<{ session: OwnerSession; account: OwnerAccount } | null> {
    const session = verifyOwnerSession(readCookie(request, "afo_owner"), dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
    if (!session) return null;
    const account = await dependencies.store.getOwnerAccountById(session.accountId);
    if (!account || account.tenantId !== session.tenantId || account.status === "suspended" || !sessionMatchesAccount(session, account)) return null;
    return { session, account };
  }
  async function readApiJson(request: IncomingMessage, session: OwnerSession, limit: number): Promise<unknown> {
    // JSON plus a header token: a cross-site form can send neither.
    if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Send JSON");
    const token = request.headers["x-csrf-token"];
    if (!verifyOwnerCsrf(session, typeof token === "string" ? token : null)) throw new HttpError(403, "Invalid CSRF token");
    const raw = await readBody(request, limit);
    return raw.trim() ? parseJson<unknown>(raw) : {};
  }
  async function ownerDashboardModel(account: OwnerAccount, csrf: string) {
    const subscription = await dependencies.store.getSubscription(account.tenantId);
    const [config, calls, tasks, usage, googleConnected, lineNumber, ownerMobile, hoursSetAt, completedAt, smsConsent, helpTeamAt, helpAskedAt] = await Promise.all([
      dependencies.store.getConfig(account.tenantId),
      dependencies.store.listCalls(account.tenantId, 50),
      dependencies.store.listCallbackTasks(account.tenantId, 100),
      dependencies.store.getUsageSummary(account.tenantId, ...currentBillingPeriod(dependencies.clock.now(), subscription?.currentPeriodEnd)),
      isGoogleConnected(dependencies.env, dependencies.store, account.tenantId),
      dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number"),
      dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
      dependencies.store.getIntegrationSecret(account.tenantId, "onboarding", "hours_set_at"),
      dependencies.store.getIntegrationSecret(account.tenantId, "onboarding", "completed_at"),
      dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner_sms_consent"),
      dependencies.store.getIntegrationSecret(account.tenantId, "forwarding", "help_team_at"),
      dependencies.store.getIntegrationSecret(account.tenantId, "forwarding", "help_requested_at"),
    ]);
    const model = apiDashboard({
      account, config, calls, tasks, usage, googleConnected, subscription, csrf, lineNumber, ownerMobile,
      smsConsent: Boolean(smsConsent), textsLive: dependencies.env.TELNYX_MESSAGING_APPROVED, helpTeam: Boolean(helpTeamAt && helpAskedAt && helpTeamAt >= helpAskedAt),
      // "Didn't ring? Book a time": the same signed booking page our team's email links to.
      helpBookUrl: dependencies.env.SESSION_SIGNING_KEY ? `/book-setup?t=${encodeURIComponent(founderBookingToken(dependencies.env.SESSION_SIGNING_KEY, account.tenantId, dependencies.clock.now()))}` : null,
      googleAvailable: anyGoogleClient(dependencies.env),
      chargeNote: stripeClient ? planCharge(currentPlan(known, config.planId), config.timezone, config.unlimitedCalls === true) : null,
      plans: apiPlans(config.timezone),
      guarantee: await guarantee.status(account.tenantId),
      onboarding: { hoursSet: Boolean(hoursSetAt), completed: Boolean(completedAt) },
      forwarding: await readForwarding(account.tenantId),
      checkCallerId: dependencies.env.TELNYX_CHECK_CONNECTION_ID && !dependencies.env.PROVIDER_TEST_MODE ? dependencies.env.TELNYX_FROM_NUMBER ?? null : null,
      checkoutConfigured: Boolean(stripeClient || dependencies.env.FOUNDING_CHECKOUT_URL),
      now: dependencies.clock.now().toISOString(),
      preview: false,
    });
    // Opaque ids only, so the browser can identify the owner and group by shop without email or phone.
    const push = { publicKey: vapid?.publicKey ?? null, devices: vapid ? (await listPushSubscriptions(dependencies.store, account.tenantId)).length : 0 };
    return telemetry.enabled ? { ...model, push, analytics: { distinctId: account.id, tenantId: account.tenantId } } : { ...model, push };
  }
  /**
   * Settings > Names and words, "Say it" (walk 11-26, SET-05). POST saves the owner's clip of one word and turns it
   * into that word's "sounds like" text; GET plays it back (this shop's owner only); DELETE removes the clip.
   */
  async function wordClipApi(request: IncomingMessage, response: ServerResponse, url: URL, account: OwnerAccount, session: OwnerSession): Promise<void> {
    const method = request.method ?? "GET";
    const tenantId = account.tenantId;
    if (method === "GET") {
      const clip = await dependencies.store.getWordClip(tenantId, url.searchParams.get("term") ?? "");
      // Another shop's word is simply not found.
      if (!clip) throw new HttpError(404, "Not found");
      return sendClip(request, response, clip.audio, clip.mimeType);
    }
    if (method === "DELETE") {
      const body = await readApiJson(request, session, 2_000) as { term?: unknown };
      if (typeof body.term !== "string" || !body.term.trim()) throw new HttpError(400, "Which word?");
      await dependencies.store.deleteWordClip(tenantId, body.term);
      return sendJson(response, 200, { removed: true });
    }
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    if (!limiter.allow(`word-clip:${tenantId}`, 30, 60 * 60_000)) throw new HttpError(429, "Too many recordings. Try again in a bit.");
    // base64 grows the clip by a third.
    const upload = parseClipUpload(await readApiJson(request, session, Math.ceil(WORD_CLIP_MAX_BYTES * 4 / 3) + 2_000));
    if ("error" in upload) throw new HttpError(upload.status, upload.error);
    let heard: string | null = null;
    if (transcriber) {
      try {
        heard = cleanHeard(await transcriber.transcribe(upload.audio, upload.mimeType));
      } catch (error) {
        // The clip and its check stay; the typed "sounds like" is left alone.
        log({ level: "warn", event: "word_clip_transcribe_failed", tenantId, error: safeError(error) });
      }
    }
    const now = dependencies.clock.now().toISOString();
    const saved = await dependencies.store.withLock(`config:${tenantId}`, async () => {
      await dependencies.store.saveWordClip({ tenantId, term: upload.term, mimeType: upload.mimeType, audio: upload.audio, heard, createdAt: now });
      if (!heard) return null;
      const config = await dependencies.store.getConfig(tenantId);
      const updated = { ...config, pronunciations: withPronunciation(config.pronunciations, upload.term, heard) };
      await dependencies.store.saveConfig(updated);
      return updated;
    });
    log({ level: "info", event: "word_clip_saved", tenantId, heard: Boolean(heard) });
    return sendJson(response, 200, {
      term: upload.term, heard, savedAt: now,
      // The saved "Word: sounds like" lines, so the page shows the new text as saved.
      pronunciations: saved ? apiSettings(saved, dependencies.clock.now()).pronunciations : null,
    });
  }

  /** One clip, with byte ranges: iPhone Safari won't play audio from a server that ignores Range. */
  function sendClip(request: IncomingMessage, response: ServerResponse, audio: Buffer, mimeType: string): void {
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
    const headers = { "content-type": mimeType, "accept-ranges": "bytes", "cache-control": "private, no-store" };
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, audio.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      if (start >= audio.length || start > end) {
        response.writeHead(416, { ...headers, "content-range": `bytes */${audio.length}` });
        response.end();
        return;
      }
      response.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${audio.length}`, "content-length": end - start + 1 });
      response.end(audio.subarray(start, end + 1));
      return;
    }
    response.writeHead(200, { ...headers, "content-length": audio.length });
    response.end(audio);
  }

  async function handleOwnerApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const auth = await authenticateOwner(request);
    if (!auth) return sendJson(response, 401, { error: "Sign in again", login: "/login" });
    const { session, account } = auth;
    const method = request.method ?? "GET";
    const owner = account.role !== "member";
    if (method === "GET" && url.pathname === "/api/app/dashboard") return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    if (url.pathname === "/api/app/team" || url.pathname.startsWith("/api/app/team/")) {
      if (method === "POST" && url.pathname === "/api/app/team/invite" && !limiter.allow(`invite:${account.id}`, 10, 60 * 60_000)) throw new HttpError(429, "Too many invitations. Please try again later.");
      if (method === "POST" && url.pathname === "/api/app/team/confirm-email" && !limiter.allow(`email-confirm:${account.id}`, 3, 60 * 60_000)) throw new HttpError(429, "We just sent one. Check your email, or try again in an hour.");
      return teamApi(request, response, url, dependencies, account, session, (limit) => readApiJson(request, session, limit));
    }
    // The review account has no line: no number, carrier lookup, test call or setup-helper call, ever.
    if (method === "POST" && /^\/api\/app\/line\/(?:business-number|check|help|go-live)$/.test(url.pathname) && isCompStatus((await dependencies.store.getSubscription(account.tenantId))?.status)) {
      throw new HttpError(409, REVIEW_NO_LINE);
    }
    if (method === "POST" && url.pathname === "/api/app/push/subscribe") {
      if (!vapid) throw new HttpError(404, "Call alerts on this phone aren’t available yet.");
      const subscription = parsePushSubscription(await readApiJson(request, session, 4_000));
      if (!subscription) throw new HttpError(400, "This browser can’t get call alerts. Try Safari on iPhone (added to your Home Screen) or Chrome on Android.");
      if (!limiter.allow(`push-subscribe:${account.tenantId}`, 20, 60 * 60_000)) throw new HttpError(429, "Too many tries. Please try again in a bit.");
      const now = dependencies.clock.now().toISOString();
      await savePushSubscription(dependencies.store, account.tenantId, { ...subscription, accountId: account.id }, now);
      const device = deviceId(subscription.endpoint);
      // A first alert right away, to this phone only, so the owner sees it work.
      await dependencies.store.enqueueNotification(ownerPushNotification({
        tenantId: account.tenantId, callId: null, destinationRef: `device:${device}`, now,
        keyBase: `push-welcome:${account.tenantId}:${device}:${now}`,
        message: { title: "Call alerts are on", body: "You’ll get an alert like this for every new call.", url: "/app", tag: "push-welcome" },
      }));
      log({ level: "info", event: "push_subscribed", tenantId: account.tenantId, device });
      telemetry.capture("push_alerts_on", account.id, account.tenantId);
      return sendJson(response, 200, { on: true, devices: (await listPushSubscriptions(dependencies.store, account.tenantId)).length });
    }
    if (method === "POST" && url.pathname === "/api/app/alerts/urgent-calls") {
      if (!owner) throw new HttpError(403, "Only the owner can change emergency calls");
      const body = await readApiJson(request, session, 1_000) as { on?: unknown };
      if (typeof body.on !== "boolean") throw new HttpError(400, "Say on or off");
      const now = dependencies.clock.now().toISOString();
      if (body.on) {
        const mobile = await dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary");
        if (!mobile) throw new HttpError(400, "Add your mobile number first.");
        await grantOwnerCallConsent(dependencies.store, account.tenantId, { at: now, source: "settings", ip: requestIp(request), phone: mobile, wording: OWNER_CALL_CONSENT_SETTINGS_VERSION });
      } else {
        await revokeOwnerCallConsent(dependencies.store, account.tenantId, { at: now, source: "settings" });
      }
      log({ level: "info", event: body.on ? "owner_calls_opted_in" : "owner_calls_opted_out", tenantId: account.tenantId, source: "settings" });
      return sendJson(response, 200, { urgentCalls: await urgentCallsState(account.tenantId) });
    }
    if (method === "POST" && url.pathname === "/api/app/alerts/texts") {
      // The text-alert consent box in Settings › Alerts. Records consent exactly as the old setup page did: the
      // number, owner_sms_consent evidence (time, wording version, IP) and one confirmation text for a new opt-in.
      // Nothing else about the shop changes.
      if (!owner) throw new HttpError(403, "Only the owner can change text alerts");
      const body = await readApiJson(request, session, 1_000) as { on?: unknown; phone?: unknown };
      if (typeof body.on !== "boolean") throw new HttpError(400, "Say on or off");
      const phoneInput = typeof body.phone === "string" ? body.phone.trim() : "";
      const phone = phoneInput ? normalizeUsPhone(phoneInput) : null;
      if (phoneInput && !phone) throw new HttpError(400, "Enter a valid US mobile number, like (941) 555-0123");
      let optedInPhone: string | null = null;
      await dependencies.store.withLock(`config:${account.tenantId}`, async () => {
        const current = await dependencies.store.getConfig(account.tenantId);
        const previousPhone = await dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary");
        if (body.on && !phone && !previousPhone) throw new HttpError(400, "Add your mobile number for text alerts");
        // A new opt-in (texts were off, or a different number): confirm it by text once.
        if (body.on && (current.ownerNotificationRefs.length === 0 || (phone && phone !== previousPhone))) optedInPhone = phone ?? previousPhone;
        if (phone) await dependencies.store.saveIntegrationSecret(account.tenantId, "notifications", "owner-primary", phone);
        await dependencies.store.saveConfig({ ...current, ownerNotificationRefs: body.on ? ["owner-primary"] : [], ownerTransferNumberRef: "owner-primary" });
      });
      if (body.on) {
        await dependencies.store.saveIntegrationSecret(account.tenantId, "notifications", "owner_sms_consent", JSON.stringify({ at: dependencies.clock.now().toISOString(), source: "settings", wording: SMS_CONSENT_VERSION, ip: requestIp(request) }));
      }
      if (optedInPhone) await queueOwnerOptInConfirmation(account.tenantId, optedInPhone, `owner-optin:${account.tenantId}:${dependencies.clock.now().toISOString()}`);
      log({ level: "info", event: body.on ? "owner_texts_opted_in" : "owner_texts_opted_out", tenantId: account.tenantId, source: "settings" });
      return sendJson(response, 200, { texts: await textsState(account.tenantId) });
    }
    if (method === "POST" && url.pathname === "/api/app/push/unsubscribe") {
      const body = await readApiJson(request, session, 4_000) as { endpoint?: unknown };
      if (typeof body.endpoint === "string") await removePushSubscriptions(dependencies.store, account.tenantId, [body.endpoint]);
      return sendJson(response, 200, { on: false, devices: (await listPushSubscriptions(dependencies.store, account.tenantId)).length });
    }
    if (method === "POST" && url.pathname === "/api/app/line/business-number") {
      if (!owner) throw new HttpError(403, "Only the owner can set up call forwarding");
      const body = await readApiJson(request, session, 1_000) as { number?: unknown; family?: unknown };
      if (!limiter.allow(`business-number:${account.tenantId}`, 30, 60 * 60_000)) throw new HttpError(429, "Too many tries. Please try again in a bit.");
      const number = typeof body.number === "string" ? normalizeUsPhone(body.number) : null;
      if (!number) throw new HttpError(400, "Enter your business phone number, like (941) 555-0123");
      const lineNumber = await dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number");
      if (lineNumber && number === lineNumber) throw new HttpError(400, "That’s your Call Otto number. Enter the number your customers call today.");
      const chosen = body.family === "verizon" || body.family === "gsm" || body.family === "office" ? body.family as CarrierFamily : null;
      const previous = await readForwarding(account.tenantId);
      let carrier: CarrierInfo;
      if (chosen) {
        carrier = { name: previous.businessNumber === number ? previous.carrier?.name ?? null : null, lineType: previous.businessNumber === number ? previous.carrier?.lineType ?? null : null, family: chosen, chosen: true };
      } else if (previous.businessNumber === number && previous.carrier) {
        carrier = previous.carrier;
      } else {
        if (!limiter.allow(`carrier-lookup:${account.tenantId}`, 10, 60 * 60_000)) throw new HttpError(429, "Too many tries. Please try again in a bit.");
        const found = dependencies.env.TELNYX_API_KEY
          ? await new TelnyxForwardingClient({ apiKey: dependencies.env.TELNYX_API_KEY, ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}) })
            .lookupCarrier(number).catch((error) => { log({ level: "warn", event: "carrier_lookup_failed", tenantId: account.tenantId, error: safeError(error) }); return { name: null, lineType: null }; })
          : { name: null, lineType: null };
        carrier = { ...found, family: carrierFamily(found.name, found.lineType), chosen: false };
      }
      // A different phone: what worked on the old one says nothing about this one, so it gets the setup steps again.
      if (previous.businessNumber && previous.businessNumber !== number) {
        // A test still ringing the old phone could forward and "prove" the new number: end it first.
        await hangUpLiveCheck(account.tenantId);
        for (const key of ["confirmed_at", "check", "previous_check", "tested_for"]) await dependencies.store.deleteIntegrationSecret(account.tenantId, "forwarding", key);
      }
      await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", number);
      await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify(carrier));
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    if (method === "POST" && url.pathname === "/api/app/line/check") {
      if (!owner) throw new HttpError(403, "Only the owner can check call forwarding");
      await readApiJson(request, session, 1_000);
      await startForwardingCheck(account.tenantId);
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    if (method === "POST" && url.pathname === "/api/app/line/handoff") {
      // The computer's QR: a fresh 15-minute short link (/d/<8 letters>) that shows the code on a phone that isn't
      // signed in. Short, so the QR stays small and sparse enough for a phone camera to read off a laptop screen.
      if (!owner) throw new HttpError(403, "Only the owner can set up call forwarding");
      await readApiJson(request, session, 1_000);
      if (!limiter.allow(`handoff:${account.tenantId}`, 60, 60 * 60_000)) throw new HttpError(429, "Too many tries. Please try again in a bit.");
      return sendJson(response, 200, { url: await newHandoffLink(account.tenantId) });
    }
    if (method === "POST" && url.pathname === "/api/app/line/handoff/email") {
      // "Email me these steps": the same link to the owner's own email, lasting a day. Texting waits for carrier approval.
      if (!owner) throw new HttpError(403, "Only the owner can set up call forwarding");
      await readApiJson(request, session, 1_000);
      if (!limiter.allow(`handoff-email:${account.tenantId}`, 5, 24 * 60 * 60_000)) throw new HttpError(429, "We’ve sent a few already. Check your inbox and spam folder.");
      if (!dependencies.env.RESEND_API_KEY || !dependencies.env.RESEND_FROM_EMAIL) throw new HttpError(503, "Email isn’t switched on yet. Scan the code instead.");
      if (!await emailForwardingSteps(account.tenantId, account.email)) throw new HttpError(502, "That didn’t send. Please try again.");
      log({ level: "info", event: "handoff_emailed", tenantId: account.tenantId });
      return sendJson(response, 200, { sentTo: account.email });
    }
    if (method === "POST" && url.pathname === "/api/app/line/check/cancel") {
      // Cancel on a running test: hang up our call (if it's still ringing) and forget the test. The card goes back to
      // the last finished test (never "Forwarding works" over a later failure), or idle if there was none.
      if (!owner) throw new HttpError(403, "Only the owner can check call forwarding");
      await readApiJson(request, session, 1_000);
      await hangUpLiveCheck(account.tenantId);
      await dependencies.store.withLock(`forwarding-check:${account.tenantId}`, async () => {
        const previous = await dependencies.store.getIntegrationSecret(account.tenantId, "forwarding", "previous_check");
        if (previous) await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "check", previous);
        else await dependencies.store.deleteIntegrationSecret(account.tenantId, "forwarding", "check");
        await dependencies.store.deleteIntegrationSecret(account.tenantId, "forwarding", "previous_check");
      });
      log({ level: "info", event: "forwarding_check_cancelled", tenantId: account.tenantId });
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    if (method === "POST" && url.pathname === "/api/app/line/mode") {
      // After a test the phone answered itself: "Let Otto answer every call" (forward-all, no phone settings) or
      // "Keep my phone ringing first" (back to missed calls only). Shows the matching code to dial.
      if (!owner) throw new HttpError(403, "Only the owner can change call forwarding");
      const body = await readApiJson(request, session, 1_000) as { mode?: unknown };
      if (body.mode !== "always" && body.mode !== "overflow") throw new HttpError(400, "Pick every call or missed calls only");
      const mode = body.mode;
      if (!limiter.allow(`forwarding-mode:${account.tenantId}`, 20, 60 * 60_000)) throw new HttpError(429, "Too many tries. Please try again in a bit.");
      const changed = await dependencies.store.withLock(`config:${account.tenantId}`, async () => {
        const current = await dependencies.store.getConfig(account.tenantId);
        // "Ring me first" is any mode but every call: only leaving every call changes it, back to what it was
        // (after hours stays after hours).
        if (mode === "overflow" ? current.operationMode !== "always" : current.operationMode === "always") return null;
        const before = await dependencies.store.getIntegrationSecret(account.tenantId, "forwarding", "mode_before_every_call");
        const next = mode === "always" ? "always" : before === "after_hours" ? "after_hours" : "overflow";
        // Same as saving settings: the live assistant's coverage changes with the mode, not just the stored config.
        await saveAssistantConfig(dependencies.store, dependencies.env, { ...current, operationMode: next }, dependencies.fetcher).catch((error: unknown) => {
          log({ level: "error", event: "forwarding_mode_save_failed", tenantId: account.tenantId, error: safeError(error) });
          throw new HttpError(502, "We couldn’t change that just now. Nothing was changed. Try again in a minute.");
        });
        await rememberLegacyTestedFor(account.tenantId, current, next);
        if (mode === "always") await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "mode_before_every_call", current.operationMode);
        return next;
      });
      if (changed) log({ level: "info", event: "forwarding_mode_changed", tenantId: account.tenantId, mode: changed });
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    if (method === "POST" && url.pathname === "/api/app/line/help") {
      // "Call me now": Otto's setup helper calls the shop's saved owner mobile, and only that number.
      if (!owner) throw new HttpError(403, "Only the owner can ask for setup help");
      const helpRequest = await readApiJson(request, session, 1_000) as { device?: unknown };
      // Taps (a slow connection, two devices) are cheap to refuse; the real cap is the durable 3 calls a day below.
      if (!limiter.allow(`forwarding-help:${account.tenantId}`, 10, 24 * 60 * 60_000)) throw new HttpError(429, "Too many tries. Please try again tomorrow.");
      const [config, state, ownerPhone, lineNumber] = await Promise.all([
        dependencies.store.getConfig(account.tenantId),
        readForwarding(account.tenantId),
        dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
        dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number"),
      ]);
      const now = dependencies.clock.now().toISOString();
      const nowMs = Date.parse(now);
      await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "help_requested_at", now);
      // Otto's AI setup helper calls right away. If it can't, our team emails the owner a link to book a call; the
      // support email below tells us the request came in.
      const device = helpRequest.device === "iphone" || helpRequest.device === "android" ? helpRequest.device : "other";
      const callTo = ownerPhone && /^\+1[2-9]\d{9}$/.test(ownerPhone) ? ownerPhone : null;
      // Never ring a mobile that forwards every call to Otto (Otto would call Otto): every call is picked on the
      // business number they ring, or the last passed test was (or they left it untested) for every call.
      const loops = Boolean(callTo) && forwardsBackToOtto({ mode: config.operationMode, businessNumber: state.businessNumber, phone: callTo, testedFor: state.testedFor ?? null });
      if (loops) log({ level: "info", event: "setup_call_skipped_forwards_to_otto", tenantId: account.tenantId });
      // One setup call per shop at a time, written only under this lock (here and by the call's webhooks).
      const calling = await dependencies.store.withLock(`setup-call:${account.tenantId}`, async (): Promise<string | "limit" | "looped" | null> => {
        const current = readSetupCall(await dependencies.store.getIntegrationSecret(account.tenantId, "forwarding", "setup_call"));
        // Already ringing or on the call (a double tap, another device): that call carries it. Never dial over it.
        if (current?.to && setupCallLive(current, nowMs)) return current.to;
        if (loops) {
          await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "setup_call", JSON.stringify({ startedAt: now, to: callTo!, endedAt: now, outcome: "looped" } satisfies SetupCallRecord));
          return "looped";
        }
        // At most SETUP_CALLS_PER_DAY placed calls a day per shop, counted durably (restarts and replicas included).
        const placed = parseTimes(await dependencies.store.getIntegrationSecret(account.tenantId, "forwarding", "setup_calls_placed")).filter((at) => nowMs - Date.parse(at) < 24 * 60 * 60_000);
        if (placed.length >= SETUP_CALLS_PER_DAY) return "limit";
        if (setupCallsConfigured() && callTo && lineNumber && account.status !== "suspended") {
          const callControlId = await setupCaller()!
            .dial({ connectionId: dependencies.env.TELNYX_CHECK_CONNECTION_ID!, from: dependencies.env.TELNYX_FROM_NUMBER!, to: callTo, tenantId: account.tenantId, webhookUrl: `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx` })
            .catch((error) => { log({ level: "error", event: "setup_call_dial_failed", tenantId: account.tenantId, error: safeError(error) }); return null; });
          if (callControlId) {
            await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "setup_calls_placed", JSON.stringify([...placed, now]));
            await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "setup_call", JSON.stringify({ startedAt: now, callControlId, device, to: callTo } satisfies SetupCallRecord));
            // The helper's tools find this shop by the call they're on (signed by Telnyx), never by anything said.
            await dependencies.store.saveIntegrationSecret(PLATFORM_TENANT_ID, SETUP_HELP_PROVIDER, callControlId, account.tenantId);
            log({ level: "info", event: "setup_call_placed", tenantId: account.tenantId, callsToday: placed.length + 1 });
            return callTo;
          }
        }
        // No call is coming (not set up, no mobile, or the dial failed): clear the older, finished call so the app
        // shows our team's email.
        await dependencies.store.deleteIntegrationSecret(account.tenantId, "forwarding", "setup_call");
        return null;
      });
      if (calling === "limit") {
        // Our team's email (at most one a day) carries it from here.
        await founder.queueSafely(account.tenantId, "limit");
        const sent = await founder.lastEmail(account.tenantId).catch(() => null);
        log({ level: "info", event: "setup_call_limited", tenantId: account.tenantId });
        throw new HttpError(429, `Otto has called you a few times today. ${!sent ? "Book a time with our team instead." : sent.link ? "Our team emailed you a link to book a 10-minute call." : "Our team emailed you to set up a quick call."}`);
      }
      if (!calling) await founder.queueSafely(account.tenantId, "call_unavailable");
      if (dependencies.env.SUPPORT_EMAIL) {
        // The app says "we got it" only once this email is really in the outbox for this request.
        const queuedForTeam = await dependencies.store.enqueueNotification({
          id: randomUUID(), tenantId: account.tenantId, callId: null, channel: "email", destinationRef: `email:${dependencies.env.SUPPORT_EMAIL}`,
          body: formatEmailBody(`Forwarding help: ${config.businessName}`, [
            `${config.businessName} wants help setting up call forwarding.`,
            `Call them back: ${ownerPhone ?? state.businessNumber ?? "no number on file"}`,
            `Business number: ${state.businessNumber ?? "not entered"}`,
            `Carrier: ${state.carrier?.name ?? "unknown"} (${state.carrier?.family ?? "unknown"}, ${state.carrier?.lineType ?? "unknown line type"})`,
            `Forward to (Call Otto number): ${lineNumber ?? "line not turned on yet"}`,
            `Account: ${account.email}`,
          ].join("\n")),
          priority: "high", state: "pending", attempts: 0, nextAttemptAt: now,
          idempotencyKey: `forwarding-help:${account.tenantId}:${now.slice(0, 13)}`,
          providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
        });
        // A repeat in the same hour is the same email (idempotency key): it was already queued for this shop this
        // hour. An older request (another hour) never counts for this one.
        const earlier = await dependencies.store.getIntegrationSecret(account.tenantId, "forwarding", "help_team_at");
        const sameEmail = Boolean(earlier) && earlier!.slice(0, 13) === now.slice(0, 13);
        await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "help_team_at", queuedForTeam || sameEmail ? now : "");
      }
      log({ level: "warn", event: "forwarding_help_requested", tenantId: account.tenantId, emailed: Boolean(dependencies.env.SUPPORT_EMAIL), calling: Boolean(calling) && calling !== "looped", looped: calling === "looped" });
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    if (method === "POST" && url.pathname === "/api/app/line/go-live") {
      if (!owner) throw new HttpError(403, "Only the owner can turn on the line");
      await readApiJson(request, session, 1_000);
      if (!limiter.allow(`go-live:${account.tenantId}`, 6, 60 * 60_000)) throw new HttpError(429, "Too many attempts. Please try again later.");
      try {
        await goLive(account, null);
      } catch (error) {
        if (error instanceof HttpError && error.message.startsWith("Live provider prerequisites")) {
          throw new HttpError(409, "New lines are waiting on carrier approval. Your setup is saved; turn your line on here once it clears.");
        }
        if (error instanceof HttpError && error.message === ASSISTANT_TAKEN) throw new HttpError(409, OWNER_SETUP_STUCK);
        throw error;
      }
      const refreshed = await dependencies.store.getOwnerAccountById(account.id) ?? account;
      return sendJson(response, 200, await ownerDashboardModel(refreshed, session.csrf));
    }
    if (method === "POST" && url.pathname === "/api/app/onboarding/activate") {
      if (!owner) throw new HttpError(403, "Only the owner can turn on the line");
      const body = await readApiJson(request, session, 1_000) as { sessionId?: unknown };
      const sessionId = typeof body.sessionId === "string" && /^cs_[A-Za-z0-9_]{6,200}$/.test(body.sessionId) ? body.sessionId : null;
      if (sessionId) await confirmCheckout(account, sessionId);
      const activation = await activateLine(account);
      const refreshed = await dependencies.store.getOwnerAccountById(account.id) ?? account;
      return sendJson(response, 200, { ...(await ownerDashboardModel(refreshed, session.csrf)), activation });
    }
    if (method === "POST" && url.pathname === "/api/app/onboarding/hours") {
      if (!owner) throw new HttpError(403, "Only the owner can set the shop’s hours");
      const body = await readApiJson(request, session, 1_000) as Record<string, unknown>;
      let choice: ReturnType<typeof hoursFromChoice>;
      try { choice = hoursFromChoice(body); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Pick when you take jobs"); }
      await dependencies.store.withLock(`config:${account.tenantId}`, async () => {
        const current = await dependencies.store.getConfig(account.tenantId);
        await saveAssistantConfig(dependencies.store, dependencies.env, {
          ...current,
          bookableHours: choice.bookableHours,
          afterHours: { ...current.afterHours, ...choice.afterHours },
        }, dependencies.fetcher ?? fetch);
      });
      await dependencies.store.saveIntegrationSecret(account.tenantId, "onboarding", "hours_set_at", dependencies.clock.now().toISOString());
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    if (method === "POST" && url.pathname === "/api/app/onboarding/done") {
      if (!owner) throw new HttpError(403, "Only the owner can finish setup");
      await readApiJson(request, session, 1_000);
      await dependencies.store.saveIntegrationSecret(account.tenantId, "onboarding", "completed_at", dependencies.clock.now().toISOString());
      telemetry.capture("onboarding_completed", account.id, account.tenantId);
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    // Billing changes never charge on a tap: the owner app asks for a quote (Stripe's own preview, nothing written),
    // shows the exact amount, and only a confirmed change carrying that quote reaches Stripe.
    if (method === "POST" && url.pathname === "/api/app/billing/preview") {
      if (!owner) throw new HttpError(403, "Only the owner can change the plan");
      const body = await readApiJson(request, session, 1_000) as { plan?: unknown; unlimited?: unknown };
      const plan = plans.find((item) => item.id === normalizePlanId(body.plan));
      if (!plan) throw new HttpError(400, "Pick a plan");
      if (typeof body.unlimited !== "boolean") throw new HttpError(400, "Say on or off");
      if (!limiter.allow(`plan-preview:${account.tenantId}`, 120, 60 * 60_000)) throw new HttpError(429, "Please try again in a bit.");
      return sendJson(response, 200, await quoteChange(account, plan, body.unlimited));
    }
    if (method === "GET" && url.pathname === "/api/app/billing/summary") {
      if (!owner) throw new HttpError(403, "Only the owner can see billing");
      return sendJson(response, 200, await billingSummary(account));
    }
    // Card, bills and cancel all live on Plan and billing: nothing here sends the owner to Stripe unless the
    // embedded card form can't run, and then Stripe's own card page sends them back by itself.
    if (method === "GET" && url.pathname === "/api/app/billing/details") {
      if (!owner) throw new HttpError(403, "Only the owner can see billing");
      return sendJson(response, 200, await billingDetails(account));
    }
    if (method === "POST" && url.pathname === "/api/app/billing/card") {
      if (!owner) throw new HttpError(403, "Only the owner can change the card");
      const body = await readApiJson(request, session, 1_000) as { hosted?: unknown };
      if (!limiter.allow(`card-change:${account.tenantId}`, 20, 60 * 60_000)) throw new HttpError(429, "Please try again in a bit.");
      return sendJson(response, 200, await startCardChange(account, body.hosted === true));
    }
    if (method === "POST" && url.pathname === "/api/app/billing/card/complete") {
      if (!owner) throw new HttpError(403, "Only the owner can change the card");
      const body = await readApiJson(request, session, 1_000) as { sessionId?: unknown };
      const sessionId = typeof body.sessionId === "string" && /^cs_[A-Za-z0-9_]{6,200}$/.test(body.sessionId) ? body.sessionId : null;
      if (!sessionId) throw new HttpError(400, "Missing card session");
      await finishCardChange(account, sessionId);
      return sendJson(response, 200, await billingDetails(account));
    }
    if (method === "POST" && url.pathname === "/api/app/billing/card/sync") {
      if (!owner) throw new HttpError(403, "Only the owner can change the card");
      await readApiJson(request, session, 1_000);
      if (!limiter.allow(`card-change:${account.tenantId}`, 20, 60 * 60_000)) throw new HttpError(429, "Please try again in a bit.");
      await syncHostedCard(account);
      return sendJson(response, 200, await billingDetails(account));
    }
    if (method === "POST" && (url.pathname === "/api/app/billing/cancel" || url.pathname === "/api/app/billing/keep")) {
      if (!owner) throw new HttpError(403, "Only the owner can cancel the plan");
      await readApiJson(request, session, 1_000);
      if (!limiter.allow(`plan-cancel:${account.tenantId}`, 20, 60 * 60_000)) throw new HttpError(429, "Please try again in a bit.");
      await setCancel(account, url.pathname.endsWith("/cancel"));
      return sendJson(response, 200, await billingSummary(account));
    }
    if (method === "POST" && (url.pathname === "/api/app/billing/change" || url.pathname === "/api/app/billing/plan" || url.pathname === "/api/app/billing/unlimited")) {
      if (!owner) throw new HttpError(403, url.pathname.endsWith("/unlimited") ? "Only the owner can change Unlimited calls" : "Only the owner can change the plan");
      const body = await readApiJson(request, session, 2_000) as { plan?: unknown; unlimited?: unknown; on?: unknown; confirm?: unknown };
      const config = await dependencies.store.getConfig(account.tenantId);
      // /plan and /unlimited are the older one-field forms; /change names both. All three need the confirmed quote once paying.
      const plan = url.pathname.endsWith("/unlimited") ? currentPlan(known, config.planId) : plans.find((item) => item.id === normalizePlanId(body.plan));
      if (!plan) throw new HttpError(400, "Pick a plan");
      const unlimited = url.pathname.endsWith("/unlimited") ? body.on : url.pathname.endsWith("/plan") ? config.unlimitedCalls === true : body.unlimited;
      if (typeof unlimited !== "boolean") throw new HttpError(400, "Say on or off");
      if (!limiter.allow(`plan-change:${account.tenantId}`, 10, 60 * 60_000)) throw new HttpError(429, "That’s a lot of plan changes. Please try again in a bit.");
      await applyChange(account, plan, unlimited, parseConfirm(body.confirm));
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    if (method === "POST" && url.pathname === "/api/app/billing/lead-refund") {
      if (!owner) throw new HttpError(403, "Only the owner can request the refund");
      await readApiJson(request, session, 1_000);
      if (!limiter.allow(`lead-refund:${account.tenantId}`, 5, 60 * 60_000)) throw new HttpError(429, "Please try again in a bit.");
      try {
        await guarantee.refund(account.tenantId, "owner");
      } catch (error) {
        if (error instanceof GuaranteeError) throw new HttpError(error.status, error.message);
        log({ level: "error", event: "lead_guarantee_refund_failed", tenantId: account.tenantId, error: safeError(error) });
        throw new HttpError(502, "We couldn’t reach our payment processor. Reply to your receipt and we’ll refund you.");
      }
      telemetry.capture("lead_guarantee_refunded", account.id, account.tenantId, { by: "owner" });
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    if (url.pathname === "/api/app/words/clip") {
      if (!owner) throw new HttpError(403, "Only the owner can change shop settings");
      return wordClipApi(request, response, url, account, session);
    }
    if (url.pathname === "/api/app/settings") {
      if (!owner) throw new HttpError(403, "Only the owner can change shop settings");
      if (method === "PUT") {
        const body = await readApiJson(request, session, 64_000);
        let form: URLSearchParams;
        try { form = settingsForm(body); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Invalid settings"); }
        await saveOwnerSettings(account, form, requestIp(request));
      } else if (method !== "GET") throw new HttpError(405, "Method not allowed");
      const [config, googleConnected, ownerPhone, subscription] = await Promise.all([
        dependencies.store.getConfig(account.tenantId),
        isGoogleConnected(dependencies.env, dependencies.store, account.tenantId),
        dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
        dependencies.store.getSubscription(account.tenantId),
      ]);
      return sendJson(response, 200, {
        csrf: session.csrf,
        urgentCalls: await urgentCallsState(account.tenantId),
        texts: await textsState(account.tenantId),
        values: apiSettings(config, dependencies.clock.now()),
        // Names and words: the words the owner said ("Say it"), for the green check and Play.
        wordClips: (await dependencies.store.listWordClips(account.tenantId)).map((clip) => ({ term: clip.term, heard: clip.heard, savedAt: clip.createdAt })),
        // The tick boxes for "What you fix" and "What counts as an emergency" (the stored lists stay plain words).
        catalog: {
          // Walk 11-26 (SET-04): the same trade names as the website.
          trades: TRADES.filter((trade) => trade.key !== "other").map((trade) => ({ key: trade.key, label: tradeShortLabel(trade), services: trade.services })),
          emergencies: EMERGENCY_CHOICES.map((choice) => ({ key: choice.key, label: choice.label, trades: choice.trades, words: choice.words })),
          alwaysOnWords: ALWAYS_ON_WORDS,
          alwaysOnLine: ALWAYS_ON_LINE,
        },
        // A shop that only has a whole state ("FL") gets its own area offered, from the mobile's area code.
        areaSuggestion: (() => {
          const area = areaForPhone(ownerPhone);
          // One whole state, and the area code's cities are in it; several states would lose the others.
          const [only] = config.serviceAreaTerms;
          const oneState = config.serviceAreaTerms.length === 1 && /^[A-Z]{2}$/.test(only ?? "");
          return area && oneState && area.every((city) => city.endsWith(` ${only}`)) ? area.join(", ") : null;
        })(),
        status: account.status,
        // No password (Google, Microsoft or email link): deleting needs a sign-in from the last 10 minutes instead.
        signIn: { hasPassword: !isPasswordless(account.passwordHash), recent: signedInRecently(session) },
        businessName: config.businessName,
        shopId: account.tenantId,
        plan: (() => {
          const current = currentPlan(known, config.planId);
          // Already on Unlimited at a legacy price (Team at $179.99): its total is what Stripe charges, not today's.
          const offer = config.unlimitedCalls === true ? billedPlan(known, config) : current;
          return {
            id: current.id, label: current.label, flatMonthlyPriceCents: config.flatMonthlyPriceCents, includedCalls: config.includedCalls, overageCentsPerCall: config.overageCentsPerCall,
            paid: hasPlanAccess(subscription?.status), plans: apiPlans(config.timezone),
            // Legacy Pro keeps working but is no longer sold: the owner sees it as current and can move to Solo, Team or Fleet.
            sold: current.sold,
            unlimited: config.unlimitedCalls === true,
            unlimitedOffer: offer.unlimited ? { addOnCents: offer.unlimited.addOnCents, priceCents: offer.unlimited.priceCents, fairUseCalls: offer.unlimited.fairUseCalls } : null,
          };
        })(),
        integrations: {
          googleAvailable: anyGoogleClient(dependencies.env),
          googleConnected,
          ownerPhoneConfigured: Boolean(ownerPhone),
          ownerPhoneMasked: ownerPhone ? maskedPhone(ownerPhone) : null,
          weeklyEmailAvailable: Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL),
          directBookingAvailable: dependencies.env.DIRECT_BOOKING_BETA,
        },
      });
    }
    const exportMatch = /^\/api\/app\/shops\/([A-Za-z0-9_-]{1,80})\/calls\.csv$/.exec(url.pathname);
    if (method === "GET" && exportMatch?.[1]) {
      // Another shop's id is simply not found: never confirm that it exists.
      if (exportMatch[1] !== account.tenantId) throw new HttpError(404, "Not found");
      if (!owner) throw new HttpError(403, "Only the owner can export the shop's calls");
      const [config, calls] = await Promise.all([
        dependencies.store.getConfig(account.tenantId),
        dependencies.store.listCalls(account.tenantId, 100_000),
      ]);
      const body = callsCsv(calls, config.timezone, dependencies.clock.now());
      response.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${callsCsvFileName(dependencies.clock.now())}"`,
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    const taskMatch = /^\/api\/app\/calls\/([0-9a-f-]{36})\/task$/i.exec(url.pathname);
    if (method === "POST" && taskMatch?.[1]) {
      const body = await readApiJson(request, session, 4_000) as { action?: unknown; minutes?: unknown };
      const action = body.action === "complete" || body.action === "reopen" || body.action === "snooze" ? body.action : null;
      if (!action) throw new HttpError(400, "Choose complete, reopen or snooze");
      const task = await ownerTaskAction(account, taskMatch[1], action, typeof body.minutes === "number" ? body.minutes : undefined);
      return sendJson(response, 200, { task: apiTask(task) });
    }
    const callMatch = /^\/api\/app\/calls\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (callMatch?.[1] && method === "DELETE") {
      if (!owner) throw new HttpError(403, "Only the owner can delete call records");
      const body = await readApiJson(request, session, 1_000) as { confirm?: unknown };
      if (body.confirm !== "delete") throw new HttpError(400, "Deletion confirmation is required");
      const deleted = await deletionService.deleteCall(account.tenantId, callMatch[1])
        .catch(() => { throw new HttpError(502, "Provider deletion failed. The local record was retained so deletion can be retried."); });
      if (!deleted) throw new HttpError(404, "Call not found");
      return sendJson(response, 200, { deleted: true });
    }
    if (callMatch?.[1] && method === "GET") {
      const call = await dependencies.store.getCall(callMatch[1]);
      if (!call || call.tenantId !== account.tenantId) throw new HttpError(404, "Call not found");
      const [booking, task, notifications, events] = await Promise.all([
        dependencies.store.getBookingForCall(call.id),
        dependencies.store.getCallbackTaskForCall(call.id),
        dependencies.store.listNotifications(call.id),
        dependencies.store.listToolEvents(call.id),
      ]);
      // The end-of-call webhook saves the recording link; a call it never reached (or a recording Telnyx finished
      // later) is looked up once (cached), so a recorded call always has its player and an unrecorded one none.
      // A caller who said no to recording never gets a player, even if deleting the audio failed.
      const recorded = call.consentState !== "declined" && (call.recordingUrl?.startsWith("https://")
        || (call.outcome !== "in_progress" && recordingClient !== null && Boolean(await recordingDownloadUrl(call.providerCallId).catch(() => null))));
      const detail: ApiCallDetail = {
        call: apiCall(call),
        recordingUrl: recorded ? `/app/provider/telnyx/recordings/${encodeURIComponent(call.providerCallId)}?stream=1` : null,
        booking: booking ? { status: booking.status, requestedStart: booking.requestedStart } : null,
        task: task && task.tenantId === account.tenantId ? apiTask(task) : null,
        alerts: notifications.filter((item) => item.channel === "sms" && item.tenantId === account.tenantId).map((item) => ({ priority: item.priority, state: item.state })),
        canDelete: owner,
        path: buildCallPath({ call, events, booking, callbackTask: task?.tenantId === account.tenantId ? task : null, notifications: notifications.filter((item) => item.tenantId === account.tenantId), now: dependencies.clock.now() }),
      };
      return sendJson(response, 200, detail);
    }
    const callPathMatch = /^\/api\/app\/calls\/([0-9a-f-]{36})\/path$/i.exec(url.pathname);
    if (callPathMatch?.[1] && method === "GET") {
      if (!limiter.allow(`call-path:${account.id}:${callPathMatch[1]}`, 90, 60_000)) throw new HttpError(429, "Too many requests");
      const call = await dependencies.store.getCall(callPathMatch[1]);
      if (!call || call.tenantId !== account.tenantId) throw new HttpError(404, "Call not found");
      response.setHeader("cache-control", "no-store");
      // The call too, so the header, safety note and facts tick along with the path.
      return sendJson(response, 200, { path: await callPathFor(call), call: apiCall(call) });
    }
    throw new HttpError(404, "Not found");
  }

  /** A fresh short link (/d/<id>) to this shop's code, stored with its expiry. */
  async function newHandoffLink(tenantId: string, ttlMs?: number): Promise<string> {
    const id = shortHandoffId(randomBytes(8));
    await dependencies.store.saveIntegrationSecret(PLATFORM_TENANT_ID, HANDOFF_PROVIDER, id, shortHandoffRecord(tenantId, dependencies.clock.now(), ttlMs));
    // Each shop's links are listed, and the expired ones deleted whenever a new one is made, so QR refreshes never
    // pile up. A link still open on the phone keeps working until it expires.
    let ids: string[] = [];
    try { ids = JSON.parse(await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "handoff_ids") ?? "[]") as string[]; } catch { ids = []; }
    const live: string[] = [];
    for (const old of Array.isArray(ids) ? ids : []) {
      if (typeof old !== "string" || !isShortHandoffId(old)) continue;
      if (readShortHandoff(await dependencies.store.getIntegrationSecret(PLATFORM_TENANT_ID, HANDOFF_PROVIDER, old), dependencies.clock.now())) live.push(old);
      else await dependencies.store.deleteIntegrationSecret(PLATFORM_TENANT_ID, HANDOFF_PROVIDER, old);
    }
    await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "handoff_ids", JSON.stringify([...live, id]));
    return `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}${SHORT_HANDOFF_PREFIX}${id}`;
  }

  /** The phone side of the forwarding QR: this shop's code, no sign-in, for 15 minutes. Expired or forged: a page that says so. */
  async function handleDialHandoff(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    const short = url.pathname.startsWith(SHORT_HANDOFF_PREFIX) ? url.pathname.slice(SHORT_HANDOFF_PREFIX.length) : null;
    const handoff = short !== null
      ? (isShortHandoffId(short) ? readShortHandoff(await dependencies.store.getIntegrationSecret(PLATFORM_TENANT_ID, HANDOFF_PROVIDER, short), dependencies.clock.now()) : null)
      : readDialHandoffToken(dependencies.env.SESSION_SIGNING_KEY!, decodeURIComponent(url.pathname.slice("/dial/".length)), dependencies.clock.now());
    if (!handoff) return sendHtml(response, 410, renderErrorPage({ status: 410, title: "This code link expired", message: "Open the setup page on your computer for a new one.", back: { href: "/login", label: "Sign in instead" } }));
    const { config, state, lineNumber, plan } = await handoffPlan(handoff.tenantId);
    if (!plan || !state.businessNumber || !lineNumber) return sendHtml(response, 409, renderErrorPage({ status: 409, title: "No code yet", message: "Finish the forwarding step on your computer first, then scan again.", back: { href: "/login", label: "Sign in instead" } }));
    const agent = String(request.headers["user-agent"] ?? "");
    const device = /iPhone|iPad|iPod/i.test(agent) ? "iphone" : /Android/i.test(agent) && !/Firefox/i.test(agent) ? "android" : "other";
    // The same steps the computer shows, one code per screen: when our last test found every call still forwarded,
    // the clear code first, then (Next) the shop's code. An office line does it in the phone company's website.
    // An iPhone on a GSM-family carrier uses its Settings switch for every call (and to clear it), code behind a link.
    const update = forwardingUpdate(plan, config.operationMode, state.testedFor ?? null);
    const forwardsAll = forwardingCheckStatus(state.check, state.confirmedAt, dependencies.clock.now().toISOString()) === "forwards_all";
    const steps = forwardingSteps({ device: device === "other" ? "phone" : device, family: plan.family, everyCall: plan.forwardsAll, leavingEveryCall: Boolean(update?.leavingEveryCall) });
    const clearFirst = (forwardsAll || steps.clearFirst) && plan.off && url.searchParams.get("step") !== "code" ? { code: plan.off, dialLink: plan.offDialLink } : null;
    const settings = (clearFirst ? steps.clear : steps.on) === "settings" ? { ottoNumber: prettyPhone(lineNumber) ?? lineNumber, digits: forwardToDigits(lineNumber) } : null;
    const what = (forwardsAll || update?.leavingEveryCall) && !plan.on && plan.family === "office"
      ? `In your phone company’s website or app, turn off forward all calls. Then forward calls you don’t answer to ${prettyPhone(lineNumber) ?? lineNumber}.`
      : plan.what;
    return sendHtml(response, 200, renderDialHandoff({ businessNumber: prettyPhone(state.businessNumber) ?? state.businessNumber, code: plan.on, what, dialLink: plan.dialLink, device, family: plan.family, clearFirst, nextHref: clearFirst ? `${url.pathname}?step=code` : null, settings }));
  }

  /** This shop's forwarding plan for the phone page and the emailed steps (null until the carrier is known). */
  async function handoffPlan(tenantId: string) {
    const [config, state, lineNumber] = await Promise.all([
      dependencies.store.getConfig(tenantId),
      readForwarding(tenantId),
      dependencies.store.getIntegrationSecret(tenantId, "telnyx", "inbound_number"),
    ]);
    const plan = lineNumber && state.businessNumber && state.carrier && state.carrier.family !== "unknown" ? forwardingPlan(state.carrier.family, lineNumber, config.operationMode, config.answerAfterRings) : null;
    return { config, state, lineNumber, plan };
  }

  /** Otto's path for one call, from everything the server recorded about it. The caller checks the tenant. */
  async function callPathFor(call: CallRecord): Promise<CallPath | null> {
    const [booking, callbackTask, notifications, events] = await Promise.all([
      dependencies.store.getBookingForCall(call.id),
      dependencies.store.getCallbackTaskForCall(call.id),
      dependencies.store.listNotifications(call.id),
      dependencies.store.listToolEvents(call.id),
    ]);
    return buildCallPath({
      call,
      events: events.filter((item) => item.tenantId === call.tenantId),
      booking: booking?.tenantId === call.tenantId ? booking : null,
      callbackTask: callbackTask?.tenantId === call.tenantId ? callbackTask : null,
      notifications: notifications.filter((item) => item.tenantId === call.tenantId),
      now: dependencies.clock.now(),
    });
  }
  async function handleDemoApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if ((request.method ?? "GET") !== "GET") throw new HttpError(405, "The demo is read-only");
    const demo = publicOwnerDemo(dependencies.clock.now());
    if (url.pathname === "/api/demo/dashboard") {
      return sendJson(response, 200, apiDashboard({ ...demo, googleConnected: true, csrf: "", checkoutConfigured: false, now: dependencies.clock.now().toISOString(), preview: true }));
    }
    const callMatch = /^\/api\/demo\/calls\/([^/]+)$/.exec(url.pathname);
    const call = callMatch?.[1] ? demo.calls.find((item) => item.id === callMatch[1]) : undefined;
    if (!call) throw new HttpError(404, "Not found");
    const task = demo.tasks.find((item) => item.callId === call.id);
    const detail: ApiCallDetail = { call: apiCall(call), recordingUrl: null, booking: null, task: task ? apiTask(task) : null, alerts: [], canDelete: false, path: null };
    return sendJson(response, 200, detail);
  }

  /** One path for the settings form and the JSON API, so validation and side effects stay identical. */
  /** Billing lock first (same order as Stripe events and the grace sweep): an unpause can reconnect a grace-period line. */
  async function saveOwnerSettings(account: OwnerAccount, form: URLSearchParams, ip: string | null): Promise<void> {
    await dependencies.store.withLock(`billing:${account.tenantId}`, () => saveOwnerSettingsLocked(account, form, ip));
  }

  async function saveOwnerSettingsLocked(account: OwnerAccount, form: URLSearchParams, ip: string | null): Promise<void> {
    await dependencies.store.withLock(`config:${account.tenantId}`, async () => {
    const current = await dependencies.store.getConfig(account.tenantId);
    const updated = configFromForm(current, form, "owner", dependencies.clock.now());
    if (updated.operationMode !== current.operationMode || updated.answerAfterRings !== current.answerAfterRings) await rememberLegacyTestedFor(account.tenantId, current, updated.operationMode);
    // So "Keep my phone ringing first" can put back what they had (after hours stays after hours).
    if (updated.operationMode === "always" && current.operationMode !== "always") await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "mode_before_every_call", current.operationMode);
    if (!dependencies.env.DIRECT_BOOKING_BETA) updated.bookingMode = "confirm";
    if (!dependencies.env.WARM_TRANSFER_BETA) updated.warmTransferEnabled = false;
    updated.flatMonthlyPriceCents = current.flatMonthlyPriceCents;
    updated.planId = current.planId ?? "solo";
    updated.includedCalls = current.includedCalls;
    updated.overageCentsPerCall = current.overageCentsPerCall;
    updated.unlimitedCalls = current.unlimitedCalls === true;
    updated.customerSmsEnabled = current.customerSmsEnabled;
    if (updated.ownerWeeklyEmailEnabled && !(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL)) {
      throw new HttpError(503, "Weekly email delivery is not configured yet");
    }
    // Owner call texts and the daily recap are included in every plan: on/off is the owner's choice, never billed.
    if (account.status !== "active") updated.paused = true;
    if (updated.paused !== current.paused) updated.pausedForBilling = false;
    const ownerPhoneInput = form.get("ownerPhone")?.trim();
    // A new mobile is just the number: texts to it need the owner's own yes (Settings › Alerts records it). A
    // different number while texts are on (with the yes on file, the box checked on the same page) is recorded the
    // way the box records an opt-in (time, wording version, IP) and gets the one confirmation text.
    let newTextNumber: string | null = null;
    if (ownerPhoneInput) {
      const ownerPhone = /^\+[1-9]\d{7,14}$/.test(ownerPhoneInput) ? ownerPhoneInput : normalizeUsPhone(ownerPhoneInput);
      if (!ownerPhone) throw new HttpError(400, "Enter your mobile number, like (941) 555-0123");
      const [previousPhone, consent] = await Promise.all([
        dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
        dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner_sms_consent"),
      ]);
      await dependencies.store.saveIntegrationSecret(account.tenantId, "notifications", "owner-primary", ownerPhone);
      updated.ownerTransferNumberRef = "owner-primary";
      if (textsOn(current, Boolean(consent)) && ownerPhone !== previousPhone) {
        newTextNumber = ownerPhone;
        await dependencies.store.saveIntegrationSecret(account.tenantId, "notifications", "owner_sms_consent", JSON.stringify({ at: dependencies.clock.now().toISOString(), source: "settings", wording: SMS_CONSENT_VERSION, ip }));
      }
    }
    let liveRouteChange: TelnyxVoiceRoutingClient | null = null;
    if (account.status === "active" && updated.paused !== current.paused) {
      const [route, inboundNumber] = await Promise.all([
        dependencies.store.getProviderRouteForTenant("telnyx", account.tenantId),
        dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number"),
      ]);
      if (!dependencies.env.TELNYX_API_KEY || !route || !inboundNumber) throw new HttpError(409, "Your line isn’t set up yet, so it can’t be paused or turned on here.");
      liveRouteChange = voiceRouting(inboundNumber, route.externalId);
      await liveRouteChange.setPaused(updated.paused)
        .catch((error) => {
          log({ level: "error", event: "owner_route_change_failed", tenantId: account.tenantId, paused: updated.paused, error: safeError(error) });
          throw new HttpError(502, "We couldn’t change your line just now. Nothing was changed. Try again in a minute.");
        });
    }
    try {
      await saveAssistantConfig(dependencies.store, dependencies.env, updated, dependencies.fetcher);
    } catch (error) {
      if (liveRouteChange) await liveRouteChange.setPaused(current.paused).catch((rollbackError) => log({ level: "error", event: "owner_route_rollback_failed", tenantId: account.tenantId, error: safeError(rollbackError) }));
      throw error;
    }
    if (newTextNumber) await queueOwnerOptInConfirmation(account.tenantId, newTextNumber, `owner-optin:${account.tenantId}:${dependencies.clock.now().toISOString()}`);
    });
  }

  /** Owner follow-up actions, shared by the form posts and the JSON API. Another shop's call is a 404. */
  async function ownerTaskAction(account: OwnerAccount, callId: string, action: "complete" | "reopen" | "snooze", minutes?: number): Promise<CallbackTask> {
    const task = await dependencies.store.getCallbackTaskForCall(callId);
    if (!task || task.tenantId !== account.tenantId) throw new HttpError(404, "Task not found");
    const now = dependencies.clock.now();
    let next: CallbackTask;
    if (action === "complete") {
      // A second Done for the same call (a double-click, a second tab) changes nothing: the first completion stands.
      if (task.status === "completed") return task;
      next = { ...task, status: "completed", completedAt: now.toISOString(), completionSource: "owner", updatedAt: now.toISOString() };
    } else if (action === "reopen") {
      if (task.status !== "completed") throw new HttpError(404, "Completed task not found");
      // Undo puts the follow-up back exactly as it was: Complete never touches dueAt, so its "Call back by" time returns.
      next = { ...task, status: "open", completedAt: null, completionSource: null, updatedAt: now.toISOString() };
    } else {
      if (task.status === "completed" || task.status === "cancelled") throw new HttpError(404, "Task not found");
      if (minutes === undefined || ![60, 240, 1_440].includes(minutes)) throw new HttpError(400, "Choose a valid reminder time");
      next = { ...task, status: "snoozed", dueAt: new Date(now.getTime() + minutes * 60_000).toISOString(), completedAt: null, completionSource: null, updatedAt: now.toISOString() };
    }
    await dependencies.store.saveCallbackTask(next);
    return next;
  }

  async function handleOwner(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const sessionValue = readCookie(request, "afo_owner");
    const session = verifyOwnerSession(sessionValue, dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
    if (!session) return redirect(response, request.method === "GET" ? loginReturningTo(url) : "/login");
    const account = await dependencies.store.getOwnerAccountById(session.accountId);
    if (!account || account.tenantId !== session.tenantId || account.status === "suspended" || !sessionMatchesAccount(session, account)) {
      response.setHeader("set-cookie", clearOwnerSessionCookie(dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/login");
    }
    const method = request.method ?? "GET";
    const member = account.role === "member";
    // The old all-in-one setup page. Its one job left (text-alert consent) lives in Settings › Alerts now.
    if (url.pathname === "/app/setup") {
      if (method !== "GET") throw member ? new HttpError(403, "Only the owner can change the shop’s call setup") : new HttpError(405, "Method not allowed");
      return redirect(response, member ? "/app" : "/app/settings");
    }
    if (member && (url.pathname.startsWith("/app/billing") || url.pathname === "/app/config" || /\/delete$/.test(url.pathname))) throw new HttpError(403, "Only the owner can change billing, shop rules, or delete call records");
    if (member && url.pathname === "/app/settings") return redirect(response, "/app/team");
    // The Team page's "Confirm my email" link. It counts only when it is opened signed in as that same account,
    // so having the inbox and the account are both proved; it changes nothing else (no new password).
    if (method === "GET" && url.pathname === "/app/confirm-email") {
      const token = url.searchParams.get("token") ?? "";
      const accountId = token ? await dependencies.store.consumePasswordReset(hashPasswordResetToken(token), dependencies.clock.now().toISOString()) : null;
      if (accountId !== account.id) return redirect(response, "/app/team?confirm=expired");
      // Same first proof as a reset link: teammates and invitations made before the email was proved are revoked.
      if (!account.emailVerifiedAt && !member) {
        log({ level: "info", event: "owner_unproven_team_revoked", method: "confirm_email", accountId, removed: await new TeamService(dependencies.store, dependencies.clock).reclaim(account.tenantId) });
      }
      await dependencies.store.markOwnerEmailVerified(account.id, dependencies.clock.now().toISOString(), null);
      log({ level: "info", event: "owner_email_confirmed", accountId });
      return redirect(response, "/app/team?confirm=done");
    }
    // /app/team is the owner app's Team screen (below); its data and changes are /api/app/team.
    if (method === "GET" && isOwnerAppPath(url.pathname) && await sendOwnerWeb(response, true)) return;
    // Setup steps live in the React app; without it, the server-rendered dashboard has the same buttons.
    if (method === "GET" && /^\/app\/start\/?$/.test(url.pathname)) return redirect(response, "/app");
    if (method === "POST" && url.pathname === "/app/line/go-live") {
      if (member) throw new HttpError(403, "Only the owner can turn on the line");
      const form = parseForm(await readBody(request, 4_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      if (!limiter.allow(`go-live:${account.tenantId}`, 6, 60 * 60_000)) throw new HttpError(429, "Too many attempts. Please try again later.");
      try {
        await goLive(account, null);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status >= 500 && error.status !== 502) throw error;
        // Show the reason on the dashboard instead of a bare error page.
        const reason = error.message.startsWith("Live provider prerequisites")
          ? "New lines are waiting on carrier approval. Your setup is saved; turn your line on here once it clears."
          : error.message === ASSISTANT_TAKEN ? OWNER_SETUP_STUCK : error.message;
        return redirect(response, `/app?line_error=${encodeURIComponent(reason.slice(0, 200))}`);
      }
      return redirect(response, "/app?line=live");
    }
    if (method === "GET" && url.pathname === "/app") {
      const subscription = await dependencies.store.getSubscription(account.tenantId);
      const [config, calls, tasks, usage, googleConnected, lineNumber] = await Promise.all([
        dependencies.store.getConfig(account.tenantId),
        dependencies.store.listCalls(account.tenantId, 50),
        dependencies.store.listCallbackTasks(account.tenantId, 100),
        dependencies.store.getUsageSummary(account.tenantId, ...currentBillingPeriod(dependencies.clock.now(), subscription?.currentPeriodEnd)),
        isGoogleConnected(dependencies.env, dependencies.store, account.tenantId),
        dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number"),
      ]);
      return sendHtml(response, 200, renderOwnerDashboard({
        lineNumber,
        lineError: url.searchParams.get("line_error"),
        account,
        config,
        calls,
        tasks,
        usage,
        googleConnected,
        subscription,
        csrf: session.csrf,
        checkoutConfigured: Boolean(stripeClient || dependencies.env.FOUNDING_CHECKOUT_URL),
        checkoutUrl: dependencies.env.FOUNDING_CHECKOUT_URL ?? null,
        now: dependencies.clock.now().toISOString(),
        selectedCallId: url.searchParams.get("call"),
        recentlyCompletedCallId: url.searchParams.get("completed"),
        view: ownerDashboardView(url.searchParams.get("view")),
      }));
    }
    if (method === "POST" && url.pathname === "/app/billing/portal") {
      const form = parseForm(await readBody(request, 8_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      const subscription = await dependencies.store.getSubscription(account.tenantId);
      // A browser goes back to Plan and billing, which says what happened in one line; other clients get the JSON error.
      if (isCompStatus(subscription?.status)) {
        if (wantsPage(request)) return redirect(response, "/app/settings/plan?billing=comp");
        throw new HttpError(409, "This is a complimentary review account. There’s no billing to manage.");
      }
      if (!stripeClient || !subscription?.providerCustomerId) {
        if (wantsPage(request)) return redirect(response, "/app/settings/plan?billing=none");
        throw new HttpError(409, "No paid subscription to manage yet");
      }
      const portalUrl = await stripeClient.createPortal(subscription.providerCustomerId, `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/settings/plan?billing=back`).catch(() => null);
      if (!portalUrl) {
        if (wantsPage(request)) return redirect(response, "/app/settings/plan?billing=unavailable");
        throw new HttpError(502, "Billing could not be opened. Please retry; your subscription has not changed.");
      }
      return redirect(response, portalUrl);
    }
    if (method === "POST" && url.pathname === "/app/billing/checkout") {
      const form = parseForm(await readBody(request, 8_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      // Complimentary: nothing to pay, and never a Stripe session or the founding link.
      if (isCompStatus((await dependencies.store.getSubscription(account.tenantId))?.status)) return redirect(response, "/app");
      if (!stripeClient) {
        if (dependencies.env.FOUNDING_CHECKOUT_URL) {
          telemetry.capture("checkout_started", account.id, account.tenantId, { result: "founding_link" });
          return redirect(response, dependencies.env.FOUNDING_CHECKOUT_URL);
        }
        throw new HttpError(503, "Checkout is not configured yet");
      }
      const returnTo = form.get("from") === "start" ? "start" : "app";
      const requested = normalizePlanId(form.get("plan"));
      const unlimitedField = form.get("unlimited");
      const target = await startCheckout(account, returnTo, requested && plans.some((plan) => plan.id === requested) ? requested : undefined, unlimitedField === null ? undefined : unlimitedField === "yes");
      const appUrl = `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app`;
      telemetry.capture("checkout_started", account.id, account.tenantId, {
        result: target === appUrl || target.endsWith("/app/start") ? "already_active" : target.endsWith("checkout=processing") ? "processing" : target.startsWith("https://checkout.stripe.com") ? "stripe_session" : "billing_portal",
      });
      return redirect(response, target);
    }
    if (method === "GET" && (url.pathname === "/app/settings" || url.pathname === "/app/config")) {
      const [config, googleConnected, ownerPhone] = await Promise.all([
        dependencies.store.getConfig(account.tenantId),
        isGoogleConnected(dependencies.env, dependencies.store, account.tenantId),
        dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
      ]);
      return sendHtml(response, 200, renderOwnerSettings({
        account,
        config,
        subscription: await dependencies.store.getSubscription(account.tenantId),
        csrf: session.csrf,
        saved: url.searchParams.get("saved") === "1",
        recentSignIn: signedInRecently(session),
        integrations: {
          googleAvailable: anyGoogleClient(dependencies.env),
          googleConnected,
          ownerPhoneConfigured: Boolean(ownerPhone),
          weeklyEmailAvailable: Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL),
          directBookingAvailable: dependencies.env.DIRECT_BOOKING_BETA,
        },
      }));
    }
    if (method === "POST" && url.pathname === "/app/config") {
      const form = parseForm(await readBody(request, 64_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      await saveOwnerSettings(account, form, requestIp(request));
      return redirect(response, "/app/settings?saved=1");
    }
    if (method === "GET" && url.pathname === "/app/account/export") {
      if (member) throw new HttpError(403, "Only the owner can export the shop's data");
      const [config, calls, tasks, subscription] = await Promise.all([
        dependencies.store.getConfig(account.tenantId),
        dependencies.store.listCalls(account.tenantId, 100_000),
        dependencies.store.listCallbackTasks(account.tenantId, 100_000),
        dependencies.store.getSubscription(account.tenantId),
      ]);
      const bookings = await dependencies.store.listBookingsForTenant(account.tenantId);
      const body = JSON.stringify({
        exportedAt: dependencies.clock.now().toISOString(),
        account: { email: account.email, displayName: account.displayName, createdAt: account.createdAt },
        settings: config,
        subscription: subscription ? { status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd } : null,
        calls: calls.map((call) => ({ id: call.id, startedAt: call.startedAt, endedAt: call.endedAt, durationSeconds: call.durationSeconds, callerNumber: call.fromNumber, details: call.fields, emergency: call.emergency, outcome: call.outcome, transcript: call.transcript, consent: call.consentState })),
        callbackTasks: tasks,
        bookings,
      }, null, 2);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="front-office-export-${dependencies.clock.now().toISOString().slice(0, 10)}.json"`,
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    if (method === "POST" && url.pathname === "/app/account/sign-out-everywhere") {
      const form = parseForm(await readBody(request, 4_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      await dependencies.store.revokeOwnerSessions(account.id, dependencies.clock.now().toISOString());
      response.setHeader("set-cookie", clearOwnerSessionCookie(dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/login");
    }
    if (method === "POST" && url.pathname === "/app/account/delete") {
      if (member) throw new HttpError(403, "Only the owner can delete the shop");
      const form = parseForm(await readBody(request, 8_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      // A browser goes back to the delete card with the problem next to the field; the JSON client (and the plain
      // server-rendered settings, which has no such card) gets the status.
      const backToCard = wantsPage(request) && Boolean(await loadOwnerWebIndex());
      const refuse = (status: number, reason: string, message: string): void => {
        if (backToCard) return redirect(response, `/app/settings/data?delete=${reason}`);
        throw new HttpError(status, message);
      };
      if (form.get("confirm")?.trim().toLowerCase() !== "delete") return refuse(400, "confirm", "Type DELETE to confirm");
      // Proof it's the owner: a sign-in in the last 10 minutes (Google, Microsoft, email link or password), or the
      // account's password. An account with no password (Google, Microsoft or email link) has only the first.
      const typed = form.get("password") ?? "";
      if (isPasswordless(account.passwordHash)) {
        if (!signedInRecently(session)) return refuse(403, "signin", "For your safety, sign in again, then delete within 10 minutes.");
      } else if (typed || !signedInRecently(session)) {
        // The page showed no password box (fresh sign-in) but the 10 minutes ran out before the tap.
        if (!typed) return refuse(403, "signin", "For your safety, enter your password or sign in again.");
        if (!limiter.allow(`delete-password:${account.id}`, 10, 15 * 60_000)) return refuse(429, "slow", "Too many tries. Wait 15 minutes or sign in again.");
        if (!await verifyOwnerPassword(typed, account.passwordHash)) return refuse(403, "password", "That password isn’t right");
      }
      const subscription = await dependencies.store.getSubscription(account.tenantId);
      // Only once billing has fully ended: anything but a cancelled subscription may still charge.
      if (subscription?.providerSubscriptionId && subscription.status !== "canceled") {
        return refuse(409, "plan", "Cancel your subscription in Billing first. You can delete your account once it has ended.");
      }
      try { await pauseLiveRoute(account.tenantId); } catch (error) {
        log({ level: "error", event: "account_delete_pause_failed", tenantId: account.tenantId, error: withoutNumbers(safeError(error)) });
        return refuse(502, "line", "We couldn't disconnect your Call Otto line. Nothing was deleted; please retry.");
      }
      // Recordings before the line: a failed one leaves the number and assistant in place, so a retry starts clean.
      try { await deletionService.deleteRecordings(account.tenantId); } catch (error) {
        log({ level: "error", event: "account_delete_recordings_failed", tenantId: account.tenantId, error: withoutNumbers(safeError(error)) });
        return refuse(502, "recording", "A call recording couldn't be deleted. Your line is paused and nothing else was removed; please retry.");
      }
      // Never throws; a release that fails is logged and the number is retried by hand. It runs before the store
      // delete because that removes the record of which number to give back.
      await releaseProvisionedLine(account.tenantId);
      await dependencies.store.deleteWorkspace(account.tenantId);
      log({ level: "warn", event: "owner_workspace_deleted", tenantId: account.tenantId });
      response.setHeader("set-cookie", clearOwnerSessionCookie(dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/?deleted=1");
    }
    if (method === "GET" && url.pathname === "/app/integrations/google/start") {
      const googleOAuth = clientForNewConnections(dependencies.env);
      if (!googleOAuth) throw new HttpError(503, "Google OAuth is not configured on the server");
      const cookiePath = "/app/integrations/google";
      const attempt = createGoogleOAuthAttempt(oauthAttemptKey(`${dependencies.env.SESSION_SIGNING_KEY!}:${account.id}`, googleOAuth.name), dependencies.env.NODE_ENV === "production", dependencies.clock.now().getTime(), cookiePath);
      const callback = `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/integrations/google/callback`;
      const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorization.search = new URLSearchParams({
        client_id: googleOAuth.id,
        redirect_uri: callback,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        scope: GOOGLE_CALENDAR_SCOPES.join(" "),
        state: attempt.state,
        code_challenge: attempt.challenge,
        code_challenge_method: "S256",
      }).toString();
      response.setHeader("set-cookie", attempt.cookie);
      return redirect(response, authorization.toString());
    }
    if (method === "GET" && url.pathname === "/app/integrations/google/callback") {
      const cookiePath = "/app/integrations/google";
      const attempt = clientForAttempt(dependencies.env, `${dependencies.env.SESSION_SIGNING_KEY!}:${account.id}`, (key) => verifyGoogleOAuthAttempt(url.searchParams.get("state"), readCookie(request, "afo_google_pkce"), key, dependencies.clock.now().getTime()));
      if (!attempt) throw new HttpError(400, "Google authorization state is invalid or expired");
      const code = url.searchParams.get("code");
      if (!code) throw new HttpError(400, "Google did not return an authorization code");
      const refreshToken = await exchangeGoogleCode(dependencies.env, attempt.client, code, attempt.result, "/app/integrations/google/callback");
      await dependencies.store.saveIntegrationSecret(account.tenantId, "google", member ? `refresh_token:${account.id}` : "refresh_token", encodeGoogleConnection(refreshToken, attempt.client));
      response.setHeader("set-cookie", clearGoogleOAuthCookie(dependencies.env.NODE_ENV === "production", cookiePath));
      return redirect(response, "/app/settings");
    }
    const recordingMatch = /^\/app\/provider\/telnyx\/recordings\/(.+)$/.exec(url.pathname);
    if (method === "GET" && recordingMatch?.[1]) {
      if (!recordingClient) throw new HttpError(503, "Recordings aren’t available right now.");
      let providerCallId: string;
      try {
        providerCallId = decodeURIComponent(recordingMatch[1]);
      } catch {
        throw new HttpError(400, "Invalid recording identifier");
      }
      const call = await dependencies.store.getCallByProviderId(providerCallId);
      if (!call || call.tenantId !== account.tenantId || call.consentState === "declined") throw new HttpError(404, "Recording not found");
      // The webhook saved a recording after a remembered miss: look again.
      if (call.recordingUrl && recordingUrls.get(providerCallId)?.url === null) recordingUrls.delete(providerCallId);
      const downloadUrl = await recordingDownloadUrl(providerCallId);
      if (!downloadUrl) throw new HttpError(404, "Recording is not available yet");
      if (url.searchParams.get("stream") === "1") return streamRecording(request, response, providerCallId, downloadUrl);
      response.writeHead(302, { location: downloadUrl, "cache-control": "no-store" });
      response.end();
      return;
    }
    const deleteCallMatch = /^\/app\/calls\/([0-9a-f-]+)\/delete$/i.exec(url.pathname);
    if (method === "POST" && deleteCallMatch?.[1]) {
      const form = parseForm(await readBody(request, 16_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      if (form.get("confirm") !== "delete") throw new HttpError(400, "Deletion confirmation is required");
      const deleted = await deletionService.deleteCall(account.tenantId, deleteCallMatch[1])
        .catch(() => { throw new HttpError(502, "Provider deletion failed. The local record was retained so deletion can be retried."); });
      if (!deleted) throw new HttpError(404, "Call not found");
      return redirect(response, "/app");
    }
    const completeTaskMatch = /^\/app\/calls\/([0-9a-f-]+)\/task\/complete$/i.exec(url.pathname);
    if (method === "POST" && completeTaskMatch?.[1]) {
      const form = parseForm(await readBody(request, 8_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      const task = await ownerTaskAction(account, completeTaskMatch[1], "complete");
      return redirect(response, `/app?completed=${encodeURIComponent(task.callId)}#inbox`);
    }
    const reopenTaskMatch = /^\/app\/calls\/([0-9a-f-]+)\/task\/reopen$/i.exec(url.pathname);
    if (method === "POST" && reopenTaskMatch?.[1]) {
      const form = parseForm(await readBody(request, 8_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      const task = await ownerTaskAction(account, reopenTaskMatch[1], "reopen");
      return redirect(response, `/app?call=${encodeURIComponent(task.callId)}#inbox`);
    }
    const snoozeTaskMatch = /^\/app\/calls\/([0-9a-f-]+)\/task\/snooze$/i.exec(url.pathname);
    if (method === "POST" && snoozeTaskMatch?.[1]) {
      const form = parseForm(await readBody(request, 8_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      await ownerTaskAction(account, snoozeTaskMatch[1], "snooze", Number(form.get("minutes")));
      return redirect(response, "/app#inbox");
    }
    const callMatch = /^\/app\/calls\/([0-9a-f-]+)$/i.exec(url.pathname);
    if (method === "GET" && callMatch?.[1]) {
      const call = await dependencies.store.getCall(callMatch[1]);
      if (!call || call.tenantId !== account.tenantId) throw new HttpError(404, "Call not found");
      const [config, booking, callbackTask, events, notifications] = await Promise.all([
        dependencies.store.getConfig(call.tenantId),
        dependencies.store.getBookingForCall(call.id),
        dependencies.store.getCallbackTaskForCall(call.id),
        dependencies.store.listToolEvents(call.id),
        dependencies.store.listNotifications(call.id),
      ]);
      const recordingUrl = call.recordingUrl?.startsWith("https://") ? call.recordingUrl.replace("/admin/provider/", "/app/provider/") : null;
      const path = buildCallPath({ call, events, booking, callbackTask, notifications, now: dependencies.clock.now() });
      return sendHtml(response, 200, renderOwnerCallRecord({ account, config, call, booking, callbackTask, notifications, recordingUrl, csrf: session.csrf, canDelete: !member, path }));
    }
    const callPathMatch = /^\/app\/calls\/([0-9a-f-]+)\/path$/i.exec(url.pathname);
    if (method === "GET" && callPathMatch?.[1]) {
      if (!limiter.allow(`call-path:${account.id}:${callPathMatch[1]}`, 90, 60_000)) throw new HttpError(429, "Too many requests");
      const call = await dependencies.store.getCall(callPathMatch[1]);
      if (!call || call.tenantId !== account.tenantId) throw new HttpError(404, "Call not found");
      const path = await callPathFor(call);
      response.setHeader("cache-control", "no-store");
      return sendJson(response, 200, path ? { live: path.live, done: path.done, html: renderCallPath(call.id, path) } : { live: false, done: 0, html: "" });
    }
    throw new HttpError(404, "Not found");
  }

  /** Stripe Checkout for this shop, or where to go instead (already paid, payment processing, fix billing). */
  async function startCheckout(account: OwnerAccount, returnTo: "start" | "app", planChoice?: PlanId, unlimitedChoice?: boolean): Promise<string> {
    if (!stripeClient) throw new HttpError(503, "Checkout is not configured yet");
    // Same lock as the billing webhook, so a payment cannot land between this read and a new session.
    return dependencies.store.withLock(`billing:${account.tenantId}`, async () => {
      const subscription = await dependencies.store.getSubscription(account.tenantId);
      const app = `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app${returnTo === "start" ? "/start" : ""}`;
      if (hasPlanAccess(subscription?.status)) return app;
      if (subscription?.providerCustomerId && (subscription.status === "past_due" || subscription.status === "unpaid")) {
        // Fix payment on the existing subscription instead of starting a second one.
        return stripeClient.createPortal(subscription.providerCustomerId, `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/settings/plan?billing=back`)
          .catch(() => { throw new HttpError(502, "Billing could not be opened. Please retry; your subscription has not changed."); });
      }
      // Any other live subscription (e.g. a first payment still processing) blocks a second one.
      if (subscription?.providerSubscriptionId && subscription.status !== "canceled") return `${app}?checkout=processing`;
      let config = await dependencies.store.getConfig(account.tenantId);
      const plan = pickPlan(plans, planChoice ?? config.planId);
      const unlimited = wantsUnlimited(plan, unlimitedChoice ?? config.unlimitedCalls === true);
      if (!isOnPlan(config, plan, unlimited)) {
        // Remember the pick, so the card screen shows it again and the dashboard shows the right price.
        config = await dependencies.store.withLock(`config:${account.tenantId}`, async () => {
          const next = onPlan(await dependencies.store.getConfig(account.tenantId), plan, unlimited);
          await dependencies.store.saveConfig(next);
          return next;
        });
      }
      // The open session is reused only for the same plan and Unlimited choice.
      const addOns = `${plan.id}${unlimited ? "+unlimited" : ""}`;
      const now = dependencies.clock.now();
      const savedOpen = await dependencies.store.getIntegrationSecret(account.tenantId, "stripe", "open_checkout");
      const open = savedOpen ? JSON.parse(savedOpen) as { id: string; url: string; expiresAt: string; addOns: string } : null;
      if (open && Date.parse(open.expiresAt) > now.getTime() + 60_000) {
        // One payable Checkout Session per shop: reuse it, or expire it if the add-ons changed.
        if (open.addOns === addOns) return open.url;
        const expired = await stripeClient.expireCheckout(open.id).catch(() => { throw new HttpError(502, "Checkout could not be updated. Please retry."); });
        if (expired === "complete") return `${app}?checkout=processing`;
      }
      const base = dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "");
      const created = await stripeClient.createCheckout({
        tenantId: account.tenantId,
        email: account.email,
        customerId: subscription?.providerCustomerId ?? null,
        // Stripe fills in the session id, so the return page can confirm payment without waiting for the webhook.
        successUrl: returnTo === "start" ? `${base}/app/start?checkout=success&session_id={CHECKOUT_SESSION_ID}` : `${base}/app?checkout=success`,
        cancelUrl: returnTo === "start" ? `${base}/app/start?checkout=cancelled` : `${base}/app?checkout=cancelled`,
        // A retry after a timeout in the same half hour gets the same session back from Stripe.
        idempotencyKey: `checkout:${account.tenantId}:${addOns}:${Math.floor(now.getTime() / 1_800_000)}`,
        now,
        trialDays,
        plan: plan.id,
        unlimited,
        couponId,
        submitMessage: planCharge(plan, config.timezone, unlimited),
      });
      await dependencies.store.saveIntegrationSecret(account.tenantId, "stripe", "open_checkout", JSON.stringify({ ...created, addOns }));
      return created.url;
    });
  }

  /**
   * The owner is back from Stripe: read the finished session and its subscription straight from
   * the API, so the line can turn on now instead of waiting for the webhook. The webhook still
   * lands later and reconciles the same record.
   */
  async function confirmCheckout(account: OwnerAccount, sessionId: string): Promise<void> {
    if (!stripeClient) return;
    // Paid already, or complimentary (never read from or written by Stripe).
    if (hasPlanAccess((await dependencies.store.getSubscription(account.tenantId))?.status)) return;
    const checkout = await stripeClient.retrieveCheckoutSession(sessionId).catch((error) => {
      log({ level: "warn", event: "checkout_return_lookup_failed", tenantId: account.tenantId, error: safeError(error) });
      return null;
    });
    if (!checkout) return;
    if (checkout.tenantId !== account.tenantId) throw new HttpError(400, "That checkout belongs to a different account");
    if (checkout.status !== "complete" || !checkout.subscriptionId) return;
    const subscriptionId = checkout.subscriptionId;
    await dependencies.store.withLock(`billing:${account.tenantId}`, async () => {
      const existing = await dependencies.store.getSubscription(account.tenantId);
      if (hasPlanAccess(existing?.status)) return;
      const live = await stripeClient.retrieveSubscription(subscriptionId)
        .catch(() => { throw new HttpError(502, "We couldn’t confirm your card with Stripe just now. Try again in a moment."); });
      if (live.tenantId && live.tenantId !== account.tenantId) throw new HttpError(400, "That subscription belongs to a different account");
      if (!stripeClient.hasPlanPrice(live.priceIds)) return;
      await syncPlan(account.tenantId, live);
      const now = dependencies.clock.now().toISOString();
      await dependencies.store.saveSubscription({
        tenantId: account.tenantId,
        providerCustomerId: live.customer ?? existing?.providerCustomerId ?? null,
        providerSubscriptionId: live.id,
        status: live.status,
        currentPeriodEnd: live.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null,
        providerEventCreatedAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      if (isPaidStatus(live.status)) {
        await dependencies.store.deleteIntegrationSecret(account.tenantId, "stripe", "open_checkout");
        // The card was charged in this checkout (no trial): that is the first successful charge.
        if (checkout.paymentStatus === "paid") await recordFirstPaid(dependencies.store, account.tenantId, now);
        telemetry.capture("checkout_completed", account.tenantId, account.tenantId, { source: "return" });
      }
    });
  }

  /** A paying subscription that a plan change would bill in Stripe now. */
  function liveSubscription(subscription: SubscriptionRecord | null): subscription is SubscriptionRecord & { providerSubscriptionId: string } {
    return Boolean(subscription?.providerSubscriptionId && subscription.status !== "canceled");
  }

  /**
   * What moving to this plan (Unlimited on or off) costs: the new monthly price and what is charged, or credited,
   * today. A paying shop's amount is Stripe's own invoice preview at prorationDate; if Stripe refuses the preview,
   * a local estimate stands in and is marked estimated (the app says "about"). Nothing is written anywhere.
   */
  async function quoteChange(account: OwnerAccount, plan: Plan, unlimitedAsked: boolean, prorationDate?: number): Promise<BillingQuote> {
    const [subscription, config] = await Promise.all([dependencies.store.getSubscription(account.tenantId), dependencies.store.getConfig(account.tenantId)]);
    if (unlimitedAsked && !plan.unlimited) throw new HttpError(409, plan.sold ? "Unlimited calls aren’t available on this plan yet." : `Unlimited calls aren’t available on ${plan.label}. Switch to Solo, Team or Fleet to add it.`);
    const unlimited = wantsUnlimited(plan, unlimitedAsked);
    const current = billedPlan(known, config);
    const base = { plan: plan.id, unlimited, monthlyCents: monthlyCents(plan, unlimited), renewsAt: subscription?.currentPeriodEnd ?? null };
    const noChange = isOnPlan(config, plan, unlimited);
    if (noChange || !liveSubscription(subscription) || !stripeClient) return { ...base, live: liveSubscription(subscription), noChange, todayCents: 0, creditCents: 0, estimated: false, prorationDate: null };
    const date = prorationDate ?? Math.floor(dependencies.clock.now().getTime() / 1_000);
    try {
      const preview = await stripeClient.previewChange(subscription.providerSubscriptionId, plan.id, { unlimited, prorationDate: date });
      return { ...base, live: true, noChange: preview.noChange, todayCents: preview.chargeCents, creditCents: preview.creditCents, estimated: false, prorationDate: date };
    } catch (error) {
      log({ level: "warn", event: "plan_preview_failed", tenantId: account.tenantId, error: safeError(error) });
      const periodEnd = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : addOneMonth(dependencies.clock.now());
      const periodStart = oneMonthBefore(periodEnd);
      const change = prorationEstimateCents({ fromMonthlyCents: monthlyCents(current, config.unlimitedCalls === true), toMonthlyCents: base.monthlyCents, periodStart, periodEnd, at: new Date(date * 1_000) });
      return { ...base, live: true, noChange: false, todayCents: Math.max(0, change), creditCents: Math.max(0, -change), estimated: true, prorationDate: date };
    }
  }

  /**
   * The owner confirmed a plan or Unlimited change. Before paying it is just remembered. A paying shop must send
   * the quote it was shown: the server previews again at the same proration date and writes to Stripe only if
   * the amount still matches, so the card is charged exactly what the owner agreed to, once.
   */
  async function applyChange(account: OwnerAccount, plan: Plan, unlimitedAsked: boolean, confirm: ConfirmedQuote | null): Promise<void> {
    await dependencies.store.withLock(`billing:${account.tenantId}`, async () => {
      const [subscription, config] = await Promise.all([dependencies.store.getSubscription(account.tenantId), dependencies.store.getConfig(account.tenantId)]);
      if (unlimitedAsked && !plan.unlimited) throw new HttpError(409, plan.sold ? "Unlimited calls aren’t available on this plan yet." : `Unlimited calls aren’t available on ${plan.label}. Switch to Solo, Team or Fleet to add it.`);
      const unlimited = wantsUnlimited(plan, unlimitedAsked);
      if (isOnPlan(config, plan, unlimited)) return;
      const live = liveSubscription(subscription);
      let addOnItems: UnlimitedItem[] | null = null;
      if (live) {
        if (!stripeClient) throw new HttpError(503, "Plan changes aren’t available yet");
        if (!confirm) throw new HttpError(409, "Check the price first. Nothing was charged.");
        const nowSeconds = Math.floor(dependencies.clock.now().getTime() / 1_000);
        if (confirm.prorationDate > nowSeconds + 60 || confirm.prorationDate < nowSeconds - 20 * 60) throw new HttpError(409, "That price is out of date. Check the new price. Nothing was charged.");
        const fresh = await quoteChange(account, plan, unlimitedAsked, confirm.prorationDate);
        if (fresh.estimated !== confirm.estimated || fresh.todayCents !== confirm.todayCents || fresh.creditCents !== confirm.creditCents) {
          throw new HttpError(409, "The price changed. Check the new price. Nothing was charged.");
        }
        addOnItems = (await stripeClient.changePlan(subscription.providerSubscriptionId, plan.id, { unlimited, prorationDate: confirm.prorationDate }).catch((error) => {
          log({ level: "error", event: "plan_change_failed", tenantId: account.tenantId, plan: plan.id, unlimited, error: safeError(error) });
          throw new HttpError(502, "Your plan couldn’t be changed just now. Nothing was changed; please try again.");
        })).addOnItems;
      }
      await dependencies.store.withLock(`config:${account.tenantId}`, async () => {
        await dependencies.store.saveConfig(onPlan(await dependencies.store.getConfig(account.tenantId), plan, unlimited));
      });
      if (live) await observeOwnChange(account.tenantId, unlimited, addOnItems);
      log({ level: "info", event: "plan_changed", tenantId: account.tenantId, from: config.planId ?? "solo", to: plan.id, unlimited });
      telemetry.capture("plan_changed", account.id, account.tenantId, { from: config.planId ?? "solo", to: plan.id, unlimited });
    });
  }

  /** The top line of Plan and billing: what was last paid and what the next bill is, from Stripe. Read only. */
  async function billingSummary(account: OwnerAccount): Promise<{ lastPaid: { amountCents: number; paidAt: string } | null; next: { amountCents: number; at: string } | null; endsAt: string | null; monthlyCents: number }> {
    const [subscription, config] = await Promise.all([dependencies.store.getSubscription(account.tenantId), dependencies.store.getConfig(account.tenantId)]);
    const monthly = monthlyCents(billedPlan(known, config), config.unlimitedCalls === true);
    if (!stripeClient || !liveSubscription(subscription) || isCompStatus(subscription.status)) return { lastPaid: null, next: null, endsAt: null, monthlyCents: monthly };
    const read = await stripeClient.billingSummary(subscription.providerSubscriptionId).catch((error) => {
      log({ level: "warn", event: "billing_summary_failed", tenantId: account.tenantId, error: safeError(error) });
      return { lastPaid: null, next: null, endsAt: null };
    });
    // Only Stripe's own preview names a next bill; never invent one (a cancelling plan has none).
    const at = read.next ? read.next.at ?? subscription.currentPeriodEnd : null;
    return { lastPaid: read.lastPaid, next: read.next && at ? { amountCents: read.next.amountCents, at } : null, endsAt: read.endsAt, monthlyCents: monthly };
  }

  /** The Stripe subscription a card or cancel change applies to, or the one-line reason there is none. */
  async function billedSubscription(account: OwnerAccount): Promise<{ client: StripeBillingClient; subscriptionId: string; customerId: string }> {
    const subscription = await dependencies.store.getSubscription(account.tenantId);
    if (isCompStatus(subscription?.status)) throw new HttpError(409, "This is a complimentary account. There’s no billing to manage.");
    if (!stripeClient || !liveSubscription(subscription) || !subscription.providerCustomerId) throw new HttpError(409, "There’s no paid plan to manage yet.");
    return { client: stripeClient, subscriptionId: subscription.providerSubscriptionId, customerId: subscription.providerCustomerId };
  }

  /** Card on file and past bills, for Plan and billing. Read only; a refused read shows nothing. */
  async function billingDetails(account: OwnerAccount): Promise<{ card: CardOnFile | null; invoices: BillLine[]; cardChange: "embedded" | "hosted" | null }> {
    const subscription = await dependencies.store.getSubscription(account.tenantId);
    if (!stripeClient || isCompStatus(subscription?.status) || !liveSubscription(subscription) || !subscription.providerCustomerId) return { card: null, invoices: [], cardChange: null };
    const read = await stripeClient.paymentDetails(subscription.providerCustomerId, subscription.providerSubscriptionId).catch((error) => {
      log({ level: "warn", event: "billing_details_failed", tenantId: account.tenantId, error: safeError(error) });
      return { card: null, invoices: [] };
    });
    return { ...read, cardChange: dependencies.env.STRIPE_PUBLISHABLE_KEY ? "embedded" : "hosted" };
  }

  /**
   * Start a card change: Stripe's embedded form on our page when a publishable key is set and Stripe agrees,
   * otherwise Stripe's own card page, which sends the owner back to Plan and billing by itself. Charges nothing.
   */
  async function startCardChange(account: OwnerAccount, hosted: boolean): Promise<{ mode: "embedded"; clientSecret: string; publishableKey: string; uiMode: "embedded" | "embedded_page" } | { mode: "hosted"; url: string }> {
    const { client, customerId } = await billedSubscription(account);
    const base = dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const publishableKey = dependencies.env.STRIPE_PUBLISHABLE_KEY;
    if (publishableKey && !hosted) {
      const embedded = await client.createCardSetup({ customerId, tenantId: account.tenantId, returnUrl: `${base}/app/settings/plan?card=done&session_id={CHECKOUT_SESSION_ID}` }).catch((error) => {
        log({ level: "warn", event: "card_setup_embedded_failed", tenantId: account.tenantId, error: safeError(error) });
        return null;
      });
      if (embedded) return { mode: "embedded", clientSecret: embedded.clientSecret, publishableKey, uiMode: embedded.uiMode };
    }
    const url = await client.createCardUpdatePortal(customerId, `${base}/app/settings/plan`, `${base}/app/settings/plan?card=back`).catch((error) => {
      log({ level: "warn", event: "card_update_page_failed", tenantId: account.tenantId, error: safeError(error) });
      return null;
    });
    if (!url) throw new HttpError(502, "We couldn’t open the card form. Nothing changed. Try again in a minute.");
    return { mode: "hosted", url };
  }

  /** The card a finished setup session saved becomes the one the subscription and the customer pay with. */
  async function finishCardChange(account: OwnerAccount, sessionId: string): Promise<void> {
    const { client, subscriptionId, customerId } = await billedSubscription(account);
    const setup = await client.retrieveCardSetup(sessionId).catch((error) => {
      log({ level: "warn", event: "card_setup_lookup_failed", tenantId: account.tenantId, error: safeError(error) });
      throw new HttpError(502, "We couldn’t check the new card. Try again in a minute.");
    });
    if (!setup.isCardUpdate || setup.tenantId !== account.tenantId || (setup.customerId && setup.customerId !== customerId)) throw new HttpError(403, "That card form belongs to another account.");
    if (!setup.paymentMethodId) throw new HttpError(409, "The new card isn’t saved yet. Finish the form, then try again.");
    await dependencies.store.withLock(`billing:${account.tenantId}`, async () => {
      // A late or repeated completion (the webhook after the page, or an older form after a newer one) never puts back
      // an older card: a card saved after this one already paying wins.
      const current = await client.currentDefaultCards(customerId, subscriptionId).catch(() => null);
      const paying = current?.subscription ?? null;
      if (paying && paying.id !== setup.paymentMethodId && setup.paymentMethodCreated !== null && paying.created > setup.paymentMethodCreated) {
        log({ level: "info", event: "card_change_superseded", tenantId: account.tenantId });
        return;
      }
      const result = await client.setDefaultCard({ customerId, subscriptionId, paymentMethodId: setup.paymentMethodId! }).catch((error) => {
        log({ level: "error", event: "card_default_update_failed", tenantId: account.tenantId, error: safeError(error) });
        throw new HttpError(502, "Your new card is saved, but we couldn’t switch to it. Try again in a minute.");
      });
      if (!result.customerUpdated) log({ level: "warn", event: "card_customer_default_failed", tenantId: account.tenantId });
    });
  }

  /**
   * Back from Stripe's own card page: it saves the new card as the customer's default only, so the subscription (which
   * may carry its own older default) is switched to it here. Only ever moves to a card saved later than the one paying.
   */
  async function syncHostedCard(account: OwnerAccount): Promise<void> {
    const { client, subscriptionId, customerId } = await billedSubscription(account);
    await dependencies.store.withLock(`billing:${account.tenantId}`, async () => {
      const current = await client.currentDefaultCards(customerId, subscriptionId);
      const saved = current.customer;
      if (!saved || saved.id === current.subscription?.id) return;
      if (current.subscription && current.subscription.created > saved.created) return;
      await client.setSubscriptionCard(subscriptionId, saved.id);
      log({ level: "info", event: "card_hosted_synced", tenantId: account.tenantId });
    }).catch((error) => {
      if (error instanceof HttpError) throw error;
      log({ level: "error", event: "card_hosted_sync_failed", tenantId: account.tenantId, error: safeError(error) });
      throw new HttpError(502, "Your new card is saved, but we couldn’t switch to it. Try again in a minute.");
    });
  }

  /** Cancel at the end of the paid period, or keep the plan. What happens when it ends is the webhook's job, as before. */
  async function setCancel(account: OwnerAccount, cancel: boolean): Promise<void> {
    const { client, subscriptionId } = await billedSubscription(account);
    await dependencies.store.withLock(`billing:${account.tenantId}`, () => client.setCancelAtPeriodEnd(subscriptionId, cancel)).catch((error) => {
      if (error instanceof HttpError) throw error;
      log({ level: "error", event: cancel ? "plan_cancel_failed" : "plan_keep_failed", tenantId: account.tenantId, error: safeError(error) });
      throw new HttpError(502, "We couldn’t reach our payment processor. Nothing changed. Try again in a minute.");
    });
    log({ level: "info", event: cancel ? "plan_cancel_scheduled" : "plan_cancel_undone", tenantId: account.tenantId });
  }

  /** Keep the shop's plan and price in step with what Stripe says it is paying for (e.g. a switch in the billing portal). */
  async function syncPlan(tenantId: string, live: { priceIds: string[]; addOnItems: UnlimitedItem[] }): Promise<void> {
    const { priceIds } = live;
    const plan = planForPriceIds(known, priceIds);
    if (!plan) return;
    // Stripe is the truth for the add-on too: its item on the subscription means Unlimited is on.
    const unlimited = hasUnlimitedPrice(known, priceIds);
    await dependencies.store.withLock(`config:${tenantId}`, async () => {
      const current = await dependencies.store.getConfig(tenantId);
      if (isOnPlan(current, plan, unlimited)) return;
      await dependencies.store.saveConfig(onPlan(current, plan, unlimited));
    });
    await recordUnlimitedObservation(dependencies.store, tenantId, { at: dependencies.clock.now().toISOString(), items: live.addOnItems, live: true });
  }

  /**
   * After we changed the add-on in Stripe ourselves: Stripe's reply lists the add-on items (with creation times).
   * If it didn't, a placeholder item stands in from now until the next read of Stripe shows the real one.
   */
  async function observeOwnChange(tenantId: string, on: boolean, items: UnlimitedItem[] | null): Promise<void> {
    const at = dependencies.clock.now().toISOString();
    await recordUnlimitedObservation(dependencies.store, tenantId, { at, items: items ?? (on ? [{ id: `owner:${at}`, createdAt: at }] : []), live: true });
  }

  /** Turn the line on with no button, and say calmly what happens next if it can't be yet. */
  async function activateLine(account: OwnerAccount): Promise<{ status: "live" | "waiting" | "blocked" | "failed"; message: string | null }> {
    const lineNumber = await dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number");
    if (account.status === "active" && lineNumber) return { status: "live", message: null };
    const status = (await dependencies.store.getSubscription(account.tenantId))?.status;
    if (isCompStatus(status)) return { status: "blocked", message: REVIEW_NO_LINE };
    if (!isPaidStatus(status)) {
      return { status: "blocked", message: "We haven’t seen your card yet. Add it to turn your line on." };
    }
    if (!limiter.allow(`go-live:${account.tenantId}`, 6, 60 * 60_000)) {
      return { status: "failed", message: "That’s a lot of tries. Give it a few minutes, then reopen this page." };
    }
    try {
      await goLive(account, null);
      return { status: "live", message: null };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.message.startsWith("Live provider prerequisites")) {
        return { status: "waiting", message: "Your Call Otto number is on its way. Phone carriers approve new business lines, which usually takes 1 to 3 business days. Everything else is saved, so keep going. We’ll turn it on the moment it clears." };
      }
      if (error.message === ASSISTANT_TAKEN) return { status: "failed", message: OWNER_SETUP_STUCK };
      if (error.status === 409) return { status: "blocked", message: `${error.message.replace(/^This shop is missing: /, "Add your ")}. You can do that in Settings.` };
      return { status: "failed", message: error.message };
    }
  }

  function liveProviderBlockers(): string[] {
    return [
      !dependencies.env.TELNYX_API_KEY && "Telnyx API key",
      !dependencies.env.TELNYX_PUBLIC_KEY && "Telnyx webhook verification",
      !dependencies.env.TELNYX_FROM_NUMBER && "Telnyx SMS sender",
      !dependencies.env.TELNYX_MESSAGING_PROFILE_ID && "Telnyx messaging profile",
      !dependencies.env.LIVE_PROVIDER_PROOF_AT && "recorded live-provider proof",
      dependencies.env.PROVIDER_TEST_MODE && "provider test mode must be disabled",
    ].filter(Boolean) as string[];
  }

  /**
   * Turn a paid, set-up shop on. Without explicit ids it provisions the shop's own number and
   * assistant (Rosie/Goodcall model). Each provider id is saved the moment it exists, so a retry
   * after a crash reuses it instead of buying a second number.
   */
  async function goLive(account: OwnerAccount, existing: { assistantId: string; inboundNumber: string } | null): Promise<string> {
    telemetry.capture("go_live_attempted", account.tenantId, account.tenantId);
    // The billing lock keeps go-live from racing a payment change or the day-30 grace release.
    return trackGoLive(account.tenantId, dependencies.store.withLock(`go-live:${account.tenantId}`, () => dependencies.store.withLock(`billing:${account.tenantId}`, async () => {
      const providerBlockers = liveProviderBlockers();
      if (providerBlockers.length > 0) throw new HttpError(409, `Live provider prerequisites are missing: ${providerBlockers.join(", ")}`);
      const config = await dependencies.store.getConfig(account.tenantId);
      const [ownerPhone, googleConnected, subscription] = await Promise.all([
        dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
        isGoogleConnected(dependencies.env, dependencies.store, account.tenantId),
        dependencies.store.getSubscription(account.tenantId),
      ]);
      // Never a number for the review account, whatever else is set up.
      if (isCompStatus(subscription?.status)) throw new HttpError(409, REVIEW_NO_LINE);
      const shopBlockers = shopActivationBlockers({
        ownerPhoneConfigured: Boolean(ownerPhone),
        googleConnected,
        bookingMode: config.bookingMode,
        serviceAreaConfigured: config.serviceAreaTerms.length > 0,
      });
      if (shopBlockers.length > 0) throw new HttpError(409, `This shop is missing: ${shopBlockers.join(", ")}`);
      if (!stripeClient || !isPaidStatus(subscription?.status)) throw new HttpError(409, "An active paid subscription is required before activation");

      let assistantId = existing?.assistantId ?? null;
      let inboundNumber = existing?.inboundNumber ?? null;
      if (!assistantId || !inboundNumber) {
        const templateAssistantId = dependencies.env.TELNYX_TEMPLATE_ASSISTANT_ID ?? dependencies.env.TELNYX_ASSISTANT_ID;
        if (!templateAssistantId) throw new HttpError(409, "Live provider prerequisites are missing: Telnyx template assistant");
        const provisioner = new TelnyxProvisioner({
          apiKey: dependencies.env.TELNYX_API_KEY!, templateAssistantId,
          messagingProfileId: dependencies.env.TELNYX_MESSAGING_PROFILE_ID!, campaignId: dependencies.env.TELNYX_CAMPAIGN_ID,
          ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
        });
        try {
          assistantId = await dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "provisioned_assistant_id");
          if (!assistantId) {
            assistantId = await provisioner.createAssistant({ tenantId: account.tenantId, businessName: config.businessName, assistantUpdate: buildTelnyxAssistantUpdate(config, dependencies.env.PUBLIC_BASE_URL, { voice: dependencies.env.TELNYX_VOICE }) });
            await dependencies.store.saveIntegrationSecret(account.tenantId, "telnyx", "provisioned_assistant_id", assistantId);
          }
          inboundNumber = await dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number");
          if (!inboundNumber) {
            const pending = await dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "pending_number");
            const candidate = pending ?? await provisioner.findNumber({ areaCodes: [areaCode(ownerPhone)].filter((code): code is string => Boolean(code)), state: serviceAreaState(config.serviceAreaTerms) });
            if (!pending) await dependencies.store.saveIntegrationSecret(account.tenantId, "telnyx", "pending_number", candidate);
            await provisioner.orderNumber({ tenantId: account.tenantId, phoneNumber: candidate }).catch(async (error) => {
              if (error instanceof NumberUnavailableError) await dependencies.store.deleteIntegrationSecret(account.tenantId, "telnyx", "pending_number");
              throw error;
            });
            inboundNumber = candidate;
            await dependencies.store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", inboundNumber);
            await provisioner.attachCampaign(inboundNumber).catch((error) => log({ level: "error", event: "number_campaign_attach_failed", tenantId: account.tenantId, error: safeError(error) }));
          }
        } catch (error) {
          if (error instanceof HttpError) throw error;
          log({ level: "error", event: "line_provisioning_failed", tenantId: account.tenantId, error: safeError(error) });
          throw new HttpError(502, "We couldn't set up your Call Otto number just now. Try again in a minute.");
        }
      }

      const existingRoute = await dependencies.store.getProviderRoute("telnyx", assistantId);
      if (existingRoute && existingRoute.tenantId !== account.tenantId) {
        log({ level: "error", event: "go_live_assistant_owned_elsewhere", tenantId: account.tenantId, otherTenantId: existingRoute.tenantId });
        throw new HttpError(409, ASSISTANT_TAKEN);
      }
      const liveRoute = voiceRouting(inboundNumber, assistantId);
      // The assistant's own TeXML app must post its end-of-call callback here, or this shop's calls never get a
      // transcript, summary, usage count or callback task. Idempotent on every activation; a line never goes live without it.
      await ensureCallEndCallback({ apiKey: dependencies.env.TELNYX_API_KEY!, assistantId, publicBaseUrl: dependencies.env.PUBLIC_BASE_URL, apply: true, fetcher: dependencies.fetcher })
        .then((result) => { if (result.action === "set") log({ level: "info", event: "call_end_callback_set", tenantId: account.tenantId }); })
        .catch((error) => {
          log({ level: "error", event: "go_live_call_end_callback_failed", tenantId: account.tenantId, error: safeError(error) });
          throw new HttpError(502, "We couldn’t connect your Call Otto number just now. Try again in a minute.");
        });
      // Carrier spam screening: flag by default (the assistant checks intent sooner), reject only with
      // CALL_SCREENING_MODE=reject. Idempotent on every activation; a failure is logged and never blocks
      // the line (scripts/enable-call-screening.ts backfills).
      await ensureInboundCallScreening({ apiKey: dependencies.env.TELNYX_API_KEY!, phoneNumber: inboundNumber, setting: callScreeningSetting(dependencies.env.CALL_SCREENING_MODE), apply: true, fetcher: dependencies.fetcher })
        .catch((error) => log({ level: "error", event: "call_screening_enable_failed", tenantId: account.tenantId, error: safeError(error) }));
      const now = dependencies.clock.now().toISOString();
      // Map first: a call that arrives the instant the number connects must already resolve to this shop.
      await dependencies.store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", inboundNumber);
      await dependencies.store.saveProviderRoute({ provider: "telnyx", externalId: assistantId, tenantId: account.tenantId, createdAt: existingRoute?.createdAt ?? now, updatedAt: now });
      try {
        await liveRoute.setPaused(false)
          .catch((error) => {
            log({ level: "error", event: "go_live_connect_failed", tenantId: account.tenantId, error: safeError(error) });
            throw new HttpError(502, "We couldn’t connect your Call Otto number just now. Try again in a minute.");
          });
        // Re-read under the config lock and change only `paused`: the owner may have picked how calls work (or saved
        // settings) while the number was being bought, and writing back the copy read above would undo it. If the
        // assistant was just created from that older copy, bring it up to date too.
        await dependencies.store.withLock(`config:${account.tenantId}`, async () => {
          const fresh = await dependencies.store.getConfig(account.tenantId);
          const builtFrom = JSON.stringify(buildTelnyxAssistantUpdate(config, dependencies.env.PUBLIC_BASE_URL, { voice: dependencies.env.TELNYX_VOICE }));
          const wanted = JSON.stringify(buildTelnyxAssistantUpdate(fresh, dependencies.env.PUBLIC_BASE_URL, { voice: dependencies.env.TELNYX_VOICE }));
          if (builtFrom !== wanted) {
            await saveAssistantConfig(dependencies.store, dependencies.env, { ...fresh, paused: false }, dependencies.fetcher ?? fetch).catch(async (error: unknown) => {
              log({ level: "error", event: "go_live_assistant_resync_failed", tenantId: account.tenantId, error: safeError(error) });
              await dependencies.store.saveConfig({ ...fresh, paused: false });
            });
          } else {
            await dependencies.store.saveConfig({ ...fresh, paused: false });
          }
        });
        await dependencies.store.updateOwnerAccountStatus(account.id, "active", now);
        if (account.status !== "active") await announceLineLive(account, config.businessName, config.ownerNotificationRefs, inboundNumber, now);
      } catch (error) {
        await liveRoute.setPaused(true).catch((rollbackError) => log({ level: "error", event: "owner_activation_rollback_failed", tenantId: account.tenantId, error: safeError(rollbackError) }));
        throw error;
      }
      return inboundNumber;
    })));
  }

  /** Tell the owner their line just went live (push, email, and text once texting is approved). Never blocks go-live. */
  async function announceLineLive(account: OwnerAccount, businessName: string, smsRefs: string[], inboundNumber: string, now: string): Promise<void> {
    try {
      const email = dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL ? account.email : null;
      const pushOn = Boolean(vapid) && (await listPushSubscriptions(dependencies.store, account.tenantId)).length > 0;
      for (const notification of lineLiveNotifications({ tenantId: account.tenantId, businessName, inboundNumber, baseUrl: dependencies.env.PUBLIC_BASE_URL, email, pushOn, smsRefs, now })) {
        await dependencies.store.enqueueNotification(notification);
      }
    } catch (error) {
      log({ level: "warn", event: "line_live_notice_failed", tenantId: account.tenantId, error: safeError(error) });
    }
  }

  /**
   * Background, every few minutes on every replica (locked per shop inside goLive):
   * 1. A paid shop still waiting for its line (carrier approval, provider test mode) goes live the moment the
   *    prerequisites clear, and the owner hears "Your line is live". No owner tap needed.
   * 2. Once texting is approved (TELNYX_MESSAGING_APPROVED), every owner who opted in before approval gets the
   *    carrier-registered opt-in confirmation once; their texts then flow because the sender stops holding them.
   */
  async function runActivationJobs(): Promise<{ activated: number; blocked: number; optInConfirmations: number }> {
    const result = { activated: 0, blocked: 0, optInConfirmations: 0 };
    const providerReady = liveProviderBlockers().length === 0 && Boolean(stripeClient);
    for (const tenantId of await dependencies.store.listTenantIds()) {
      try {
        await activationJobsForShop(tenantId, providerReady, result);
      } catch (error) {
        // One bad shop never stops the scan for the rest.
        log({ level: "error", event: "activation_job_shop_failed", tenantId, error: safeError(error) });
      }
    }
    return result;
  }

  async function activationJobsForShop(tenantId: string, providerReady: boolean, result: { activated: number; blocked: number; optInConfirmations: number }): Promise<void> {
    {
      const account = await dependencies.store.getOwnerAccountByTenant(tenantId);
      if (!account) return;
      if (providerReady && account.status === "pending_activation" && isPaidStatus((await dependencies.store.getSubscription(tenantId))?.status)) {
        try {
          await goLive(account, null);
          result.activated += 1;
          log({ level: "info", event: "line_auto_activated", tenantId });
        } catch (error) {
          result.blocked += 1;
          log({ level: error instanceof HttpError && error.status < 500 ? "info" : "error", event: "line_auto_activation_blocked", tenantId, status: error instanceof HttpError ? error.status : 500, error: safeError(error) });
        }
      }
      if (dependencies.env.TELNYX_MESSAGING_APPROVED) {
        const config = await dependencies.store.getConfig(tenantId);
        if (config.ownerNotificationRefs.length > 0 && await dependencies.store.getIntegrationSecret(tenantId, "notifications", "owner_sms_consent")) {
          const queued = await dependencies.store.withLock(`optin-confirm:${tenantId}`, async () => {
            if (await dependencies.store.getIntegrationSecret(tenantId, "notifications", "optin_confirmation_queued_at")) return false;
            await enqueueOptInConfirmation(tenantId, `owner-optin:${tenantId}:approved`);
            return true;
          });
          if (queued) result.optInConfirmations += 1;
        }
      }
    }
  }

  /** Records how a go-live ended: live, blocked (4xx: a prerequisite is missing) or failed (5xx: provider or server). */
  function trackGoLive(tenantId: string, attempt: Promise<string>): Promise<string> {
    return attempt.then(
      (inboundNumber) => {
        telemetry.capture("go_live_result", tenantId, tenantId, { result: "live", http_status: 200 });
        return inboundNumber;
      },
      (error: unknown) => {
        const httpStatus = error instanceof HttpError ? error.status : 500;
        telemetry.capture("go_live_result", tenantId, tenantId, { result: httpStatus < 500 ? "blocked" : "failed", http_status: httpStatus });
        throw error;
      },
    );
  }

  /** Numbers and assistants we bought for a shop go back to Telnyx when the shop is deleted. Best effort: logged, never blocks deletion. */
  async function releaseProvisionedLine(tenantId: string): Promise<void> {
    await releaseLine(graceContext, tenantId);
  }

  /** Every voice-routing change knows the shared voicemail app, so a number in its billing grace period is still ours to move. */
  function voiceRouting(phoneNumber: string, assistantId: string): TelnyxVoiceRoutingClient {
    return new TelnyxVoiceRoutingClient({
      apiKey: dependencies.env.TELNYX_API_KEY!, phoneNumber, assistantId,
      voicemailConnectionId: dependencies.env.TELNYX_VOICEMAIL_APP_ID,
      ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
    });
  }

  /** Detach the shop's number from the assistant so callers do not reach an AI that can save nothing. */
  async function pauseLiveRoute(tenantId: string): Promise<void> {
    const [route, inboundNumber] = await Promise.all([
      dependencies.store.getProviderRouteForTenant("telnyx", tenantId),
      dependencies.store.getIntegrationSecret(tenantId, "telnyx", "inbound_number"),
    ]);
    if (!route || !inboundNumber || !dependencies.env.TELNYX_API_KEY) return;
    await voiceRouting(inboundNumber, route.externalId).setPaused(true);
  }

  /**
   * Billing grace line: point the shop's number at the shared voicemail app instead of
   * disconnecting it. Returns false (and changes nothing) when there is no voicemail app or no line.
   */
  async function startGraceLine(tenantId: string): Promise<boolean> {
    if (!dependencies.env.TELNYX_VOICEMAIL_APP_ID || !dependencies.env.TELNYX_API_KEY) return false;
    const [route, inboundNumber] = await Promise.all([
      dependencies.store.getProviderRouteForTenant("telnyx", tenantId),
      dependencies.store.getIntegrationSecret(tenantId, "telnyx", "inbound_number"),
    ]);
    if (!route || !inboundNumber) return false;
    // Re-save so shops provisioned before the number lookup existed can be found by the number callers dial.
    await dependencies.store.saveIntegrationSecret(tenantId, "telnyx", "inbound_number", inboundNumber);
    await voiceRouting(inboundNumber, route.externalId).setVoicemail();
    if (!await graceStartedAt(dependencies.store, tenantId)) {
      await dependencies.store.saveIntegrationSecret(tenantId, GRACE_PROVIDER, GRACE_STARTED_KEY, dependencies.clock.now().toISOString());
    }
    return true;
  }

  async function readForwarding(tenantId: string): Promise<ForwardingState> {
    const [businessNumber, carrierJson, confirmedAt, checkJson, helpRequestedAt, setupCallJson, testedForJson, founderEmail] = await Promise.all([
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "business_number"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "carrier"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "confirmed_at"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "check"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "help_requested_at"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "setup_call"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "tested_for"),
      founder.lastEmail(tenantId),
    ]);
    const parse = <T>(value: string | null): T | null => { try { return value ? JSON.parse(value) as T : null; } catch { return null; } };
    const check = parse<ForwardingCheckRecord>(checkJson);
    return {
      businessNumber, carrier: parse<CarrierInfo>(carrierJson), confirmedAt, testedFor: parseTestedFor(testedForJson),
      check: check ? { startedAt: check.startedAt, method: check.method, answeredAt: check.answeredAt ?? null, endedAt: check.endedAt ?? null, hangupCause: check.hangupCause ?? null, screenedAt: check.screenedAt ?? null, amdResult: check.amdResult ?? null, code: check.code ?? null, choice: check.choice ?? null, autoFailed: check.autoFailed === true, forwardedAfterMs: typeof check.forwardedAfterMs === "number" ? check.forwardedAfterMs : null, atOnce: check.atOnce === true, rangFirst: check.rangFirst === true } : null,
      helpRequestedAt,
      helpCall: ((call) => call?.to && call.startedAt ? { to: call.to, startedAt: call.startedAt, answeredAt: call.answeredAt ?? null, endedAt: call.endedAt ?? null, outcome: call.outcome ?? null, booked: Boolean(call.bookedAt) } : null)(readSetupCall(setupCallJson)),
      founderEmail,
    };
  }

  /**
   * Steps of our check call. Answered: unless the forwarded call already reached Call Otto (then we
   * hung this leg up), say what this call is, so a person or a call screener never hears dead air,
   * and note when it was picked up. Done speaking: hang up. Hung up: note how it ended. How fast it was
   * picked up tells the owner what went wrong (their phone or a screener vs. their voicemail).
   */
  function setupCallsConfigured(): boolean {
    const env = dependencies.env;
    return Boolean(env.TELNYX_API_KEY && env.TELNYX_CHECK_CONNECTION_ID && env.TELNYX_FROM_NUMBER && !env.PROVIDER_TEST_MODE && !env.DEMO_MODE);
  }

  function setupCaller(): TelnyxSetupCaller | null {
    if (!dependencies.env.TELNYX_API_KEY) return null;
    return new TelnyxSetupCaller({
      apiKey: dependencies.env.TELNYX_API_KEY,
      templateAssistantId: dependencies.env.TELNYX_TEMPLATE_ASSISTANT_ID ?? dependencies.env.TELNYX_ASSISTANT_ID ?? null,
      setupAssistantId: dependencies.env.TELNYX_SETUP_ASSISTANT_ID ?? null,
      publicBaseUrl: dependencies.env.PUBLIC_BASE_URL,
      voice: dependencies.env.TELNYX_VOICE,
      getSecret: (tenantId, provider, key) => dependencies.store.getIntegrationSecret(tenantId, provider, key),
      saveSecret: (tenantId, provider, key, value) => dependencies.store.saveIntegrationSecret(tenantId, provider, key, value),
      ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
    });
  }

  /**
   * Start a forwarding test: our call to the business phone (or a manual test from another phone). The owner app's
   * Test it and the setup helper's start_forwarding_test both come here. Throws HttpError with the owner's words.
   */
  async function startForwardingCheck(tenantId: string): Promise<void> {
    const [lineNumber, state] = await Promise.all([
      dependencies.store.getIntegrationSecret(tenantId, "telnyx", "inbound_number"),
      readForwarding(tenantId),
    ]);
    if (!lineNumber) throw new HttpError(409, "Turn on your Call Otto line first.");
    if (!state.businessNumber) throw new HttpError(409, "Add your business phone number first.");
    if (!limiter.allow(`forwarding-check:${tenantId}`, 6, 60 * 60_000)) throw new HttpError(429, "That’s a lot of checks. Please wait a few minutes and try again.");
    // What the owner is set up for right now (their choice and the code on screen): a pass records it.
    const config = await dependencies.store.getConfig(tenantId);
    const code = state.carrier ? forwardingPlan(state.carrier.family, lineNumber, config.operationMode, config.answerAfterRings).on : null;
    const choice = forwardingChoice(config.operationMode);
    await hangUpLiveCheck(tenantId);
    const startedAt = dependencies.clock.now().toISOString();
    const connectionId = dependencies.env.TELNYX_CHECK_CONNECTION_ID;
    const from = dependencies.env.TELNYX_FROM_NUMBER;
    let method: "auto" | "manual" = "manual";
    let callControlId: string | null = null;
    const autoConfigured = Boolean(connectionId && from && dependencies.env.TELNYX_API_KEY && !dependencies.env.PROVIDER_TEST_MODE);
    if (connectionId && from && dependencies.env.TELNYX_API_KEY && !dependencies.env.PROVIDER_TEST_MODE) {
      callControlId = await new TelnyxForwardingClient({ apiKey: dependencies.env.TELNYX_API_KEY, ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}) })
        .placeCheckCall({ connectionId, from, to: state.businessNumber, tenantId: tenantId, startedAt, webhookUrl: `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx` })
        .catch((error) => { log({ level: "error", event: "forwarding_check_call_failed", tenantId: tenantId, error: safeError(error) }); return null; });
      if (callControlId) method = "auto";
    }
    // autoFailed: we meant to call their phone and couldn't, so the app says why and asks for a call from another phone.
    const autoFailed = autoConfigured && method === "manual";
    await dependencies.store.withLock(`forwarding-check:${tenantId}`, async () => {
      // The last finished test is kept, so Cancel on this one brings back what the card said before (a failure
      // stays a failure). A test still running when this one replaced it was never a result: the older one stays.
      const prior = await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "check");
      if (prior && state.check && forwardingCheckStatus(state.check, state.confirmedAt, startedAt) !== "calling") {
        await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "previous_check", prior);
      }
      await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "check", JSON.stringify({ startedAt, method, callControlId, code, choice, ...(autoFailed ? { autoFailed: true } : {}) }));
    });
    log({ level: "info", event: "forwarding_check_started", tenantId: tenantId, method, autoFailed });
  }

  /** "Email me these steps" (the owner app and the setup helper): the same steps the computer shows. True once queued. */
  async function emailForwardingSteps(tenantId: string, email: string): Promise<boolean> {
    const link = await newHandoffLink(tenantId, EMAILED_HANDOFF_TTL_MS);
    const now = dependencies.clock.now().toISOString();
    // The same steps the computer shows: every call on an iPhone (GSM family) is the Settings switch, with the
    // link for the rest (the code, for Verizon-family phones and odd carriers).
    const { plan, lineNumber } = await handoffPlan(tenantId);
    const iphone = plan && lineNumber && forwardingSteps({ device: "desktop", family: plan.family, everyCall: plan.forwardsAll }).on === "settings";
    const body = iphone
      ? formatEmailBody("Your Call Otto forwarding steps", `${settingsStepsText(lineNumber)}\n\nNot an iPhone, or no Call Forwarding? Open this on the phone your customers call:\n\n${link}\n\nThe link works for 24 hours.`)
      : formatEmailBody("Your Call Otto forwarding code", `Open this on the phone your customers call. It shows your code and how to dial it:\n\n${link}\n\nThe link works for 24 hours.`);
    const queued = await dependencies.store.enqueueNotification({
      id: randomUUID(), tenantId: tenantId, callId: null, channel: "email", destinationRef: `email:${email}`,
      body,
      priority: "high", state: "pending", attempts: 0, nextAttemptAt: now,
      idempotencyKey: `handoff-email:${tenantId}:${now}`, providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
    });
    return queued;
  }

  /** What the setup helper is told about this shop: only what we stored. Null until the line has a number. */
  async function setupCallFacts(tenantId: string, device: SetupCallFacts["device"]): Promise<{ facts: SetupCallFacts; state: ForwardingState } | null> {
    const [config, state, lineNumber] = await Promise.all([
      dependencies.store.getConfig(tenantId),
      readForwarding(tenantId),
      dependencies.store.getIntegrationSecret(tenantId, "telnyx", "inbound_number"),
    ]);
    if (!lineNumber) return null;
    const family = state.carrier?.family ?? null;
    const plan = family ? forwardingPlan(family, lineNumber, config.operationMode, config.answerAfterRings) : null;
    const everyCall = family ? forwardingPlan(family, lineNumber, "always") : null;
    const ringFirst = family ? forwardingPlan(family, lineNumber, "overflow", config.answerAfterRings) : null;
    const facts: SetupCallFacts = {
      businessName: config.businessName,
      businessNumber: state.businessNumber,
      carrierName: state.carrier?.name ?? null,
      family,
      code: plan?.on ?? null,
      offCode: plan?.off ?? null,
      confirm: plan?.confirm ?? null,
      ottoNumber: lineNumber,
      device,
      ringSeconds: plan?.ringSeconds ?? null,
      forwardsAll: plan?.forwardsAll ?? false,
      everyCallCode: everyCall?.on ?? null,
      ringFirstCode: ringFirst?.on ?? null,
      ringFirstSeconds: ringFirst?.ringSeconds ?? null,
      // Only while ring first is picked: after switching to every call, the screen asks for the new code instead.
      phoneAnswersTest: !plan?.forwardsAll && forwardingCheckStatus(state.check, state.confirmedAt, dependencies.clock.now().toISOString()) === "phone_answers",
      // Leaving every call: the off code first, then the ring-first code (forward-all wins over it otherwise).
      everyCallOn: state.testedFor?.mode === "every-call",
    };
    return { facts, state };
  }

  /** The last forwarding test, in one plain line for the helper. */
  function setupTestSummary(state: ForwardingState): SetupTestSummary {
    const status = forwardingCheckStatus(state.check, state.confirmedAt, dependencies.clock.now().toISOString());
    return SETUP_TEST_WORDS[status] ?? { status: "not_run", detail: "No test yet." };
  }

  /** Answered: start the setup helper with this shop's exact numbers and code. Only the latest setup call. */
  async function continueSetupCall(tenantId: string, phase: "help" | "sorry", envelope: ReturnType<typeof parseTelnyxEnvelope>): Promise<void> {
    const callControlId = envelope.data.payload.call_control_id;
    if (typeof callControlId !== "string") return;
    const caller = setupCaller();
    if (!caller) return;
    const clientState = typeof envelope.data.payload.client_state === "string" ? envelope.data.payload.client_state : "";
    // Only our apology ends in a hang-up; nothing the helper itself says ever does.
    if (phase === "sorry") { if (envelope.data.event_type === "call.speak.ended") await caller.hangUp(callControlId); return; }
    const type = envelope.data.event_type;
    if (type !== "call.answered" && type !== "call.hangup" && type !== AMD_ENDED_EVENT) return;
    const at = dependencies.clock.now().toISOString();
    // Read and write the call record under the same lock as the help endpoint, so an answer and a hang-up that
    // arrive together (or out of order) never both act on a stale record.
    const lockedCall = (task: (call: SetupCallRecord) => Promise<SetupCallRecord | null>) => dependencies.store.withLock(`setup-call:${tenantId}`, async () => {
      const call = readSetupCall(await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "setup_call"));
      return call && call.callControlId === callControlId ? task(call) : null;
    });
    if (type === AMD_ENDED_EVENT) {
      // Voicemail picked up: hang up (never leave a message) and the screen offers a time with our team instead.
      const result = typeof envelope.data.payload.result === "string" ? envelope.data.payload.result : null;
      if (result !== "machine") return;
      const machine = await lockedCall(async (call) => {
        if (call.endedAt || call.outcome === "voicemail") return null;
        await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "setup_call", JSON.stringify({ ...call, outcome: "voicemail" } satisfies SetupCallRecord));
        return call;
      });
      if (machine) {
        log({ level: "info", event: "setup_call_voicemail", tenantId });
        await caller.hangUp(callControlId);
      }
      return;
    }
    if (type === "call.hangup") {
      const cause = typeof envelope.data.payload.hangup_cause === "string" ? envelope.data.payload.hangup_cause.slice(0, 40) : null;
      const ended = await lockedCall(async (call) => {
        if (call.endedAt) return null;
        const outcome: SetupCallOutcome = call.outcome ?? (call.answeredAt ? "done" : "missed");
        await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "setup_call", JSON.stringify({ ...call, endedAt: at, hangupCause: cause, outcome } satisfies SetupCallRecord));
        return { ...call, outcome };
      });
      if (ended) {
        // Every support call is logged with how it ended (never the number or anything said).
        const talkedSec = ended.answeredAt ? Math.max(0, Math.round((Date.parse(at) - Date.parse(ended.answeredAt)) / 1_000)) : 0;
        log({ level: "info", event: "setup_call_ended", tenantId, outcome: ended.outcome, cause, talkedSec, booked: Boolean(ended.bookedAt) });
        await dependencies.store.deleteIntegrationSecret(PLATFORM_TENANT_ID, SETUP_HELP_PROVIDER, callControlId).catch(() => undefined);
      }
      // Rang out, busy or declined: the helper never got to talk, so our team emails now. Any other ending without a
      // recorded answer (a normal hang-up whose answer we haven't seen yet) is left to the 20-minute check.
      if (ended && !ended.answeredAt && cause && SETUP_CALL_MISSED_CAUSES.has(cause)) await founder.queueSafely(tenantId, "no_answer");
      return;
    }
    const call = await lockedCall(async (current) => {
      // The hang-up already came in (or voicemail did): there's no one to start the helper for.
      if (current.endedAt || current.outcome === "voicemail") return null;
      if (!current.answeredAt) await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "setup_call", JSON.stringify({ ...current, answeredAt: at }));
      return current;
    });
    if (!call) return;
    const built = await setupCallFacts(tenantId, call.device ?? "other");
    if (!built) return;
    await caller.start({
      callControlId,
      commandId: `setup-start:${envelope.data.id}`,
      clientState,
      test: setupTestSummary(built.state),
      facts: built.facts,
    }).then(() => log({ level: "info", event: "setup_call_started", tenantId }), async (error: unknown) => {
      // Never leave the owner on a silent line: queue Brock's email first, so the apology can say he just sent it,
      // then apologize and hang up when that's said.
      log({ level: "error", event: "setup_call_start_failed", tenantId, error: safeError(error) });
      await founder.queueSafely(tenantId, "helper_failed");
      const sent = await founder.lastEmail(tenantId).catch(() => null);
      const fresh = sent ? dependencies.clock.now().getTime() - Date.parse(sent.sentAt) < 10 * 60_000 : false;
      await caller.apologize(callControlId, `setup-sorry:${envelope.data.id}`, tenantId, setupSorrySpeech(sent ? { fresh, link: sent.link } : null));
    });
  }

  /**
   * The setup helper's tools. Signed by Telnyx; the shop comes from the call the tool runs on (our own record of the
   * call we placed), never from anything in the conversation, and only while that call is live.
   */
  async function handleSetupHelpTool(request: IncomingMessage, response: ServerResponse, name: string): Promise<void> {
    if (!(SETUP_HELP_TOOL_NAMES as readonly string[]).includes(name)) throw new HttpError(404, "Not found");
    const tool = name as SetupHelpToolName;
    const rawBody = await readBody(request, 8_000);
    requireProviderAuth(request, rawBody);
    let payload: Record<string, unknown> = {};
    try {
      const parsed = unwrapToolPayload(JSON.parse(rawBody));
      payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      payload = {};
    }
    // The call id from the signed body (the preset {{call_control_id}}), else the provider header.
    const fromBody = typeof payload.provider_call_id === "string" ? payload.provider_call_id : null;
    const callId = fromBody ?? singleHeader(request.headers["x-telnyx-call-control-id"]) ?? null;
    if (!callId || callId.length > MAX_PROVIDER_CALL_ID_LENGTH) return sendJson(response, 200, { status: "unavailable", say: "Sorry, I can't do that on this call." });
    if (!limiter.allow(`setup-help:${callId}`, 60, 60_000)) return sendJson(response, 200, { status: "unavailable", say: "One moment, then try again." });
    const tenantId = await dependencies.store.getIntegrationSecret(PLATFORM_TENANT_ID, SETUP_HELP_PROVIDER, callId);
    const call = tenantId ? readSetupCall(await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "setup_call")) : null;
    if (!tenantId || !call || call.callControlId !== callId || call.endedAt || !call.answeredAt) {
      log({ level: "warn", event: "setup_help_tool_refused", tool });
      return sendJson(response, 200, { status: "unavailable", say: "Sorry, I can't do that on this call." });
    }
    const account = await dependencies.store.getOwnerAccountByTenant(tenantId);
    if (!account || account.status === "suspended") return sendJson(response, 200, { status: "unavailable", say: "Sorry, I can't do that on this call." });
    const now = dependencies.clock.now();
    const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(call.answeredAt)) / 6_000) / 10);
    // About two minutes in and not solved: the helper offers a time with our team.
    const timing = { minutes_on_call: minutes, offer_team_time: minutes >= 2 };
    const reply = (body: Record<string, unknown>) => {
      log({ level: "info", event: "setup_help_tool", tenantId, tool, status: body.status });
      return sendJson(response, 200, { ...body, ...timing });
    };
    const config = await dependencies.store.getConfig(tenantId);
    if (tool === "start_forwarding_test") {
      try {
        await startForwardingCheck(tenantId);
      } catch (error) {
        if (error instanceof HttpError) return reply({ status: "not_started", say: error.message });
        throw error;
      }
      return reply({ status: "calling", say: "The test is calling your business phone now. Don't answer it. I'll tell you in a few seconds." });
    }
    if (tool === "get_test_result") {
      const state = await readForwarding(tenantId);
      const status = forwardingCheckStatus(state.check, state.confirmedAt, now.toISOString());
      const words = SETUP_TEST_WORDS[status];
      return reply({ status, say: words?.say ?? "There's no test yet." });
    }
    if (tool === "email_steps") {
      if (!dependencies.env.RESEND_API_KEY || !dependencies.env.RESEND_FROM_EMAIL) return reply({ status: "unavailable", say: "I can't email right now. The steps are on your Call Otto screen." });
      if (!limiter.allow(`handoff-email:${tenantId}`, 5, 24 * 60 * 60_000)) return reply({ status: "already_sent", say: "We've emailed these a few times today. Check your inbox and spam folder." });
      const queued = await emailForwardingSteps(tenantId, account.email);
      return reply(queued ? { status: "sent", say: "Done. The steps are in your email." } : { status: "failed", say: "That didn't send. The steps are on your Call Otto screen." });
    }
    if (tool === "get_open_times") {
      const existing = await founder.existingBooking(tenantId);
      if (existing) return reply({ status: "already_booked", say: `You're already booked with our team for ${slotFullLabel(existing.start, config.timezone)}.` });
      if (!await founderCalendars.connected().catch(() => false)) {
        await founder.queueSafely(tenantId, "asked_for_team");
        return reply({ status: "no_calendar", say: "I can't see our team's times right now. Our team will email you to set one up." });
      }
      const slots = await founder.openSlots().catch(() => null);
      if (!slots || slots.length === 0) {
        await founder.queueSafely(tenantId, "asked_for_team");
        return reply({ status: "nothing_open", say: "Nothing's open in the next few days. Our team will email you to set a time." });
      }
      // Three choices, the soonest on different days where possible.
      const picked: typeof slots = [];
      for (const slot of slots) if (picked.length < 3 && !picked.some((item) => slotFullLabel(item.start, config.timezone).split(" at ")[0] === slotFullLabel(slot.start, config.timezone).split(" at ")[0])) picked.push(slot);
      for (const slot of slots) if (picked.length < 3 && !picked.includes(slot)) picked.push(slot);
      return reply({ status: "open", times: picked.map((slot) => ({ slot_start: slot.start, label: slotFullLabel(slot.start, config.timezone) })) });
    }
    // book_time
    const start = typeof payload.slot_start === "string" ? payload.slot_start : "";
    if (payload.explicit_confirmation !== true) return reply({ status: "needs_confirmation", say: "Ask them to say yes to that exact time first." });
    const facts = await founderBookingFacts(account);
    let result: Awaited<ReturnType<typeof founder.book>>;
    try {
      result = await founder.book(tenantId, start, facts);
    } catch (error) {
      log({ level: "error", event: "setup_help_booking_failed", tenantId, error: safeError(error) });
      await founder.queueSafely(tenantId, "asked_for_team");
      return reply({ status: "failed", say: "I couldn't book that just now. Our team will email you to set a time." });
    }
    if (result.status === "taken") return reply({ status: "taken", say: "That time just got taken. Let me get the open times again." });
    if (result.status === "invalid") return reply({ status: "invalid", say: "That time isn't open. Let me get the open times again." });
    if (result.status === "no_calendar") {
      await founder.queueSafely(tenantId, "asked_for_team");
      return reply({ status: "no_calendar", say: "I can't book right now. Our team will email you to set a time." });
    }
    const when = slotFullLabel(result.slot.start, config.timezone);
    await dependencies.store.withLock(`setup-call:${tenantId}`, async () => {
      const latest = readSetupCall(await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "setup_call"));
      if (latest?.callControlId === callId && !latest.bookedAt) await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "setup_call", JSON.stringify({ ...latest, bookedAt: now.toISOString() } satisfies SetupCallRecord));
    });
    await queueTeamBookingEmail(tenantId, result.slot, facts);
    const last4 = facts.callNumber ? facts.callNumber.slice(-4) : null;
    return reply({ status: "booked", when, say: `You're booked for ${when}. Our team will call you${last4 ? ` at the number ending in ${spokenDigits(last4)}` : ""}. A confirmation email is on its way.` });
  }

  /** The support inbox's copy of a booking, with a calendar invite so it lands on the team calendar. Never throws. */
  async function queueTeamBookingEmail(tenantId: string, slot: { start: string; end: string }, facts: FounderBookingFacts): Promise<void> {
    if (!dependencies.env.SUPPORT_EMAIL) return;
    try {
      const at = dependencies.clock.now().toISOString();
      const details = [
        `Business: ${facts.businessName}`,
        `Call them at: ${prettyPhone(facts.callNumber) ?? "no number on file"}`,
        `Business number: ${prettyPhone(facts.businessNumber) ?? "not entered"}`,
        `Carrier: ${facts.carrier ?? "unknown"}`,
        `Forwarding code: ${facts.forwardingCode ?? "none yet"}`,
        `Call Otto number: ${prettyPhone(facts.ottoNumber) ?? "line not on yet"}`,
        `Account email: ${facts.email}`,
      ].join("\n");
      const ics = founderCallIcs({
        uid: `setup-help-${tenantId}-${slot.start}`.replace(/[^\w-]/g, "-"), start: slot.start, end: slot.end, now: dependencies.clock.now(),
        summary: `Call Otto setup: ${facts.businessName} (10 min)`, description: details,
      });
      await dependencies.store.enqueueNotification({
        id: randomUUID(), tenantId, callId: null, channel: "email", senderRef: "founder", destinationRef: `email:${dependencies.env.SUPPORT_EMAIL}`,
        body: formatEmailBody(`Setup call booked: ${facts.businessName}, ${slotFullLabel(slot.start, dependencies.env.FOUNDER_TIMEZONE)}`, `Booked by Otto's setup helper on a support call.\n\n${details}`, [{ filename: "call-otto-setup.ics", content: ics }]),
        priority: "high", state: "pending", attempts: 0, nextAttemptAt: at,
        idempotencyKey: `setup-help-booking:${tenantId}:${slot.start}:team`, providerReceipt: null, lastError: null, createdAt: at, sentAt: null,
      });
    } catch (error) {
      log({ level: "error", event: "setup_help_team_email_failed", tenantId, error: safeError(error) });
    }
  }

  /** What the team's calendar event and confirmation need about the shop. */
  async function founderBookingFacts(account: OwnerAccount): Promise<FounderBookingFacts> {
    const [config, state, ownerPhone, lineNumber] = await Promise.all([
      dependencies.store.getConfig(account.tenantId),
      readForwarding(account.tenantId),
      dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
      dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number"),
    ]);
    const family = state.carrier?.family ?? null;
    const plan = family && lineNumber ? forwardingPlan(family, lineNumber, config.operationMode, config.answerAfterRings) : null;
    return {
      ownerName: ownerFirstName(account.displayName) ? account.displayName : null,
      email: account.email,
      businessName: config.businessName,
      timezone: config.timezone,
      callNumber: ownerPhone ?? state.businessNumber,
      businessNumber: state.businessNumber,
      carrier: state.carrier?.name ?? null,
      forwardingCode: plan?.on ?? null,
      ottoNumber: lineNumber,
    };
  }

  /** /book-setup: the owner picks a 10-minute call with Brock (GET), or books the time they tapped (POST). */
  async function handleFounderBooking(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    response.setHeader("cache-control", "private, no-store");
    const form = method === "POST" ? parseForm(await readBody(request, 4_000)) : null;
    const key = dependencies.env.SESSION_SIGNING_KEY;
    const parsed = key ? readFounderBookingToken(key, form ? form.get("t") : url.searchParams.get("t"), dependencies.clock.now()) : null;
    const account = parsed ? await dependencies.store.getOwnerAccountByTenant(parsed.tenantId) : null;
    if (!parsed || !account || account.status === "suspended") return sendHtml(response, 404, renderFounderBooking({ state: "expired" }));
    const token = (form ? form.get("t") : url.searchParams.get("t"))!;
    const facts = await founderBookingFacts(account);
    const booked = (slot: { start: string; end: string }, justBooked: boolean) => renderFounderBooking({ state: "booked", slot, timeZone: facts.timezone, callNumber: prettyPhone(facts.callNumber), justBooked });
    // An existing booking also gets its confirmation queued here, if a failure skipped it (queued once).
    const existing = await founder.bookedCall(account.tenantId, facts);
    if (existing) return sendHtml(response, 200, booked(existing, false));
    let taken = false;
    if (form) {
      if (!limiter.allow(`${requestIp(request)}:book-setup`, 20, 10 * 60_000)) throw new HttpError(429, "Too many tries. Please wait a few minutes.");
      try {
        const result = await founder.book(account.tenantId, form.get("start") ?? "", facts);
        if (result.status === "booked") return sendHtml(response, 200, booked(result.slot, true));
        if (result.status === "no_calendar") return sendHtml(response, 200, renderFounderBooking({ state: "reply", reason: "no_calendar" }));
        taken = true;
      } catch (error) {
        log({ level: "error", event: "founder_booking_failed", tenantId: account.tenantId, error: safeError(error) });
        return sendHtml(response, 503, renderFounderBooking({ state: "reply", reason: "unavailable" }));
      }
    }
    if (!await founderCalendars.connected()) {
      log({ level: "warn", event: "founder_calendar_not_connected", tenantId: account.tenantId });
      return sendHtml(response, 200, renderFounderBooking({ state: "reply", reason: "no_calendar" }));
    }
    let slots;
    try {
      slots = await founder.openSlots();
    } catch (error) {
      log({ level: "error", event: "founder_slots_failed", tenantId: account.tenantId, error: safeError(error) });
      return sendHtml(response, 503, renderFounderBooking({ state: "reply", reason: "unavailable" }));
    }
    if (slots.length === 0) return sendHtml(response, 200, renderFounderBooking({ state: "reply", reason: "nothing_open" }));
    return sendHtml(response, taken ? 409 : 200, renderFounderBooking({ state: "pick", token, businessName: facts.businessName, timeZone: facts.timezone, slots, taken }));
  }

  /**
   * /admin/review-account?k=...: makes the Google OAuth review account (or gives it a new password) and shows the
   * password once. Only a signed link (purpose "review-account", at most 24 hours) opens it; no admin session.
   */
  async function handleReviewAccount(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
    const signingKey = dependencies.env.SESSION_SIGNING_KEY!;
    const k = url.searchParams.get("k");
    // Never indexed, cached or sent on as a referrer: the page carries a password.
    response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    if (!reviewAccountTokenValid(signingKey, k, dependencies.clock.now())) {
      if (k && !limiter.allow(`${requestIp(request)}:review-link`, 20, 15 * 60_000)) throw new HttpError(429, "Too many requests");
      return sendHtml(response, 401, renderLogin());
    }
    // A chat app's link preview must not reset the password Brock just copied: it gets a page that changes nothing.
    if (isLinkPreview(request.headers["user-agent"])) {
      return sendHtml(response, 200, renderReviewAccount({ state: "error", message: "Open this link in a browser to see the review account." }));
    }
    try {
      const result = await ensureReviewAccount(dependencies.store, dependencies.clock);
      // The password is never logged.
      log({ level: "warn", event: result.created ? "review_account_created" : "review_account_password_reset", tenantId: result.tenantId });
      return sendHtml(response, 200, renderReviewAccount({ state: "ready", email: result.email, password: result.password, loginUrl: `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/login`, created: result.created }));
    } catch (error) {
      if (!(error instanceof ReviewAccountError)) throw error;
      log({ level: "error", event: "review_account_refused", error: safeError(error) });
      return sendHtml(response, 409, renderReviewAccount({ state: "error", message: error.message }));
    }
  }

  /**
   * /admin/founder-calendars: connect Brock's Google accounts, pick which one takes bookings, see his windows.
   * Open with the admin session, or with a signed link (k) that lasts at most 24 hours; on a form, k is the CSRF proof.
   */
  async function handleFounderCalendars(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    const signingKey = dependencies.env.SESSION_SIGNING_KEY!;
    const now = dependencies.clock.now();
    const session = readCookie(request, "afo_admin");
    const bearer = bearerMatches(request, dependencies.env.ADMIN_TOKEN);
    const adminSession = verifyAdminSession(session, signingKey);
    const form = method === "POST" ? parseForm(await readBody(request, 4_000)) : null;
    const k = form ? form.get("k") : url.searchParams.get("k");
    const linked = founderConnectTokenValid(signingKey, k, now);
    if (!bearer && !adminSession && !linked) {
      if (k && !limiter.allow(`${requestIp(request)}:founder-link`, 20, 15 * 60_000)) throw new HttpError(429, "Too many requests");
      return sendHtml(response, 401, renderLogin());
    }
    const viaLink = linked && !bearer && !adminSession;
    const back = (query: string): string => `/admin/founder-calendars?${viaLink ? `k=${encodeURIComponent(k!)}&` : ""}${query}`;
    if (method === "GET" && url.pathname === "/admin/founder-calendars/connect") {
      const client = clientForNewConnections(dependencies.env);
      if (!client) throw new HttpError(503, "Google OAuth is not configured on the server");
      const secure = dependencies.env.NODE_ENV === "production";
      const attempt = createGoogleOAuthAttempt(oauthAttemptKey(`${signingKey}:founder-calendar`, client.name), secure, now.getTime(), FOUNDER_OAUTH_PATH);
      const value = attempt.cookie.slice(attempt.cookie.indexOf("=") + 1, attempt.cookie.indexOf(";"));
      const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorization.search = new URLSearchParams({
        client_id: client.id,
        redirect_uri: `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/integrations/google/callback`,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        scope: FOUNDER_GOOGLE_SCOPES.join(" "),
        state: attempt.state,
        code_challenge: attempt.challenge,
        code_challenge_method: "S256",
      }).toString();
      // The way back: the link this connect started with, never a fresh one. A connect with admin access mints no
      // link at all (one in the address would sit in history and logs and work without the session).
      const returnLink = viaLink ? k! : FOUNDER_RETURN_ADMIN;
      response.setHeader("set-cookie", [
        `${FOUNDER_OAUTH_COOKIE}=${value}; Path=${FOUNDER_OAUTH_PATH}; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`,
        `${FOUNDER_RETURN_COOKIE}=${encodeURIComponent(returnLink)}; Path=${FOUNDER_OAUTH_PATH}; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`,
      ]);
      return redirect(response, authorization.toString());
    }
    if (form) {
      if (!linked && !bearer && !(session && verifyCsrf(session, form.get("csrf"), signingKey))) throw new HttpError(403, "Invalid CSRF token");
      const accountId = form.get("account") ?? "";
      if (url.pathname === "/admin/founder-calendars/book-here") {
        const done = await founderCalendars.setBookHere(accountId);
        return redirect(response, back(done ? "done=book-here" : "error=missing"));
      }
      if (url.pathname === "/admin/founder-calendars/disconnect") {
        await founderCalendars.disconnect(accountId);
        log({ level: "info", event: "founder_calendar_disconnected" });
        return redirect(response, back("done=disconnected"));
      }
      throw new HttpError(404, "Not found");
    }
    if (method !== "GET" || url.pathname !== "/admin/founder-calendars") throw new HttpError(404, "Not found");
    const accounts = await founderCalendars.accounts();
    let readError: string | null = null;
    let perAccount: Record<string, number> = {};
    const preview = accounts.length === 0 ? [] : await founder.openSlotsByAccount().then((result) => {
      perAccount = result.perAccount;
      return result.all;
    }).catch((error: unknown) => {
      log({ level: "warn", event: "founder_slots_failed", error: safeError(error), ...(error instanceof FounderCalendarReadError ? { accountId: error.accountId, reason: error.reason } : {}) });
      if (error instanceof FounderCalendarReadError) readError = `Couldn't read ${error.account} (${error.reason}). Disconnect it or connect it again.`;
      return null;
    });
    const notices: Record<string, string> = { connected: "Connected. Connect another account, or pick which one takes bookings.", "book-here": "Saved. New setup calls go on that calendar.", disconnected: "Disconnected." };
    const errors: Record<string, string> = { declined: "Google sign-in was cancelled. Connect again when you're ready.", partial: "That account isn't connected. Leave both calendar boxes ticked and connect again.", failed: "Couldn't connect that account. Try again.", missing: "That account isn't connected anymore." };
    return sendHtml(response, 200, renderFounderCalendars({
      accounts,
      auth: viaLink ? { k: k! } : { csrf: session && adminSession ? csrfForSession(session, signingKey) : "bearer-auth" },
      connectHref: viaLink ? `/admin/founder-calendars/connect?k=${encodeURIComponent(k!)}` : "/admin/founder-calendars/connect",
      windows: dependencies.env.FOUNDER_BOOKING_WINDOWS,
      timeZone: dependencies.env.FOUNDER_TIMEZONE,
      preview,
      readError,
      perAccount,
      notice: notices[url.searchParams.get("done") ?? ""],
      error: errors[url.searchParams.get("error") ?? ""],
    }));
  }

  /**
   * Google's return from a founder calendar connect, at the shared redirect URI. False (handled elsewhere, as
   * today) unless the state was signed for a founder connect and matches this browser's founder cookie.
   */
  async function finishFounderConnect(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const signingKey = dependencies.env.SESSION_SIGNING_KEY;
    if (!signingKey) return false;
    const now = dependencies.clock.now();
    const attempt = clientForAttempt(dependencies.env, `${signingKey}:founder-calendar`, (key) => verifyGoogleOAuthAttempt(url.searchParams.get("state"), readCookie(request, FOUNDER_OAUTH_COOKIE), key, now.getTime()));
    if (!attempt) return false;
    const secure = dependencies.env.NODE_ENV === "production";
    response.setHeader("set-cookie", [FOUNDER_OAUTH_COOKIE, FOUNDER_RETURN_COOKIE].map((name) => `${name}=; Path=${FOUNDER_OAUTH_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`));
    // Back to the calendars page with the same signed link the connect started with, never a new one (so a link
    // can't renew itself here), and none once it has run out.
    const returnLink = readCookie(request, FOUNDER_RETURN_COOKIE);
    const linked = returnLink && founderConnectTokenValid(signingKey, returnLink, now) ? returnLink : null;
    const back = (query: string): void => {
      const target = `/admin/founder-calendars?${linked ? `k=${encodeURIComponent(linked)}&` : ""}${query}`;
      if (linked || returnLink !== FOUNDER_RETURN_ADMIN) return redirect(response, target);
      // Started with admin access: a redirect at the end of Google's trip leaves the SameSite=Strict admin cookie
      // behind, but this page's own refresh is a same-site navigation, so the admin session opens the page.
      sendHtml(response, 200, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Founder calendars</title><p><a href="${target}">Back to your calendars</a></p>`);
    };
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || !code) {
      back("error=declined");
      return true;
    }
    try {
      const result = await founderCalendars.exchangeCode(attempt.client, code, attempt.result, `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/integrations/google/callback`);
      const account = await founderCalendars.connect({ client: attempt.client, ...result });
      log({ level: "info", event: "founder_calendar_connected", accountId: account.id, calendars: account.calendarsSource });
      back("done=connected");
    } catch (error) {
      log({ level: "warn", event: "founder_calendar_connect_failed", error: safeError(error) });
      back(`error=${error instanceof FounderConnectError ? "partial" : "failed"}`);
    }
    return true;
  }

  async function continueForwardingCheck(tenantId: string, startedAt: string | null, envelope: ReturnType<typeof parseTelnyxEnvelope>): Promise<void> {
    // One check record per shop, written by the check endpoint and by each of these steps: never interleave.
    const speak = await dependencies.store.withLock(`forwarding-check:${tenantId}`, () => continueForwardingCheckLocked(tenantId, startedAt, envelope));
    if (!speak) return;
    // Picked up. If forwarding works, Call Otto's own line is what answered: give that a moment to register,
    // then say what this call is (to a person or a screener) instead of dead air, or hang up if it can't be said.
    await new Promise((resolve) => setTimeout(resolve, dependencies.env.NODE_ENV === "test" ? 0 : 1_500));
    const confirmedAt = await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "confirmed_at");
    if (confirmedAt && confirmedAt >= speak.startedAt) return;
    const client = new TelnyxForwardingClient({ apiKey: dependencies.env.TELNYX_API_KEY!, ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}) });
    const spoke = await client.speak(speak.callControlId, FORWARDING_CHECK_SPEECH, `check-speak:${envelope.data.id}`, typeof envelope.data.payload.client_state === "string" ? envelope.data.payload.client_state : null);
    if (!spoke) await client.hangUp(speak.callControlId);
    log({ level: "info", event: "forwarding_check_answered_by_phone", tenantId, afterMs: speak.afterMs });
  }

  async function continueForwardingCheckLocked(tenantId: string, startedAt: string | null, envelope: ReturnType<typeof parseTelnyxEnvelope>): Promise<{ callControlId: string; startedAt: string; afterMs: number } | null> {
    const callControlId = envelope.data.payload.call_control_id;
    if (typeof callControlId !== "string") return null;
    if (envelope.data.event_type === "call.speak.ended") {
      // Our explanation finished on one of our own test legs (client_state says so): always hang it up, even when a
      // newer test has started, so an old leg never sits on the owner's phone while the next test rings it.
      if (dependencies.env.TELNYX_API_KEY) await new TelnyxForwardingClient({ apiKey: dependencies.env.TELNYX_API_KEY, ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}) }).hangUp(callControlId);
      return null;
    }
    let check: ForwardingCheckRecord | null = null;
    try { check = JSON.parse(await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "check") ?? "null") as ForwardingCheckRecord | null; } catch { check = null; }
    // This call's test isn't saved yet (a very fast pick-up beat our own save): have Telnyx send it again.
    if (startedAt && (!check || check.startedAt < startedAt)) throw new Error("Forwarding check not saved yet");
    // Only the latest check's leg; an older leg finishing late never rewrites a newer test.
    if (!check || (startedAt ? check.startedAt !== startedAt : check.callControlId !== callControlId)) return null;
    if (!check.callControlId) check = { ...check, callControlId };
    const at = envelope.data.occurred_at ?? dependencies.clock.now().toISOString();
    const type = envelope.data.event_type;
    if (type === "call.answered") {
      if (!check.answeredAt) await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "check", JSON.stringify({ ...check, answeredAt: at }));
      const confirmedAt = await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "confirmed_at");
      if ((confirmedAt && confirmedAt >= check.startedAt) || !dependencies.env.TELNYX_API_KEY) return null;
      return { callControlId, startedAt: check.startedAt, afterMs: Date.parse(at) - Date.parse(check.startedAt) };
    }
    if (type === SCREENING_DETECTED_EVENT || type === AMD_ENDED_EVENT || type === GREETING_ENDED_EVENT) {
      // Premium AMD on our test call. The phone's own screener (iOS Call Screening or Live Voicemail) answering
      // means carrier forwarding can never fire: the app says so at once, while our short explanation plays.
      // Telnyx sends "machine" first for Apple's screener too, then the screening tone (call_screening.detected) or
      // the end of its prompt (greeting.ended: prompt_ended). Only the first verdict is kept.
      const confirmedAt = await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "confirmed_at");
      if (confirmedAt && confirmedAt >= check.startedAt) return null;
      const result = typeof envelope.data.payload.result === "string" ? envelope.data.payload.result.slice(0, 40) : null;
      const screened = type === SCREENING_DETECTED_EVENT || (type === GREETING_ENDED_EVENT && result === "prompt_ended");
      if (screened && !check.screenedAt) {
        await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "check", JSON.stringify({ ...check, screenedAt: at }));
        log({ level: "info", event: "forwarding_check_phone_screens", tenantId, afterMs: Date.parse(at) - Date.parse(check.startedAt) });
      }
      if (type === AMD_ENDED_EVENT && result && !check.amdResult) await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "check", JSON.stringify({ ...check, amdResult: result }));
      return null;
    }
    if (type === "call.hangup") {
      const cause = typeof envelope.data.payload.hangup_cause === "string" ? envelope.data.payload.hangup_cause.slice(0, 40) : null;
      if (!check.endedAt) await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "check", JSON.stringify({ ...check, endedAt: at, hangupCause: cause }));
      log({ level: "info", event: "forwarding_check_ended", tenantId, answered: Boolean(check.answeredAt), cause });
    }
    return null;
  }

  /**
   * Every inbound call proves the forwarded line reaches us, except one from the business number itself: that's a
   * real call (the owner dialing Otto from that phone, or a genuine missed call), never proof, unless our automatic
   * check is open (some carriers show the forwarding phone's own number on the forwarded test).
   * Our own number (TELNYX_FROM_NUMBER) only ever calls owners (tests, urgent alerts, the setup helper): one of those
   * reaching the shop's line was forwarded there. It proves forwarding works, it's ended at once and never becomes a
   * call record, so Otto never talks to Otto. A pass while a test is open records what the owner was set up for when
   * they started it; how long it took never decides which code is on.
   */
  async function noteForwardedCall(tenantId: string, callerPhone: string, callControlId: string, occurredAt?: string | null): Promise<"check" | "customer"> {
    const now = dependencies.clock.now();
    const [checkJson, businessNumber] = await Promise.all([
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "check"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "business_number"),
    ]);
    let check: ForwardingCheckRecord | null = null;
    try { check = checkJson ? JSON.parse(checkJson) as ForwardingCheckRecord : null; } catch { check = null; }
    const open = Boolean(check) && now.getTime() - Date.parse(check!.startedAt) < FORWARDING_CHECK_WINDOW_MS;
    const ours = Boolean(dependencies.env.TELNYX_FROM_NUMBER) && callerPhone === dependencies.env.TELNYX_FROM_NUMBER;
    const fromCheck = ours || (open && check?.method === "auto" && businessNumber !== null && callerPhone === businessNumber);
    if (!fromCheck && businessNumber !== null && callerPhone === businessNumber) return "customer";
    // The setup helper ringing the business number, forwarded back here: end its leg before the helper can start.
    if (ours) await endLoopedSetupCall(tenantId, businessNumber, now, open && check ? check.startedAt : null);
    await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "confirmed_at", now.toISOString());
    // Only the test's own leg records what it was set up for (a manual test comes from any phone): a customer call
    // landing during the test proves forwarding works, never which choice is on.
    if (open && check && (fromCheck || check.method === "manual")) {
      const choice = check.choice ?? forwardingChoice((await dependencies.store.getConfig(tenantId)).operationMode);
      // Our own call is timed from when we placed it to when Telnyx says it reached Otto (the event's own time: a
      // retried or slow webhook never stretches it). Ring first that got here with no ring: every call is still
      // forwarded, recorded as every call, so the card shows the one clear-it code and Otto keeps off this number
      // until a ring-first test passes. Every call that rang first: the every-call code isn't on yet.
      const eventMs = occurredAt ? Date.parse(occurredAt) : Number.NaN;
      const afterMs = eventMs - Date.parse(check.startedAt);
      // While the setup helper is on the line with that phone it's busy, and busy forwards at once: not timed then.
      const helper = readSetupCall(await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "setup_call"));
      const phoneBusy = Boolean(helper?.to && helper.to === businessNumber && !helper.endedAt && helper.startedAt && now.getTime() - Date.parse(helper.startedAt) < SETUP_CALL_STALE_MS);
      const timed = fromCheck && check.method === "auto" && !phoneBusy && Number.isFinite(afterMs) && afterMs >= 0;
      const atOnce = timed && choice === "ring-first" && ringFirstVerdict(afterMs) === "at_once";
      const rangFirst = timed && choice === "every-call" && everyCallVerdict(afterMs) === "rang";
      // Ring first is proven only by our own timed call: a test from another phone, or one we couldn't time, says
      // calls reach Otto but not that the phone rang first, so it never records ring first.
      const proves = choice === "every-call" ? !rangFirst : timed && !atOnce;
      // Under the test's lock, and only for the test that's still the newest: an older test landing late never
      // rewrites what a newer one recorded.
      await dependencies.store.withLock(`forwarding-check:${tenantId}`, async () => {
        let latest: ForwardingCheckRecord | null = null;
        try { latest = JSON.parse(await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "check") ?? "null") as ForwardingCheckRecord | null; } catch { latest = null; }
        if (latest?.startedAt !== check!.startedAt) return;
        if (timed) await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "check", JSON.stringify({ ...latest, forwardedAfterMs: afterMs, ...(atOnce ? { atOnce: true } : {}), ...(rangFirst ? { rangFirst: true } : {}) }));
        if (atOnce) await saveTestedFor(tenantId, { mode: "every-call", code: null, at: now.toISOString() });
        else if (proves) await saveTestedFor(tenantId, { mode: choice, code: check!.code ?? null, at: now.toISOString(), rangSeconds: choice === "ring-first" ? rangSeconds(afterMs) : null, ...(timed ? { timed: true } : {}) });
      });
      if (timed) log({ level: "info", event: atOnce ? "forwarding_check_forwards_all" : rangFirst ? "forwarding_check_rang_first" : "forwarding_check_timed", tenantId, afterMs, choice });
    }
    if (!fromCheck) return "customer";
    await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "check_inbound_call", callControlId);
    if (open && check?.callControlId && dependencies.env.TELNYX_API_KEY) {
      await new TelnyxForwardingClient({ apiKey: dependencies.env.TELNYX_API_KEY, ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}) })
        .hangUp(check.callControlId).catch((error) => log({ level: "warn", event: "forwarding_check_hangup_failed", tenantId, error: safeError(error) }));
    }
    log({ level: "info", event: "forwarding_check_passed", tenantId });
    return "check";
  }

  async function saveTestedFor(tenantId: string, record: TestedFor): Promise<void> {
    await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "tested_for", JSON.stringify(record));
  }

  /**
   * Our own call reached the shop's line while the setup helper was ringing the business number (placed in the last
   * minute, still up): it's the helper's leg, forwarded back. Mark it ended as looped under the setup-call lock (so its
   * answer never starts the helper) and hang it up; the screen says their phone already sends every call to Otto. How fast it came back
   * never decides what's on: a Decline, a busy phone or no signal forward as fast as forward-all does.
   * A test that started after the helper call is open: this call is that test (say the owner, on the phone with the
   * helper, tapped Call me now and the busy phone forwarded it), so the helper is left alone.
   */
  async function endLoopedSetupCall(tenantId: string, businessNumber: string | null, now: Date, openTestStartedAt: string | null): Promise<void> {
    if (!businessNumber) return;
    // Every call is on (picked, or what the last test found): their phone sends every call to Otto. Otherwise it was
    // missed or declined and forwarded like any missed call.
    const [config, testedFor] = await Promise.all([
      dependencies.store.getConfig(tenantId),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "tested_for"),
    ]);
    const outcome: SetupCallOutcome = config.operationMode === "always" || parseTestedFor(testedFor)?.mode === "every-call" ? "looped" : "missed";
    const ended = await dependencies.store.withLock(`setup-call:${tenantId}`, async () => {
      const call = readSetupCall(await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "setup_call"));
      // Any phone we rang for the helper (the owner's mobile, often the business number itself) that forwards here.
      if (!call?.callControlId || call.endedAt || !call.startedAt) return null;
      if (openTestStartedAt && Date.parse(openTestStartedAt) >= Date.parse(call.startedAt)) return null;
      const afterMs = now.getTime() - Date.parse(call.startedAt);
      if (!(afterMs < 60_000)) return null;
      await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "setup_call", JSON.stringify({ ...call, endedAt: now.toISOString(), hangupCause: "no_answer", outcome } satisfies SetupCallRecord));
      return { callControlId: call.callControlId, afterMs };
    });
    if (!ended) return;
    log({ level: "info", event: "setup_call_forwarded_back", tenantId, afterMs: ended.afterMs });
    log({ level: "info", event: "setup_call_ended", tenantId, outcome, cause: "forwarded_back", talkedSec: 0, booked: false });
    await setupCaller()?.hangUp(ended.callControlId).catch((error: unknown) => log({ level: "warn", event: "setup_call_hangup_failed", tenantId, error: safeError(error) }));
    // Looped: the screen says their phone already sends every call to Otto, with a time to book. Missed: our team emails.
    if (outcome === "missed") await founder.queueSafely(tenantId, "no_answer");
  }

  /**
   * Before a mode or ring-time change, write down what the phone may be set up for, since a pass only records what
   * a test proved:
   * - Leaving every call once its code (or website step) was on screen: the owner may have dialed forward-all, and it
   *   wins over the ring-first code. Recorded as every call unless a test already says so, so the card asks for the
   *   off code first and Otto keeps off the number (helper, urgent calls, transfers) until a ring-first test passes.
   * - Forwarding that worked before any test recorded anything: assume the old settings, so the change still shows
   *   the one new code to dial.
   */
  async function rememberLegacyTestedFor(tenantId: string, config: BusinessConfig, nextMode: ForwardingMode): Promise<void> {
    const [state, lineNumber] = await Promise.all([
      readForwarding(tenantId),
      dependencies.store.getIntegrationSecret(tenantId, "telnyx", "inbound_number"),
    ]);
    const plan = lineNumber && state.businessNumber && state.carrier ? forwardingPlan(state.carrier.family, lineNumber, config.operationMode, config.answerAfterRings) : null;
    const leavingEveryCall = config.operationMode === "always" && nextMode !== "always" && plan !== null && plan.family !== "unknown";
    if (leavingEveryCall) {
      if (state.testedFor?.mode === "every-call") return;
      await saveTestedFor(tenantId, { mode: "every-call", code: plan.on, at: dependencies.clock.now().toISOString() });
      return;
    }
    if (state.testedFor || !state.confirmedAt) return;
    await saveTestedFor(tenantId, { mode: forwardingChoice(config.operationMode), code: plan?.on ?? null, at: state.confirmedAt });
  }

  /**
   * "Test again" while the last test call is still up (the phone's screener still on the line, our explanation still
   * playing): hang it up and give it a moment to clear, so the new test never reaches a phone that's busy on the old
   * one (busy forwarding would send it to Otto and pass a phone that still answers calls itself).
   */
  async function hangUpLiveCheck(tenantId: string): Promise<void> {
    if (!dependencies.env.TELNYX_API_KEY) return;
    let previous: ForwardingCheckRecord | null = null;
    try { previous = JSON.parse(await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "check") ?? "null") as ForwardingCheckRecord | null; } catch { previous = null; }
    if (!previous?.callControlId || previous.method !== "auto" || previous.endedAt) return;
    if (dependencies.clock.now().getTime() - Date.parse(previous.startedAt) >= FORWARDING_CHECK_WINDOW_MS) return;
    // A test that reached Otto was already hung up when it passed.
    const confirmedAt = await dependencies.store.getIntegrationSecret(tenantId, "forwarding", "confirmed_at");
    if (confirmedAt && confirmedAt >= previous.startedAt) return;
    await new TelnyxForwardingClient({ apiKey: dependencies.env.TELNYX_API_KEY, ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}) })
      .hangUp(previous.callControlId).catch((error) => log({ level: "warn", event: "forwarding_check_hangup_failed", tenantId, error: safeError(error) }));
    // Something on the phone had it (a screener, Live Voicemail, a person): let the phone clear the call first.
    if (previous.answeredAt) await new Promise((resolve) => setTimeout(resolve, dependencies.env.NODE_ENV === "test" ? 0 : 1_500));
  }

  /** Lapse and restore run under `billing:<tenant>`, the lock the grace sweep holds while it releases a line. */
  async function handleBillingLapse(tenantId: string, status: SubscriptionRecord["status"], eventId: string): Promise<void> {
    await dependencies.store.withLock(`billing:${tenantId}`, () => handleBillingLapseLocked(tenantId, status, eventId));
  }

  async function handleBillingRestored(tenantId: string, eventId: string): Promise<void> {
    await dependencies.store.withLock(`billing:${tenantId}`, () => handleBillingRestoredLocked(tenantId, eventId));
  }

  async function handleBillingLapseLocked(tenantId: string, status: SubscriptionRecord["status"], eventId: string): Promise<void> {
    const account = await dependencies.store.getOwnerAccountByTenant(tenantId);
    if (account?.status !== "active") return;
    if ((await dependencies.store.getConfig(tenantId)).paused) return; // already off (billing or owner)
    // Billing lapse keeps the number answering with voicemail for the grace period; account deletion still disconnects.
    const grace = await startGraceLine(tenantId).catch((error) => {
      log({ level: "error", event: "billing_lapse_voicemail_failed", tenantId, error: safeError(error) });
      throw new HttpError(502, "Could not move the phone line to voicemail; Stripe will retry");
    });
    if (!grace) await pauseLiveRoute(tenantId).catch((error) => {
      log({ level: "error", event: "billing_lapse_pause_failed", tenantId, error: safeError(error) });
      throw new HttpError(502, "Could not pause the live phone route; Stripe will retry");
    });
    const config = await dependencies.store.withLock(`config:${tenantId}`, async () => {
      const current = await dependencies.store.getConfig(tenantId);
      // Remember that billing (not the owner) paused it, so payment can turn it back on.
      await dependencies.store.saveConfig({ ...current, paused: true, pausedForBilling: !current.paused || current.pausedForBilling === true });
      return current;
    });
    const now = dependencies.clock.now().toISOString();
    const statusWords = status === "past_due" ? "past due" : status === "canceled" ? "cancelled" : status.replace("_", " ");
    const offCode = forwardingOffInstruction((await readForwarding(tenantId)).carrier?.family ?? null);
    for (const destinationRef of config.ownerNotificationRefs) {
      await dependencies.store.enqueueNotification({
        id: randomUUID(), tenantId, callId: null, channel: "sms", destinationRef,
        body: grace
          ? `Call Otto is paused: your subscription is ${statusWords}. For the next ${GRACE_DAYS} days calls forwarded to your Call Otto line go to voicemail and we text you each message; after that the number stops working. Update billing in your dashboard, or ${lowerFirst(offCode)}`
          : `Call Otto is paused: your subscription is ${statusWords}. Calls forwarded to your Call Otto line will not be answered. Update billing in your dashboard, or ${lowerFirst(offCode)}`,
        priority: "high", state: "pending", attempts: 0, nextAttemptAt: now,
        idempotencyKey: `billing-lapse:${tenantId}:${eventId}:${destinationRef}`,
        providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
      });
    }
    log({ level: "warn", event: grace ? "billing_lapse_voicemail" : "billing_lapse_paused", tenantId, status });
  }

  /** Billing paused this shop and it has now paid: reconnect the line and tell the owner. */
  async function handleBillingRestoredLocked(tenantId: string, eventId: string): Promise<void> {
    const account = await dependencies.store.getOwnerAccountByTenant(tenantId);
    if (account?.status !== "active") return;
    const config = await dependencies.store.getConfig(tenantId);
    if (!config.pausedForBilling) {
      await clearGrace(dependencies.store, tenantId);
      return;
    }
    const [route, inboundNumber] = await Promise.all([
      dependencies.store.getProviderRouteForTenant("telnyx", tenantId),
      dependencies.store.getIntegrationSecret(tenantId, "telnyx", "inbound_number"),
    ]);
    if (route && inboundNumber && dependencies.env.TELNYX_API_KEY) {
      // Reconnects from either state: disconnected, or on the grace-period voicemail.
      await voiceRouting(inboundNumber, route.externalId).setPaused(false).catch((error) => {
        log({ level: "error", event: "billing_restore_resume_failed", tenantId, error: safeError(error) });
        throw new HttpError(502, "Could not reconnect the live phone route; Stripe will retry");
      });
    }
    await dependencies.store.withLock(`config:${tenantId}`, async () => {
      const current = await dependencies.store.getConfig(tenantId);
      await dependencies.store.saveConfig({ ...current, paused: false, pausedForBilling: false });
    });
    await clearGrace(dependencies.store, tenantId);
    const now = dependencies.clock.now().toISOString();
    for (const destinationRef of config.ownerNotificationRefs) {
      await dependencies.store.enqueueNotification({
        id: randomUUID(), tenantId, callId: null, channel: "sms", destinationRef,
        body: "Call Otto is back on: your payment went through and calls forwarded to your Call Otto line are being answered again.",
        priority: "normal", state: "pending", attempts: 0, nextAttemptAt: now,
        idempotencyKey: `billing-restored:${tenantId}:${eventId}:${destinationRef}`,
        providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
      });
    }
    log({ level: "info", event: "billing_restored_resumed", tenantId });
  }

  async function handleStripe(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!dependencies.env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, "Stripe webhooks are not configured");
    const rawBody = await readBody(request, 256_000);
    let event;
    try {
      event = verifyStripeWebhook(rawBody, singleHeader(request.headers["stripe-signature"]), dependencies.env.STRIPE_WEBHOOK_SECRET, dependencies.clock.now().getTime());
    } catch {
      throw new HttpError(401, "Invalid Stripe webhook signature");
    }
    if (event.type === "checkout.session.completed" || event.type.startsWith("customer.subscription.")) {
      const object = event.data.object;
      const metadata = object.metadata && typeof object.metadata === "object" ? object.metadata as Record<string, unknown> : {};
      const tenantId = typeof metadata.tenant_id === "string" ? metadata.tenant_id : typeof object.client_reference_id === "string" ? object.client_reference_id : null;
      if (!tenantId || !await dependencies.store.getOwnerAccountByTenant(tenantId)) throw new HttpError(400, "Stripe event tenant is not recognized");
      // One shop's billing events are applied one at a time, each against a fresh API read,
      // so a slow stale read can never overwrite a newer state.
      await dependencies.store.withLock(`billing:${tenantId}`, async () => {
        const existing = await dependencies.store.getSubscription(tenantId);
        if (isCompStatus(existing?.status)) {
          // A complimentary shop never takes a Stripe status (it never had a checkout): ignored, and said so.
          log({ level: "error", event: "stripe_event_for_comp_shop_ignored", tenantId, stripeEventType: event.type });
          return;
        }
        const now = dependencies.clock.now().toISOString();
        const subscriptionId = event.type.startsWith("customer.subscription.")
          ? (typeof object.id === "string" ? object.id : null)
          : (typeof object.subscription === "string" ? object.subscription : null);
        let record: SubscriptionRecord | null = null;
        if (stripeClient && subscriptionId) {
          const live = await stripeClient.retrieveSubscription(subscriptionId)
            .catch(() => { throw new HttpError(502, "Stripe subscription lookup failed; Stripe will retry"); });
          if (live.tenantId && live.tenantId !== tenantId) throw new HttpError(400, "Stripe subscription belongs to a different workspace");
          const otherSubscription = existing?.providerSubscriptionId && existing.providerSubscriptionId !== live.id;
          if (!stripeClient.hasPlanPrice(live.priceIds)) {
            log({ level: "warn", event: "stripe_subscription_ignored_wrong_price", tenantId });
          } else if (otherSubscription && isPaidStatus(existing?.status)) {
            // Never let a second subscription cancel or replace the one that is paying.
            if (live.status !== "canceled") log({ level: "error", event: "stripe_duplicate_subscription_requires_refund", tenantId });
          } else {
            // The event's own payload is a fact as of its created time (order-proof); the API read is the truth now.
            const payloadItems = (object.items as { data?: unknown } | undefined)?.data;
            if (event.type.startsWith("customer.subscription.") && Array.isArray(payloadItems) && typeof event.created === "number") {
              await recordUnlimitedObservation(dependencies.store, tenantId, { at: new Date(event.created * 1_000).toISOString(), items: stripeClient.addOnItemsFrom(payloadItems as Array<Record<string, unknown>>) });
            }
            await syncPlan(tenantId, live);
            record = {
              tenantId,
              providerCustomerId: live.customer ?? existing?.providerCustomerId ?? null,
              providerSubscriptionId: live.id,
              status: live.status,
              currentPeriodEnd: live.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null,
              providerEventCreatedAt: typeof event.created === "number" ? new Date(event.created * 1_000).toISOString() : now,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
            };
          }
        } else {
          record = subscriptionFromStripeEvent(event, existing, now);
        }
        if (record) {
          if (record.status !== existing?.status) telemetry.capture("subscription_status_changed", tenantId, tenantId, { status: record.status, stripe_event_type: event.type });
          // Pause or resume first: if Telnyx fails, nothing is saved and Stripe's retry sees the same transition.
          // Reconcile the line with the current status on every event, not only on a status edge,
          // so a crash between steps cannot leave a paid shop paused or an unpaid shop live.
          if (!isPaidStatus(record.status)) await handleBillingLapse(tenantId, record.status, event.id);
          else await handleBillingRestored(tenantId, event.id);
          await dependencies.store.saveSubscription(record);
          if (isPaidStatus(record.status)) {
            await dependencies.store.deleteIntegrationSecret(tenantId, "stripe", "open_checkout");
          }
        }
      });
    }
    // A card saved on Plan and billing becomes the default here too, in case the owner closed the page first.
    const cardSession = event.data.object as { id?: unknown; mode?: unknown; metadata?: Record<string, unknown> };
    if (event.type === "checkout.session.completed" && cardSession.mode === "setup" && cardSession.metadata?.front_office === CARD_UPDATE_TAG && typeof cardSession.id === "string" && typeof cardSession.metadata?.tenant_id === "string") {
      const owner = await dependencies.store.getOwnerAccountByTenant(cardSession.metadata.tenant_id);
      if (owner && stripeClient) {
        await finishCardChange(owner, cardSession.id).catch((error) => {
          // Not a paid plan any more, or someone else's form: nothing to switch, and nothing for Stripe to retry.
          if (error instanceof HttpError && (error.status === 403 || error.status === 409)) return;
          throw new HttpError(502, "Card default update failed; Stripe will retry");
        });
      }
    }
    // The guarantee clock and overage clamping start at the first successful charge, taken from Stripe:
    // a paid invoice (paid_at), or a checkout completed with payment. Idempotent (keeps the earliest).
    const firstCharge = firstChargeFromEvent(event);
    if (firstCharge && await dependencies.store.getOwnerAccountByTenant(firstCharge.tenantId)) {
      await recordFirstPaid(dependencies.store, firstCharge.tenantId, firstCharge.at);
    }
    const firstReceipt = await dependencies.store.claimWebhook(`stripe:${event.id}`);
    if (!firstReceipt) return sendJson(response, 200, { received: true, duplicate: true });
    if (event.type === "checkout.session.completed") {
      const tenantId = typeof event.data.object.client_reference_id === "string" ? event.data.object.client_reference_id : null;
      if (tenantId) telemetry.capture("checkout_completed", tenantId, tenantId, { stripe_event_type: event.type });
    }
    return sendJson(response, 200, { received: true });
  }

  async function handleTelnyx(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    enforceProviderRate(request, "webhook:telnyx");
    if (request.headers["content-type"]?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      const callback = parseTelnyxTexmlCallback(rawBody);
      if (callback.callStatus === "conversation_ended" && callback.providerCallId) {
        const existing = await dependencies.store.getCallByProviderId(callback.providerCallId);
        if (existing) {
          const ownerPortal = await dependencies.store.getOwnerAccountByTenant(existing.tenantId) ? "/app" : "/admin";
          const recordingUrl = `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}${ownerPortal}/provider/telnyx/recordings/${encodeURIComponent(callback.providerCallId)}`;
          trackFinalizedCall(await service.finalize(toTelnyxTexmlCallSummary(
            rawBody,
            existing.tenantId,
            dependencies.clock.now(),
            recordingUrl,
          )), "texml");
        }
      }
      return sendJson(response, 200, { received: true });
    }
    const envelope = parseTelnyxEnvelope(rawBody);
    const help = setupHelpState(envelope.data.payload.client_state);
    if (help) {
      // Otto's setup helper calling an owner who tapped "Set it up with me". Never a customer call record.
      await continueSetupCall(help.tenantId, help.phase, envelope).catch((error) => {
        log({ level: "error", event: "setup_call_step_failed", tenantId: help.tenantId, step: envelope.data.event_type, error: safeError(error) });
        throw new HttpError(502, "Setup call step failed");
      });
      return sendJson(response, 200, { received: true, setupCall: true });
    }
    const checkState = forwardingCheckState(envelope.data.payload.client_state);
    if (checkState) {
      // Our "Test my forwarding" call to the owner's business phone. Never a customer call record.
      await continueForwardingCheck(checkState.tenantId, checkState.startedAt, envelope).catch((error) => {
        log({ level: "error", event: "forwarding_check_step_failed", tenantId: checkState.tenantId, step: envelope.data.event_type, error: safeError(error) });
        throw new HttpError(502, "Forwarding check step failed");
      });
      return sendJson(response, 200, { received: true, forwardingCheck: true });
    }
    const ownerAlert = ownerAlertState(envelope.data.payload.client_state);
    if (ownerAlert) {
      // Our urgent call to an owner: speak when answered, hang up when done. Never a customer call record.
      // No webhook claim: a failed step answers 502 so Telnyx redelivers, and command_id (the event id) makes a
      // redelivered speak or hangup a no-op at Telnyx.
      const callControlId = envelope.data.payload.call_control_id;
      if (typeof callControlId === "string" && dependencies.env.TELNYX_API_KEY) {
        const digits = typeof envelope.data.payload.digits === "string" ? envelope.data.payload.digits : null;
        const onOptOut = async () => {
          // Pressed 9: no more automated calls to this owner until they turn them back on in Settings.
          // Only a grant older than this keypress: a redelivered webhook never undoes a later "turn it back on".
          // Telnyx always stamps occurred_at; without it, stopping wins.
          const revoked = await revokeOwnerCallConsent(dependencies.store, ownerAlert.tenantId, { at: dependencies.clock.now().toISOString(), source: "keypad", ...(envelope.data.occurred_at ? { before: envelope.data.occurred_at } : {}) });
          if (revoked) log({ level: "info", event: "owner_calls_opted_out", tenantId: ownerAlert.tenantId, source: "keypad" });
        };
        await continueOwnerAlertCall({ apiKey: dependencies.env.TELNYX_API_KEY, eventType: envelope.data.event_type, eventId: envelope.data.id, callControlId, state: ownerAlert, digits, onOptOut, ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}) })
          .catch((error) => {
            log({ level: "error", event: "owner_alert_call_step_failed", step: envelope.data.event_type, error: safeError(error) });
            throw new HttpError(502, "Owner alert call step failed");
          });
      }
      return sendJson(response, 200, { received: true });
    }
    if (envelope.data.event_type === "message.finalized") {
      const finalized = asTelnyxMessageFinalized(envelope);
      if (!await dependencies.store.claimWebhook(telnyxEventId(envelope, rawBody))) return sendJson(response, 200, { received: true, duplicate: true });
      const notification = await dependencies.store.getNotificationByProviderReceipt(finalized.data.payload.id);
      if (notification) {
        const statuses = finalized.data.payload.to.map((destination) => destination.status);
        notification.state = statuses.every((status) => status === "delivered")
          ? "delivered"
          : statuses.some((status) => status === "sending_failed" || status === "delivery_failed")
            ? "delivery_failed"
            : statuses.some((status) => status === "delivery_unconfirmed")
              ? "delivery_unconfirmed"
              : "sent";
        notification.lastError = notification.state === "delivery_failed"
          ? finalized.data.payload.errors.map((error) => [error.code, error.title].filter(Boolean).join(": ")).filter(Boolean).join("; ").slice(0, 500) || "Carrier delivery failed"
          : null;
        await dependencies.store.saveNotification(notification);
        log({ level: notification.state === "delivery_failed" ? "error" : "info", event: "notification_finalized", notificationId: notification.id, state: notification.state });
      }
      return sendJson(response, 200, { received: true });
    }
    if (envelope.data.event_type === "message.received") {
      const received = asTelnyxMessageReceived(envelope);
      if (!await dependencies.store.claimWebhook(telnyxEventId(envelope, rawBody))) return sendJson(response, 200, { received: true, duplicate: true });
      const action = received.data.payload.autoresponse_type?.toUpperCase();
      if ((action === "STOP" || action === "START") && /^\+1[2-9]\d{9}$/.test(received.data.payload.from.phone_number)) {
        const tenants = await dependencies.store.listTenantIds();
        await Promise.all(tenants.map((tenantId) => dependencies.store.setSmsOptOut(tenantId, received.data.payload.from.phone_number, action === "STOP")));
        // Re-subscribed: the next owner text tells them how to stop again.
        if (action === "START") await dependencies.store.resetSmsStopNotice(received.data.payload.from.phone_number);
        log({ level: "info", event: "sms_consent_changed", action, tenantCount: tenants.length });
      }
      return sendJson(response, 200, { received: true });
    }
    if (envelope.data.event_type === "assistant.initialization") {
      const initialization = asTelnyxInitialization(envelope);
      const tenantId = await tenantForAssistant(initialization.data.payload.assistant_id);
      await requireOperational(tenantId);
      const config = await dependencies.store.getConfig(tenantId);
      const callerPhone = initialization.data.payload.telnyx_end_user_target ?? "unknown";
      if (await noteForwardedCall(tenantId, callerPhone, initialization.data.payload.call_control_id, initialization.data.occurred_at ?? null) === "check") {
        // Our own forwarding check reached the shop: confirm it and end the call without a call record.
        return sendJson(response, 200, {
          dynamic_variables: { tenant_id: config.tenantId, business_name: config.businessName, call_direction: "inbound", opening_greeting: "Forwarding check complete. Goodbye.", caller_phone: callerPhone, call_access: "forwarding_check", owner_transfer_targets: [] },
          conversation: { metadata: { tenant_id: config.tenantId } },
        });
      }
      const recentCalls = /^\+1[2-9]\d{9}$/.test(callerPhone)
        ? await dependencies.store.countCallsFromNumberSince(config.tenantId, callerPhone, new Date(dependencies.clock.now().getTime() - 24 * 60 * 60_000).toISOString())
        : 0;
      // A fixed safeguard, not an owner setting: one number can't use up the shop's calls in a day.
      const callAccess = recentCalls >= REPEAT_CALLER_DAILY_LIMIT ? "blocked_daily_limit" : "allowed";
      await service.recordStarted({
        eventId: telnyxEventId(envelope, rawBody),
        tenantId,
        providerCallId: initialization.data.payload.call_control_id,
        fromNumber: callerPhone,
        fromNumberVerified: initialization.data.payload.telnyx_end_user_target_verified === true,
        startedAt: initialization.data.occurred_at ?? dependencies.clock.now().toISOString(),
        consentState: config.recordingDisclosure.trim() ? "disclosed" : "unknown",
      });
      const localContext = formatLocalCallContext(dependencies.clock.now(), config.timezone);
      return sendJson(response, 200, {
        dynamic_variables: {
          tenant_id: config.tenantId,
          business_name: config.businessName,
          call_direction: "inbound",
          opening_greeting: buildTelnyxGreeting(config),
          caller_phone: initialization.data.payload.telnyx_end_user_target ?? "unknown",
          current_local_date: localContext.date,
          current_local_time: localContext.time,
          business_timezone: config.timezone,
          call_access: callAccess,
          caller_reputation: callerReputation(initialization.data.payload),
          owner_transfer_targets: [],
        },
        conversation: { metadata: { tenant_id: config.tenantId } },
      });
    }
    if (envelope.data.event_type === "call.conversation.ended") {
      const ended = asTelnyxConversationEnded(envelope);
      const routedTenantId = await tenantForAssistant(ended.data.payload.assistant_id);
      if (await dependencies.store.getIntegrationSecret(routedTenantId, "forwarding", "check_inbound_call") === ended.data.payload.call_control_id) {
        return sendJson(response, 200, { received: true, forwardingCheck: true });
      }
      const existing = await dependencies.store.getCallByProviderId(ended.data.payload.call_control_id);
      const tenantId = existing?.tenantId ?? routedTenantId;
      if (tenantId !== routedTenantId) throw new HttpError(403, "Webhook assistant does not match the call tenant");
      const recordingAvailable = recordingClient
        ? await recordingClient.getDownloadUrl(ended.data.payload.call_control_id).then(Boolean).catch(() => false)
        : false;
      const ownerPortal = await dependencies.store.getOwnerAccountByTenant(tenantId) ? "/app" : "/admin";
      const recordingUrl = recordingAvailable
        ? `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}${ownerPortal}/provider/telnyx/recordings/${encodeURIComponent(ended.data.payload.call_control_id)}`
        : null;
      const summary = toTelnyxCallSummary(
        ended,
        rawBody,
        tenantId,
        dependencies.clock.now(),
        recordingUrl,
      );
      if (summary.consentState === "declined" && recordingClient) {
        await recordingClient.deleteForCall(summary.providerCallId).catch((error) => {
          log({ level: "error", event: "declined_recording_delete_failed", providerCallId: summary.providerCallId, error: safeError(error) });
        });
        summary.recordingUrl = null;
      }
      trackFinalizedCall(await service.finalize(summary), "ai_assistant");
    }
    sendJson(response, 200, { received: true });
  }

  /** Outcome only: never the caller's name, number, address or transcript. */
  function trackFinalizedCall(call: CallRecord, channel: "texml" | "ai_assistant"): void {
    telemetry.capture("call_finalized", call.tenantId, call.tenantId, {
      channel,
      outcome: call.outcome,
      emergency: call.emergency?.emergency === true,
      duration_seconds: call.durationSeconds,
      consent_state: call.consentState,
      billing_disposition: call.billingDisposition,
    });
  }

  async function handleIntake(tool: ToolRequest): Promise<unknown> {
    const input = parseTool(tool, intakeSchema);
    requireToolCallId(tool, input.provider_call_id);
    const tenantId = await tenantForCall(input.provider_call_id);
    await requireOperational(tenantId);
    const result = await service.saveIntake({
      tenantId,
      providerCallId: input.provider_call_id,
      fromNumber: await callerNumber(input.provider_call_id, input.from_number),
      fields: {
        problemDescription: input.problem_description,
        ...(input.caller_name === undefined ? {} : { callerName: input.caller_name }),
        ...(input.company_name === undefined ? {} : { companyName: input.company_name }),
        ...(input.callback_number === undefined ? {} : { callbackNumber: input.callback_number }),
        ...(input.service_address === undefined ? {} : { address: input.service_address }),
        ...(input.service_category === undefined ? {} : { serviceCategory: input.service_category }),
        ...(input.service_category_confidence === undefined ? {} : { serviceCategoryConfidence: input.service_category_confidence }),
        ...(input.equipment_details === undefined ? {} : { equipmentDetails: input.equipment_details }),
        ...(input.access_notes === undefined ? {} : { accessNotes: input.access_notes }),
        ...(input.diagnostic_fee_accepted === undefined ? {} : { diagnosticFeeAccepted: input.diagnostic_fee_accepted }),
        ...(input.human_requested === undefined ? {} : { humanRequested: input.human_requested }),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      },
      ...(input.recording_disclosure_declined === undefined ? {} : { recordingDisclosureDeclined: input.recording_disclosure_declined }),
      signal: tool.signal,
    });
    return result;
  }

  async function handleAvailability(tool: ToolRequest): Promise<unknown> {
    const input = parseTool(tool, availabilitySchema);
    requireToolCallId(tool, input.provider_call_id);
    const tenantId = await tenantForCall(input.provider_call_id);
    await requireOperational(tenantId);
    const result = await service.checkAvailability({
      tenantId,
      providerCallId: input.provider_call_id,
      windowStart: input.window_start,
      windowEnd: input.window_end,
      signal: tool.signal,
    });
    return { ...result, wrap_up: await service.wrapUp(input.provider_call_id) };
  }

  async function handleServiceArea(tool: ToolRequest): Promise<unknown> {
    const input = parseTool(tool, serviceAreaSchema);
    requireToolCallId(tool, input.provider_call_id);
    const tenantId = await tenantForCall(input.provider_call_id);
    await requireOperational(tenantId);
    const result = await service.checkServiceArea({
      tenantId,
      providerCallId: input.provider_call_id,
      address: input.address,
    });
    return { ...result, wrap_up: await service.wrapUp(input.provider_call_id) };
  }

  async function handleTriage(tool: ToolRequest): Promise<unknown> {
    const input = parseTool(tool, triageSchema);
    requireToolCallId(tool, input.provider_call_id);
    const tenantId = await tenantForCall(input.provider_call_id);
    await requireOperational(tenantId);
    const result = await service.triageCall({
      tenantId,
      providerCallId: input.provider_call_id,
      fromNumber: await callerNumber(input.provider_call_id, input.from_number),
      problemDescription: input.problem_description,
      ...(input.caller_name === undefined ? {} : { callerName: input.caller_name }),
      ...(input.llm_score === undefined ? {} : { llmScore: input.llm_score }),
      ...(input.llm_reason === undefined ? {} : { llmReason: input.llm_reason }),
    });
    return { ...result, wrap_up: await service.wrapUp(input.provider_call_id) };
  }

  async function handleBooking(tool: ToolRequest): Promise<unknown> {
    const input = parseTool(tool, bookingSchema);
    requireToolCallId(tool, input.provider_call_id);
    const tenantId = await tenantForCall(input.provider_call_id);
    await requireOperational(tenantId);
    const result = await service.bookConfirmedSlot({
      tenantId,
      providerCallId: input.provider_call_id,
      slotStart: input.slot_start,
      callerName: input.caller_name,
      callbackNumber: input.callback_number,
      address: input.address,
      serviceCategory: input.service_category,
      problemDescription: input.problem_description,
      explicitConfirmation: input.explicit_confirmation,
      diagnosticFeeAccepted: input.diagnostic_fee_accepted,
      signal: tool.signal,
    });
    return { ...result, wrap_up: await service.wrapUp(input.provider_call_id) };
  }

  async function handleHandoff(tool: ToolRequest): Promise<unknown> {
    const input = parseTool(tool, handoffSchema);
    requireToolCallId(tool, input.provider_call_id);
    const tenantId = await tenantForCall(input.provider_call_id);
    await requireOperational(tenantId);
    if (input.reason === "explicit_request") {
      if (!isExplicitHumanRequest(input.caller_quote)) {
        throw new HttpError(409, "Human handoff requires the caller's explicit request for a person");
      }
    } else {
      const call = await dependencies.store.getCallByProviderId(input.provider_call_id);
      if (!call || call.tenantId !== tenantId || call.emergency?.emergency !== true) {
        throw new HttpError(409, "Emergency handoff requires a prior deterministic emergency triage result");
      }
    }
    const result = await service.queueHumanHandoff({
      tenantId,
      providerCallId: input.provider_call_id,
      fromNumber: await callerNumber(input.provider_call_id, input.from_number),
      ...(input.caller_name === undefined ? {} : { callerName: input.caller_name }),
      ...(input.problem_description === undefined ? {} : { problemDescription: input.problem_description }),
      reason: input.reason,
    });
    const config = await dependencies.store.getConfig(tenantId);
    const call = await dependencies.store.getCallByProviderId(input.provider_call_id);
    const targets = await dependencies.store.withLock(`transfer:${input.provider_call_id}`, async () => {
      const key = `attempt:${input.provider_call_id}`;
      if (await dependencies.store.getIntegrationSecret(tenantId, "transfer", key)) return [];
      const approved = await approvedTransferTargets(dependencies.store, config, call?.fromNumber ?? input.from_number, tenantId === dependencies.env.DEFAULT_TENANT_ID ? dependencies.env.TELNYX_FROM_NUMBER : undefined);
      if (approved.length) await dependencies.store.saveIntegrationSecret(tenantId, "transfer", key, "issued");
      return approved;
    });
    return { ...result, wrap_up: await service.wrapUp(input.provider_call_id), transferAvailable: targets.length > 0, transferTargets: targets, message: targets.length ? "Owner alert and callback are saved. Offer one warm transfer to the configured Owner target. If it fails, return to the caller; the callback remains open." : result.message };
  }

  async function handleAdmin(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    if (method === "POST" && url.pathname === "/admin/login") {
      const form = parseForm(await readBody(request, 16_000));
      if (!limiter.allow(`${requestIp(request)}:login`, 10, 15 * 60_000)) throw new HttpError(429, "Too many sign-in attempts");
      if (!safeTokenMatch(form.get("token"), dependencies.env.ADMIN_TOKEN)) return sendHtml(response, 401, renderLogin("Invalid admin token."));
      const session = mintAdminSession(dependencies.env.SESSION_SIGNING_KEY!);
      response.setHeader("set-cookie", adminCookie(session, dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/admin");
    }
    if (method === "GET" && url.pathname === "/admin/logout") {
      response.setHeader("set-cookie", "afo_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0");
      return redirect(response, "/admin");
    }
    if (method === "GET" && url.pathname === "/admin/integrations/google/callback") {
      const attempt = clientForAttempt(dependencies.env, dependencies.env.SESSION_SIGNING_KEY!, (key) => verifyGoogleOAuthAttempt(url.searchParams.get("state"), readCookie(request, "afo_google_pkce"), key));
      if (!attempt) throw new HttpError(400, "Google OAuth state is invalid or expired");
      if (url.searchParams.has("error")) throw new HttpError(400, "Google authorization was declined");
      const code = url.searchParams.get("code");
      if (!code) throw new HttpError(400, "Google did not return an authorization code");
      const refreshToken = await exchangeGoogleCode(dependencies.env, attempt.client, code, attempt.result);
      await dependencies.store.saveIntegrationSecret(dependencies.env.DEFAULT_TENANT_ID, "google", "refresh_token", encodeGoogleConnection(refreshToken, attempt.client));
      const config = await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID);
      await dependencies.store.saveConfig({ ...config, calendarConnectionRef: "google-oauth" });
      response.setHeader("set-cookie", clearGoogleOAuthCookie(dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/admin/config");
    }

    // Brock's setup-call calendars: the admin session, or the signed link from scripts/founder-connect-link.ts.
    if (url.pathname === "/admin/founder-calendars" || url.pathname.startsWith("/admin/founder-calendars/")) return handleFounderCalendars(request, response, url);
    // The Google OAuth review account: only the signed link from scripts/review-account-link.ts.
    if (url.pathname === "/admin/review-account") return handleReviewAccount(request, response, url);

    const session = readCookie(request, "afo_admin");
    const bearer = bearerMatches(request, dependencies.env.ADMIN_TOKEN);
    const sessionAuthorized = verifyAdminSession(session, dependencies.env.SESSION_SIGNING_KEY!);
    if (!bearer && !sessionAuthorized) return sendHtml(response, 401, renderLogin());
    const csrf = session ? csrfForSession(session, dependencies.env.SESSION_SIGNING_KEY!) : "bearer-auth";

    if (method === "GET" && url.pathname === "/admin/readiness") {
      const [report, config] = await Promise.all([
        getActivationReport(),
        dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID),
      ]);
      return sendHtml(response, 200, renderReadiness(report, config));
    }
    if (method === "GET" && url.pathname === "/admin/simulator") {
      return sendHtml(response, 200, renderSimulator(null, csrf));
    }
    if (method === "POST" && url.pathname === "/admin/simulator") {
      const form = parseForm(await readBody(request, 16_000));
      if (!bearer && (!session || !verifyCsrf(session, form.get("csrf"), dependencies.env.SESSION_SIGNING_KEY!))) throw new HttpError(403, "Invalid CSRF token");
      const selected = form.get("scenario");
      const valid = SIMULATION_SCENARIOS.some(([id]) => id === selected);
      if (selected !== "all" && !valid) throw new HttpError(400, "Unknown simulator scenario");
      const results = selected === "all" ? await runAllSimulations() : [await runSimulation(selected as SimulationScenarioId)];
      return sendHtml(response, 200, renderSimulator(results, csrf));
    }

    if (method === "GET" && url.pathname === "/admin/integrations/google/start") {
      const googleOAuth = clientForNewConnections(dependencies.env);
      if (!googleOAuth) throw new HttpError(503, "Google OAuth is not configured on the server");
      const attempt = createGoogleOAuthAttempt(oauthAttemptKey(dependencies.env.SESSION_SIGNING_KEY!, googleOAuth.name), dependencies.env.NODE_ENV === "production");
      const callback = `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/integrations/google/callback`;
      const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorization.search = new URLSearchParams({
        client_id: googleOAuth.id,
        redirect_uri: callback,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        scope: GOOGLE_CALENDAR_SCOPES.join(" "),
        state: attempt.state,
        code_challenge: attempt.challenge,
        code_challenge_method: "S256",
      }).toString();
      response.setHeader("set-cookie", attempt.cookie);
      return redirect(response, authorization.toString());
    }

    if (method === "GET" && url.pathname === "/admin") {
      const [config, calls, googleConnected, activation] = await Promise.all([
        dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID),
        dependencies.store.listCalls(dependencies.env.DEFAULT_TENANT_ID, 50),
        isGoogleConnected(dependencies.env, dependencies.store),
        getActivationReport(),
      ]);
      return sendHtml(response, 200, renderDashboard({ config, calls, csrf, activation, integrations: { ...dependencies.integrations, "Google Calendar": googleConnected } }));
    }
    if (method === "GET" && url.pathname === "/admin/signups") {
      return sendHtml(response, 200, renderPilotSignups(await dependencies.store.listPilotSignups(200)));
    }
    if (method === "GET" && url.pathname === "/admin/owners") {
      return sendHtml(response, 200, renderOwnerAccounts(await dependencies.store.listOwnerAccounts(200), csrf));
    }
    const resetLinkMatch = /^\/admin\/owners\/([0-9a-f-]+)\/reset-link$/i.exec(url.pathname);
    if (method === "POST" && resetLinkMatch?.[1]) {
      const form = parseForm(await readBody(request, 4_000));
      if (!bearer && (!session || !verifyCsrf(session, form.get("csrf"), dependencies.env.SESSION_SIGNING_KEY!))) throw new HttpError(403, "Invalid CSRF token");
      const owner = await dependencies.store.getOwnerAccountById(resetLinkMatch[1]);
      if (!owner) throw new HttpError(404, "Owner account not found");
      const { token, tokenHash } = createPasswordResetToken();
      await dependencies.store.createPasswordReset(owner.id, tokenHash, new Date(dependencies.clock.now().getTime() + 30 * 60_000).toISOString());
      log({ level: "info", event: "admin_reset_link_created", accountId: owner.id });
      return sendHtml(response, 200, renderAdminResetLink(owner.email, `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/reset?token=${encodeURIComponent(token)}`));
    }
    const ownerStatusMatch = /^\/admin\/owners\/([0-9a-f-]+)\/status$/i.exec(url.pathname);
    if (method === "POST" && ownerStatusMatch?.[1]) {
      const form = parseForm(await readBody(request, 16_000));
      if (!bearer && (!session || !verifyCsrf(session, form.get("csrf"), dependencies.env.SESSION_SIGNING_KEY!))) throw new HttpError(403, "Invalid CSRF token");
      const status = form.get("status");
      if (status !== "pending_activation" && status !== "active" && status !== "suspended") throw new HttpError(400, "Invalid owner status");
      const account = await dependencies.store.getOwnerAccountById(ownerStatusMatch[1]);
      if (!account) throw new HttpError(404, "Owner account not found");
      if (status === "active") {
        // Blank ids provision a fresh number and assistant, exactly like the owner's own button.
        const assistantId = form.get("assistantId")?.trim() || null;
        const inboundNumber = form.get("inboundNumber")?.trim() || null;
        if (Boolean(assistantId) !== Boolean(inboundNumber)) throw new HttpError(400, "Enter both an assistant ID and a number, or leave both blank to provision new ones");
        if (inboundNumber && !/^\+[1-9]\d{7,14}$/.test(inboundNumber)) throw new HttpError(400, "A dedicated Telnyx number in E.164 format is required for activation");
        await goLive(account, assistantId && inboundNumber ? { assistantId, inboundNumber } : null);
      } else {
        const config = await dependencies.store.getConfig(account.tenantId);
        await pauseLiveRoute(account.tenantId)
          .catch(() => { throw new HttpError(502, "Telnyx could not disconnect the live phone route; account status was not changed"); });
        await dependencies.store.saveConfig({ ...config, paused: true });
        await dependencies.store.updateOwnerAccountStatus(account.id, status, dependencies.clock.now().toISOString());
      }
      return redirect(response, "/admin/owners");
    }
    // Lead guarantee, support side ("reply to your receipt"): GET shows eligibility, POST refunds the first month.
    // Same zero-lead check as the owner button (a late claim past day 37 is allowed here). Once per shop, ever.
    const leadRefundMatch = /^\/admin\/owners\/([0-9a-f-]+)\/lead-refund$/i.exec(url.pathname);
    if (leadRefundMatch?.[1] && (method === "GET" || method === "POST")) {
      const owner = await dependencies.store.getOwnerAccountById(leadRefundMatch[1]);
      if (!owner) throw new HttpError(404, "Owner account not found");
      if (method === "GET") return sendJson(response, 200, { tenantId: owner.tenantId, guarantee: await guarantee.status(owner.tenantId) });
      const form = parseForm(await readBody(request, 4_000));
      if (!bearer && (!session || !verifyCsrf(session, form.get("csrf"), dependencies.env.SESSION_SIGNING_KEY!))) throw new HttpError(403, "Invalid CSRF token");
      try {
        const refund = await guarantee.refund(owner.tenantId, "admin");
        return sendJson(response, 200, { refunded: true, refund });
      } catch (error) {
        if (error instanceof GuaranteeError) throw new HttpError(error.status, error.message);
        log({ level: "error", event: "lead_guarantee_refund_failed", tenantId: owner.tenantId, by: "admin", error: safeError(error) });
        throw new HttpError(502, "Stripe refund failed; nothing was recorded. Retry or refund in the Stripe dashboard.");
      }
    }
    if (method === "GET" && url.pathname === "/admin/config") {
      const [config, googleConnected, ownerPhone] = await Promise.all([
        dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID),
        isGoogleConnected(dependencies.env, dependencies.store),
        dependencies.store.getIntegrationSecret(dependencies.env.DEFAULT_TENANT_ID, "notifications", "owner-primary"),
      ]);
      return sendHtml(response, 200, renderConfig(config, csrf, {
        googleAvailable: anyGoogleClient(dependencies.env),
        googleConnected,
        ownerPhoneConfigured: Boolean(ownerPhone),
        weeklyEmailAvailable: Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL),
      }));
    }
    if (method === "POST" && url.pathname === "/admin/config") {
      const form = parseForm(await readBody(request, 64_000));
      if (!bearer && (!session || !verifyCsrf(session, form.get("csrf"), dependencies.env.SESSION_SIGNING_KEY!))) throw new HttpError(403, "Invalid CSRF token");
      await dependencies.store.withLock(`config:${dependencies.env.DEFAULT_TENANT_ID}`, async () => {
      const current = await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID);
      const updated = configFromForm(current, form, "platform");
      const ownerPhone = form.get("ownerPhone")?.trim();
      if (ownerPhone) {
        if (!/^\+[1-9]\d{7,14}$/.test(ownerPhone)) throw new HttpError(400, "Owner phone must use E.164 format");
        await dependencies.store.saveIntegrationSecret(dependencies.env.DEFAULT_TENANT_ID, "notifications", "owner-primary", ownerPhone);
        updated.ownerNotificationRefs = ["owner-primary"];
        updated.ownerTransferNumberRef = "owner-primary";
      }
      if (!dependencies.env.DEMO_MODE) {
        if (!routingClient) throw new HttpError(503, "Telnyx voice routing is not configured");
        await routingClient.setPaused(updated.paused).catch((error) => {
          log({ level: "error", event: "voice_routing_update_failed", error: safeError(error) });
          throw new HttpError(502, "Telnyx voice routing could not be updated; configuration was not changed");
        });
      }
      await saveAssistantConfig(dependencies.store, dependencies.env, updated);
      });
      return redirect(response, "/admin/config");
    }
    if (method === "GET" && url.pathname === "/admin/prompt") {
      const config = await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID);
      return sendHtml(response, 200, renderPrompt(config, dependencies.env.PUBLIC_BASE_URL, dependencies.env.TELNYX_VOICE));
    }
    const recordingMatch = /^\/admin\/provider\/telnyx\/recordings\/(.+)$/.exec(url.pathname);
    if (method === "GET" && recordingMatch?.[1]) {
      if (!recordingClient) throw new HttpError(503, "Telnyx recordings are not configured");
      let providerCallId: string;
      try {
        providerCallId = decodeURIComponent(recordingMatch[1]);
      } catch {
        throw new HttpError(400, "Invalid recording identifier");
      }
      const call = await dependencies.store.getCallByProviderId(providerCallId);
      if (!call || call.tenantId !== dependencies.env.DEFAULT_TENANT_ID) throw new HttpError(404, "Recording not found");
      const downloadUrl = await recordingClient.getDownloadUrl(providerCallId);
      if (!downloadUrl) throw new HttpError(404, "Recording is not available yet");
      response.writeHead(302, { location: downloadUrl, "cache-control": "no-store" });
      response.end();
      return;
    }
    const deleteCallMatch = /^\/admin\/calls\/([0-9a-f-]+)\/delete$/i.exec(url.pathname);
    if (method === "POST" && deleteCallMatch?.[1]) {
      const form = parseForm(await readBody(request, 16_000));
      if (!bearer && (!session || !verifyCsrf(session, form.get("csrf"), dependencies.env.SESSION_SIGNING_KEY!))) throw new HttpError(403, "Invalid CSRF token");
      if (form.get("confirm") !== "delete") throw new HttpError(400, "Deletion confirmation is required");
      const deleted = await deletionService.deleteCall(dependencies.env.DEFAULT_TENANT_ID, deleteCallMatch[1])
        .catch(() => { throw new HttpError(502, "Provider deletion failed. The local record was retained so deletion can be retried."); });
      if (!deleted) throw new HttpError(404, "Call not found");
      return redirect(response, "/admin");
    }
    const callMatch = /^\/admin\/calls\/([0-9a-f-]+)$/i.exec(url.pathname);
    if (method === "GET" && callMatch?.[1]) {
      const call = await dependencies.store.getCall(callMatch[1]);
      if (!call || call.tenantId !== dependencies.env.DEFAULT_TENANT_ID) throw new HttpError(404, "Call not found");
      const [config, booking, callbackTask, events, notifications] = await Promise.all([
        dependencies.store.getConfig(call.tenantId),
        dependencies.store.getBookingForCall(call.id),
        dependencies.store.getCallbackTaskForCall(call.id),
        dependencies.store.listToolEvents(call.id),
        dependencies.store.listNotifications(call.id),
      ]);
      return sendHtml(response, 200, renderCallDetail({ config, call, booking, callbackTask, events, notifications, csrf }));
    }
    throw new HttpError(404, "Not found");
  }

  /**
   * Billing grace-period voicemail, served by the shared TeXML app (TELNYX_VOICEMAIL_APP_ID).
   * The greeting only names the shop the caller already dialed, so an unsigned instruction fetch is
   * still answered (a signed one must verify). Recording and transcription callbacks are always
   * Telnyx-signed and bound to this tenant and call by an HMAC token in their URL.
   */
  async function handleVoicemail(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    if (method !== "POST" && method !== "GET") throw new HttpError(405, "Method not allowed");
    const rawBody = method === "POST" ? await readBody(request, 64_000) : "";
    const form = method === "POST" ? new URLSearchParams(rawBody) : url.searchParams;
    const tokenSecret = dependencies.env.SESSION_SIGNING_KEY ?? dependencies.env.TOOL_TOKEN;
    const sendTexml = (xml: string): void => {
      response.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" });
      response.end(xml);
    };

    if (url.pathname === "/texml/voicemail" || url.pathname === "/texml/voicemail/done") {
      if (method === "POST" && request.headers["telnyx-signature-ed25519"]) requireProviderAuth(request, rawBody);
      enforceProviderRate(request, "texml:voicemail");
      if (url.pathname === "/texml/voicemail/done") return sendTexml(renderHangupTexml(null));
      const callSid = form.get("CallSid")?.trim() || null;
      const dialed = form.get("To")?.trim() ?? "";
      const to = normalizeUsPhone(dialed) ?? (/^\+[1-9]\d{7,14}$/.test(dialed) ? dialed : null);
      const tenantId = to ? await dependencies.store.getTenantIdByInboundNumber(to) : null;
      const config = tenantId ? await dependencies.store.getConfig(tenantId).catch(() => null) : null;
      if (!tenantId || !config || !callSid) {
        log({ level: "warn", event: "voicemail_unknown_number" });
        return sendTexml(renderHangupTexml("Sorry, this number is not in service. Goodbye."));
      }
      log({ level: "info", event: "voicemail_answered", tenantId });
      return sendTexml(renderVoicemailTexml({
        businessName: config.businessName, publicBaseUrl: dependencies.env.PUBLIC_BASE_URL,
        tenantId, callSid, token: voicemailToken(tokenSecret, tenantId, callSid),
      }));
    }

    const recordingCallback = url.pathname === "/texml/voicemail/recording";
    if (method !== "POST" || (!recordingCallback && url.pathname !== "/texml/voicemail/transcription")) throw new HttpError(404, "Not found");
    requireProviderAuth(request, rawBody);
    enforceProviderRate(request, "texml:voicemail-callback");
    const tenantId = url.searchParams.get("t");
    const callSid = form.get("CallSid");
    if (!tenantId || !callSid || !voicemailTokenMatches(tokenSecret, tenantId, callSid, url.searchParams.get("s"))) {
      throw new HttpError(403, "Voicemail callback is not bound to this call");
    }
    const config = await dependencies.store.getConfig(tenantId).catch(() => null);
    if (!config) return sendJson(response, 200, { received: true, ignored: "unknown_tenant" });
    const caller = describeCaller(form.get("From")?.trim() || null);
    const off = await offInstructionFor(tenantId);
    const suffix = await graceStartedAt(dependencies.store, tenantId) ? ` Your Call Otto plan is paused; ${lowerFirst(off)}` : "";
    const fallbackBase = `voicemail-fallback:${tenantId}:${callSid}`;
    // One gate per call: whichever callback arrives first decides whether a no-transcript fallback may exist.
    const firstForCall = await dependencies.store.claimWebhook(fallbackBase);

    if (recordingCallback) {
      const status = form.get("RecordingStatus");
      if (!firstForCall || (status && status !== "completed")) return sendJson(response, 200, { received: true });
      // Goes out only if the transcript has not arrived (and cancelled it) within a few minutes.
      await queueOwnerMessage(graceContext, {
        tenantId,
        sms: `Call Otto voicemail for ${config.businessName}: ${caller} left you a message we couldn't transcribe. Call them back.${suffix}`,
        emailSubject: `New voicemail for ${config.businessName}`,
        idempotencyBase: fallbackBase,
        sendAfter: new Date(dependencies.clock.now().getTime() + VOICEMAIL_FALLBACK_DELAY_MS),
      });
      return sendJson(response, 200, { received: true });
    }

    for (const key of [...config.ownerNotificationRefs.map((reference) => `${fallbackBase}:${reference}`), `${fallbackBase}:email`]) {
      await dependencies.store.cancelPendingNotification(key);
    }
    const transcript = transcriptSnippet(form.get("TranscriptionText") ?? "");
    const said = transcript ? `${caller} said: \u201c${transcript}\u201d.` : `${caller} left a message with no words we could make out.`;
    const result = await queueOwnerMessage(graceContext, {
      tenantId,
      sms: `Call Otto voicemail for ${config.businessName}: ${said}${suffix}`,
      emailSubject: `New voicemail for ${config.businessName}`,
      idempotencyBase: `voicemail:${tenantId}:${callSid}`,
    });
    log({ level: "info", event: "voicemail_transcribed", tenantId, channel: result.channel, queued: result.queued });
    return sendJson(response, 200, { received: true });
  }

  async function offInstructionFor(tenantId: string): Promise<string> {
    return forwardingOffInstruction((await readForwarding(tenantId)).carrier?.family ?? null);
  }

  function requireProviderAuth(request: IncomingMessage, rawBody: string): void {
    if (dependencies.env.DEMO_MODE && bearerMatches(request, dependencies.env.TOOL_TOKEN)) return;
    if (!dependencies.env.TELNYX_PUBLIC_KEY) {
      throw new HttpError(dependencies.env.DEMO_MODE ? 401 : 503, dependencies.env.DEMO_MODE ? "Invalid tool credentials" : "Telnyx webhook verification is not configured");
    }
    const verified = verifyTelnyxWebhook(
      rawBody,
      singleHeader(request.headers["telnyx-timestamp"]),
      singleHeader(request.headers["telnyx-signature-ed25519"]),
      dependencies.env.TELNYX_PUBLIC_KEY,
      dependencies.clock.now().getTime(),
    );
    if (!verified) throw new HttpError(401, "Invalid Telnyx webhook signature");
  }

  async function tenantForAssistant(assistantId: string): Promise<string> {
    const route = await dependencies.store.getProviderRoute("telnyx", assistantId);
    if (route) return route.tenantId;
    if (assistantId === dependencies.env.TELNYX_ASSISTANT_ID || (dependencies.env.DEMO_MODE && !dependencies.env.TELNYX_ASSISTANT_ID)) {
      return dependencies.env.DEFAULT_TENANT_ID;
    }
    throw new HttpError(403, "Webhook assistant is not assigned to a tenant");
  }

  function enforceProviderRate(request: IncomingMessage, route: string): void {
    const callId = singleHeader(request.headers["x-telnyx-call-control-id"]) ?? requestIp(request);
    if (!limiter.allow(`provider:${callId}:${route}`, 240, 60_000)) throw new HttpError(429, "Too many authenticated provider requests");
  }

  async function tenantForCall(providerCallId: string): Promise<string> {
    const call = await dependencies.store.getCallByProviderId(providerCallId);
    if (!call && dependencies.env.DEMO_MODE) return dependencies.env.DEFAULT_TENANT_ID;
    if (!call) throw new HttpError(409, "Call initialization has not been recorded");
    return call.tenantId;
  }

  async function getActivationReport(): Promise<ActivationReport> {
    const config = await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID);
    const [googleConnected, ownerDestinations] = await Promise.all([
      isGoogleConnected(dependencies.env, dependencies.store),
      Promise.all(config.ownerNotificationRefs.map((reference) => dependencies.store.getIntegrationSecret(config.tenantId, "notifications", reference))),
    ]);
    return buildActivationReport({
      env: dependencies.env,
      config,
      googleConnected,
      ownerPhoneConfigured: ownerDestinations.some(Boolean),
    });
  }

  async function requireOperational(tenantId = dependencies.env.DEFAULT_TENANT_ID): Promise<void> {
    if (dependencies.env.DEMO_MODE) return;
    const config = await dependencies.store.getConfig(tenantId);
    if (config.paused) throw new HttpError(503, "Service is paused");
    // The public demo line answers anyone, with or without provider test mode; it never sends (NotificationRouter).
    if (tenantId === dependencies.env.PUBLIC_DEMO_TENANT_ID && !await dependencies.store.getOwnerAccountByTenant(tenantId)) return;
    if (dependencies.env.PROVIDER_TEST_MODE) return;
    if (tenantId !== dependencies.env.DEFAULT_TENANT_ID) {
      // Voice goes live without carrier texting approval (10DLC): texts are held until it lands (TelnyxSmsAdapter).
      if (!dependencies.env.LIVE_PROVIDER_PROOF_AT) throw new HttpError(503, "Commercial provider prerequisites are not satisfied");
      const account = await dependencies.store.getOwnerAccountByTenant(tenantId);
      const subscription = await dependencies.store.getSubscription(tenantId);
      if (account?.status !== "active") throw new HttpError(503, "Shop activation is not complete");
      if (!isPaidStatus(subscription?.status)) throw new HttpError(402, "An active paid subscription is required for customer traffic");
      return;
    }
    const report = await getActivationReport();
    if (!report.go) throw new HttpError(503, "Commercial activation gate is not satisfied");
  }
}

/** Operator-facing (admin activation); owners see OWNER_SETUP_STUCK instead. */
const ASSISTANT_TAKEN = "That Telnyx assistant is already assigned to another tenant";
const OWNER_SETUP_STUCK = "We couldn’t finish setting up your line. We’ve been alerted and will fix it. Your setup is saved.";

function toolForPath(pathname: string): VoiceToolName | null {
  return pathname.startsWith("/tools/") ? TOOL_ROUTES[pathname.slice(7)] ?? null : null;
}

/** Null, or the words "null" / "undefined" as text: how a model or the provider writes a field it has nothing for. */
function isNotGiven(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^\s*(null|undefined)\s*$/i.test(value));
}

/** A field with nothing in it means "not given", so it is dropped (a required one still fails). */
function withoutNullFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, field]) => !isNotGiven(field)));
}

/**
 * What was tolerated in a tool body, or null when nothing was: how many fields were null, which of our optional
 * fields were sent but unusable, and why the caller number was. Our field names, counts and kinds only.
 */
function inputRepairs(schema: z.ZodObject, sent: unknown, parsed: Record<string, unknown>): Record<string, unknown> | null {
  const body = sent && typeof sent === "object" && !Array.isArray(sent) ? sent as Record<string, unknown> : {};
  const fields = Object.keys(schema.shape);
  const nullFields = Object.values(body).filter(isNotGiven).length;
  const dropped = fields.filter((key) => key !== "from_number" && body[key] !== undefined && !isNotGiven(body[key]) && parsed[key] === undefined);
  const fromNumber = fields.includes("from_number") ? fromNumberProblem(body.from_number) : null;
  if (!nullFields && !dropped.length && !fromNumber) return null;
  return { ...(nullFields ? { nullFields } : {}), ...(dropped.length ? { dropped: dropped.join(",") } : {}), ...(fromNumber ? { fromNumber } : {}) };
}

/** Which fields failed and how (names and types only, never what the caller said), so a rejected tool call can be fixed from the log. */
function invalidFields(error: z.ZodError): string {
  return error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "(body)"}:${issue.code}`).join(",");
}

/** "0 1 9 9": digits read one at a time. */
function spokenDigits(digits: string): string {
  return digits.split("").join(" ");
}

function unwrapToolPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const nested = record.args ?? record.arguments;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return value;
  const { args: _args, arguments: _arguments, ...outer } = record;
  return { ...(nested as Record<string, unknown>), ...outer };
}


function formatLocalCallContext(now: Date, timeZone: string): { date: string; time: string } {
  return {
    date: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(now),
    time: new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(now),
  };
}

/** The Stripe client for this server's plans, or null when checkout isn't configured. Shared with the period-end job. */
export function createStripeClient(env: Environment, fetcher: typeof fetch): StripeBillingClient | null {
  const prices = planPriceIds(env);
  if (!env.STRIPE_SECRET_KEY || !prices.solo) return null;
  return new StripeBillingClient(env.STRIPE_SECRET_KEY, {
    base: prices.solo,
    ...(prices.pro ? { pro: prices.pro } : {}),
    ...(prices.team ? { team: prices.team } : {}),
    ...(prices.fleet ? { fleet: prices.fleet } : {}),
    legacy: Object.values(legacyPlanPriceIds(env)).flat(),
    unlimited: Object.fromEntries(Object.entries(unlimitedPriceIds(env)).filter(([, price]) => Boolean(price))) as Partial<Record<PlanId, string>>,
  }, fetcher);
}

/** A plan change priced for the owner before anything is charged. */
interface BillingQuote {
  plan: PlanId; unlimited: boolean; monthlyCents: number; renewsAt: string | null; live: boolean; noChange: boolean;
  /** Charged to the card today (after any account credit), and credited to the next bill. */
  todayCents: number; creditCents: number;
  /** True when Stripe refused the preview and this is our own estimate ("about"). */
  estimated: boolean;
  /** Unix seconds the proration is computed at; the confirmed change sends it back so Stripe bills the same amount. */
  prorationDate: number | null;
}
interface ConfirmedQuote { prorationDate: number; todayCents: number; creditCents: number; estimated: boolean }
function parseConfirm(value: unknown): ConfirmedQuote | null {
  if (!value || typeof value !== "object") return null;
  const { prorationDate, todayCents, creditCents, estimated } = value as Record<string, unknown>;
  const whole = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  return whole(prorationDate) && whole(todayCents) && whole(creditCents) && typeof estimated === "boolean" ? { prorationDate, todayCents, creditCents, estimated } : null;
}

/** The shop's config on a plan: label lives in the catalog; price, included calls and overage are saved with the shop. */
function onPlan(config: BusinessConfig, plan: Plan, unlimited = config.unlimitedCalls === true): BusinessConfig {
  return { ...config, planId: plan.id, flatMonthlyPriceCents: plan.priceCents, includedCalls: plan.includedCalls, overageCentsPerCall: plan.overageCentsPerCall, unlimitedCalls: unlimited && Boolean(plan.unlimited) };
}
function isOnPlan(config: BusinessConfig, plan: Plan, unlimited = config.unlimitedCalls === true): boolean {
  return config.planId === plan.id && config.flatMonthlyPriceCents === plan.priceCents && config.includedCalls === plan.includedCalls && config.overageCentsPerCall === plan.overageCentsPerCall
    && (config.unlimitedCalls === true) === (unlimited && Boolean(plan.unlimited));
}

function routeKey(pathname: string): string {
  if (pathname === "/webhooks/telnyx") return "webhook:telnyx";
  if (pathname.startsWith("/texml/")) return `texml:${pathname.slice(7)}`;
  if (pathname.startsWith("/tools/")) return `tool:${pathname.slice(7)}`;
  if (pathname.startsWith("/admin/calls/")) return "admin:call";
  if (pathname.startsWith("/c/")) return "callback-link";
  // The live path polls every two seconds; its own bucket keeps it from starving the call page's actions.
  if (/^\/(?:api\/)?app\/calls\/[^/]+\/path$/.test(pathname)) return "owner:call-path";
  if (pathname.startsWith("/app/calls/")) return "owner:call";
  if (pathname.startsWith("/app/provider/")) return "owner:recording";
  if (pathname.startsWith("/api/app/")) return "owner:api";
  if (pathname.startsWith("/api/demo/")) return "demo:api";
  if (pathname.startsWith("/web/")) return "web:asset";
  if (pathname.startsWith("/demo/")) return "/demo";
  if (pathname.startsWith("/app")) return "owner:app";
  return pathname;
}

function normalizeUsPhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national) ? `+1${national}` : null;
}

function normalizeOptionalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function parseOptionalCount(value: string | undefined): number | null | undefined {
  if (!value) return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 500 ? count : undefined;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeTokenMatch(supplied: string | null, expected: string): boolean {
  if (supplied === null) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqualBuffers(left, right);
}

function timingSafeEqualBuffers(left: Buffer, right: Buffer): boolean {
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index]! ^ right[index]!;
  return mismatch === 0;
}

/** The short optional notice an owner can switch on in setup. */
const RECORDING_NOTICE = TRANSFER_RECORDING_NOTICE;

/** Sign-up problems by field, each naming the fix. The schema's issues plus the checks it can't make (phone, password). */
const SIGNUP_TIMED_OUT = "Your sign-up timed out. Start again with Google or your email.";

function signupFieldErrors(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>, values: Record<string, string>, verified: boolean, only?: ReadonlyArray<keyof SignupFieldErrors>): SignupFieldErrors {
  const errors: SignupFieldErrors = {};
  const bad = new Set(issues.map((issue) => issue.path[0]));
  if (only) {
    if (only.includes("email") && bad.has("email")) errors.email = "Enter an email like you@yourshop.com.";
    if (only.includes("password") && (bad.has("password") || !values.password)) errors.password = `Make your password at least ${PASSWORD_MIN_LENGTH} characters.`;
    return errors;
  }
  if (bad.has("businessName")) {
    const shop = (values.businessName ?? "").trim();
    errors.businessName = !shop ? "Enter your shop name." : shop.length < 2 ? "Use at least 2 characters for your shop name." : "Shorten your shop name to 120 characters.";
  }
  const phoneInput = (values.phone ?? "").trim();
  if (bad.has("phone") || (phoneInput && !normalizeUsPhone(phoneInput))) errors.phone = "Enter a 10-digit US mobile number.";
  else if (!phoneInput && (values.ownerSmsConsent === "yes" || values.founderSmsConsent === "yes")) errors.phone = "Add your mobile number to get texts.";
  if (bad.has("email")) errors.email = "Enter an email like you@yourshop.com.";
  if (!verified && (bad.has("password") || !values.password)) errors.password = `Make your password at least ${PASSWORD_MIN_LENGTH} characters.`;
  return errors;
}

function serviceAreaMessage(errors: string[]): string {
  return errors.length > 0
    ? `Add a state to: ${errors.slice(0, 5).join(", ")}. Use a city and state ("Sarasota FL") or a 5-digit ZIP.`
    : "Add at least one city and state or 5-digit ZIP.";
}

function configFromForm(current: BusinessConfig, form: URLSearchParams, surface: "owner" | "platform", now: Date = new Date()): BusinessConfig {
  const required = (name: string): string => {
    const value = form.get(name)?.trim();
    if (!value) throw new HttpError(400, `${name} is required`);
    return value;
  };
  const timezone = required("timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new HttpError(400, "timezone must be a valid IANA timezone");
  }
  const operationMode = required("operationMode");
  if (!(["always", "after_hours", "overflow"] as const).includes(operationMode as BusinessConfig["operationMode"])) throw new HttpError(400, "Invalid operation mode");
  const bookingMode = required("bookingMode");
  if (bookingMode !== "confirm" && bookingMode !== "direct") throw new HttpError(400, "Invalid booking mode");
  // The price follows the plan (set by checkout, plan changes and Stripe); only the platform form may set it by hand.
  const monthlyDollars = surface === "platform" ? Number(form.get("flatMonthlyPrice") ?? "0") : current.flatMonthlyPriceCents / 100;
  if (surface === "platform" && (!Number.isFinite(monthlyDollars) || monthlyDollars < 49 || monthlyDollars > 400)) throw new HttpError(400, "Flat monthly price must be between $49 and $400");
  const serviceState = required("serviceState");
  if (serviceState !== "paused" && serviceState !== "active") throw new HttpError(400, "Invalid service state");
  const answerAfterRings = Number(form.get("answerAfterRings") ?? "0");
  // Half rings allowed: 2.5 rings is the 15-second default ("15 seconds (2–3 rings)").
  if (!Number.isInteger(answerAfterRings * 2) || answerAfterRings < 2 || answerAfterRings > 12) throw new HttpError(400, "Answer-after-rings must be between 2 and 12");
  // Calls are kept until the owner deletes them (no automatic deletion); only the platform form still sends this.
  const dataRetentionDays = form.has("dataRetentionDays") ? Number(form.get("dataRetentionDays")) : current.dataRetentionDays;
  if (!Number.isInteger(dataRetentionDays) || dataRetentionDays < 7 || dataRetentionDays > 365) throw new HttpError(400, "Data retention must be 7–365 days");
  const supportEmail = form.get("supportEmail")?.trim() || null;
  if (supportEmail && !z.string().email().safeParse(supportEmail).success) throw new HttpError(400, "Support email is invalid");
  const list = (name: string): string[] => (form.get(name) ?? "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 100);
  const defaultServiceDurationMinutes = Number(form.get("defaultServiceDurationMinutes") ?? "0");
  if (!Number.isInteger(defaultServiceDurationMinutes) || defaultServiceDurationMinutes < 15 || defaultServiceDurationMinutes > 480) throw new HttpError(400, "Default service duration must be 15–480 minutes");
  const emergencyThreshold = Number(form.get("emergencyThreshold") ?? "0");
  if (!Number.isFinite(emergencyThreshold) || emergencyThreshold < 0.5 || emergencyThreshold > 0.9) throw new HttpError(400, "Emergency threshold must be between 0.5 and 0.9");
  const weekdayStart = required("weekdayStart");
  const weekdayEnd = required("weekdayEnd");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(weekdayStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(weekdayEnd)) throw new HttpError(400, "Coverage times must use HH:MM");
  const bookableWeekdayStart = required("bookableWeekdayStart");
  const bookableWeekdayEnd = required("bookableWeekdayEnd");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(bookableWeekdayStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(bookableWeekdayEnd)) throw new HttpError(400, "Bookable hours must use HH:MM");
  const minimumLeadTimeMinutes = Number(form.get("minimumLeadTimeMinutes") ?? "0");
  if (!Number.isInteger(minimumLeadTimeMinutes) || minimumLeadTimeMinutes < 0 || minimumLeadTimeMinutes > 10_080) throw new HttpError(400, "Minimum lead time must be 0–10080 minutes");
  // Not an owner setting any more (the fixed REPEAT_CALLER_DAILY_LIMIT applies); the platform form may still send it.
  const maxCallsPerCallerPerDay = form.has("maxCallsPerCallerPerDay") ? Number(form.get("maxCallsPerCallerPerDay")) : current.maxCallsPerCallerPerDay;
  if (!Number.isInteger(maxCallsPerCallerPerDay) || maxCallsPerCallerPerDay < 1 || maxCallsPerCallerPerDay > 20) throw new HttpError(400, "Caller daily limit must be 1–20 calls");
  const ownerDailySmsHour = Number(form.get("ownerDailySmsHour") ?? current.ownerDailySmsHour);
  if (!Number.isInteger(ownerDailySmsHour) || ownerDailySmsHour < 0 || ownerDailySmsHour > 23) throw new HttpError(400, "Daily summary hour must be 0–23");
  // Forms that don't show the minutes alert (the platform admin page) keep the saved value.
  const usageAlertPercent = form.has("usageAlertPercent") ? Number(form.get("usageAlertPercent")) : current.usageAlertPercent;
  if (!isValidUsageAlertPercent(usageAlertPercent)) throw new HttpError(400, `Minutes alert must be between ${MIN_USAGE_ALERT_PERCENT}% and ${MAX_USAGE_ALERT_PERCENT}%`);
  const holidayDates = list("holidayDates");
  if (holidayDates.some((value) => !isIsoDate(value))) throw new HttpError(400, "Holiday dates must use valid YYYY-MM-DD values");
  // Forms without the Days off list (the platform admin page) keep the saved days.
  const daysOff = form.has("daysOff") ? (() => {
    try { return parseDaysOff(form.get("daysOff") ?? "", localDate(now, timezone)); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Check your days off"); }
  })() : current.daysOff ?? [];
  return {
    ...current,
    paused: serviceState === "paused",
    businessName: required("businessName").slice(0, 120),
    greeting: required("greeting").slice(0, 1_000),
    timezone,
    operationMode: operationMode as BusinessConfig["operationMode"],
    answerAfterRings,
    bookingMode,
    warmTransferEnabled: form.get("warmTransferEnabled") === "on",
    serviceAreaTerms: (() => { const area = normalizeServiceAreaInput(form.get("serviceAreaTerms") ?? ""); if (area.errors.length > 0) throw new HttpError(400, serviceAreaMessage(area.errors)); return area.terms; })(),
    emergencyKeywords: (() => {
      // Every box ticked is about 100 phrases; Other adds a few. Refuse a list too long instead of dropping words.
      const words = (form.get("emergencyKeywords") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      if (words.length > 200) throw new HttpError(400, "That’s too many emergency words. Untick a few or shorten Other.");
      return words;
    })(),
    emergencyThreshold,
    minimumLeadTimeMinutes,
    daysOff,
    maxCallsPerCallerPerDay,
    defaultServiceDurationMinutes,
    serviceCategories: (() => {
      const services = list("serviceCategories");
      if (surface !== "owner") return services;
      if (services.length === 0) throw new HttpError(400, "Pick at least one thing you fix.");
      // Only what's new is checked, so an old entry never blocks saving another page.
      // Services that come with a trade tick box aren't typed by the owner, so they never count against Other.
      const known = new Set([...current.serviceCategories, ...TRADES.flatMap((trade) => trade.services)].map((item) => item.toLowerCase()));
      const problem = otherServiceProblem(services.filter((item) => !known.has(item.toLowerCase())));
      if (problem) throw new HttpError(400, problem);
      return services;
    })(),
    priceSnippets: parseLines(form.get("priceSnippets") ?? "", 50).map((line) => {
      const [label, ...rest] = line.split(":");
      const item = { label: label!.trim().slice(0, 120), text: rest.join(":").trim().slice(0, 1_000) };
      // A half-filled row in the owner app would vanish on save: say which one instead.
      if (surface === "owner" && Boolean(item.label) !== Boolean(item.text)) throw new HttpError(400, item.label ? `Add a price for “${item.label}”, or remove that row.` : "A price is missing its service. Fill it in, or remove that row.");
      return item;
    }).filter((item) => item.label && item.text),
    approvedKnowledge: parseLines(form.get("approvedKnowledge") ?? "", 50).map((line) => {
      const [topic, ...rest] = line.split(":");
      const item = { topic: topic!.trim().slice(0, 120), text: rest.join(":").trim().slice(0, 1_000) };
      if (surface === "owner" && Boolean(item.topic) !== Boolean(item.text)) throw new HttpError(400, item.topic ? `Add an answer for “${item.topic}”, or remove that row.` : "An answer is missing its question. Fill it in, or remove that row.");
      return item;
    }).filter((item) => item.topic && item.text),
    pronunciations: parseLines(form.get("pronunciations") ?? "", 100).map((line) => {
      const [term, ...rest] = line.split(":");
      return { term: term!.trim().slice(0, 120), spokenAs: rest.join(":").trim().slice(0, 240) };
    }).filter((item) => item.term && item.spokenAs),
    customerSmsEnabled: form.has("customerSmsEnabled"),
    ownerWeeklyEmailEnabled: form.has("ownerWeeklyEmailEnabled"),
    ownerDailySmsEnabled: form.has("ownerDailySmsEnabled"),
    ownerDailySmsHour,
    ownerRealtimeSmsEnabled: form.has("ownerRealtimeSmsEnabled"),
    // Remember an explicit change, so a later default-on rollout never overrides it.
    ownerRealtimeSmsSetByOwner: current.ownerRealtimeSmsSetByOwner === true || form.has("ownerRealtimeSmsEnabled") !== current.ownerRealtimeSmsEnabled,
    usageAlertPercent,
    requireDiagnosticFeeAcceptance: form.has("requireDiagnosticFeeAcceptance"),
    // Owners toggle a fixed notice; only the platform admin form may send its own text (single line).
    recordingDisclosure: surface === "platform" ? (form.get("recordingDisclosure") ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) : form.get("recordingNotice") === "on" ? RECORDING_NOTICE : "",
    dataRetentionDays,
    supportEmail,
    flatMonthlyPriceCents: Math.round(monthlyDollars * 100),
    afterHours: {
      ...current.afterHours,
      weekdayStart,
      weekdayEnd,
      weekends: form.has("weekends"),
      holidayDates,
    },
    bookableHours: {
      ...current.bookableHours,
      weekdayStart: bookableWeekdayStart,
      weekdayEnd: bookableWeekdayEnd,
      weekends: form.has("bookableWeekends"),
    },
  };
}

function parseLines(value: string, limit: number): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, limit);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Provider error text can quote the phone number; logs keep the HTTP status and wording, not the number. */
function withoutNumbers(text: string): string {
  return text.replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]");
}

function safeError(error: unknown): string {
  if (error instanceof z.ZodError) return "Request validation failed";
  if (error instanceof Error) return redactError(error);
  return "Unknown error";
}

function renderFounderWelcome(template: string, founderName: string, businessName: string): string {
  const rendered = template
    .replaceAll("{founder_name}", founderName)
    .replaceAll("{business_name}", businessName)
    .replace(/\s+/g, " ")
    .trim();
  const compliant = /reply\s+stop/i.test(rendered) ? rendered : `${rendered} Reply STOP to opt out.`;
  return compliant.slice(0, 500);
}

async function isGoogleConnected(env: Environment, store: Store, tenantId = env.DEFAULT_TENANT_ID): Promise<boolean> {
  return Boolean(await store.getIntegrationSecret(tenantId, "google", "refresh_token") || (tenantId === env.DEFAULT_TENANT_ID && env.GOOGLE_REFRESH_TOKEN));
}

async function exchangeGoogleCode(env: Environment, client: GoogleOAuthClient, code: string, verifier: string, callbackPath = "/admin/integrations/google/callback"): Promise<string> {
  const callback = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}${callbackPath}`;
  const response = await withTimeout(fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: callback,
    }),
  }), 5_000);
  const payload = await response.json().catch(() => ({})) as { refresh_token?: string; scope?: string };
  if (!response.ok || !payload.refresh_token) throw new HttpError(502, "Google did not return a refresh token; reconnect with consent enabled");
  if (missingCalendarPermissions(payload.scope).length > 0) {
    // Don't keep a grant Otto can't use: hand it back to Google, then ask for both boxes.
    await withTimeout(fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: payload.refresh_token }),
    }), 5_000).catch(() => undefined);
    throw new HttpError(400, "Google Calendar isn't connected. Otto needs both calendar permissions, your busy times and adding events, to book jobs. Connect again and leave both boxes ticked.");
  }
  return payload.refresh_token;
}

function areaCode(phone: string | null): string | null {
  const match = /^\+1([2-9]\d{2})\d{7}$/.exec(phone ?? "");
  return match?.[1] ?? null;
}

/** A browser navigation or form post (it asks for HTML), not the app's JSON API, a webhook or a voice tool. */
function wantsPage(request: IncomingMessage): boolean {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (/^\/(api|webhooks|tools|texml)\//.test(path)) return false;
  return String(request.headers.accept ?? "").includes("text/html");
}

/** The error as a page with a way back: Calls for the owner app, the home page anywhere else. */
function errorPage(status: number, message: string, path: string): string {
  const inApp = path === "/app" || path.startsWith("/app/");
  const back = inApp ? { href: "/app", label: "Back to Calls" } : { href: "/", label: "Go to the home page" };
  if (status === 404) return renderErrorPage({ status, title: "Page not found", message: "This page doesn’t exist, or it moved.", back });
  // Never "nothing was changed": a 5xx can come after part of the work is done (signup after the account exists).
  if (status >= 500) return renderErrorPage({ status, title: "Something went wrong", message: "Please try again in a minute.", back });
  // A stale form (its CSRF token no longer matches the session), never the raw "Invalid CSRF token".
  if (status === 403 && /csrf/i.test(message)) return renderErrorPage({ status, title: "This page expired", message: "Go back and try again.", back });
  if (status === 403) return renderErrorPage({ status, title: "You can’t do that here", message: message || "Ask the shop owner.", back });
  return renderErrorPage({ status, title: "That didn’t work", message: message || "Please try again.", back });
}
