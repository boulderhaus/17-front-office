import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { forwardingInstructions, NumberUnavailableError, TelnyxProvisioner } from "../src/adapters/telnyx-provisioning.js";
import { loadEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";

type Call = { url: string; method: string; body: Record<string, unknown> | null; key: string | undefined };

/** A fake Telnyx that sells numbers, creates assistants and routes numbers, recording every request. */
function fakeTelnyx(options: { available?: Record<string, string[]>; orderStatuses?: string[]; failAssistantCreate?: boolean | undefined; failConnect?: boolean | undefined; carriers?: Record<string, { name: string; type: string }> | undefined } = {}) {
  const calls: Call[] = [];
  const orders = [...(options.orderStatuses ?? ["pending", "success"])];
  const owned = new Map<string, { id: string; connection_id: string | null; screening?: string }>();
  let assistants = 0;
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, method, body, key: (init?.headers as Record<string, string> | undefined)?.["idempotency-key"] });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.endsWith("/ai/assistants/template-assistant") && method === "GET") return json({ data: { id: "template-assistant", model: "synthetic/model", voice_settings: { voice: "synthetic-voice" } } });
    if (url.endsWith("/ai/assistants") && method === "POST") {
      if (options.failAssistantCreate) return json({ errors: [{ detail: "down" }] }, 503);
      assistants += 1;
      return json({ data: { id: `assistant-${assistants}` } });
    }
    const assistant = /\/ai\/assistants\/(assistant-\d+)$/.exec(url);
    if (assistant && method === "GET") return json({ data: { id: assistant[1], telephony_settings: { default_texml_app_id: `texml-${assistant[1]}` } } });
    if (assistant && method === "POST") return json({ data: { id: assistant[1] } });
    if (url.includes("/available_phone_numbers?")) {
      const params = new URL(url).searchParams;
      const key = params.get("filter[national_destination_code]") ?? params.get("filter[administrative_area]") ?? "any";
      return json({ data: (options.available?.[key] ?? []).map((phone_number) => ({ phone_number })) });
    }
    if (url.endsWith("/number_orders") && method === "POST") {
      const number = ((body?.phone_numbers as Array<{ phone_number: string }>)[0]!).phone_number;
      owned.set(number, { id: `num-${owned.size + 1}`, connection_id: null });
      return json({ data: { id: `order-${number}`, status: orders.shift() ?? "success" } });
    }
    if (url.includes("/number_orders/")) return json({ data: { status: orders.shift() ?? "success" } });
    if (url.includes("/phone_numbers?")) {
      const number = new URL(url).searchParams.get("filter[phone_number]")!;
      const record = owned.get(number);
      return json({ data: record ? [{ id: record.id, phone_number: number, connection_id: record.connection_id }] : [] });
    }
    const voice = /\/phone_numbers\/(num-\d+)\/voice$/.exec(url);
    if (voice) {
      const entry = [...owned.values()].find((value) => value.id === voice[1])!;
      if (method === "PATCH") entry.screening = String(body?.inbound_call_screening);
      return json({ data: { id: voice[1], inbound_call_screening: entry.screening ?? "disabled" } });
    }
    const patch = /\/phone_numbers\/(num-\d+)$/.exec(url);
    if (patch && method === "PATCH") {
      if (options.failConnect) return json({ errors: [{ detail: "Telnyx internal routing detail" }] }, 500);
      const entry = [...owned.values()].find((value) => value.id === patch[1])!;
      entry.connection_id = (body?.connection_id as string | null) ?? null;
      return json({ data: { connection_id: entry.connection_id } });
    }
    if (url.includes("/number_lookup/")) {
      const number = decodeURIComponent(/number_lookup\/([^?]+)/.exec(url)![1]!);
      const carrier = options.carriers?.[number] ?? { name: "Verizon Wireless", type: "mobile" };
      return json({ data: { phone_number: number, carrier: { name: carrier.name, type: carrier.type }, portability: { line_type: carrier.type } } });
    }
    if (url.endsWith("/v2/calls") && method === "POST") return json({ data: { call_control_id: "v3:check-call" } });
    if (/\/calls\/[^/]+\/actions\/(hangup|speak|ai_assistant_start)$/.test(url)) return json({ data: { result: "ok" } });
    if (method === "DELETE") return json({ data: {} });
    if (url.endsWith("/10dlc/phone_number_campaigns")) return json({ phoneNumber: body?.phoneNumber, campaignId: body?.campaignId });
    throw new Error(`Unexpected outbound request in test: ${method} ${url}`);
  }) as typeof fetch;
  return { calls, fetcher, owned };
}

const noSleep = async () => undefined;

describe("Telnyx self-serve provisioning", () => {
  it("prefers the owner's area code, then the shop's state, and never offers toll-free", async () => {
    const telnyx = fakeTelnyx({ available: { "941": [], FL: ["+18005550100", "+19415550123"] } });
    const provisioner = new TelnyxProvisioner({ apiKey: "k", templateAssistantId: "template-assistant", messagingProfileId: "mp", fetcher: telnyx.fetcher, sleep: noSleep });
    expect(await provisioner.findNumber({ areaCodes: ["941", "941", "123"], state: "FL" })).toBe("+19415550123");
    const searches = telnyx.calls.map((call) => new URL(call.url).searchParams);
    expect(searches[0]!.get("filter[national_destination_code]")).toBe("941");
    expect(searches).toHaveLength(2); // invalid area code "123" and the duplicate are skipped
    expect(searches[1]!.get("filter[administrative_area]")).toBe("FL");
    expect(searches[1]!.getAll("filter[features][]")).toEqual(["voice", "sms"]);
  });

  it("orders with a number-scoped idempotency key, waits for success, and flags a taken number", async () => {
    const telnyx = fakeTelnyx({ orderStatuses: ["pending", "pending", "success"] });
    const provisioner = new TelnyxProvisioner({ apiKey: "k", templateAssistantId: "template-assistant", messagingProfileId: "mp", fetcher: telnyx.fetcher, sleep: noSleep });
    await provisioner.orderNumber({ tenantId: "t1", phoneNumber: "+19415550123" });
    const order = telnyx.calls.find((call) => call.url.endsWith("/number_orders"))!;
    expect(order.key).toBe("front-office-number-t1-19415550123");
    expect(order.body).toMatchObject({ messaging_profile_id: "mp", customer_reference: "front-office:t1" });
    expect(order.body).not.toHaveProperty("connection_id"); // bought paused; activation connects it

    const failing = fakeTelnyx({ orderStatuses: ["failure"] });
    const second = new TelnyxProvisioner({ apiKey: "k", templateAssistantId: "template-assistant", messagingProfileId: "mp", fetcher: failing.fetcher, sleep: noSleep });
    await expect(second.orderNumber({ tenantId: "t1", phoneNumber: "+19415550124" })).rejects.toBeInstanceOf(NumberUnavailableError);

    // Telnyx refusing the order outright (422) also means "pick another number", not "retry this one".
    const refusing = (async () => new Response(JSON.stringify({ errors: [{ detail: "Number not available" }] }), { status: 422 })) as unknown as typeof fetch;
    const third = new TelnyxProvisioner({ apiKey: "k", templateAssistantId: "template-assistant", messagingProfileId: "mp", fetcher: refusing, sleep: noSleep });
    await expect(third.orderNumber({ tenantId: "t1", phoneNumber: "+19415550125" })).rejects.toBeInstanceOf(NumberUnavailableError);
  });

  it("creates the assistant from the template's voice and model with the shop's own prompt", async () => {
    const telnyx = fakeTelnyx();
    const provisioner = new TelnyxProvisioner({ apiKey: "k", templateAssistantId: "template-assistant", messagingProfileId: "mp", fetcher: telnyx.fetcher, sleep: noSleep });
    const id = await provisioner.createAssistant({ tenantId: "t1", businessName: "Gulf Air", assistantUpdate: { instructions: "shop prompt", promote_to_main: true } });
    expect(id).toBe("assistant-1");
    const create = telnyx.calls.find((call) => call.url.endsWith("/ai/assistants") && call.method === "POST")!;
    expect(create.key).toBe("front-office-assistant-t1");
    expect(create.body).toMatchObject({ name: "Call Otto · Gulf Air", instructions: "shop prompt", model: "synthetic/model", voice_settings: { voice: "synthetic-voice" } });
    expect(create.body).not.toHaveProperty("promote_to_main");
  });

  it("gives carrier codes that forward only missed calls unless the owner wants every call", () => {
    const missed = forwardingInstructions("+19415550123", "overflow");
    expect(missed[0]).toMatchObject({ on: "*719415550123", off: "*73" });
    expect(missed[1]).toMatchObject({ on: "**61*19415550123#", off: "##61#" });
    expect(forwardingInstructions("+19415550123", "always")[0]!.on).toBe("*729415550123");
  });
});

