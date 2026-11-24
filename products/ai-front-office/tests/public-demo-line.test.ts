import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { NotificationRouter } from "../src/adapters/notification-router.js";
import { loadEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";
import { NotificationHeldError } from "../src/ports.js";

const now = new Date("2026-11-24T15:00:00.000Z");

describe("public demo line after provider test mode is off", () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = null; });

  async function start(extra: Record<string, string>, setup?: (store: InMemoryStore) => Promise<void>) {
    const keys = generateKeyPairSync("ed25519");
    const rawPublicKey = (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
    const env = loadEnvironment({
      NODE_ENV: "production", DEMO_MODE: "false", PROVIDER_TEST_MODE: "false", LIVE_PROVIDER_PROOF_AT: "2026-11-01T00:00:00Z", PUBLIC_BASE_URL: "https://front-office.example",
      ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", SESSION_SIGNING_KEY: "session-signing-key-abcdefghijklmnopqrstuvwxyz",
      DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      TELNYX_API_KEY: "KEY_synthetic", TELNYX_PUBLIC_KEY: rawPublicKey, TELNYX_FROM_NUMBER: "+15555550199", TELNYX_ASSISTANT_ID: "demo-assistant",
      ...extra,
    });
    const store = new InMemoryStore();
    await store.saveConfig({ ...createDemoConfig("demo"), paused: false });
    await store.saveProviderRoute({ provider: "telnyx", externalId: "demo-assistant", tenantId: "demo", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    await setup?.(store);
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => now }, integrations: {}, logger: () => undefined }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return async () => {
      const body = JSON.stringify({ data: { record_type: "event", event_type: "assistant.initialization", id: `evt-${randomUUID()}`, occurred_at: now.toISOString(), payload: { telnyx_conversation_channel: "phone_call", telnyx_agent_target: "+15555550199", telnyx_end_user_target: "+19415550110", call_control_id: `v3:${randomUUID()}`, assistant_id: "demo-assistant" } } });
      const timestamp = String(Math.floor(now.getTime() / 1_000));
      return fetch(`http://127.0.0.1:${address.port}/webhooks/telnyx`, { method: "POST", headers: { "content-type": "application/json", "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": sign(null, Buffer.from(`${timestamp}|${body}`), keys.privateKey).toString("base64") }, body });
    };
  }

  it("keeps answering when it is the named public demo tenant, and only then", async () => {
    const exempt = await start({ PUBLIC_DEMO_TENANT_ID: "demo" });
    const answered = await exempt();
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { dynamic_variables: { call_access: string } }).dynamic_variables.call_access).toBe("allowed");
    await new Promise<void>((resolve) => server!.close(() => resolve())); server = null;
    // Without the explicit id, the demo tenant faces the full readiness gate (no test-mode leak).
    expect((await (await start({}))()).status).toBe(503);
  });

  it("never exempts a tenant that belongs to a real shop", async () => {
    // Even if the env names it: a tenant with an owner account is a real shop and keeps the paid gate.
    const call = await start({ PUBLIC_DEMO_TENANT_ID: "demo-shop" }, async (store) => {
      await store.createOwnerWorkspace({
        account: { id: randomUUID(), tenantId: "demo-shop", email: "owner@example.test", displayName: "Owner", passwordHash: "synthetic", role: "owner", status: "pending_activation", createdAt: now.toISOString(), updatedAt: now.toISOString() },
        config: { ...createDemoConfig("demo-shop"), paused: false }, ownerPhone: "+15555550100",
      });
      await store.saveProviderRoute({ provider: "telnyx", externalId: "demo-assistant", tenantId: "demo-shop", createdAt: now.toISOString(), updatedAt: now.toISOString() });
    });
    expect((await call()).status).toBe(503);
  });

  it("sends nothing from the public demo tenant on any channel", async () => {
    const sender = { send: vi.fn(async () => ({ providerReceipt: "x" })) };
    const router = new NotificationRouter(sender, sender, sender, sender, new Set(["demo"]));
    for (const channel of ["sms", "email", "push", "voice"] as const) {
      await expect(router.send({ id: randomUUID(), tenantId: "demo", callId: null, channel, destinationRef: "owner-primary", body: "x", priority: "high", state: "pending", attempts: 0, nextAttemptAt: now.toISOString(), idempotencyKey: `k-${channel}`, providerReceipt: null, lastError: null, createdAt: now.toISOString(), sentAt: null })).rejects.toBeInstanceOf(NotificationHeldError);
    }
    expect(sender.send).not.toHaveBeenCalled();
    await expect(router.send({ id: randomUUID(), tenantId: "shop", callId: null, channel: "sms", destinationRef: "owner-primary", body: "x", priority: "high", state: "pending", attempts: 0, nextAttemptAt: now.toISOString(), idempotencyKey: "k-shop", providerReceipt: null, lastError: null, createdAt: now.toISOString(), sentAt: null })).resolves.toEqual({ providerReceipt: "x" });
  });
});
