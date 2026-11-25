import { withTimeout } from "../application/retry.js";
import { DEFAULT_TELNYX_VOICE } from "../voice/system-prompt.js";
import { PLATFORM_TENANT_ID } from "../ports.js";

/**
 * "Set it up with me": Otto's AI setup helper calls the owner right away and walks them through call
 * forwarding. We dial over the Call Control connection; when the owner answers, our webhook starts a
 * dedicated setup assistant on the call with this shop's exact numbers and code in its instructions.
 * The assistant has no booking tools and no dynamic-variables webhook, so it never becomes a shop call.
 */
const STATE_PREFIX = "setup-help:";
const PLATFORM_TENANT = PLATFORM_TENANT_ID;

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
  /** About how long their phone rings before Call Otto answers in today's mode (GSM timer, Verizon ~30 s), or null. */
  ringSeconds?: number | null;
  /** "Every call" mode: their phone never rings for this number. */
  forwardsAll?: boolean;
  /** The forward-everything code, for "Otto answers every call". */
  everyCallCode?: string | null;
  /** The ring-first code, for "Ring my phone first". */
  ringFirstCode?: string | null;
  /** How long "Ring my phone first" rings before Call Otto answers (GSM timer, Verizon ~30 s), or null. */
  ringFirstSeconds?: number | null;
  /** Their last test call was picked up by the phone itself (screening, Live Voicemail, a person). */
  phoneAnswersTest?: boolean;
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
  const say = (code: string) => `${code} (say it as: ${spoken(code)})`;
  const ringFor = facts.family === "verizon" ? "about 30 seconds (Verizon sets that; nobody can change it)" : facts.ringFirstSeconds ? `${facts.ringFirstSeconds} seconds` : null;
  const iphoneFirst = "On iPhone they first turn off Live Voicemail in Settings, then Apps, then Phone (and set Screen Unknown Callers to Never if it's on).";
  const picked = facts.forwardsAll ? "Otto answers every call" : "Ring my phone first";
  const steps: string[] = [];
  const everyCallCode = facts.everyCallCode ?? (facts.forwardsAll ? facts.code : null);
  const ringFirstCode = facts.ringFirstCode ?? (facts.forwardsAll ? null : facts.code);
  if (facts.code) {
    steps.push(`Ask which they want, and explain each in one sentence, every call first. Otto answers every call: nothing to change on their phone, Otto picks up on the first ring, and their phone won't ring for calls to this number (calls they make and texts work like before). Ring my phone first: their phone rings${ringFor ? ` for ${ringFor}` : ""} first and Otto takes the calls they miss or decline. ${facts.device === "android" ? "On Android there's nothing else to change." : iphoneFirst} Suggest every call unless they want their phone to ring. Their screen shows both choices at the top, and ${picked} is picked now; if they want the other one, they tap it and the code on screen changes to match.`);
    const codes = [
      everyCallCode ? `For Otto answers every call, the code is ${say(everyCallCode)}.` : "",
      ringFirstCode ? `For Ring my phone first, the code is ${say(ringFirstCode)}.` : "",
    ].filter(Boolean).join(" ");
    steps.push(`${codes} They dial the one for their choice on the business phone (it's in the yellow box on their screen), then press Call.`);
    if (facts.device !== "android") steps.push("On iPhone: tap Copy code on their screen, open Phone, then Keypad, touch and hold above the numbers, tap Paste, then tap Call right away. Or type it in. iPhones block forwarding codes sent as links, so never offer to text them a link. If they see \"Call Forwarding Link Blocked\", tell them to close the Phone app and type the code.");
    if (facts.device !== "iphone") steps.push("On Android: they tap Tap to dial on their screen. The Phone app opens with the code filled in, and they tap Call. Android may ask them to confirm; that's expected.");
    if (facts.confirm) steps.push(`What they should see or hear: ${facts.confirm}`);
    steps.push(`They can't dial the code while on this call. So once they understand it, tell them to hang up, dial it, then come back to the Call Otto screen and tap Call me now. With every call, their phone won't ring, and they'll see a green check in a few seconds. With ring first, they tap Decline when it rings, and they'll see a green check.${facts.ringFirstSeconds ? ` No Decline button? They let it ring (about ${facts.ringFirstSeconds} seconds).` : " No Decline button? They let it ring until it stops."}`);
    steps.push(`${facts.phoneAnswersTest ? "Their last test: their phone picked up our test call by itself. Start with this. " : ""}If the screen says their phone picked up the test itself (Live Voicemail or call screening), carrier forwarding never got a chance. Two fixes: switch to Otto answers every call (tap it on the screen, then dial the new code${everyCallCode ? `, ${say(everyCallCode)}` : ""}), or keep ring first and turn off the phone's own answering, then test again. On iPhone that's Live Voicemail in Settings, then Apps, then Phone, and Screen Unknown Callers set to Never. On Android, automatic call screening in the Phone app's settings.`);
    if (facts.offCode) steps.push(`With every call: if they ever pause Call Otto, they dial ${say(facts.offCode)} first, or calls to this number won't go through.`);
  } else if (facts.family === "office") {
    steps.push(`Their business number is an office or landline phone. Ask which they want, one sentence each, every call first: Otto answers every call (their phones won't ring for this number), or Ring my phone first (Otto takes the calls they miss). Suggest every call unless they want their phones to ring. Forwarding is set in their phone company's website or app: find Call Forwarding, then forward all calls (for every call) or calls not answered, sometimes called no answer (for ring first), to their Call Otto number, ${pretty(facts.ottoNumber)}. You can't see their portal: if they get stuck, say Brock, our founder, will email them a link to book a 10-minute call.`);
  } else {
    steps.push("We don't know their phone company yet. Ask which company they pay for this number, then tell them to pick it on the Call Otto screen; the right code shows up there. Don't make up a code.");
  }
  if (facts.offCode) steps.push(`If they ask how to turn forwarding off later: dial ${facts.offCode} on the business phone.`);
  return [
    "You are Otto, Call Otto's AI setup helper, on a phone call the owner asked for by tapping \"Set it up with me\". Call Otto is an AI receptionist for trade businesses.",
    "Your only job: get their calls forwarding to Call Otto. Be warm, plain and brief: one short step at a time, then wait. These are busy tradespeople, not tech people.",
    "",
    "Their details:",
    `- Business: ${facts.businessName}`,
    `- Business number (the phone customers call today, which they keep): ${pretty(facts.businessNumber)}`,
    `- Phone company: ${facts.carrierName ?? "unknown"}`,
    `- Their Call Otto number (where calls go): ${pretty(facts.ottoNumber)}`,
    `- They're on ${phone}.`,
    `- Picked on their screen now: ${picked}.`,
    "",
    "Walk them through, in order:",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Rules:",
    "- Only give the codes and settings written above. Never invent a code, a setting path, a price or a promise.",
    "- Don't ask them to change phone settings unless they pick Ring my phone first on an iPhone, or their phone picked up our test call by itself.",
    facts.forwardsAll
      ? "- Right now every call to their business number goes to Call Otto once the code is on; their phone doesn't ring for those. Calls they make and texts work like before."
      : "- Right now their phone rings first. Only calls they miss, decline, or can't get (no signal) go to Call Otto.",
    "- If something isn't covered here (billing, a carrier that refuses the code, an error message you don't recognize), say Brock, our founder, will email them a link to book a 10-minute call, then wrap up.",
    "- If they say it's a bad time, say they can tap \"Set it up with me\" again anytime, then say goodbye and hang up.",
    "- When they're done or say goodbye, say a short goodbye and hang up in the same turn.",
  ].join("\n");
}

