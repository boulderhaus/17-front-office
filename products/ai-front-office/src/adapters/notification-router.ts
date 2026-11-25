import type { OutboxNotification } from "../domain/models.js";
import { NotificationHeldError, type NotificationPort } from "../ports.js";

export class NotificationRouter implements NotificationPort {
  constructor(
    private readonly sms: NotificationPort | null,
    private readonly email: NotificationPort | null,
    private readonly push: NotificationPort | null = null,
    private readonly voice: NotificationPort | null = null,
    /** The public demo line and the review account never send anything: true holds every notification for this tenant (checked per send). */
    private readonly isSilentTenant: (tenantId: string) => Promise<boolean> = async () => false,
  ) {}

  async send(notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    if (await this.isSilentTenant(notification.tenantId)) throw new NotificationHeldError("Public demo line or review account: nothing is sent from it");
    const sender = notification.channel === "sms" ? this.sms : notification.channel === "email" ? this.email : notification.channel === "push" ? this.push : notification.channel === "voice" ? this.voice : null;
    if (!sender) throw new Error(`${notification.channel.toUpperCase()} integration is not configured`);
    return sender.send(notification);
  }
}
