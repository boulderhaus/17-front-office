import { withTimeout } from "../application/retry.js";
import { DEFAULT_TELNYX_VOICE, ottoSpeechSettings, TOOL_CALL_AUDIO } from "../voice/system-prompt.js";
import { forwardingSteps, forwardToDigits } from "../domain/forwarding-steps.js";
import { PLATFORM_TENANT_ID } from "../ports.js";
import { assistantVoicePayload, currentTextModel, isSpeechToSpeechAssistant, VoiceModeError, type ShopAssistantPayload, type SpeechToSpeechSettings } from "../voice/voice-mode.js";

/**
 * "Call me now": Otto's AI setup helper calls the owner's saved mobile right away and walks them through call
 * forwarding. We dial over the Call Control connection; when the owner answers, our webhook starts the setup
 * assistant on the call with this shop's facts as variables. Its tools are our signed /setup-help webhooks (test,
 * email the steps, book a time with our team); it has no shop booking tools and no dynamic-variables webhook, so it
 * never becomes a shop call.
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
  /**
   * Their last passed test was for every call (or they left every call untested), so forward-all may still be on:
   * for Ring my phone first they turn forwarding off first (offCode, or the website for office lines), then set ring
   * first. Forward-all wins otherwise.
   */
  everyCallOn?: boolean;
  /** Ring first, and the latest timed test reached Otto with no ring: what the screen shows next (see ringFirstTry). */
  ringFirstRetry?: "clear" | "clear_again" | "instead" | "help" | null;
  /** T-Mobile family ring first: optional decline and no-signal codes, one at a time, only after a ring-first pass. */
  ringFirstExtras?: string[];
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


export function setupGreeting(facts: SetupCallFacts): string {
  return `Hi, this is Otto, Call Otto's A.I. setup helper. You asked for help turning on call forwarding for ${facts.businessName}. Is now a good time?`;
}

/** The greeting as the assistant reads it, from the call's variables. */
export const SETUP_HELP_GREETING = "Hi, this is Otto, Call Otto's A.I. setup helper. You asked for help turning on call forwarding for {{shop_name}}. Is now a good time?";

/** Say "our team" when the helper can't finish: the booking tools, or our team's email when there's no calendar. */
const TEAM_FALLBACK = "offer a quick 10-minute call with our team (get_open_times, then book_time)";

/**
 * The numbered steps for this shop's case. The way to turn forwarding on comes from forwardingSteps, the one decision
 * the owner app, the phone page and the emailed steps use, so the voice never says something the screen doesn't.
 */
