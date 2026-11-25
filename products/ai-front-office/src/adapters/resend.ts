import type { OutboxNotification } from "../domain/models.js";
import type { NotificationPort } from "../ports.js";
import { withTimeout } from "../application/retry.js";

export interface ResendEmailOptions {
  apiKey: string;
  from: string;
  /** Brock's own follow-ups (senderRef "founder"): their From header and Reply-To. */
  founder?: { from: string; replyTo: string | null } | null;
  fetcher?: typeof fetch;
}

export interface EmailAttachment { filename: string; content: string }

export class ResendEmailAdapter implements NotificationPort {
  constructor(private readonly options: ResendEmailOptions) {}

  async send(notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    if (notification.channel !== "email") throw new Error("Resend only sends email notifications");
    const to = notification.destinationRef.startsWith("email:") ? notification.destinationRef.slice(6) : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("No valid email destination is configured");
    const { subject, text, attachments } = parseEmailBody(notification.body);
    const founder = notification.senderRef === "founder" ? this.options.founder ?? null : null;
    const response = await withTimeout((this.options.fetcher ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": notification.idempotencyKey,
      },
      body: JSON.stringify({
        from: founder?.from ?? this.options.from, to: [to], subject, text,
        ...(founder?.replyTo ? { reply_to: founder.replyTo } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
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

/** An outbox email body: the subject line, optional attachment lines (base64), a blank line, then the text. */
export function formatEmailBody(subject: string, text: string, attachments: EmailAttachment[] = []): string {
  const files = attachments
    .filter((file) => /^[\w.-]{1,80}$/.test(file.filename))
    .map((file) => `Attachment: ${file.filename}; ${Buffer.from(file.content, "utf8").toString("base64")}\n`).join("");
  return `Subject: ${subject.trim().slice(0, 160)}\n${files}\n${text.trim()}`;
}

export function parseEmailBody(value: string): { subject: string; text: string; attachments: EmailAttachment[] } {
  const [first = "", ...rest] = value.split("\n");
  if (!first.startsWith("Subject: ")) return { subject: "Call Otto update", text: value, attachments: [] };
  const attachments: EmailAttachment[] = [];
  while (rest.length > 0) {
    const file = /^Attachment: ([\w.-]{1,80}); ([A-Za-z0-9+/]+={0,2})$/.exec(rest[0]!);
    if (!file) break;
    attachments.push({ filename: file[1]!, content: file[2]! });
    rest.shift();
  }
  return { subject: first.slice(9).trim() || "Call Otto update", text: rest.join("\n").trimStart(), attachments };
}
