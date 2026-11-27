import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { CallService, toolResultKey } from "../src/application/call-service.js";
import { demoEnvironment, loadEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { AvailabilitySlot, BookingAttempt } from "../src/domain/models.js";
import { createRequestHandler, type AppDependencies } from "../src/http/app.js";
import type { CalendarPort, Clock } from "../src/ports.js";

// Hardening after PR #19 (Grok + Gemini review): the provider only reads a tool body on 2xx, the budget
// is charged before parsing and survives restarts/replicas, and a timed-out write can never land twice.

const toolToken = "tool-token-abcdefghijklmnopqrstuvwxyz";
const clock: Clock = { now: () => new Date("2026-01-15T08:00:00.000Z") };
const bearer = { authorization: `Bearer ${toolToken}`, "content-type": "application/json" };
const window = { window_start: "2026-01-15T15:00:00Z", window_end: "2026-01-15T18:00:00Z" };
const FAILURE_KEYS = ["instruction", "ok", "say", "status"];

/** A calendar that can hold isFree/createEvent open past the tool deadline. */
class GatedCalendar extends InMemoryCalendar {
  isFreeGate: Promise<void> | null = null;
  createDelayMs = 0;
  createCalls = 0;
  listCalls = 0;

  override async listAvailableSlots(input: Parameters<CalendarPort["listAvailableSlots"]>[0], options?: { signal?: AbortSignal }): Promise<AvailabilitySlot[]> {
    this.listCalls += 1;
    return super.listAvailableSlots(input, options);
  }

  override async isFree(input: { tenantId: string; slot: AvailabilitySlot }, options?: { signal?: AbortSignal }): Promise<boolean> {
    if (this.isFreeGate) await this.isFreeGate;
    return super.isFree(input, options);
  }

  override async createEvent(attempt: BookingAttempt): Promise<{ status: "confirmed" | "unknown"; providerEventId: string | null }> {
    this.createCalls += 1;
    // Ignores the abort signal on purpose: the provider committed the write after our deadline.
    if (this.createDelayMs) await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    return super.createEvent(attempt);
  }
}

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(dependencies: AppDependencies): Promise<string> {
  const server = createServer(createRequestHandler(dependencies));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function demoApp(options: { store?: InMemoryStore; calendar?: CalendarPort; toolDeadlineMs?: number; logs?: Array<Record<string, unknown>> } = {}) {
  const store = options.store ?? new InMemoryStore();
  if (!options.store) await store.saveConfig({ ...createDemoConfig(), bookingMode: "direct", requireDiagnosticFeeAcceptance: false });
  const calendar = options.calendar ?? new GatedCalendar();
  const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: toolToken, PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
  const baseUrl = await listen({
    env, store, calendar, clock, integrations: {},
    logger: (entry) => { options.logs?.push(entry); },
    ...(options.toolDeadlineMs === undefined ? {} : { toolDeadlineMs: options.toolDeadlineMs }),
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = bearer) =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { store, calendar, baseUrl, post };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("the per-call budget is charged before parsing", () => {
  it("counts invalid arguments: the third bad call gets the limit and the tool never runs", async () => {
    const { calendar, post } = await demoApp();
    const gated = calendar as GatedCalendar;
    const bad = { provider_call_id: "bad-args", window_start: "tomorrow", window_end: "later" };
    const first = await post("/tools/check-availability", bad);
    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({ ok: false, status: "unavailable" });
    expect(await json(await post("/tools/check-availability", bad))).toMatchObject({ ok: false, status: "unavailable" });
    const third = await post("/tools/check-availability", bad);
    expect(third.status).toBe(200);
    expect(await json(third)).toMatchObject({ ok: false, status: "limit_reached" });
    // A valid call after the loop is still refused, without touching the calendar.
    expect(await json(await post("/tools/check-availability", { provider_call_id: "bad-args", ...window }))).toMatchObject({ status: "limit_reached" });
    expect(gated.listCalls).toBe(0);
  });

  it("answers take-a-message when the call id is missing, without spending any budget", async () => {
    const { store, post } = await demoApp();
    const increment = vi.spyOn(store, "incrementToolCallCount");
    const response = await post("/tools/check-availability", { ...window });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ ok: false, status: "limit_reached" });
    expect(increment).not.toHaveBeenCalled();
  });

  it("keeps the count in the store, so a fresh handler (restart or another replica) sees it", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const first = await demoApp({ store });
    const second = await demoApp({ store });
    const body = { provider_call_id: "replica-call", ...window };
    expect((await json(await first.post("/tools/check-availability", body))).status).toBe("available");
    expect((await json(await second.post("/tools/check-availability", body))).status).toBe("available");
    expect(await json(await first.post("/tools/check-availability", body))).toMatchObject({ status: "limit_reached" });
    expect(await json(await second.post("/tools/check-availability", body))).toMatchObject({ status: "limit_reached" });
  });

  it("fails closed when the counter cannot be written", async () => {
    const { store, calendar, post } = await demoApp();
    vi.spyOn(store, "incrementToolCallCount").mockRejectedValue(new Error("Synthetic database outage"));
    const response = await post("/tools/check-availability", { provider_call_id: "store-down", ...window });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ ok: false, status: "limit_reached" });
    expect((calendar as GatedCalendar).listCalls).toBe(0);
  });

  it("answers the provider rate limit with take-a-message and never throttles another call", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { post } = await demoApp({ logs });
    const body = { provider_call_id: "flood-call", ...window };
    const responses = await Promise.all(Array.from({ length: 245 }, () => post("/tools/check-availability", body)));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(logs.some((entry) => entry.event === "tool_call_limited" && entry.reason === "rate_limited")).toBe(true);
    expect((await json(await post("/tools/check-availability", { provider_call_id: "quiet-call", ...window }))).status).toBe("available");
  });
});