export function setupSteps(facts: SetupCallFacts): string[] {
  const say = (code: string) => `${code} (say it as: ${spoken(code)})`;
  const ringFor = facts.family === "verizon" ? "about 30 seconds (Verizon sets that; nobody can change it)" : facts.ringFirstSeconds ? `${facts.ringFirstSeconds} seconds` : null;
  const iphoneFirst = "On iPhone they first turn off Live Voicemail in Settings, then Apps, then Phone (and set Screen Unknown Callers to Never if it's on).";
  const picked = facts.forwardsAll ? "Otto answers every call" : "Ring my phone first";
  const steps: string[] = [];
  const everyCallCode = facts.everyCallCode ?? (facts.forwardsAll ? facts.code : null);
  const ringFirstCode = facts.ringFirstCode ?? (facts.forwardsAll ? null : facts.code);
  // An iPhone on an AT&T or T-Mobile family line turns every call on with its own Call Forwarding switch, no code.
  const switchWay = facts.device === "iphone" && forwardingSteps({ device: "iphone", family: facts.family, everyCall: true }).on === "settings";
  const digits = spoken(forwardToDigits(facts.ottoNumber));
  if (facts.code) {
    steps.push(`Ask which they want, and explain each in one sentence, every call first. Otto answers every call: no phone settings to change, Otto answers right away, and their phone won't ring for calls to this number (calls they make and texts work like before). Ring my phone first: their phone rings${ringFor ? ` for ${ringFor}` : ""} first and Otto takes the calls they miss or decline. ${facts.device === "android" ? "On Android there's nothing else to change." : iphoneFirst} Suggest every call unless they want their phone to ring. Their screen shows both choices at the top, and ${picked} is picked now; if they want the other one, they tap it and the steps on screen change to match.`);
    // Ring first that never rang: the same next step the screen shows. "help" gives no ring-first code at all, and
    // "instead" clears nothing first.
    const retry = facts.forwardsAll ? null : facts.ringFirstRetry ?? null;
    const codes = [
      everyCallCode
        ? switchWay
          ? `For Otto answers every call, on this iPhone they use the Call Forwarding switch, no code. They can do it while on this call: open Settings, then Apps, then Phone. Tap Call Forwarding and turn it on. Tap Forward To and enter Otto's number, ${digits}. Older iPhones: Settings, then Phone. If they don't see Call Forwarding, the code is ${say(everyCallCode)}.`
          : `For Otto answers every call, the code is ${say(everyCallCode)}.`
        : "",
      ringFirstCode && retry !== "help"
        ? facts.everyCallOn && facts.offCode && !retry
          ? `For Ring my phone first, every call may still be on, so they first turn forwarding off${switchWay ? " (on this iPhone: the Call Forwarding switch in Settings, then Apps, then Phone, turned off; or" : ":"} dial ${say(facts.offCode)} and press Call${switchWay ? ")" : ""}. Then they dial the ring-first code, ${say(ringFirstCode)}.`
          : `For Ring my phone first, the code is ${say(ringFirstCode)}.`
        : "",
    ].filter(Boolean).join(" ");
    steps.push(`${codes} A code is dialed on the business phone (it's in the yellow box on their screen), then they press Call.`);
    if (facts.device !== "android") steps.push("To dial a code on iPhone: tap Copy code & open Phone on their screen (if the Phone app doesn't open, they open Phone, then Keypad), touch and hold above the numbers, tap Paste, then tap Call right away. Or type it in. iPhones block forwarding codes sent as links, so never offer to text them a link. If they see \"Call Forwarding Link Blocked\", tell them to close the Phone app and type the code.");
    if (facts.device !== "iphone") steps.push("On Android: they tap Tap to dial on their screen. The Phone app opens with the code filled in, and they tap Call. Android may ask them to confirm; that's expected.");
    if (facts.confirm) steps.push(`What they should see or hear after a code: ${facts.confirm}`);
    steps.push(`${switchWay ? "The switch works during this call. " : ""}A code can't be dialed during this call, so once they understand it, tell them to hang up, dial it, then come back to the Call Otto screen and tap Test it (or Test again). If it's on already, run start_forwarding_test yourself. With every call, their phone won't ring, and they'll see a green check in a few seconds. With ring first, their phone rings and they don't answer or decline it: they let it ring${facts.ringFirstSeconds ? ` (about ${facts.ringFirstSeconds} seconds)` : " until it stops"}, and they'll see a green check. The test times the ring, so a Decline makes it look like the phone never rang.`);
    if ((retry === "clear" || retry === "clear_again") && facts.offCode && ringFirstCode) steps.push(`Their last ring-first test reached Otto with no ring, so old forwarding is still on. First they dial ${say(facts.offCode)} and press Call${retry === "clear" && switchWay ? " (on this iPhone they can turn off the Call Forwarding switch instead)" : ""}, then the ring-first code again, ${say(ringFirstCode)}, then test again.`);
    if (retry === "instead" && ringFirstCode) steps.push(`Their last two ring-first tests reached Otto with no ring, so this phone may not take that code. Their screen now says Try this code instead: ${say(ringFirstCode)}. They dial it, then test again.`);
    if (retry === "help") steps.push(`Ring first codes didn't work on this phone after several tries. Don't give them another code. Offer Otto answers every call, or ${TEAM_FALLBACK}.`);
    if (!facts.forwardsAll && facts.ringFirstExtras?.length) steps.push(`Only after a ring-first test has passed, and only if they ask about declined calls or no signal: it's optional. They dial ${facts.ringFirstExtras.map(say).join(", then ")}, one at a time, each followed by Call.`);
    steps.push(`${facts.phoneAnswersTest ? "Their last test: their phone picked up our test call by itself. Start with this. " : ""}If the test says their phone picked up the call itself (Live Voicemail or call screening), carrier forwarding never got a chance. Two fixes: switch to Otto answers every call (tap it on the screen${everyCallCode && !switchWay ? `, then dial the new code, ${say(everyCallCode)}` : ""}), or keep ring first and turn off the phone's own answering, then test again. On iPhone that's Live Voicemail in Settings, then Apps, then Phone, and Screen Unknown Callers set to Never. On Android, automatic call screening in the Phone app's settings.`);
    if (facts.offCode) steps.push(`To turn forwarding off later, they dial ${say(facts.offCode)} on the business phone${switchWay ? " (or turn the iPhone switch off for every call)" : ""}. With every call, they do that before they ever pause Call Otto, or calls to this number won't go through.`);
  } else if (facts.family === "office") {
    steps.push(`Their business number is an office or landline phone. Ask which they want, one sentence each, every call first: Otto answers every call (their phones won't ring for this number), or Ring my phone first (Otto takes the calls they miss). Suggest every call unless they want their phones to ring. Forwarding is set in their phone company's website or app: find Call Forwarding, then forward all calls (for every call) or calls not answered, sometimes called no answer (for ring first), to their Call Otto number, ${digits}.${facts.everyCallOn ? " Every call may still be on: for Ring my phone first, they turn off forward all calls there first, then set calls not answered." : ""} You can't see their portal: if they get stuck, ${TEAM_FALLBACK}.`);
  } else {
    steps.push("We don't know their phone company yet. Ask which company they pay for this number, then tell them to pick it on the Call Otto screen; the right code shows up there. Don't make up a code.");
  }
  return steps.map((step, index) => `${index + 1}. ${step}`);
}

