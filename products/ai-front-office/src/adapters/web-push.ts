import { createCipheriv, createECDH, createHash, createPrivateKey, hkdfSync, randomBytes, sign, type ECDH } from "node:crypto";
import { z } from "zod";
import { withTimeout } from "../application/retry.js";
import type { OutboxNotification } from "../domain/models.js";
import type { Clock, NotificationPort, Store } from "../ports.js";

/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), no dependencies.
 * Owners turn on "call alerts" per phone in the app; each lead then reaches every phone that said yes,
 * with a tap that opens the call. This works today, before carrier texting approval.
 */

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (65 bytes): the browser's applicationServerKey. */
  publicKey: string;
  /** The private scalar d, base64url (32 bytes). */
  privateKey: string;
  /** mailto: or https: contact the push services can reach. */
  subject: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
  accountId: string;
  createdAt: string;
}

/** What a push notification says. Kept short: it is shown on a lock screen. */
export interface PushMessage {
  title: string;
  body: string;
  /** Same-origin path the tap opens, e.g. /app/calls/{id}. */
  url: string;
  /** A newer notification with the same tag replaces the older one (the summary replaces the handoff alert). */
  tag?: string;
  urgent?: boolean;
}

/** Only the browsers' own push services: a subscription is never a way to make us POST anywhere else. */
const PUSH_HOST = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;
const MAX_DEVICES = 10;
const base64url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/);
const subscriptionSchema = z.object({
  endpoint: z.string().url().max(1_000),
  keys: z.object({ p256dh: base64url.max(200), auth: base64url.max(100) }),
});

/** A browser's PushSubscription.toJSON(), checked: a known push service over HTTPS and well-formed keys. */
export function parsePushSubscription(value: unknown): { endpoint: string; p256dh: string; auth: string } | null {
  const parsed = subscriptionSchema.safeParse(value);
  if (!parsed.success) return null;
  const url = new URL(parsed.data.endpoint);
  if (url.protocol !== "https:" || url.port || url.username || url.password || !PUSH_HOST.test(url.hostname)) return null;
  const p256dh = Buffer.from(parsed.data.keys.p256dh, "base64url");
  const auth = Buffer.from(parsed.data.keys.auth, "base64url");
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return null;
  return { endpoint: url.toString(), p256dh: p256dh.toString("base64url"), auth: auth.toString("base64url") };
}

/** Short, stable id for one phone's subscription, safe to log and use as a destination. */
export function deviceId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

export async function listPushSubscriptions(store: Store, tenantId: string): Promise<PushSubscriptionRecord[]> {
  const raw = await store.getIntegrationSecret(tenantId, "push", "subscriptions");
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is PushSubscriptionRecord => typeof item?.endpoint === "string" && typeof item?.p256dh === "string" && typeof item?.auth === "string") : [];
  } catch {
    return [];
  }
}

/** Add (or refresh) one phone. The newest ten phones per shop are kept. */
export async function savePushSubscription(store: Store, tenantId: string, subscription: Omit<PushSubscriptionRecord, "createdAt">, now: string): Promise<void> {
  await store.withLock(`push:${tenantId}`, async () => {
    const others = (await listPushSubscriptions(store, tenantId)).filter((item) => item.endpoint !== subscription.endpoint);
    const next = [...others, { ...subscription, createdAt: now }].slice(-MAX_DEVICES);
    await store.saveIntegrationSecret(tenantId, "push", "subscriptions", JSON.stringify(next));
  });
}

export async function removePushSubscriptions(store: Store, tenantId: string, endpoints: string[]): Promise<void> {
  if (endpoints.length === 0) return;
  await store.withLock(`push:${tenantId}`, async () => {
    const current = await listPushSubscriptions(store, tenantId);
    const next = current.filter((item) => !endpoints.includes(item.endpoint));
    if (next.length === current.length) return;
    if (next.length === 0) await store.deleteIntegrationSecret(tenantId, "push", "subscriptions");
    else await store.saveIntegrationSecret(tenantId, "push", "subscriptions", JSON.stringify(next));
  });
}

/** A fresh VAPID key pair (scripts and tests). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: fixed32(ecdh.getPrivateKey()).toString("base64url") };
}

/** True when the pair is a real P-256 key pair (the public key is the private key's). */
export function validVapidKeys(publicKey: string, privateKey: string): boolean {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
    return ecdh.getPublicKey().equals(Buffer.from(publicKey, "base64url"));
  } catch {
    return false;
  }
}

