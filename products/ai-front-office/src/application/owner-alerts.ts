import { randomUUID } from "node:crypto";
import type { OutboxNotification } from "../domain/models.js";
import { formatEmailBody } from "../adapters/resend.js";
import { OWNER_SMS_PREFIX } from "../domain/owner-sms.js";

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
