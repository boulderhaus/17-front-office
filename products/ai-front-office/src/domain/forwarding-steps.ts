/**
 * How the owner turns forwarding on, clears it and turns it off. Pure, no imports: the owner app
 * (web/src/lib/dial.ts), the phone page (/d/<id>), the emailed steps and the setup helper all use it, so they always
 * say the same thing.
 *
 * The rule (Brock, 2026-11-27): an owner is never sent into phone Settings to set forwarding up. Every step's default,
 * on every device, is a carrier code they copy and dial. A code dialed on an iPhone shows the carrier's gray "Dismiss"
 * box: iOS draws it, nothing hides it, and one line warns the owner first.
 *
 * The iPhone's own switch (Settings › Apps › Phone › Call Forwarding; older iPhones: Settings › Phone) is only the
 * other way, behind a quiet link the owner taps under the code ("Code didn't work?"). It exists on GSM-family
 * carriers (AT&T, T-Mobile and their resellers), not on the Verizon family, and it only does every call: "Ring my
 * phone first" has no switch.
 */

/** Who's setting up: an iPhone, an Android, another phone browser, or a computer (the owner then picks up the phone). */
export type SetupDevice = "iphone" | "android" | "phone" | "desktop";
/** A carrier code (for office lines, the phone company's website), or the iPhone's Settings switch. */
export type SetupWay = "settings" | "code";

export interface ForwardingSteps {
  /** The default way to turn today's choice on. Always the code. */
  on: SetupWay;
  /** The default way to clear every-call forwarding before ring first works. Always the code. */
  clear: SetupWay;
  /** The default way to turn today's forwarding off ("How to turn forwarding off"). Always the code. */
  off: SetupWay;
  /** Where the iPhone's switch can do that step too. Only ever offered behind the quiet link, never up front. */
  iphoneSwitch: { on: boolean; clear: boolean; off: boolean };
  /**
   * Leaving every call for ring first, once a test proved every call on, where the switch exists: clear it first,
   * before any ring-first test (it beats any ring-first code, whether a code or the switch turned it on). Unproven,
   * the ring-first code comes first and our timed test says whether there is anything to clear.
   */
  clearFirst: boolean;
}

/**
 * The one decision. The default is the code for every step, device and carrier. The switch is the other way only on an
 * iPhone (or a computer, whose steps are read on the phone) with a GSM-family carrier or one we couldn't place: for
 * every call (on and off) and for clearing it. Verizon family, Android and office lines have no other way.
 */
export function forwardingSteps(input: { device: SetupDevice; family: string | null | undefined; everyCall: boolean; leavingProvenEveryCall?: boolean }): ForwardingSteps {
  const hasSwitch = (input.device === "iphone" || input.device === "desktop") && (input.family === "gsm" || input.family === "unknown" || input.family == null);
  return {
    on: "code",
    clear: "code",
    off: "code",
    iphoneSwitch: { on: hasSwitch && input.everyCall, clear: hasSwitch, off: hasSwitch && input.everyCall },
    clearFirst: hasSwitch && !input.everyCall && input.leavingProvenEveryCall === true,
  };
}

/** After a ring-first test that never rang (see ringFirstTry in forwarding.ts): what comes next. */
export type RingFirstRetry = "clear" | "clear_again" | "instead" | "help";

export interface RingFirstNext {
  /** The step to show, or null when the latest test didn't find ring first failing. */
  retry: RingFirstRetry | null;
  /** A clear step may show (the off code, with the switch behind its link). "instead" and "help" clear nothing. */
  mayClear: boolean;
  /** Clearing again is the all-forwarding code alone, even on an iPhone: no switch behind a link this time. */
  clearByCode: boolean;
  /** No more codes: the help that exists (Call me now, a time with our team, or every call). */
  noCodes: boolean;
}

/**
 * The screen's next step after a ring-first test, shared by the owner app and the phone page. Only while ring first
 * is picked and the latest test found the phone never rang; otherwise the plan's retry is ignored.
 */
export function ringFirstNext(input: { retry: RingFirstRetry | null | undefined; neverRang: boolean; everyCall: boolean }): RingFirstNext {
  const retry = input.neverRang && !input.everyCall ? input.retry ?? null : null;
  return { retry, mayClear: retry !== "instead" && retry !== "help", clearByCode: retry === "clear_again", noCodes: retry === "help" };
}

/** The codes a clear step picks from: a plan's own (see ForwardingPlan in forwarding.ts). */
export interface ClearCodes {
  /** Today's off code. For ring first: its own clear code for this try (ringFirstTry). */
  off: string | null;
  offDialLink?: string | null;
  /** The code that turns every call off, whatever today's choice. */
  everyCallOff?: string | null;
  everyCallOffDialLink?: string | null;
}

/**
 * The one code that clears forwarding before the ring-first code, the same on the owner app, the phone page and for
 * the setup helper. Which step shows, and when, is forwardingSteps.clearFirst and ringFirstNext; this is only the code.
 * - Before any ring-first test (leaving an every call a test proved on): the code that turns every call off.
 * - After a test found every call still forwarded, while the owner is leaving every call: that same code. Forward-all
 *   is what's on (a code or the iPhone's switch set it), and ring first's own clear code can leave it on: T-Mobile's
 *   ##004# only resets the missed-call rules.
 * - Otherwise: ring first's own clear code for this try.
 */
export function forwardingClear(input: { neverRang: boolean; leavingEveryCall: boolean; plan: ClearCodes | null | undefined }): { code: string; dialLink: string | null } | null {
  const plan = input.plan;
  if (!plan) return null;
  const everyCall = !input.neverRang || input.leavingEveryCall;
  if (everyCall && plan.everyCallOff && plan.everyCallOff !== plan.off) return { code: plan.everyCallOff, dialLink: plan.everyCallOffDialLink ?? null };
  return plan.off ? { code: plan.off, dialLink: plan.offDialLink ?? null } : null;
}

/** Otto's number as the Forward To field takes it: 10 digits, no +1, no punctuation. */
export function forwardToDigits(number: string): string {
  const digits = number.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** The quiet link under a code: the only way to the iPhone's switch. */
export const CODE_FAILED_LINK = "Code didn’t work?";
/** On a computer the owner may not have an iPhone: the same link says who it's for. */
export const CODE_FAILED_LINK_DESKTOP = "Code didn’t work on your iPhone?";
/** Behind that link, the fix that needs no Settings comes first: a typed code works where a pasted one is blocked. */
export const RETRY_CODE_LINE = "First try the code once more, typed by hand.";
/** Then the switch, second. */
export const SWITCH_INSTEAD_LINE = "Or use the switch on your iPhone:";
/** From the switch steps back to the code. */
export const BACK_TO_CODE_LINK = "Back to the code";

export const OLDER_IPHONE_LINE = "Older iPhones: Settings › Phone.";
/** The steps after the number is copied. */
export const SETTINGS_ON_STEPS: readonly string[] = [
  "Open Settings › Apps › Phone.",
  "Tap Call Forwarding and turn it on.",
  "Tap Forward To and paste the number.",
];
export const SETTINGS_OFF_LINE = "Open Settings › Apps › Phone. Tap Call Forwarding and turn it off.";
