import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { z } from "zod";
import { renderCallDetail, renderConfig, renderDashboard, renderLanding, renderLogin, renderOwnerAccounts, renderOwnerDashboard, renderOwnerLogin, renderOwnerSignup, renderPilotSignups, renderPrivacy, renderPrompt, renderReadiness, renderSimulator, renderStart, renderStartReceived, renderTerms } from "../admin/render.js";
import { buildActivationReport, type ActivationReport } from "../application/readiness.js";
import { runAllSimulations, runSimulation, SIMULATION_SCENARIOS, type SimulationScenarioId } from "../application/simulator.js";
import { CallService } from "../application/call-service.js";
import { DataDeletionService } from "../application/data-deletion.js";
import { redactError, withTimeout } from "../application/retry.js";
import type { Environment } from "../config/environment.js";
import { createDemoConfig } from "../domain/config.js";
import type { BusinessConfig, CallbackTask, CallRecord, OwnerAccount, PilotSignup, SubscriptionRecord, UsageSummary } from "../domain/models.js";
import { clearOwnerSessionCookie, hashOwnerPassword, mintOwnerSession, ownerSessionCookie, verifyOwnerCsrf, verifyOwnerPassword, verifyOwnerSession } from "../security/owner-auth.js";
import { buildTelnyxGreeting } from "../voice/system-prompt.js";
import type { CalendarPort, Clock, Store } from "../ports.js";
import {
  asTelnyxConversationEnded,
  asTelnyxInitialization,
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
import { StripeBillingClient, subscriptionFromStripeEvent, verifyStripeWebhook } from "../adapters/stripe.js";
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
  displayName: z.string().trim().min(2).max(120),
  businessName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(200),
  phone: z.string().trim().min(7).max(30),
  timezone: z.string().trim().min(3).max(100),
  serviceAreaTerms: z.string().trim().min(2).max(800),
  operationMode: z.enum(["after_hours", "overflow", "always"]),
  greeting: z.string().trim().min(5).max(500),
  weekdayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  weekdayEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  bookableWeekdayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  bookableWeekdayEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  serviceCategories: z.string().trim().min(2).max(800),
  emergencyKeywords: z.string().trim().min(2).max(800),
  weekends: z.string().optional(),
  ownerSmsConsent: z.literal("yes"),
  founderSmsConsent: z.literal("yes").optional(),
  consent: z.literal("yes"),
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
    serviceAreaTerms: ["Sarasota FL", "342"],
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
    usage: { periodStart, periodEnd, billableCalls: 22, excludedSpamCalls: 5, billedMinutes: 87 },
    subscription: {
      tenantId, providerCustomerId: null, providerSubscriptionId: null, status: "active",
      currentPeriodEnd: periodEnd, providerEventCreatedAt: stamp(43_200), createdAt: stamp(43_200), updatedAt: stamp(43_200),
    },
  };
}

function ownerDashboardView(value: string | null): "today" | "pipeline" | "calendar" {
  return value === "pipeline" || value === "calendar" ? value : "today";
}