describe("every tool failure answers 200 in plain English", () => {
  it("covers auth, validation, deliberate 409/503 and unexpected errors, logging the real status", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { store, post } = await demoApp({ logs });

    const unauthenticated = await post("/tools/check-availability", { provider_call_id: "no-auth", ...window }, { "content-type": "application/json" });
    expect(unauthenticated.status).toBe(200);
    expect(Object.keys(await json(unauthenticated)).sort()).toEqual(FAILURE_KEYS);

    const invalid = await post("/tools/approved-answer", { provider_call_id: "bad", kind: "discount", key: "x" });
    expect(invalid.status).toBe(200);
    expect(await json(invalid)).toMatchObject({ ok: false, status: "unavailable", say: expect.any(String) });

    const notExplicit = await post("/tools/request-human", { provider_call_id: "loud", from_number: "+15555550110", reason: "explicit_request", caller_quote: "why is this so loud" });
    expect(notExplicit.status).toBe(200);
    expect(await json(notExplicit)).toMatchObject({ ok: false, status: "unavailable" });

    const tooBig = await post("/tools/save-intake", { provider_call_id: "huge", from_number: "+15555550110", problem_description: "x".repeat(70_000) });
    expect(tooBig.status).toBe(200);
    expect(await json(tooBig)).toMatchObject({ ok: false });

    vi.spyOn(store, "getConfig").mockRejectedValue(new Error("Synthetic database failure"));
    const broken = await post("/tools/check-availability", { provider_call_id: "broken", ...window });
    expect(broken.status).toBe(200);
    expect(await json(broken)).toMatchObject({ ok: false, status: "unavailable" });

    const statuses = logs.filter((entry) => entry.event === "tool_request_failed").map((entry) => entry.status);
    expect(statuses).toEqual(expect.arrayContaining([401, 400, 409, 500]));
  });

  it("never echoes caller details or validation messages to the model", async () => {
    const { post } = await demoApp();
    const response = await post("/tools/save-intake", {
      provider_call_id: "pii-call", from_number: "+15555550123", caller_name: "Janet Q Synthetic".repeat(20),
      service_address: "742 Evergreen Terrace", problem_description: "",
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/Janet|Evergreen|5555550123|too_big|too_small|caller_name|Too big|Too small|expected/i);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(FAILURE_KEYS);
  });

  it("answers a header/payload mismatch and a paused shop with 200 in signed mode", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const rawPublicKey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
    const store = new InMemoryStore();
    await store.saveConfig({ ...createDemoConfig(), paused: true });
    await new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example")
      .recordStarted({ eventId: "start:signed", tenantId: "demo", providerCallId: "v3:signed", fromNumber: "+15555550110", startedAt: clock.now().toISOString() });
    const logs: Array<Record<string, unknown>> = [];
    const env = loadEnvironment({
      NODE_ENV: "production", DEMO_MODE: "false", PROVIDER_TEST_MODE: "true",
      PUBLIC_BASE_URL: "https://front-office.example", ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: toolToken,
      SESSION_SIGNING_KEY: "session-signing-key-abcdefghijklmnopqrstuvwxyz",
      DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      TELNYX_API_KEY: "synthetic", TELNYX_PUBLIC_KEY: rawPublicKey, TELNYX_FROM_NUMBER: "+15555550199",
      TELNYX_MESSAGING_PROFILE_ID: "00000000-0000-4000-8000-000000000001", TELNYX_ASSISTANT_ID: "assistant-synthetic",
      GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic",
      OWNER_DESTINATIONS_JSON: "{\"owner-primary\":\"+15555550100\"}",
    });
    const calendar = new GatedCalendar();
    const baseUrl = await listen({ env, store, calendar, clock, integrations: {}, logger: (entry) => { logs.push(entry); } });
    const body = JSON.stringify({ provider_call_id: "v3:signed", ...window });
    const send = (headers: Record<string, string>) => fetch(`${baseUrl}/tools/check-availability`, { method: "POST", headers: { ...signedHeaders(body, privateKey, clock.now()), ...headers }, body });

    const missingHeader = await send({});
    expect(missingHeader.status).toBe(200);
    expect(await json(missingHeader)).toMatchObject({ status: "limit_reached" });

    const mismatch = await send({ "x-telnyx-call-control-id": "v3:someone-else" });
    expect(mismatch.status).toBe(200);
    expect(await json(mismatch)).toMatchObject({ ok: false, status: "unavailable" });

    const paused = await send({ "x-telnyx-call-control-id": "v3:signed" });
    expect(paused.status).toBe(200);
    expect(await json(paused)).toMatchObject({ ok: false, status: "unavailable" });

    const badSignature = await fetch(`${baseUrl}/tools/check-availability`, { method: "POST", headers: { "content-type": "application/json", "x-telnyx-call-control-id": "v3:signed" }, body });
    expect(badSignature.status).toBe(200);
    expect(await json(badSignature)).toMatchObject({ ok: false, status: "unavailable" });
    expect(calendar.listCalls).toBe(0);
    expect(logs.filter((entry) => entry.event === "tool_request_failed").map((entry) => entry.status)).toEqual(expect.arrayContaining([401, 503]));
  });
});