/** Read when the helper can't start. Brock's email with a booking link is queued before this is said. */
export const SETUP_SORRY_SPEECH = "Hi, this is Call Otto. Our setup helper couldn't start just now. Brock, our founder, just emailed you a link to book a quick 10 minute call. Sorry about that. Goodbye.";

/**
 * The apology, true to what was actually sent: SETUP_SORRY_SPEECH when Brock's email with a booking link just went,
 * "emailed you earlier" when today's email went before, no link mentioned when his calendar isn't connected (the
 * email asks for a reply), and no email mentioned when none went.
 */
export function setupSorrySpeech(email: { fresh: boolean; link: boolean } | null): string {
  if (email?.fresh && email.link) return SETUP_SORRY_SPEECH;
  const middle = email
    ? email.link
      ? `Brock, our founder, ${email.fresh ? "just emailed you a link" : "emailed you a link earlier"} to book a quick 10 minute call.`
      : `Brock, our founder, ${email.fresh ? "just emailed you" : "emailed you earlier"} to set up a quick 10 minute call.`
    : "Please try again later from the Call Otto app.";
  return `Hi, this is Call Otto. Our setup helper couldn't start just now. ${middle} Sorry about that. Goodbye.`;
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
  async apologize(callControlId: string, commandId: string, tenantId: string, speech = SETUP_SORRY_SPEECH): Promise<void> {
    const clientState = Buffer.from(`${SORRY_PREFIX}${tenantId}`).toString("base64");
    await this.request(`/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
      method: "POST",
      body: JSON.stringify({
        payload: speech,
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