export function createRequestHandler(dependencies: AppDependencies): RequestListener {
  const service = new CallService(dependencies.store, dependencies.calendar, dependencies.clock, dependencies.env.PUBLIC_BASE_URL);
  const recordingClient = dependencies.env.TELNYX_API_KEY ? new TelnyxRecordingClient(dependencies.env.TELNYX_API_KEY) : null;
  const routingClient = dependencies.env.TELNYX_API_KEY && dependencies.env.TELNYX_FROM_NUMBER && dependencies.env.TELNYX_ASSISTANT_ID
    ? new TelnyxVoiceRoutingClient({ apiKey: dependencies.env.TELNYX_API_KEY, phoneNumber: dependencies.env.TELNYX_FROM_NUMBER, assistantId: dependencies.env.TELNYX_ASSISTANT_ID })
    : null;
  const stripeClient = dependencies.env.STRIPE_SECRET_KEY && dependencies.env.STRIPE_PRICE_ID
    ? new StripeBillingClient(dependencies.env.STRIPE_SECRET_KEY, {
        base: dependencies.env.STRIPE_PRICE_ID,
        ...(dependencies.env.STRIPE_DAILY_SMS_PRICE_ID ? { dailySms: dependencies.env.STRIPE_DAILY_SMS_PRICE_ID } : {}),
        ...(dependencies.env.STRIPE_REALTIME_SMS_PRICE_ID ? { realtimeSms: dependencies.env.STRIPE_REALTIME_SMS_PRICE_ID } : {}),
      })
    : null;
  const deletionService = new DataDeletionService(dependencies.store, dependencies.calendar, recordingClient);
  const dummyOwnerPasswordHash = hashOwnerPassword(`unregistered:${randomUUID()}`);
  const limiter = new RateLimiter();
  const log = dependencies.logger ?? ((entry) => console.log(JSON.stringify(entry)));

  return (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const requestId = response.getHeader("x-request-id") ?? request.headers["x-request-id"] ?? "unassigned";
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
      const message = error instanceof HttpError || error instanceof z.ZodError ? error.message : "Internal server error";
      log({ level: status >= 500 ? "error" : "warn", event: "request_failed", requestId, status, error: safeError(error) });
      if (!response.headersSent) sendJson(response, status, { error: message, request_id: requestId });
      else response.end();
    });
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setSecurityHeaders(response);
    const requestId = typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : randomUUID();
    response.setHeader("x-request-id", requestId);
    const started = Date.now();
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    const route = routeKey(url.pathname);
    const ip = requestIp(request);
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
      return sendHtml(response, 200, renderLanding(config));
    }
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
    if (method === "GET" && url.pathname === "/signup") return sendHtml(response, 200, renderOwnerSignup());
    if (method === "POST" && url.pathname === "/signup") {
      if (!limiter.allow(`${ip}:owner-signup`, 5, 60 * 60_000)) throw new HttpError(429, "Too many signup attempts from this connection");
      const form = parseForm(await readBody(request, 48_000));
      if (form.get("faxNumber")?.trim()) return sendHtml(response, 200, renderOwnerSignup());
      const values = Object.fromEntries(form.entries());
      const parsed = ownerSignupSchema.safeParse(values);
      if (!parsed.success) return sendHtml(response, 400, renderOwnerSignup("Check every required field and use a password with at least 12 characters.", values));
      const phone = normalizeUsPhone(parsed.data.phone);
      if (!phone) return sendHtml(response, 400, renderOwnerSignup("Enter a valid US mobile number.", values));
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.timezone }).format();
      } catch {
        return sendHtml(response, 400, renderOwnerSignup("Choose a valid timezone.", values));
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
      const config: BusinessConfig = {
        ...createDemoConfig(tenantId),
        paused: true,
        businessName: parsed.data.businessName,
        greeting: parsed.data.greeting,
        timezone: parsed.data.timezone,
        serviceAreaTerms: splitList(parsed.data.serviceAreaTerms),
        emergencyKeywords: splitList(parsed.data.emergencyKeywords),
        serviceCategories: splitList(parsed.data.serviceCategories),
        operationMode: parsed.data.operationMode,
        ownerNotificationRefs: ["owner-primary"],
        ownerTransferNumberRef: "owner-primary",
        supportEmail: parsed.data.email,
        afterHours: {
          weekdayStart: parsed.data.weekdayStart,
          weekdayEnd: parsed.data.weekdayEnd,
          weekends: parsed.data.weekends === "on",
          holidayDates: [],
        },
        bookableHours: {
          weekdayStart: parsed.data.bookableWeekdayStart,
          weekdayEnd: parsed.data.bookableWeekdayEnd,
          weekends: parsed.data.weekends === "on",
        },
      };
      const created = await dependencies.store.createOwnerWorkspace({ account, config, ownerPhone: phone });
      if (!created) return sendHtml(response, 409, renderOwnerSignup("That email already has an account. Sign in instead.", values));
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
      const session = mintOwnerSession(account, dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
      response.setHeader("set-cookie", ownerSessionCookie(session, dependencies.env.NODE_ENV === "production"));
      log({ level: "info", event: "owner_workspace_created", accountId: account.id, tenantId });
      return redirect(response, "/app");
    }
    if (method === "GET" && url.pathname === "/login") return sendHtml(response, 200, renderOwnerLogin());
    if (method === "POST" && url.pathname === "/login") {
      if (!limiter.allow(`${ip}:owner-login`, 10, 15 * 60_000)) throw new HttpError(429, "Too many sign-in attempts");
      const parsed = ownerLoginSchema.safeParse(Object.fromEntries(parseForm(await readBody(request, 16_000)).entries()));
      if (!parsed.success) return sendHtml(response, 400, renderOwnerLogin("Enter a valid email and password."));
      const account = await dependencies.store.getOwnerAccountByEmail(parsed.data.email);
      const valid = await verifyOwnerPassword(parsed.data.password, account?.passwordHash ?? await dummyOwnerPasswordHash);
      if (!account || !valid || account.status === "suspended") return sendHtml(response, 401, renderOwnerLogin("Email or password is incorrect."));
      const session = mintOwnerSession(account, dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
      response.setHeader("set-cookie", ownerSessionCookie(session, dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/app");
    }
    if (method === "GET" && url.pathname === "/logout") {
      response.setHeader("set-cookie", clearOwnerSessionCookie(dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/");
    }
    if (url.pathname.startsWith("/app")) return handleOwner(request, response, url);
    if (method === "GET" && url.pathname === "/start") return sendHtml(response, 200, renderStart());
    if (method === "POST" && url.pathname === "/start") {
      if (!limiter.allow(`${ip}:pilot-signup`, 5, 60 * 60_000)) throw new HttpError(429, "Too many applications from this connection");
      const form = parseForm(await readBody(request, 32_000));
      if (form.get("faxNumber")?.trim()) return sendHtml(response, 200, renderStartReceived(null));
      const values = Object.fromEntries(form.entries());
      const parsed = pilotSignupSchema.safeParse(values);
      if (!parsed.success) return sendHtml(response, 400, renderStart("Check the required fields and try again.", values));
      const phone = normalizeUsPhone(parsed.data.phone);
      if (!phone) return sendHtml(response, 400, renderStart("Enter a valid US mobile number.", values));
      const website = normalizeOptionalUrl(parsed.data.website);
      if (parsed.data.website && !website) return sendHtml(response, 400, renderStart("Enter a complete website address beginning with https://", values));
      const missedCallsPerWeek = parseOptionalCount(parsed.data.missedCallsPerWeek);
      if (missedCallsPerWeek === undefined) return sendHtml(response, 400, renderStart("Missed calls must be a whole number from 0 to 500.", values));
      const now = dependencies.clock.now().toISOString();
      const signup: PilotSignup = {
        id: randomUUID(),
        ownerName: parsed.data.ownerName,
        businessName: parsed.data.businessName,
        email: parsed.data.email,
        phone,
        website,
        trade: parsed.data.trade,
        serviceArea: parsed.data.serviceArea,
        desiredMode: parsed.data.desiredMode,
        missedCallsPerWeek,
        calendarProvider: parsed.data.calendarProvider,
        notes: parsed.data.notes || null,
        status: "new",
        source: "website",
        consentedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await dependencies.store.savePilotSignup(signup);
      log({ level: "info", event: "pilot_signup_received", signupId: signup.id, trade: signup.trade });
      return sendHtml(response, 200, renderStartReceived(dependencies.env.FOUNDING_CHECKOUT_URL ?? null));
    }
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
      return sendHtml(response, 200, renderTerms(await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID)));
    }
    if (method === "POST" && url.pathname === "/webhooks/telnyx") return handleTelnyx(request, response);
    if (method === "POST" && url.pathname === "/webhooks/stripe") return handleStripe(request, response);
    if (method === "POST" && url.pathname === "/tools/save-intake") return handleIntake(request, response);
    if (method === "POST" && url.pathname === "/tools/check-service-area") return handleServiceArea(request, response);
    if (method === "POST" && url.pathname === "/tools/check-availability") return handleAvailability(request, response);
    if (method === "POST" && url.pathname === "/tools/triage") return handleTriage(request, response);
    if (method === "POST" && url.pathname === "/tools/book") return handleBooking(request, response);
    if (method === "POST" && url.pathname === "/tools/request-human") return handleHandoff(request, response);
    if (url.pathname.startsWith("/admin")) return handleAdmin(request, response, url);
    throw new HttpError(404, "Not found");
  }

  async function handleOwner(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const sessionValue = readCookie(request, "afo_owner");
    const session = verifyOwnerSession(sessionValue, dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
    if (!session) return redirect(response, "/login");
    const account = await dependencies.store.getOwnerAccountById(session.accountId);
    if (!account || account.tenantId !== session.tenantId || account.status === "suspended") {
      response.setHeader("set-cookie", clearOwnerSessionCookie(dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/login");
    }
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/app") {
      const [config, calls, tasks, usage, googleConnected, subscription] = await Promise.all([
        dependencies.store.getConfig(account.tenantId),
        dependencies.store.listCalls(account.tenantId, 50),
        dependencies.store.listCallbackTasks(account.tenantId, 100),
        dependencies.store.getUsageSummary(account.tenantId, ...currentBillingPeriod(dependencies.clock.now())),
        isGoogleConnected(dependencies.env, dependencies.store, account.tenantId),
        dependencies.store.getSubscription(account.tenantId),
      ]);
      return sendHtml(response, 200, renderOwnerDashboard({
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
    if (method === "POST" && url.pathname === "/app/billing/checkout") {
      const form = parseForm(await readBody(request, 8_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      const subscription = await dependencies.store.getSubscription(account.tenantId);
      if (subscription?.status === "active" || subscription?.status === "trialing") return redirect(response, "/app");
      if (stripeClient) {
        const config = await dependencies.store.getConfig(account.tenantId);
        const base = dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "");
        const checkoutUrl = await stripeClient.createCheckout({
          tenantId: account.tenantId,
          email: account.email,
          successUrl: `${base}/app?checkout=success`,
          cancelUrl: `${base}/app?checkout=cancelled`,
          idempotencyKey: `checkout:${account.tenantId}:${randomUUID()}`,
          dailySms: config.ownerDailySmsEnabled,
          realtimeSms: config.ownerRealtimeSmsEnabled,
        });
        return redirect(response, checkoutUrl);
      }
      if (dependencies.env.FOUNDING_CHECKOUT_URL) return redirect(response, dependencies.env.FOUNDING_CHECKOUT_URL);
      throw new HttpError(503, "Checkout is not configured yet");
    }
    if (method === "GET" && (url.pathname === "/app/settings" || url.pathname === "/app/config")) {
      const [config, googleConnected, ownerPhone] = await Promise.all([
        dependencies.store.getConfig(account.tenantId),
        isGoogleConnected(dependencies.env, dependencies.store, account.tenantId),
        dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
      ]);
      return sendHtml(response, 200, renderConfig(config, session.csrf, {
        googleAvailable: Boolean(dependencies.env.GOOGLE_CLIENT_ID && dependencies.env.GOOGLE_CLIENT_SECRET),
        googleConnected,
        ownerPhoneConfigured: Boolean(ownerPhone),
        weeklyEmailAvailable: Boolean(dependencies.env.RESEND_API_KEY && dependencies.env.RESEND_FROM_EMAIL),
        dailySmsAvailable: Boolean(dependencies.env.STRIPE_DAILY_SMS_PRICE_ID),
        realtimeSmsAvailable: Boolean(dependencies.env.STRIPE_REALTIME_SMS_PRICE_ID),
      }, "owner"));
    }
    if (method === "POST" && url.pathname === "/app/config") {
      const form = parseForm(await readBody(request, 64_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      const current = await dependencies.store.getConfig(account.tenantId);
      const updated = configFromForm(current, form);
      updated.flatMonthlyPriceCents = current.flatMonthlyPriceCents;
      updated.includedMinutes = current.includedMinutes;
      updated.overageCentsPerMinute = current.overageCentsPerMinute;
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
        if (subscription?.status === "active" || subscription?.status === "trialing") {
          if (!stripeClient || !subscription.providerSubscriptionId) throw new HttpError(503, "Subscription add-on billing is not available yet");
          addOnSubscriptionId = subscription.providerSubscriptionId;
        }
      }
      if (account.status !== "active") updated.paused = true;
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
        liveRouteChange = new TelnyxVoiceRoutingClient({ apiKey: dependencies.env.TELNYX_API_KEY, phoneNumber: inboundNumber, assistantId: route.externalId });
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
        await dependencies.store.saveConfig(updated);
      } catch (error) {
        if (liveRouteChange) await liveRouteChange.setPaused(current.paused).catch((rollbackError) => log({ level: "error", event: "owner_route_rollback_failed", tenantId: account.tenantId, error: safeError(rollbackError) }));
        if (addOnSubscriptionId) await stripeClient!.syncAddOns(addOnSubscriptionId, {
          dailySms: current.ownerDailySmsEnabled,
          realtimeSms: current.ownerRealtimeSmsEnabled,
        }).catch((rollbackError) => log({ level: "error", event: "owner_addon_rollback_failed", tenantId: account.tenantId, error: safeError(rollbackError) }));
        throw error;
      }
      return redirect(response, "/app/settings");
    }
    if (method === "GET" && url.pathname === "/app/integrations/google/start") {
      if (!dependencies.env.GOOGLE_CLIENT_ID || !dependencies.env.GOOGLE_CLIENT_SECRET) throw new HttpError(503, "Google OAuth is not configured on the server");
      const cookiePath = "/app/integrations/google";
      const attempt = createGoogleOAuthAttempt(dependencies.env.SESSION_SIGNING_KEY!, dependencies.env.NODE_ENV === "production", dependencies.clock.now().getTime(), cookiePath);
      const callback = `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/integrations/google/callback`;
      const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorization.search = new URLSearchParams({
        client_id: dependencies.env.GOOGLE_CLIENT_ID,
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
      const verifier = verifyGoogleOAuthAttempt(url.searchParams.get("state"), readCookie(request, "afo_google_pkce"), dependencies.env.SESSION_SIGNING_KEY!, dependencies.clock.now().getTime());
      if (!verifier) throw new HttpError(400, "Google authorization state is invalid or expired");
      const code = url.searchParams.get("code");
      if (!code) throw new HttpError(400, "Google did not return an authorization code");
      const refreshToken = await exchangeGoogleCode(dependencies.env, code, verifier, "/app/integrations/google/callback");
      await dependencies.store.saveIntegrationSecret(account.tenantId, "google", "refresh_token", refreshToken);
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
      const downloadUrl = await recordingClient.getDownloadUrl(providerCallId);
      if (!downloadUrl) throw new HttpError(404, "Recording is not available yet");
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
      const task = await dependencies.store.getCallbackTaskForCall(completeTaskMatch[1]);
      if (!task || task.tenantId !== account.tenantId) throw new HttpError(404, "Task not found");
      await dependencies.store.saveCallbackTask({
        ...task,
        status: "completed",
        completedAt: dependencies.clock.now().toISOString(),
        completionSource: "owner",
        updatedAt: dependencies.clock.now().toISOString(),
      });
      return redirect(response, `/app?completed=${encodeURIComponent(task.callId)}#inbox`);
    }
    const reopenTaskMatch = /^\/app\/calls\/([0-9a-f-]+)\/task\/reopen$/i.exec(url.pathname);
    if (method === "POST" && reopenTaskMatch?.[1]) {
      const form = parseForm(await readBody(request, 8_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      const task = await dependencies.store.getCallbackTaskForCall(reopenTaskMatch[1]);
      if (!task || task.tenantId !== account.tenantId || task.status !== "completed") throw new HttpError(404, "Completed task not found");
      const now = dependencies.clock.now().toISOString();
      await dependencies.store.saveCallbackTask({
        ...task,
        status: "open",
        dueAt: now,
        completedAt: null,
        completionSource: null,
        updatedAt: now,
      });
      return redirect(response, `/app?call=${encodeURIComponent(task.callId)}#inbox`);
    }
    const snoozeTaskMatch = /^\/app\/calls\/([0-9a-f-]+)\/task\/snooze$/i.exec(url.pathname);
    if (method === "POST" && snoozeTaskMatch?.[1]) {
      const form = parseForm(await readBody(request, 8_000));
      if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
      const task = await dependencies.store.getCallbackTaskForCall(snoozeTaskMatch[1]);
      if (!task || task.tenantId !== account.tenantId || task.status === "completed" || task.status === "cancelled") throw new HttpError(404, "Task not found");
      const minutes = Number(form.get("minutes"));
      if (![60, 240, 1_440].includes(minutes)) throw new HttpError(400, "Choose a valid reminder time");
      const now = dependencies.clock.now();
      await dependencies.store.saveCallbackTask({
        ...task,
        status: "snoozed",
        dueAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
        completedAt: null,
        completionSource: null,
        updatedAt: now.toISOString(),
      });
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
      return sendHtml(response, 200, renderCallDetail({ config, call, booking, callbackTask, events, notifications, csrf: session.csrf, surface: "owner" }));
    }
    throw new HttpError(404, "Not found");
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
      const record = subscriptionFromStripeEvent(event, await dependencies.store.getSubscription(tenantId), dependencies.clock.now().toISOString());
      if (record) await dependencies.store.saveSubscription(record);
    }
    const firstReceipt = await dependencies.store.claimWebhook(`stripe:${event.id}`);
    if (!firstReceipt) return sendJson(response, 200, { received: true, duplicate: true });
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
          await service.finalize(toTelnyxTexmlCallSummary(
            rawBody,
            existing.tenantId,
            dependencies.clock.now(),
            recordingUrl,
          ));
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
          owner_transfer_targets: [],
        },
        conversation: { metadata: { tenant_id: config.tenantId } },
      });
    }
    if (envelope.data.event_type === "call.conversation.ended") {
      const ended = asTelnyxConversationEnded(envelope);
      const routedTenantId = await tenantForAssistant(ended.data.payload.assistant_id);
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
      await service.finalize(summary);
    }
    sendJson(response, 200, { received: true });
  }

  async function handleIntake(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    enforceProviderRate(request, "tool:save-intake");
    const input = intakeSchema.parse(unwrapToolPayload(parseJson<unknown>(rawBody)));
    requireMatchingCallHeader(request, input.provider_call_id);
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
      ...(input.recording_disclosure_given === undefined ? {} : { recordingDisclosureGiven: input.recording_disclosure_given }),
      ...(input.recording_disclosure_declined === undefined ? {} : { recordingDisclosureDeclined: input.recording_disclosure_declined }),
    });
    sendJson(response, 200, result);
  }

  async function handleAvailability(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    enforceProviderRate(request, "tool:check-availability");
    const input = availabilitySchema.parse(unwrapToolPayload(parseJson<unknown>(rawBody)));
    requireMatchingCallHeader(request, input.provider_call_id);
    const tenantId = await tenantForCall(input.provider_call_id);
    await requireOperational(tenantId);
    const result = await service.checkAvailability({
      tenantId,
      providerCallId: input.provider_call_id,
      windowStart: input.window_start,
      windowEnd: input.window_end,
    });
    sendJson(response, 200, result);
  }

  async function handleServiceArea(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    enforceProviderRate(request, "tool:check-service-area");
    const input = serviceAreaSchema.parse(unwrapToolPayload(parseJson<unknown>(rawBody)));
    requireMatchingCallHeader(request, input.provider_call_id);
    const tenantId = await tenantForCall(input.provider_call_id);
    await requireOperational(tenantId);
    const result = await service.checkServiceArea({
      tenantId,
      providerCallId: input.provider_call_id,
      address: input.address,
    });
    sendJson(response, 200, result);
  }

  async function handleTriage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    enforceProviderRate(request, "tool:triage");
    const input = triageSchema.parse(unwrapToolPayload(parseJson<unknown>(rawBody)));
    requireMatchingCallHeader(request, input.provider_call_id);
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
    sendJson(response, 200, result);
  }

  async function handleBooking(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    enforceProviderRate(request, "tool:book");
    const input = bookingSchema.parse(unwrapToolPayload(parseJson<unknown>(rawBody)));
    requireMatchingCallHeader(request, input.provider_call_id);
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
    });
    sendJson(response, 200, result);
  }

  async function handleHandoff(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    enforceProviderRate(request, "tool:request-human");
    const input = handoffSchema.parse(unwrapToolPayload(parseJson<unknown>(rawBody)));
    requireMatchingCallHeader(request, input.provider_call_id);
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
    sendJson(response, 200, result);
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
      if (!dependencies.env.GOOGLE_CLIENT_ID || !dependencies.env.GOOGLE_CLIENT_SECRET) throw new HttpError(503, "Google OAuth is not configured on the server");
      const verifier = verifyGoogleOAuthAttempt(url.searchParams.get("state"), readCookie(request, "afo_google_pkce"), dependencies.env.SESSION_SIGNING_KEY!);
      if (!verifier) throw new HttpError(400, "Google OAuth state is invalid or expired");
      if (url.searchParams.has("error")) throw new HttpError(400, "Google authorization was declined");
      const code = url.searchParams.get("code");
      if (!code) throw new HttpError(400, "Google did not return an authorization code");
      const refreshToken = await exchangeGoogleCode(dependencies.env, code, verifier);
      await dependencies.store.saveIntegrationSecret(dependencies.env.DEFAULT_TENANT_ID, "google", "refresh_token", refreshToken);
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
      if (!dependencies.env.GOOGLE_CLIENT_ID || !dependencies.env.GOOGLE_CLIENT_SECRET) throw new HttpError(503, "Google OAuth is not configured on the server");
      const attempt = createGoogleOAuthAttempt(dependencies.env.SESSION_SIGNING_KEY!, dependencies.env.NODE_ENV === "production");
      const callback = `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/integrations/google/callback`;
      const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorization.search = new URLSearchParams({
        client_id: dependencies.env.GOOGLE_CLIENT_ID,
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
    const ownerStatusMatch = /^\/admin\/owners\/([0-9a-f-]+)\/status$/i.exec(url.pathname);
    if (method === "POST" && ownerStatusMatch?.[1]) {
      const form = parseForm(await readBody(request, 16_000));
      if (!bearer && (!session || !verifyCsrf(session, form.get("csrf"), dependencies.env.SESSION_SIGNING_KEY!))) throw new HttpError(403, "Invalid CSRF token");
      const status = form.get("status");
      if (status !== "pending_activation" && status !== "active" && status !== "suspended") throw new HttpError(400, "Invalid owner status");
      const account = await dependencies.store.getOwnerAccountById(ownerStatusMatch[1]);
      if (!account) throw new HttpError(404, "Owner account not found");
      const config = await dependencies.store.getConfig(account.tenantId);
      if (status === "active") {
        const assistantId = form.get("assistantId")?.trim();
        const inboundNumber = form.get("inboundNumber")?.trim();
        if (!assistantId) throw new HttpError(400, "An existing Telnyx assistant ID is required for activation");
        if (!inboundNumber || !/^\+[1-9]\d{7,14}$/.test(inboundNumber)) throw new HttpError(400, "A dedicated Telnyx number in E.164 format is required for activation");
        const providerBlockers = [
          !dependencies.env.TELNYX_API_KEY && "Telnyx API key",
          !dependencies.env.TELNYX_PUBLIC_KEY && "Telnyx webhook verification",
          !dependencies.env.TELNYX_FROM_NUMBER && "Telnyx SMS sender",
          !dependencies.env.TELNYX_MESSAGING_PROFILE_ID && "Telnyx messaging profile",
          !dependencies.env.TELNYX_MESSAGING_APPROVED && "approved owner-alert messaging",
          !dependencies.env.RECORDING_CONSENT_APPROVED && "recording-consent approval",
          !dependencies.env.LIVE_PROVIDER_PROOF_AT && "recorded live-provider proof",
          dependencies.env.PROVIDER_TEST_MODE && "provider test mode must be disabled",
        ].filter(Boolean) as string[];
        if (providerBlockers.length > 0) throw new HttpError(409, `Live provider prerequisites are missing: ${providerBlockers.join(", ")}`);
        const [ownerPhone, googleConnected, subscription] = await Promise.all([
          dependencies.store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary"),
          isGoogleConnected(dependencies.env, dependencies.store, account.tenantId),
          dependencies.store.getSubscription(account.tenantId),
        ]);
        if (!ownerPhone || !googleConnected || config.serviceAreaTerms.length === 0) throw new HttpError(409, "Owner phone, Google Calendar, and service area must be configured before activation");
        if (stripeClient && subscription?.status !== "active" && subscription?.status !== "trialing") throw new HttpError(409, "An active subscription is required before activation");
        const existingRoute = await dependencies.store.getProviderRoute("telnyx", assistantId);
        if (existingRoute && existingRoute.tenantId !== account.tenantId) throw new HttpError(409, "That Telnyx assistant is already assigned to another tenant");
        const liveRoute = new TelnyxVoiceRoutingClient({ apiKey: dependencies.env.TELNYX_API_KEY!, phoneNumber: inboundNumber, assistantId });
        await liveRoute.setPaused(false)
          .catch(() => { throw new HttpError(502, "Telnyx could not verify and connect that assistant and phone number"); });
        const now = dependencies.clock.now().toISOString();
        try {
          await dependencies.store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", inboundNumber);
          await dependencies.store.saveProviderRoute({ provider: "telnyx", externalId: assistantId, tenantId: account.tenantId, createdAt: existingRoute?.createdAt ?? now, updatedAt: now });
          await dependencies.store.saveConfig({ ...config, paused: false });
          await dependencies.store.updateOwnerAccountStatus(account.id, status, now);
        } catch (error) {
          await liveRoute.setPaused(true).catch((rollbackError) => log({ level: "error", event: "owner_activation_rollback_failed", tenantId: account.tenantId, error: safeError(rollbackError) }));
          throw error;
        }
      } else {
        const [route, inboundNumber] = await Promise.all([
          dependencies.store.getProviderRouteForTenant("telnyx", account.tenantId),
          dependencies.store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number"),
        ]);
        if (route && inboundNumber && dependencies.env.TELNYX_API_KEY) {
          await new TelnyxVoiceRoutingClient({ apiKey: dependencies.env.TELNYX_API_KEY, phoneNumber: inboundNumber, assistantId: route.externalId })
            .setPaused(true)
            .catch(() => { throw new HttpError(502, "Telnyx could not disconnect the live phone route; account status was not changed"); });
        }
        await dependencies.store.saveConfig({ ...config, paused: true });
        await dependencies.store.updateOwnerAccountStatus(account.id, status, dependencies.clock.now().toISOString());
      }
      return redirect(response, "/admin/owners");
    }
    if (method === "GET" && url.pathname === "/admin/config") {
      const [config, googleConnected, ownerPhone] = await Promise.all([
        dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID),
        isGoogleConnected(dependencies.env, dependencies.store),
        dependencies.store.getIntegrationSecret(dependencies.env.DEFAULT_TENANT_ID, "notifications", "owner-primary"),
      ]);
      return sendHtml(response, 200, renderConfig(config, csrf, {
        googleAvailable: Boolean(dependencies.env.GOOGLE_CLIENT_ID && dependencies.env.GOOGLE_CLIENT_SECRET),
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
      const current = await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID);
      const updated = configFromForm(current, form);
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
      await dependencies.store.saveConfig(updated);
      return redirect(response, "/admin/config");
    }
    if (method === "GET" && url.pathname === "/admin/prompt") {
      const config = await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID);
      return sendHtml(response, 200, renderPrompt(config, dependencies.env.PUBLIC_BASE_URL));
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

  function requireMatchingCallHeader(request: IncomingMessage, providerCallId: string): void {
    if (dependencies.env.DEMO_MODE && bearerMatches(request, dependencies.env.TOOL_TOKEN)) return;
    const headerCallId = singleHeader(request.headers["x-telnyx-call-control-id"]);
    if (!headerCallId || headerCallId !== providerCallId) throw new HttpError(401, "Telnyx call identifier does not match the signed tool payload");
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
    if (tenantId !== dependencies.env.DEFAULT_TENANT_ID) return;
    const report = await getActivationReport();
    if (!report.go) throw new HttpError(503, "Commercial activation gate is not satisfied");
  }
}

function unwrapToolPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const nested = record.args ?? record.arguments;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return value;
  const { args: _args, arguments: _arguments, ...outer } = record;
  return { ...(nested as Record<string, unknown>), ...outer };
}

function isExplicitHumanRequest(callerQuote: string): boolean {
  const quote = callerQuote.toLowerCase().replace(/\s+/g, " ").trim();
  const person = "(?:human|person|owner|representative|operator|technician|someone|somebody)";
  if (new RegExp(`\\b(?:do not|don't|dont|never|no need to|not trying to|not asking to|do not want to|don't want to)\\b.{0,40}\\b${person}\\b`).test(quote)) return false;
  return [
    new RegExp(`\\b(?:i|we)\\s+(?:want|need|would like|have to)\\s+(?:to\\s+)?(?:speak|talk|connect|transfer|reach|get|call|be connected)?\\s*(?:with|to)?\\s*(?:a|the|your)?\\s*${person}\\b`),
    new RegExp(`\\b(?:can|could|would|will)\\s+(?:i|you)\\s+(?:please\\s+)?(?:speak|talk|connect|transfer|put|get|reach)\\b.{0,30}\\b${person}\\b`),
    new RegExp(`\\b(?:connect|transfer|put|get)\\s+me\\b.{0,30}\\b${person}\\b`),
    new RegExp(`\\b(?:let me|please)\\s+(?:speak|talk)\\b.{0,30}\\b${person}\\b`),
    /\b(?:have|ask)\s+(?:the\s+)?(?:owner|technician|someone|somebody)\s+(?:to\s+)?call\s+me(?:\s+back)?\b/,
    /\b(?:human|person|representative|operator)\s*(?:please|now)?[.!?]*$/,
  ].some((pattern) => pattern.test(quote));
}

function formatLocalCallContext(now: Date, timeZone: string): { date: string; time: string } {
  return {
    date: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(now),
    time: new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(now),
  };
}

function routeKey(pathname: string): string {
  if (pathname === "/webhooks/telnyx") return "webhook:telnyx";
  if (pathname.startsWith("/tools/")) return `tool:${pathname.slice(7)}`;
  if (pathname.startsWith("/admin/calls/")) return "admin:call";
  if (pathname.startsWith("/app/calls/")) return "owner:call";
  if (pathname.startsWith("/app")) return "owner:app";
  return pathname;
}

function currentBillingPeriod(now: Date): [string, string] {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return [start.toISOString(), end.toISOString()];
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

function configFromForm(current: BusinessConfig, form: URLSearchParams): BusinessConfig {
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
  const monthlyDollars = Number(form.get("flatMonthlyPrice") ?? "0");
  if (!Number.isFinite(monthlyDollars) || monthlyDollars < 49 || monthlyDollars > 99) throw new HttpError(400, "Flat monthly price must be between $49 and $99");
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
    serviceAreaTerms: list("serviceAreaTerms"),
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
    requireDiagnosticFeeAcceptance: form.has("requireDiagnosticFeeAcceptance"),
    recordingDisclosure: required("recordingDisclosure").slice(0, 1_000),
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

async function exchangeGoogleCode(env: Environment, code: string, verifier: string, callbackPath = "/admin/integrations/google/callback"): Promise<string> {
  const callback = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}${callbackPath}`;
  const response = await withTimeout(fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
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
