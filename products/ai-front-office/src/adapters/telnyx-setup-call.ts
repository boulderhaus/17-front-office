import { withTimeout } from "../application/retry.js";
import { DEFAULT_TELNYX_VOICE } from "../voice/system-prompt.js";

/**
 * "Set it up with me": Otto's AI setup helper calls the owner right away and walks them through call
 * forwarding. We dial over the Call Control connection; when the owner answers, our webhook starts a
 * dedicated setup assistant on the call with this shop's exact numbers and code in its instructions.
 * The assistant has no booking tools and no dynamic-variables webhook, so it never becomes a shop call.
 */
const STATE_PREFIX = "setup-help:";
const PLATFORM_TENANT = "platform";

export interface SetupCallFacts {
  businessName: string;
  businessNumber: string | null;
  carrierName: string | null;
  family: "verizon" | "gsm" | "office" | "unknown" | null;
  code: string | null;
  offCode: string | null;
  confirm: string | null;
  ottoNumber: string;
  device: "iphone" | "android" | "other";
}

export function setupHelpClientState(tenantId: string): string {
  return Buffer.from(`${STATE_PREFIX}${tenantId}`).toString("base64");
}

const SORRY_PREFIX = "setup-sorry:";

/**
 * The shop whose setup-help call this Call Control leg is, and where the call is: "help" while the
 * helper runs, "sorry" once we're reading the can't-start apology (then hang up when it ends).
 */
export function setupHelpState(clientState: unknown): { tenantId: string; phase: "help" | "sorry" } | null {
  if (typeof clientState !== "string" || !clientState) return null;
  const decoded = Buffer.from(clientState, "base64").toString("utf8");
  const phase = decoded.startsWith(STATE_PREFIX) ? "help" : decoded.startsWith(SORRY_PREFIX) ? "sorry" : null;
  if (!phase) return null;
  const tenantId = decoded.slice((phase === "help" ? STATE_PREFIX : SORRY_PREFIX).length);
  return /^[\w-]{1,80}$/.test(tenantId) ? { tenantId, phase } : null;
}

/** Digits read one at a time, so the voice says "nine four one", never "nine hundred forty-one". */
function spoken(code: string): string {
  return code.split("").map((char) => (char === "*" ? "star" : char === "#" ? "pound" : char)).join(" ");
}

function pretty(phone: string | null): string {
  const match = phone ? /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone) : null;
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone ?? "not entered yet";
}

export function setupGreeting(facts: SetupCallFacts): string {
  return `Hi, this is Otto, Call Otto's A.I. setup helper. You asked for help turning on call forwarding for ${facts.businessName}. Is now a good time?`;
}

/** Everything the helper may say comes from here. It never invents a code or a setting. */
export function setupInstructions(facts: SetupCallFacts): string {
  const phone = facts.device === "iphone" ? "an iPhone" : facts.device === "android" ? "an Android phone" : "a phone we couldn't identify (ask whether it's an iPhone or Android)";
  const steps: string[] = [];
  if (facts.device !== "android") {
    steps.push("iPhone only, before anything else: open Settings, then Apps, then Phone. Set Screen Unknown Callers to Never, and turn off Live Voicemail. Explain: otherwise the iPhone picks up new customers' calls itself before Call Otto can, and Call Otto screens those calls for them.");
  }
  if (facts.device !== "iphone") {
    steps.push("Android only: if the Phone app screens unknown callers (Pixel Call Screen, Samsung Bixby text call), turn that off in the Phone app's settings, for the same reason.");
  }
  if (facts.code) {
    steps.push(`Dial the code on their screen, in the yellow box, on the business phone, then press Call. The code is ${facts.code} (say it as: ${spoken(facts.code)}). It's also on their screen with a Copy code button: in the Phone app keypad they can tap above the numbers and paste.`);
    if (facts.confirm) steps.push(`What they should see or hear: ${facts.confirm}`);
    steps.push("They can't dial the code while on this call. So once the settings are done and they understand the code, tell them to hang up, dial it, then come back to the Call Otto screen and tap Call me now under Test it. When our test call rings, they should not answer: let it ring until it stops. A green check means it works.");
  } else if (facts.family === "office") {
    steps.push(`Their business number is an office or landline phone. Forwarding is set in their phone company's website or app: find Call Forwarding, then the option for when a call is not answered (or no answer), and forward to their Call Otto number, ${pretty(facts.ottoNumber)}. You can't see their portal: if they get stuck, say a person from Call Otto will follow up by email today.`);
  } else {
    steps.push("We don't know their phone company yet. Ask which company they pay for this number, then tell them to pick it on the Call Otto screen; the right code shows up there. Don't make up a code.");
  }
  if (facts.offCode) steps.push(`If they ask how to turn forwarding off later: dial ${facts.offCode} on the business phone.`);
  return [
    "You are Otto, Call Otto's AI setup helper, on a phone call the owner asked for by tapping \"Set it up with me\". Call Otto is an AI receptionist that answers the calls a trade business misses.",
    "Your only job: get their missed calls forwarding to Call Otto. Be warm, plain and brief: one short step at a time, then wait. These are busy tradespeople, not tech people.",
    "",
    "Their details:",
    `- Business: ${facts.businessName}`,
    `- Business number (the phone customers call today, which they keep): ${pretty(facts.businessNumber)}`,
    `- Phone company: ${facts.carrierName ?? "unknown"}`,
    `- Their Call Otto number (where missed calls go): ${pretty(facts.ottoNumber)}`,
    `- They're on ${phone}.`,
    "",
    "Walk them through, in order:",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Rules:",
    "- Only give the codes and settings written above. Never invent a code, a setting path, a price or a promise.",
    "- Their phone still rings first. Only calls they miss, decline, or can't get (no signal) go to Call Otto.",
    "- If something isn't covered here (billing, a carrier that refuses the code, an error message you don't recognize), say a person from Call Otto will follow up by email today, then wrap up.",
    "- If they say it's a bad time, say they can tap \"Set it up with me\" again anytime, then say goodbye and hang up.",
    "- When they're done or say goodbye, say a short goodbye and hang up in the same turn.",
  ].join("\n");
}

