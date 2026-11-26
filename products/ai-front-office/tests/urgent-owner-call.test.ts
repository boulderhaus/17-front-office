import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { ownerAlertClientState, ownerAlertState, TelnyxOwnerCallSender, type OwnerAlertState } from "../src/adapters/telnyx-owner-call.js";
import { OWNER_CALL_CONSENT_KEY, OWNER_CALL_CONSENT_SIGNUP_LABEL, OWNER_CALL_CONSENT_SIGNUP_VERSION } from "../src/domain/owner-call-consent.js";
import { CallService } from "../src/application/call-service.js";
import { urgentCallSpeech, urgentOwnerCallNotification } from "../src/application/owner-alerts.js";
import { loadEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { CollectedCallFields } from "../src/domain/models.js";
import { createRequestHandler } from "../src/http/app.js";
import { NotificationHeldError } from "../src/ports.js";
import { shopStepPage } from "./signup-steps.js";

const now = new Date("2026-11-23T15:00:00.000Z");
const clock = { now: () => now };
const fields: CollectedCallFields = {
  callerName: "Maria Gonzalez", companyName: null, callbackNumber: "+15555550142", address: "41 Palm Ave, Sarasota, FL", serviceCategory: "HVAC repair", serviceCategoryConfidence: 0.9,
  problemDescription: "no AC", equipmentDetails: null, accessNotes: null, requestedStart: "2026-11-23T19:00:00.000Z", explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: false, confidence: 0.9,
};

describe("urgent calls ring the owner", () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = null; });

  it("says who, what and when in plain words", () => {
    const speech = urgentCallSpeech({ fields, emergency: { emergency: true, severity: "urgent", score: 0.9, evidence: ["no AC"], immediateInstruction: null } }, "Wants someone today");
    expect(speech).toBe("Otto here: urgent call from Maria, no AC, wants someone today. Check your Call Otto app.");
    expect(urgentCallSpeech({ fields: { ...fields, callerName: null, problemDescription: "" }, emergency: { emergency: true, severity: "life_safety", score: 1, evidence: ["gas smell"], immediateInstruction: null } }, null))
      .toBe("Otto here: urgent call from a caller, gas smell. Check your Call Otto app.");
  });

  it("queues one call per urgent call to an owner-app shop with a mobile number, never for routine calls", async () => {
    const store = new InMemoryStore();
    const tenantId = "shop_urgent";
    await store.createOwnerWorkspace({
      account: { id: randomUUID(), tenantId, email: "owner@example.test", displayName: "Owner", passwordHash: "synthetic", role: "owner", status: "active", createdAt: now.toISOString(), updatedAt: now.toISOString() },
      config: { ...createDemoConfig(tenantId), timezone: "America/New_York", ownerNotificationRefs: [] },
      ownerPhone: "+15555550100",
    });
    const service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example", { urgentCallAvailable: true });
    await store.saveIntegrationSecret(tenantId, "notifications", OWNER_CALL_CONSENT_KEY, JSON.stringify({ at: now.toISOString(), phone: "+15555550100" }));
    const end = (id: string, problemDescription: string, llmEmergencyScore?: number) => service.finalize({
      webhookEventId: `end:${id}`, tenantId, providerCallId: id, fromNumber: "+15555550142", startedAt: "2026-11-23T14:50:00.000Z", endedAt: now.toISOString(), durationSeconds: 95,
      fields: { ...fields, problemDescription }, transcript: `Caller: ${problemDescription}`, recordingUrl: null, consentState: "disclosed",
      ...(llmEmergencyScore === undefined ? {} : { llmEmergencyScore, llmEmergencyReason: "gas smell" }),
    });
    await end("routine-1", "Annual AC tune-up");
    expect([...store.notifications.values()].some((item) => item.channel === "voice")).toBe(false);
    await service.queueHumanHandoff({ tenantId, providerCallId: "urgent-1", fromNumber: "+15555550142", callerName: "Maria Gonzalez", problemDescription: "Gas smell in the kitchen", urgent: { emergency: true, severity: "life_safety", score: 1, evidence: ["gas smell"], immediateInstruction: null } });
    await end("urgent-1", "Gas smell in the kitchen", 0.99);
    const calls = [...store.notifications.values()].filter((item) => item.channel === "voice");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ destinationRef: "owner-primary", priority: "high" });
    expect(calls[0]!.body).toMatch(/^Otto here: urgent call from Maria, Gas smell in the kitchen/);
  });

  it("dials the owner from our number, carries the words in client state, holds past three an hour and in test mode", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: { call_control_id: `v3:owner-${posted.length}` } }), { status: 200 });
    }) as unknown as typeof fetch;
    const claims = new InMemoryStore();
    const options = { apiKey: "KEY", connectionId: "check-connection", from: "+15555550199", webhookUrl: "https://front-office.example/webhooks/telnyx", clock, fetcher, resolveDestination: async () => "+15555550100", claimDial: (key: string) => claims.claimWebhook(key), hasConsent: async () => true };
    const sender = new TelnyxOwnerCallSender(options);
    const notification = (callId: string) => urgentOwnerCallNotification({ tenantId: "shop", callId, speech: "Otto here: urgent call from Maria, no AC. Check your Call Otto app.", now: now.toISOString() });
    const receipts = [];
    for (const id of ["a", "b", "c"]) receipts.push((await sender.send(notification(id))).providerReceipt);
    expect(new Set(receipts).size).toBe(3);
    // A retried notification never rings the owner a second time, even on another sender (replica).
    await expect(new TelnyxOwnerCallSender(options).send(notification("a"))).rejects.toBeInstanceOf(NotificationHeldError);
    expect(posted).toHaveLength(3);
    await expect(sender.send(notification("d"))).rejects.toBeInstanceOf(NotificationHeldError);
    expect(posted[0]).toMatchObject({ connection_id: "check-connection", to: "+15555550100", from: "+15555550199", webhook_url: "https://front-office.example/webhooks/telnyx" });
    expect(ownerAlertState(posted[0]!.client_state)).toEqual({ tenantId: "shop", speech: "Otto here: urgent call from Maria, no AC. Check your Call Otto app.", phase: "dial" });
    expect(ownerAlertState(Buffer.from("forwarding-check:shop").toString("base64"))).toBeNull();
    // No recorded consent (never agreed, or pressed 9 since): never dialed.
    await expect(new TelnyxOwnerCallSender({ ...options, hasConsent: async () => false }).send(notification("g"))).rejects.toThrow("not agreed");
    const testMode = new TelnyxOwnerCallSender({ ...options, allowedDestinations: new Set(["+15555550111"]) });
    await expect(testMode.send(notification("e"))).rejects.toBeInstanceOf(NotificationHeldError);
    // A dial that times out may have rung anyway: held, never retried.
    const slow = new TelnyxOwnerCallSender({ ...options, fetcher: (async () => { throw new Error("timeout"); }) as unknown as typeof fetch });
    await expect(slow.send(notification("f"))).rejects.toBeInstanceOf(NotificationHeldError);
    await expect(slow.send(notification("f"))).rejects.toThrow("already dialed");
  });

  it("reads the summary with a press-9 opt-out when the owner answers, from signed webhooks only", async () => {
    const keys = generateKeyPairSync("ed25519");
    const rawPublicKey = (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
    const actions: Array<{ url: string; body: Record<string, unknown> }> = [];
    let refuseSpeak = false;
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      actions.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      if (refuseSpeak && /\/(speak|gather_using_speak)$/.test(String(input))) return new Response("{}", { status: 422 });
      return new Response(JSON.stringify({ data: { result: "ok" } }), { status: 200 });
    }) as typeof fetch;
    const env = loadEnvironment({
      NODE_ENV: "production", DEMO_MODE: "false", PUBLIC_BASE_URL: "https://front-office.example",
      ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", SESSION_SIGNING_KEY: "session-signing-key-abcdefghijklmnopqrstuvwxyz",
      DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      TELNYX_API_KEY: "KEY_synthetic", TELNYX_PUBLIC_KEY: rawPublicKey, TELNYX_FROM_NUMBER: "+15555550199", TELNYX_CHECK_CONNECTION_ID: "check-connection",
    });
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined, fetcher }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const tenantId = "shop_consent";
    await store.saveIntegrationSecret(tenantId, "notifications", OWNER_CALL_CONSENT_KEY, JSON.stringify({ at: "2026-11-23T14:00:00.000Z", phone: "+15555550100" }));
    const state = (phase: OwnerAlertState["phase"]) => ownerAlertClientState({ tenantId, speech: "Otto here: urgent call from Maria, no AC. Check your Call Otto app.", phase });
    const post = (eventType: string, id: string, options: { key?: KeyObject; phase?: OwnerAlertState["phase"]; digits?: string } = {}) => {
      const body = JSON.stringify({ data: { record_type: "event", event_type: eventType, id, occurred_at: now.toISOString(), payload: { call_control_id: "v3:owner-1", client_state: state(options.phase ?? "dial"), ...(options.digits === undefined ? {} : { digits: options.digits }) } } });
      const timestamp = String(Math.floor(now.getTime() / 1_000));
      return fetch(`http://127.0.0.1:${address.port}/webhooks/telnyx`, { method: "POST", headers: { "content-type": "application/json", "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": sign(null, Buffer.from(`${timestamp}|${body}`), options.key ?? keys.privateKey).toString("base64") }, body });
    };
    expect((await post("call.answered", "evt-forged", { key: generateKeyPairSync("ed25519").privateKey })).status).toBe(401);
    expect(actions).toHaveLength(0);
    // A refused gather answers 502 so Telnyx redelivers; the redelivery reads it (same command_id, so never twice).
    refuseSpeak = true;
    expect((await post("call.answered", "evt-answered")).status).toBe(502);
    refuseSpeak = false;
    expect((await post("call.answered", "evt-answered")).status).toBe(200);
    const gather = actions[actions.length - 1]!;
    expect(gather.url).toBe("https://api.telnyx.com/v2/calls/v3%3Aowner-1/actions/gather_using_speak");
    expect(gather.body).toMatchObject({ command_id: "evt-answered", valid_digits: "9", maximum_digits: 1 });
    expect(String(gather.body.payload)).toContain("urgent call from Maria, no AC");
    expect(String(gather.body.payload)).toMatch(/To stop these calls, press 9\.$/);
    expect(ownerAlertState(gather.body.client_state)?.phase).toBe("gather");
    // Speech events while gathering never hang up early.
    await post("call.speak.ended", "evt-gather-speak", { phase: "gather" });
    expect(actions).toHaveLength(2);
    // Nothing pressed: hang up, consent kept.
    await post("call.gather.ended", "evt-no-digits", { phase: "gather", digits: "" });
    expect(actions[actions.length - 1]!.url).toBe("https://api.telnyx.com/v2/calls/v3%3Aowner-1/actions/hangup");
    expect(await store.getIntegrationSecret(tenantId, "notifications", OWNER_CALL_CONSENT_KEY)).not.toBeNull();
    // Pressed 9: consent removed, confirmation spoken, then hang up.
    await post("call.gather.ended", "evt-nine", { phase: "gather", digits: "9" });
    expect(await store.getIntegrationSecret(tenantId, "notifications", OWNER_CALL_CONSENT_KEY)).toBeNull();
    const bye = actions[actions.length - 1]!;
    expect(bye.url).toBe("https://api.telnyx.com/v2/calls/v3%3Aowner-1/actions/speak");
    expect(String(bye.body.payload)).toContain("won't call you about emergencies anymore");
    expect(await store.getIntegrationSecret(tenantId, "notifications", "owner_call_consent_log")).toContain("keypad");
    // The owner turns calls back on; a redelivered old keypress never turns them off again.
    await store.saveIntegrationSecret(tenantId, "notifications", OWNER_CALL_CONSENT_KEY, JSON.stringify({ at: new Date(now.getTime() + 60_000).toISOString(), phone: "+15555550100" }));
    await post("call.gather.ended", "evt-nine", { phase: "gather", digits: "9" });
    expect(await store.getIntegrationSecret(tenantId, "notifications", OWNER_CALL_CONSENT_KEY)).not.toBeNull();
    await post("call.speak.ended", "evt-bye", { phase: "bye" });
    expect(actions[actions.length - 1]!.url).toBe("https://api.telnyx.com/v2/calls/v3%3Aowner-1/actions/hangup");
    expect(await store.listCalls("demo", 10)).toHaveLength(0);
  });
});

