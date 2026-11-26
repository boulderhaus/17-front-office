import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { GraceLineService, queueOwnerMessage } from "../src/application/grace-line.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";

const DAY = 24 * 60 * 60_000;
const LINE = "+15555550188";
const CALLER = "+15555550123";
const secret = "whsec_synthetic_abcdefghijklmnopqrstuvwxyz";

async function harness(options: { voicemail?: boolean } = { voicemail: true }) {
  let now = new Date("2026-11-21T18:00:00.000Z");
  const clock = { now: () => now };
  const api = { status: "active", tenant: null as string | null };
  const telnyx = { connectionId: "texml_assistant" as string | null, released: [] as string[], patchGate: null as Promise<void> | null, onPatch: null as (() => void) | null, recordings: [] as string[], recordingDeleteFails: false };
  const calls: Array<{ url: string; method: string }> = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    const subscription = /api\.stripe\.com\/v1\/subscriptions\/([^?/]+)/.exec(url);
    if (subscription) return json({ id: subscription[1], status: api.status, customer: "cus_synthetic", metadata: { tenant_id: api.tenant }, items: { data: [{ price: { id: "price_synthetic" }, current_period_end: 1_766_400_000 }] } });
    if (url.endsWith("/v2/ai/assistants/assistant_synthetic") && method === "GET") return json({ data: { telephony_settings: { default_texml_app_id: "texml_assistant" } } });
    if (url.endsWith("/v2/ai/assistants/assistant_synthetic") && method === "DELETE") { telnyx.released.push("assistant"); return json({}); }
    if (url.includes("api.telnyx.com/v2/phone_numbers?")) return json({ data: telnyx.released.includes("number") ? [] : [{ id: "num_synthetic", phone_number: LINE, connection_id: telnyx.connectionId }] });
    if (url.endsWith("/v2/phone_numbers/num_synthetic") && method === "PATCH") {
      telnyx.onPatch?.();
      if (telnyx.patchGate) await telnyx.patchGate;
      telnyx.connectionId = (JSON.parse(String(init?.body)) as { connection_id: string | null }).connection_id;
      return json({ data: { connection_id: telnyx.connectionId } });
    }
    if (url.endsWith("/v2/phone_numbers/num_synthetic") && method === "DELETE") { telnyx.released.push("number"); return json({}); }
    if (url.includes("api.telnyx.com/v2/recordings?") && method === "GET") return json({ data: telnyx.recordings.map((id) => ({ id })) });
    const recording = /api\.telnyx\.com\/v2\/recordings\/([^?/]+)$/.exec(url);
    if (recording && method === "DELETE") {
      if (telnyx.recordingDeleteFails) return json({ errors: [{ detail: "synthetic outage" }] }, 503);
      telnyx.recordings = telnyx.recordings.filter((id) => id !== recording[1]);
      return json({});
    }
    throw new Error(`Unexpected outbound request in test: ${method} ${url}`);
  }) as typeof fetch;

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const env = demoEnvironment({
    PUBLIC_BASE_URL: "https://front-office.example.test",
    STRIPE_WEBHOOK_SECRET: secret, STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_PRICE_ID: "price_synthetic",
    TELNYX_API_KEY: "KEY_synthetic",
    TELNYX_PUBLIC_KEY: (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64"),
    ...(options.voicemail ? { TELNYX_VOICEMAIL_APP_ID: "texml_voicemail" } : {}),
  });
  const store = new InMemoryStore();
  await store.saveConfig(createDemoConfig());
  const server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined, fetcher }));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const signup = await fetch(`${baseUrl}/signup`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ businessName: "Synthetic Heating", email: "grace@example.test", password: "synthetic-password-42", consent: "yes", phone: "5555550199", ownerSmsConsent: "yes" }),
  });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  const account = (await store.getOwnerAccountByEmail("grace@example.test"))!;
  const tenantId = account.tenantId;
  api.tenant = tenantId;
  await store.updateOwnerAccountStatus(account.id, "active", now.toISOString());
  await store.saveProviderRoute({ provider: "telnyx", externalId: "assistant_synthetic", tenantId, createdAt: now.toISOString(), updatedAt: now.toISOString() });
  await store.saveIntegrationSecret(tenantId, "telnyx", "inbound_number", LINE);
  await store.saveIntegrationSecret(tenantId, "telnyx", "provisioned_assistant_id", "assistant_synthetic");
  await store.saveConfig({ ...(await store.getConfig(tenantId)), paused: false });

  let sequence = 0;
  const stripeEvent = (type: string) => {
    sequence += 1;
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const raw = JSON.stringify({ id: `evt_${sequence}`, type, created: Number(timestamp), data: { object: { id: "sub_synthetic", customer: "cus_synthetic", status: "incomplete", metadata: { tenant_id: tenantId } } } });
    const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
    return fetch(`${baseUrl}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body: raw });
  };
  const setStatus = async (status: string) => { api.status = status; return stripeEvent("customer.subscription.updated"); };
  const telnyxPost = (pathAndQuery: string, form: Record<string, string>, signed = true) => {
    const body = new URLSearchParams(form).toString();
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (signed) {
      headers["telnyx-timestamp"] = timestamp;
      headers["telnyx-signature-ed25519"] = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64");
    }
    return fetch(`${baseUrl}${pathAndQuery}`, { method: "POST", headers, body });
  };
  const sweep = new GraceLineService({ store, env, clock, fetcher, log: () => undefined });
  const outbox = (prefix: string) => [...store.notifications.values()].filter((item) => item.idempotencyKey.startsWith(prefix));
  const advance = (ms: number) => { now = new Date(now.getTime() + ms); };
  const close = async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };
  await setStatus("active");
  return { store, env, tenantId, account, cookie, baseUrl, telnyx, calls, setStatus, telnyxPost, sweep, outbox, advance, close };
}

/** The callback URL the voicemail TeXML hands Telnyx, as a path + query on our server. */
function callbackPath(texml: string, attribute: "transcriptionCallback" | "recordingStatusCallback"): string {
  const match = new RegExp(`${attribute}="([^"]+)"`).exec(texml);
  const url = new URL(match![1]!.replace(/&amp;/g, "&"));
  return `${url.pathname}${url.search}`;
}

