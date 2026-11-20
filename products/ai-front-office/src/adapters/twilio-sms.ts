import type { OutboxNotification } from "../domain/models.js";
import type { NotificationPort } from "../ports.js";
import { withTimeout } from "../application/retry.js";

interface TwilioSmsOptions {
  accountSid: string;
  authUser: string;
  authSecret: string;
  fromNumber?: string;
  messagingServiceSid?: string;
  resolveDestination: (reference: string) => Promise<string | null>;
}

export class TwilioSmsAdapter implements NotificationPort {
  constructor(private readonly options: TwilioSmsOptions) {
    if (!options.fromNumber && !options.messagingServiceSid) throw new Error("Twilio requires fromNumber or messagingServiceSid");
  }

  async send(notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    const direct = notification.destinationRef.startsWith("tel:") ? notification.destinationRef.slice(4) : null;
    const to = direct ?? await this.options.resolveDestination(notification.destinationRef);
    if (direct && !/^\+[1-9]\d{7,14}$/.test(direct)) throw new Error("Direct SMS destination must use E.164 format");
    if (!to) throw new Error(`No phone number is configured for destination reference ${notification.destinationRef}`);
    const body = new URLSearchParams({ To: to, Body: notification.body });
    if (this.options.messagingServiceSid) body.set("MessagingServiceSid", this.options.messagingServiceSid);
    else body.set("From", this.options.fromNumber!);
    const response = await withTimeout(fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.options.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.options.authUser}:${this.options.authSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      },
    ), 4_000);
    const payload = await response.json().catch(() => ({})) as { sid?: string; message?: string };
    if (!response.ok || !payload.sid) throw new Error(`Twilio SMS failed with HTTP ${response.status}${payload.message ? `: ${payload.message}` : ""}`);
    return { providerReceipt: payload.sid };
  }
}
