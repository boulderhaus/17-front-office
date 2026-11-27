/**
 * Call forwarding for owners who keep their business number. The owner gives us one number;
 * we look up the carrier and show exactly one code to dial, one code to undo it, and nothing else.
 */

import type { RingFirstRetry } from "./forwarding-steps.js";

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
  /** GSM only: T-Mobile family (per-leg codes), AT&T family, or a GSM carrier we can't place (null elsewhere). */
  network?: GsmNetwork | null;
  /**
   * Ring first on GSM, after timed tests found the phone never rang (see ringFirstTry): what comes next once the
   * latest test says so. null: nothing failed yet. Only acted on while the latest test says the phone never rang.
   */
  retry?: RingFirstRetry | null;
  /**
   * T-Mobile family ring first: optional codes that also send declined calls and no-signal calls to Otto, dialed one
   * at a time and only after a timed test proved ring first. Empty elsewhere.
   */
  extras?: string[];
}

/** Which GSM network a carrier is on: T-Mobile's documents per-leg codes, AT&T's the combined **004 form. */
export type GsmNetwork = "tmobile" | "att" | "gsm";
/**
 * After a ring-first test where the phone never rang: "clear" the old forwarding (then the code again), "clear_again"
 * with the all-forwarding code, try the other code "instead", or stop dialing codes and offer "help".
 */
export type { RingFirstRetry };

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
 * What the owner was set up for when a test last passed: their choice and the code on screen then. Also written,
 * as every call, when the owner leaves every call before any test proved it (they may have dialed forward-all).
 * A ring-first test is also timed (ringFirstVerdict): a call that reached Otto with no ring means every call is
 * still forwarded. The owner is told never to answer or decline the test, so a fast arrival is never a Decline.
 */
export interface TestedFor {
  mode: ForwardingChoice;
  code: string | null;
  at: string;
  /** Ring first, tested by our own call: about how long the owner's phone rang before Otto answered. */
  rangSeconds?: number | null;
  /** Proven by our own timed call (every call: it reached Otto with no ring). A test from another phone isn't. */
  timed?: boolean;
}

/**
 * Ring-first test, timed by our own check call: from the moment Telnyx accepted our call to the moment the forwarded
 * call reached Otto (Telnyx's own event timestamp, so a slow or retried webhook never stretches it).
 * Forward-all (or a phone that turns the call away at once) gets there in about 2-4 s with no ring. The shortest
 * ring-first choice is 10 s of ringing on top of call setup, so a ring-first that works takes about 12 s.
 * Under this many ms the phone never rang: every call is still being forwarded.
 */
export const RING_FIRST_AT_ONCE_MS = 8_000;
/** About how long call setup takes before the owner's phone starts ringing; left out of "it rang about N seconds". */
export const CALL_SETUP_MS = 2_000;
/**
 * Every call picked, but our call took this long to reach Otto: the phone rang first (the ring-first code, or no
 * every-call code dialed yet). Above forward-all's slowest arrival, at the shortest ring-first timer.
 */
export const EVERY_CALL_RANG_MS = 12_000;
/** Nothing reached Otto this long after our test call went out (Verizon's ~30 s ring included): it isn't forwarding. */
export const NOT_FORWARDING_AFTER_MS = 45_000;
/** A setup-helper call this old with no recorded end is over (a lost hangup webhook never blocks timing for good). */
export const SETUP_CALL_STALE_MS = 15 * 60_000;

export type RingFirstVerdict = "at_once" | "rang";

/** What a ring-first test's timing proves: forwarded at once (forward-all still on) or rang first. */
export function ringFirstVerdict(afterMs: number): RingFirstVerdict {
  return Number.isFinite(afterMs) && afterMs >= RING_FIRST_AT_ONCE_MS ? "rang" : "at_once";
}

/** What an every-call test's timing proves: reached Otto at once, or the phone rang first (every call isn't on). */
export function everyCallVerdict(afterMs: number): RingFirstVerdict {
  return Number.isFinite(afterMs) && afterMs >= EVERY_CALL_RANG_MS ? "rang" : "at_once";
}

/** About how long the phone rang, in whole seconds, for "it rang about N seconds" (call setup left out). */
export function rangSeconds(afterMs: number): number {
  return Math.max(1, Math.round((afterMs - CALL_SETUP_MS) / 1_000));
}

export function parseTestedFor(value: string | null | undefined): TestedFor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TestedFor> | null;
    if (!parsed || (parsed.mode !== "every-call" && parsed.mode !== "ring-first")) return null;
    return { mode: parsed.mode, code: typeof parsed.code === "string" ? parsed.code : null, at: typeof parsed.at === "string" ? parsed.at : "", rangSeconds: typeof parsed.rangSeconds === "number" && Number.isFinite(parsed.rangSeconds) ? parsed.rangSeconds : null, ...(parsed.timed === true ? { timed: true } : {}) };
  } catch {
    return null;
  }
}

