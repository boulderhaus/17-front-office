import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { ensureInboundCallScreening, TelnyxProvisioner } from "../src/adapters/telnyx-provisioning.js";
import { CallService } from "../src/application/call-service.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";
import { usageClass } from "../src/domain/usage.js";
import type { CollectedCallFields } from "../src/domain/models.js";
import type { Clock } from "../src/ports.js";
import { buildTelnyxAssistantUpdate, buildTelnyxGreeting, buildTelnyxTools, buildVoiceSystemPrompt } from "../src/voice/system-prompt.js";
import { runEnableCallScreening } from "../scripts/enable-call-screening.js";

const noFields: CollectedCallFields = {
  callerName: null, companyName: null, callbackNumber: null, address: null, serviceCategory: null, serviceCategoryConfidence: 0,
  problemDescription: "", equipmentDetails: null, accessNotes: null, requestedStart: null, explicitSlotConfirmation: false,
  diagnosticFeeAccepted: false, humanRequested: false, confidence: 0,
};

class MutableClock implements Clock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value); }
  advance(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}

describe("call-minute guards in the assistant", () => {
  const config = createDemoConfig();
  const prompt = buildVoiceSystemPrompt(config);

  it("keeps the greeting and the safety rules untouched", () => {
    expect(buildTelnyxGreeting(config)).toBe("Thanks for calling North Star Heating. How can I help?");
    expect(prompt).toContain("If the caller reports gas odor, carbon monoxide, smoke, fire, or immediate danger, tell them to leave the building and call 911 or the gas utility. Do not troubleshoot.");
    expect(prompt).toContain("Its deterministic life-safety rules always win over your judgment.");
  });

  it("ends clear non-service calls in the first 15 seconds and never a possible customer", () => {
    expect(prompt).toContain("SERVICE-CALL CHECK (FIRST 15 SECONDS)");
    expect(prompt).toContain("a vendor, supplier, or anyone selling to the shop");
    expect(prompt).toContain("a recruiter; a robocall or pre-recorded or scripted pitch; or a clear wrong number");
    expect(prompt).toContain('say exactly "Sorry, this line is only for service calls. Goodbye." and invoke the built-in hangup tool in the same turn');
    expect(prompt).toContain("Never use mark_spam_call for a possible customer");
    expect(prompt).toContain("an emergency or safety concern, or an existing customer");
    expect(prompt).toContain("When unsure, continue the call normally.");
  });

  it("checks in once on silence, then says goodbye and hangs up", () => {
    expect(prompt).toContain('If the caller goes silent, ask once, "Are you still there?"');
    expect(prompt).toContain('say "I\'ll let you go. Goodbye.", and invoke the built-in hangup tool in the same turn');
  });

  it("wraps up at five minutes and targets a two-minute, one-question-at-a-time intake", () => {
    expect(prompt).toContain("save_intake returns wrap_up=true once the call has run about five minutes");
    expect(prompt).toContain('say exactly "I\'ve got everything I need; the owner will call you back."');
    expect(prompt).toContain("Finish intake in about two minutes. No small talk. Ask exactly one question at a time");
    expect(prompt).toContain("the problem, the caller's name, the callback number, the service address, and how urgent it is");
    expect(prompt).toContain("Confirm the details once, in the final recap.");
    expect(prompt).not.toContain("small, natural groups");
  });

  it("sets Telnyx's six-minute cap and silence timers and exposes the spam tool", () => {
    const update = buildTelnyxAssistantUpdate(config, "https://front-office.example") as { telephony_settings: Record<string, unknown> };
    expect(update.telephony_settings).toMatchObject({ time_limit_secs: 360, user_idle_reply_secs: 4, user_idle_timeout_secs: 10 });
    const tool = buildTelnyxTools(config, "https://front-office.example")
      .find((entry) => (entry.webhook as { name?: string } | undefined)?.name === "mark_spam_call") as {
        webhook: { url: string; body_parameters: { required: string[]; properties: { category: { enum: string[] } } }; preset_body_fields: Record<string, unknown> };
      };
    expect(tool.webhook.url).toBe("https://front-office.example/tools/mark-spam");
    expect(tool.webhook.body_parameters.required).toEqual(["category", "caller_quote"]);
    expect(tool.webhook.body_parameters.properties.category.enum).toEqual(["vendor", "solicitor", "sales", "recruiter", "robocall", "wrong_number"]);
    expect(tool.webhook.preset_body_fields).toEqual({ provider_call_id: "{{call_control_id}}", from_number: "{{telnyx_end_user_target}}" });
  });
});

