/**
 * Call forwarding for owners who keep their business number. The owner gives us one number;
 * we look up the carrier and show exactly one code to dial, one code to undo it, and nothing else.
 */

/** How a phone company turns forwarding on. "office" = landline/VoIP set up in a web portal. */
export type CarrierFamily = "verizon" | "gsm" | "office" | "unknown";
export type ForwardingMode = "overflow" | "after_hours" | "always";

export interface CarrierInfo {
  /** Carrier name as the lookup reported it, for display only. */
  name: string | null;
  /** Lookup line type: "mobile", "fixed line", "voip", ... */
  lineType: string | null;
  family: CarrierFamily;
  /** True when the owner picked the carrier instead of the lookup. */
  chosen: boolean;
}

export interface ForwardingPlan {
  family: CarrierFamily;
  /** What the owner dials to turn forwarding on, or null for office lines (portal setup). */
  on: string | null;
  /** What the owner dials to turn it off, or null for office lines. */
  off: string | null;
  /** Android-safe tel: link for the on code. Never rendered on iPhones: iOS blocks forwarding links. */
  dialLink: string | null;
  offDialLink: string | null;
  /** True when every call goes to Call Otto and the owner's phone never rings for this number. */
  forwardsAll: boolean;
  /** About how long the owner's phone rings before Call Otto answers: the GSM timer, Verizon's fixed ~30 s, else null. */
  ringSeconds: number | null;
  /** Plain-English line under the code. */
  what: string;
  /** Short tips shown under the code. */
  tips: string[];
  /** What the owner sees or hears once the code goes through, so they know it took. */
  confirm: string | null;
}

/** GSM carriers ring this long before forwarding unless the owner picks another time: about 7–12 s to pick up. */
export const DEFAULT_RING_SECONDS = 10;
/** New shops' "Ring my phone first" setting: 2 rings ≈ 10 seconds (see ringSeconds). */
export const DEFAULT_ANSWER_AFTER_RINGS = 2;
/** Verizon (and Visible) ring about this long before *71 forwards, and nobody can change it. */
export const VERIZON_RING_SECONDS = 30;

/**
 * "Ring my phone first" in seconds for the GSM no-answer timer: a North American ring is about 6 s
 * (2 on, 4 off), rounded to the nearest 5 and kept to the 5–30 s carriers accept.
 */
export function ringSeconds(answerAfterRings: number | null | undefined): number {
  if (typeof answerAfterRings !== "number" || !Number.isFinite(answerAfterRings) || answerAfterRings <= 0) return DEFAULT_RING_SECONDS;
  return Math.min(30, Math.max(5, Math.round((answerAfterRings * 6) / 5) * 5));
}

/** How long "Ring my phone first" rings before Call Otto answers, for this carrier: GSM's timer, Verizon's fixed ~30 s, else null. */
export function ringFirstSeconds(family: CarrierFamily, answerAfterRings?: number | null): number | null {
  if (family === "verizon") return VERIZON_RING_SECONDS;
  if (family === "gsm") return ringSeconds(answerAfterRings);
  return null;
}

/** The "Ring my phone first" choices, labelled with what the owner actually gets. Values are rings (half steps allowed). */
export const RING_CHOICES: ReadonlyArray<{ rings: number; seconds: number; label: string }> = [
  { rings: 2, seconds: 10, label: "About 10 seconds (2 rings)" },
  { rings: 2.5, seconds: 15, label: "15 seconds (2–3 rings)" },
  { rings: 3, seconds: 20, label: "About 20 seconds (3 rings)" },
  { rings: 4, seconds: 25, label: "About 25 seconds (4 rings)" },
  { rings: 5, seconds: 30, label: "30 seconds (5 rings)" },
];

/** The choices plus a saved value from before them (6–12 rings all mean the 30-second most), so a select never drops it. */
export function ringChoicesWith(current: number): Array<{ rings: number; seconds: number; label: string }> {
  if (!Number.isFinite(current) || RING_CHOICES.some((choice) => choice.rings === current)) return [...RING_CHOICES];
  const seconds = ringSeconds(current);
  const label = seconds === 30 ? "30 seconds (the longest carriers allow)" : `About ${seconds} seconds`;
  return [...RING_CHOICES, { rings: current, seconds, label }].sort((left, right) => left.rings - right.rings);
}

/** A code that sends every call to Call Otto (GSM **21, Verizon *72), so the owner's phone never rings. */
export function isForwardAllCode(code: string | null | undefined): boolean {
  return typeof code === "string" && /^(\*\*21\*|\*72)/.test(code);
}

/** "Otto answers every call" (forward-all) or "Ring my phone first" (missed calls only, or after hours). */
export type ForwardingChoice = "every-call" | "ring-first";

export function forwardingChoice(mode: ForwardingMode): ForwardingChoice {
  return mode === "always" ? "every-call" : "ring-first";
}

/**
 * What the owner was set up for when a test last passed: their choice and the code on screen then. The owner's
 * choice is the source of truth; we never work out which code is on from how long a test took (a Decline forwards
 * as fast as forward-all, and a 15 s timer can't be told from a 25 s one).
 */
export interface TestedFor {
  mode: ForwardingChoice;
  code: string | null;
  at: string;
}

export function parseTestedFor(value: string | null | undefined): TestedFor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TestedFor> | null;
    if (!parsed || (parsed.mode !== "every-call" && parsed.mode !== "ring-first")) return null;
    return { mode: parsed.mode, code: typeof parsed.code === "string" ? parsed.code : null, at: typeof parsed.at === "string" ? parsed.at : "" };
  } catch {
    return null;
  }
}

