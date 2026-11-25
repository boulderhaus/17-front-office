import { withTimeout } from "../application/retry.js";

const CHECK_STATE_PREFIX = "forwarding-check:";

/**
 * What our check call says when something picks it up. If forwarding works, Call Otto's own line
 * answers and we hang up at once, so only a phone, a call screener or a voicemail ever hears this.
 */
export const FORWARDING_CHECK_SPEECH = "Hi, this is Call Otto, testing your call forwarding. Your phone picked up this test call, so it did not reach Call Otto. Please hang up, and follow the steps on your screen.";

/** The shop whose forwarding check this Call Control leg is, or null for any other call. */
export function forwardingCheckTenant(clientState: unknown): string | null {
  if (typeof clientState !== "string" || !clientState) return null;
  const decoded = Buffer.from(clientState, "base64").toString("utf8");
  if (!decoded.startsWith(CHECK_STATE_PREFIX)) return null;
  const tenantId = decoded.slice(CHECK_STATE_PREFIX.length);
  return /^[\w-]{1,80}$/.test(tenantId) ? tenantId : null;
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
  async placeCheckCall(input: { connectionId: string; from: string; to: string; webhookUrl: string; tenantId: string }): Promise<string | null> {
    const result = await this.request<{ data?: { call_control_id?: unknown } }>("/calls", {
      method: "POST",
      body: JSON.stringify({
        connection_id: input.connectionId,
        to: input.to,
        from: input.from,
        // Carriers forward an unanswered call after 20–30 s; ring long enough for that to happen.
        timeout_secs: 60,
        time_limit_secs: 90,
        webhook_url: input.webhookUrl,
        client_state: Buffer.from(`${CHECK_STATE_PREFIX}${input.tenantId}`).toString("base64"),
      }),
    });
    return typeof result.data?.call_control_id === "string" ? result.data.call_control_id : null;
  }

  /** Say something on our check call, so whoever picked it up hears what it is instead of dead air. */
  async speak(callControlId: string, text: string, commandId: string): Promise<void> {
    await this.request(`/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
      method: "POST",
      body: JSON.stringify({ payload: text, voice: "AWS.Polly.Joanna", language: "en-US", command_id: commandId }),
    }, [404, 422]);
  }

  async hangUp(callControlId: string): Promise<void> {
    await this.request(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`, { method: "POST", body: "{}" }, [404, 422]);
  }

  private async request<T = Record<string, unknown>>(path: string, init?: RequestInit, tolerated: number[] = []): Promise<T> {
    const response = await withTimeout((this.options.fetcher ?? fetch)(`https://api.telnyx.com/v2${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", ...init?.headers },
    }), 8_000);
    const payload = await response.json().catch(() => ({})) as T;
    if (!response.ok && !tolerated.includes(response.status)) throw new Error(`Telnyx request failed with HTTP ${response.status}`);
    return payload;
  }
}
