import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { InMemoryCalendar, InMemoryStore } from "../../src/adapters/in-memory.js";
import { TelnyxProviderCallHistory, TelnyxRecordingClient } from "../../src/adapters/telnyx.js";
import { CallRecovery } from "../../src/application/call-recovery.js";
import { CallService } from "../../src/application/call-service.js";
import { loadEnvironment } from "../../src/config/environment.js";
import { createDemoConfig } from "../../src/domain/config.js";
import type { BusinessConfig } from "../../src/domain/models.js";
import { createRequestHandler } from "../../src/http/app.js";
import type { ApiDashboard } from "../../src/http/owner-api-model.js";

/** Everything here is synthetic: 555 numbers, invented names, a made-up address. */
export const CALLER = "+15555550110";
export const LINE = "+19415550123";
export const BASE = "https://front-office.example";

export class TestClock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value); }
  advance(seconds: number): void { this.value = new Date(this.value.getTime() + seconds * 1000); }
  iso(offsetSeconds = 0): string { return new Date(this.value.getTime() + offsetSeconds * 1000).toISOString(); }
}

export interface HistoryMessage {
  role: string;
  text: string | null;
  sent_at?: string;
  created_at?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

type CallStatus = { is_alive: boolean; call_duration?: number; end_time?: string } | "gone" | "error";

/**
 * Telnyx as a shop's line sees it: the provisioning calls go-live makes, each assistant's own TeXML app, a call's
 * status, its stored AI conversation (paged), and its recordings. Every request is recorded.
 */
export function fakeTelnyx() {
  const requests: Array<{ method: string; path: string; search: URLSearchParams; body: Record<string, unknown> | null }> = [];
  const owned = new Map<string, { id: string; connection_id: string | null }>();
  const texmlApps = new Map<string, Record<string, unknown>>();
  const calls = new Map<string, CallStatus>();
  const conversations = new Map<string, { id: string; messages: HistoryMessage[]; lastMessageAt: string; endUser: string }>();
  const recordings = new Set<string>();
  const state = { pageSize: 100 as number, conversationsDown: false, newestFirst: false };
  let assistants = 0;
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    const path = decodeURIComponent(url.pathname);
    requests.push({ method, path, search: url.searchParams, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/v2/ai/assistants/template-assistant" && method === "GET") return json({ data: { id: "template-assistant", model: "synthetic/model", voice_settings: { voice: "synthetic-voice" }, telephony_settings: { default_texml_app_id: "texml-template-assistant" } } });
    if (path === "/v2/ai/assistants" && method === "POST") {
      assistants += 1;
      return json({ data: { id: `assistant-${assistants}` } });
    }
    const assistant = /^\/v2\/ai\/assistants\/(assistant-\d+)$/.exec(path);
    if (assistant) return json({ data: { id: assistant[1], telephony_settings: { default_texml_app_id: `texml-${assistant[1]}` } } });
    const texml = /^\/v2\/texml_applications\/(texml-[a-z0-9-]+)$/.exec(path);
    if (texml) {
      const app = texmlApps.get(texml[1]!) ?? { id: texml[1], friendly_name: `ai-${texml[1]}`, voice_url: "https://api.telnyx.com/v2/texml/ai_assistant", status_callback: null, status_callback_method: "post", call_cost_in_webhooks: false };
      texmlApps.set(texml[1]!, app);
      if (method === "PATCH") Object.assign(app, body);
      return json({ data: app });
    }
    if (path === "/v2/available_phone_numbers") return json({ data: [{ phone_number: LINE }] });
    if (path === "/v2/number_orders" && method === "POST") {
      owned.set(LINE, { id: "num-1", connection_id: null });
      return json({ data: { id: "order-1", status: "success" } });
    }
    if (path === "/v2/phone_numbers" && method === "GET") {
      const record = owned.get(url.searchParams.get("filter[phone_number]") ?? "");
      return json({ data: record ? [{ id: record.id, phone_number: LINE, connection_id: record.connection_id }] : [] });
    }
    if (path === "/v2/phone_numbers/num-1/voice") return json({ data: { id: "num-1", inbound_call_screening: method === "PATCH" ? body?.inbound_call_screening : "disabled" } });
    if (path === "/v2/phone_numbers/num-1" && method === "PATCH") {
      owned.get(LINE)!.connection_id = (body?.connection_id as string | null) ?? null;
      return json({ data: { connection_id: owned.get(LINE)!.connection_id } });
    }
    if (path === "/v2/10dlc/phone_number_campaigns") return json({ phoneNumber: body?.phoneNumber });
    if (path.startsWith("/v2/number_lookup/")) return json({ data: { carrier: { name: "Verizon Wireless", type: "mobile" }, portability: { line_type: "mobile" } } });

    const call = /^\/v2\/calls\/([^/]+)$/.exec(path);
    if (call && method === "GET") {
      const status = calls.get(call[1]!) ?? "gone";
      if (status === "error") return json({ errors: [{ code: "10007", detail: "upstream" }] }, 500);
      if (status === "gone") return json({ errors: [{ code: "10005", detail: "Resource not found" }] }, 404);
      return json({ data: { record_type: "call", call_control_id: call[1], ...status } });
    }
    if (path === "/v2/ai/conversations" && method === "GET") {
      if (state.conversationsDown) return json({ errors: [{ detail: "upstream" }] }, 503);
      const wanted = (url.searchParams.get("metadata->call_control_id") ?? "").replace(/^eq\./, "");
      const found = conversations.get(wanted);
      return json({ data: found ? [{ id: found.id, name: "", created_at: found.messages[0]?.sent_at ?? found.lastMessageAt, last_message_at: found.lastMessageAt, metadata: { call_control_id: wanted, telnyx_end_user_target: found.endUser, telnyx_agent_target: LINE, assistant_id: "assistant-1", telnyx_conversation_channel: "phone_call" } }] : [] });
    }
    const messages = /^\/v2\/ai\/conversations\/([^/]+)\/messages$/.exec(path);
    if (messages && method === "GET") {
      const found = [...conversations.values()].find((item) => item.id === messages[1]);
      if (!found) return json({ errors: [{ detail: "not found" }] }, 404);
      const page = Number(url.searchParams.get("page[number]") ?? "1");
      const size = Math.min(Number(url.searchParams.get("page[size]") ?? "20"), state.pageSize);
      const ordered = state.newestFirst ? [...found.messages].reverse() : found.messages;
      return json({ data: ordered.slice((page - 1) * size, page * size), meta: { total_pages: Math.max(1, Math.ceil(ordered.length / size)), total_results: ordered.length, page_number: page, page_size: size } });
    }
    if (path === "/v2/recordings" && method === "GET") {
      const id = url.searchParams.get("filter[call_control_id]") ?? "";
      return json({ data: recordings.has(id) ? [{ id: `rec-${id}`, download_urls: { mp3: "https://recordings.example/synthetic.mp3" } }] : [] });
    }
    const recording = /^\/v2\/recordings\/rec-(.+)$/.exec(path);
    if (recording && method === "DELETE") {
      recordings.delete(recording[1]!);
      return json({ data: {} });
    }
    throw new Error(`Unexpected outbound request in test: ${method} ${path}`);
  }) as typeof fetch;
  return {
    fetcher, requests, owned, texmlApps, calls, recordings, state,
    /** Telnyx kept this call's conversation. */
    keepConversation(callId: string, messages: HistoryMessage[], lastMessageAt: string, endUser = CALLER): void {
      conversations.set(callId, { id: `conv-${callId.replace(/[^a-z0-9]/gi, "")}`, messages, lastMessageAt, endUser });
    },
    forgetConversation(callId: string): void { conversations.delete(callId); },
    historyRequests: () => requests.filter((request) => request.path.startsWith("/v2/ai/conversations") || request.path.startsWith("/v2/calls/")),
  };
}

/** How Telnyx signs every webhook and tool call: Ed25519 over "timestamp|body". */
export function signed(body: string, privateKey: KeyObject, now: Date, contentType = "application/json"): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  return { "content-type": contentType, "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64") };
}

