import { withTimeout } from "../application/retry.js";

/**
 * Self-serve line provisioning, the Rosie/Goodcall model: every shop gets its own local
 * number and assistant, created by API. The owner keeps their business number and forwards
 * missed (or all) calls to it with a carrier code.
 *
 * Every step is idempotent: the caller persists each id as soon as it exists and passes it
 * back in, so a retry after a crash never buys a second number or assistant.
 */
/** The order definitively failed (number taken); a retry should search for another number. */
export class NumberUnavailableError extends Error {
  constructor(phoneNumber: string) {
    super(`Telnyx could not order ${phoneNumber.slice(0, 5)}…`);
  }
}

export interface TelnyxProvisionerOptions {
  apiKey: string;
  templateAssistantId: string;
  messagingProfileId: string;
  campaignId?: string | undefined;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class TelnyxProvisioner {
  constructor(private readonly options: TelnyxProvisionerOptions) {}

  /** Create the shop's assistant from the template's voice and model plus this shop's prompt and tools. */
  async createAssistant(input: { tenantId: string; businessName: string; assistantUpdate: Record<string, unknown> }): Promise<string> {
    const template = objectData(await this.request(`/ai/assistants/${encodeURIComponent(this.options.templateAssistantId)}`));
    const inherited = Object.fromEntries(
      ["model", "voice_settings", "llm_api_key_ref", "enabled_features", "insight_settings", "privacy_settings"]
        .filter((key) => template[key] !== undefined && template[key] !== null)
        .map((key) => [key, template[key]]),
    );
    const { promote_to_main: _promote, ...update } = input.assistantUpdate;
    const created = objectData(await this.request("/ai/assistants", {
      method: "POST",
      headers: { "idempotency-key": `front-office-assistant-${input.tenantId}` },
      body: JSON.stringify({
        ...inherited,
        ...update,
        name: `Front Office · ${input.businessName}`.slice(0, 120),
      }),
    }));
    const id = typeof created.id === "string" ? created.id : null;
    if (!id) throw new Error("Telnyx did not return an assistant id");
    return id;
  }

  /** Find a voice+SMS local number, preferring the owner's own area code, then the shop's state. */
  async findNumber(input: { areaCodes: string[]; state?: string | null }): Promise<string> {
    const attempts: Array<Record<string, string>> = [
      ...unique(input.areaCodes).map((code) => ({ "filter[national_destination_code]": code })),
      ...(input.state ? [{ "filter[administrative_area]": input.state }] : []),
      {},
    ];
    for (const filters of attempts) {
      const url = new URL("https://api.telnyx.com/v2/available_phone_numbers");
      url.searchParams.set("filter[country_code]", "US");
      url.searchParams.set("filter[phone_number_type]", "local");
      url.searchParams.append("filter[features][]", "voice");
      url.searchParams.append("filter[features][]", "sms");
      url.searchParams.set("filter[limit]", "5");
      url.searchParams.set("filter[exclude_held_numbers]", "true");
      for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
      const result = await this.request<{ data?: Array<{ phone_number?: unknown }> }>(url.toString(), undefined, true);
      const number = result.data?.map((item) => item.phone_number).find((value): value is string => typeof value === "string" && isUsLocal(value));
      if (number) return number;
    }
    throw new Error("No local Telnyx number is available right now");
  }

  /**
   * Buy the number with no voice connection (the line stays paused until activation) and with
   * our messaging profile, then wait until Telnyx reports the order complete.
   */
  async orderNumber(input: { tenantId: string; phoneNumber: string }): Promise<void> {
    const order = objectData(await this.request<Record<string, unknown>>("/number_orders", {
      method: "POST",
      headers: { "idempotency-key": `front-office-number-${input.tenantId}-${input.phoneNumber.replace(/\D/g, "")}` },
      body: JSON.stringify({
        phone_numbers: [{ phone_number: input.phoneNumber }],
        messaging_profile_id: this.options.messagingProfileId,
        customer_reference: `front-office:${input.tenantId}`,
      }),
    }).catch((error: Error & { status?: number }) => {
      // Taken or not orderable: the caller drops this candidate and searches again.
      if (error.status && error.status >= 400 && error.status < 500 && ![401, 403, 429].includes(error.status)) throw new NumberUnavailableError(input.phoneNumber);
      throw error;
    }));
    const orderId = typeof order.id === "string" ? order.id : null;
    if (!orderId) throw new Error("Telnyx did not return a number order id");
    let status = typeof order.status === "string" ? order.status : "pending";
    for (let attempt = 0; status === "pending" && attempt < 10; attempt += 1) {
      await (this.options.sleep ?? delay)(1_500);
      const current = objectData(await this.request(`/number_orders/${encodeURIComponent(orderId)}`));
      status = typeof current.status === "string" ? current.status : status;
    }
    if (status === "failure") throw new NumberUnavailableError(input.phoneNumber);
    if (status !== "success") throw new Error(`Telnyx number order is ${status}`);
  }

  /** Put the number on our approved 10DLC campaign. A pending campaign is not a provisioning failure. */
  async attachCampaign(phoneNumber: string): Promise<boolean> {
    if (!this.options.campaignId) return false;
    await this.request("/10dlc/phone_number_campaigns", {
      method: "POST",
      body: JSON.stringify({ phoneNumber, campaignId: this.options.campaignId }),
    });
    return true;
  }

  /** Give back a shop's number and assistant when the shop is deleted, so nothing keeps billing. */
  async release(input: { phoneNumber: string | null; assistantId: string | null }): Promise<void> {
    if (input.phoneNumber && this.options.campaignId) {
      await this.request(`/10dlc/phone_number_campaigns/${encodeURIComponent(input.phoneNumber)}`, { method: "DELETE" }, false, [404]);
    }
    if (input.phoneNumber) {
      const url = new URL("https://api.telnyx.com/v2/phone_numbers");
      url.searchParams.set("filter[phone_number]", input.phoneNumber);
      const found = await this.request<{ data?: Array<{ id?: unknown; phone_number?: unknown }> }>(url.toString(), undefined, true);
      const id = found.data?.find((item) => item.phone_number === input.phoneNumber)?.id;
      if (typeof id === "string") await this.request(`/phone_numbers/${encodeURIComponent(id)}`, { method: "DELETE" });
    }
    if (input.assistantId && input.assistantId !== this.options.templateAssistantId) {
      await this.request(`/ai/assistants/${encodeURIComponent(input.assistantId)}`, { method: "DELETE" });
    }
  }

  private async request<T = Record<string, unknown>>(path: string, init?: RequestInit, absolute = false, tolerated: number[] = []): Promise<T> {
    const target = absolute ? path : `https://api.telnyx.com/v2${path}`;
    const response = await withTimeout((this.options.fetcher ?? fetch)(target, {
      ...init,
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", ...init?.headers },
    }), 10_000);
    const payload = await response.json().catch(() => ({})) as T & { errors?: Array<{ detail?: string }> };
    if (!response.ok && !tolerated.includes(response.status)) {
      const error = new Error(`Telnyx provisioning request failed with HTTP ${response.status}${payload.errors?.[0]?.detail ? `: ${payload.errors[0].detail}` : ""}`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    return payload;
  }
}

/** Carrier codes owners dial on their business phone to forward calls to their Front Office number. */
export function forwardingInstructions(frontOfficeNumber: string, mode: "overflow" | "after_hours" | "always"): Array<{ carrier: string; on: string; off: string }> {
  const digits = frontOfficeNumber.replace(/^\+1/, "");
  const missedOnly = mode !== "always";
  return [
    { carrier: "Verizon", on: missedOnly ? `*71${digits}` : `*72${digits}`, off: "*73" },
    { carrier: "AT&T, T-Mobile and most other cell phones", on: missedOnly ? `**61*1${digits}#` : `**21*1${digits}#`, off: missedOnly ? "##61#" : "##21#" },
    missedOnly
      ? { carrier: "Office or cable lines (Comcast, Spectrum, RingCentral…)", on: "Set “forward when unanswered” in your provider’s portal", off: "Turn it off in the same place" }
      : { carrier: "Office or cable lines (Comcast, Spectrum, Cox)", on: `*72${digits}`, off: "*73" },
  ];
}

function isUsLocal(value: string): boolean {
  const match = /^\+1([2-9]\d{2})[2-9]\d{6}$/.exec(value);
  return Boolean(match && !["800", "833", "844", "855", "866", "877", "888", "900"].includes(match[1]!));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => /^[2-9]\d{2}$/.test(value)))];
}

function objectData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  return object.data && typeof object.data === "object" && !Array.isArray(object.data)
    ? object.data as Record<string, unknown>
    : object;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
