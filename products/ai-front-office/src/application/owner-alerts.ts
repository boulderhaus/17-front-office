import { randomUUID } from "node:crypto";
import type { OutboxNotification } from "../domain/models.js";
import { formatEmailBody } from "../adapters/resend.js";
import { callerFirstName, OWNER_SMS_PREFIX } from "../domain/owner-sms.js";
import type { CallRecord } from "../domain/models.js";
import { pushBody, type PushMessage } from "../adapters/web-push.js";

/**
 * The owner's new-call email: the same words as the owner text, so an owner without texts (texting not approved
 * yet, or never opted in) still hears about every lead. Subject is the text's first line:
 * "Front Office: URGENT: no AC" or "Front Office: New call: Maria".
 */
export function ownerCallEmail(smsBody: string, settingsUrl: string): string {
  const lines = smsBody.replace(new RegExp(`^${OWNER_SMS_PREFIX}`), "").split("\n");
  return formatEmailBody(`${OWNER_SMS_PREFIX}${lines[0] ?? "New call"}`, `${lines.join("\n")}\n\nChange your call alerts in Settings: ${settingsUrl}`);
}

/** One owner email for a call, unique per call and kind (keyBase), so a retry never sends it twice. */
export function ownerCallEmailNotification(input: { tenantId: string; callId: string; email: string; smsBody: string; settingsUrl: string; high: boolean; keyBase: string; now: string }): OutboxNotification {
  return {
    id: randomUUID(), tenantId: input.tenantId, callId: input.callId, channel: "email",
    destinationRef: `email:${input.email}`,
    body: ownerCallEmail(input.smsBody, input.settingsUrl),
    priority: input.high ? "high" : "normal", state: "pending", attempts: 0, nextAttemptAt: input.now,
    idempotencyKey: `${input.keyBase}:email`,
    providerReceipt: null, lastError: null, createdAt: input.now, sentAt: null,
  };
}

/**
 * The owner text as a phone notification: its first line is the title ("URGENT: no AC" or "New call: Maria"),
 * the short lines after it the body, and a tap opens the call in the app (the owner is signed in there,
 * so no call-back link). Same tag per call, so the end-of-call summary replaces an earlier handoff alert.
 */
export function ownerCallPushMessage(smsBody: string, callId: string, urgent: boolean): PushMessage {
  const lines = smsBody.replace(new RegExp(`^${OWNER_SMS_PREFIX}`), "").split("\n");
  const blank = lines.indexOf("");
  const content = (blank === -1 ? lines : lines.slice(0, blank)).map((line) => line.replace(/^- /, "").trim()).filter(Boolean);
  return {
    title: content[0] ?? "New call",
    body: content.slice(1).join(" · ") || "Open Front Office to see the call.",
    url: `/app/calls/${encodeURIComponent(callId)}`,
    tag: `call:${callId}`,
    urgent,
  };
}

/** A push to every phone with call alerts on; a no-op send when the shop has none. */
export function ownerPushNotification(input: { tenantId: string; callId: string | null; message: PushMessage; keyBase: string; now: string; destinationRef?: string }): OutboxNotification {
  return {
    id: randomUUID(), tenantId: input.tenantId, callId: input.callId, channel: "push",
    destinationRef: input.destinationRef ?? "devices",
    body: pushBody(input.message),
    priority: input.message.urgent ? "high" : "normal", state: "pending", attempts: 0, nextAttemptAt: input.now,
    idempotencyKey: `${input.keyBase}:push`,
    providerReceipt: null, lastError: null, createdAt: input.now, sentAt: null,
  };
}

/**
 * What the urgent owner call says, in plain spoken words:
 * "Front Office: urgent call from Maria, no AC, wants someone today. Check your Front Office app."
 */
export function urgentCallSpeech(call: Pick<CallRecord, "fields" | "emergency">, wants: string | null): string {
  const name = callerFirstName(call.fields.callerName);
  const who = name === "Unknown caller" ? "a caller" : name;
  const evidence = call.emergency?.evidence.find((item) => item.trim());
  const what = (call.fields.problemDescription || evidence || "").replace(/\s+/g, " ").trim().slice(0, 90).replace(/[.,;:\s]+$/, "");
  const parts = [`Front Office: urgent call from ${who}`, what, wants ? wants.replace(/^Wants/, "wants") : null].filter(Boolean);
  return `${parts.join(", ")}. Check your Front Office app.`;
}

/** One urgent owner call per call record, to the owner's mobile. */
export function urgentOwnerCallNotification(input: { tenantId: string; callId: string; speech: string; now: string }): OutboxNotification {
  return {
    id: randomUUID(), tenantId: input.tenantId, callId: input.callId, channel: "voice",
    destinationRef: "owner-primary",
    body: input.speech,
    priority: "high", state: "pending", attempts: 0, nextAttemptAt: input.now,
    idempotencyKey: `urgent-owner-call:${input.callId}`,
    providerReceipt: null, lastError: null, createdAt: input.now, sentAt: null,
  };
}

/** "(941) 555-0123" from "+19415550123". */
function spokenNumber(e164: string): string {
  const digits = e164.replace(/^\+1/, "");
  return /^\d{10}$/.test(digits) ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : e164;
}

/**
 * "Your line is live": by push, email and (once texting is approved, for opted-in owners) text. One of each per
 * number, so a retry or a second replica never repeats it.
 */
export function lineLiveNotifications(input: { tenantId: string; businessName: string; inboundNumber: string; baseUrl: string; email: string | null; pushOn: boolean; smsRefs: string[]; now: string }): OutboxNotification[] {
  const number = spokenNumber(input.inboundNumber);
  const keyBase = `line-live:${input.tenantId}:${input.inboundNumber}`;
  const base = input.baseUrl.replace(/\/$/, "");
  const common = { tenantId: input.tenantId, callId: null, priority: "normal" as const, state: "pending" as const, attempts: 0, nextAttemptAt: input.now, providerReceipt: null, lastError: null, createdAt: input.now, sentAt: null };
  const out: OutboxNotification[] = [];
  if (input.pushOn) out.push(ownerPushNotification({ tenantId: input.tenantId, callId: null, keyBase, now: input.now, message: { title: "Your line is live", body: `${number} now answers for ${input.businessName}.`, url: "/app", tag: "line-live" } }));
  if (input.email) {
    out.push({ ...common, id: randomUUID(), channel: "email", destinationRef: `email:${input.email}`, idempotencyKey: `${keyBase}:email`,
      body: formatEmailBody("Your Front Office line is live", `Your Front Office number ${number} now answers for ${input.businessName}.\n\nIf you haven't yet, send your missed calls to it: ${base}/app/start?step=forward\n\nSee your calls: ${base}/app`) });
  }
  for (const destinationRef of input.smsRefs) {
    out.push({ ...common, id: randomUUID(), channel: "sms", destinationRef, idempotencyKey: `${keyBase}:sms:${destinationRef}`,
      body: `Your line is live. ${number} now answers for ${input.businessName}.` });
  }
  return out;
}
