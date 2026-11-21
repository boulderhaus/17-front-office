import { randomUUID } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";
import { renderCallDetail, renderConfig, renderDashboard, renderLanding, renderLogin, renderPrivacy, renderPrompt, renderReadiness, renderSimulator, renderTerms } from "../admin/render.js";
import { buildActivationReport, type ActivationReport } from "../application/readiness.js";
import { runAllSimulations, runSimulation, SIMULATION_SCENARIOS, type SimulationScenarioId } from "../application/simulator.js";
import { CallService } from "../application/call-service.js";
import { redactError, withTimeout } from "../application/retry.js";
import type { Environment } from "../config/environment.js";
import type { BusinessConfig } from "../domain/models.js";
import type { CalendarPort, Clock, Store } from "../ports.js";
import {
  asTelnyxConversationEnded,
  asTelnyxInitialization,
  parseTelnyxEnvelope,
  TelnyxRecordingClient,
  telnyxEventId,
  toTelnyxCallSummary,
  verifyTelnyxWebhook,
} from "../adapters/telnyx.js";
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
  redirect,
  sendHtml,
  sendJson,
  setSecurityHeaders,
  verifyAdminSession,
  verifyCsrf,
  verifyGoogleOAuthAttempt,
} from "./security.js";

const dateTime = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Must be an ISO date-time");
const baseToolSchema = z.object({
  tenant_id: z.string().min(1).optional(),
  provider_call_id: z.string().min(1),
});
const availabilitySchema = baseToolSchema.extend({
  window_start: dateTime,
  window_end: dateTime,
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
  requested_start: dateTime.optional(),
  explicit_slot_confirmation: z.boolean().optional(),
  diagnostic_fee_accepted: z.boolean().optional(),
  human_requested: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  recording_disclosure_given: z.boolean().optional(),
});

export interface AppDependencies {
  env: Environment;
  store: Store;
  calendar: CalendarPort;
  clock: Clock;
  integrations: Record<string, boolean>;
  logger?: (entry: Record<string, unknown>) => void;
}

