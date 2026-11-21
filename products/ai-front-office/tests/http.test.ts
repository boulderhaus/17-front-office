import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { demoEnvironment, loadEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";
import type { Clock } from "../src/ports.js";

describe("HTTP boundary", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  let logs: Array<Record<string, unknown>>;
  const adminToken = "admin-token-abcdefghijklmnopqrstuvwxyz";
  const toolToken = "tool-token-abcdefghijklmnopqrstuvwxyz";
  const clock: Clock = { now: () => new Date("2026-01-15T08:00:00.000Z") };
  const syntheticEncryptionKey = Buffer.alloc(32).toString("base64");

  beforeEach(async () => {
    store = new InMemoryStore();
    logs = [];
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: adminToken, TOOL_TOKEN: toolToken, PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: { Demo: true }, logger: (entry) => logs.push(entry) }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("exposes health and rejects unauthenticated tools", async () => {
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${baseUrl}/tools/check-availability`, { method: "POST", body: "{}" })).status).toBe(401);
    expect(logs.some((entry) => entry.event === "request_completed" && entry.status === 401)).toBe(true);
  });

  it("accepts an authenticated availability tool call", async () => {
    const response = await fetch(`${baseUrl}/tools/check-availability`, {
      method: "POST",
      headers: { authorization: `Bearer ${toolToken}`, "content-type": "application/json" },
      body: JSON.stringify({ provider_call_id: "tool-call", window_start: "2026-01-15T15:00:00Z", window_end: "2026-01-15T18:00:00Z" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { status: string }).status).toBe("available");
  });

  it("applies deterministic emergency triage through an authenticated tool", async () => {
    const response = await fetch(`${baseUrl}/tools/triage`, {
      method: "POST",
      headers: { authorization: `Bearer ${toolToken}`, "content-type": "application/json" },
      body: JSON.stringify({ provider_call_id: "triage-call", from_number: "+15555550110", problem_description: "The basement smells like gas" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { severity: string }).severity).toBe("life_safety");
  });

  it("accepts a demo-authenticated Telnyx conversation-ended webhook", async () => {
    const response = await fetch(`${baseUrl}/webhooks/telnyx`, {
      method: "POST",
      headers: { authorization: `Bearer ${toolToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        data: {
          record_type: "event",
          event_type: "call.conversation.ended",
          id: "evt-1",
          occurred_at: "2026-01-15T08:02:00.000Z",
          payload: {
            assistant_id: "assistant-synthetic",
            call_control_id: "telnyx-call",
            from: "+15555550110",
            duration_sec: 120,
            messages: [
              { role: "user", content: "Routine maintenance", timestamp: "2026-01-15T08:00:10.000Z" },
              {
                role: "assistant",
                timestamp: "2026-01-15T08:00:30.000Z",
                tool_calls: [{
                  id: "tool-1",
                  type: "function",
                  function: {
                    name: "save_intake",
                    arguments: JSON.stringify({
                      caller_name: "Caller",
                      callback_number: "+15555550110",
                      service_address: "100 Main St, Springfield",
                      service_category: "HVAC maintenance",
                      problem_description: "Routine maintenance",
                      recording_disclosure_given: true,
                    }),
                  },
                }],
              },
            ],
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect((await store.getCallByProviderId("telnyx-call"))?.outcome).toBe("pending_confirmation");
  });

  it("accepts signed Telnyx initialization and tool webhooks in provider-test mode", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const rawPublicKey = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
    store = new InMemoryStore();
    await store.saveConfig({ ...createDemoConfig(), paused: false, ownerNotificationRefs: ["owner-primary"], ownerTransferNumberRef: "owner-primary" });
    await store.saveIntegrationSecret("demo", "notifications", "owner-primary", "+15555550100");
    const env = loadEnvironment({
      NODE_ENV: "production", DEMO_MODE: "false", PROVIDER_TEST_MODE: "true",
      PUBLIC_BASE_URL: "https://front-office.example", ADMIN_TOKEN: adminToken, TOOL_TOKEN: toolToken,
      DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: syntheticEncryptionKey,
      TELNYX_API_KEY: "synthetic", TELNYX_PUBLIC_KEY: rawPublicKey, TELNYX_FROM_NUMBER: "+15555550199",
      TELNYX_MESSAGING_PROFILE_ID: "00000000-0000-4000-8000-000000000001", TELNYX_ASSISTANT_ID: "assistant-synthetic",
      GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic",
      OWNER_DESTINATIONS_JSON: "{\"owner-primary\":\"+15555550100\"}",
    });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const initialization = JSON.stringify({
      data: {
        record_type: "event", event_type: "assistant.initialization", id: "event-initialization",
        occurred_at: "2026-01-15T08:00:00.000Z",
        payload: {
          telnyx_conversation_channel: "phone_call", telnyx_agent_target: "+15555550199",
          telnyx_end_user_target: "+15555550110", call_control_id: "v3:signed-call", assistant_id: "assistant-synthetic",
        },
      },
    });
    const initResponse = await fetch(`${baseUrl}/webhooks/telnyx`, {
      method: "POST", headers: signedHeaders(initialization, privateKey, clock.now()), body: initialization,
    });
    expect(initResponse.status).toBe(200);
    expect((await initResponse.json() as { dynamic_variables: { owner_transfer_targets: unknown[] } }).dynamic_variables.owner_transfer_targets).toHaveLength(1);
    expect(await store.getCallByProviderId("v3:signed-call")).not.toBeNull();

    const intake = JSON.stringify({
      provider_call_id: "v3:signed-call", from_number: "+15555550110", caller_name: "Signed Caller",
      callback_number: "+15555550110", service_address: "100 Main St, Springfield",
      service_category: "HVAC maintenance", problem_description: "Routine maintenance", recording_disclosure_given: true,
    });
    const intakeResponse = await fetch(`${baseUrl}/tools/save-intake`, {
      method: "POST", headers: { ...signedHeaders(intake, privateKey, clock.now()), "x-telnyx-call-control-id": "v3:signed-call" }, body: intake,
    });
    expect(intakeResponse.status).toBe(200);
    expect((await store.getCallByProviderId("v3:signed-call"))?.fields.callerName).toBe("Signed Caller");
    const mismatchResponse = await fetch(`${baseUrl}/tools/save-intake`, {
      method: "POST", headers: { ...signedHeaders(intake, privateKey, clock.now()), "x-telnyx-call-control-id": "v3:other-call" }, body: intake,
    });
    expect(mismatchResponse.status).toBe(401);

    const conversationEnded = new URLSearchParams({
      CallStatus: "conversation_ended",
      CallSid: "v3:signed-call",
      CallSessionId: "session-synthetic",
      ConversationId: "conversation-synthetic",
      DurationSec: "120",
      Messages: JSON.stringify([
        { role: "assistant", content: "How can I help?", timestamp: "2026-01-15T08:00:00.000Z" },
        { role: "user", content: "Routine maintenance", timestamp: "2026-01-15T08:00:10.000Z" },
      ]),
    }).toString();
    const endedResponse = await fetch(`${baseUrl}/webhooks/telnyx`, {
      method: "POST",
      headers: { ...signedHeaders(conversationEnded, privateKey, clock.now()), "content-type": "application/x-www-form-urlencoded" },
      body: conversationEnded,
    });
    expect(endedResponse.status).toBe(200);
    const completedCall = await store.getCallByProviderId("v3:signed-call");
    expect(completedCall?.endedAt).toBe(clock.now().toISOString());
    expect(completedCall?.transcript).toContain("Caller: Routine maintenance");
    expect(completedCall?.outcome).toBe("pending_confirmation");
  });

  it("uses an HttpOnly admin session and rejects a forged CSRF token", async () => {
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: adminToken }),
    });
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    const configPage = await fetch(`${baseUrl}/admin/config`, { headers: { cookie: cookie!.split(";")[0]! } });
    expect(configPage.status).toBe(200);
    expect(await configPage.text()).toContain("Owner alert phone");
    const response = await fetch(`${baseUrl}/admin/config`, {
      method: "POST",
      headers: { cookie: cookie!.split(";")[0]!, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: "forged" }),
    });
    expect(response.status).toBe(403);
  });

  it("persists owner-approved scripts and coverage rules from the admin form", async () => {
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: adminToken }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await fetch(`${baseUrl}/admin/config`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
    expect(csrf).toBeTruthy();
    const response = await fetch(`${baseUrl}/admin/config`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf: csrf!,
        businessName: "Synthetic Heating",
        timezone: "America/New_York",
        greeting: "Thanks for calling. I am the owner's AI assistant.",
        serviceState: "active",
        bookingMode: "confirm",
        operationMode: "after_hours",
        answerAfterRings: "5",
        flatMonthlyPrice: "49",
        dataRetentionDays: "45",
        supportEmail: "support@example.com",
        defaultServiceDurationMinutes: "60",
        emergencyThreshold: "0.8",
        serviceAreaTerms: "Albany, 122",
        emergencyKeywords: "no heat, burst pipe",
        serviceCategories: "HVAC repair, maintenance",
        priceSnippets: "Diagnostic: The diagnostic visit is $89.",
        approvedKnowledge: "Hours: We open at eight.",
        pronunciations: "HVAC: H V A C",
        weekdayStart: "17:30",
        weekdayEnd: "07:30",
        holidayDates: "2026-12-25, 2027-01-01",
        weekends: "on",
        requireDiagnosticFeeAcceptance: "on",
        recordingDisclosure: "This call may be recorded.",
      }),
    });
    expect(response.status).toBe(303);
    const config = await store.getConfig("demo");
    expect(config.priceSnippets).toEqual([{ label: "Diagnostic", text: "The diagnostic visit is $89." }]);
    expect(config.afterHours.holidayDates).toEqual(["2026-12-25", "2027-01-01"]);
    expect(config.defaultServiceDurationMinutes).toBe(60);
    expect(config.emergencyThreshold).toBe(0.8);
    expect(config.paused).toBe(false);
    expect(config.answerAfterRings).toBe(5);
    expect(config.dataRetentionDays).toBe(45);
    expect(config.supportEmail).toBe("support@example.com");
  });

  it("exposes honest activation, public policy pages, and the isolated simulator", async () => {
    const landing = await fetch(`${baseUrl}/`);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("Stop losing jobs");
    expect((await fetch(`${baseUrl}/activationz`)).status).toBe(503);
    expect((await fetch(`${baseUrl}/privacy`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/terms`)).status).toBe(200);
    const simulator = await fetch(`${baseUrl}/admin/simulator`, { headers: { authorization: `Bearer ${adminToken}` } });
    expect(simulator.status).toBe(200);
    expect(await simulator.text()).toContain("Run all 15 launch scenarios");
    const run = await fetch(`${baseUrl}/admin/simulator`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ scenario: "all" }),
    });
    const body = await run.text();
    expect(run.status).toBe(200);
    expect(body).toContain("All selected scenarios passed");
    expect((body.match(/>PASS</g) ?? [])).toHaveLength(15);
  });

  it("rejects production provider traffic while paused or commercially unproven", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = loadEnvironment({
      NODE_ENV: "production", DEMO_MODE: "false", PROVIDER_TEST_MODE: "false",
      PUBLIC_BASE_URL: "https://front-office.example", ADMIN_TOKEN: adminToken, TOOL_TOKEN: toolToken,
      DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: syntheticEncryptionKey, OWNER_DESTINATIONS_JSON: "{}",
    });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const invoke = () => fetch(`${baseUrl}/tools/check-availability`, {
      method: "POST",
      headers: { authorization: `Bearer ${toolToken}`, "content-type": "application/json" },
      body: JSON.stringify({ provider_call_id: "gate", window_start: "2026-01-15T15:00:00Z", window_end: "2026-01-15T18:00:00Z" }),
    });
    expect((await invoke()).status).toBe(503);
    await store.saveConfig({ ...createDemoConfig(), paused: false });
    expect((await invoke()).status).toBe(503);
    expect((await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", body: "{}" })).status).toBe(503);
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