/**
 * A caller whose AC stopped cooling, as Telnyx stores the conversation (role, text, tool_calls, sent_at). The
 * tool arguments carry nulls for unset fields, as the provider sends them. `intakeFailed`: the save failed
 * mid-call (the walk), so only this history knows the name and address.
 */
export function acConversation(callId: string, startedAt: string, options: { intakeFailed?: boolean } = {}): HistoryMessage[] {
  const at = (seconds: number) => new Date(Date.parse(startedAt) + seconds * 1000).toISOString();
  const common = { provider_call_id: callId, from_number: CALLER };
  return [
    { role: "assistant", text: "Thanks for calling Gulf Air. How can I help?", sent_at: at(2) },
    { role: "user", text: "Hi, my AC stopped cooling this morning.", sent_at: at(9) },
    { role: "assistant", text: null, sent_at: at(10), tool_calls: [{ id: "tool-1", type: "function", function: { name: "triage_call", arguments: JSON.stringify({ ...common, caller_name: null, problem_description: "AC stopped cooling this morning", llm_score: 0.1, llm_reason: null }) } }] },
    { role: "tool", text: JSON.stringify({ ok: true, severity: "routine", emergency: false }), tool_call_id: "tool-1", sent_at: at(11) },
    { role: "assistant", text: "Sorry to hear that. Can I get your name and the address?", sent_at: at(12) },
    { role: "user", text: "It's Dana Miller, 100 Main Street in Sarasota.", sent_at: at(21) },
    { role: "assistant", text: null, sent_at: at(22), tool_calls: [{ id: "tool-2", type: "function", function: { name: "save_intake", arguments: JSON.stringify({ ...common, caller_name: "Dana Miller", company_name: null, callback_number: null, service_address: "100 Main Street, Sarasota FL", service_category: "HVAC repair", service_category_confidence: 0.9, problem_description: "AC stopped cooling this morning", equipment_details: null, access_notes: null, diagnostic_fee_accepted: null, human_requested: null, confidence: 0.9, recording_disclosure_given: null, recording_disclosure_declined: null }) } }] },
    { role: "tool", text: JSON.stringify(options.intakeFailed ? { ok: false, status: "unavailable" } : { status: "saved", missing: [] }), tool_call_id: "tool-2", sent_at: at(23) },
    { role: "assistant", text: "Thanks, Dana. The owner will call you back shortly.", sent_at: at(25) },
    { role: "user", text: "Okay, thanks, bye.", sent_at: at(30) },
  ];
}

