import { withTimeout } from "../application/retry.js";
import { resolveVoiceMode, speechToSpeechPayload, type SpeechToSpeechSettings } from "../voice/voice-mode.js";

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

/** Where every assistant's TeXML app posts its end-of-call callback (the same URL as the signed webhooks). */
export function callEndCallbackUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/webhooks/telnyx`;
}

export interface CallEndCallbackResult {
  assistantId: string;
  texmlAppId: string;
  action: "already_set" | "set" | "would_set";
  /** The callback URL is set and posted, so calls finalize (call cost in webhooks may still be off). */
  delivers: boolean;
}

/** The assistant has no TeXML app to configure, or Telnyx refused the change: never activate a line on it. */
export class CallEndCallbackError extends Error {}

/**
 * Every Telnyx assistant answers through its own default TeXML app, and that app only tells us a call ended
 * (CallStatus=conversation_ended, with the whole conversation) when its status_callback points here. Without
 * it a shop's calls are never finalized: no transcript, summary, usage count or callback task.
 *
 * Idempotent: reads the app and writes only when apply is true and a setting differs. Transient failures
 * (network, 408, 429, 5xx) are retried; anything else throws CallEndCallbackError.
 */
export async function ensureCallEndCallback(input: {
  apiKey: string;
  assistantId: string;
  publicBaseUrl: string;
  apply: boolean;
  fetcher?: typeof fetch | undefined;
  attempts?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}): Promise<CallEndCallbackResult> {
  const want = callEndCallbackUrl(input.publicBaseUrl);
  const attempts = Math.max(1, input.attempts ?? 3);
  const request = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    let last: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let retry = true;
      try {
        const response = await withTimeout((input.fetcher ?? fetch)(`https://api.telnyx.com/v2${path}`, {
          ...init,
          headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json", ...init?.headers },
        }), 8_000);
        const payload = await response.json().catch(() => ({})) as Record<string, unknown> & { errors?: Array<{ detail?: string }> };
        if (response.ok) return payload;
        retry = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new CallEndCallbackError(`Telnyx call-end callback request failed with HTTP ${response.status}${payload.errors?.[0]?.detail ? `: ${payload.errors[0].detail}` : ""}`);
      } catch (error) {
        last = error;
        if (!retry || attempt === attempts) break;
        await (input.sleep ?? delay)(250 * 3 ** (attempt - 1));
      }
    }
    throw last instanceof CallEndCallbackError ? last : new CallEndCallbackError(last instanceof Error ? last.message : "Telnyx call-end callback request failed");
  };
  const assistant = objectData(await request(`/ai/assistants/${encodeURIComponent(input.assistantId)}`));
  const telephony = objectData(assistant.telephony_settings);
  const texmlAppId = typeof telephony.default_texml_app_id === "string" && telephony.default_texml_app_id ? telephony.default_texml_app_id : null;
  if (!texmlAppId) throw new CallEndCallbackError("Telnyx assistant has no default TeXML application");
  const app = objectData(await request(`/texml_applications/${encodeURIComponent(texmlAppId)}`));
  const delivers = callEndCallbackDelivers(app, want);
  if (delivers && app.call_cost_in_webhooks === true) return { assistantId: input.assistantId, texmlAppId, action: "already_set", delivers };
  if (!input.apply) return { assistantId: input.assistantId, texmlAppId, action: "would_set", delivers };
  const updated = objectData(await request(`/texml_applications/${encodeURIComponent(texmlAppId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      // Telnyx documents friendly_name and voice_url as required on update: send back what the app already has.
      ...(typeof app.friendly_name === "string" && app.friendly_name ? { friendly_name: app.friendly_name } : {}),
      ...(typeof app.voice_url === "string" && app.voice_url ? { voice_url: app.voice_url } : {}),
      status_callback: want,
      status_callback_method: "post",
      call_cost_in_webhooks: true,
    }),
  }));
  // Trust only what Telnyx says it stored; an update that doesn't echo the app is read back.
  const stored = updated.status_callback === undefined ? objectData(await request(`/texml_applications/${encodeURIComponent(texmlAppId)}`)) : updated;
  if (!callEndCallbackDelivers(stored, want)) throw new CallEndCallbackError("Telnyx did not persist the call-end callback");
  return { assistantId: input.assistantId, texmlAppId, action: "set", delivers: true };
}

/** The part a call record depends on: the callback URL, posted. (Call cost in webhooks is wanted, not required.) */
function callEndCallbackDelivers(app: Record<string, unknown>, want: string): boolean {
  return app.status_callback === want && String(app.status_callback_method ?? "post").toLowerCase() === "post";
}

export class TelnyxProvisioner {
  constructor(private readonly options: TelnyxProvisionerOptions) {}

  /** Create the shop's assistant from the template's voice and model plus this shop's prompt and tools. */
  async createAssistant(input: { tenantId: string; businessName: string; assistantUpdate: Record<string, unknown>; speechToSpeech?: SpeechToSpeechSettings | undefined }): Promise<string> {
    const template = objectData(await this.request(`/ai/assistants/${encodeURIComponent(this.options.templateAssistantId)}`));
    const inherited = Object.fromEntries(
      ["model", "voice_settings", "llm_api_key_ref", "enabled_features", "insight_settings", "privacy_settings"]
        .filter((key) => template[key] !== undefined && template[key] !== null)
        .map((key) => [key, template[key]]),
    );
    // An opt-in speech-to-speech tenant (src/voice/voice-mode.ts) delegates tools to the template's text model.
    const mode = resolveVoiceMode(input.speechToSpeech, input.tenantId, template);
    const built = mode.kind === "speech_to_speech" ? speechToSpeechPayload(input.assistantUpdate, mode).payload : input.assistantUpdate;
    const { promote_to_main: _promote, ...update } = built;
    const created = objectData(await this.request("/ai/assistants", {
      method: "POST",
      headers: { "idempotency-key": `front-office-assistant-${input.tenantId}` },
      body: JSON.stringify({
        ...inherited,
        ...update,
        name: `Call Otto · ${input.businessName}`.slice(0, 120),
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

  /** Set carrier spam screening on the number. Idempotent; safe on every activation. */
  async enableCallScreening(phoneNumber: string, setting: CallScreeningSetting): Promise<CallScreeningResult> {
    return ensureInboundCallScreening({ apiKey: this.options.apiKey, phoneNumber, setting, apply: true, fetcher: this.options.fetcher });
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

/**
 * Telnyx Inbound Call Screening (PATCH /v2/phone_numbers/{id}/voice, field inbound_call_screening,
 * enum disabled | reject_calls | flag_calls). Telnyx scores calls by Nomorobo/YouMail/CallerAPI
 * reputation, number validity and SHAKEN/STIR. flag_calls labels likely spam ("SPAM LIKELY" caller
 * name, X-Telnyx-Call-Screening header, call_screening_result on call events) and still delivers it;
 * reject_calls drops it at the network with no record. Default is flag: forwarded calls and new
 * mobiles can false-positive, and a dropped emergency caller leaves no trace.
 */
export type CallScreeningMode = "flag" | "reject" | "off";
export type CallScreeningSetting = "flag_calls" | "reject_calls" | "disabled";

export function callScreeningSetting(mode: CallScreeningMode): CallScreeningSetting {
  return mode === "reject" ? "reject_calls" : mode === "off" ? "disabled" : "flag_calls";
}

export interface CallScreeningResult {
  phoneNumber: string;
  numberId: string | null;
  current: string | null;
  action: "already_set" | "set" | "would_set" | "not_found";
}

/** Idempotent: reads the number's voice settings and writes the setting only when apply is true and it differs. */
export async function ensureInboundCallScreening(input: { apiKey: string; phoneNumber: string; setting: CallScreeningSetting; apply: boolean; fetcher?: typeof fetch | undefined }): Promise<CallScreeningResult> {
  const request = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    const target = path.startsWith("https://") ? path : `https://api.telnyx.com/v2${path}`;
    const response = await withTimeout((input.fetcher ?? fetch)(target, {
      ...init,
      headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json", ...init?.headers },
    }), 10_000);
    const payload = await response.json().catch(() => ({})) as Record<string, unknown> & { errors?: Array<{ detail?: string }> };
    if (!response.ok) throw new Error(`Telnyx call screening request failed with HTTP ${response.status}${payload.errors?.[0]?.detail ? `: ${payload.errors[0].detail}` : ""}`);
    return payload;
  };
  const url = new URL("https://api.telnyx.com/v2/phone_numbers");
  url.searchParams.set("filter[phone_number]", input.phoneNumber);
  const found = await request(url.toString()) as { data?: Array<{ id?: unknown; phone_number?: unknown }> };
  const id = found.data?.find((item) => item.phone_number === input.phoneNumber)?.id;
  if (typeof id !== "string") return { phoneNumber: input.phoneNumber, numberId: null, current: null, action: "not_found" };
  const voice = objectData(await request(`/phone_numbers/${encodeURIComponent(id)}/voice`));
  const current = typeof voice.inbound_call_screening === "string" ? voice.inbound_call_screening : null;
  if (current === input.setting) return { phoneNumber: input.phoneNumber, numberId: id, current, action: "already_set" };
  if (!input.apply) return { phoneNumber: input.phoneNumber, numberId: id, current, action: "would_set" };
  const updated = objectData(await request(`/phone_numbers/${encodeURIComponent(id)}/voice`, {
    method: "PATCH",
    body: JSON.stringify({ inbound_call_screening: input.setting }),
  }));
  if (updated.inbound_call_screening !== undefined && updated.inbound_call_screening !== input.setting) {
    throw new Error("Telnyx did not persist inbound call screening");
  }
  return { phoneNumber: input.phoneNumber, numberId: id, current, action: "set" };
}

/** Carrier codes owners dial on their business phone to forward calls to their Call Otto number. */
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
