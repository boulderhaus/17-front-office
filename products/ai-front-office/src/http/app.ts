import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { z } from "zod";
import { renderAdminResetLink, renderCallbackLink, renderForgotPassword, renderResetPassword, renderCallDetail, renderConfig, renderDashboard, renderLanding, renderLogin, renderOwnerAccounts, renderOwnerDashboard, renderOwnerLogin, renderOwnerSignup, renderPilotSignups, renderPrivacy, renderPrompt, renderReadiness, renderSimulator, renderStart, renderStartReceived, renderTerms } from "../admin/render.js";
import { buildActivationReport, shopActivationBlockers, type ActivationReport } from "../application/readiness.js";
import { runAllSimulations, runSimulation, SIMULATION_SCENARIOS, type SimulationScenarioId } from "../application/simulator.js";
import { CallService, ToolWriteInProgressError } from "../application/call-service.js";
import { approvedTransferTargets } from "../application/transfer-policy.js";
import { joinTeam, teamRoutes } from "./team-routes.js";
import { renderQuickSetup } from "../admin/setup.js";
import { renderOwnerCallRecord, renderOwnerSettings } from "../admin/owner-app.js";
import { chargeSentence, isPaidStatus } from "../domain/billing.js";
import { currentPlan, hasUnlimitedPrice, introCouponId, knownPlans, legacyPlanPriceIds, normalizePlanId, pickPlan, planCatalog, planForPriceIds, planPriceIds, unlimitedPriceIds, type Plan, type PlanId } from "../domain/plans.js";
import { GuaranteeError, LeadGuaranteeService, recordFirstPaid, recordUnlimitedObservation, type UnlimitedItem } from "../application/billing-jobs.js";
import { callbackLinkMatches, readCallbackLinkToken } from "../domain/owner-sms.js";
import { callsCsv } from "./calls-csv.js";
import { hoursFromChoice } from "../domain/hours.js";
import { SMS_CONSENT_VERSION } from "../admin/footer.js";
import { stateForPhone, timezoneForState } from "../domain/area-codes.js";
import { MAX_USAGE_ALERT_PERCENT, MIN_USAGE_ALERT_PERCENT, currentBillingPeriod, isValidUsageAlertPercent } from "../domain/usage.js";