export class TelnyxSetupCaller {
  constructor(private readonly options: {
    apiKey: string;
    templateAssistantId: string | null;
    getSecret: (tenantId: string, provider: string, key: string) => Promise<string | null>;
    saveSecret: (tenantId: string, provider: string, key: string, value: string) => Promise<void>;
    fetcher?: typeof fetch;
  }) {}

  /** Ring the owner now. Returns the call's id, or null if Telnyx didn't take it. */
  async dial(input: { connectionId: string; from: string; to: string; webhookUrl: string; tenantId: string }): Promise<string | null> {
    const result = await this.request<{ data?: { call_control_id?: unknown } }>("/calls", {
      method: "POST",
      body: JSON.stringify({
        connection_id: input.connectionId,
        to: input.to,
        from: input.from,
        timeout_secs: 30,
        time_limit_secs: 900,
        webhook_url: input.webhookUrl,
        client_state: setupHelpClientState(input.tenantId),
      }),
    });
    return typeof result.data?.call_control_id === "string" ? result.data.call_control_id : null;
  }

  /** Answered: start the setup helper on the call with this shop's facts. */
  async start(input: { callControlId: string; commandId: string; clientState: string; facts: SetupCallFacts }): Promise<void> {
    const assistantId = await this.assistantId();
    await this.request(`/calls/${encodeURIComponent(input.callControlId)}/actions/ai_assistant_start`, {
      method: "POST",
      body: JSON.stringify({
        assistant: { id: assistantId, instructions: setupInstructions(input.facts) },
        greeting: setupGreeting(input.facts),
        client_state: input.clientState,
        command_id: input.commandId,
      }),
    }, [422]);
  }

  /** The helper couldn't start: say so plainly instead of leaving the owner in silence, then hang up. */
  async apologize(callControlId: string, commandId: string, tenantId: string): Promise<void> {
    const clientState = Buffer.from(`${SORRY_PREFIX}${tenantId}`).toString("base64");
    await this.request(`/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
      method: "POST",
      body: JSON.stringify({
        payload: "Hi, this is Call Otto. Our setup helper couldn't start just now. A person from Call Otto will email you today to set up your call forwarding. Sorry about that. Goodbye.",
        voice: "AWS.Polly.Joanna", language: "en-US", command_id: commandId, client_state: clientState,
      }),
    }, [404, 422]);
  }

  async hangUp(callControlId: string): Promise<void> {
    await this.request(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`, { method: "POST", body: "{}" }, [404, 422]);
  }

  /** One setup-helper assistant for every shop, made once from the template's model and voice. */
  private async assistantId(): Promise<string> {
    const saved = await this.options.getSecret(PLATFORM_TENANT, "telnyx", "setup_assistant_id");
    if (saved) return saved;
    const template = this.options.templateAssistantId
      ? await this.request<{ data?: Record<string, unknown> }>(`/ai/assistants/${encodeURIComponent(this.options.templateAssistantId)}`).then((value) => value.data ?? {})
      : {};
    const inherited = Object.fromEntries(["model", "voice_settings", "llm_api_key_ref", "enabled_features"].filter((key) => template[key] !== undefined && template[key] !== null).map((key) => [key, template[key]]));
    const created = await this.request<{ data?: { id?: unknown }; id?: unknown }>("/ai/assistants", {
      method: "POST",
      headers: { "idempotency-key": "call-otto-setup-helper-v1" },
      body: JSON.stringify({
        ...inherited,
        name: "Call Otto · Setup helper",
        instructions: "You are Otto, Call Otto's AI setup helper. Per-call instructions replace this.",
        ...(inherited.voice_settings ? {} : { voice_settings: { voice: DEFAULT_TELNYX_VOICE, voice_speed: 1 } }),
        tools: [{ type: "hangup", hangup: { description: "End the call right after saying goodbye, in the same turn." } }],
        telephony_settings: { time_limit_secs: 900, user_idle_timeout_secs: 120 },
        transcription: { model: "deepgram/flux", language: "en" },
      }),
    });
    const id = typeof created.data?.id === "string" ? created.data.id : typeof created.id === "string" ? created.id : null;
    if (!id) throw new Error("Telnyx did not return a setup assistant id");
    await this.options.saveSecret(PLATFORM_TENANT, "telnyx", "setup_assistant_id", id);
    return id;
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
