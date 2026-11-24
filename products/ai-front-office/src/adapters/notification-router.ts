import type { OutboxNotification } from "../domain/models.js";
import { NotificationHeldError, type NotificationPort } from "../ports.js";

export class NotificationRouter implements NotificationPort {
  constructor(
    private readonly sms: NotificationPort | null,
    private readonly email: NotificationPort | null,
    private readonly push: NotificationPort | null = null,
    private readonly voice: NotificationPort | null = null,
    /** Tenants that never send anything (the public demo line): every notification is held. */
    private readonly silentTenants: ReadonlySet<string> = new Set(),
  ) {}

  async send(notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    if (this.silentTenants.has(notification.tenantId)) throw new NotificationHeldError("Public demo line: nothing is sent from it");
    const sender = notification.channel === "sms" ? this.sms : notification.channel === "email" ? this.email : notification.channel === "push" ? this.push : notification.channel === "voice" ? this.voice : null;
    if (!sender) throw new Error(`${notification.channel.toUpperCase()} integration is not configured`);
    return sender.send(notification);
  }
}