export { currentBillingPeriod };
import { apiCall, apiDashboard, apiSettings, apiTask, settingsForm, type ApiCallDetail, type ApiPlan } from "./owner-api-model.js";
import { approvedAnswer } from "../domain/approved-answer.js";
import { isExplicitHumanRequest } from "../domain/human-request.js";
import { saveAssistantConfig } from "../adapters/assistant-config.js";
import { DataDeletionService } from "../application/data-deletion.js";
import { formatEmailBody } from "../adapters/resend.js";
import { anyGoogleClient, clientForAttempt, clientForNewConnections, encodeGoogleConnection, oauthAttemptKey, type GoogleOAuthClient } from "../adapters/google-oauth-clients.js";
import { redactError, withTimeout } from "../application/retry.js";
import type { Environment } from "../config/environment.js";
import { createDemoConfig, normalizeServiceAreaInput } from "../domain/config.js";
import type { BusinessConfig, CallbackTask, CallRecord, OwnerAccount, PilotSignup, SubscriptionRecord, UsageSummary } from "../domain/models.js";
import type { OwnerSession } from "../security/owner-auth.js";
import { clearOwnerSessionCookie, createPasswordResetToken, hashOwnerPassword, hashPasswordResetToken, mintOwnerSession, ownerSessionCookie, sessionMatchesAccount, verifyOwnerCsrf, verifyOwnerPassword, verifyOwnerSession } from "../security/owner-auth.js";
import { buildTelnyxAssistantUpdate, buildTelnyxGreeting, SPAM_CATEGORIES, TRANSFER_RECORDING_NOTICE } from "../voice/system-prompt.js";
import { MAX_PROVIDER_CALL_ID_LENGTH, TOOL_DEADLINE_MS, TOOL_ROUTES, toolFailure, toolLimitReached, withinToolBudget, type ToolLimitReason, type VoiceToolName } from "../voice/tool-results.js";
import { callScreeningSetting, ensureInboundCallScreening, NumberUnavailableError, TelnyxProvisioner } from "../adapters/telnyx-provisioning.js";
import { TelnyxForwardingClient } from "../adapters/telnyx-forwarding.js";
import { carrierFamily, forwardingOffInstruction, type CarrierFamily, type CarrierInfo } from "../domain/forwarding.js";
import { FORWARDING_CHECK_WINDOW_MS, type ForwardingState } from "./owner-api-model.js";
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
import type { CalendarPort, Clock, Store } from "../ports.js";
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
import { firstChargeFromEvent, StripeBillingClient, subscriptionFromStripeEvent, verifyStripeWebhook } from "../adapters/stripe.js";
import { noopTelemetry, type Telemetry } from "../adapters/posthog.js";
import { injectAnalytics, POSTHOG_PROXY_PREFIX, proxyToPostHog } from "./posthog-proxy.js";
import {
  adminCookie,
  bearerMatches,
  clearGoogleOAuthCookie,
  createGoogleOAuthAttempt,
  csrfForSession,
  HttpError,
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

const dateTime = z.string().datetime({ offset: true });
const baseToolSchema = z.object({
  provider_call_id: z.string().min(1),
});
const availabilitySchema = baseToolSchema.extend({
  window_start: dateTime,
  window_end: dateTime,
});
const serviceAreaSchema = baseToolSchema.extend({
  address: z.string().min(3).max(500),
});
const triageSchema = baseToolSchema.extend({
  from_number: z.string().min(3).max(40),
  caller_name: z.string().max(120).optional(),
  problem_description: z.string().min(1).max(2_000),
  llm_score: z.number().min(0).max(1).optional(),
  llm_reason: z.string().max(500).optional(),
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
  from_number: z.string().min(3).max(40),
  reason: z.enum(["explicit_request", "emergency"]),
  caller_quote: z.string().min(1).max(500),
  caller_name: z.string().max(120).optional(),
  problem_description: z.string().max(2_000).optional(),
});
const intakeSchema = baseToolSchema.extend({
  from_number: z.string().min(3).max(40),
  caller_name: z.string().max(120).optional(),
  company_name: z.string().max(120).optional(),
  callback_number: z.string().max(40).optional(),
  service_address: z.string().max(500).optional(),
  service_category: z.string().max(120).optional(),
  service_category_confidence: z.number().min(0).max(1).optional(),
  problem_description: z.string().min(1).max(2_000),
  equipment_details: z.string().max(1_000).optional(),
  access_notes: z.string().max(1_000).optional(),
  diagnostic_fee_accepted: z.boolean().optional(),
  human_requested: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  recording_disclosure_given: z.boolean().optional(),
  recording_disclosure_declined: z.boolean().optional(),
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
  password: z.string().min(12).max(200),
  phone: z.string().trim().max(30).optional(),
  timezone: z.string().trim().max(100).optional(),
  serviceAreaTerms: z.string().trim().max(800).default(""),
  operationMode: z.enum(["after_hours", "overflow", "always"]).default("overflow"),
  greeting: z.string().trim().min(5).max(500).default("Thanks for calling. How can I help?"),
  weekdayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("17:00"),
  weekdayEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
  bookableWeekdayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
  bookableWeekdayEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("17:00"),
  serviceCategories: z.string().trim().min(2).max(800).default("HVAC repair, HVAC maintenance"),
  emergencyKeywords: z.string().trim().min(2).max(800).default("gas smell, carbon monoxide, no heat, frozen pipes"),
  weekends: z.string().optional(),
  ownerSmsConsent: z.literal("yes").optional(),
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
}

/** An authenticated voice tool call whose budget is already charged, before its arguments are parsed. */
interface ToolRequest {
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
    transcript: "Synthetic demonstration transcript.",
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
    transcript: "Synthetic demonstration transcript.",
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
    transcript: "Synthetic demonstration transcript.",
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

const OWNER_APP_PATH = /^\/app(?:\/(?:start|jobs|calendar|settings|calls|calls\/[0-9a-f-]{36}))?\/?$/i;
const DEMO_APP_PATH = /^\/demo(?:\/(?:jobs|calendar|calls|calls\/[A-Za-z0-9-]{1,64}))?\/?$/;
function isOwnerAppPath(pathname: string): boolean { return OWNER_APP_PATH.test(pathname); }
function isDemoAppPath(pathname: string): boolean { return DEMO_APP_PATH.test(pathname); }

function ownerDashboardView(value: string | null): "today" | "pipeline" | "calendar" {
  return value === "pipeline" || value === "calendar" ? value : "today";
}

export function createRequestHandler(dependencies: AppDependencies): RequestListener {
  const service = new CallService(dependencies.store, dependencies.calendar, dependencies.clock, dependencies.env.PUBLIC_BASE_URL, {
    callbackLinkKey: dependencies.env.SESSION_SIGNING_KEY ?? null,
    ownerEmailAvailable: Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL),
  });
  const recordingClient = dependencies.env.TELNYX_API_KEY ? new TelnyxRecordingClient(dependencies.env.TELNYX_API_KEY, dependencies.fetcher ?? fetch) : null;
  const routingClient = dependencies.env.TELNYX_API_KEY && dependencies.env.TELNYX_FROM_NUMBER && dependencies.env.TELNYX_ASSISTANT_ID
    ? new TelnyxVoiceRoutingClient({ apiKey: dependencies.env.TELNYX_API_KEY, phoneNumber: dependencies.env.TELNYX_FROM_NUMBER, assistantId: dependencies.env.TELNYX_ASSISTANT_ID })
    : null;
  const stripeClient = createStripeClient(dependencies.env, dependencies.fetcher ?? fetch);
  const guarantee = new LeadGuaranteeService(dependencies.store, stripeClient, dependencies.clock, (entry) => (dependencies.logger ?? ((value) => console.log(JSON.stringify(value))))(entry));
  const deletionService = new DataDeletionService(dependencies.store, recordingClient);
  const dummyOwnerPasswordHash = hashOwnerPassword(`unregistered:${randomUUID()}`);
  const limiter = new RateLimiter();
  const log = dependencies.logger ?? ((entry) => console.log(JSON.stringify(entry)));
  const telemetry = dependencies.telemetry ?? noopTelemetry;
  const graceContext: GraceContext = { store: dependencies.store, env: dependencies.env, clock: dependencies.clock, fetcher: dependencies.fetcher, log };
  const analyticsPage = (html: string, loader = true): string => injectAnalytics(html, { key: dependencies.env.POSTHOG_KEY, ingestionHost: dependencies.env.POSTHOG_HOST, loader });
  let ownerWebIndex: Promise<string | null> | null = null;
  const WEB_TYPES: Record<string, string> = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", woff2: "font/woff2", woff: "font/woff", svg: "image/svg+xml", png: "image/png" };
  const recordingUrls = new Map<string, { url: string; expiresAt: number }>();
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
    unlimited: plan.unlimited ? { addOnCents: plan.unlimited.addOnCents, priceCents: plan.unlimited.priceCents, firstMonthCents: plan.unlimited.firstMonthCents, fairUseCalls: plan.unlimited.fairUseCalls, chargeNote: planCharge(plan, timezone, true) } : null,
  })) : [];
  const signupPage = (error = "", values: Record<string, string> = {}): string => renderOwnerSignup(error, values, {
    supportEmail: dependencies.env.SUPPORT_EMAIL ?? null,
    chargeNote: stripeClient ? planCharge(plans[0]!) : null,
    plans: stripeClient ? plans.map((plan) => ({ ...plan, chargeNote: planCharge(plan), unlimitedChargeNote: plan.unlimited ? planCharge(plan, undefined, true) : null })) : [],
  });
  /** The add-on can be bought only where this plan's Unlimited price exists. */
  const wantsUnlimited = (plan: Plan, value: unknown): boolean => Boolean(plan.unlimited) && (value === "yes" || value === "1" || value === "on" || value === true);

  return (request, response) => {
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
      else sendJson(response, status, { error: message, request_id: requestId });
    });
  };

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
      log({ level: status >= 500 ? "error" : "warn", event: "tool_request_failed", requestId, tool, status, error: safeError(error) });
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

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setSecurityHeaders(response);
    const requestId = typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : randomUUID();
    response.setHeader("x-request-id", requestId);
    const started = Date.now();
    const url = new URL(request.url ?? "/", "http://localhost");
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
    if (!route.startsWith("webhook") && !route.startsWith("tool:") && !limiter.allow(`${ip}:${route}`, 90, 60_000)) {
      throw new HttpError(429, "Too many requests");
    }

    if (method === "GET" && url.pathname === "/assets/front-office-mascot-flat.png") {
      const asset = await readFile(resolve(process.cwd(), "public/assets/front-office-mascot-flat.png"));
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
      return sendHtml(response, 200, analyticsPage(renderLanding(config, undefined, { supportEmail: dependencies.env.SUPPORT_EMAIL ?? null, trialDays: stripeClient ? trialDays : 0, plans })));
    }
    if (method === "GET" && url.pathname.startsWith("/web/assets/")) return serveWebAsset(response, url.pathname.slice("/web/assets/".length));
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
    if (url.pathname === "/join" && (method === "GET" || method === "POST")) {
      if (!limiter.allow(`${ip}:team-join`, 12, 60 * 60_000)) throw new HttpError(429, "Too many invitation attempts");
      return joinTeam(request, response, url, dependencies);
    }
    if (method === "GET" && url.pathname === "/signup") {
      // The pricing page's picks carry over: ?unlimited=1 and ?plan=team preselect the form.
      const preset: Record<string, string> = {};
      if (url.searchParams.get("unlimited") === "1") preset.unlimited = "yes";
      const presetPlan = normalizePlanId(url.searchParams.get("plan"));
      if (presetPlan && plans.some((plan) => plan.id === presetPlan)) preset.plan = presetPlan;
      return sendHtml(response, 200, analyticsPage(signupPage("", preset)));
    }
    if (method === "POST" && url.pathname === "/signup") {
      if (!limiter.allow(`${ip}:owner-signup`, 5, 60 * 60_000)) throw new HttpError(429, "Too many signup attempts from this connection");
      const form = parseForm(await readBody(request, 48_000));
      if (form.get("faxNumber")?.trim()) return sendHtml(response, 200, signupPage());
      const values = Object.fromEntries(form.entries());
      const parsed = ownerSignupSchema.safeParse(values);
      if (!parsed.success) return sendHtml(response, 400, signupPage("Check every required field and use a password with at least 12 characters.", values));
      const phoneInput = parsed.data.phone?.trim() ?? "";
      const phone = phoneInput ? normalizeUsPhone(phoneInput) : null;
      if (phoneInput && !phone) return sendHtml(response, 400, signupPage("Enter a valid US mobile number.", values));
      if ((parsed.data.ownerSmsConsent === "yes" || parsed.data.founderSmsConsent === "yes") && !phone) {
        return sendHtml(response, 400, signupPage("Add a valid US mobile number to receive text messages.", values));
      }
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
        displayName: parsed.data.displayName,
        passwordHash: await hashOwnerPassword(parsed.data.password),
        status: "pending_activation",
        createdAt: now,
        updatedAt: now,
      };
      const splitList = (value: string): string[] => value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 100);
      const serviceArea = normalizeServiceAreaInput(parsed.data.serviceAreaTerms || homeState || "");
      if (serviceArea.errors.length > 0) return sendHtml(response, 400, signupPage(serviceAreaMessage(serviceArea.errors), values));
      // The plan picked above the button; Solo when nothing was sent.
      const plan = pickPlan(plans, form.get("plan"));
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
        timezone,
        serviceAreaTerms: serviceArea.terms,
        emergencyKeywords: splitList(parsed.data.emergencyKeywords),
        serviceCategories: splitList(parsed.data.serviceCategories),
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
      if (!created) return sendHtml(response, 409, signupPage("That email already has an account. Sign in instead.", values));
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
      if (parsed.data.ownerSmsConsent === "yes") {
        // Proof of opt-in for the carrier: when, from where, and the exact wording version shown.
        await dependencies.store.saveIntegrationSecret(tenantId, "notifications", "owner_sms_consent", JSON.stringify({ at: now, source: "signup", wording: SMS_CONSENT_VERSION, ip }));
      }
      const session = mintOwnerSession(account, dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
      response.setHeader("set-cookie", ownerSessionCookie(session, dependencies.env.NODE_ENV === "production"));
      log({ level: "info", event: "owner_workspace_created", accountId: account.id, tenantId });
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
    if (method === "GET" && url.pathname === "/login") return sendHtml(response, 200, renderOwnerLogin());
    if (method === "POST" && url.pathname === "/login") {
      if (!limiter.allow(`${ip}:owner-login`, 10, 15 * 60_000)) throw new HttpError(429, "Too many sign-in attempts");
      const parsed = ownerLoginSchema.safeParse(Object.fromEntries(parseForm(await readBody(request, 16_000)).entries()));
      if (!parsed.success) return sendHtml(response, 400, renderOwnerLogin("Enter a valid email and password."));
      // Per-account limit so guesses spread across many addresses still stop.
      if (!limiter.allow(`owner-login-email:${parsed.data.email}`, 10, 15 * 60_000)) throw new HttpError(429, "Too many sign-in attempts");
      const account = await dependencies.store.getOwnerAccountByEmail(parsed.data.email);
      const valid = await verifyOwnerPassword(parsed.data.password, account?.passwordHash ?? await dummyOwnerPasswordHash);
      if (!account || !valid || account.status === "suspended") return sendHtml(response, 401, renderOwnerLogin("Email or password is incorrect."));
      const session = mintOwnerSession(account, dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
      response.setHeader("set-cookie", ownerSessionCookie(session, dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/app");
    }
    if (url.pathname === "/forgot" && (method === "GET" || method === "POST")) {
      const emailEnabled = Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL);
      if (method === "GET") return sendHtml(response, 200, renderForgotPassword({ emailEnabled, supportEmail: dependencies.env.SUPPORT_EMAIL ?? null }));
      if (!emailEnabled) return sendHtml(response, 200, renderForgotPassword({ emailEnabled, supportEmail: dependencies.env.SUPPORT_EMAIL ?? null }));
      if (!limiter.allow(`${ip}:forgot`, 5, 60 * 60_000)) throw new HttpError(429, "Too many reset requests");
      const parsed = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).safeParse(Object.fromEntries(parseForm(await readBody(request, 4_000)).entries()));
      if (!parsed.success) return sendHtml(response, 400, renderForgotPassword({ emailEnabled, error: "Enter the email on your account." }));
      const resetAccount = limiter.allow(`forgot-email:${parsed.data.email}`, 3, 60 * 60_000) ? await dependencies.store.getOwnerAccountByEmail(parsed.data.email) : null;
      if (resetAccount && resetAccount.status !== "suspended") {
        const { token, tokenHash } = createPasswordResetToken();
        const now = dependencies.clock.now();
        await dependencies.store.createPasswordReset(resetAccount.id, tokenHash, new Date(now.getTime() + 30 * 60_000).toISOString());
        const link = `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/reset?token=${encodeURIComponent(token)}`;
        await dependencies.store.enqueueNotification({
          id: randomUUID(), tenantId: resetAccount.tenantId, callId: null, channel: "email", destinationRef: `email:${resetAccount.email}`,
          body: formatEmailBody("Reset your Front Office password", `Use this link within 30 minutes to choose a new password:\n\n${link}\n\nIf you didn't ask for this, ignore this email. Your password has not changed.`),
          priority: "high", state: "pending", attempts: 0, nextAttemptAt: now.toISOString(),
          idempotencyKey: `password-reset:${tokenHash}`, providerReceipt: null, lastError: null, createdAt: now.toISOString(), sentAt: null,
        });
      }
      // Same answer whether or not the account exists.
      return sendHtml(response, 200, renderForgotPassword({ emailEnabled, sent: true }));
    }
    if (url.pathname === "/reset" && method === "GET") return sendHtml(response, 200, renderResetPassword(url.searchParams.get("token") ?? ""));
    if (url.pathname === "/reset" && method === "POST") {
      if (!limiter.allow(`${ip}:reset`, 10, 60 * 60_000)) throw new HttpError(429, "Too many attempts");
      const form = parseForm(await readBody(request, 4_000));
      const token = form.get("token") ?? "";
      const password = form.get("password") ?? "";
      if (password.length < 12 || password.length > 200) return sendHtml(response, 400, renderResetPassword(token, "Use at least 12 characters."));
      if (password !== form.get("confirm")) return sendHtml(response, 400, renderResetPassword(token, "The two passwords don't match."));
      const accountId = token ? await dependencies.store.consumePasswordReset(hashPasswordResetToken(token), dependencies.clock.now().toISOString()) : null;
      if (!accountId) return sendHtml(response, 400, renderForgotPassword({ emailEnabled: Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL), error: "That reset link is expired or already used. Ask for a new one." }));
      await dependencies.store.updateOwnerPassword(accountId, await hashOwnerPassword(password), dependencies.clock.now().toISOString());
      log({ level: "info", event: "owner_password_reset", accountId });
      response.setHeader("set-cookie", clearOwnerSessionCookie(dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/login");
    }
    if (method === "GET" && url.pathname === "/logout") {
      response.setHeader("set-cookie", clearOwnerSessionCookie(dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/");
    }
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
    const context: ToolRequest = { rawBody, callId, signal };
    const result = await toolResult(url.pathname, context);
    signal.throwIfAborted();
    if (!response.headersSent) sendJson(response, 200, result);
  }

  async function toolResult(pathname: string, tool: ToolRequest): Promise<unknown> {
    if (pathname === "/tools/save-intake") return handleIntake(tool);
    if (pathname === "/tools/approved-answer") {
      const input = baseToolSchema.extend({ kind: z.enum(["price", "answer"]), key: z.string().max(120) }).strict().parse(toolPayload(tool));
      requireToolCallId(tool, input.provider_call_id);
      const tenantId = await tenantForCall(input.provider_call_id);
      await requireOperational(tenantId);
      return { ...approvedAnswer(await dependencies.store.getConfig(tenantId), input.kind, input.key), wrap_up: await service.wrapUp(input.provider_call_id) };
    }
    if (pathname === "/tools/check-service-area") return handleServiceArea(tool);
    if (pathname === "/tools/check-availability") return handleAvailability(tool);
    if (pathname === "/tools/triage") return handleTriage(tool);
    if (pathname === "/tools/book") return handleBooking(tool);
    if (pathname === "/tools/request-human") return handleHandoff(tool);
    if (pathname === "/tools/mark-spam") {
      const input = baseToolSchema.extend({ from_number: z.string().min(3).max(40), category: z.enum(SPAM_CATEGORIES), caller_quote: z.string().min(1).max(500) }).parse(toolPayload(tool));
      requireToolCallId(tool, input.provider_call_id);
      const tenantId = await tenantForCall(input.provider_call_id);
      await requireOperational(tenantId);
      return service.markSpam({ tenantId, providerCallId: input.provider_call_id, fromNumber: input.from_number, category: input.category, callerQuote: input.caller_quote });
    }
    throw new HttpError(404, "Not found");
  }

  function toolPayload(tool: ToolRequest): unknown {
    return unwrapToolPayload(parseJson<unknown>(tool.rawBody));
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
  async function sendOwnerWeb(response: ServerResponse): Promise<boolean> {
    const html = await loadOwnerWebIndex();
    if (!html) return false;
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
    if (url) {
      if (recordingUrls.size > 500) recordingUrls.delete(recordingUrls.keys().next().value!);
      recordingUrls.set(providerCallId, { url, expiresAt: now + 4 * 60_000 });
    }
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
    const [config, calls, tasks, usage, googleConnected, lineNumber, ownerMobile, hoursSetAt, completedAt] = await Promise.all([
      dependencies.store.getConfig(account.tenantId),
      dependencies.store.listCalls(account.tenantId, 50),
      dependencies.store.listCallbackTasks(account.tenantId, 100),
      dependencies.store.getUsageSummary(account.tenantId, ...currentBillingPeriod(dependencies.clock.now(), subscription?.currentPeriodEnd)),
      isGoogleConnected(dependencies.env, dependencies.store, account.tenantId),
      dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number"),
      dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
      dependencies.store.getIntegrationSecret(account.tenantId, "onboarding", "hours_set_at"),
      dependencies.store.getIntegrationSecret(account.tenantId, "onboarding", "completed_at"),
    ]);
    const model = apiDashboard({
      account, config, calls, tasks, usage, googleConnected, subscription, csrf, lineNumber, ownerMobile,
      googleAvailable: anyGoogleClient(dependencies.env),
      chargeNote: stripeClient ? planCharge(currentPlan(known, config.planId), config.timezone, config.unlimitedCalls === true) : null,
      plans: apiPlans(config.timezone),
      guarantee: await guarantee.status(account.tenantId),
      onboarding: { hoursSet: Boolean(hoursSetAt), completed: Boolean(completedAt) },
      forwarding: await readForwarding(account.tenantId),
      checkoutConfigured: Boolean(stripeClient || dependencies.env.FOUNDING_CHECKOUT_URL),
      now: dependencies.clock.now().toISOString(),
      preview: false,
    });
    // Opaque ids only, so the browser can identify the owner and group by shop without email or phone.
    return telemetry.enabled ? { ...model, analytics: { distinctId: account.id, tenantId: account.tenantId } } : model;
  }
  async function handleOwnerApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const auth = await authenticateOwner(request);
    if (!auth) return sendJson(response, 401, { error: "Sign in again", login: "/login" });
    const { session, account } = auth;
    const method = request.method ?? "GET";
    const owner = account.role !== "member";
    if (method === "GET" && url.pathname === "/api/app/dashboard") return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    if (method === "POST" && url.pathname === "/api/app/line/business-number") {
      if (!owner) throw new HttpError(403, "Only the owner can set up call forwarding");
      const body = await readApiJson(request, session, 1_000) as { number?: unknown; family?: unknown };
      if (!limiter.allow(`business-number:${account.tenantId}`, 30, 60 * 60_000)) throw new HttpError(429, "Too many tries. Please try again in a bit.");
      const number = typeof body.number === "string" ? normalizeUsPhone(body.number) : null;
      if (!number) throw new HttpError(400, "Enter your business phone number, like (941) 555-0123");
      const lineNumber = await dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number");
      if (lineNumber && number === lineNumber) throw new HttpError(400, "That’s your Front Office number. Enter the number your customers call today.");
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
      await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", number);
      await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify(carrier));
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    if (method === "POST" && url.pathname === "/api/app/line/check") {
      if (!owner) throw new HttpError(403, "Only the owner can check call forwarding");
      await readApiJson(request, session, 1_000);
      const [lineNumber, state] = await Promise.all([
        dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number"),
        readForwarding(account.tenantId),
      ]);
      if (!lineNumber) throw new HttpError(409, "Turn on your Front Office line first.");
      if (!state.businessNumber) throw new HttpError(409, "Add your business phone number first.");
      if (!limiter.allow(`forwarding-check:${account.tenantId}`, 6, 60 * 60_000)) throw new HttpError(429, "That’s a lot of checks. Please wait a few minutes and try again.");
      const startedAt = dependencies.clock.now().toISOString();
      const connectionId = dependencies.env.TELNYX_CHECK_CONNECTION_ID;
      const from = dependencies.env.TELNYX_FROM_NUMBER;
      let method: "auto" | "manual" = "manual";
      let callControlId: string | null = null;
      if (connectionId && from && dependencies.env.TELNYX_API_KEY && !dependencies.env.PROVIDER_TEST_MODE) {
        callControlId = await new TelnyxForwardingClient({ apiKey: dependencies.env.TELNYX_API_KEY, ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}) })
          .placeCheckCall({ connectionId, from, to: state.businessNumber, tenantId: account.tenantId, webhookUrl: `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx` })
          .catch((error) => { log({ level: "error", event: "forwarding_check_call_failed", tenantId: account.tenantId, error: safeError(error) }); return null; });
        if (callControlId) method = "auto";
      }
      await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "check", JSON.stringify({ startedAt, method, callControlId }));
      log({ level: "info", event: "forwarding_check_started", tenantId: account.tenantId, method });
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    if (method === "POST" && url.pathname === "/api/app/line/help") {
      if (!owner) throw new HttpError(403, "Only the owner can ask for setup help");
      await readApiJson(request, session, 1_000);
      if (!limiter.allow(`forwarding-help:${account.tenantId}`, 3, 24 * 60 * 60_000)) throw new HttpError(429, "We already have your request. We’ll call you soon.");
      const [config, state, ownerPhone, lineNumber] = await Promise.all([
        dependencies.store.getConfig(account.tenantId),
        readForwarding(account.tenantId),
        dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
        dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number"),
      ]);
      const now = dependencies.clock.now().toISOString();
      await dependencies.store.saveIntegrationSecret(account.tenantId, "forwarding", "help_requested_at", now);
      if (dependencies.env.SUPPORT_EMAIL) {
        await dependencies.store.enqueueNotification({
          id: randomUUID(), tenantId: account.tenantId, callId: null, channel: "email", destinationRef: `email:${dependencies.env.SUPPORT_EMAIL}`,
          body: formatEmailBody(`Forwarding help: ${config.businessName}`, [
            `${config.businessName} wants help setting up call forwarding.`,
            `Call them back: ${ownerPhone ?? state.businessNumber ?? "no number on file"}`,
            `Business number: ${state.businessNumber ?? "not entered"}`,
            `Carrier: ${state.carrier?.name ?? "unknown"} (${state.carrier?.family ?? "unknown"}, ${state.carrier?.lineType ?? "unknown line type"})`,
            `Forward to (Front Office number): ${lineNumber ?? "line not turned on yet"}`,
            `Account: ${account.email}`,
          ].join("\n")),
          priority: "high", state: "pending", attempts: 0, nextAttemptAt: now,
          idempotencyKey: `forwarding-help:${account.tenantId}:${now.slice(0, 13)}`,
          providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
        });
      }
      log({ level: "warn", event: "forwarding_help_requested", tenantId: account.tenantId, emailed: Boolean(dependencies.env.SUPPORT_EMAIL) });
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
    if (method === "POST" && url.pathname === "/api/app/billing/plan") {
      if (!owner) throw new HttpError(403, "Only the owner can change the plan");
      const body = await readApiJson(request, session, 1_000) as { plan?: unknown };
      const id = normalizePlanId(body.plan);
      const plan = plans.find((item) => item.id === id);
      if (!plan) throw new HttpError(400, "Pick a plan");
      if (!limiter.allow(`plan-change:${account.tenantId}`, 10, 60 * 60_000)) throw new HttpError(429, "That’s a lot of plan changes. Please try again in a bit.");
      await changePlan(account, plan);
      return sendJson(response, 200, await ownerDashboardModel(account, session.csrf));
    }
    if (method === "POST" && url.pathname === "/api/app/billing/unlimited") {
      if (!owner) throw new HttpError(403, "Only the owner can change Unlimited calls");
      const body = await readApiJson(request, session, 1_000) as { on?: unknown };
      if (typeof body.on !== "boolean") throw new HttpError(400, "Say on or off");
      if (!limiter.allow(`plan-change:${account.tenantId}`, 10, 60 * 60_000)) throw new HttpError(429, "That’s a lot of plan changes. Please try again in a bit.");
      await setUnlimited(account, body.on);
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
    if (url.pathname === "/api/app/settings") {
      if (!owner) throw new HttpError(403, "Only the owner can change shop settings");
      if (method === "PUT") {
        const body = await readApiJson(request, session, 64_000);
        let form: URLSearchParams;
        try { form = settingsForm(body); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Invalid settings"); }
        await saveOwnerSettings(account, form);
      } else if (method !== "GET") throw new HttpError(405, "Method not allowed");
      const [config, googleConnected, ownerPhone, subscription] = await Promise.all([
        dependencies.store.getConfig(account.tenantId),
        isGoogleConnected(dependencies.env, dependencies.store, account.tenantId),
        dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
        dependencies.store.getSubscription(account.tenantId),
      ]);
      return sendJson(response, 200, {
        csrf: session.csrf,
        values: apiSettings(config),
        status: account.status,
        businessName: config.businessName,
        shopId: account.tenantId,
        plan: (() => {
          const current = currentPlan(known, config.planId);
          return {
            id: current.id, label: current.label, flatMonthlyPriceCents: config.flatMonthlyPriceCents, includedCalls: config.includedCalls, overageCentsPerCall: config.overageCentsPerCall,
            paid: isPaidStatus(subscription?.status), plans: apiPlans(config.timezone),
            // Legacy Pro keeps working but is no longer sold: the owner sees it as current and can move to Solo, Team or Fleet.
            sold: current.sold,
            unlimited: config.unlimitedCalls === true,
            unlimitedOffer: current.unlimited ? { addOnCents: current.unlimited.addOnCents, priceCents: current.unlimited.priceCents, fairUseCalls: current.unlimited.fairUseCalls } : null,
          };
        })(),
        integrations: {
          googleAvailable: anyGoogleClient(dependencies.env),
          googleConnected,
          ownerPhoneConfigured: Boolean(ownerPhone),
          weeklyEmailAvailable: Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL),
          dailySmsAvailable: Boolean(dependencies.env.STRIPE_DAILY_SMS_PRICE_ID),
          realtimeSmsAvailable: Boolean(dependencies.env.STRIPE_REALTIME_SMS_PRICE_ID),
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
      const body = callsCsv(calls, config.timezone);
      response.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="front-office-calls-${dependencies.clock.now().toISOString().slice(0, 10)}.csv"`,
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
      const [booking, task, notifications] = await Promise.all([
        dependencies.store.getBookingForCall(call.id),
        dependencies.store.getCallbackTaskForCall(call.id),
        dependencies.store.listNotifications(call.id),
      ]);
      const detail: ApiCallDetail = {
        call: apiCall(call),
        recordingUrl: call.recordingUrl?.startsWith("https://") ? `/app/provider/telnyx/recordings/${encodeURIComponent(call.providerCallId)}?stream=1` : null,
        booking: booking ? { status: booking.status, requestedStart: booking.requestedStart } : null,
        task: task && task.tenantId === account.tenantId ? apiTask(task) : null,
        alerts: notifications.filter((item) => item.channel === "sms" && item.tenantId === account.tenantId).map((item) => ({ priority: item.priority, state: item.state })),
        canDelete: owner,
      };
      return sendJson(response, 200, detail);
    }
    throw new HttpError(404, "Not found");
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
    const detail: ApiCallDetail = { call: apiCall(call), recordingUrl: null, booking: null, task: task ? apiTask(task) : null, alerts: [], canDelete: false };
    return sendJson(response, 200, detail);
  }

  /** One path for the settings form and the JSON API, so validation and side effects stay identical. */
  /** Billing lock first (same order as Stripe events and the grace sweep): an unpause can reconnect a grace-period line. */
  async function saveOwnerSettings(account: OwnerAccount, form: URLSearchParams): Promise<void> {
    await dependencies.store.withLock(`billing:${account.tenantId}`, () => saveOwnerSettingsLocked(account, form));
  }

  async function saveOwnerSettingsLocked(account: OwnerAccount, form: URLSearchParams): Promise<void> {
    await dependencies.store.withLock(`config:${account.tenantId}`, async () => {
    const current = await dependencies.store.getConfig(account.tenantId);
    const updated = configFromForm(current, form, "owner");
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
    if (updated.ownerDailySmsEnabled && !dependencies.env.STRIPE_DAILY_SMS_PRICE_ID) throw new HttpError(503, "Daily SMS billing is not configured yet");
    if (updated.ownerRealtimeSmsEnabled && !dependencies.env.STRIPE_REALTIME_SMS_PRICE_ID) throw new HttpError(503, "Instant lead SMS billing is not configured yet");
    const addOnsChanged = updated.ownerDailySmsEnabled !== current.ownerDailySmsEnabled
      || updated.ownerRealtimeSmsEnabled !== current.ownerRealtimeSmsEnabled;
    let addOnSubscriptionId: string | null = null;
    if (addOnsChanged) {
      const subscription = await dependencies.store.getSubscription(account.tenantId);
      if (subscription && isPaidStatus(subscription.status)) {
        if (!stripeClient || !subscription.providerSubscriptionId) throw new HttpError(503, "Subscription add-on billing is not available yet");
        addOnSubscriptionId = subscription.providerSubscriptionId;
      }
    }
    if (account.status !== "active") updated.paused = true;
    if (updated.paused !== current.paused) updated.pausedForBilling = false;
    const ownerPhone = form.get("ownerPhone")?.trim();
    if (ownerPhone) {
      if (!/^\+[1-9]\d{7,14}$/.test(ownerPhone)) throw new HttpError(400, "Owner phone must use E.164 format");
      await dependencies.store.saveIntegrationSecret(account.tenantId, "notifications", "owner-primary", ownerPhone);
      updated.ownerNotificationRefs = ["owner-primary"];
      updated.ownerTransferNumberRef = "owner-primary";
    }
    let liveRouteChange: TelnyxVoiceRoutingClient | null = null;
    if (account.status === "active" && updated.paused !== current.paused) {
      const [route, inboundNumber] = await Promise.all([
        dependencies.store.getProviderRouteForTenant("telnyx", account.tenantId),
        dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number"),
      ]);
      if (!dependencies.env.TELNYX_API_KEY || !route || !inboundNumber) throw new HttpError(409, "The live phone route is not configured for this shop");
      liveRouteChange = voiceRouting(inboundNumber, route.externalId);
      await liveRouteChange.setPaused(updated.paused)
        .catch(() => { throw new HttpError(502, "Telnyx could not change the live phone route; your setting was not changed"); });
    }
    if (addOnSubscriptionId) {
      await stripeClient!.syncAddOns(addOnSubscriptionId, {
        dailySms: updated.ownerDailySmsEnabled,
        realtimeSms: updated.ownerRealtimeSmsEnabled,
      }).catch(async (error) => {
        if (liveRouteChange) await liveRouteChange.setPaused(current.paused).catch(() => undefined);
        log({ level: "error", event: "owner_addon_sync_failed", tenantId: account.tenantId, error: safeError(error) });
        throw new HttpError(502, "Stripe could not update the notification add-ons; settings were not changed");
      });
    }
    try {
      await saveAssistantConfig(dependencies.store, dependencies.env, updated);
    } catch (error) {
      if (liveRouteChange) await liveRouteChange.setPaused(current.paused).catch((rollbackError) => log({ level: "error", event: "owner_route_rollback_failed", tenantId: account.tenantId, error: safeError(rollbackError) }));
      if (addOnSubscriptionId) await stripeClient!.syncAddOns(addOnSubscriptionId, {
        dailySms: current.ownerDailySmsEnabled,
        realtimeSms: current.ownerRealtimeSmsEnabled,
      }).catch((rollbackError) => log({ level: "error", event: "owner_addon_rollback_failed", tenantId: account.tenantId, error: safeError(rollbackError) }));
      throw error;
    }
    });
  }

  /** Owner follow-up actions, shared by the form posts and the JSON API. Another shop's call is a 404. */
  async function ownerTaskAction(account: OwnerAccount, callId: string, action: "complete" | "reopen" | "snooze", minutes?: number): Promise<CallbackTask> {
    const task = await dependencies.store.getCallbackTaskForCall(callId);
    if (!task || task.tenantId !== account.tenantId) throw new HttpError(404, "Task not found");
    const now = dependencies.clock.now();
    let next: CallbackTask;
    if (action === "complete") {
      next = { ...task, status: "completed", completedAt: now.toISOString(), completionSource: "owner", updatedAt: now.toISOString() };
    } else if (action === "reopen") {
      if (task.status !== "completed") throw new HttpError(404, "Completed task not found");
      next = { ...task, status: "open", dueAt: now.toISOString(), completedAt: null, completionSource: null, updatedAt: now.toISOString() };
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
    if (!session) return redirect(response, "/login");
    const account = await dependencies.store.getOwnerAccountById(session.accountId);
    if (!account || account.tenantId !== session.tenantId || account.status === "suspended" || !sessionMatchesAccount(session, account)) {
      response.setHeader("set-cookie", clearOwnerSessionCookie(dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/login");
    }
    const method = request.method ?? "GET";
    const member = account.role === "member";
    if (url.pathname === "/app/setup") {
      if (member) throw new HttpError(403, "Only the owner can change the shop’s call setup");
      if (method === "GET") return sendHtml(response, 200, renderQuickSetup(await dependencies.store.getConfig(account.tenantId), session.csrf, await isGoogleConnected(dependencies.env, dependencies.store, account.tenantId), { directBooking: dependencies.env.DIRECT_BOOKING_BETA, warmTransfer: dependencies.env.WARM_TRANSFER_BETA }));
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      const form = parseForm(await readBody(request, 20_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
      const parsed = z.object({ businessName: z.string().trim().min(2).max(120), serviceAreaTerms: z.string().trim().min(2).max(800), timezone: z.string(), operationMode: z.enum(["overflow", "after_hours", "always"]), start: time, end: time, bookStart: time, bookEnd: time, bookingMode: z.enum(["confirm", "direct"]), greeting: z.string().trim().min(5).max(500), prices: z.string().max(5000), answers: z.string().max(5000) }).safeParse(Object.fromEntries(form));
      if (!parsed.success || parsed.data.bookStart >= parsed.data.bookEnd) throw new HttpError(400, "Check the required answers and appointment hours");
      const data = parsed.data;
      const serviceArea = normalizeServiceAreaInput(data.serviceAreaTerms);
      if (serviceArea.errors.length > 0 || serviceArea.terms.length === 0) throw new HttpError(400, serviceAreaMessage(serviceArea.errors));
      try { new Intl.DateTimeFormat("en-US", { timeZone: data.timezone }).format(); } catch { throw new HttpError(400, "Choose a valid timezone"); }
      const phoneInput = form.get("ownerPhone")?.trim();
      const phone = phoneInput ? normalizeUsPhone(phoneInput) : null;
      if (phoneInput && !phone) throw new HttpError(400, "Enter a valid US mobile number");
      await dependencies.store.withLock(`config:${account.tenantId}`, async () => {
        const current = await dependencies.store.getConfig(account.tenantId);
        if (phone) await dependencies.store.saveIntegrationSecret(account.tenantId, "notifications", "owner-primary", phone);
        if (form.get("ownerSmsConsent") === "yes" && !phone && !await dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary")) throw new HttpError(400, "Add a mobile number for text alerts");
        await saveAssistantConfig(dependencies.store, dependencies.env, { ...current, businessName: data.businessName, timezone: data.timezone, serviceAreaTerms: serviceArea.terms, operationMode: data.operationMode, afterHours: { ...current.afterHours, weekdayStart: data.start, weekdayEnd: data.end }, bookableHours: { ...current.bookableHours, weekdayStart: data.bookStart, weekdayEnd: data.bookEnd, weekends: form.get("weekends") === "on" }, bookingMode: dependencies.env.DIRECT_BOOKING_BETA ? data.bookingMode : "confirm", greeting: data.greeting, recordingDisclosure: form.get("recordingNotice") === "on" ? RECORDING_NOTICE : "", priceSnippets: parseLines(data.prices, 30).map((text, index) => ({ label: `Approved price ${index + 1}`, text })), approvedKnowledge: parseLines(data.answers, 30).map((text, index) => ({ topic: `Approved answer ${index + 1}`, text })), ownerNotificationRefs: form.get("ownerSmsConsent") === "yes" ? ["owner-primary"] : [], ownerTransferNumberRef: "owner-primary", warmTransferEnabled: dependencies.env.WARM_TRANSFER_BETA && form.get("warmTransferEnabled") === "on" });
      });
      if (form.get("ownerSmsConsent") === "yes") {
        await dependencies.store.saveIntegrationSecret(account.tenantId, "notifications", "owner_sms_consent", JSON.stringify({ at: dependencies.clock.now().toISOString(), source: "setup", wording: SMS_CONSENT_VERSION, ip: requestIp(request) }));
      }
      return redirect(response, "/app?setup=saved");
    }
    if (member && (url.pathname.startsWith("/app/billing") || url.pathname === "/app/config" || /\/delete$/.test(url.pathname))) throw new HttpError(403, "Only the owner can change billing, shop rules, or delete call records");
    if (member && url.pathname === "/app/settings") return redirect(response, "/app/team");
    if (url.pathname === "/app/team" || url.pathname.startsWith("/app/team/")) {
      if (method === "POST" && url.pathname === "/app/team/invite" && !limiter.allow(`invite:${account.id}`, 10, 60 * 60_000)) throw new HttpError(429, "Too many invitations. Please try again later.");
      return teamRoutes(request, response, url, dependencies, account, session);
    }
    if (method === "GET" && isOwnerAppPath(url.pathname) && await sendOwnerWeb(response)) return;
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
          : error.message;
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
      if (!stripeClient || !subscription?.providerCustomerId) throw new HttpError(409, "No paid subscription to manage yet");
      const portalUrl = await stripeClient.createPortal(subscription.providerCustomerId, `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app`)
        .catch(() => { throw new HttpError(502, "Billing could not be opened. Please retry; your subscription has not changed."); });
      return redirect(response, portalUrl);
    }
    if (method === "POST" && url.pathname === "/app/billing/checkout") {
      const form = parseForm(await readBody(request, 8_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
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
        integrations: {
          googleAvailable: anyGoogleClient(dependencies.env),
          googleConnected,
          ownerPhoneConfigured: Boolean(ownerPhone),
          weeklyEmailAvailable: Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL),
          dailySmsAvailable: Boolean(dependencies.env.STRIPE_DAILY_SMS_PRICE_ID),
          realtimeSmsAvailable: Boolean(dependencies.env.STRIPE_REALTIME_SMS_PRICE_ID),
          directBookingAvailable: dependencies.env.DIRECT_BOOKING_BETA,
        },
      }));
    }
    if (method === "POST" && url.pathname === "/app/config") {
      const form = parseForm(await readBody(request, 64_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      await saveOwnerSettings(account, form);
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
      if (form.get("confirm")?.trim().toLowerCase() !== "delete") throw new HttpError(400, "Type DELETE to confirm");
      if (!await verifyOwnerPassword(form.get("password") ?? "", account.passwordHash)) throw new HttpError(403, "Password is incorrect");
      const subscription = await dependencies.store.getSubscription(account.tenantId);
      // Only once billing has fully ended: anything but a cancelled subscription may still charge.
      if (subscription?.providerSubscriptionId && subscription.status !== "canceled") {
        throw new HttpError(409, "Cancel your subscription in Billing first. You can delete your account once it has ended.");
      }
      await pauseLiveRoute(account.tenantId)
        .catch(() => { throw new HttpError(502, "We couldn't disconnect your Front Office line. Nothing was deleted; please retry."); });
      await releaseProvisionedLine(account.tenantId);
      await deletionService.deleteWorkspace(account.tenantId)
        .catch(() => { throw new HttpError(502, "A call recording couldn't be deleted. Nothing else was removed; please retry."); });
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
        scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
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
      if (!recordingClient) throw new HttpError(503, "Telnyx recordings are not configured");
      let providerCallId: string;
      try {
        providerCallId = decodeURIComponent(recordingMatch[1]);
      } catch {
        throw new HttpError(400, "Invalid recording identifier");
      }
      const call = await dependencies.store.getCallByProviderId(providerCallId);
      if (!call || call.tenantId !== account.tenantId) throw new HttpError(404, "Recording not found");
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
      return sendHtml(response, 200, renderOwnerCallRecord({ account, config, call, booking, callbackTask, notifications, recordingUrl, csrf: session.csrf, canDelete: !member }));
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
      if (isPaidStatus(subscription?.status)) return app;
      if (subscription?.providerCustomerId && (subscription.status === "past_due" || subscription.status === "unpaid")) {
        // Fix payment on the existing subscription instead of starting a second one.
        return stripeClient.createPortal(subscription.providerCustomerId, `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app`)
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
      // The open session is reused only for the same plan and add-ons.
      const addOns = `${plan.id}${unlimited ? "+unlimited" : ""}:${config.ownerDailySmsEnabled ? 1 : 0}${config.ownerRealtimeSmsEnabled ? 1 : 0}`;
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
        dailySms: config.ownerDailySmsEnabled,
        realtimeSms: config.ownerRealtimeSmsEnabled,
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
    if (isPaidStatus((await dependencies.store.getSubscription(account.tenantId))?.status)) return;
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
      if (isPaidStatus(existing?.status)) return;
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

  /**
   * The owner picks another plan in Settings. A paying shop's Stripe subscription moves first (prorated,
   * the difference invoiced now); only then is the shop saved on the new plan. Before paying it is just remembered.
   */
  async function changePlan(account: OwnerAccount, plan: Plan): Promise<void> {
    await dependencies.store.withLock(`billing:${account.tenantId}`, async () => {
      const [subscription, config] = await Promise.all([
        dependencies.store.getSubscription(account.tenantId),
        dependencies.store.getConfig(account.tenantId),
      ]);
      // Unlimited stays on across a plan change, at the new plan's add-on price (off where the plan has none).
      const unlimited = wantsUnlimited(plan, config.unlimitedCalls === true);
      if (isOnPlan(config, plan, unlimited)) return;
      const live = Boolean(subscription?.providerSubscriptionId && subscription.status !== "canceled");
      let addOnItems: UnlimitedItem[] | null = null;
      if (live) {
        if (!stripeClient) throw new HttpError(503, "Plan changes aren’t available yet");
        addOnItems = (await stripeClient.changePlan(subscription!.providerSubscriptionId!, plan.id, { unlimited }).catch((error) => {
          log({ level: "error", event: "plan_change_failed", tenantId: account.tenantId, plan: plan.id, error: safeError(error) });
          throw new HttpError(502, "Your plan couldn’t be changed just now. Nothing was changed; please try again.");
        })).addOnItems;
      }
      await dependencies.store.withLock(`config:${account.tenantId}`, async () => {
        await dependencies.store.saveConfig(onPlan(await dependencies.store.getConfig(account.tenantId), plan, unlimited));
      });
      if (live) await observeOwnChange(account.tenantId, unlimited, addOnItems);
      log({ level: "info", event: "plan_changed", tenantId: account.tenantId, from: config.planId ?? "solo", to: plan.id });
      telemetry.capture("plan_changed", account.id, account.tenantId, { from: config.planId ?? "solo", to: plan.id });
    });
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

  /**
   * The owner turns the Unlimited add-on on or off in Settings. A paying shop's Stripe subscription changes first
   * (the add-on item is added or removed, prorated, the difference invoiced now); only then is the shop saved and
   * the add-on's window recorded for the overage job. Before paying it is just remembered for checkout.
   */
  async function setUnlimited(account: OwnerAccount, on: boolean): Promise<void> {
    await dependencies.store.withLock(`billing:${account.tenantId}`, async () => {
      const [subscription, config] = await Promise.all([
        dependencies.store.getSubscription(account.tenantId),
        dependencies.store.getConfig(account.tenantId),
      ]);
      const plan = currentPlan(known, config.planId);
      if (on && !plan.unlimited) throw new HttpError(409, plan.sold ? "Unlimited calls aren’t available on this plan yet." : `Unlimited calls aren’t available on ${plan.label}. Switch to Solo, Team or Fleet to add it.`);
      if ((config.unlimitedCalls === true) === on) return;
      const live = Boolean(subscription?.providerSubscriptionId && subscription.status !== "canceled");
      let addOnItems: UnlimitedItem[] | null = null;
      if (live) {
        if (!stripeClient) throw new HttpError(503, "Plan changes aren’t available yet");
        addOnItems = (await stripeClient.changePlan(subscription!.providerSubscriptionId!, plan.id, { unlimited: on }).catch((error) => {
          log({ level: "error", event: "unlimited_change_failed", tenantId: account.tenantId, on, error: safeError(error) });
          throw new HttpError(502, "Unlimited calls couldn’t be changed just now. Nothing was changed; please try again.");
        })).addOnItems;
      }
      await dependencies.store.withLock(`config:${account.tenantId}`, async () => {
        await dependencies.store.saveConfig({ ...await dependencies.store.getConfig(account.tenantId), unlimitedCalls: on });
      });
      if (live) await observeOwnChange(account.tenantId, on, addOnItems);
      log({ level: "info", event: "unlimited_changed", tenantId: account.tenantId, on });
      telemetry.capture("unlimited_changed", account.id, account.tenantId, { on, plan: plan.id });
    });
  }

  /** Turn the line on with no button, and say calmly what happens next if it can't be yet. */
  async function activateLine(account: OwnerAccount): Promise<{ status: "live" | "waiting" | "blocked" | "failed"; message: string | null }> {
    const lineNumber = await dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number");
    if (account.status === "active" && lineNumber) return { status: "live", message: null };
    if (!isPaidStatus((await dependencies.store.getSubscription(account.tenantId))?.status)) {
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
        return { status: "waiting", message: "Your Front Office number is on its way. Phone carriers approve new business lines, which usually takes 1 to 3 business days. Everything else is saved, so keep going. We’ll turn it on the moment it clears." };
      }
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
      !dependencies.env.TELNYX_MESSAGING_APPROVED && "approved owner-alert messaging",
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
          throw new HttpError(502, "We couldn't set up your Front Office number just now. Try again in a minute.");
        }
      }

      const existingRoute = await dependencies.store.getProviderRoute("telnyx", assistantId);
      if (existingRoute && existingRoute.tenantId !== account.tenantId) throw new HttpError(409, "That Telnyx assistant is already assigned to another tenant");
      const liveRoute = voiceRouting(inboundNumber, assistantId);
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
          .catch(() => { throw new HttpError(502, "Telnyx could not verify and connect that assistant and phone number"); });
        await dependencies.store.saveConfig({ ...config, paused: false });
        await dependencies.store.updateOwnerAccountStatus(account.id, "active", now);
      } catch (error) {
        await liveRoute.setPaused(true).catch((rollbackError) => log({ level: "error", event: "owner_activation_rollback_failed", tenantId: account.tenantId, error: safeError(rollbackError) }));
        throw error;
      }
      return inboundNumber;
    })));
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
    const [businessNumber, carrierJson, confirmedAt, checkJson, helpRequestedAt] = await Promise.all([
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "business_number"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "carrier"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "confirmed_at"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "check"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "help_requested_at"),
    ]);
    const parse = <T>(value: string | null): T | null => { try { return value ? JSON.parse(value) as T : null; } catch { return null; } };
    const check = parse<{ startedAt: string; method: "auto" | "manual" }>(checkJson);
    return { businessNumber, carrier: parse<CarrierInfo>(carrierJson), confirmedAt, check: check ? { startedAt: check.startedAt, method: check.method } : null, helpRequestedAt };
  }

  /**
   * Every inbound call proves the forwarded line reaches us. A call from our check number (or
   * the owner's own business number, which some carriers show) during an open check is the
   * check itself: confirm it, hang up our side, and skip the call record.
   */
  async function noteForwardedCall(tenantId: string, callerPhone: string, callControlId: string): Promise<"check" | "customer"> {
    const now = dependencies.clock.now();
    const [checkJson, businessNumber] = await Promise.all([
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "check"),
      dependencies.store.getIntegrationSecret(tenantId, "forwarding", "business_number"),
    ]);
    let check: { startedAt: string; method?: "auto" | "manual"; callControlId?: string | null } | null = null;
    try { check = checkJson ? JSON.parse(checkJson) : null; } catch { check = null; }
    const open = check && now.getTime() - Date.parse(check.startedAt) < FORWARDING_CHECK_WINDOW_MS;
    // Some carriers show the forwarding phone's own number; trust that only for our automatic check call.
    const fromCheck = callerPhone === dependencies.env.TELNYX_FROM_NUMBER || (check?.method === "auto" && businessNumber !== null && callerPhone === businessNumber);
    await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "confirmed_at", now.toISOString());
    if (!open || !fromCheck) return "customer";
    await dependencies.store.saveIntegrationSecret(tenantId, "forwarding", "check_inbound_call", callControlId);
    if (check?.callControlId && dependencies.env.TELNYX_API_KEY) {
      await new TelnyxForwardingClient({ apiKey: dependencies.env.TELNYX_API_KEY, ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}) })
        .hangUp(check.callControlId).catch((error) => log({ level: "warn", event: "forwarding_check_hangup_failed", tenantId, error: safeError(error) }));
    }
    log({ level: "info", event: "forwarding_check_passed", tenantId });
    return "check";
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
          ? `Front Office is paused: your subscription is ${statusWords}. For the next ${GRACE_DAYS} days calls forwarded to your Front Office line go to voicemail and we text you each message; after that the number stops working. Update billing in your dashboard, or ${lowerFirst(offCode)}`
          : `Front Office is paused: your subscription is ${statusWords}. Calls forwarded to your Front Office line will not be answered. Update billing in your dashboard, or ${lowerFirst(offCode)}`,
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
        body: "Front Office is back on: your payment went through and calls forwarded to your Front Office line are being answered again.",
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
      if (await noteForwardedCall(tenantId, callerPhone, initialization.data.payload.call_control_id) === "check") {
        // Our own forwarding check reached the shop: confirm it and end the call without a call record.
        return sendJson(response, 200, {
          dynamic_variables: { tenant_id: config.tenantId, business_name: config.businessName, call_direction: "inbound", opening_greeting: "Forwarding check complete. Goodbye.", caller_phone: callerPhone, call_access: "forwarding_check", owner_transfer_targets: [] },
          conversation: { metadata: { tenant_id: config.tenantId } },
        });
      }
      const recentCalls = /^\+1[2-9]\d{9}$/.test(callerPhone)
        ? await dependencies.store.countCallsFromNumberSince(config.tenantId, callerPhone, new Date(dependencies.clock.now().getTime() - 24 * 60 * 60_000).toISOString())
        : 0;
      const callAccess = recentCalls >= config.maxCallsPerCallerPerDay ? "blocked_daily_limit" : "allowed";
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
    const input = intakeSchema.parse(toolPayload(tool));
    requireToolCallId(tool, input.provider_call_id);
    const tenantId = await tenantForCall(input.provider_call_id);
    await requireOperational(tenantId);
    const result = await service.saveIntake({
      tenantId,
      providerCallId: input.provider_call_id,
      fromNumber: input.from_number,
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
    const input = availabilitySchema.parse(toolPayload(tool));
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
    const input = serviceAreaSchema.parse(toolPayload(tool));
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
    const input = triageSchema.parse(toolPayload(tool));
    requireToolCallId(tool, input.provider_call_id);
    const tenantId = await tenantForCall(input.provider_call_id);
    await requireOperational(tenantId);
    const result = await service.triageCall({
      tenantId,
      providerCallId: input.provider_call_id,
      fromNumber: input.from_number,
      problemDescription: input.problem_description,
      ...(input.caller_name === undefined ? {} : { callerName: input.caller_name }),
      ...(input.llm_score === undefined ? {} : { llmScore: input.llm_score }),
      ...(input.llm_reason === undefined ? {} : { llmReason: input.llm_reason }),
    });
    return { ...result, wrap_up: await service.wrapUp(input.provider_call_id) };
  }

  async function handleBooking(tool: ToolRequest): Promise<unknown> {
    const input = bookingSchema.parse(toolPayload(tool));
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
    const input = handoffSchema.parse(toolPayload(tool));
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
      fromNumber: input.from_number,
      ...(input.caller_name === undefined ? {} : { callerName: input.caller_name }),
      ...(input.problem_description === undefined ? {} : { problemDescription: input.problem_description }),
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
        scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
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
        dailySmsAvailable: Boolean(dependencies.env.STRIPE_DAILY_SMS_PRICE_ID),
        realtimeSmsAvailable: Boolean(dependencies.env.STRIPE_REALTIME_SMS_PRICE_ID),
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
    const suffix = await graceStartedAt(dependencies.store, tenantId) ? ` Your Front Office plan is paused; ${lowerFirst(off)}` : "";
    const fallbackBase = `voicemail-fallback:${tenantId}:${callSid}`;
    // One gate per call: whichever callback arrives first decides whether a no-transcript fallback may exist.
    const firstForCall = await dependencies.store.claimWebhook(fallbackBase);

    if (recordingCallback) {
      const status = form.get("RecordingStatus");
      if (!firstForCall || (status && status !== "completed")) return sendJson(response, 200, { received: true });
      // Goes out only if the transcript has not arrived (and cancelled it) within a few minutes.
      await queueOwnerMessage(graceContext, {
        tenantId,
        sms: `Front Office voicemail for ${config.businessName}: ${caller} left you a message we couldn't transcribe. Call them back.${suffix}`,
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
      sms: `Front Office voicemail for ${config.businessName}: ${said}${suffix}`,
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
    if (dependencies.env.PROVIDER_TEST_MODE) return;
    if (tenantId !== dependencies.env.DEFAULT_TENANT_ID) {
      if (!dependencies.env.TELNYX_MESSAGING_APPROVED || !dependencies.env.LIVE_PROVIDER_PROOF_AT) throw new HttpError(503, "Commercial provider prerequisites are not satisfied");
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

function toolForPath(pathname: string): VoiceToolName | null {
  return pathname.startsWith("/tools/") ? TOOL_ROUTES[pathname.slice(7)] ?? null : null;
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
    ...(env.STRIPE_DAILY_SMS_PRICE_ID ? { dailySms: env.STRIPE_DAILY_SMS_PRICE_ID } : {}),
    ...(env.STRIPE_REALTIME_SMS_PRICE_ID ? { realtimeSms: env.STRIPE_REALTIME_SMS_PRICE_ID } : {}),
  }, fetcher);
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

function serviceAreaMessage(errors: string[]): string {
  return errors.length > 0
    ? `Add a state to: ${errors.slice(0, 5).join(", ")}. Use a city and state ("Sarasota FL") or a 5-digit ZIP.`
    : "Add at least one city and state or 5-digit ZIP.";
}

function configFromForm(current: BusinessConfig, form: URLSearchParams, surface: "owner" | "platform"): BusinessConfig {
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
  if (!Number.isInteger(answerAfterRings) || answerAfterRings < 2 || answerAfterRings > 12) throw new HttpError(400, "Answer-after-rings must be between 2 and 12");
  const dataRetentionDays = Number(form.get("dataRetentionDays") ?? "0");
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
  const maxCallsPerCallerPerDay = Number(form.get("maxCallsPerCallerPerDay") ?? "0");
  if (!Number.isInteger(maxCallsPerCallerPerDay) || maxCallsPerCallerPerDay < 1 || maxCallsPerCallerPerDay > 20) throw new HttpError(400, "Caller daily limit must be 1–20 calls");
  const ownerDailySmsHour = Number(form.get("ownerDailySmsHour") ?? current.ownerDailySmsHour);
  if (!Number.isInteger(ownerDailySmsHour) || ownerDailySmsHour < 0 || ownerDailySmsHour > 23) throw new HttpError(400, "Daily summary hour must be 0–23");
  // Forms that don't show the minutes alert (the platform admin page) keep the saved value.
  const usageAlertPercent = form.has("usageAlertPercent") ? Number(form.get("usageAlertPercent")) : current.usageAlertPercent;
  if (!isValidUsageAlertPercent(usageAlertPercent)) throw new HttpError(400, `Minutes alert must be between ${MIN_USAGE_ALERT_PERCENT}% and ${MAX_USAGE_ALERT_PERCENT}%`);
  const holidayDates = list("holidayDates");
  if (holidayDates.some((value) => !isIsoDate(value))) throw new HttpError(400, "Holiday dates must use valid YYYY-MM-DD values");
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
    emergencyKeywords: list("emergencyKeywords"),
    emergencyThreshold,
    minimumLeadTimeMinutes,
    maxCallsPerCallerPerDay,
    defaultServiceDurationMinutes,
    serviceCategories: list("serviceCategories"),
    priceSnippets: parseLines(form.get("priceSnippets") ?? "", 50).map((line) => {
      const [label, ...rest] = line.split(":");
      return { label: label!.trim().slice(0, 120), text: rest.join(":").trim().slice(0, 1_000) };
    }).filter((item) => item.label && item.text),
    approvedKnowledge: parseLines(form.get("approvedKnowledge") ?? "", 50).map((line) => {
      const [topic, ...rest] = line.split(":");
      return { topic: topic!.trim().slice(0, 120), text: rest.join(":").trim().slice(0, 1_000) };
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
  const payload = await response.json().catch(() => ({})) as { refresh_token?: string };
  if (!response.ok || !payload.refresh_token) throw new HttpError(502, "Google did not return a refresh token; reconnect with consent enabled");
  return payload.refresh_token;
}

function areaCode(phone: string | null): string | null {
  const match = /^\+1([2-9]\d{2})\d{7}$/.exec(phone ?? "");
  return match?.[1] ?? null;
}

/** "Sarasota FL" or "Sarasota, FL" → "FL"; ZIP-only areas give no state. */
function serviceAreaState(terms: string[]): string | null {
  for (const term of terms) {
    const match = /(?:^|[\s,])([A-Z]{2})$/.exec(term.trim());
    if (match) return match[1]!;
  }
  return null;
}