/** The Authorization header for one push service: a 12-hour ES256 JWT for that origin, plus our public key. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now: Date): string {
  const publicKey = Buffer.from(keys.publicKey, "base64url");
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: publicKey.subarray(1, 33).toString("base64url"), y: publicKey.subarray(33, 65).toString("base64url") },
    format: "jwk",
  });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1_000) + 12 * 3_600, sub: keys.subject })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `vapid t=${unsigned}.${signature}, k=${keys.publicKey}`;
}

/** RFC 8291 aes128gcm: one record, salt + record size + our ephemeral public key in the header. */
export function encryptPushPayload(payload: Buffer, subscription: { p256dh: string; auth: string }, options: { ephemeral?: ECDH; salt?: Buffer } = {}): Buffer {
  const uaPublic = Buffer.from(subscription.p256dh, "base64url");
  const authSecret = Buffer.from(subscription.auth, "base64url");
  const ephemeral = options.ephemeral ?? createECDH("prime256v1");
  if (!options.ephemeral) ephemeral.generateKeys();
  const asPublic = ephemeral.getPublicKey();
  // RFC 8291 uses the full 32-byte x-coordinate; OpenSSL drops leading zero bytes (about 1 send in 256).
  const shared = fixed32(ephemeral.computeSecret(uaPublic));
  const salt = options.salt ?? randomBytes(16);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4_096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

/** A P-256 scalar or shared secret as exactly 32 bytes, left-padded with zeros. */
function fixed32(value: Buffer): Buffer {
  if (value.length > 32) throw new Error("Unexpected P-256 value length");
  if (value.length === 32) return value;
  const out = Buffer.alloc(32);
  value.copy(out, 32 - value.length);
  return out;
}

/** The outbox body of a push notification. */
export function pushBody(message: PushMessage): string {
  return JSON.stringify({ title: message.title.slice(0, 80), body: message.body.slice(0, 240), url: message.url, tag: message.tag, urgent: message.urgent === true });
}

/**
 * Sends a "push" outbox notification to the shop's phones: destinationRef "devices" (every phone) or
 * "device:{deviceId}" (one phone, e.g. the confirmation right after turning alerts on). A phone the push
 * service says is gone is forgotten. Any temporary failure throws so the outbox retries.
 */
export class WebPushSender implements NotificationPort {
  constructor(private readonly options: { store: Store; vapid: VapidKeys; clock: Clock; fetcher?: typeof fetch; log?: (entry: Record<string, unknown>) => void }) {}

  async send(notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    if (notification.channel !== "push") throw new Error("Web push only sends push notifications");
    const message = JSON.parse(notification.body) as PushMessage;
    const all = await listPushSubscriptions(this.options.store, notification.tenantId);
    const targets = notification.destinationRef === "devices" ? all : all.filter((item) => `device:${deviceId(item.endpoint)}` === notification.destinationRef);
    if (targets.length === 0) return { providerReceipt: `push:${notification.id}:none` };
    const payload = Buffer.from(JSON.stringify(message));
    const gone: string[] = [];
    let delivered = 0;
    let lastError: string | null = null;
    for (const target of targets) {
      try {
        const response = await withTimeout((this.options.fetcher ?? fetch)(target.endpoint, {
          method: "POST",
          headers: {
            authorization: vapidAuthorization(target.endpoint, this.options.vapid, this.options.clock.now()),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: message.urgent ? "3600" : "86400",
            urgency: message.urgent ? "high" : "normal",
          },
          body: encryptPushPayload(payload, target),
        }), 4_000);
        // Gone (404/410) or no longer ours (401/403: e.g. keys changed): forget the phone rather than retry forever.
        if ([401, 403, 404, 410].includes(response.status)) gone.push(target.endpoint);
        else if (response.ok) delivered += 1;
        else lastError = `push service HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message.slice(0, 200) : "push failed";
      }
    }
    if (gone.length > 0) {
      await removePushSubscriptions(this.options.store, notification.tenantId, gone);
      this.options.log?.({ level: "info", event: "push_devices_forgotten", tenantId: notification.tenantId, count: gone.length });
    }
    // Any phone that failed for a temporary reason: retry the whole notification. Phones that already have it
    // show the retry in place of the first (same tag); forgotten phones are skipped.
    if (lastError) throw new Error(`Web push failed (${delivered} delivered): ${lastError}`);
    return { providerReceipt: `push:${notification.id}:${delivered}` };
  }
}
