import { withTimeout } from "../application/retry.js";
import type { OutboxNotification } from "../domain/models.js";
import { NotificationHeldError, type Clock, type NotificationPort } from "../ports.js";
import type { Environment } from "../config/environment.js";

/**
 * Urgent calls ring the owner: an automated call to their mobile that reads a short summary, twice, then hangs up.
 * Voice needs no carrier texting approval. The call is placed on the Call Control connection (the same one as the
 * forwarding check); when it is answered, our webhook tells Telnyx to speak the words carried in client_state.
 */
const STATE_PREFIX = "owner-alert:";

/** Urgent calls ring the owner from our number over the Call Control connection (webhooks verified with TELNYX_PUBLIC_KEY). */
export function urgentOwnerCallsConfigured(env: Pick<Environment, "DEMO_MODE" | "TELNYX_API_KEY" | "TELNYX_PUBLIC_KEY" | "TELNYX_CHECK_CONNECTION_ID" | "TELNYX_FROM_NUMBER">): boolean {
  return Boolean(!env.DEMO_MODE && env.TELNYX_API_KEY && env.TELNYX_PUBLIC_KEY && env.TELNYX_CHECK_CONNECTION_ID && env.TELNYX_FROM_NUMBER);
}
const SPEECH_LIMIT = 300;
/** At most this many urgent calls to one shop's owner per hour, so a burst of emergencies never becomes a phone storm. */
const CALLS_PER_HOUR = 3;

export interface OwnerCallOptions {
  apiKey: string;
  connectionId: string;
  from: string;
  webhookUrl: string;
  clock: Clock;
  resolveDestination: (tenantId: string, reference: string) => Promise<string | null>;
  /** Provider test mode: only these numbers may be called. */
  allowedDestinations?: ReadonlySet<string>;
  fetcher?: typeof fetch;
}

export class TelnyxOwnerCallSender implements NotificationPort {
  readonly #recent = new Map<string, number[]>();

  constructor(private readonly options: OwnerCallOptions) {}

  async send(notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    if (notification.channel !== "voice") throw new Error("Owner calls only send voice notifications");
    const to = await this.options.resolveDestination(notification.tenantId, notification.destinationRef);
    if (!to || !/^\+1[2-9]\d{9}$/.test(to)) throw new NotificationHeldError("No owner mobile number to call");
    if (this.options.allowedDestinations && !this.options.allowedDestinations.has(to)) throw new NotificationHeldError("Provider test mode: owner number is not allowlisted");
    const now = this.options.clock.now().getTime();
    const recent = (this.#recent.get(notification.tenantId) ?? []).filter((at) => now - at < 60 * 60_000);
    if (recent.length >= CALLS_PER_HOUR) throw new NotificationHeldError("Urgent owner call limit reached for this hour");
    const response = await withTimeout((this.options.fetcher ?? fetch)("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        connection_id: this.options.connectionId,
        to,
        from: this.options.from,
        timeout_secs: 30,
        time_limit_secs: 90,
        webhook_url: this.options.webhookUrl,
        client_state: ownerAlertClientState(notification.body),
      }),
    }), 8_000);
    const payload = await response.json().catch(() => ({})) as { data?: { call_control_id?: unknown } };
    const callControlId = typeof payload.data?.call_control_id === "string" ? payload.data.call_control_id : null;
    if (!response.ok || !callControlId) throw new Error(`Owner call failed with HTTP ${response.status}`);
    this.#recent.set(notification.tenantId, [...recent, now]);
    return { providerReceipt: `owner-call:${callControlId}` };
  }
}

export function ownerAlertClientState(speech: string): string {
  return Buffer.from(`${STATE_PREFIX}${speech.slice(0, SPEECH_LIMIT)}`).toString("base64");
}

/** The words to read when a webhook's client_state is one of our owner alert calls; null for any other call. */
export function ownerAlertSpeech(clientState: unknown): string | null {
  if (typeof clientState !== "string" || !clientState) return null;
  const decoded = Buffer.from(clientState, "base64").toString("utf8");
  return decoded.startsWith(STATE_PREFIX) ? decoded.slice(STATE_PREFIX.length) : null;
}

/** Answered: read the summary twice (the owner may miss the start). Spoken: hang up. */
export async function continueOwnerAlertCall(input: { apiKey: string; eventType: string; eventId: string; callControlId: string; speech: string; fetcher?: typeof fetch }): Promise<void> {
  const action = input.eventType === "call.answered" ? "speak" : input.eventType === "call.speak.ended" ? "hangup" : null;
  if (!action) return;
  const body = action === "speak"
    ? { payload: `${input.speech} I'll say that again. ${input.speech}`, voice: "AWS.Polly.Joanna", language: "en-US", command_id: input.eventId }
    : { command_id: input.eventId };
  const response = await withTimeout((input.fetcher ?? fetch)(`https://api.telnyx.com/v2/calls/${encodeURIComponent(input.callControlId)}/actions/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), 8_000);
  // The caller may already have hung up: that is fine.
  if (!response.ok && response.status !== 404 && response.status !== 422) throw new Error(`Owner call ${action} failed with HTTP ${response.status}`);
}