describe("a signed tool call whose provider-filled caller number is unusable", () => {
  it("still triages, saves and marks on the number the call started with, and logs why", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const rawPublicKey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
    const store = new InMemoryStore();
    await store.saveConfig({ ...createDemoConfig(), paused: false });
    await new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example")
      .recordStarted({ eventId: "start:forwarded", tenantId: "demo", providerCallId: "v3:forwarded", fromNumber: "+15555550110", startedAt: clock.now().toISOString() });
    const logs: Array<Record<string, unknown>> = [];
    const env = loadEnvironment({
      NODE_ENV: "production", DEMO_MODE: "false", PROVIDER_TEST_MODE: "true",
      PUBLIC_BASE_URL: "https://front-office.example", ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: toolToken,
      SESSION_SIGNING_KEY: "session-signing-key-abcdefghijklmnopqrstuvwxyz",
      DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      TELNYX_API_KEY: "synthetic", TELNYX_PUBLIC_KEY: rawPublicKey, TELNYX_FROM_NUMBER: "+15555550199",
      TELNYX_MESSAGING_PROFILE_ID: "00000000-0000-4000-8000-000000000001", TELNYX_ASSISTANT_ID: "assistant-synthetic",
      GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic",
      OWNER_DESTINATIONS_JSON: "{\"owner-primary\":\"+15555550100\"}",
    });
    const baseUrl = await listen({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: (entry) => { logs.push(entry); } });
    const signed = async (path: string, payload: Record<string, unknown>) => {
      const body = JSON.stringify({ provider_call_id: "v3:forwarded", ...payload });
      return json(await fetch(`${baseUrl}${path}`, { method: "POST", headers: { ...signedHeaders(body, privateKey, clock.now()), "x-telnyx-call-control-id": "v3:forwarded" }, body }));
    };

    expect(await signed("/tools/triage", { from_number: null, problem_description: "No heat, wants service tomorrow" })).toMatchObject({ severity: expect.any(String) });
    expect(await signed("/tools/save-intake", { caller_name: "Sam", company_name: null, problem_description: "No heat, wants service tomorrow" })).toMatchObject({ status: "saved" });
    expect(await signed("/tools/mark-spam", { from_number: 15555550110, category: "wrong_number", caller_quote: "Sorry, wrong number" })).toMatchObject({ status: expect.stringMatching(/^(marked|continue)$/) });
    expect(await signed("/tools/request-human", { from_number: "{{telnyx_end_user_target}}", reason: "explicit_request", caller_quote: "I want to speak to the owner" })).toMatchObject({ status: "handoff_queued" });

    const call = await store.getCallByProviderId("v3:forwarded");
    expect(call?.fromNumber).toBe("+15555550110");
    expect(call?.fields).toMatchObject({ callerName: "Sam", problemDescription: "No heat, wants service tomorrow", callbackNumber: "+15555550110" });
    expect(logs.some((entry) => entry.event === "tool_request_failed")).toBe(false);
    expect(logs.filter((entry) => entry.event === "tool_input_repaired").map((entry) => [entry.tool, entry.fromNumber])).toEqual([
      ["triage_call", "null"], ["save_intake", "missing"], ["mark_spam_call", "number"], ["request_human", "placeholder"],
    ]);
    expect(JSON.stringify(logs)).not.toContain("5555550110");
  });
});

