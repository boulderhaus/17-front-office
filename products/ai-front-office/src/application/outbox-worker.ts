import { randomUUID } from "node:crypto";
import type { OutboxNotification } from "../domain/models.js";
import { NotificationHeldError, type Clock, type NotificationPort, type Store } from "../ports.js";
import { redactError, withRetry } from "./retry.js";

export class OutboxWorker {
  constructor(
    private readonly store: Store,
    private readonly sender: NotificationPort,
    private readonly clock: Clock,
  ) {}

  async runOnce(limit = 20): Promise<{ sent: number; retried: number; dead: number; held: number }> {
    const now = this.clock.now();
    await this.store.requeueStaleNotifications(new Date(now.getTime() - 10 * 60_000).toISOString(), now.toISOString());
    const due = await this.store.claimDueNotifications(now.toISOString(), limit);
    const result = { sent: 0, retried: 0, dead: 0, held: 0 };
    for (const notification of due) {
      try {
        const receipt = await withRetry(() => this.sender.send(notification), {
          // Persist each retry boundary instead of firing duplicate provider
          // POSTs inside one claim. This keeps failures visible and limits the
          // duplicate window for providers without request idempotency keys.
          attempts: 1,
          baseDelayMs: 100,
          maxDelayMs: 300,
          timeoutMs: 4_500,
        });
        notification.state = "sent";
        notification.sentAt = this.clock.now().toISOString();
        notification.providerReceipt = receipt.providerReceipt;
        notification.lastError = null;
        result.sent += 1;
      } catch (error) {
        notification.lastError = redactError(error);
        if (error instanceof NotificationHeldError) {
          // On purpose, not a failure: no retry, no failure alert. Its STOP-line claim (if any) is handed back.
          await this.store.releaseSmsStopNotice(notification.id).catch(() => undefined);
          notification.state = "held";
          result.held += 1;
          await this.store.saveNotification(notification);
          continue;
        }
        const maxAttempts = notification.priority === "high" ? 12 : 5;
        // Never sent, never retried: if it held the number's STOP line, the next owner text must carry it instead.
        // If that hand-back fails, stay in retry (one more attempt, then this again) rather than strand the notice.
        const released = notification.attempts >= maxAttempts && notification.channel === "sms"
          ? await this.store.releaseSmsStopNotice(notification.id).then(() => true, () => false)
          : true;
        if (notification.attempts >= maxAttempts && released) {
          notification.state = "dead";
          result.dead += 1;
          if (notification.idempotencyKey.startsWith("customer-confirmation:") || notification.idempotencyKey.startsWith("missed-call-text:")) {
            await this.enqueueOwnerFailureAlert(notification);
          }
        } else {
          notification.state = "retry";
          const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, notification.attempts - 1));
          notification.nextAttemptAt = new Date(this.clock.now().getTime() + delaySeconds * 1_000).toISOString();
          result.retried += 1;
        }
      }
      await this.store.saveNotification(notification);
    }
    return result;
  }

  private async enqueueOwnerFailureAlert(notification: OutboxNotification): Promise<void> {
    if (!notification.callId) return;
    const config = await this.store.getConfig(notification.tenantId);
    const call = await this.store.getCall(notification.callId);
    if (!call) return;
    const now = this.clock.now().toISOString();
    for (const destinationRef of config.ownerNotificationRefs) {
      await this.store.enqueueNotification({
        id: randomUUID(), tenantId: notification.tenantId, callId: notification.callId, channel: "sms", destinationRef,
        body: `Front Office: CUSTOMER SMS FAILED\n${call.fields.callerName ?? "Unknown caller"} - ${call.fields.callbackNumber ?? call.fromNumber}\nManual follow-up required.`,
        priority: "high", state: "pending", attempts: 0, nextAttemptAt: now,
        idempotencyKey: `customer-sms-failure:${notification.id}:${destinationRef}`,
        providerReceipt: null, lastError: null, createdAt: now, sentAt: null,
      });
    }
  }
}
