import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, randomUUID, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import {
  encryptPushPayload, generateVapidKeys, listPushSubscriptions, parsePushSubscription, savePushSubscription, vapidAuthorization, WebPushSender,
} from "../src/adapters/web-push.js";
import { OutboxWorker } from "../src/application/outbox-worker.js";
import { CallService } from "../src/application/call-service.js";
import { ownerCallPushMessage, ownerPushNotification } from "../src/application/owner-alerts.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";

function browserSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/synthetic-device") {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  return { ua, auth, json: { endpoint, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } };
}

/** What the browser does with an aes128gcm push body (RFC 8291), to prove ours decrypts. */
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20]!;
  const asPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const raw = ua.computeSecret(asPublic);
  const shared = Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1).toString();
}

describe("web push call alerts", () => {
  const now = new Date("2026-11-23T15:00:00.000Z");
  const clock = { now: () => now };
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = null; });

  it("encrypts so the phone can read it, and signs a VAPID token the push service can verify", () => {
    const { ua, auth, json } = browserSubscription();
    const parsed = parsePushSubscription(json)!;
    const body = encryptPushPayload(Buffer.from("{\"title\":\"New call: Maria\"}"), parsed);
    expect(decrypt(body, ua, auth)).toBe("{\"title\":\"New call: Maria\"}");

    const keys = { ...generateVapidKeys(), subject: "mailto:hello@example.test" };
    const header = vapidAuthorization(json.endpoint, keys, now);
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(key).toBe(keys.publicKey);
    const [head, claims, signature] = token!.split(".");
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:hello@example.test" });
    const publicKey = Buffer.from(keys.publicKey, "base64url");
    const jwk = createPublicKey({ key: { kty: "EC", crv: "P-256", x: publicKey.subarray(1, 33).toString("base64url"), y: publicKey.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${head}.${claims}`), { key: jwk, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("decrypts for every key, including the 1-in-256 shared secrets with a leading zero byte", () => {
    const { ua, auth, json } = browserSubscription();
    const parsed = parsePushSubscription(json)!;
    for (let index = 0; index < 1_500; index += 1) {
      expect(decrypt(encryptPushPayload(Buffer.from(`n${index}`), parsed), ua, auth)).toBe(`n${index}`);
    }
    for (let index = 0; index < 300; index += 1) expect(generateVapidKeys().privateKey).toHaveLength(43);
  });

  it("accepts only the browsers' own push services over HTTPS", () => {
    const { json } = browserSubscription();
    expect(parsePushSubscription(json)).not.toBeNull();
    expect(parsePushSubscription({ ...json, endpoint: "https://web.push.apple.com/QOabc" })).not.toBeNull();
    expect(parsePushSubscription({ ...json, endpoint: "https://evil.example/fcm" })).toBeNull();
    expect(parsePushSubscription({ ...json, endpoint: "http://fcm.googleapis.com/fcm/send/x" })).toBeNull();
    expect(parsePushSubscription({ ...json, endpoint: "https://fcm.googleapis.com:8443/x" })).toBeNull();
    expect(parsePushSubscription({ ...json, keys: { ...json.keys, auth: "short" } })).toBeNull();
  });

  it("sends to every phone, forgets a phone the push service says is gone, and gives each send its own receipt", async () => {
    const store = new InMemoryStore();
    const phoneA = browserSubscription("https://fcm.googleapis.com/fcm/send/a");
    const phoneB = browserSubscription("https://fcm.googleapis.com/fcm/send/b");
    for (const phone of [phoneA, phoneB]) await savePushSubscription(store, "shop", { ...parsePushSubscription(phone.json)!, accountId: "owner" }, now.toISOString());
    const seen: string[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/b")) return new Response(null, { status: 410 });
      seen.push(decrypt(Buffer.from(init.body as Uint8Array), phoneA.ua, phoneA.auth));
      expect((init.headers as Record<string, string>).urgency).toBe("high");
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const sender = new WebPushSender({ store, clock, fetcher, vapid: { ...generateVapidKeys(), subject: "mailto:hello@example.test" } });
    const message = ownerCallPushMessage("Otto: URGENT: gas smell\nNew call: Maria\n- Gas smell in kitchen\n- 41 Palm Ave, Sarasota\n\nCall back: https://x.example/c/abc", "11111111-1111-4111-8111-111111111111", true);
    expect(message).toMatchObject({ title: "URGENT: gas smell", body: "New call: Maria · Gas smell in kitchen · 41 Palm Ave, Sarasota", url: "/app/calls/11111111-1111-4111-8111-111111111111" });
    const first = ownerPushNotification({ tenantId: "shop", callId: null, message, keyBase: "k1", now: now.toISOString() });
    const second = ownerPushNotification({ tenantId: "shop", callId: null, message, keyBase: "k2", now: now.toISOString() });
    const receipts = [await sender.send(first), await sender.send(second)];
    expect(receipts[0]!.providerReceipt).not.toBe(receipts[1]!.providerReceipt);
    expect(JSON.parse(seen[0]!)).toMatchObject({ title: "URGENT: gas smell", url: "/app/calls/11111111-1111-4111-8111-111111111111" });
    expect((await listPushSubscriptions(store, "shop")).map((item) => item.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/a"]);
  });

  it("retries when any phone failed, and keeps a phone the push service refused on credentials (401/403)", async () => {
    const store = new InMemoryStore();
    for (const name of ["a", "b", "c"]) await savePushSubscription(store, "shop", { ...parsePushSubscription(browserSubscription(`https://fcm.googleapis.com/fcm/send/${name}`).json)!, accountId: "owner" }, now.toISOString());
    const status: Record<string, number> = { a: 201, b: 503, c: 403 };
    const fetcher = (async (url: string) => new Response(null, { status: status[url.slice(-1)]! })) as unknown as typeof fetch;
    const sender = new WebPushSender({ store, clock, fetcher, vapid: { ...generateVapidKeys(), subject: "mailto:hello@example.test" } });
    await expect(sender.send(ownerPushNotification({ tenantId: "shop", callId: null, message: { title: "t", body: "b", url: "/app" }, keyBase: "k", now: now.toISOString() }))).rejects.toThrow("1 delivered");
    expect((await listPushSubscriptions(store, "shop")).map((item) => item.endpoint.slice(-1))).toEqual(["a", "b", "c"]);
  });

  it("retries when no phone took it, and succeeds quietly when the shop has no phones", async () => {
    const store = new InMemoryStore();
    const vapid = { ...generateVapidKeys(), subject: "mailto:hello@example.test" };
    const message = { title: "New call: Maria", body: "AC", url: "/app" };
    const none = await new WebPushSender({ store, clock, vapid, fetcher: vi.fn() as unknown as typeof fetch }).send(ownerPushNotification({ tenantId: "shop", callId: null, message, keyBase: "k", now: now.toISOString() }));
    expect(none.providerReceipt).toMatch(/:none$/);
    await savePushSubscription(store, "shop", { ...parsePushSubscription(browserSubscription().json)!, accountId: "owner" }, now.toISOString());
    const down = new WebPushSender({ store, clock, vapid, fetcher: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch });
    await expect(down.send(ownerPushNotification({ tenantId: "shop", callId: null, message, keyBase: "k2", now: now.toISOString() }))).rejects.toThrow("Web push failed");
  });

  it("queues a push for every lead once a phone has alerts on, whatever the instant-texts switch says", async () => {
    const store = new InMemoryStore();
    const tenantId = "shop_push";
    await store.createOwnerWorkspace({
      account: { id: randomUUID(), tenantId, email: "owner@example.test", displayName: "Owner", passwordHash: "synthetic", role: "owner", status: "active", createdAt: now.toISOString(), updatedAt: now.toISOString() },
      config: { ...createDemoConfig(tenantId), ownerNotificationRefs: [], ownerRealtimeSmsEnabled: false },
      ownerPhone: "+15555550100",
    });
    const service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example", { pushAvailable: true });
    const finish = (id: string) => service.finalize({
      webhookEventId: `end:${id}`, tenantId, providerCallId: id, fromNumber: "+15555550142", startedAt: "2026-11-23T14:50:00.000Z", endedAt: now.toISOString(), durationSeconds: 95,
      fields: { callerName: "Maria Gonzalez", companyName: null, callbackNumber: "+15555550142", address: "41 Palm Ave, Sarasota, FL", serviceCategory: "HVAC repair", serviceCategoryConfidence: 0.9, problemDescription: "AC not cooling", equipmentDetails: null, accessNotes: null, requestedStart: null, explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: false, confidence: 0.9 },
      transcript: "Synthetic", recordingUrl: null, consentState: "disclosed",
    });
    await finish("push-0");
    expect([...store.notifications.values()].some((item) => item.channel === "push")).toBe(false);
    await savePushSubscription(store, tenantId, { ...parsePushSubscription(browserSubscription().json)!, accountId: "owner" }, now.toISOString());
    const call = await finish("push-1");
    const pushes = [...store.notifications.values()].filter((item) => item.channel === "push");
    expect(pushes).toHaveLength(1);
    expect(JSON.parse(pushes[0]!.body)).toMatchObject({ title: "New call: Maria", url: `/app/calls/${call.id}` });
    expect([...store.notifications.values()].some((item) => item.channel === "sms")).toBe(false);
  });

  it("serves the service worker and manifest, and saves a phone from the app with a confirmation push to it", async () => {
    const keys = generateVapidKeys();
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    const worker = await fetch(`${base}/app/sw.js`);
    expect(worker.headers.get("content-type")).toContain("javascript");
    expect(worker.headers.get("service-worker-allowed")).toBe("/app");
    const source = await worker.text();
    expect(source).toContain("showNotification");
    expect(source).not.toContain("\"fetch\"");
    expect(await (await fetch(`${base}/app/manifest.webmanifest`)).json()).toMatchObject({ start_url: "/app", display: "standalone" });
    expect((await fetch(`${base}/assets/icon-192.png`)).headers.get("content-type")).toBe("image/png");

    const signup = await fetch(`${base}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Gulf Air", email: "owner@push.example", password: "synthetic-password-42", consent: "yes", phone: "9415550199" }) });
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const dashboard = await (await fetch(`${base}/api/app/dashboard`, { headers: { cookie } })).json() as { csrf: string; push: { publicKey: string; devices: number } };
    expect(dashboard.push).toEqual({ publicKey: keys.publicKey, devices: 0 });
    const subscribe = (body: unknown, csrf = dashboard.csrf) => fetch(`${base}/api/app/push/subscribe`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
    expect((await subscribe(browserSubscription().json, "forged")).status).toBe(403);
    expect((await subscribe({ ...browserSubscription().json, endpoint: "https://evil.example/x" })).status).toBe(400);
    const saved = await subscribe(browserSubscription().json);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ on: true, devices: 1 });
    const account = (await store.getOwnerAccountByEmail("owner@push.example"))!;
    const welcome = [...store.notifications.values()].find((item) => item.channel === "push" && item.tenantId === account.tenantId)!;
    expect(welcome.destinationRef).toMatch(/^device:[0-9a-f]{16}$/);
    expect(JSON.parse(welcome.body).title).toBe("Call alerts are on");
    // The outbox sends it like any other alert.
    const fetcher = vi.fn(async () => new Response(null, { status: 201 })) as unknown as typeof fetch;
    const result = await new OutboxWorker(store, new WebPushSender({ store, clock, fetcher, vapid: { ...keys, subject: "mailto:hello@example.test" } }), clock).runOnce();
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