describe("the tool deadline aborts work and a late write lands at most once", () => {
  const booking = (callId: string, slotStart: string) => ({
    provider_call_id: callId, slot_start: slotStart, caller_name: "Synthetic Caller", callback_number: "+15555550110",
    address: "100 Main St, Springfield IL 62701", service_category: "HVAC maintenance", problem_description: "Furnace check",
    explicit_confirmation: true, diagnostic_fee_accepted: true,
  });

  async function offeredSlot(post: (path: string, body: unknown) => Promise<Response>, callId: string): Promise<string> {
    const offered = await json(await post("/tools/check-availability", { provider_call_id: callId, ...window }));
    expect(offered.status).toBe("available");
    return (offered.slots as AvailabilitySlot[])[0]!.start;
  }

  it("answers take-a-message at the deadline and the aborted booking never writes", async () => {
    const calendar = new GatedCalendar();
    const { store, post } = await demoApp({ calendar, toolDeadlineMs: 80 });
    const slot = await offeredSlot(post, "slow-book");
    let release!: () => void;
    calendar.isFreeGate = new Promise<void>((resolve) => { release = resolve; });

    const started = Date.now();
    const response = await post("/tools/book", booking("slow-book", slot));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ ok: false, status: "limit_reached" });

    release();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calendar.createCalls).toBe(0);
    expect(calendar.events).toHaveLength(0);
    const call = await store.getCallByProviderId("slow-book");
    const saved = call ? await store.getBookingForCall(call.id) : null;
    expect(saved?.status ?? null).not.toBe("confirmed");
  });

  it("records a write the provider committed late, and the retry is a no-op that reports it truthfully", async () => {
    const calendar = new GatedCalendar();
    const { store, post } = await demoApp({ calendar, toolDeadlineMs: 80 });
    const slot = await offeredSlot(post, "late-book");
    calendar.createDelayMs = 250;

    const timedOut = await post("/tools/book", booking("late-book", slot));
    expect(await json(timedOut)).toMatchObject({ ok: false, status: "limit_reached" });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const call = await store.getCallByProviderId("late-book");
    const late = await store.getBookingForCall(call!.id);
    expect(["confirmed", "unknown"]).toContain(late?.status);
    expect(late?.providerEventId).toBeTruthy();

    calendar.createDelayMs = 0;
    const retry = await json(await post("/tools/book", booking("late-book", slot)));
    expect(retry.status).toBe(late?.status);
    expect(calendar.createCalls).toBe(1);
    expect(calendar.events).toHaveLength(1);
  });

  it("makes a repeated book_slot for the same slot a no-op", async () => {
    const calendar = new GatedCalendar();
    const { store, post } = await demoApp({ calendar });
    const slot = await offeredSlot(post, "twice-book");
    expect((await json(await post("/tools/book", booking("twice-book", slot)))).status).toBe("confirmed");
    const saveCall = vi.spyOn(store, "saveCall");
    const saveBooking = vi.spyOn(store, "saveBooking");
    expect((await json(await post("/tools/book", booking("twice-book", slot)))).status).toBe("confirmed");
    expect(calendar.createCalls).toBe(1);
    expect(saveCall).not.toHaveBeenCalled();
    expect(saveBooking).not.toHaveBeenCalled();
  });

  it("lets only the claim winner write: a concurrent book_slot for the same slot gets a plain-English refusal", async () => {
    const calendar = new GatedCalendar();
    const { store, post } = await demoApp({ calendar });
    const slot = await offeredSlot(post, "claimed-book");
    // Another replica is mid-write on this exact slot.
    expect((await store.claimToolResult("claimed-book", toolResultKey("book_slot", "claimed-book", new Date(slot).toISOString()), new Date().toISOString(), new Date(Date.now() - 30_000).toISOString())).status).toBe("claimed");
    const response = await post("/tools/book", booking("claimed-book", slot));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ ok: false, status: "unavailable" });
    expect(calendar.createCalls).toBe(0);
  });

  it("makes a repeated identical save_intake a no-op but applies a changed one", async () => {
    const { store, post } = await demoApp();
    const intake = { provider_call_id: "twice-intake", from_number: "+15555550110", caller_name: "Synthetic Caller", problem_description: "Furnace noise" };
    expect((await json(await post("/tools/save-intake", intake))).status).toBe("saved");
    const saveCall = vi.spyOn(store, "saveCall");
    const repeated = await json(await post("/tools/save-intake", intake));
    expect(repeated).toMatchObject({ status: "saved", missing: expect.any(Array) });
    expect(saveCall).not.toHaveBeenCalled();
    expect((await json(await post("/tools/save-intake", { ...intake, service_address: "100 Main St, Springfield" }))).status).toBe("saved");
    expect(saveCall).toHaveBeenCalled();
    expect((await store.getCallByProviderId("twice-intake"))?.fields.address).toBe("100 Main St, Springfield");
  });

  it("stops intake writes once the deadline has passed", async () => {
    const { store, post } = await demoApp({ toolDeadlineMs: 60 });
    const intake = { provider_call_id: "slow-intake", from_number: "+15555550110", caller_name: "Synthetic Caller", problem_description: "Furnace noise" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = store.getConfig.bind(store);
    vi.spyOn(store, "getConfig").mockImplementation(async (tenantId) => { await gate; return original(tenantId); });
    expect(await json(await post("/tools/save-intake", intake))).toMatchObject({ status: "limit_reached" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await store.getCallByProviderId("slow-intake"))?.fields.callerName ?? null).toBeNull();
  });
});