/**
 * True when the business number may send every call to Call Otto: "every call" is picked (dialed or not), or the
 * last passed test was for every call (until a test passes for ring first). Otto never dials it then (setup helper,
 * urgent owner calls, warm transfers): it would only be Otto calling Otto. Office lines follow the same rule.
 */
export function mayForwardAll(input: { mode: ForwardingMode; testedFor?: TestedFor | null }): boolean {
  return input.mode === "always" || input.testedFor?.mode === "every-call";
}

/** True when ringing `phone` could land back on this shop's Call Otto line (see mayForwardAll). */
export function forwardsBackToOtto(input: { mode: ForwardingMode; businessNumber: string | null; phone: string | null; testedFor?: TestedFor | null }): boolean {
  if (!input.businessNumber || input.phone !== input.businessNumber) return false;
  return mayForwardAll(input);
}

/** Families an owner can pick when the lookup is unsure, in the words they'd use. */
export const CARRIER_CHOICES: Array<{ family: Exclude<CarrierFamily, "unknown">; label: string }> = [
  { family: "verizon", label: "Verizon, Xfinity Mobile, Spectrum Mobile or Visible" },
  { family: "gsm", label: "AT&T, T-Mobile, Cricket, Metro, Mint or another cell company" },
  { family: "office", label: "An office or landline phone (Comcast Business, Spectrum Business, RingCentral…)" },
];

const VERIZON = /verizon|cellco|xfinity|comcast.*mobile|spectrum mobile|charter.*mobile|visible|straight ?talk.*verizon|total wireless/i;
const GSM = /at&t|at ?& ?t|\batt\b|new cingular|cingular|cricket|t-?mobile|metro ?pcs|metro by|mint|sprint|consumer cellular|us mobile|ultra mobile|tracfone|h2o|red pocket|boost|dish wireless|google fi/i;

export function carrierFamily(name: string | null | undefined, lineType: string | null | undefined): CarrierFamily {
  const carrier = name ?? "";
  const type = (lineType ?? "").toLowerCase();
  const mobile = type.includes("mobile");
  if (type === "fixed line" || type === "voip") return "office";
  if (VERIZON.test(carrier)) return "verizon";
  if (GSM.test(carrier)) return "gsm";
  if (mobile) return "unknown";
  return carrier ? "office" : "unknown";
}

export function forwardingPlan(family: CarrierFamily, frontOfficeNumber: string, mode: ForwardingMode, answerAfterRings?: number | null): ForwardingPlan {
  const digits = frontOfficeNumber.replace(/^\+1/, "").replace(/\D/g, "");
  const always = mode === "always";
  const everyCall = "Every call goes to Call Otto. Your phone won’t ring for this number.";
  if (family === "verizon") {
    const on = `${always ? "*72" : "*71"}${digits}`;
    return {
      family, on, off: "*73", dialLink: telLink(on), offDialLink: telLink("*73"), forwardsAll: always,
      ringSeconds: always ? null : VERIZON_RING_SECONDS,
      what: always ? everyCall : "Your phone rings about 30 seconds first (Verizon sets that). Calls you miss or decline go to Call Otto.",
      tips: [],
      confirm: "You’ll hear a tone.",
    };
  }
  if (family === "gsm") {
    // **004 covers no answer (after T seconds), busy (tapping Decline) and no signal (attics, basements) in one code.
    // ##002# clears every kind of forwarding, so the off code is right whichever one was set.
    const seconds = ringFirstSeconds("gsm", answerAfterRings)!;
    const on = always ? `**21*1${digits}#` : `**004*1${digits}**${seconds}#`;
    const off = "##002#";
    return {
      family, on, off, dialLink: telLink(on), offDialLink: telLink(off), forwardsAll: always,
      ringSeconds: always ? null : seconds,
      what: always ? everyCall : `Your phone rings ${seconds} seconds first. Calls you miss or decline go to Call Otto.`,
      tips: [],
      confirm: "You’ll see “Setting Registration Succeeded.”",
    };
  }
  if (family === "office") {
    return {
      family, on: null, off: null, dialLink: null, offDialLink: null, forwardsAll: always, ringSeconds: null,
      what: always
        ? `In your phone company’s website or app, forward all calls to ${pretty(frontOfficeNumber)}.`
        : `In your phone company’s website or app, forward calls you don’t answer to ${pretty(frontOfficeNumber)}.`,
      tips: [],
      confirm: null,
    };
  }
  return {
    family, on: null, off: null, dialLink: null, offDialLink: null, forwardsAll: always, ringSeconds: null,
    what: "Which phone company do you pay for this number?",
    tips: [], confirm: null,
  };
}

/** The one line we text an owner who stops paying, so callers never hit a dead number. */
export function forwardingOffInstruction(family: CarrierFamily | null): string {
  if (family === "verizon") return "To stop forwarding, dial *73 on your business phone and press Call.";
  if (family === "gsm") return "To stop forwarding, dial ##002# on your business phone and press Call.";
  return "To stop forwarding, turn off call forwarding for your business number (dial *73 on Verizon, ##002# on AT&T or T-Mobile, or use your phone company’s website).";
}

/** Android dials * and # only when they are percent-encoded. */
function telLink(code: string): string {
  return `tel:${code.replace(/\*/g, "%2A").replace(/#/g, "%23")}`;
}

function pretty(phone: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}
