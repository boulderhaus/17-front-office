import type { OutboxNotification } from "../domain/models.js";
import type { NotificationPort } from "../ports.js";

export class NotificationRouter implements NotificationPort {
  constructor(
    private readonly sms: NotificationPort | null,
    private readonly email: NotificationPort | null,
    private readonly push: NotificationPort | null = null,
  ) {}

  async send(notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    const sender = notification.channel === "sms" ? this.sms : notification.channel === "email" ? this.email : notification.channel === "push" ? this.push : null;
    if (!sender) throw new Error(`${notification.channel.toUpperCase()} integration is not configured`);
    return sender.send(notification);
  }
}