describe("billing grace line", () => {
  it("moves a lapsed shop's number to the voicemail app instead of disconnecting it", async () => {
    const h = await harness();
    try {
      expect((await h.setStatus("past_due")).status).toBe(200);
      expect(h.telnyx.connectionId).toBe("texml_voicemail");
      expect(await h.store.getConfig(h.tenantId)).toMatchObject({ paused: true, pausedForBilling: true });
      expect(await h.store.getIntegrationSecret(h.tenantId, "billing", "grace_started_at")).toBe("2026-11-21T18:00:00.000Z");
      expect(await h.store.getTenantIdByInboundNumber(LINE)).toBe(h.tenantId);
      const lapse = h.outbox("billing-lapse:");
      expect(lapse).toHaveLength(1);
      expect(lapse[0]!.body).toContain("go to voicemail");
      expect(lapse[0]!.body).toContain("30 days");
      expect(lapse[0]!.body).toContain("or to stop forwarding");
      // A repeat lapse event keeps the original grace start and sends nothing new.
      h.advance(60_000);
      await h.setStatus("canceled");
      expect(await h.store.getIntegrationSecret(h.tenantId, "billing", "grace_started_at")).toBe("2026-11-21T18:00:00.000Z");
      expect(h.outbox("billing-lapse:")).toHaveLength(1);
    } finally { await h.close(); }
  });

  it("answers the number with the shop's name and a recording, and hangs up on unknown numbers", async () => {
    const h = await harness();
    try {
      await h.setStatus("past_due");
      const answered = await h.telnyxPost("/texml/voicemail", { CallSid: "call_synthetic_1", From: CALLER, To: LINE });
      expect(answered.status).toBe(200);
      expect(answered.headers.get("content-type")).toContain("application/xml");
      const texml = await answered.text();
      expect(texml).toContain("<Say>You&apos;ve reached Synthetic Heating. We can&apos;t get to the phone right now.");
      expect(texml).toMatch(/<Record [^>]*maxLength="120"[^>]*playBeep="true"/);
      expect(texml).toContain('transcription="true"');
      expect(callbackPath(texml, "transcriptionCallback")).toContain("/texml/voicemail/transcription?t=");
      // Telnyx's default instruction fetch is an unsigned GET; it still gets the greeting.
      const viaGet = await fetch(`${h.baseUrl}/texml/voicemail?${new URLSearchParams({ CallSid: "call_synthetic_2", To: LINE })}`);
      expect(await viaGet.text()).toContain("Synthetic Heating");
      const unknown = await (await h.telnyxPost("/texml/voicemail", { CallSid: "call_synthetic_3", From: CALLER, To: "+15555550111" })).text();
      expect(unknown).toContain("<Hangup/>");
      expect(unknown).not.toContain("<Record");
      expect((await h.telnyxPost("/texml/voicemail/done", { CallSid: "call_synthetic_1" })).status).toBe(200);
    } finally { await h.close(); }
  });

  it("texts the owner one transcript per voicemail, cancels the no-transcript fallback, and rejects forged callbacks", async () => {
    const h = await harness();
    try {
      await h.setStatus("past_due");
      const texml = await (await h.telnyxPost("/texml/voicemail", { CallSid: "call_synthetic_1", From: CALLER, To: LINE })).text();
      const recording = callbackPath(texml, "recordingStatusCallback");
      const transcription = callbackPath(texml, "transcriptionCallback");
      expect((await h.telnyxPost(recording, { CallSid: "call_synthetic_1", RecordingSid: "rec_1", RecordingStatus: "completed" })).status).toBe(200);
      const fallback = h.outbox("voicemail-fallback:");
      expect(fallback).toHaveLength(1);
      expect(fallback[0]!.nextAttemptAt > new Date("2026-11-21T18:00:00.000Z").toISOString()).toBe(true);

      const form = { CallSid: "call_synthetic_1", RecordingSid: "rec_1", From: CALLER, TranscriptionText: `Hi, this is Pat. Our furnace stopped overnight and the house is cold. ${"Please call back. ".repeat(20)}` };
      expect((await h.telnyxPost(transcription, form)).status).toBe(200);
      expect((await h.telnyxPost(transcription, form)).status).toBe(200); // Telnyx retry
      const sent = h.outbox("voicemail:");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.channel).toBe("sms");
      expect(sent[0]!.body).toContain("Call Otto voicemail for Synthetic Heating: (555) 555-0123 said: “Hi, this is Pat. Our furnace stopped");
      expect(sent[0]!.body).toContain("…”");
      expect(sent[0]!.body).toContain("Your Call Otto plan is paused; to stop forwarding");
      expect(h.outbox("voicemail-fallback:")[0]!.state).toBe("cancelled");

      // Unsigned, or bound to another call, is refused and queues nothing.
      expect((await h.telnyxPost(transcription, form, false)).status).toBe(401);
      expect((await h.telnyxPost(transcription, { ...form, CallSid: "call_synthetic_other" })).status).toBe(403);
      expect(h.outbox("voicemail:")).toHaveLength(1);
    } finally { await h.close(); }
  });

  it("never queues a fallback when the transcript arrives before the recording callback", async () => {
    const h = await harness();
    try {
      await h.setStatus("past_due");
      const texml = await (await h.telnyxPost("/texml/voicemail", { CallSid: "call_synthetic_9", From: CALLER, To: LINE })).text();
      await h.telnyxPost(callbackPath(texml, "transcriptionCallback"), { CallSid: "call_synthetic_9", From: CALLER, TranscriptionText: "" });
      await h.telnyxPost(callbackPath(texml, "recordingStatusCallback"), { CallSid: "call_synthetic_9", RecordingStatus: "completed" });
      expect(h.outbox("voicemail-fallback:")).toHaveLength(0);
      expect(h.outbox("voicemail:")[0]!.body).toContain("left a message with no words we could make out");
    } finally { await h.close(); }
  });

  it("sends one day-23 reminder and releases the number and assistant once on day 30", async () => {
    const h = await harness();
    try {
      await h.setStatus("canceled");
      h.advance(22 * DAY);
      expect(await h.sweep.runOnce()).toEqual({ reminded: 0, released: 0 });
      h.advance(1 * DAY);
      expect((await h.sweep.runOnce()).reminded).toBe(1);
      await h.sweep.runOnce();
      h.advance(DAY);
      await h.sweep.runOnce();
      const reminders = h.outbox("grace-reminder:");
      expect(reminders).toHaveLength(1);
      expect(reminders[0]!.body).toContain("Otto: in 7 days your Call Otto number for Synthetic Heating stops working");
      expect(reminders[0]!.body).toContain("to stop forwarding");
      expect(h.telnyx.released).toEqual([]);

      h.advance(6 * DAY);
      expect((await h.sweep.runOnce()).released).toBe(1);
      expect(await h.sweep.runOnce()).toEqual({ reminded: 0, released: 0 });
      expect(h.telnyx.released.sort()).toEqual(["assistant", "number"]);
      expect(h.calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
      expect(await h.store.getIntegrationSecret(h.tenantId, "telnyx", "inbound_number")).toBeNull();
      expect(await h.store.getIntegrationSecret(h.tenantId, "billing", "grace_started_at")).toBeNull();
      expect((await h.store.getOwnerAccountByTenant(h.tenantId))?.status).toBe("pending_activation");
      // Paying after release does not try to reconnect a number that no longer exists.
      expect((await h.setStatus("active")).status).toBe(200);
    } finally { await h.close(); }
  });

  it("reconnects the number to the assistant and ends grace when payment comes back", async () => {
    const h = await harness();
    try {
      await h.setStatus("past_due");
      expect(h.telnyx.connectionId).toBe("texml_voicemail");
      h.advance(10 * DAY);
      expect((await h.setStatus("active")).status).toBe(200);
      expect(h.telnyx.connectionId).toBe("texml_assistant");
      expect(await h.store.getConfig(h.tenantId)).toMatchObject({ paused: false, pausedForBilling: false });
      expect(await h.store.getIntegrationSecret(h.tenantId, "billing", "grace_started_at")).toBeNull();
      h.advance(25 * DAY);
      expect(await h.sweep.runOnce()).toEqual({ reminded: 0, released: 0 });
      expect(h.telnyx.released).toEqual([]);
    } finally { await h.close(); }
  });

  it("keeps the line when payment lands while the day-30 sweep is waiting to release it", async () => {
    const h = await harness();
    try {
      await h.setStatus("past_due");
      h.advance(31 * DAY);
      let openGate!: () => void;
      h.telnyx.patchGate = new Promise<void>((resolve) => { openGate = resolve; });
      const reconnectStarted = new Promise<void>((resolve) => { h.telnyx.onPatch = resolve; });
      const restoring = h.setStatus("active");
      await reconnectStarted; // restore holds the billing lock, mid-reconnect
      const sweeping = h.sweep.runOnce(); // saw grace before restore cleared it
      await new Promise((resolve) => setTimeout(resolve, 50));
      openGate();
      expect((await restoring).status).toBe(200);
      expect(await sweeping).toEqual({ reminded: 0, released: 0 });
      expect(h.telnyx.released).toEqual([]);
      expect(h.telnyx.connectionId).toBe("texml_assistant");
      expect(await h.store.getIntegrationSecret(h.tenantId, "telnyx", "inbound_number")).toBe(LINE);
      expect((await h.store.getOwnerAccountByTenant(h.tenantId))?.status).toBe("active");
    } finally { await h.close(); }
  });

  it("does not finish grace when the line cannot be released, and retries on the next sweep", async () => {
    const h = await harness();
    try {
      await h.setStatus("past_due");
      h.advance(31 * DAY);
      const noKey = new GraceLineService({ store: h.store, env: { ...h.env, TELNYX_API_KEY: undefined }, clock: { now: () => new Date(Date.parse("2026-11-21T18:00:00.000Z") + 31 * DAY) }, log: () => undefined });
      expect(await noKey.runOnce()).toEqual({ reminded: 0, released: 0 });
      expect(await h.store.getIntegrationSecret(h.tenantId, "telnyx", "inbound_number")).toBe(LINE);
      expect(await h.store.getIntegrationSecret(h.tenantId, "billing", "grace_started_at")).not.toBeNull();
      expect(h.telnyx.connectionId).toBe("texml_voicemail");
      expect((await h.sweep.runOnce()).released).toBe(1);
      expect(h.telnyx.released.sort()).toEqual(["assistant", "number"]);
    } finally { await h.close(); }
  });

  it("takes a number we did not provision off the voicemail app on day 30 without deleting it", async () => {
    const h = await harness();
    try {
      await h.store.deleteIntegrationSecret(h.tenantId, "telnyx", "provisioned_assistant_id");
      await h.setStatus("past_due");
      expect(h.telnyx.connectionId).toBe("texml_voicemail");
      h.advance(31 * DAY);
      expect((await h.sweep.runOnce()).released).toBe(1);
      expect(h.telnyx.connectionId).toBeNull();
      expect(h.telnyx.released).toEqual([]);
    } finally { await h.close(); }
  });

  it("cancels a voicemail fallback that is waiting to retry, and a queued reminder when payment clears grace", async () => {
    const h = await harness();
    try {
      await h.setStatus("past_due");
      const texml = await (await h.telnyxPost("/texml/voicemail", { CallSid: "call_synthetic_5", From: CALLER, To: LINE })).text();
      await h.telnyxPost(callbackPath(texml, "recordingStatusCallback"), { CallSid: "call_synthetic_5", RecordingStatus: "completed" });
      const fallback = h.outbox("voicemail-fallback:")[0]!;
      await h.store.saveNotification({ ...fallback, state: "retry", attempts: 1 });
      await h.telnyxPost(callbackPath(texml, "transcriptionCallback"), { CallSid: "call_synthetic_5", From: CALLER, TranscriptionText: "Please call me back." });
      expect(h.outbox("voicemail-fallback:")[0]!.state).toBe("cancelled");

      h.advance(23 * DAY);
      await h.sweep.runOnce();
      expect(h.outbox("grace-reminder:")[0]!.state).toBe("pending");
      await h.setStatus("active");
      expect(h.outbox("grace-reminder:")[0]!.state).toBe("cancelled");
    } finally { await h.close(); }
  });

  it("still disconnects and releases right away when the owner deletes the account during grace", async () => {
    const h = await harness();
    try {
      await h.setStatus("canceled");
      const page = await (await fetch(`${h.baseUrl}/app/settings`, { headers: { cookie: h.cookie } })).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
      const deleted = await fetch(`${h.baseUrl}/app/account/delete`, {
        method: "POST", redirect: "manual", headers: { cookie: h.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, confirm: "DELETE", password: "synthetic-password-42" }),
      });
      expect(deleted.status).toBe(303);
      expect(h.telnyx.connectionId).toBeNull();
      expect(h.telnyx.released.sort()).toEqual(["assistant", "number"]);
    } finally { await h.close(); }
  });

  it("keeps the line when a recording can't be deleted, so deleting again works", async () => {
    const h = await harness();
    try {
      await h.setStatus("canceled");
      const at = "2026-11-21T18:00:00.000Z";
      await h.store.saveCall({
        id: "33333333-3333-4333-8333-333333333333", tenantId: h.tenantId, providerCallId: "v3:recorded-call", fromNumber: CALLER, fromNumberVerified: true,
        startedAt: at, endedAt: at, durationSeconds: 60,
        fields: { callerName: null, companyName: null, callbackNumber: null, address: null, serviceCategory: null, serviceCategoryConfidence: 0, problemDescription: null, equipmentDetails: null, accessNotes: null, requestedStart: null, explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: false, confidence: 0 },
        emergency: null, outcome: "message_taken", transcript: null, recordingUrl: "https://recordings.example.test/1.mp3", consentState: "disclosed",
        billingDisposition: "billable", qualityFlags: [], createdAt: at, updatedAt: at,
      } as never);
      h.telnyx.recordings = ["rec_synthetic"];
      h.telnyx.recordingDeleteFails = true;
      const page = await (await fetch(`${h.baseUrl}/app/settings`, { headers: { cookie: h.cookie } })).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
      const remove = () => fetch(`${h.baseUrl}/app/account/delete`, {
        method: "POST", redirect: "manual", headers: { cookie: h.cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, confirm: "DELETE", password: "synthetic-password-42" }),
      });
      expect((await remove()).status).toBe(502);
      expect(h.telnyx.released).toEqual([]);
      expect(await h.store.getOwnerAccountByEmail("grace@example.test")).not.toBeNull();

      h.telnyx.recordingDeleteFails = false;
      expect((await remove()).status).toBe(303);
      expect(h.telnyx.recordings).toEqual([]);
      expect(h.telnyx.released.sort()).toEqual(["assistant", "number"]);
      expect(await h.store.getOwnerAccountByEmail("grace@example.test")).toBeNull();
    } finally { await h.close(); }
  });

  it("keeps today's disconnect when no voicemail app is configured", async () => {
    const h = await harness({ voicemail: false });
    try {
      await h.setStatus("past_due");
      expect(h.telnyx.connectionId).toBeNull();
      expect(await h.store.getIntegrationSecret(h.tenantId, "billing", "grace_started_at")).toBeNull();
      expect(h.outbox("billing-lapse:")[0]!.body).toContain("will not be answered");
      h.advance(31 * DAY);
      expect(await h.sweep.runOnce()).toEqual({ reminded: 0, released: 0 });
    } finally { await h.close(); }
  });
});