export interface SetupTestSummary {
  /** passed, failed, not_run. */
  status: "passed" | "failed" | "not_run";
  /** One plain line for the helper, never a number or a name. */
  detail: string;
}

/**
 * Everything the helper is told about this shop, as the call's variables. All of it comes from what we stored, never
 * from a guess. Values are plain text (Telnyx variables are strings).
 */
export function setupHelpVariables(facts: SetupCallFacts, test: SetupTestSummary = { status: "not_run", detail: "No test yet." }): Record<string, string> {
  const device = facts.device === "iphone" ? "an iPhone" : facts.device === "android" ? "an Android phone" : "a phone we couldn't identify (ask whether it's an iPhone or Android)";
  return {
    shop_name: facts.businessName,
    picked_mode: facts.forwardsAll ? "Otto answers every call" : "Ring my phone first",
    device,
    carrier: facts.carrierName ?? "unknown",
    carrier_family: facts.family === "gsm" ? "AT&T or T-Mobile family" : facts.family === "verizon" ? "Verizon family" : facts.family === "office" ? "office or landline" : "unknown",
    business_number_last4: facts.businessNumber ? facts.businessNumber.slice(-4) : "not entered yet",
    otto_number_digits: spoken(forwardToDigits(facts.ottoNumber)),
    setup_steps: setupSteps(facts).join("\n"),
    mode_rule: facts.forwardsAll
      ? "Right now every call to their business number goes to Call Otto once forwarding is on; their phone doesn't ring for those. Calls they make and texts work like before."
      : "Right now their phone rings first. Only calls they miss, decline, or can't get (no signal) go to Call Otto.",
    last_test: `${test.status}: ${test.detail}`,
  };
}

