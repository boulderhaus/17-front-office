import { randomUUID } from "node:crypto";
import type { OutboxNotification } from "../domain/models.js";
import { formatEmailBody } from "../adapters/resend.js";
import { OWNER_SMS_PREFIX } from "../domain/owner-sms.js";
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
