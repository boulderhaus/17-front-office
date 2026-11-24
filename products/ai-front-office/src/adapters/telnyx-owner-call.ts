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
  /**
   * Durable once-only claim (Store.claimWebhook): each urgent notification dials at most once, across retries,
   * replicas and restarts. A lost or failed dial is never retried, so the owner is never rung twice.
   */
  claimDial: (key: string) => Promise<boolean>;
  /** TCPA: the owner agreed to automated calls (signup or Settings) and has not stopped them. */
  hasConsent: (tenantId: string, phone: string) => Promise<boolean>;
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
    // Consent can be withdrawn (Settings or pressing 9) between queueing and sending.
    if (!await this.options.hasConsent(notification.tenantId, to)) throw new NotificationHeldError("Owner has not agreed to automated urgent calls");
    const now = this.options.clock.now().getTime();
    const recent = (this.#recent.get(notification.tenantId) ?? []).filter((at) => now - at < 60 * 60_000);
    if (recent.length >= CALLS_PER_HOUR) throw new NotificationHeldError("Urgent owner call limit reached for this hour");
    if (!await this.options.claimDial(`owner-call-dial:${notification.idempotencyKey}`)) throw new NotificationHeldError("Urgent owner call already dialed once");
    this.#recent.set(notification.tenantId, [...recent, now]);
    // One attempt only: a timeout may still have created the call, so nothing here is retried.
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
        client_state: ownerAlertClientState({ tenantId: notification.tenantId, speech: notification.body, phase: "dial" }),
      }),
    }), 8_000).catch((error: unknown) => {
      throw new NotificationHeldError(`Urgent owner call not confirmed, not retried: ${error instanceof Error ? error.message.slice(0, 120) : "request failed"}`);
    });
    const payload = await response.json().catch(() => ({})) as { data?: { call_control_id?: unknown } };
    const callControlId = typeof payload.data?.call_control_id === "string" ? payload.data.call_control_id : null;
    if (!response.ok || !callControlId) throw new NotificationHeldError(`Urgent owner call failed with HTTP ${response.status}, not retried`);
    return { providerReceipt: `owner-call:${callControlId}` };
  }
}

/** What our own owner alert call carries in client_state: which shop, the words, and where the call is. */
export interface OwnerAlertState {
  tenantId: string;
  speech: string;
  /** dial: ringing or just answered. gather: reading the summary, listening for 9. bye: saying the stop confirmation. */
  phase: "dial" | "gather" | "bye";
}

export function ownerAlertClientState(state: OwnerAlertState): string {
  return Buffer.from(`${STATE_PREFIX}${JSON.stringify({ t: state.tenantId, s: state.speech.slice(0, SPEECH_LIMIT), p: state.phase })}`).toString("base64");
}

/** Our owner alert call's state from a (signed) webhook's client_state; null for any other call. */
export function ownerAlertState(clientState: unknown): OwnerAlertState | null {
  if (typeof clientState !== "string" || !clientState) return null;
  const decoded = Buffer.from(clientState, "base64").toString("utf8");
  if (!decoded.startsWith(STATE_PREFIX)) return null;
  try {
    const value = JSON.parse(decoded.slice(STATE_PREFIX.length)) as { t?: unknown; s?: unknown; p?: unknown };
    if (typeof value.t !== "string" || typeof value.s !== "string" || (value.p !== "dial" && value.p !== "gather" && value.p !== "bye")) return null;
    return { tenantId: value.t, speech: value.s, phase: value.p };
  } catch {
    return null;
  }
}

export const OWNER_CALL_STOP_PROMPT = "To stop these calls, press 9.";
export const OWNER_CALL_STOPPED = "Done. Front Office won't call you about emergencies anymore. You can turn these calls back on in Settings. Goodbye.";
const VOICE = { voice: "AWS.Polly.Joanna", language: "en-US" };

/**
 * Answered: read the summary twice, then "To stop these calls, press 9", listening for 9 (TCPA opt-out).
 * Pressed 9: stop calling this shop's owner (onOptOut), confirm, hang up. Otherwise: hang up.
 */
export async function continueOwnerAlertCall(input: { apiKey: string; eventType: string; eventId: string; callControlId: string; state: OwnerAlertState; digits: string | null; onOptOut: () => Promise<void>; fetcher?: typeof fetch }): Promise<void> {
  const { state } = input;
  let action: string | null = null;
  let body: Record<string, unknown> = { command_id: input.eventId };
  if (input.eventType === "call.answered" && state.phase === "dial") {
    action = "gather_using_speak";
    body = { ...body, ...VOICE, payload: `${state.speech} I'll say that again. ${state.speech} ${OWNER_CALL_STOP_PROMPT}`, valid_digits: "9", minimum_digits: 1, maximum_digits: 1, timeout_millis: 8_000, client_state: ownerAlertClientState({ ...state, phase: "gather" }) };
  } else if (input.eventType === "call.gather.ended" && state.phase === "gather") {
    if (input.digits?.includes("9")) {
      await input.onOptOut();
      action = "speak";
      body = { ...body, ...VOICE, payload: OWNER_CALL_STOPPED, client_state: ownerAlertClientState({ ...state, phase: "bye" }) };
    } else {
      action = "hangup";
    }
  } else if (input.eventType === "call.speak.ended" && state.phase === "bye") {
    action = "hangup";
  }
  if (!action) return;
  const response = await withTimeout((input.fetcher ?? fetch)(`https://api.telnyx.com/v2/calls/${encodeURIComponent(input.callControlId)}/actions/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), 8_000);
  // The call already ended (404/422) is fine for a hangup or the stop confirmation; a refused summary is not.
  if (!response.ok && !(action !== "gather_using_speak" && (response.status === 404 || response.status === 422))) throw new Error(`Owner call ${action} failed with HTTP ${response.status}`);
}