/** The helper's standing instructions. Every fact about the shop is a {{variable}} filled at call start. */
export const SETUP_HELP_INSTRUCTIONS = [
  "You are Otto, Call Otto's AI setup helper, on a phone call the owner asked for by tapping \"Call me now\". Call Otto is an AI receptionist for trade businesses.",
  "Your only job: get their calls forwarding to Call Otto. Be warm, plain and brief. Short spoken sentences. One step at a time, then stop and wait for them. These are busy tradespeople, not tech people.",
  "",
  "Their details:",
  "- Business: {{shop_name}}",
  "- Business number (the phone customers call today, which they keep): ends in {{business_number_last4}}",
  "- Phone company: {{carrier}} ({{carrier_family}})",
  "- Their Call Otto number (where calls go), read one digit at a time: {{otto_number_digits}}",
  "- They're on {{device}}.",
  "- Picked on their screen now: {{picked_mode}}.",
  "- Their last forwarding test: {{last_test}}",
  "",
  "Walk them through, in order:",
  "{{setup_steps}}",
  "",
  "Tools:",
  "- start_forwarding_test: once they say forwarding is on, start our test call, then call get_test_result every few seconds until it isn't calling. Read its say line.",
  "- email_steps: if they want the steps in writing, email them once. Say it's on its way. Never call it again on this call.",
  "- get_open_times and book_time: a 10-minute call with our team. Read the times exactly as given, let them pick, repeat the time back, and only book after they say yes. Then say the booked time out loud and that a confirmation email is coming.",
  "",
  "Rules:",
  "- Only give the codes and settings written above. Never invent a code, a setting path, a price or a promise. Read numbers and codes one digit at a time.",
  "- Don't ask them to change phone settings unless they pick Ring my phone first on an iPhone, or their phone picked up our test call by itself.",
  "- {{mode_rule}}",
  "- Every tool answer says minutes_on_call. If it isn't working after about two minutes, or they ask for a person, " + TEAM_FALLBACK + ". Never give a person's name: say our team.",
  "- If something isn't covered here (billing, a carrier that refuses the code, an error message you don't recognize), " + TEAM_FALLBACK + ".",
  "- If they say it's a bad time, offer a time with our team, or say they can tap \"Call me now\" again anytime. Then say goodbye and hang up.",
  "- When they're done or say goodbye, say a short goodbye and hang up in the same turn.",
].join("\n");

/** The template filled in with this shop's variables: what the helper effectively reads. */
export function setupInstructions(facts: SetupCallFacts, test?: SetupTestSummary): string {
  const variables = setupHelpVariables(facts, test);
  return SETUP_HELP_INSTRUCTIONS.replace(/\{\{(\w+)\}\}/g, (match, name: string) => variables[name] ?? match);
}

/** The helper's tools: our webhooks (signed by Telnyx, keyed to this call) and hang up. */
export function setupHelpTools(publicBaseUrl: string): Array<Record<string, unknown>> {
  const base = publicBaseUrl.replace(/\/$/, "");
  const webhook = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = [], filler?: string) => ({
    type: "webhook",
    timeout_ms: 8_000,
    webhook: {
      name,
      description,
      url: `${base}${SETUP_HELP_TOOL_PREFIX}${name}`,
      method: "POST",
      body_parameters: { type: "object", properties, required },
      preset_body_fields: { provider_call_id: "{{call_control_id}}" },
      ...(filler ? { messages: [{ type: "request_start", content: filler }] } : {}),
    },
  });
  return [
    webhook("start_forwarding_test", "Start Call Otto's test call to their business phone. Only after they say forwarding is on. Then poll get_test_result.", {}, [], "Okay, starting the test."),
    webhook("get_test_result", "Read the latest forwarding test. status is calling, passed, or a problem; say is the line to read."),
    webhook("email_steps", "Email the owner the forwarding steps for their phone. Once per call.", {}, [], "Sending that now."),
    webhook("get_open_times", "Up to three open times for a 10-minute call with our team, in the owner's time zone. Read each label exactly.", {}, [], "Let me look at the times."),
    webhook("book_time", "Book one of the times from get_open_times after the owner says yes. Only status=booked means booked.", {
      slot_start: { type: "string", description: "The exact start of the time they picked, as given by get_open_times." },
      explicit_confirmation: { type: "boolean", description: "True only after the owner said yes to that exact time." },
    }, ["slot_start", "explicit_confirmation"], "Okay, booking that."),
    { type: "hangup", hangup: { description: "End the call right after saying goodbye, in the same turn." } },
  ];
}

/** Where the helper's tool webhooks land. */
export const SETUP_HELP_TOOL_PREFIX = "/setup-help/tools/";
export const SETUP_HELP_TOOL_NAMES = ["start_forwarding_test", "get_test_result", "email_steps", "get_open_times", "book_time"] as const;
export type SetupHelpToolName = typeof SETUP_HELP_TOOL_NAMES[number];
/** Hard cap on a support call: about six minutes. */
export const SETUP_CALL_TIME_LIMIT_SECS = 360;
/** At most this many support calls per shop in 24 hours. */
export const SETUP_CALLS_PER_DAY = 3;
export const SETUP_ASSISTANT_NAME = "Call Otto · Setup helper";