describe("owner message routing", () => {
  it("emails the owner when no owner number can receive texts", async () => {
    const store = new InMemoryStore();
    const env = demoEnvironment({ RESEND_API_KEY: "re_synthetic_key", RESEND_FROM_EMAIL: "alerts@example.test" });
    await store.createOwnerWorkspace({
      config: { ...createDemoConfig("shop_mail"), ownerNotificationRefs: [] }, ownerPhone: null,
      account: { id: "00000000-0000-4000-8000-0000000000aa", tenantId: "shop_mail", email: "owner@example.test", displayName: "Owner", passwordHash: "x", status: "active", createdAt: "2026-11-21T18:00:00.000Z", updatedAt: "2026-11-21T18:00:00.000Z" },
    });
    const context = { store, env, clock: { now: () => new Date("2026-11-21T18:00:00.000Z") }, log: () => undefined };
    const result = await queueOwnerMessage(context, { tenantId: "shop_mail", sms: "Voicemail text", emailSubject: "New voicemail", idempotencyBase: "voicemail:shop_mail:call_1" });
    expect(result).toMatchObject({ channel: "email", queued: 1 });
    expect([...store.notifications.values()][0]).toMatchObject({ channel: "email", destinationRef: "email:owner@example.test" });
    expect((await queueOwnerMessage(context, { tenantId: "shop_mail", sms: "Voicemail text", emailSubject: "New voicemail", idempotencyBase: "voicemail:shop_mail:call_1" })).queued).toBe(0);
  });
});
