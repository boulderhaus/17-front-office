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

/** GSM carriers ring this long before forwarding unless the owner picks another time. */
export const DEFAULT_RING_SECONDS = 15;
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

/**
 * True when ringing `phone` could land back on this shop's Call Otto line: the owner's business number forwards
 * everything to Otto, so Otto calling it would just be Otto calling Otto. That's the case in "every call" mode (even
 * before the code is dialed) and whenever the last code proven in force is a forward-all one (after switching back
 * to "ring me first" but before dialing the off code).
 */
export function forwardsBackToOtto(input: { mode: ForwardingMode; businessNumber: string | null; phone: string | null; dialedCode?: string | null }): boolean {
  if (!input.businessNumber || input.phone !== input.businessNumber) return false;
  return input.mode === "always" || isForwardAllCode(input.dialedCode);
}

/** A forward-all code sends our test straight to Otto, phone untouched: a pass that took longer means the phone rang first. */
export const FORWARD_ALL_PASS_MS = 10_000;
/** Leaving forward-all for "ring me first": a pass this fast means the test never rang the phone, so forward-all is still on. */
export const RANG_FIRST_MIN_MS = 6_000;

/**
 * Which code a passing test proves is in force: the one on screen when the owner started it, if the timing fits
 * that code. Null when it doesn't (the new code wasn't dialed yet), so "Dial this once" stays up.
 */
export function codeProvenByTest(input: { code: string | null | undefined; previous: string | null | undefined; passMs: number }): string | null {
  if (!input.code || !Number.isFinite(input.passMs)) return null;
  if (isForwardAllCode(input.code)) return input.passMs <= FORWARD_ALL_PASS_MS ? input.code : null;
  if (isForwardAllCode(input.previous) && input.passMs < RANG_FIRST_MIN_MS) return null;
  return input.code;
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
  const everyCall = "Every call goes straight to Call Otto. Your phone won’t ring for calls to this number.";
  if (family === "verizon") {
    const on = `${always ? "*72" : "*71"}${digits}`;
    return {
      family, on, off: "*73", dialLink: telLink(on), offDialLink: telLink("*73"), forwardsAll: always,
      ringSeconds: always ? null : VERIZON_RING_SECONDS,
      what: always ? everyCall : "Your phone rings for about 30 seconds first (Verizon sets that). If you don’t pick up or you tap Decline, Call Otto answers.",
      tips: [],
      confirm: "You’ll hear a tone or a short message. Hang up, come back here and test it.",
    };
  }
  if (family === "gsm") {
    // **004 covers no answer (after T seconds), busy (tapping Decline) and no signal (attics, basements) in one code.
    // ##002# clears every kind of forwarding, so the off code is right whichever one was set.
    const seconds = ringSeconds(answerAfterRings);
    const on = always ? `**21*1${digits}#` : `**004*1${digits}**${seconds}#`;
    const off = "##002#";
    return {
      family, on, off, dialLink: telLink(on), offDialLink: telLink(off), forwardsAll: always,
      ringSeconds: always ? null : seconds,
      what: always ? everyCall : `Your phone rings for ${seconds} seconds first. If you don’t pick up, Call Otto answers. Same if you tap Decline or have no signal.`,
      tips: [],
      confirm: "You’ll see “Setting Registration Succeeded” (Android: “Call forwarding”). Tap Dismiss, come back here and test it.",
    };
  }
  if (family === "office") {
    return {
      family, on: null, off: null, dialLink: null, offDialLink: null, forwardsAll: always, ringSeconds: null,
      what: always
        ? `In your phone company’s website or app, find Call Forwarding and forward all calls to ${pretty(frontOfficeNumber)}.`
        : `In your phone company’s website or app, find Call Forwarding › “when not answered” (or “no answer”) and forward to ${pretty(frontOfficeNumber)}.`,
      tips: ["Not sure where that is? Tap “Set it up with me” and we’ll do it together on the phone."],
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