function signedHeaders(body: string, privateKey: KeyObject, now: Date): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  return {
    "content-type": "application/json",
    "telnyx-timestamp": timestamp,
    "telnyx-signature-ed25519": sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64"),
  };
}

describe("a tool the model repeats in one call does its work once", () => {
  // A real test call saw request_human five times in one call. Each tool below is called three times on one call:
  // exactly one owner alert (per channel), one task, one booking, and the repeat answer is short and final.
  const forCall = (store: InMemoryStore, callId: string) => [...store.notifications.values()].filter((item) => item.callId === callId);
  const tasksFor = (store: InMemoryStore, callId: string) => [...store.callbackTasks.values()].filter((task) => task.callId === callId);
  const one = (items: Array<{ idempotencyKey: string }>) => new Set(items.map((item) => item.idempotencyKey)).size === items.length;

  it("request_human: one owner alert and one task; the second answer says it's done, the third is the stop", async () => {
    const { store, post } = await demoApp();
    const body = { provider_call_id: "thrice-human", from_number: "+15555550110", reason: "explicit_request", caller_quote: "I want to speak to the owner", problem_description: "Water heater leaking" };
    expect(await json(await post("/tools/request-human", body))).toMatchObject({ status: "handoff_queued" });
    const repeat = await json(await post("/tools/request-human", body));
    expect(repeat).toMatchObject({ status: "handoff_queued", already: true, transferAvailable: false, transferTargets: [] });
    expect(repeat.message).toMatch(/^Already done\. .*Do not call request_human again/);
    expect(await json(await post("/tools/request-human", body))).toMatchObject({ ok: false, status: "limit_reached" });
    const call = (await store.getCallByProviderId("thrice-human"))!;
    const alerts = forCall(store, call.id);
    expect(alerts.filter((item) => item.channel === "sms")).toHaveLength(1);
    expect(one(alerts)).toBe(true);
    expect(tasksFor(store, call.id)).toHaveLength(1);
  });

  it("triage_call on an emergency: one owner alert and one task", async () => {
    const { store, post } = await demoApp();
    const body = { provider_call_id: "thrice-triage", from_number: "+15555550110", problem_description: "I smell gas in the basement" };
    for (let attempt = 0; attempt < 3; attempt += 1) await post("/tools/triage", body);
    const call = (await store.getCallByProviderId("thrice-triage"))!;
    expect(call.emergency?.emergency).toBe(true);
    const alerts = forCall(store, call.id);
    expect(alerts.filter((item) => item.channel === "sms")).toHaveLength(1);
    expect(one(alerts)).toBe(true);
    expect(tasksFor(store, call.id)).toHaveLength(1);
  });

  it("save_intake on an emergency, saved three times with new details each time: one owner alert and one task", async () => {
    const { store, post } = await demoApp();
    const base = { provider_call_id: "thrice-intake", from_number: "+15555550110", problem_description: "I smell gas in the basement" };
    await post("/tools/save-intake", base);
    await post("/tools/save-intake", { ...base, caller_name: "Synthetic Caller" });
    await post("/tools/save-intake", { ...base, caller_name: "Synthetic Caller", service_address: "100 Main St, Springfield" });
    const call = (await store.getCallByProviderId("thrice-intake"))!;
    expect(call.fields.address).toBe("100 Main St, Springfield");
    const alerts = forCall(store, call.id);
    expect(alerts.filter((item) => item.channel === "sms")).toHaveLength(1);
    expect(one(alerts)).toBe(true);
    expect(tasksFor(store, call.id)).toHaveLength(1);
  });

  it("book_slot: one booking and one calendar event, even when the repeat names another offered time", async () => {
    const calendar = new GatedCalendar();
    const { store, post } = await demoApp({ calendar });
    const offer = async (windowStart: string, windowEnd: string) => ((await json(await post("/tools/check-availability", { provider_call_id: "thrice-book", window_start: windowStart, window_end: windowEnd }))).slots as AvailabilitySlot[])[0]!;
    const slots = [await offer(window.window_start, window.window_end)];
    const booking = (slotStart: string) => ({
      provider_call_id: "thrice-book", slot_start: slotStart, caller_name: "Synthetic Caller", callback_number: "+15555550110",
      address: "100 Main St, Springfield IL 62701", service_category: "HVAC maintenance", problem_description: "Furnace check",
      explicit_confirmation: true, diagnostic_fee_accepted: true,
    });
    expect((await json(await post("/tools/book", booking(slots[0]!.start)))).status).toBe("confirmed");
    // The model asks for times again and books one of the new ones.
    slots.push(await offer("2026-01-16T15:00:00Z", "2026-01-16T18:00:00Z"));
    expect(slots[1]!.start).not.toBe(slots[0]!.start);
    const again = await json(await post("/tools/book", booking(slots[1]!.start)));
    // Never a second appointment for the same caller, whatever the repeat names.
    expect(["confirmed", "pending"]).toContain(again.status);
    expect(await json(await post("/tools/book", booking(slots[0]!.start)))).toMatchObject({ status: "limit_reached" });
    expect(calendar.createCalls).toBe(1);
    expect(calendar.events).toHaveLength(1);
    const call = (await store.getCallByProviderId("thrice-book"))!;
    expect([...store.bookings.values()].filter((item) => item.callId === call.id)).toHaveLength(1);
    expect(one(forCall(store, call.id))).toBe(true);
  });

  it("mark_spam_call: marks once and never alerts the owner", async () => {
    const store = new InMemoryStore();
    await store.saveConfig({ ...createDemoConfig(), bookingMode: "direct", requireDiagnosticFeeAcceptance: false });
    await new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example")
      .recordStarted({ eventId: "start:thrice-spam", tenantId: "demo", providerCallId: "thrice-spam", fromNumber: "+15555550110", startedAt: clock.now().toISOString() });
    const { post } = await demoApp({ store });
    const body = { provider_call_id: "thrice-spam", from_number: "+15555550110", category: "vendor", caller_quote: "I'm calling about your merchant services" };
    for (let attempt = 0; attempt < 3; attempt += 1) await post("/tools/mark-spam", body);
    const call = (await store.getCallByProviderId("thrice-spam"))!;
    expect(call.billingDisposition).toBe("spam_excluded");
    expect(forCall(store, call.id)).toHaveLength(0);
    expect(tasksFor(store, call.id)).toHaveLength(0);
  });
});
