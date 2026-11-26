import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { CallEndCallbackError, callEndCallbackUrl, ensureCallEndCallback } from "../src/adapters/telnyx-provisioning.js";
import { LineHealthCheck } from "../src/application/line-health.js";
import { createDemoConfig } from "../src/domain/config.js";
import { planAssistantPushes, syncCallEndCallbacks } from "../scripts/configure-telnyx.js";

const WANT = "https://front-office.example/webhooks/telnyx";
const noSleep = async () => undefined;

/** Telnyx assistants, each with its own default TeXML app, in the shape the live API returns them. */
function fakeTelnyx(apps: Record<string, Record<string, unknown> | null>, options: { fail?: Record<string, number>; ignoreWrites?: boolean } = {}) {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const state = new Map(Object.entries(apps).map(([assistantId, app]) => [assistantId, app ? { id: `texml-${assistantId}`, friendly_name: `ai-${assistantId}`, voice_url: "https://api.telnyx.com/v2/texml/ai_assistant", status_callback: null, status_callback_method: "post", call_cost_in_webhooks: false, ...app } : null]));
  const failures = { ...options.fail };
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    requests.push({ method, path, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if ((failures[`${method} ${path}`] ?? 0) > 0) {
      failures[`${method} ${path}`]! -= 1;
      return json({ errors: [{ detail: "upstream" }] }, 503);
    }
    const assistant = /^\/v2\/ai\/assistants\/([^/]+)$/.exec(path);
    if (assistant && method === "GET") {
      if (!state.has(assistant[1]!)) return json({ errors: [{ detail: "not found" }] }, 404);
      const app = state.get(assistant[1]!);
      return json({ data: { id: assistant[1], telephony_settings: app ? { default_texml_app_id: app.id } : {} } });
    }
    const texml = /^\/v2\/texml_applications\/texml-([^/]+)$/.exec(path);
    const app = texml ? state.get(texml[1]!) : null;
    if (app) {
      if (method === "PATCH" && !options.ignoreWrites) Object.assign(app, body);
      return json({ data: app });
    }
    throw new Error(`Unexpected outbound request in test: ${method} ${path}`);
  }) as typeof fetch;
  return { fetcher, requests, app: (assistantId: string) => state.get(assistantId) ?? null };
}

