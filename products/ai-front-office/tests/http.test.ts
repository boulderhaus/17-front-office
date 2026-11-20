import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { demoEnvironment } from "../src/config/environment.js";
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
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
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

  it("accepts a demo-authenticated Retell call-ended webhook", async () => {
    const response = await fetch(`${baseUrl}/webhooks/retell`, {
      method: "POST",
      headers: { authorization: `Bearer ${toolToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        event: "call_ended",
        event_id: "evt-1",
        call: {
          call_id: "retell-call",
          from_number: "+15555550110",
          start_timestamp: 1_768_438_800_000,
          end_timestamp: 1_768_438_920_000,
          duration_ms: 120_000,
          transcript: "Routine maintenance",
          recording_url: "https://example.invalid/recording",
          call_analysis: { custom_analysis_data: { caller_name: "Caller", service_address: "100 Main St, Springfield", problem_description: "Routine maintenance", recording_disclosure_given: true } },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect((await store.getCallByProviderId("retell-call"))?.outcome).toBe("pending_confirmation");
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
        bookingMode: "confirm",
        operationMode: "after_hours",
        flatMonthlyPrice: "49",
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
  });
});