describe("owner one-tap go-live", () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = null; });

  async function shop(options: { live?: boolean; failAssistantCreate?: boolean | undefined; failConnect?: boolean | undefined; env?: Record<string, string>; carriers?: Record<string, { name: string; type: string }> | undefined } = {}) {
    const telnyx = fakeTelnyx({ available: { "941": ["+19415550123", "+19415550124"] }, failAssistantCreate: options.failAssistantCreate, failConnect: options.failConnect, carriers: options.carriers });
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const clock = { at: new Date("2026-11-23T15:00:00Z"), now() { return this.at; } };
    const keys = generateKeyPairSync("ed25519");
    const rawPublicKey = (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
    const env = loadEnvironment({
      NODE_ENV: "production", DEMO_MODE: "false", PROVIDER_TEST_MODE: options.live === false ? "true" : "false",
      PUBLIC_BASE_URL: "https://front-office.example", ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz",
      SESSION_SIGNING_KEY: "session-signing-key-abcdefghijklmnopqrstuvwxyz",
      DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      TELNYX_API_KEY: "KEY_synthetic", TELNYX_PUBLIC_KEY: rawPublicKey, TELNYX_FROM_NUMBER: "+15555550199",
      TELNYX_MESSAGING_PROFILE_ID: "00000000-0000-4000-8000-000000000001", TELNYX_ASSISTANT_ID: "template-assistant",
      TELNYX_CAMPAIGN_ID: "campaign-synthetic", TELNYX_MESSAGING_APPROVED: "true", LIVE_PROVIDER_PROOF_AT: "2026-11-01T00:00:00Z",
      STRIPE_SECRET_KEY: "sk_test_synthetic_abcdefghijklmnopqrstuvwxyz", STRIPE_PRICE_ID: "price_synthetic", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_abcdefghijklmnopqrstuvwxyz",
      GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic",
      OWNER_DESTINATIONS_JSON: "{\"owner-primary\":\"+15555550100\"}",
      ...options.env,
    });
    const handler = createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined, fetcher: telnyx.fetcher });
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const signup = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Gulf Air", email: "owner@synthetic.example", password: "synthetic-password-42", consent: "yes", phone: "9415550199", ownerSmsConsent: "yes" }) });
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const account = (await store.getOwnerAccountByEmail("owner@synthetic.example"))!;
    const config = await store.getConfig(account.tenantId);
    await store.saveConfig({ ...config, serviceAreaTerms: ["Sarasota FL"], ownerNotificationRefs: ["owner-primary"] });
    await store.saveIntegrationSecret(account.tenantId, "google", "refresh_token", "synthetic-refresh");
    const stamp = "2026-11-23T14:00:00.000Z";
    await store.saveSubscription({ tenantId: account.tenantId, providerCustomerId: "cus_1", providerSubscriptionId: "sub_1", status: "active", currentPeriodEnd: null, providerEventCreatedAt: stamp, createdAt: stamp, updatedAt: stamp });
    const page = await (await fetch(`${baseUrl}/app`, { headers: { cookie } })).text();
    const csrf = /action="\/app\/line\/go-live"><input type="hidden" name="csrf" value="([^"]+)"/.exec(page)?.[1];
    const goLive = () => fetch(`${baseUrl}/app/line/go-live`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: csrf ?? "" }) });
    return { baseUrl, cookie, csrf, goLive, store, account, telnyx, privateKey: keys.privateKey, clock, handler, env };
  }

  it("buys a local number, creates and routes the shop's assistant, and shows forwarding codes", async () => {
    const { baseUrl, cookie, csrf, goLive, store, account, telnyx } = await shop();
    expect(csrf).toBeTruthy();
    const response = await goLive();
    expect(response.headers.get("location")).toBe("/app?line=live");
    expect((await store.getOwnerAccountById(account.id))!.status).toBe("active");
    expect(await store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number")).toBe("+19415550123");
    expect((await store.getProviderRoute("telnyx", "assistant-1"))?.tenantId).toBe(account.tenantId);
    expect(telnyx.owned.get("+19415550123")!.connection_id).toBe("texml-assistant-1");
    expect(telnyx.calls.some((call) => call.url.endsWith("/10dlc/phone_number_campaigns") && call.body?.phoneNumber === "+19415550123")).toBe(true);
    // Carrier screening flags spam by default (never drops a possible emergency caller).
    const screening = telnyx.calls.find((call) => call.method === "PATCH" && call.url.endsWith("/phone_numbers/num-1/voice"));
    expect(screening?.body).toEqual({ inbound_call_screening: "flag_calls" });
    // The six-minute cap ships with every new shop assistant, not only via the prompt.
    const created = telnyx.calls.find((call) => call.method === "POST" && call.url.endsWith("/ai/assistants"));
    expect((created?.body?.telephony_settings as { time_limit_secs?: number } | undefined)?.time_limit_secs).toBe(420);
    const dashboard = await (await fetch(`${baseUrl}/app`, { headers: { cookie } })).text();
    expect(dashboard).toContain("(941) 555-0123");
    // New shops start on "Otto answers every call".
    expect(dashboard).toContain("*729415550123");

    // A second tap never buys another number or assistant.
    const purchases = () => telnyx.calls.filter((call) => call.method === "POST" && (call.url.endsWith("/number_orders") || call.url.endsWith("/ai/assistants"))).length;
    const before = purchases();
    await goLive();
    expect(purchases()).toBe(before);
  });

  it("gives the number and assistant back to Telnyx when the shop deletes its account", async () => {
    const { baseUrl, cookie, goLive, store, account, telnyx } = await shop();
    await goLive();
    const stamp = "2026-11-23T14:30:00.000Z";
    await store.saveSubscription({ tenantId: account.tenantId, providerCustomerId: "cus_1", providerSubscriptionId: "sub_1", status: "canceled", currentPeriodEnd: null, providerEventCreatedAt: stamp, createdAt: stamp, updatedAt: stamp });
    const settings = await (await fetch(`${baseUrl}/app/settings`, { headers: { cookie } })).text();
    const csrf = /action="\/app\/account\/delete"><input type="hidden" name="csrf" value="([^"]+)"/.exec(settings)![1]!;
    const deleted = await fetch(`${baseUrl}/app/account/delete`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, confirm: "DELETE", password: "synthetic-password-42" }) });
    expect(deleted.headers.get("location")).toBe("/?deleted=1");
    const deletes = telnyx.calls.filter((call) => call.method === "DELETE").map((call) => new URL(call.url).pathname);
    expect(deletes).toEqual(["/v2/10dlc/phone_number_campaigns/%2B19415550123", "/v2/phone_numbers/num-1", "/v2/ai/assistants/assistant-1"]);
  });

  it("reuses an assistant created before a failure instead of creating a second one", async () => {
    const { goLive, store, account, telnyx } = await shop();
    await store.saveIntegrationSecret(account.tenantId, "telnyx", "provisioned_assistant_id", "assistant-7");
    expect((await goLive()).headers.get("location")).toBe("/app?line=live");
    expect(telnyx.calls.some((call) => call.url.endsWith("/ai/assistants") && call.method === "POST")).toBe(false);
    expect((await store.getProviderRoute("telnyx", "assistant-7"))?.tenantId).toBe(account.tenantId);
  });

  it("rejects spam at the carrier only when CALL_SCREENING_MODE=reject opts in", async () => {
    const { goLive, telnyx } = await shop({ env: { CALL_SCREENING_MODE: "reject" } });
    expect((await goLive()).headers.get("location")).toBe("/app?line=live");
    const screening = telnyx.calls.find((call) => call.method === "PATCH" && call.url.endsWith("/phone_numbers/num-1/voice"));
    expect(screening?.body).toEqual({ inbound_call_screening: "reject_calls" });
  });

  it("goes live on voice before texting is approved, and answers customer calls", async () => {
    const { baseUrl, goLive, store, account, privateKey, clock } = await shop({ env: { TELNYX_MESSAGING_APPROVED: "false" } });
    expect((await goLive()).headers.get("location")).toBe("/app?line=live");
    expect((await store.getOwnerAccountById(account.id))!.status).toBe("active");
    const init = JSON.stringify({ data: { record_type: "event", event_type: "assistant.initialization", id: "evt-voice-only", occurred_at: clock.now().toISOString(), payload: { telnyx_conversation_channel: "phone_call", telnyx_agent_target: "+19415550123", telnyx_end_user_target: "+19415550110", call_control_id: "v3:voice-only", assistant_id: "assistant-1" } } });
    const reply = await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(init, privateKey, clock.now()), body: init });
    expect(reply.status).toBe(200);
    expect(((await reply.json()) as { dynamic_variables: { call_access: string } }).dynamic_variables.call_access).toBe("allowed");
  });

  it("turns a waiting paid shop on by itself and tells the owner the line is live, once", async () => {
    const { store, account, handler } = await shop({ env: { TELNYX_MESSAGING_APPROVED: "false", RESEND_API_KEY: "re_synthetic", RESEND_FROM_EMAIL: "alerts@front-office.example" } });
    expect((await store.getOwnerAccountById(account.id))!.status).toBe("pending_activation");
    expect(await handler.runActivationJobs()).toMatchObject({ activated: 1 });
    expect((await store.getOwnerAccountById(account.id))!.status).toBe("active");
    const notices = () => [...store.notifications.values()].filter((item) => item.idempotencyKey.startsWith(`line-live:${account.tenantId}:`));
    const email = notices().find((item) => item.channel === "email")!;
    expect(email.destinationRef).toBe("email:owner@synthetic.example");
    expect(email.body).toContain("Subject: Your Call Otto line is live");
    expect(email.body).toContain("(941) 555-0123 now answers for Gulf Air");
    expect(notices().some((item) => item.channel === "sms")).toBe(true);
    await handler.runActivationJobs();
    expect(notices()).toHaveLength(2);
  });

  it("keeps scanning when one shop's data breaks the activation job", async () => {
    const { store, account, handler } = await shop();
    const list = store.listTenantIds.bind(store);
    const lookup = store.getOwnerAccountByTenant.bind(store);
    store.listTenantIds = async () => ["broken-shop", ...await list()];
    store.getOwnerAccountByTenant = async (tenantId: string) => { if (tenantId === "broken-shop") throw new Error("bad row"); return lookup(tenantId); };
    expect(await handler.runActivationJobs()).toMatchObject({ activated: 1 });
    expect((await store.getOwnerAccountById(account.id))!.status).toBe("active");
  });

  it("sends the opt-in confirmation once to owners who opted in before texting was approved", async () => {
    const before = await shop({ env: { TELNYX_MESSAGING_APPROVED: "false" } });
    const confirmations = (store: typeof before.store) => [...store.notifications.values()].filter((item) => item.idempotencyKey.startsWith("owner-optin:"));
    expect(confirmations(before.store)).toHaveLength(0);
    expect((await before.handler.runActivationJobs()).optInConfirmations).toBe(0);
    // Same shop data, server restarted with texting approved.
    const approved = createRequestHandler({ env: { ...before.env, TELNYX_MESSAGING_APPROVED: true }, store: before.store, calendar: new InMemoryCalendar(), clock: before.clock, integrations: {}, logger: () => undefined, fetcher: before.telnyx.fetcher });
    expect((await approved.runActivationJobs()).optInConfirmations).toBe(1);
    expect((await approved.runActivationJobs()).optInConfirmations).toBe(0);
    expect(confirmations(before.store).map((item) => item.idempotencyKey)).toEqual([`owner-optin:${before.account.tenantId}:approved`]);
  });

  it("keeps the line off and explains why while carrier approval is pending", async () => {
    const { goLive, store, account, telnyx } = await shop({ live: false });
    const location = (await goLive()).headers.get("location")!;
    expect(location).toContain("/app?line_error=");
    expect(decodeURIComponent(location)).toContain("waiting on carrier approval");
    expect(telnyx.calls.some((call) => call.url.includes("/number_orders"))).toBe(false);
    expect((await store.getOwnerAccountById(account.id))!.status).not.toBe("active");
  });

  it("turns the line on from the React app's JSON API and returns the number with forwarding codes", async () => {
    const { baseUrl, cookie, store, account } = await shop();
    const before = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { csrf: string; line: { number: string | null } };
    expect(before.line.number).toBeNull();
    // No CSRF header: refused, nothing bought.
    const forged = await fetch(`${baseUrl}/api/app/line/go-live`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(forged.status).toBe(403);
    expect(await store.getIntegrationSecret(account.tenantId, "telnyx", "inbound_number")).toBeNull();
    const response = await fetch(`${baseUrl}/api/app/line/go-live`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": before.csrf }, body: "{}" });
    expect(response.status).toBe(200);
    const after = await response.json() as { viewer: { status: string }; line: { number: string; forwarding: Array<{ on: string }> } };
    expect(after.viewer.status).toBe("active");
    expect(after.line.number).toBe("+19415550123");
    expect(after.line.forwarding.map((row) => row.on)).toContain("*729415550123");
  });

  it("answers the React app with a 409 and a plain reason while carrier approval is pending", async () => {
    const { baseUrl, cookie, telnyx } = await shop({ live: false });
    const { csrf } = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { csrf: string };
    const response = await fetch(`${baseUrl}/api/app/line/go-live`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: "{}" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("waiting on carrier approval");
    expect(telnyx.calls.some((call) => call.url.includes("/number_orders"))).toBe(false);
  });

  it("never shows the owner the phone company's name or raw error when connecting the line fails", async () => {
    const { baseUrl, cookie, goLive } = await shop({ failConnect: true });
    const location = decodeURIComponent((await goLive()).headers.get("location")!);
    expect(location).toContain("couldn’t connect your Call Otto number");
    expect(location).not.toMatch(/telnyx/i);
    const { csrf } = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { csrf: string };
    const activation = await (await fetch(`${baseUrl}/api/app/onboarding/activate`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: "{}" })).json() as { activation: { status: string; message: string } };
    expect(activation.activation.status).toBe("failed");
    expect(activation.activation.message).not.toMatch(/telnyx/i);
  });

  it("shows a retry message when Telnyx is down and buys nothing", async () => {
    const { goLive, telnyx } = await shop({ failAssistantCreate: true });
    const location = decodeURIComponent((await goLive()).headers.get("location")!);
    expect(location).toContain("couldn't set up your Call Otto number");
    expect(telnyx.calls.some((call) => call.url.includes("/number_orders"))).toBe(false);
  });

  describe("call forwarding a 60-year-old can do", () => {
    /** A live shop. New shops start on "Otto answers every call"; ringFirst taps "Ring my phone first" like an owner would. */
    async function liveShop(options: Parameters<typeof shop>[0] & { ringFirst?: boolean } = {}) {
      const made = await shop(options);
      const api = async (path: string, body: unknown = {}, csrf?: string) => {
        const token = csrf ?? ((await (await fetch(`${made.baseUrl}/api/app/dashboard`, { headers: { cookie: made.cookie } })).json()) as { csrf: string }).csrf;
        return fetch(`${made.baseUrl}${path}`, { method: "POST", headers: { cookie: made.cookie, "content-type": "application/json", "x-csrf-token": token }, body: JSON.stringify(body) });
      };
      const dashboard = async () => (await (await fetch(`${made.baseUrl}/api/app/dashboard`, { headers: { cookie: made.cookie } })).json()) as {
        line: { business: { number: string | null; carrier: { family: string; name: string | null } | null; plan: { on: string | null; off: string | null; dialLink: string | null } | null }; confirmedAt: string | null; check: { status: string; method: string | null; answeredAfterSec: number | null; callerId: string | null }; helpRequestedAt: string | null };
      };
      expect((await api("/api/app/line/go-live")).status).toBe(200);
      if (options.ringFirst) expect((await api("/api/app/line/mode", { mode: "overflow" })).status).toBe(200);
      return { ...made, api, dashboard };
    }

    it("looks up the carrier from the business number and shows one Verizon code per choice", async () => {
      const { api, dashboard, telnyx } = await liveShop();
      const saved = await api("/api/app/line/business-number", { number: "(941) 555-0177" });
      expect(saved.status).toBe(200);
      const { line } = await dashboard();
      expect(line.business.number).toBe("+19415550177");
      expect(line.business.carrier?.family).toBe("verizon");
      // New shops start on "Otto answers every call": *72. "Ring my phone first" would ring about 30 seconds.
      expect(line.business.plan?.on).toBe("*729415550123");
      expect((line.business as { ringFirstSeconds?: number | null }).ringFirstSeconds).toBe(30);
      await api("/api/app/line/mode", { mode: "overflow" });
      const ringFirst = (await dashboard()).line.business;
      expect(ringFirst.plan?.on).toBe("*719415550123");
      expect(ringFirst.plan?.off).toBe("*73");
      expect(ringFirst.plan?.dialLink).toBe("tel:%2A719415550123");
      // Saving the same number again does not pay for another lookup.
      await api("/api/app/line/business-number", { number: "941-555-0177" });
      expect(telnyx.calls.filter((call) => call.url.includes("/number_lookup/"))).toHaveLength(1);
    });

    it("new shops start on every call (**21); Ring my phone first is one code that covers no answer (15 seconds), Decline and no signal", async () => {
      const { api, dashboard } = await liveShop({ carriers: { "+19415550177": { name: "T-Mobile USA", type: "mobile" } } });
      await api("/api/app/line/business-number", { number: "9415550177" });
      const start = (await dashboard()).line as unknown as { mode: string; business: { plan: { on: string; forwardsAll: boolean }; ringFirstSeconds: number | null } };
      expect(start).toMatchObject({ mode: "always", business: { plan: { on: "**21*19415550123#", forwardsAll: true }, ringFirstSeconds: 15 } });
      expect((await api("/api/app/line/mode", { mode: "overflow" })).status).toBe(200);
      const { plan } = (await dashboard()).line.business;
      expect(plan?.on).toBe("**004*19415550123**15#");
      expect(plan?.off).toBe("##002#");
      expect(plan?.dialLink).toBe("tel:%2A%2A004%2A19415550123%2A%2A15%23");
      // No phone-settings step up front any more.
      expect(plan).not.toHaveProperty("iphoneTip");
    });

    it("asks which phone company when the lookup can't tell, and accepts the owner's pick", async () => {
      const { api, dashboard } = await liveShop({ carriers: { "+19415550177": { name: "", type: "mobile" } } });
      await api("/api/app/line/business-number", { number: "9415550177" });
      expect((await dashboard()).line.business.plan?.on).toBeNull();
      await api("/api/app/line/business-number", { number: "9415550177", family: "gsm" });
      expect((await dashboard()).line.business.plan?.on).toBe("**21*19415550123#");
    });

    it("refuses the Call Otto number itself and a bad number", async () => {
      const { api } = await liveShop();
      expect((await api("/api/app/line/business-number", { number: "+19415550123" })).status).toBe(400);
      expect((await api("/api/app/line/business-number", { number: "555" })).status).toBe(400);
    });

    it("Test my forwarding rings the business phone, confirms when it reaches the shop, and leaves no call record", async () => {
      const { api, dashboard, telnyx, store, account, baseUrl, privateKey, clock } = await liveShop({ env: { TELNYX_CHECK_CONNECTION_ID: "check-connection" } });
      await api("/api/app/line/business-number", { number: "9415550177" });
      await api("/api/app/line/check");
      const dial = telnyx.calls.find((call) => call.url.endsWith("/v2/calls"));
      expect(dial?.body).toMatchObject({ connection_id: "check-connection", to: "+19415550177", from: "+15555550199" });
      expect((await dashboard()).line.check).toMatchObject({ status: "calling", method: "auto" });

      const init = JSON.stringify({ data: { record_type: "event", event_type: "assistant.initialization", id: "evt-check", occurred_at: clock.now().toISOString(), payload: { telnyx_conversation_channel: "phone_call", telnyx_agent_target: "+19415550123", telnyx_end_user_target: "+15555550199", call_control_id: "v3:forwarded-check", assistant_id: "assistant-1" } } });
      const reply = await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(init, privateKey, clock.now()), body: init });
      expect(reply.status).toBe(200);
      expect(((await reply.json()) as { dynamic_variables: { call_access: string } }).dynamic_variables.call_access).toBe("forwarding_check");
      expect(telnyx.calls.some((call) => call.url.endsWith("/calls/v3%3Acheck-call/actions/hangup"))).toBe(true);
      expect((await dashboard()).line.check.status).toBe("passed");

      const ended = JSON.stringify({ data: { record_type: "event", event_type: "call.conversation.ended", id: "evt-check-end", occurred_at: clock.now().toISOString(), payload: { assistant_id: "assistant-1", call_control_id: "v3:forwarded-check", from: "+15555550199", duration_sec: 4, messages: [] } } });
      expect((await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(ended, privateKey, clock.now()), body: ended })).status).toBe(200);
      expect(await store.listCalls(account.tenantId, 10)).toHaveLength(0);
    });

    describe("says exactly what happened to the test call", () => {
      async function started() {
        const made = await liveShop({ env: { TELNYX_CHECK_CONNECTION_ID: "check-connection" } });
        await made.api("/api/app/line/business-number", { number: "9415550177" });
        await made.api("/api/app/line/check");
        // Webhooks for our check leg: Telnyx echoes the client_state we dialed with on every event.
        const send = async (event: string, secondsAfter: number, extra: Record<string, unknown> = {}) => {
          const at = new Date(made.clock.now().getTime() + secondsAfter * 1_000);
          // The client_state we dialed with (shop + test start), exactly as Telnyx echoes it back.
          const clientState = (made.telnyx.calls.filter((call) => call.url.endsWith("/v2/calls")).at(-1)!.body as { client_state: string }).client_state;
          const body = JSON.stringify({ data: { record_type: "event", event_type: event, id: `evt-${event}-${secondsAfter}`, occurred_at: at.toISOString(), payload: { call_control_id: "v3:check-call", client_state: clientState, ...extra } } });
          return fetch(`${made.baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(body, made.privateKey, made.clock.now()), body });
        };
        return { ...made, send };
      }

      it("picked up in 2 seconds (call screening): says what the call is instead of dead air, hangs up, and names the fix", async () => {
        const { send, telnyx, dashboard, store, account } = await started();
        expect((await dashboard()).line.check).toMatchObject({ status: "calling", callerId: "+15555550199" });
        expect((await send("call.answered", 2)).status).toBe(200);
        const spoke = telnyx.calls.find((call) => call.url.endsWith("/calls/v3%3Acheck-call/actions/speak"));
        expect((spoke?.body as { payload: string }).payload).toContain("testing your call forwarding");
        await send("call.speak.ended", 12);
        expect(telnyx.calls.some((call) => call.url.endsWith("/calls/v3%3Acheck-call/actions/hangup"))).toBe(true);
        expect((await dashboard()).line.check.status).toBe("calling");
        await send("call.hangup", 13, { hangup_cause: "normal_clearing" });
        expect((await dashboard()).line.check).toMatchObject({ status: "phone_answers", answeredAfterSec: 2 });
        expect((await dashboard()).line.confirmedAt).toBeNull();
        expect(await store.listCalls(account.tenantId, 10)).toHaveLength(0);
      });

      it("dials with Premium AMD iOS call screening detection, and rings long enough for Verizon's 30 seconds", async () => {
        const { telnyx } = await started();
        const dial = telnyx.calls.filter((call) => call.url.endsWith("/v2/calls")).at(-1)!.body as { answering_machine_detection: string; timeout_secs: number };
        expect(dial.answering_machine_detection).toBe("premium_ios_call_screening_detection");
        expect(dial.timeout_secs).toBeGreaterThanOrEqual(45);
      });

      it("Telnyx hears the phone's own screener (iOS call screening, Live Voicemail): 'phone answers' at once, explained, then hung up", async () => {
        const { send, telnyx, dashboard, store, account } = await started();
        await send("call.answered", 2);
        expect((await dashboard()).line.check.status).toBe("calling");
        // Telnyx's real order: a first "machine" verdict for Apple's screener, then the screening tone.
        await send("call.machine.premium.detection.ended", 4, { result: "machine" });
        expect((await dashboard()).line.check.status).toBe("calling");
        expect((await send("call.machine.premium.call_screening.detected", 5, { result: "screening" })).status).toBe(200);
        // No waiting for the call to end: the app shows it now.
        expect((await dashboard()).line.check).toMatchObject({ status: "phone_answers", answeredAfterSec: 2 });
        const spoke = telnyx.calls.find((call) => call.url.endsWith("/calls/v3%3Acheck-call/actions/speak"));
        expect((spoke?.body as { payload: string }).payload).toContain("Your phone picked up this test call");
        await send("call.speak.ended", 12);
        expect(telnyx.calls.some((call) => call.url.endsWith("/calls/v3%3Acheck-call/actions/hangup"))).toBe(true);
        await send("call.machine.premium.detection.ended", 13, { result: "human_residence" });
        await send("call.hangup", 14, { hangup_cause: "normal_clearing" });
        expect((await dashboard()).line.check.status).toBe("phone_answers");
        expect((await dashboard()).line.confirmedAt).toBeNull();
        expect(await store.listCalls(account.tenantId, 10)).toHaveLength(0);
      });

      it("Apple's screening prompt ending with no tone (greeting.ended: prompt_ended) is 'phone answers' too, not voicemail", async () => {
        const { send, dashboard } = await started();
        await send("call.answered", 2);
        await send("call.machine.premium.detection.ended", 4, { result: "machine" });
        await send("call.machine.premium.greeting.ended", 9, { result: "prompt_ended" });
        expect((await dashboard()).line.check.status).toBe("phone_answers");
        await send("call.hangup", 14, { hangup_cause: "normal_clearing" });
        expect((await dashboard()).line.check.status).toBe("phone_answers");
      });

      it("a person picking up (Premium AMD: human) is 'you answered', not the phone answering itself", async () => {
        const { send, dashboard } = await started();
        await send("call.answered", 4);
        await send("call.machine.premium.detection.ended", 6, { result: "human_residence" });
        await send("call.hangup", 16, { hangup_cause: "normal_clearing" });
        expect((await dashboard()).line.check.status).toBe("you_answered");
      });

      it("Test again while the last test call is still up: hangs that one up first, and still hangs it up when its explanation ends", async () => {
        const { send, telnyx, dashboard, api, clock, baseUrl, privateKey } = await started();
        await send("call.answered", 2);
        await send("call.machine.premium.call_screening.detected", 5, { result: "screening" });
        expect((await dashboard()).line.check.status).toBe("phone_answers");
        const oldState = (telnyx.calls.filter((call) => call.url.endsWith("/v2/calls")).at(-1)!.body as { client_state: string }).client_state;
        const before = telnyx.calls.length;
        clock.at = new Date(clock.at.getTime() + 8_000);
        expect((await api("/api/app/line/check")).status).toBe(200);
        const after = telnyx.calls.slice(before).map((call) => call.url);
        const hangup = after.findIndex((url) => url.endsWith("/calls/v3%3Acheck-call/actions/hangup"));
        const dial = after.findIndex((url) => url.endsWith("/v2/calls"));
        expect(hangup).toBeGreaterThanOrEqual(0);
        expect(dial).toBeGreaterThan(hangup);
        expect((await dashboard()).line.check.status).toBe("calling");
        // The old leg's explanation ends after the new test started: it's still ours, so it's still hung up.
        const ended = JSON.stringify({ data: { record_type: "event", event_type: "call.speak.ended", id: "evt-old-speak", occurred_at: clock.now().toISOString(), payload: { call_control_id: "v3:old-leg", client_state: oldState } } });
        expect((await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(ended, privateKey, clock.now()), body: ended })).status).toBe(200);
        expect(telnyx.calls.some((call) => call.url.endsWith("/calls/v3%3Aold-leg/actions/hangup"))).toBe(true);
        expect((await dashboard()).line.check.status).toBe("calling");
      }, 15_000);

      it("Decline that lands on a voicemail greeting (Premium AMD: machine) is voicemail, not 'phone answers'", async () => {
        const { send, dashboard } = await started();
        await send("call.answered", 3);
        await send("call.machine.premium.detection.ended", 6, { result: "machine" });
        await send("call.hangup", 20, { hangup_cause: "normal_clearing" });
        expect((await dashboard()).line.check.status).toBe("voicemail");
      });

      it("picked up after 25 seconds with no forward: their voicemail has it", async () => {
        const { send, dashboard } = await started();
        await send("call.answered", 25);
        await send("call.hangup", 40, { hangup_cause: "normal_clearing" });
        expect((await dashboard()).line.check.status).toBe("voicemail");
      });

      it("rang out with nobody picking up: not reached, as soon as the call ends", async () => {
        const { send, dashboard } = await started();
        await send("call.hangup", 60, { hangup_cause: "timeout" });
        expect((await dashboard()).line.check.status).toBe("not_reached");
      });

      it("declined but nothing forwarded it", async () => {
        const { send, dashboard } = await started();
        await send("call.hangup", 6, { hangup_cause: "call_rejected" });
        expect((await dashboard()).line.check.status).toBe("declined");
      });

      it("forwarded to Call Otto: passes, and says nothing on our leg", async () => {
        const { send, telnyx, dashboard, baseUrl, privateKey, clock } = await started();
        const init = JSON.stringify({ data: { record_type: "event", event_type: "assistant.initialization", id: "evt-fwd", occurred_at: clock.now().toISOString(), payload: { telnyx_conversation_channel: "phone_call", telnyx_agent_target: "+19415550123", telnyx_end_user_target: "+15555550199", call_control_id: "v3:forwarded-check", assistant_id: "assistant-1" } } });
        await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(init, privateKey, clock.now()), body: init });
        await send("call.answered", 24);
        await send("call.hangup", 25, { hangup_cause: "normal_clearing" });
        expect(telnyx.calls.some((call) => call.url.endsWith("/actions/speak"))).toBe(false);
        expect((await dashboard()).line.check.status).toBe("passed");
      });

      it("a pick-up that beats our own save of the test is retried by Telnyx, not dropped", async () => {
        const { baseUrl, privateKey, clock, account, dashboard } = await started();
        const ahead = new Date(clock.now().getTime() + 60_000).toISOString();
        const early = JSON.stringify({ data: { record_type: "event", event_type: "call.answered", id: "evt-early", occurred_at: clock.now().toISOString(), payload: { call_control_id: "v3:next-call", client_state: Buffer.from(`forwarding-check:${account.tenantId}|${ahead}`).toString("base64") } } });
        expect((await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(early, privateKey, clock.now()), body: early })).status).toBe(502);
        expect((await dashboard()).line.check.status).toBe("calling");
      });

      it("an older test call finishing late never rewrites the newest test", async () => {
        const { dashboard, baseUrl, privateKey, clock, account } = await started();
        const stale = JSON.stringify({ data: { record_type: "event", event_type: "call.hangup", id: "evt-stale", occurred_at: clock.now().toISOString(), payload: { call_control_id: "v3:older-call", hangup_cause: "timeout", client_state: Buffer.from(`forwarding-check:${account.tenantId}`).toString("base64") } } });
        expect((await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(stale, privateKey, clock.now()), body: stale })).status).toBe(200);
        expect((await dashboard()).line.check.status).toBe("calling");
      });
    });

    it("the owner calling their own Call Otto number from the business phone is not proof that forwarding works", async () => {
      const { api, dashboard, baseUrl, privateKey, clock } = await liveShop();
      await api("/api/app/line/business-number", { number: "9415550177" });
      const init = JSON.stringify({ data: { record_type: "event", event_type: "assistant.initialization", id: "evt-self", occurred_at: clock.now().toISOString(), payload: { telnyx_conversation_channel: "phone_call", telnyx_agent_target: "+19415550123", telnyx_end_user_target: "+19415550177", call_control_id: "v3:self", assistant_id: "assistant-1" } } });
      await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(init, privateKey, clock.now()), body: init });
      expect((await dashboard()).line.confirmedAt).toBeNull();
    });

    it("falls back to calling yourself, and says so plainly when the call never reaches us", async () => {
      const { api, dashboard, telnyx, clock } = await liveShop();
      await api("/api/app/line/business-number", { number: "9415550177" });
      await api("/api/app/line/check");
      expect(telnyx.calls.some((call) => call.url.endsWith("/v2/calls"))).toBe(false);
      expect((await dashboard()).line.check).toMatchObject({ status: "calling", method: "manual" });
      clock.at = new Date(clock.at.getTime() + 2 * 60_000);
      expect((await dashboard()).line.check.status).toBe("not_reached");
    });

    it("a real customer call also proves forwarding works, and is kept as a normal call", async () => {
      const { api, dashboard, store, account, baseUrl, privateKey, clock } = await liveShop();
      await api("/api/app/line/business-number", { number: "9415550177" });
      const init = JSON.stringify({ data: { record_type: "event", event_type: "assistant.initialization", id: "evt-customer", occurred_at: clock.now().toISOString(), payload: { telnyx_conversation_channel: "phone_call", telnyx_agent_target: "+19415550123", telnyx_end_user_target: "+19415550110", call_control_id: "v3:customer", assistant_id: "assistant-1" } } });
      const reply = await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(init, privateKey, clock.now()), body: init });
      expect(((await reply.json()) as { dynamic_variables: { call_access: string } }).dynamic_variables.call_access).toBe("allowed");
      expect((await dashboard()).line.confirmedAt).toBeTruthy();
      expect(await store.listCalls(account.tenantId, 10)).toHaveLength(1);
    });

    it("Set it up with me emails support the details needed to call the owner back", async () => {
      const { api, dashboard, store, account } = await liveShop({ env: { SUPPORT_EMAIL: "help@front-office.example", RESEND_API_KEY: "re_synthetic", RESEND_FROM_EMAIL: "alerts@front-office.example" } });
      await api("/api/app/line/business-number", { number: "9415550177" });
      expect((await api("/api/app/line/help")).status).toBe(200);
      expect((await dashboard()).line.helpRequestedAt).toBeTruthy();
      const email = [...store.notifications.values()].find((item) => item.destinationRef === "email:help@front-office.example");
      expect(email?.body).toContain("+19415550177");
      expect(email?.body).toContain("+19415550123");
      expect(email?.tenantId).toBe(account.tenantId);
    });

    it("Set it up with me: Otto's AI setup helper calls the owner right away with their exact code, and never loops into their own line", async () => {
      const made = await liveShop({ env: { TELNYX_CHECK_CONNECTION_ID: "check-connection", TELNYX_TEMPLATE_ASSISTANT_ID: "template-assistant" }, carriers: { "+19415550177": { name: "T-Mobile USA", type: "mobile" } } });
      const { api, dashboard, telnyx, baseUrl, privateKey, clock, account, store } = made;
      await api("/api/app/line/business-number", { number: "9415550177" });
      expect((await api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
      const dial = telnyx.calls.filter((call) => call.url.endsWith("/v2/calls")).at(-1);
      expect(dial?.body).toMatchObject({ connection_id: "check-connection", from: "+15555550199" });
      const to = (dial?.body as { to: string }).to;
      expect((await dashboard()).line).toMatchObject({ helpCall: { to } });

      const state = (dial?.body as { client_state: string }).client_state;
      const answered = JSON.stringify({ data: { record_type: "event", event_type: "call.answered", id: "evt-help-answered", occurred_at: clock.now().toISOString(), payload: { call_control_id: "v3:check-call", client_state: state } } });
      expect((await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(answered, privateKey, clock.now()), body: answered })).status).toBe(200);
      const created = telnyx.calls.filter((call) => call.url.endsWith("/ai/assistants") && call.method === "POST").at(-1);
      expect((created?.body as { name: string }).name).toBe("Call Otto · Setup helper");
      expect((created?.body as Record<string, unknown>).dynamic_variables_webhook_url).toBeUndefined();
      const start = telnyx.calls.find((call) => call.url.endsWith("/actions/ai_assistant_start"));
      const startBody = start?.body as { assistant: { id: string; instructions: string }; greeting: string };
      expect(startBody.greeting).toContain("setup helper");
      expect(startBody.assistant.instructions).toContain("**004*19415550123**15#");
      expect(startBody.assistant.instructions).toContain("Screen Unknown Callers to Never");
      expect(startBody.assistant.instructions).toContain("Never invent a code");

      // Missed, it forwards into the shop's own line: Otto ends it at once, and that proves forwarding works.
      const looped = JSON.stringify({ data: { record_type: "event", event_type: "assistant.initialization", id: "evt-loop", occurred_at: clock.now().toISOString(), payload: { telnyx_conversation_channel: "phone_call", telnyx_agent_target: "+19415550123", telnyx_end_user_target: "+15555550199", call_control_id: "v3:looped", assistant_id: "assistant-1" } } });
      const reply = await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(looped, privateKey, clock.now()), body: looped });
      expect(((await reply.json()) as { dynamic_variables: { call_access: string } }).dynamic_variables.call_access).toBe("forwarding_check");
      expect(await store.listCalls(account.tenantId, 10)).toHaveLength(0);
      expect((await dashboard()).line.confirmedAt).toBeTruthy();
      // Not a test the owner started: it proves forwarding works, but no particular code.
      expect(await store.getIntegrationSecret(account.tenantId, "forwarding", "dialed_code")).toBeNull();

      // A second setup call reuses the one setup assistant.
      expect((await api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
      const again = JSON.stringify({ data: { record_type: "event", event_type: "call.answered", id: "evt-help-answered-2", occurred_at: clock.now().toISOString(), payload: { call_control_id: "v3:check-call", client_state: state } } });
      await fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(again, privateKey, clock.now()), body: again });
      expect(telnyx.calls.filter((call) => call.url.endsWith("/ai/assistants") && call.method === "POST" && (call.body as { name?: string }).name === "Call Otto · Setup helper")).toHaveLength(1);
    });

    describe("when the phone answers the test itself", () => {
      const forwarded = async (made: Awaited<ReturnType<typeof liveShop>>, id: string) => {
        const init = JSON.stringify({ data: { record_type: "event", event_type: "assistant.initialization", id, occurred_at: made.clock.now().toISOString(), payload: { telnyx_conversation_channel: "phone_call", telnyx_agent_target: "+19415550123", telnyx_end_user_target: "+15555550199", call_control_id: `v3:${id}`, assistant_id: "assistant-1" } } });
        return fetch(`${made.baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(init, made.privateKey, made.clock.now()), body: init });
      };
      type Line = { mode: string; business: { plan: { on: string; forwardsAll: boolean; ringSeconds: number | null } | null; update: { clearFirst: string | null } | null }; check: { status: string }; confirmedAt: string | null };
      const line = async (made: Awaited<ReturnType<typeof liveShop>>) => ((await (await fetch(`${made.baseUrl}/api/app/dashboard`, { headers: { cookie: made.cookie } })).json()) as { line: Line }).line;

      it("Let Otto answer every call: switches to forward-all (CSRF-checked, saved), shows **21, and the test passes at once", async () => {
        const made = await liveShop({ env: { TELNYX_CHECK_CONNECTION_ID: "check-connection" }, carriers: { "+19415550177": { name: "T-Mobile USA", type: "mobile" } }, ringFirst: true });
        const { api, store, account, baseUrl, cookie } = made;
        await api("/api/app/line/business-number", { number: "9415550177" });
        const forged = await fetch(`${baseUrl}/api/app/line/mode`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ mode: "always" }) });
        expect(forged.status).toBe(403);
        expect((await api("/api/app/line/mode", { mode: "after_hours" })).status).toBe(400);
        expect((await store.getConfig(account.tenantId)).operationMode).not.toBe("always");

        expect((await api("/api/app/line/mode", { mode: "always" })).status).toBe(200);
        expect((await store.getConfig(account.tenantId)).operationMode).toBe("always");
        expect(await line(made)).toMatchObject({ mode: "always", business: { plan: { on: "**21*19415550123#", forwardsAll: true, ringSeconds: null }, update: null } });

        // Test again: with every call forwarded, our test call lands on Call Otto right away.
        await api("/api/app/line/check");
        expect((await forwarded(made, "always-check")).status).toBe(200);
        expect((await line(made)).check.status).toBe("passed");
        expect(await store.getIntegrationSecret(account.tenantId, "forwarding", "dialed_code")).toBe("**21*19415550123#");

        expect((await line(made)).business).toMatchObject({ everyCallOn: true, codeApplied: true });

        // Back to "ring me first": the conditional code, after clearing forward-all.
        expect((await api("/api/app/line/mode", { mode: "overflow" })).status).toBe(200);
        expect((await line(made)).business).toMatchObject({ plan: { on: "**004*19415550123**15#", forwardsAll: false }, update: { clearFirst: "##002#", missed: false }, everyCallOn: true });

        // Tested without dialing anything: forward-all still sends the test straight to Otto. That proves nothing
        // about the new code, so "Dial this once" stays, and the card still says every call goes to Otto.
        made.clock.at = new Date(made.clock.at.getTime() + 60_000);
        await api("/api/app/line/check");
        made.clock.at = new Date(made.clock.at.getTime() + 2_000);
        await forwarded(made, "still-all");
        expect(await store.getIntegrationSecret(account.tenantId, "forwarding", "dialed_code")).toBe("**21*19415550123#");
        expect((await line(made)).business).toMatchObject({ update: { clearFirst: "##002#", missed: true }, everyCallOn: true, codeApplied: false });

        // Dialed ##002# and the new code: the phone rings first, they tap Decline, and Otto gets it.
        made.clock.at = new Date(made.clock.at.getTime() + 60_000);
        await api("/api/app/line/check");
        made.clock.at = new Date(made.clock.at.getTime() + 9_000);
        await forwarded(made, "ring-first");
        expect(await store.getIntegrationSecret(account.tenantId, "forwarding", "dialed_code")).toBe("**004*19415550123**15#");
        expect((await line(made)).business).toMatchObject({ update: null, everyCallOn: false, codeApplied: true });
      });

      it("Picked every call but didn't dial it: a test where the phone rang first never claims every call is on", async () => {
        const made = await liveShop({ env: { TELNYX_CHECK_CONNECTION_ID: "check-connection" }, carriers: { "+19415550177": { name: "T-Mobile USA", type: "mobile" } }, ringFirst: true });
        const { api, store, account } = made;
        await api("/api/app/line/business-number", { number: "9415550177" });
        await api("/api/app/line/check");
        await forwarded(made, "first-check");
        expect(await store.getIntegrationSecret(account.tenantId, "forwarding", "dialed_code")).toBe("**004*19415550123**15#");
        expect((await api("/api/app/line/mode", { mode: "always" })).status).toBe(200);
        expect((await line(made)).business).toMatchObject({ plan: { on: "**21*19415550123#" }, update: { clearFirst: null, missed: false }, everyCallOn: false });
        // The old code still forwards on Decline, 14 seconds in: that's the phone ringing, not **21.
        made.clock.at = new Date(made.clock.at.getTime() + 60_000);
        await api("/api/app/line/check");
        made.clock.at = new Date(made.clock.at.getTime() + 14_000);
        await forwarded(made, "rang-first");
        expect((await line(made)).check.status).toBe("passed");
        expect(await store.getIntegrationSecret(account.tenantId, "forwarding", "dialed_code")).toBe("**004*19415550123**15#");
        expect((await line(made)).business).toMatchObject({ update: { clearFirst: null, missed: true }, everyCallOn: false, codeApplied: false });
      });

      it("after-hours shops that try every call and change their mind go back to after hours", async () => {
        const made = await liveShop({ carriers: { "+19415550177": { name: "T-Mobile USA", type: "mobile" } } });
        const { api, store, account } = made;
        await api("/api/app/line/business-number", { number: "9415550177" });
        await store.saveConfig({ ...(await store.getConfig(account.tenantId)), operationMode: "after_hours" });
        // "Keep my phone ringing first" leaves after hours alone.
        expect((await api("/api/app/line/mode", { mode: "overflow" })).status).toBe(200);
        expect((await store.getConfig(account.tenantId)).operationMode).toBe("after_hours");
        expect((await api("/api/app/line/mode", { mode: "always" })).status).toBe(200);
        expect((await store.getConfig(account.tenantId)).operationMode).toBe("always");
        expect((await api("/api/app/line/mode", { mode: "overflow" })).status).toBe(200);
        expect((await store.getConfig(account.tenantId)).operationMode).toBe("after_hours");
      });

      it("changing 'Ring my phone first' after forwarding works shows the one new code to dial", async () => {
        const made = await liveShop({ env: { TELNYX_CHECK_CONNECTION_ID: "check-connection" }, carriers: { "+19415550177": { name: "T-Mobile USA", type: "mobile" } }, ringFirst: true });
        const { api, baseUrl, cookie } = made;
        await api("/api/app/line/business-number", { number: "9415550177" });
        await api("/api/app/line/check");
        await forwarded(made, "ring-check");
        expect((await line(made)).business.update).toBeNull();
        const settings = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie } })).json() as { csrf: string; values: Record<string, string | boolean> };
        expect(settings.values.answerAfterRings).toBe("2.5");
        const put = (answerAfterRings: string) => fetch(`${baseUrl}/api/app/settings`, { method: "PUT", headers: { cookie, "content-type": "application/json", "x-csrf-token": settings.csrf }, body: JSON.stringify({ ...settings.values, answerAfterRings }) });
        expect((await put("2.25")).status).toBe(400);
        // A test started before the change proves the code on screen then, never the one today's settings call for.
        made.clock.at = new Date(made.clock.at.getTime() + 60_000);
        await api("/api/app/line/check");
        expect((await put("4")).status).toBe(200);
        await forwarded(made, "ring-check-old");
        expect(await made.store.getIntegrationSecret(made.account.tenantId, "forwarding", "dialed_code")).toBe("**004*19415550123**15#");
        expect((await line(made)).business).toMatchObject({ plan: { on: "**004*19415550123**25#", ringSeconds: 25 }, update: { clearFirst: null, missed: false }, codeApplied: false });
        // Dialed and tested: nothing left to apply.
        made.clock.at = new Date(made.clock.at.getTime() + 60_000);
        await api("/api/app/line/check");
        await forwarded(made, "ring-check-2");
        expect((await line(made)).business).toMatchObject({ update: null, codeApplied: true });
      });

      it("Set it up with me and urgent calls skip the business number between leaving every call and dialing the off code", async () => {
        const made = await liveShop({ env: { TELNYX_CHECK_CONNECTION_ID: "check-connection", TELNYX_TEMPLATE_ASSISTANT_ID: "template-assistant" }, carriers: { "+19415550199": { name: "T-Mobile USA", type: "mobile" } } });
        const { api, store, account, telnyx } = made;
        const helpDials = () => telnyx.calls.filter((call) => call.url.endsWith("/v2/calls") && Buffer.from(String((call.body as { client_state?: string }).client_state ?? ""), "base64").toString().startsWith("setup-help:"));
        await api("/api/app/line/business-number", { number: "9415550199" });
        await api("/api/app/line/mode", { mode: "always" });
        await api("/api/app/line/check");
        await forwarded(made, "all-on");
        expect(await store.getIntegrationSecret(account.tenantId, "forwarding", "dialed_code")).toBe("**21*19415550123#");
        // Back to "ring me first", ##002# not dialed yet: the phone still sends everything to Otto.
        await api("/api/app/line/mode", { mode: "overflow" });
        expect((await store.getConfig(account.tenantId)).operationMode).toBe("overflow");
        expect((await api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
        expect(helpDials()).toHaveLength(0);
        // Dialed and tested (the phone rang first): now the helper may ring it.
        made.clock.at = new Date(made.clock.at.getTime() + 60_000);
        await api("/api/app/line/check");
        made.clock.at = new Date(made.clock.at.getTime() + 9_000);
        await forwarded(made, "ring-first-on");
        expect(await store.getIntegrationSecret(account.tenantId, "forwarding", "dialed_code")).toBe("**004*19415550123**15#");
        expect((await api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
        expect(helpDials().map((call) => (call.body as { to: string }).to)).toEqual(["+19415550199"]);
      });

      it("Set it up with me rings the business number until a test proves it forwards every call; a call that loops back ends at once", async () => {
        const made = await liveShop({ env: { TELNYX_CHECK_CONNECTION_ID: "check-connection", TELNYX_TEMPLATE_ASSISTANT_ID: "template-assistant" }, carriers: { "+19415550199": { name: "T-Mobile USA", type: "mobile" }, "+19415550177": { name: "T-Mobile USA", type: "mobile" } } });
        const { api, store, account, telnyx, baseUrl, privateKey, clock } = made;
        expect(await store.getIntegrationSecret(account.tenantId, "notifications", "owner-primary")).toBe("+19415550199");
        const helpDials = () => telnyx.calls.filter((call) => call.url.endsWith("/v2/calls") && Buffer.from(String((call.body as { client_state?: string }).client_state ?? ""), "base64").toString().startsWith("setup-help:"));
        const hangups = () => telnyx.calls.filter((call) => call.url.endsWith("/v2/calls/v3%3Acheck-call/actions/hangup")).length;
        const arrives = (id: string, from: string) => {
          const init = JSON.stringify({ data: { record_type: "event", event_type: "assistant.initialization", id, occurred_at: clock.now().toISOString(), payload: { telnyx_conversation_channel: "phone_call", telnyx_agent_target: "+19415550123", telnyx_end_user_target: from, call_control_id: `v3:${id}`, assistant_id: "assistant-1" } } });
          return fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(init, privateKey, clock.now()), body: init });
        };
        const setupCall = async () => JSON.parse(await store.getIntegrationSecret(account.tenantId, "forwarding", "setup_call") ?? "null") as { endedAt?: string; hangupCause?: string } | null;
        // The owner's only number is the business number. Every call is picked (the default), nothing proven yet:
        // the helper rings it, since nothing says the code is on.
        await api("/api/app/line/business-number", { number: "9415550199" });
        await api("/api/app/line/mode", { mode: "always" });
        expect((await api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
        expect(helpDials().map((call) => (call.body as { to: string }).to)).toEqual(["+19415550199"]);
        // The code was on after all: the helper's call lands on Otto. Otto ends it (no Otto talking to Otto, no call
        // record), hangs up the helper's leg, and counts it as forwarding working.
        const reply = await arrives("help-loop", "+15555550199");
        expect(((await reply.json()) as { dynamic_variables: { call_access: string } }).dynamic_variables.call_access).toBe("forwarding_check");
        expect(await setupCall()).toMatchObject({ hangupCause: "forwarded_to_otto" });
        expect(hangups()).toBe(1);
        expect((await line(made)).confirmedAt).toBeTruthy();
        expect(await store.listCalls(account.tenantId, 10)).toHaveLength(0);
        // Some carriers show the business number as the caller: the same.
        clock.at = new Date(clock.at.getTime() + 60_000);
        expect((await api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
        expect(helpDials()).toHaveLength(2);
        const shown = await arrives("help-loop-2", "+19415550199");
        expect(((await shown.json()) as { dynamic_variables: { call_access: string } }).dynamic_variables.call_access).toBe("forwarding_check");
        expect(hangups()).toBe(2);
        expect(await store.listCalls(account.tenantId, 10)).toHaveLength(0);
        expect(((await line(made)) as unknown as { helpCall: { endedAt: string | null } }).helpCall.endedAt).toBeTruthy();
        // A test proves every call is forwarded: never ring that number again.
        clock.at = new Date(clock.at.getTime() + 60_000);
        await api("/api/app/line/check");
        await forwarded(made, "all-on");
        expect(await store.getIntegrationSecret(account.tenantId, "forwarding", "dialed_code")).toBe("**21*19415550123#");
        expect((await api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
        expect(helpDials()).toHaveLength(2);
        expect((await line(made) as unknown as { helpCall: unknown }).helpCall ?? null).toBeNull();
        // A different business number: the owner's mobile is separate, so the helper calls it.
        await api("/api/app/line/business-number", { number: "9415550177" });
        expect((await api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
        expect(helpDials().map((call) => (call.body as { to: string }).to)).toEqual(["+19415550199", "+19415550199", "+19415550199"]);
      });
    });

    it("only the owner can change forwarding, and a forged request without the token buys nothing", async () => {
      const { baseUrl, cookie } = await liveShop();
      const forged = await fetch(`${baseUrl}/api/app/line/check`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
      expect(forged.status).toBe(403);
    });
  });
});

function signed(body: string, privateKey: KeyObject, now: Date): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  return { "content-type": "application/json", "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64") };
}