describe("consent to automated emergency calls", () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = null; });

  it("is an unchecked box at signup, recorded with its wording version, and a switch in Settings", async () => {
    const keys = generateKeyPairSync("ed25519");
    const rawPublicKey = (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
    const env = loadEnvironment({
      NODE_ENV: "production", DEMO_MODE: "false", PUBLIC_BASE_URL: "https://front-office.example",
      ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", SESSION_SIGNING_KEY: "session-signing-key-abcdefghijklmnopqrstuvwxyz",
      DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      TELNYX_API_KEY: "KEY_synthetic", TELNYX_PUBLIC_KEY: rawPublicKey, TELNYX_FROM_NUMBER: "+15555550199", TELNYX_CHECK_CONNECTION_ID: "check-connection",
    });
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    const form = await shopStepPage(base);
    expect(form).toMatch(/<input name="ownerCallConsent" type="checkbox" value="yes" >/);
    // One short line at signup (who calls, automated voice, why, optional, how to stop); Settings keeps the full text.
    expect(form).toContain(`<span>${OWNER_CALL_CONSENT_SIGNUP_LABEL}</span></label></div>`);
    expect(OWNER_CALL_CONSENT_SIGNUP_LABEL).toMatch(/automated voice.*emergency.*Optional; press 9 to stop\./);
    const signup = async (email: string, extra: Record<string, string>) => {
      const response = await fetch(`${base}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Gulf Air", email, password: "synthetic-password-42", consent: "yes", phone: "9415550199", ...extra }) });
      const account = (await store.getOwnerAccountByEmail(email))!;
      return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, tenantId: account.tenantId };
    };
    const yes = await signup("yes@consent.example", { ownerCallConsent: "yes" });
    expect(JSON.parse((await store.getIntegrationSecret(yes.tenantId, "notifications", OWNER_CALL_CONSENT_KEY))!)).toMatchObject({ source: "signup", wording: OWNER_CALL_CONSENT_SIGNUP_VERSION });
    const no = await signup("no@consent.example", {});
    expect(await store.getIntegrationSecret(no.tenantId, "notifications", OWNER_CALL_CONSENT_KEY)).toBeNull();
    const settings = await (await fetch(`${base}/api/app/settings`, { headers: { cookie: no.cookie } })).json() as { csrf: string; urgentCalls: { available: boolean; on: boolean; disclosure: string } };
    expect(settings.urgentCalls).toMatchObject({ available: true, on: false });
    expect(settings.urgentCalls.disclosure).toContain("artificial-voice");
    const toggle = (on: boolean) => fetch(`${base}/api/app/alerts/urgent-calls`, { method: "POST", headers: { cookie: no.cookie, "content-type": "application/json", "x-csrf-token": settings.csrf }, body: JSON.stringify({ on }) });
    expect(await (await toggle(true)).json()).toMatchObject({ urgentCalls: { available: true, on: true } });
    expect(JSON.parse((await store.getIntegrationSecret(no.tenantId, "notifications", OWNER_CALL_CONSENT_KEY))!)).toMatchObject({ source: "settings" });
    // Consent belongs to the number: a new mobile is never called without a new yes.
    await store.saveIntegrationSecret(no.tenantId, "notifications", "owner-primary", "+19415550111");
    expect((await (await fetch(`${base}/api/app/settings`, { headers: { cookie: no.cookie } })).json() as { urgentCalls: { on: boolean } }).urgentCalls.on).toBe(false);
    await store.saveIntegrationSecret(no.tenantId, "notifications", "owner-primary", "+19415550199");
    expect(await (await toggle(false)).json()).toMatchObject({ urgentCalls: { available: true, on: false } });
    expect(await store.getIntegrationSecret(no.tenantId, "notifications", "owner_call_consent_log")).toContain("settings");
    expect(await store.getIntegrationSecret(no.tenantId, "notifications", OWNER_CALL_CONSENT_KEY)).toBeNull();
    expect(await (await fetch(`${base}/terms`)).text()).toContain("press 9 during any of these calls");
  });
});