describe("end-of-call callback on an assistant's TeXML app", () => {
  it("uses the same URL as the signed webhooks, whatever the trailing slash", () => {
    expect(callEndCallbackUrl("https://front-office.example/")).toBe(WANT);
  });

  it("sets the callback, POST and call cost, keeps the app's own name and voice URL, and then leaves it alone", async () => {
    const telnyx = fakeTelnyx({ "assistant-shop": {} });
    const first = await ensureCallEndCallback({ apiKey: "k", assistantId: "assistant-shop", publicBaseUrl: "https://front-office.example", apply: true, fetcher: telnyx.fetcher, sleep: noSleep });
    expect(first).toEqual({ assistantId: "assistant-shop", texmlAppId: "texml-assistant-shop", action: "set", delivers: true });
    const patch = telnyx.requests.find((request) => request.method === "PATCH")!;
    expect(patch.path).toBe("/v2/texml_applications/texml-assistant-shop");
    expect(patch.body).toEqual({ friendly_name: "ai-assistant-shop", voice_url: "https://api.telnyx.com/v2/texml/ai_assistant", status_callback: WANT, status_callback_method: "post", call_cost_in_webhooks: true });

    const second = await ensureCallEndCallback({ apiKey: "k", assistantId: "assistant-shop", publicBaseUrl: "https://front-office.example", apply: true, fetcher: telnyx.fetcher, sleep: noSleep });
    expect(second.action).toBe("already_set");
    expect(telnyx.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("only reports without apply", async () => {
    const telnyx = fakeTelnyx({ "assistant-shop": {} });
    expect((await ensureCallEndCallback({ apiKey: "k", assistantId: "assistant-shop", publicBaseUrl: "https://front-office.example", apply: false, fetcher: telnyx.fetcher })).action).toBe("would_set");
    expect(telnyx.requests.every((request) => request.method === "GET")).toBe(true);
    expect(telnyx.app("assistant-shop")!.status_callback).toBeNull();
  });

  it("treats a callback to another URL, or sent by GET, as not set", async () => {
    for (const app of [{ status_callback: "https://elsewhere.example/webhooks/telnyx", call_cost_in_webhooks: true }, { status_callback: WANT, status_callback_method: "get", call_cost_in_webhooks: true }]) {
      const telnyx = fakeTelnyx({ "assistant-shop": app });
      expect((await ensureCallEndCallback({ apiKey: "k", assistantId: "assistant-shop", publicBaseUrl: "https://front-office.example", apply: false, fetcher: telnyx.fetcher })).action).toBe("would_set");
    }
  });

  it("retries a 503 and gives up loudly when Telnyx stays down", async () => {
    const flaky = fakeTelnyx({ "assistant-shop": {} }, { fail: { "PATCH /v2/texml_applications/texml-assistant-shop": 2 } });
    expect((await ensureCallEndCallback({ apiKey: "k", assistantId: "assistant-shop", publicBaseUrl: "https://front-office.example", apply: true, fetcher: flaky.fetcher, sleep: noSleep })).action).toBe("set");
    const down = fakeTelnyx({ "assistant-shop": {} }, { fail: { "PATCH /v2/texml_applications/texml-assistant-shop": 9 } });
    await expect(ensureCallEndCallback({ apiKey: "k", assistantId: "assistant-shop", publicBaseUrl: "https://front-office.example", apply: true, fetcher: down.fetcher, sleep: noSleep })).rejects.toBeInstanceOf(CallEndCallbackError);
  });

  it("fails when Telnyx answers 200 but did not store the callback, or the assistant has no TeXML app", async () => {
    const ignored = fakeTelnyx({ "assistant-shop": {} }, { ignoreWrites: true });
    await expect(ensureCallEndCallback({ apiKey: "k", assistantId: "assistant-shop", publicBaseUrl: "https://front-office.example", apply: true, fetcher: ignored.fetcher, sleep: noSleep })).rejects.toThrow("did not persist");
    const bare = fakeTelnyx({ "assistant-shop": null });
    await expect(ensureCallEndCallback({ apiKey: "k", assistantId: "assistant-shop", publicBaseUrl: "https://front-office.example", apply: true, fetcher: bare.fetcher, sleep: noSleep })).rejects.toThrow("no default TeXML application");
  });
});

async function twoShops() {
  const store = new InMemoryStore();
  await store.saveConfig({ ...createDemoConfig(), paused: false });
  const stamp = "2026-11-26T12:00:00.000Z";
  for (const [tenantId, assistantId, paused] of [["shop_live", "assistant-live", false], ["shop_paused", "assistant-paused", true]] as const) {
    await store.saveConfig({ ...createDemoConfig(tenantId), paused });
    await store.saveProviderRoute({ provider: "telnyx", externalId: assistantId, tenantId, createdAt: stamp, updatedAt: stamp });
  }
  await store.saveProviderRoute({ provider: "telnyx", externalId: "assistant-demo", tenantId: "demo", createdAt: stamp, updatedAt: stamp });
  return store;
}

describe("configure-telnyx repair path", () => {
  it("sets the end-of-call callback on the demo assistant and on every shop's own assistant", async () => {
    const store = await twoShops();
    const pushes = await planAssistantPushes({ store, defaultTenantId: "demo", demoAssistantId: "assistant-demo", publicBaseUrl: "https://front-office.example" });
    // Production on the walk: the demo app was set, the shops' apps were not.
    const telnyx = fakeTelnyx({ "assistant-demo": { status_callback: WANT, call_cost_in_webhooks: true }, "assistant-live": {}, "assistant-paused": {} });

    const dryRun = await syncCallEndCallbacks({ pushes, apiKey: "k", publicBaseUrl: "https://front-office.example", apply: false, fetcher: telnyx.fetcher, sleep: noSleep });
    expect(dryRun.map((item) => [item.tenantId, item.action])).toEqual([["demo", "already_set"], ["shop_live", "would_set"], ["shop_paused", "would_set"]]);
    expect(telnyx.requests.every((request) => request.method === "GET")).toBe(true);

    const applied = await syncCallEndCallbacks({ pushes, apiKey: "k", publicBaseUrl: "https://front-office.example", apply: true, fetcher: telnyx.fetcher, sleep: noSleep });
    expect(applied.map((item) => item.action)).toEqual(["already_set", "set", "set"]);
    for (const assistantId of ["assistant-live", "assistant-paused"]) {
      expect(telnyx.app(assistantId)).toMatchObject({ status_callback: WANT, status_callback_method: "post", call_cost_in_webhooks: true });
    }
  });

  it("keeps going when one assistant fails and says which", async () => {
    const store = await twoShops();
    const pushes = await planAssistantPushes({ store, defaultTenantId: "demo", demoAssistantId: "assistant-demo", publicBaseUrl: "https://front-office.example" });
    const telnyx = fakeTelnyx({ "assistant-demo": {}, "assistant-paused": {} });
    const applied = await syncCallEndCallbacks({ pushes, apiKey: "k", publicBaseUrl: "https://front-office.example", apply: true, fetcher: telnyx.fetcher, sleep: noSleep });
    expect(applied.map((item) => [item.tenantId, item.action])).toEqual([["demo", "set"], ["shop_live", "failed"], ["shop_paused", "set"]]);
    expect(applied[1]!.error).toContain("HTTP 404");
  });
});

describe("line health check", () => {
  it("logs an error naming the shop whose live line lacks the callback, and never writes", async () => {
    const store = await twoShops();
    const telnyx = fakeTelnyx({ "assistant-demo": { status_callback: WANT, call_cost_in_webhooks: true }, "assistant-live": {}, "assistant-paused": {} });
    const logs: Array<Record<string, unknown>> = [];
    const alerted: string[] = [];
    const health = new LineHealthCheck(store, { apiKey: "k", publicBaseUrl: "https://front-office.example", log: (entry) => { logs.push(entry); }, onMissing: (tenantId) => { alerted.push(tenantId); }, fetcher: telnyx.fetcher, sleep: noSleep });
    expect(await health.runOnce()).toEqual({ checked: 3, missing: 2, failed: 0 });
    expect(logs.filter((entry) => entry.event === "line_call_end_callback_missing")).toEqual([
      expect.objectContaining({ level: "error", tenantId: "shop_live", lineOn: true }),
      // A paused line takes no calls: a warning until it is turned back on.
      expect.objectContaining({ level: "warn", tenantId: "shop_paused", lineOn: false }),
    ]);
    expect(alerted).toEqual(["shop_live"]);
    expect(telnyx.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("is quiet when every line is set, and reports a shop it could not read without stopping", async () => {
    const store = await twoShops();
    const set = { status_callback: WANT, call_cost_in_webhooks: true };
    // A callback that delivers but without call cost (a hand patch) still finalizes calls: no alarm.
    const noCost = { status_callback: WANT, call_cost_in_webhooks: false };
    const logs: Array<Record<string, unknown>> = [];
    const healthy = new LineHealthCheck(store, { apiKey: "k", publicBaseUrl: "https://front-office.example", log: (entry) => { logs.push(entry); }, fetcher: fakeTelnyx({ "assistant-demo": set, "assistant-live": noCost, "assistant-paused": set }).fetcher, sleep: noSleep });
    expect(await healthy.runOnce()).toEqual({ checked: 3, missing: 0, failed: 0 });
    expect(logs).toEqual([]);

    const broken = new LineHealthCheck(store, { apiKey: "k", publicBaseUrl: "https://front-office.example", log: (entry) => { logs.push(entry); }, fetcher: fakeTelnyx({ "assistant-demo": set, "assistant-paused": set }).fetcher, sleep: noSleep });
    expect(await broken.runOnce()).toEqual({ checked: 2, missing: 0, failed: 1 });
    expect(logs).toEqual([expect.objectContaining({ level: "error", event: "line_health_check_failed", tenantId: "shop_live" })]);
  });
});
