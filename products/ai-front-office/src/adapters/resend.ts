import type { OutboxNotification } from "../domain/models.js";
import type { NotificationPort } from "../ports.js";
import { withTimeout } from "../application/retry.js";

export interface ResendEmailOptions {
  apiKey: string;
  from: string;
  fetcher?: typeof fetch;
}

export class ResendEmailAdapter implements NotificationPort {
  constructor(private readonly options: ResendEmailOptions) {}

  async send(notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    if (notification.channel !== "email") throw new Error("Resend only sends email notifications");
    const to = notification.destinationRef.startsWith("email:") ? notification.destinationRef.slice(6) : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("No valid email destination is configured");
    const { subject, text } = parseEmailBody(notification.body);
    const response = await withTimeout((this.options.fetcher ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": notification.idempotencyKey,
      },
      body: JSON.stringify({ from: this.options.from, to: [to], subject, text }),
    }), 4_000);
    const payload = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok || !payload.id) throw new Error(`Resend email failed with HTTP ${response.status}${payload.message ? `: ${payload.message}` : ""}`);
    return { providerReceipt: payload.id };
  }
}

/** The From header Resend sends: "Call Otto <hello@callotto.co>". */
export function resendFrom(name: string, email: string): string {
  return `${name} <${email}>`;
}

export function formatEmailBody(subject: string, text: string): string {
  return `Subject: ${subject.trim().slice(0, 160)}\n\n${text.trim()}`;
}

function parseEmailBody(value: string): { subject: string; text: string } {
  const [first = "", ...rest] = value.split("\n");
  if (!first.startsWith("Subject: ")) return { subject: "Call Otto update", text: value };
  return { subject: first.slice(9).trim() || "Call Otto update", text: rest.join("\n").trimStart() };
}