/**
 * True when the business number may send every call to Call Otto: "every call" is picked (dialed or not), or the
 * last passed test was (or the owner left it untested) for every call, until a test passes for ring first. Otto never dials it then (setup helper,
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

// T-Mobile family, including the legacy names carrier lookups still return for T-Mobile numbers (Aerial
// Communications, Omnipoint, VoiceStream, Powertel, SunCom, Sprint, Nextel) and the resellers on its network.
const TMOBILE = /t-?mobile|metro ?pcs|metro by|\bmetro\b|\bmint\b|ultra mobile|\bultra\b|google fi|project fi|us mobile|aerial comm|omnipoint|voicestream|voice stream|powertel|suncom|sprint|nextel|assurance wireless/i;
const ATT = /at&t|at ?& ?t|\batt\b|new cingular|cingular|cricket|consumer cellular|aio wireless|h2o|red pocket/i;

/** T-Mobile family, AT&T family, or another GSM carrier, from the carrier name the lookup stored. */
export function gsmNetwork(name: string | null | undefined): GsmNetwork {
  const carrier = name ?? "";
  if (TMOBILE.test(carrier)) return "tmobile";
  if (ATT.test(carrier)) return "att";
  return "gsm";
}

/** What ring first shows for this network after `misses` timed tests in a row found the phone never rang. */
export interface RingFirstTry {
  /** "combined": **004 (no answer, busy and no signal in one code). "no_answer": **61 (no answer only). */
  code: "combined" | "no_answer";
  /** The code that clears forwarding at this point (also the off code for ring first). */
  clear: string;
  retry: RingFirstRetry | null;
}

/**
 * The ring-first sequence. Never loops: each miss moves one step on, and the last step is help, not another code.
 * - T-Mobile family: **61 (T-Mobile documents it; the combined **004 fails silently on some of its lines while the
 *   iPhone still says Succeeded). Missed: clear with ##004# (T-Mobile's clear code), then **61. Missed again: clear
 *   with ##002#, then **61. Missed again: help.
 * - AT&T family and unknown GSM: **004. Missed: clear with ##002#, then **004. Missed again: "Try this code instead",
 *   **61. Missed again: help.
 */
export function ringFirstTry(network: GsmNetwork, misses: number): RingFirstTry {
  const count = Number.isFinite(misses) && misses > 0 ? Math.floor(misses) : 0;
  if (network === "tmobile") {
    if (count === 0) return { code: "no_answer", clear: "##004#", retry: null };
    if (count === 1) return { code: "no_answer", clear: "##004#", retry: "clear" };
    if (count === 2) return { code: "no_answer", clear: "##002#", retry: "clear_again" };
    return { code: "no_answer", clear: "##002#", retry: "help" };
  }
  if (count === 0) return { code: "combined", clear: "##002#", retry: null };
  if (count === 1) return { code: "combined", clear: "##002#", retry: "clear" };
  if (count === 2) return { code: "no_answer", clear: "##002#", retry: "instead" };
  return { code: "no_answer", clear: "##002#", retry: "help" };
}

/**
 * Misses kept once a ring-first test passes (or the owner changes how calls work): back to the start, except that an AT&T-family line that only worked
 * with **61 keeps it (its next miss goes to help, not back to the code that already failed).
 */
export function ringFirstMissesKept(network: GsmNetwork, misses: number): number {
  return network !== "tmobile" && Number.isFinite(misses) && misses >= 2 ? 2 : 0;
}

/** Misses saved, read back: a whole number, 0 when unset or unreadable. */
export function parseRingFirstMisses(value: string | null | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.min(9, Math.floor(count)) : 0;
}

const VERIZON = /verizon|cellco|xfinity|comcast.*mobile|spectrum mobile|charter.*mobile|visible|straight ?talk.*verizon|total wireless/i;
const GSM = /at&t|at ?& ?t|\batt\b|new cingular|cingular|cricket|t-?mobile|metro ?pcs|metro by|mint|sprint|consumer cellular|us mobile|ultra mobile|tracfone|h2o|red pocket|boost|dish wireless|google fi|aerial comm|omnipoint|voicestream|voice stream|powertel|suncom|nextel/i;

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

/**
 * `carrierName`: what the lookup stored (tells the T-Mobile family from the AT&T family). `misses`: timed ring-first
 * tests in a row that found the phone never rang (see ringFirstTry).
 */
export function forwardingPlan(family: CarrierFamily, frontOfficeNumber: string, mode: ForwardingMode, answerAfterRings?: number | null, options: { carrierName?: string | null; misses?: number | null } = {}): ForwardingPlan {
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
    // **004 covers no answer (after T seconds), busy (tapping Decline) and no signal (attics, basements) in one code;
    // **61 is no answer only. Which one, and which clear code, comes from ringFirstTry. Every call clears with ##002#.
    const seconds = ringFirstSeconds("gsm", answerAfterRings)!;
    const network = gsmNetwork(options.carrierName);
    const step = ringFirstTry(network, options.misses ?? 0);
    const on = always ? `**21*1${digits}#` : step.code === "no_answer" ? `**61*1${digits}**${seconds}#` : `**004*1${digits}**${seconds}#`;
    const off = always ? "##002#" : step.clear;
    return {
      family, on, off, dialLink: telLink(on), offDialLink: telLink(off), forwardsAll: always,
      ringSeconds: always ? null : seconds,
      what: always ? everyCall : step.code === "no_answer" ? `Your phone rings ${seconds} seconds first. Calls you miss go to Call Otto.` : `Your phone rings ${seconds} seconds first. Calls you miss or decline go to Call Otto.`,
      tips: [],
      confirm: "You’ll see “Setting Registration Succeeded.”",
      network,
      retry: always ? null : step.retry,
      extras: !always && network === "tmobile" ? [`**67*1${digits}#`, `**62*1${digits}#`] : [],
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