describe("spam-intent tool", () => {
  let store: InMemoryStore;
  let clock: MutableClock;
  let service: CallService;
  const start = (id: string, fromNumber = "+15555550177") => service.recordStarted({ eventId: `start:${id}`, tenantId: "demo", providerCallId: id, fromNumber, startedAt: clock.now().toISOString() });
  const finalize = (id: string, fromNumber = "+15555550177") => service.finalize({
    webhookEventId: `end:${id}`, tenantId: "demo", providerCallId: id, fromNumber,
    startedAt: "2026-01-15T08:00:00.000Z", endedAt: clock.now().toISOString(), durationSeconds: 25,
    fields: noFields, transcript: "Hi, I'm calling about your Google business listing.", recordingUrl: null, consentState: "unknown",
  });

  beforeEach(async () => {
    store = new InMemoryStore();
    clock = new MutableClock(new Date("2026-01-15T08:00:00.000Z"));
    await store.saveConfig({ ...createDemoConfig(), ownerRealtimeSmsEnabled: true, customerSmsEnabled: true });
    service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example");
  });

  it("marks the call spam_excluded, keeps it out of usage, alerts and callbacks", async () => {
    await start("seo-pitch");
    const result = await service.markSpam({ tenantId: "demo", providerCallId: "seo-pitch", fromNumber: "+15555550177", category: "sales", callerQuote: "I'm calling about your Google business listing" });
    expect(result.status).toBe("marked");
    expect(await store.getCallByProviderId("seo-pitch")).toMatchObject({ billingDisposition: "spam_excluded", outcome: "ignored_spam" });
    // A stale-call sweep must not turn the hung-up spam call into an owner callback.
    clock.advance(40 * 60_000);
    expect(await service.recoverStaleCalls("demo")).toBe(0);
    const call = await finalize("seo-pitch");
    expect(call.billingDisposition).toBe("spam_excluded");
    expect(call.outcome).toBe("ignored_spam");
    expect(usageClass(call)).toBe("spam");
    expect(await store.listNotifications(call.id)).toHaveLength(0);
    expect(await store.getCallbackTaskForCall(call.id)).toBeNull();
    expect(await store.isKnownCustomer("demo", "+15555550177")).toBe(false);
    expect(await store.getUsageSummary("demo", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")).toMatchObject({ billableCalls: 0, billedMinutes: 0, excludedSpamCalls: 1 });
  });

  it("refuses when the caller could be a customer: an emergency, an address, or a past caller", async () => {
    await start("gas");
    expect((await service.markSpam({ tenantId: "demo", providerCallId: "gas", fromNumber: "+15555550177", category: "wrong_number", callerQuote: "Wrong number? I smell gas in my kitchen" })).status).toBe("continue");
    expect((await store.getCallByProviderId("gas"))!.billingDisposition).not.toBe("spam_excluded");

    await start("address");
    await service.saveIntake({ tenantId: "demo", providerCallId: "address", fromNumber: "+15555550177", fields: { problemDescription: "Not sure", address: "100 Main St, Springfield, IL" } });
    expect((await service.markSpam({ tenantId: "demo", providerCallId: "address", fromNumber: "+15555550177", category: "sales", callerQuote: "Do you sell filters?" })).status).toBe("continue");

    await store.upsertCustomer({ id: "c1", tenantId: "demo", phone: "+15555550188", name: "Past Caller", address: null, lastCallId: "x", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    await start("repeat", "+15555550188");
    expect((await service.markSpam({ tenantId: "demo", providerCallId: "repeat", fromNumber: "+15555550188", category: "sales", callerQuote: "Is this the shop?" })).status).toBe("continue");
    expect((await store.getCallByProviderId("repeat"))!.billingDisposition).not.toBe("spam_excluded");
  });

  it("an emergency found later still beats an earlier spam mark", async () => {
    await start("late-emergency");
    await service.markSpam({ tenantId: "demo", providerCallId: "late-emergency", fromNumber: "+15555550177", category: "robocall", callerQuote: "Press one to lower your rate" });
    const call = await service.finalize({
      webhookEventId: "end:late-emergency", tenantId: "demo", providerCallId: "late-emergency", fromNumber: "+15555550177",
      startedAt: "2026-01-15T08:00:00.000Z", endedAt: clock.now().toISOString(), durationSeconds: 40,
      fields: { ...noFields, problemDescription: "My carbon monoxide alarm is going off" }, transcript: null, recordingUrl: null, consentState: "unknown",
    });
    expect(call.billingDisposition).toBe("billable");
    expect(call.outcome).toBe("handoff_queued");
  });

  it("tells the assistant to wrap up once the call passes five minutes", async () => {
    await start("long");
    const save = () => service.saveIntake({ tenantId: "demo", providerCallId: "long", fromNumber: "+15555550177", fields: { problemDescription: "Furnace short cycling" } });
    expect((await save()).wrap_up).toBe(false);
    clock.advance(299_000);
    expect((await save()).wrap_up).toBe(false);
    clock.advance(1_000);
    expect((await save()).wrap_up).toBe(true);
  });
});

describe("mark-spam tool endpoint", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  const toolToken = "tool-token-abcdefghijklmnopqrstuvwxyz";

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: toolToken, PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => new Date("2026-01-15T08:00:00.000Z") }, integrations: { Demo: true }, logger: () => undefined }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it("requires tool auth and a known category, then marks the call", async () => {
    const body = JSON.stringify({ provider_call_id: "robo", from_number: "+15555550177", category: "robocall", caller_quote: "This is an important message about your vehicle warranty" });
    expect((await fetch(`${baseUrl}/tools/mark-spam`, { method: "POST", body })).status).toBe(401);
    const headers = { authorization: `Bearer ${toolToken}`, "content-type": "application/json" };
    const bad = await fetch(`${baseUrl}/tools/mark-spam`, { method: "POST", headers, body: JSON.stringify({ provider_call_id: "robo", from_number: "+15555550177", category: "customer", caller_quote: "x" }) });
    expect(bad.status).toBe(400);
    const response = await fetch(`${baseUrl}/tools/mark-spam`, { method: "POST", headers, body });
    expect(response.status).toBe(200);
    expect((await response.json() as { status: string }).status).toBe("marked");
    expect((await store.getCallByProviderId("robo"))?.billingDisposition).toBe("spam_excluded");
  });
});

/** A fake Telnyx number inventory with per-number voice settings. */
function fakeNumbers(numbers: Array<{ id: string; phone: string; screening: string; reference?: string }>) {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    requests.push({ method, url, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    const parsed = new URL(url);
    if (parsed.pathname === "/v2/phone_numbers" && parsed.searchParams.has("filter[phone_number]")) {
      const phone = parsed.searchParams.get("filter[phone_number]");
      return json({ data: numbers.filter((entry) => entry.phone === phone).map((entry) => ({ id: entry.id, phone_number: entry.phone })) });
    }
    if (parsed.pathname === "/v2/phone_numbers") {
      return json({ data: numbers.map((entry) => ({ id: entry.id, phone_number: entry.phone, customer_reference: entry.reference ?? null })), meta: { total_pages: 1 } });
    }
    const voice = /^\/v2\/phone_numbers\/([^/]+)\/voice$/.exec(parsed.pathname);
    const entry = voice ? numbers.find((item) => item.id === voice[1]) : undefined;
    if (entry && method === "GET") return json({ data: { id: entry.id, inbound_call_screening: entry.screening } });
    if (entry && method === "PATCH") {
      entry.screening = String(body?.inbound_call_screening);
      return json({ data: { id: entry.id, inbound_call_screening: entry.screening } });
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  }) as typeof fetch;
  return { fetcher, requests, numbers };
}

describe("inbound call screening", () => {
  it("provisioning sets inbound_call_screening=reject_calls on the shop's number, once", async () => {
    const telnyx = fakeNumbers([{ id: "num-1", phone: "+19415550123", screening: "disabled" }]);
    const provisioner = new TelnyxProvisioner({ apiKey: "k", templateAssistantId: "t", messagingProfileId: "mp", fetcher: telnyx.fetcher });
    expect((await provisioner.enableCallScreening("+19415550123")).action).toBe("set");
    const patch = telnyx.requests.find((request) => request.method === "PATCH")!;
    expect(new URL(patch.url).pathname).toBe("/v2/phone_numbers/num-1/voice");
    expect(patch.body).toEqual({ inbound_call_screening: "reject_calls" });
    expect((await provisioner.enableCallScreening("+19415550123")).action).toBe("already_set");
    expect(telnyx.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("a dry run reads the current setting and never writes", async () => {
    const telnyx = fakeNumbers([{ id: "num-1", phone: "+19415550123", screening: "flag_calls" }]);
    const result = await ensureInboundCallScreening({ apiKey: "k", phoneNumber: "+19415550123", apply: false, fetcher: telnyx.fetcher });
    expect(result).toMatchObject({ action: "would_set", current: "flag_calls" });
    expect(telnyx.requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("the ops script dry-run prints planned changes for our numbers only and writes nothing", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig("shop-a"));
    await store.saveConfig(createDemoConfig("shop-b"));
    await store.saveIntegrationSecret("shop-a", "telnyx", "inbound_number", "+19415550101");
    await store.saveIntegrationSecret("shop-b", "telnyx", "inbound_number", "+19415550102");
    const telnyx = fakeNumbers([
      { id: "a", phone: "+19415550101", screening: "disabled", reference: "front-office:shop-a" },
      { id: "b", phone: "+19415550102", screening: "reject_calls", reference: "front-office:shop-b" },
      { id: "demo", phone: "+15555550199", screening: "disabled" },
      { id: "orphan", phone: "+19415550103", screening: "disabled", reference: "front-office:deleted-shop" },
      { id: "other", phone: "+13125550100", screening: "disabled", reference: "lovebug" },
    ]);
    const lines: string[] = [];
    const report = await runEnableCallScreening({ apply: false, apiKey: "k", store, demoNumber: "+15555550199", fetcher: telnyx.fetcher, print: (line) => lines.push(line) });
    expect(report.mode).toBe("dry_run");
    expect(report.summary).toEqual({ total: 4, alreadySet: 1, toChange: 3, changed: 0, notFound: 0, failed: 0 });
    expect(lines).toContain("+19415550101 (shop_line, telnyx_account): would change disabled -> reject_calls");
    expect(lines).toContain("+19415550102 (shop_line, telnyx_account): already reject_calls, no change");
    expect(lines).toContain("+15555550199 (demo_line): would change disabled -> reject_calls");
    expect(lines).toContain("+19415550103 (telnyx_account): would change disabled -> reject_calls");
    expect(lines.join("\n")).not.toContain("+13125550100");
    expect(lines.at(-1)).toContain("Dry run: nothing was written");
    expect(telnyx.requests.some((request) => request.method !== "GET")).toBe(false);

    const applied = await runEnableCallScreening({ apply: true, apiKey: "k", store, demoNumber: "+15555550199", fetcher: telnyx.fetcher, print: () => undefined });
    expect(applied.summary).toMatchObject({ changed: 3, alreadySet: 1, failed: 0 });
    expect(telnyx.numbers.find((entry) => entry.id === "other")!.screening).toBe("disabled");
  });
});
