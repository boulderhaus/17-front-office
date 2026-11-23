import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { callerReputation } from "../src/adapters/telnyx.js";
import { callScreeningSetting, ensureInboundCallScreening, TelnyxProvisioner } from "../src/adapters/telnyx-provisioning.js";
import { CallService } from "../src/application/call-service.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { CollectedCallFields } from "../src/domain/models.js";
import { createRequestHandler } from "../src/http/app.js";
import { usageClass } from "../src/domain/usage.js";
import type { Clock } from "../src/ports.js";
import { buildTelnyxAssistantUpdate, buildTelnyxGreeting, buildTelnyxTools, buildVoiceSystemPrompt } from "../src/voice/system-prompt.js";
import { runEnableCallScreening } from "../scripts/enable-call-screening.js";
import { planAssistantPushes } from "../scripts/configure-telnyx.js";

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
    expect(prompt).toContain('If it returns status=marked, say exactly "Sorry, this line is only for service calls. Goodbye." and invoke the built-in hangup tool in the same turn');
    expect(prompt).toContain("Never use mark_spam_call for a possible customer");
    expect(prompt).toContain("an emergency or safety concern, or an existing customer");
    expect(prompt).toContain("When unsure, continue the call normally.");
  });

  it("uses the carrier's spam flag only to check intent sooner, never to hang up", () => {
    expect(prompt).toContain("The carrier's caller reputation is {{caller_reputation}}.");
    expect(prompt).toContain("If it is likely_spam, do the service-call check on the caller's first turn.");
    expect(prompt).toContain("Never hang up because of caller reputation alone");
    const update = buildTelnyxAssistantUpdate(config, "https://front-office.example") as { dynamic_variables: Record<string, unknown> };
    expect(update.dynamic_variables.caller_reputation).toBe("unknown");
  });

  it("checks in once on silence, then says goodbye and hangs up", () => {
    expect(prompt).toContain('If the caller goes silent, ask once, "Are you still there?"');
    expect(prompt).toContain('say "I\'ll let you go. Goodbye.", and invoke the built-in hangup tool in the same turn');
  });

  it("wraps up at five minutes and targets a two-minute, one-question-at-a-time intake", () => {
    expect(prompt).toContain("Any tool may return wrap_up=true once the call has run about five minutes");
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

describe("caller reputation from Telnyx call screening (flag mode)", () => {
  it("reads the flag from the initialization payload, if Telnyx sends one", () => {
    expect(callerReputation({})).toBe("unknown");
    expect(callerReputation({ call_screening_result: "spam_likely" })).toBe("likely_spam");
    expect(callerReputation({ call_screening_result: { action: "flag_calls", reputation: "spam_likely", shaken_stir_attestation: "A" } })).toBe("likely_spam");
    expect(callerReputation({ call_screening_result: { action: "flag_calls", reputation: "clean" } })).toBe("unknown");
    expect(callerReputation({ caller_id_name: "SPAM LIKELY" })).toBe("likely_spam");
    expect(callerReputation({ telnyx_end_user_target_name: "Spam Likely" })).toBe("likely_spam");
    expect(callerReputation({ caller_id_name: "JANE DOE" })).toBe("unknown");
  });
});

describe("spam-intent tool", () => {
  let store: InMemoryStore;
  let clock: MutableClock;
  let service: CallService;
  const start = (id: string, fromNumber = "+15555550177") => service.recordStarted({ eventId: `start:${id}`, tenantId: "demo", providerCallId: id, fromNumber, startedAt: clock.now().toISOString() });
  const mark = (id: string, callerQuote = "I'm calling about your Google business listing", fromNumber = "+15555550177") => service.markSpam({ tenantId: "demo", providerCallId: id, fromNumber, category: "sales", callerQuote });
  const finalize = (id: string, fields: Partial<CollectedCallFields> = {}, fromNumber = "+15555550177") => service.finalize({
    webhookEventId: `end:${id}`, tenantId: "demo", providerCallId: id, fromNumber,
    startedAt: "2026-01-15T08:00:00.000Z", endedAt: clock.now().toISOString(), durationSeconds: 25,
    fields: { ...noFields, ...fields }, transcript: "Hi, I'm calling about your Google business listing.", recordingUrl: null, consentState: "unknown",
  });
  const stored = async (id: string) => (await store.getCallByProviderId(id))!;

  beforeEach(async () => {
    store = new InMemoryStore();
    clock = new MutableClock(new Date("2026-01-15T08:00:00.000Z"));
    await store.saveConfig({ ...createDemoConfig(), ownerRealtimeSmsEnabled: true, customerSmsEnabled: true, ownerNotificationRefs: ["owner-primary"] });
    service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example");
  });

  it("marks the call spam_excluded, keeps it out of usage, alerts and callbacks", async () => {
    await start("seo-pitch");
    const pre = await stored("seo-pitch");
    await store.saveCall({ ...pre, qualityFlags: ["caller_id_unverified"] });
    expect((await mark("seo-pitch")).status).toBe("marked");
    expect(await stored("seo-pitch")).toMatchObject({ billingDisposition: "spam_excluded", outcome: "ignored_spam" });
    expect((await stored("seo-pitch")).qualityFlags).toEqual(["caller_id_unverified", "spam_excluded"]);
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

  it.each([
    ["problem", { problemDescription: "Furnace is making a noise" }],
    ["category", { serviceCategory: "HVAC repair" }],
    ["name", { callerName: "Pat" }],
    ["callback", { callbackNumber: "+15555550123" }],
    ["address", { address: "100 Main St, Springfield, IL" }],
  ] as Array<[string, Partial<CollectedCallFields>]>)("refuses once any lead field is captured (%s)", async (id, fields) => {
    await start(id);
    await store.saveCall({ ...await stored(id), fields: { ...noFields, ...fields } });
    expect((await mark(id)).status).toBe("continue");
    expect((await stored(id)).billingDisposition).not.toBe("spam_excluded");
  });

  it("refuses an emergency quote, a past caller, and an unknown caller ID, ignoring the tool's from_number", async () => {
    await start("gas");
    expect((await mark("gas", "Wrong number? I smell gas in my kitchen")).status).toBe("continue");

    await store.upsertCustomer({ id: "c1", tenantId: "demo", phone: "+15555550188", name: "Past Caller", address: null, lastCallId: "x", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    await start("repeat", "+15555550188");
    // The tool claims a different number; the server uses the provider's caller ID it recorded.
    expect((await mark("repeat", "Is this the shop?", "+15555550177")).status).toBe("continue");

    await start("hidden", "unknown");
    expect((await mark("hidden", "Press one for a lower rate", "+15555550177")).status).toBe("continue");

    // No provider-recorded call at all: refuse and create nothing.
    expect((await mark("never-started")).status).toBe("continue");
    expect(await store.getCallByProviderId("never-started")).toBeNull();
  });

  it("a refusal is sticky, so a same-turn hangup still counts and reaches the owner", async () => {
    await start("refused");
    expect((await mark("refused", "My CO alarm is beeping, wrong number?")).status).toBe("continue");
    expect((await stored("refused")).qualityFlags).toContain("spam_refused");
    expect((await mark("refused", "Never mind, I'm selling SEO")).status).toBe("continue");
    const call = await finalize("refused");
    expect(call.billingDisposition).toBe("billable");
    expect(call.outcome).not.toBe("ignored_spam");
    expect(await store.getCallbackTaskForCall(call.id)).not.toBeNull();
  });

  it("an emergency or human request later in the call clears the spam mark", async () => {
    await start("then-gas");
    expect((await mark("then-gas")).status).toBe("marked");
    await service.saveIntake({ tenantId: "demo", providerCallId: "then-gas", fromNumber: "+15555550177", fields: { problemDescription: "Actually I smell gas" } });
    expect(await stored("then-gas")).not.toMatchObject({ billingDisposition: "spam_excluded" });
    expect((await stored("then-gas")).outcome).not.toBe("ignored_spam");
    expect((await stored("then-gas")).qualityFlags).not.toContain("spam_excluded");

    await start("then-human");
    expect((await mark("then-human")).status).toBe("marked");
    await service.queueHumanHandoff({ tenantId: "demo", providerCallId: "then-human", fromNumber: "+15555550177" });
    expect((await stored("then-human")).billingDisposition).not.toBe("spam_excluded");
    expect((await stored("then-human")).outcome).toBe("handoff_queued");

    await start("final-human");
    expect((await mark("final-human")).status).toBe("marked");
    const call = await finalize("final-human", { humanRequested: true });
    expect(call.billingDisposition).toBe("billable");
    expect(call.outcome).toBe("handoff_queued");
  });

  it("an emergency found at finalize still beats an earlier spam mark", async () => {
    await start("late-emergency");
    await mark("late-emergency", "Press one to lower your rate");
    const call = await finalize("late-emergency", { problemDescription: "My carbon monoxide alarm is going off" });
    expect(call.billingDisposition).toBe("billable");
    expect(call.outcome).toBe("handoff_queued");
  });

  it("tells the assistant to wrap up after five minutes, except during an emergency or human handoff", async () => {
    await start("long");
    const save = (id: string, problemDescription = "Furnace short cycling") => service.saveIntake({ tenantId: "demo", providerCallId: id, fromNumber: "+15555550177", fields: { problemDescription } });
    expect((await save("long")).wrap_up).toBe(false);
    clock.advance(299_000);
    expect((await save("long")).wrap_up).toBe(false);
    clock.advance(1_000);
    expect((await save("long")).wrap_up).toBe(true);
    expect(await service.wrapUp("long")).toBe(true);

    await start("long-gas");
    clock.advance(400_000);
    expect((await save("long-gas", "There's smoke coming from the furnace")).wrap_up).toBe(false);

    await start("long-human");
    clock.advance(400_000);
    await service.queueHumanHandoff({ tenantId: "demo", providerCallId: "long-human", fromNumber: "+15555550177" });
    expect(await service.wrapUp("long-human")).toBe(false);
  });
});

describe("tool endpoints", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  let clock: MutableClock;
  const toolToken = "tool-token-abcdefghijklmnopqrstuvwxyz";
  const headers = { authorization: `Bearer ${toolToken}`, "content-type": "application/json" };
  const post = (path: string, body: Record<string, unknown>) => fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  beforeEach(async () => {
    store = new InMemoryStore();
    clock = new MutableClock(new Date("2026-01-15T08:00:00.000Z"));
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: toolToken, PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: { Demo: true }, logger: () => undefined }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it("mark-spam requires tool auth and a known category, then marks a provider-recorded call", async () => {
    await new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example")
      .recordStarted({ eventId: "start:robo", tenantId: "demo", providerCallId: "robo", fromNumber: "+15555550177", startedAt: clock.now().toISOString() });
    const body = { provider_call_id: "robo", from_number: "+15555550177", category: "robocall", caller_quote: "This is an important message about your vehicle warranty" };
    expect((await fetch(`${baseUrl}/tools/mark-spam`, { method: "POST", body: JSON.stringify(body) })).status).toBe(401);
    expect((await post("/tools/mark-spam", { ...body, category: "customer" })).status).toBe(400);
    const response = await post("/tools/mark-spam", body);
    expect(response.status).toBe(200);
    expect((await response.json() as { status: string }).status).toBe("marked");
    expect((await store.getCallByProviderId("robo"))?.billingDisposition).toBe("spam_excluded");
  });

  it("returns wrap_up on every tool the assistant calls", async () => {
    await new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example")
      .recordStarted({ eventId: "start:long", tenantId: "demo", providerCallId: "long", fromNumber: "+15555550177", startedAt: clock.now().toISOString() });
    clock.advance(301_000);
    const id = { provider_call_id: "long" };
    const responses = {
      area: await post("/tools/check-service-area", { ...id, address: "100 Main St, Springfield, IL 62701" }),
      availability: await post("/tools/check-availability", { ...id, window_start: "2026-01-15T15:00:00Z", window_end: "2026-01-15T18:00:00Z" }),
      answer: await post("/tools/approved-answer", { ...id, kind: "answer", key: "hours" }),
      triage: await post("/tools/triage", { ...id, from_number: "+15555550177", problem_description: "Furnace is noisy" }),
      intake: await post("/tools/save-intake", { ...id, from_number: "+15555550177", problem_description: "Furnace is noisy" }),
    };
    for (const [name, response] of Object.entries(responses)) {
      expect(response.status, name).toBe(200);
      expect((await response.json() as { wrap_up?: boolean }).wrap_up, name).toBe(true);
    }
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
  it("defaults to flag mode; reject only by explicit opt-in", () => {
    expect(demoEnvironment({}).CALL_SCREENING_MODE).toBe("flag");
    expect(demoEnvironment({ CALL_SCREENING_MODE: "reject" }).CALL_SCREENING_MODE).toBe("reject");
    expect(() => demoEnvironment({ CALL_SCREENING_MODE: "drop" })).toThrow();
    expect(callScreeningSetting("flag")).toBe("flag_calls");
    expect(callScreeningSetting("reject")).toBe("reject_calls");
    expect(callScreeningSetting("off")).toBe("disabled");
  });

  it("provisioning sets the configured screening on the shop's number, once", async () => {
    const telnyx = fakeNumbers([{ id: "num-1", phone: "+19415550123", screening: "disabled" }]);
    const provisioner = new TelnyxProvisioner({ apiKey: "k", templateAssistantId: "t", messagingProfileId: "mp", fetcher: telnyx.fetcher });
    expect((await provisioner.enableCallScreening("+19415550123", "flag_calls")).action).toBe("set");
    const patch = telnyx.requests.find((request) => request.method === "PATCH")!;
    expect(new URL(patch.url).pathname).toBe("/v2/phone_numbers/num-1/voice");
    expect(patch.body).toEqual({ inbound_call_screening: "flag_calls" });
    expect((await provisioner.enableCallScreening("+19415550123", "flag_calls")).action).toBe("already_set");
    expect(telnyx.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("a dry run reads the current setting and never writes", async () => {
    const telnyx = fakeNumbers([{ id: "num-1", phone: "+19415550123", screening: "reject_calls" }]);
    const result = await ensureInboundCallScreening({ apiKey: "k", phoneNumber: "+19415550123", setting: "flag_calls", apply: false, fetcher: telnyx.fetcher });
    expect(result).toMatchObject({ action: "would_set", current: "reject_calls" });
    expect(telnyx.requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("the ops script dry-run shows the mode and planned changes for our numbers only, and writes nothing", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig("shop-a"));
    await store.saveConfig(createDemoConfig("shop-b"));
    await store.saveIntegrationSecret("shop-a", "telnyx", "inbound_number", "+19415550101");
    await store.saveIntegrationSecret("shop-b", "telnyx", "inbound_number", "+19415550102");
    const telnyx = fakeNumbers([
      { id: "a", phone: "+19415550101", screening: "disabled", reference: "front-office:shop-a" },
      { id: "b", phone: "+19415550102", screening: "flag_calls", reference: "front-office:shop-b" },
      { id: "demo", phone: "+15555550199", screening: "reject_calls" },
      { id: "orphan", phone: "+19415550103", screening: "disabled", reference: "front-office:deleted-shop" },
      { id: "other", phone: "+13125550100", screening: "disabled", reference: "lovebug" },
    ]);
    const lines: string[] = [];
    const report = await runEnableCallScreening({ apply: false, mode: "flag", apiKey: "k", store, demoNumber: "+15555550199", fetcher: telnyx.fetcher, print: (line) => lines.push(line) });
    expect(report.mode).toBe("dry_run");
    expect(report.setting).toEqual({ mode: "flag", field: "inbound_call_screening", value: "flag_calls" });
    expect(report.summary).toEqual({ total: 4, alreadySet: 1, toChange: 3, changed: 0, notFound: 0, failed: 0 });
    expect(lines[0]).toBe("Call screening mode: flag (inbound_call_screening=flag_calls). Dry run.");
    expect(lines).toContain("+19415550101 (shop_line, telnyx_account): would change disabled -> flag_calls");
    expect(lines).toContain("+19415550102 (shop_line, telnyx_account): already flag_calls, no change");
    expect(lines).toContain("+15555550199 (demo_line): would change reject_calls -> flag_calls");
    expect(lines).toContain("+19415550103 (telnyx_account): would change disabled -> flag_calls");
    expect(lines.join("\n")).not.toContain("+13125550100");
    expect(lines.at(-1)).toContain("Dry run: nothing was written");
    expect(telnyx.requests.some((request) => request.method !== "GET")).toBe(false);

    const applied = await runEnableCallScreening({ apply: true, mode: "reject", apiKey: "k", store, demoNumber: "+15555550199", fetcher: telnyx.fetcher, print: () => undefined });
    expect(applied.summary).toMatchObject({ changed: 3, alreadySet: 1, failed: 0 });
    expect(telnyx.numbers.find((entry) => entry.id === "a")!.screening).toBe("reject_calls");
    expect(telnyx.numbers.find((entry) => entry.id === "other")!.screening).toBe("disabled");
  });
});

describe("assistant config push", () => {
  it("configure-telnyx pushes the six-minute cap to the demo assistant and every shop assistant", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig("demo"));
    await store.saveConfig(createDemoConfig("shop-a"));
    await store.saveConfig(createDemoConfig("shop-b"));
    const stamp = "2026-01-01T00:00:00.000Z";
    await store.saveProviderRoute({ provider: "telnyx", externalId: "assistant-a", tenantId: "shop-a", createdAt: stamp, updatedAt: stamp });
    const plan = await planAssistantPushes({ store, defaultTenantId: "demo", demoAssistantId: "assistant-demo", publicBaseUrl: "https://front-office.example" });
    expect(plan.map((entry) => [entry.tenantId, entry.assistantId])).toEqual([["demo", "assistant-demo"], ["shop-a", "assistant-a"]]);
    for (const entry of plan) expect((entry.update.telephony_settings as { time_limit_secs: number }).time_limit_secs).toBe(360);
  });
});