/**
 * The setup helper assistant in the standard voice, as configure-telnyx creates and updates it and the runtime creates
 * it if it was never made (both through buildSetupHelper, which applies the voice mode). Voice and speech settings are
 * Otto's own (TELNYX_VOICE and ottoSpeechSettings); the model is copied from Otto's assistant, never written here.
 */
export function buildSetupAssistant(input: { publicBaseUrl: string; voice?: string | undefined; inherited?: Record<string, unknown> }): Record<string, unknown> {
  return {
    ...(input.inherited ?? {}),
    name: SETUP_ASSISTANT_NAME,
    instructions: SETUP_HELP_INSTRUCTIONS,
    greeting: SETUP_HELP_GREETING,
    voice_settings: { voice: input.voice ?? DEFAULT_TELNYX_VOICE, voice_speed: 1, tool_call_audio: TOOL_CALL_AUDIO },
    tools: setupHelpTools(input.publicBaseUrl),
    dynamic_variables: Object.fromEntries(Object.keys(setupHelpVariables(PLACEHOLDER_FACTS)).map((key) => [key, "unknown"])),
    telephony_settings: { time_limit_secs: SETUP_CALL_TIME_LIMIT_SECS, user_idle_timeout_secs: 120 },
    ...ottoSpeechSettings(),
  };
}

export interface SetupHelperBuild extends Omit<ShopAssistantPayload, "payload"> {
  /** The whole assistant, as created or pushed. */
  body: Record<string, unknown>;
}

/**
 * The setup helper in the voice mode every Call Otto voice uses (src/voice/voice-mode.ts). `ottoAssistant` is Otto's
 * (the demo) assistant as Telnyx has it; `existing` is the helper itself when it already exists.
 *
 * Speech-to-speech by default (TELNYX_VOICE_MODE, unless "platform" is in TELNYX_STANDARD_TENANT_IDS): the same
 * speaking model and voice as Otto, with its own tools delegated to the same backend text model. If that can't be
 * built it is standard, with the reason (fallback).
 * Standard: Otto's text model (its delegation backend while Otto's assistant is still in speech-to-speech mode, never
 * the speaking model, which would run no tools) and the text-to-speech voice, with delegation turned off when the
 * helper itself is still in speech-to-speech mode (rollback).
 */
export function buildSetupHelper(input: { publicBaseUrl: string; voice?: string | undefined; ottoAssistant?: Record<string, unknown> | null | undefined; speechToSpeech?: SpeechToSpeechSettings | undefined; existing?: Record<string, unknown> | null | undefined }): SetupHelperBuild {
  const otto = dataOf(input.ottoAssistant);
  const inherited = inheritedModel(otto);
  const textModel = currentTextModel(otto) ?? currentTextModel(input.existing) ?? input.speechToSpeech?.backendModel ?? null;
  if (isSpeechToSpeechAssistant(otto)) {
    if (textModel) inherited.model = textModel;
    else delete inherited.model;
  }
  const standard = buildSetupAssistant({ publicBaseUrl: input.publicBaseUrl, voice: input.voice, inherited });
  // The helper follows the default only: it is no shop, so the opt-in list and the demo rule never apply to it.
  const settings = input.speechToSpeech ? { ...input.speechToSpeech, tenantIds: [], demoTenantId: undefined } : undefined;
  const { payload, ...voice } = assistantVoicePayload(standard, { tenantId: PLATFORM_TENANT_ID, speechToSpeech: settings, existing: textModel ? { model: textModel } : null });
  if (voice.mode === "speech_to_speech" || !isSpeechToSpeechAssistant(input.existing)) return { body: payload, ...voice };
  if (!textModel) throw new VoiceModeError("The setup helper is in speech-to-speech mode and has no text model to go back to");
  return { body: { ...payload, model: textModel, delegation_settings: { enabled: false } }, ...voice, rollback: true };
}

function dataOf(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const data = value?.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : value ?? {};
}

const PLACEHOLDER_FACTS: SetupCallFacts = { businessName: "", businessNumber: null, carrierName: null, family: null, code: null, offCode: null, confirm: null, ottoNumber: "", device: "other" };