/** The same conversation as the end-of-call callback carries it (role, content, timestamp). */
export function callbackMessages(history: HistoryMessage[]): Array<Record<string, unknown>> {
  return history.map((message) => ({
    role: message.role,
    ...(message.text === null ? {} : { content: message.text }),
    ...(message.sent_at ? { timestamp: message.sent_at } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  }));
}

/**
 * A paid shop that went live through the real go-live route (its own assistant and number), ready to take
 * signed provider webhooks. `recovery` is wired as server.ts wires it: its own CallService on the same store.
 */
export async function liveShop(options: { config?: Partial<BusinessConfig>; startAt?: string; env?: Record<string, string> } = {}) {
  const telnyx = fakeTelnyx();
  const store = new InMemoryStore();
  const calendar = new InMemoryCalendar();
  await store.saveConfig(createDemoConfig());
  const clock = new TestClock(new Date(options.startAt ?? "2026-11-23T15:00:00.000Z"));
  const keys = generateKeyPairSync("ed25519");
  const rawPublicKey = (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
  const logs: Array<Record<string, unknown>> = [];
  const env = loadEnvironment({
    NODE_ENV: "production", DEMO_MODE: "false", PROVIDER_TEST_MODE: "false",
    PUBLIC_BASE_URL: BASE, ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz",
    SESSION_SIGNING_KEY: "session-signing-key-abcdefghijklmnopqrstuvwxyz",
    DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    TELNYX_API_KEY: "KEY_synthetic", TELNYX_PUBLIC_KEY: rawPublicKey, TELNYX_FROM_NUMBER: "+15555550199",
    TELNYX_MESSAGING_PROFILE_ID: "00000000-0000-4000-8000-000000000001", TELNYX_ASSISTANT_ID: "template-assistant",
    TELNYX_MESSAGING_APPROVED: "true", LIVE_PROVIDER_PROOF_AT: "2026-11-01T00:00:00Z",
    STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_PRICE_ID: "price_synthetic", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_abcdefghijklmnopqrstuvwxyz",
    GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic",
    OWNER_DESTINATIONS_JSON: "{\"owner-primary\":\"+15555550100\"}",
    ...options.env,
  });
  const handler = createRequestHandler({ env, store, calendar, clock, integrations: {}, logger: (entry) => { logs.push(entry); }, fetcher: telnyx.fetcher });
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const signup = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: form, body: new URLSearchParams({ businessName: "Gulf Air", email: "owner@synthetic.example", password: "synthetic-password-42", consent: "yes", phone: "9415550199", ownerSmsConsent: "yes" }) });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  const account = (await store.getOwnerAccountByEmail("owner@synthetic.example"))!;
  const tenantId = account.tenantId;
  await store.saveConfig({ ...await store.getConfig(tenantId), serviceAreaTerms: ["Sarasota FL"], ownerNotificationRefs: ["owner-primary"], ...options.config });
  await store.saveIntegrationSecret(tenantId, "google", "refresh_token", "synthetic-refresh");
  const stamp = clock.iso(-3600);
  await store.saveSubscription({ tenantId, providerCustomerId: "cus_1", providerSubscriptionId: "sub_1", status: "active", currentPeriodEnd: null, providerEventCreatedAt: stamp, createdAt: stamp, updatedAt: stamp });
  const page = await (await fetch(`${baseUrl}/app`, { headers: { cookie } })).text();
  const csrf = /action="\/app\/line\/go-live"><input type="hidden" name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
  const live = await fetch(`${baseUrl}/app/line/go-live`, { method: "POST", redirect: "manual", headers: { cookie, ...form }, body: new URLSearchParams({ csrf }) });
  if (live.headers.get("location") !== "/app?line=live") throw new Error(`go-live failed: ${live.status} ${live.headers.get("location")}`);

  const service = new CallService(store, calendar, clock, BASE, { callbackLinkKey: env.SESSION_SIGNING_KEY ?? null });
  const recovery = new CallRecovery(store, service, new TelnyxProviderCallHistory("KEY_synthetic", telnyx.fetcher), clock, {
    publicBaseUrl: BASE, recordings: new TelnyxRecordingClient("KEY_synthetic", telnyx.fetcher), log: (entry) => { logs.push(entry); },
  });

  /** The signed assistant.initialization webhook Telnyx sends when the shop's assistant answers. */
  const init = async (callId: string, from: string | null = CALLER): Promise<Response> => {
    const body = JSON.stringify({ data: { record_type: "event", event_type: "assistant.initialization", id: `evt-init-${callId}`, occurred_at: clock.iso(), payload: { telnyx_conversation_channel: "phone_call", telnyx_agent_target: LINE, ...(from ? { telnyx_end_user_target: from } : {}), call_control_id: callId, assistant_id: "assistant-1" } } });
    return fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(body, keys.privateKey, clock.now()), body });
  };
  /** A signed voice-tool webhook, as the assistant calls it mid-call. */
  const tool = async (route: string, callId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const body = JSON.stringify({ provider_call_id: callId, ...args });
    const response = await fetch(`${baseUrl}/tools/${route}`, { method: "POST", headers: { ...signed(body, keys.privateKey, clock.now()), "x-telnyx-call-control-id": callId }, body });
    return await response.json() as Record<string, unknown>;
  };
  /** The signed, form-encoded TeXML status callback Telnyx posts when the conversation ends. */
  const callEnded = async (callId: string, messages: Array<Record<string, unknown>>, durationSec: number): Promise<Response> => {
    const body = new URLSearchParams({ CallStatus: "conversation_ended", CallSid: callId, CallSessionId: `session-${callId}`, ConversationId: `conv-${callId}`, DurationSec: String(durationSec), Messages: JSON.stringify(messages) }).toString();
    return fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(body, keys.privateKey, clock.now(), "application/x-www-form-urlencoded"), body });
  };
  const dashboard = async (): Promise<ApiDashboard> => await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as ApiDashboard;
  const callDetail = async (id: string): Promise<Record<string, unknown>> => await (await fetch(`${baseUrl}/api/app/calls/${id}`, { headers: { cookie } })).json() as Record<string, unknown>;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { baseUrl, cookie, store, calendar, clock, telnyx, tenantId, account, env, logs, handler, service, recovery, init, tool, callEnded, dashboard, callDetail, close, privateKey: keys.privateKey };
}

export type LiveShop = Awaited<ReturnType<typeof liveShop>>;
