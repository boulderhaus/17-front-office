import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { forwardingInstructions, NumberUnavailableError, TelnyxProvisioner } from "../src/adapters/telnyx-provisioning.js";
import { loadEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";

type Call = { url: string; method: string; body: Record<string, unknown> | null; key: string | undefined };

/** A fake Telnyx that sells numbers, creates assistants and routes numbers, recording every request. */
function fakeTelnyx(options: { available?: Record<string, string[]>; orderStatuses?: string[]; failAssistantCreate?: boolean | undefined } = {}) {
  const calls: Call[] = [];
  const orders = [...(options.orderStatuses ?? ["pending", "success"])];
  const owned = new Map<string, { id: string; connection_id: string | null }>();
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
    const patch = /\/phone_numbers\/(num-\d+)$/.exec(url);
    if (patch && method === "PATCH") {
      const entry = [...owned.values()].find((value) => value.id === patch[1])!;
      entry.connection_id = (body?.connection_id as string | null) ?? null;
      return json({ data: { connection_id: entry.connection_id } });
    }
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
    expect(create.body).toMatchObject({ name: "Front Office · Gulf Air", instructions: "shop prompt", model: "synthetic/model", voice_settings: { voice: "synthetic-voice" } });
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

  async function shop(options: { live?: boolean; failAssistantCreate?: boolean | undefined } = {}) {
    const telnyx = fakeTelnyx({ available: { "941": ["+19415550123", "+19415550124"] }, failAssistantCreate: options.failAssistantCreate });
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const rawPublicKey = (generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
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
    });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => new Date("2026-11-23T15:00:00Z") }, integrations: {}, logger: () => undefined, fetcher: telnyx.fetcher }));
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
    return { baseUrl, cookie, csrf, goLive, store, account, telnyx };
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
    const dashboard = await (await fetch(`${baseUrl}/app`, { headers: { cookie } })).text();
    expect(dashboard).toContain("(941) 555-0123");
    expect(dashboard).toContain("*719415550123");

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

  it("keeps the line off and explains why while carrier approval is pending", async () => {
    const { goLive, store, account, telnyx } = await shop({ live: false });
    const location = (await goLive()).headers.get("location")!;
    expect(location).toContain("/app?line_error=");
    expect(decodeURIComponent(location)).toContain("waiting on carrier approval");
    expect(telnyx.calls.some((call) => call.url.includes("/number_orders"))).toBe(false);
    expect((await store.getOwnerAccountById(account.id))!.status).not.toBe("active");
  });

  it("shows a retry message when Telnyx is down and buys nothing", async () => {
    const { goLive, telnyx } = await shop({ failAssistantCreate: true });
    const location = decodeURIComponent((await goLive()).headers.get("location")!);
    expect(location).toContain("couldn't set up your Front Office number");
    expect(telnyx.calls.some((call) => call.url.includes("/number_orders"))).toBe(false);
  });
});