/** Read when the helper can't start. Our team's email with a booking link is queued before this is said. */
export const SETUP_SORRY_SPEECH = "Hi, this is Call Otto. Our setup helper couldn't start just now. Our team just emailed you a link to book a quick 10 minute call. Sorry about that. Goodbye.";

/**
 * The apology, true to what was actually sent: SETUP_SORRY_SPEECH when our team's email with a booking link just went,
 * "emailed you earlier" when today's email went before, no link mentioned when the team calendar isn't connected (the
 * email asks for a reply), and no email mentioned when none went.
 */
export function setupSorrySpeech(email: { fresh: boolean; link: boolean } | null): string {
  if (email?.fresh && email.link) return SETUP_SORRY_SPEECH;
  const middle = email
    ? email.link
      ? `Our team ${email.fresh ? "just emailed you a link" : "emailed you a link earlier"} to book a quick 10 minute call.`
      : `Our team ${email.fresh ? "just emailed you" : "emailed you earlier"} to set up a quick 10 minute call.`
    : "Please try again later from the Call Otto app.";
  return `Hi, this is Call Otto. Our setup helper couldn't start just now. ${middle} Sorry about that. Goodbye.`;
}

export class TelnyxSetupCaller {
  constructor(private readonly options: {
    apiKey: string;
    templateAssistantId: string | null;
    /** The setup helper's own assistant (TELNYX_SETUP_ASSISTANT_ID), when configure-telnyx made it and it's set. */
    setupAssistantId?: string | null;
    publicBaseUrl: string;
    voice?: string | undefined;
    /** The voice mode settings (speechToSpeechSettings(env)), for a helper this caller has to make itself. */
    speechToSpeech?: SpeechToSpeechSettings | undefined;
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
        time_limit_secs: SETUP_CALL_TIME_LIMIT_SECS,
        // Voicemail answers: our webhook hangs up on a "machine" verdict and the screen offers a time instead.
        answering_machine_detection: "premium",
        webhook_url: input.webhookUrl,
        client_state: setupHelpClientState(input.tenantId),
      }),
    });
    return typeof result.data?.call_control_id === "string" ? result.data.call_control_id : null;
  }

  /**
   * Answered: start the setup helper on the call with this shop's facts as variables. The instructions and tools go
   * inline too, so a helper assistant made before they existed still runs today's version.
   */
  async start(input: { callControlId: string; commandId: string; clientState: string; facts: SetupCallFacts; test?: SetupTestSummary }): Promise<void> {
    const assistantId = await this.assistantId();
    await this.request(`/calls/${encodeURIComponent(input.callControlId)}/actions/ai_assistant_start`, {
      method: "POST",
      body: JSON.stringify({
        assistant: { id: assistantId, instructions: SETUP_HELP_INSTRUCTIONS, tools: setupHelpTools(this.options.publicBaseUrl), dynamic_variables: setupHelpVariables(input.facts, input.test) },
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

  /** One setup-helper assistant for every shop: TELNYX_SETUP_ASSISTANT_ID, the saved one, or made once now. */
  private async assistantId(): Promise<string> {
    if (this.options.setupAssistantId) return this.options.setupAssistantId;
    const saved = await this.options.getSecret(PLATFORM_TENANT, "telnyx", "setup_assistant_id");
    if (saved) return saved;
    const template = this.options.templateAssistantId
      ? await this.request<{ data?: Record<string, unknown> }>(`/ai/assistants/${encodeURIComponent(this.options.templateAssistantId)}`).then((value) => value.data ?? {})
      : {};
    const created = await this.request<{ data?: { id?: unknown }; id?: unknown }>("/ai/assistants", {
      method: "POST",
      headers: { "idempotency-key": "call-otto-setup-helper-v2" },
      body: JSON.stringify(buildSetupHelper({ publicBaseUrl: this.options.publicBaseUrl, voice: this.options.voice, ottoAssistant: template, speechToSpeech: this.options.speechToSpeech }).body),
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

/** Otto's model settings, copied from its assistant: the setup helper never names a model of its own. */
export function inheritedModel(template: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(["model", "llm_api_key_ref", "enabled_features"].filter((key) => template[key] !== undefined && template[key] !== null).map((key) => [key, template[key]]));
}
