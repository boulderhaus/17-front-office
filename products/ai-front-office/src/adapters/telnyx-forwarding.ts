import { withTimeout } from "../application/retry.js";

const CHECK_STATE_PREFIX = "forwarding-check:";

/**
 * What our check call says when something picks it up. If forwarding works, Call Otto's own line
 * answers and we hang up at once, so only a phone, a call screener or a voicemail ever hears this.
 */
export const FORWARDING_CHECK_SPEECH = "Hi, this is Call Otto, testing your call forwarding. Your phone picked up this test call, so it did not reach Call Otto. Please hang up, and follow the steps on your screen.";

/**
 * Telnyx Premium AMD with iOS call screening detection: it hears Apple's screener (Ask Reason, Live Voicemail)
 * answer our test call and says so, so the owner learns in seconds that their phone answers calls itself.
 */
export const CHECK_CALL_AMD = "premium_ios_call_screening_detection";
/** The phone's own screener answered (iOS Call Screening or Live Voicemail). Not terminal: AMD keeps listening. */
export const SCREENING_DETECTED_EVENT = "call.machine.premium.call_screening.detected";
/** Premium AMD's verdict: human_residence, human_business, machine, silence, fax_detected or not_sure. */
export const AMD_ENDED_EVENT = "call.machine.premium.detection.ended";

/**
 * The shop whose forwarding check this Call Control leg is, and which test it belongs to (its start
 * time, so a webhook that beats our own save can wait for it), or null for any other call.
 */
export function forwardingCheckState(clientState: unknown): { tenantId: string; startedAt: string | null } | null {
  if (typeof clientState !== "string" || !clientState) return null;
  const decoded = Buffer.from(clientState, "base64").toString("utf8");
  if (!decoded.startsWith(CHECK_STATE_PREFIX)) return null;
  const match = /^([\w-]{1,80})(?:\|(\d{4}-\d\d-\d\dT[\d:.]+Z))?$/.exec(decoded.slice(CHECK_STATE_PREFIX.length));
  return match ? { tenantId: match[1]!, startedAt: match[2] ?? null } : null;
}

/** Carrier lookup and the "Test my forwarding" call, so owners never have to know their carrier or test by hand. */
export class TelnyxForwardingClient {
  constructor(private readonly options: { apiKey: string; fetcher?: typeof fetch }) {}

  /** Who carries this number and what kind of line it is (~$0.0015–$0.01 per lookup). */
  async lookupCarrier(phoneNumber: string): Promise<{ name: string | null; lineType: string | null }> {
    const result = await this.request<{ data?: { carrier?: { name?: unknown; normalized_carrier?: unknown; type?: unknown }; portability?: { line_type?: unknown; spid_carrier_name?: unknown } } }>(
      `/number_lookup/${encodeURIComponent(phoneNumber)}?type=carrier`,
    );
    const carrier = result.data?.carrier;
    const portability = result.data?.portability;
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
    // The ported-to carrier is what actually serves the line today.
    const name = text(portability?.spid_carrier_name) ?? text(carrier?.normalized_carrier) ?? text(carrier?.name);
    const lineType = text(carrier?.type) ?? text(portability?.line_type);
    return { name, lineType };
  }

  /**
   * Ring the owner's business number from our line. If forwarding works, the call lands on the
   * shop's Call Otto number and the assistant webhook marks the check passed. If anything else picks it
   * up, it says what it is and hangs up; otherwise it ends by itself after `time_limit_secs`.
   */
  async placeCheckCall(input: { connectionId: string; from: string; to: string; webhookUrl: string; tenantId: string; startedAt: string }): Promise<string | null> {
    const result = await this.request<{ data?: { call_control_id?: unknown } }>("/calls", {
      method: "POST",
      body: JSON.stringify({
        connection_id: input.connectionId,
        to: input.to,
        from: input.from,
        // Verizon forwards an unanswered call after about 30 s (and Telnyx's own default is 30 s): ring long enough.
        timeout_secs: 60,
        time_limit_secs: 90,
        answering_machine_detection: CHECK_CALL_AMD,
        webhook_url: input.webhookUrl,
        client_state: Buffer.from(`${CHECK_STATE_PREFIX}${input.tenantId}|${input.startedAt}`).toString("base64"),
      }),
    });
    return typeof result.data?.call_control_id === "string" ? result.data.call_control_id : null;
  }

  /** Say something on our check call, so whoever picked it up hears what it is instead of dead air. */
  async speak(callControlId: string, text: string, commandId: string, clientState: string | null = null): Promise<boolean> {
    let ok = true;
    await this.request(`/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
      method: "POST",
      // Keep the check's client_state on the speak, so its later webhooks still route to the check.
      body: JSON.stringify({ payload: text, voice: "AWS.Polly.Joanna", language: "en-US", command_id: commandId, ...(clientState ? { client_state: clientState } : {}) }),
    }, [404, 422], () => { ok = false; });
    return ok;
  }

  async hangUp(callControlId: string): Promise<void> {
    await this.request(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`, { method: "POST", body: "{}" }, [404, 422]);
  }

  private async request<T = Record<string, unknown>>(path: string, init?: RequestInit, tolerated: number[] = [], onTolerated?: () => void): Promise<T> {
    const response = await withTimeout((this.options.fetcher ?? fetch)(`https://api.telnyx.com/v2${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", ...init?.headers },
    }), 8_000);
    const payload = await response.json().catch(() => ({})) as T;
    if (!response.ok && !tolerated.includes(response.status)) throw new Error(`Telnyx request failed with HTTP ${response.status}`);
    if (!response.ok) onTolerated?.();
    return payload;
  }
}
