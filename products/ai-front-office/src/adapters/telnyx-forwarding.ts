import { withTimeout } from "../application/retry.js";

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
   * shop's Front Office number and the assistant webhook marks the check passed. The call ends by
   * itself after `time_limit_secs`.
   */
  async placeCheckCall(input: { connectionId: string; from: string; to: string; webhookUrl: string; tenantId: string }): Promise<string | null> {
    const result = await this.request<{ data?: { call_control_id?: unknown } }>("/calls", {
      method: "POST",
      body: JSON.stringify({
        connection_id: input.connectionId,
        to: input.to,
        from: input.from,
        timeout_secs: 45,
        time_limit_secs: 75,
        webhook_url: input.webhookUrl,
        client_state: Buffer.from(`forwarding-check:${input.tenantId}`).toString("base64"),
      }),
    });
    return typeof result.data?.call_control_id === "string" ? result.data.call_control_id : null;
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