export function createRequestHandler(dependencies: AppDependencies): RequestListener {
  const service = new CallService(dependencies.store, dependencies.calendar, dependencies.clock, dependencies.env.PUBLIC_BASE_URL);
  const recordingClient = dependencies.env.TELNYX_API_KEY ? new TelnyxRecordingClient(dependencies.env.TELNYX_API_KEY) : null;
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
    const ip = request.socket.remoteAddress ?? "unknown";
    response.once("finish", () => {
      log({ level: "info", event: "request_completed", requestId, method, route, status: response.statusCode, latencyMs: Date.now() - started });
    });
    if (!limiter.allow(`${ip}:${route}`, route.startsWith("webhook") ? 180 : 90, 60_000)) {
      throw new HttpError(429, "Too many requests");
    }

    if (method === "GET" && url.pathname === "/") {
      const config = await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID);
      return sendHtml(response, 200, renderLanding(config, dependencies.env.TELNYX_FROM_NUMBER ?? null));
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
    if (method === "POST" && url.pathname === "/tools/save-intake") return handleIntake(request, response);
    if (method === "POST" && url.pathname === "/tools/check-availability") return handleAvailability(request, response);
    if (method === "POST" && url.pathname === "/tools/triage") return handleTriage(request, response);
    if (method === "POST" && url.pathname === "/tools/book") return handleBooking(request, response);
    if (method === "POST" && url.pathname === "/tools/request-human") return handleHandoff(request, response);
    if (url.pathname.startsWith("/admin")) return handleAdmin(request, response, url);
    throw new HttpError(404, "Not found");
  }

  async function handleTelnyx(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    await requireOperational();
    const envelope = parseTelnyxEnvelope(rawBody);
    if (envelope.data.event_type === "assistant.initialization") {
      const initialization = asTelnyxInitialization(envelope);
      requireExpectedAssistant(initialization.data.payload.assistant_id);
      await service.recordStarted({
        eventId: telnyxEventId(envelope, rawBody),
        tenantId: dependencies.env.DEFAULT_TENANT_ID,
        providerCallId: initialization.data.payload.call_control_id,
        fromNumber: initialization.data.payload.telnyx_end_user_target ?? "unknown",
        startedAt: initialization.data.occurred_at ?? dependencies.clock.now().toISOString(),
      });
      const config = await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID);
      const transferNumber = config.ownerTransferNumberRef
        ? await dependencies.store.getIntegrationSecret(config.tenantId, "notifications", config.ownerTransferNumberRef)
        : null;
      return sendJson(response, 200, {
        dynamic_variables: {
          tenant_id: config.tenantId,
          business_name: config.businessName,
          owner_transfer_targets: transferNumber
            ? [{ name: "Owner", to: transferNumber, message: "Your AI front office has a caller who requested immediate human help." }]
            : [],
        },
        conversation: { metadata: { tenant_id: config.tenantId } },
      });
    }
    if (envelope.data.event_type === "call.conversation.ended") {
      const ended = asTelnyxConversationEnded(envelope);
      requireExpectedAssistant(ended.data.payload.assistant_id);
      const recordingUrl = `${dependencies.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/provider/telnyx/recordings/${encodeURIComponent(ended.data.payload.call_control_id)}`;
      await service.finalize(toTelnyxCallSummary(
        ended,
        rawBody,
        dependencies.env.DEFAULT_TENANT_ID,
        dependencies.clock.now(),
        recordingUrl,
      ));
    }
    sendJson(response, 200, { received: true });
  }

  async function handleIntake(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    await requireOperational();
    const input = intakeSchema.parse(unwrapToolPayload(parseJson<unknown>(rawBody)));
    requireMatchingCallHeader(request, input.provider_call_id);
    const result = await service.saveIntake({
      tenantId: input.tenant_id ?? dependencies.env.DEFAULT_TENANT_ID,
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
        ...(input.requested_start === undefined ? {} : { requestedStart: input.requested_start }),
        ...(input.explicit_slot_confirmation === undefined ? {} : { explicitSlotConfirmation: input.explicit_slot_confirmation }),
        ...(input.diagnostic_fee_accepted === undefined ? {} : { diagnosticFeeAccepted: input.diagnostic_fee_accepted }),
        ...(input.human_requested === undefined ? {} : { humanRequested: input.human_requested }),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      },
      ...(input.recording_disclosure_given === undefined ? {} : { recordingDisclosureGiven: input.recording_disclosure_given }),
    });
    sendJson(response, 200, result);
  }

  async function handleAvailability(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    await requireOperational();
    const input = availabilitySchema.parse(unwrapToolPayload(parseJson<unknown>(rawBody)));
    requireMatchingCallHeader(request, input.provider_call_id);
    const result = await service.checkAvailability({
      tenantId: input.tenant_id ?? dependencies.env.DEFAULT_TENANT_ID,
      providerCallId: input.provider_call_id,
      windowStart: input.window_start,
      windowEnd: input.window_end,
    });
    sendJson(response, 200, result);
  }

  async function handleTriage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readBody(request);
    requireProviderAuth(request, rawBody);
    await requireOperational();
    const input = triageSchema.parse(unwrapToolPayload(parseJson<unknown>(rawBody)));
    requireMatchingCallHeader(request, input.provider_call_id);
    const result = await service.triageCall({
      tenantId: input.tenant_id ?? dependencies.env.DEFAULT_TENANT_ID,
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
    await requireOperational();
    const input = bookingSchema.parse(unwrapToolPayload(parseJson<unknown>(rawBody)));
    requireMatchingCallHeader(request, input.provider_call_id);
    const result = await service.bookConfirmedSlot({
      tenantId: input.tenant_id ?? dependencies.env.DEFAULT_TENANT_ID,
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
    await requireOperational();
    const input = handoffSchema.parse(unwrapToolPayload(parseJson<unknown>(rawBody)));
    requireMatchingCallHeader(request, input.provider_call_id);
    const result = await service.queueHumanHandoff({
      tenantId: input.tenant_id ?? dependencies.env.DEFAULT_TENANT_ID,
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
      if (!limiter.allow(`${request.socket.remoteAddress ?? "unknown"}:login`, 10, 15 * 60_000)) throw new HttpError(429, "Too many sign-in attempts");
      if (!safeTokenMatch(form.get("token"), dependencies.env.ADMIN_TOKEN)) return sendHtml(response, 401, renderLogin("Invalid admin token."));
      const session = mintAdminSession(dependencies.env.ADMIN_TOKEN);
      response.setHeader("set-cookie", adminCookie(session, dependencies.env.NODE_ENV === "production"));
      return redirect(response, "/admin");
    }
    if (method === "GET" && url.pathname === "/admin/logout") {
      response.setHeader("set-cookie", "afo_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0");
      return redirect(response, "/admin");
    }
    if (method === "GET" && url.pathname === "/admin/integrations/google/callback") {
      if (!dependencies.env.GOOGLE_CLIENT_ID || !dependencies.env.GOOGLE_CLIENT_SECRET) throw new HttpError(503, "Google OAuth is not configured on the server");
      const verifier = verifyGoogleOAuthAttempt(url.searchParams.get("state"), readCookie(request, "afo_google_pkce"), dependencies.env.ADMIN_TOKEN);
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
    const sessionAuthorized = verifyAdminSession(session, dependencies.env.ADMIN_TOKEN);
    if (!bearer && !sessionAuthorized) return sendHtml(response, 401, renderLogin());
    const csrf = session ? csrfForSession(session, dependencies.env.ADMIN_TOKEN) : "bearer-auth";

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
      if (!bearer && (!session || !verifyCsrf(session, form.get("csrf"), dependencies.env.ADMIN_TOKEN))) throw new HttpError(403, "Invalid CSRF token");
      const selected = form.get("scenario");
      const valid = SIMULATION_SCENARIOS.some(([id]) => id === selected);
      if (selected !== "all" && !valid) throw new HttpError(400, "Unknown simulator scenario");
      const results = selected === "all" ? await runAllSimulations() : [await runSimulation(selected as SimulationScenarioId)];
      return sendHtml(response, 200, renderSimulator(results, csrf));
    }

    if (method === "GET" && url.pathname === "/admin/integrations/google/start") {
      if (!dependencies.env.GOOGLE_CLIENT_ID || !dependencies.env.GOOGLE_CLIENT_SECRET) throw new HttpError(503, "Google OAuth is not configured on the server");
      const attempt = createGoogleOAuthAttempt(dependencies.env.ADMIN_TOKEN, dependencies.env.NODE_ENV === "production");
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
      }));
    }
    if (method === "POST" && url.pathname === "/admin/config") {
      const form = parseForm(await readBody(request, 64_000));
      if (!bearer && (!session || !verifyCsrf(session, form.get("csrf"), dependencies.env.ADMIN_TOKEN))) throw new HttpError(403, "Invalid CSRF token");
      const current = await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID);
      const updated = configFromForm(current, form);
      const ownerPhone = form.get("ownerPhone")?.trim();
      if (ownerPhone) {
        if (!/^\+[1-9]\d{7,14}$/.test(ownerPhone)) throw new HttpError(400, "Owner phone must use E.164 format");
        await dependencies.store.saveIntegrationSecret(dependencies.env.DEFAULT_TENANT_ID, "notifications", "owner-primary", ownerPhone);
        updated.ownerNotificationRefs = ["owner-primary"];
        updated.ownerTransferNumberRef = "owner-primary";
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
      if (!bearer && (!session || !verifyCsrf(session, form.get("csrf"), dependencies.env.ADMIN_TOKEN))) throw new HttpError(403, "Invalid CSRF token");
      if (form.get("confirm") !== "delete") throw new HttpError(400, "Deletion confirmation is required");
      if (!await dependencies.store.deleteCall(dependencies.env.DEFAULT_TENANT_ID, deleteCallMatch[1])) throw new HttpError(404, "Call not found");
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
    if (bearerMatches(request, dependencies.env.TOOL_TOKEN)) return;
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

  function requireExpectedAssistant(assistantId: string): void {
    if (dependencies.env.TELNYX_ASSISTANT_ID && assistantId !== dependencies.env.TELNYX_ASSISTANT_ID) {
      throw new HttpError(403, "Webhook assistant does not match this deployment");
    }
  }

  function requireMatchingCallHeader(request: IncomingMessage, providerCallId: string): void {
    if (bearerMatches(request, dependencies.env.TOOL_TOKEN)) return;
    const headerCallId = singleHeader(request.headers["x-telnyx-call-control-id"]);
    if (!headerCallId || headerCallId !== providerCallId) throw new HttpError(401, "Telnyx call identifier does not match the signed tool payload");
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

  async function requireOperational(): Promise<void> {
    if (dependencies.env.DEMO_MODE) return;
    const config = await dependencies.store.getConfig(dependencies.env.DEFAULT_TENANT_ID);
    if (config.paused) throw new HttpError(503, "Service is paused");
    if (dependencies.env.PROVIDER_TEST_MODE) return;
    const report = await getActivationReport();
    if (!report.go) throw new HttpError(503, "Commercial activation gate is not satisfied");
  }
}

function unwrapToolPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return record.args ?? record.arguments ?? value;
}

function routeKey(pathname: string): string {
  if (pathname === "/webhooks/telnyx") return "webhook:telnyx";
  if (pathname.startsWith("/tools/")) return `tool:${pathname.slice(7)}`;
  if (pathname.startsWith("/admin/calls/")) return "admin:call";
  return pathname;
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
  if (!Number.isFinite(emergencyThreshold) || emergencyThreshold < 0.5 || emergencyThreshold > 1) throw new HttpError(400, "Emergency threshold must be between 0.5 and 1");
  const weekdayStart = required("weekdayStart");
  const weekdayEnd = required("weekdayEnd");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(weekdayStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(weekdayEnd)) throw new HttpError(400, "Coverage times must use HH:MM");
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

async function isGoogleConnected(env: Environment, store: Store): Promise<boolean> {
  return Boolean(env.GOOGLE_REFRESH_TOKEN || await store.getIntegrationSecret(env.DEFAULT_TENANT_ID, "google", "refresh_token"));
}

async function exchangeGoogleCode(env: Environment, code: string, verifier: string): Promise<string> {
  const callback = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/integrations/google/callback`;
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
