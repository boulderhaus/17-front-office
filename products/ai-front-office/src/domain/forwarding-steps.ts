/**
 * Which way the owner turns forwarding on and off: the iPhone's own Call Forwarding switch, or a carrier code.
 * Pure, no imports: the owner app (web/src/lib/dial.ts), the phone page (/d/<id>) and the emailed steps all use it,
 * so the three always show the same thing.
 *
 * Why: a forwarding code makes an iPhone show the carrier's gray "Dismiss" box, and iOS blocks every way around it.
 * The switch in Settings › Apps › Phone › Call Forwarding (older iPhones: Settings › Phone) sets forward-all with no
 * code and no gray box. It exists on GSM-family carriers (AT&T, T-Mobile and their resellers), not on the Verizon
 * family, and it only does every call: "Ring my phone first" has no switch, so it stays a code.
 */

/** Who's setting up: an iPhone, an Android, another phone browser, or a computer (the owner then picks up the phone). */
export type SetupDevice = "iphone" | "android" | "phone" | "desktop";
/** The iPhone's Settings switch, or a carrier code (or, for office lines, the phone company's website). */
export type SetupWay = "settings" | "code";

export interface ForwardingSteps {
  /** How to turn today's choice on. */
  on: SetupWay;
  /** How to clear every-call forwarding before ring first works (after a test found every call forwarded). */
  clear: SetupWay;
  /** How to turn today's forwarding off ("How to turn forwarding off"). */
  off: SetupWay;
  /**
   * Leaving every call for ring first where every call was the Settings switch: turn the switch off first, even
   * before a test finds it on (it beats any ring-first code, and turning it off shows no gray box).
   */
  clearFirst: boolean;
}

/**
 * The one decision. The switch is THE way only for every call, on an iPhone (or a computer, whose steps are read on
 * the phone), with a GSM-family carrier or one we couldn't place. Verizon family, Android and office lines keep codes.
 */
export function forwardingSteps(input: { device: SetupDevice; family: string | null | undefined; everyCall: boolean; leavingEveryCall?: boolean }): ForwardingSteps {
  const hasSwitch = (input.device === "iphone" || input.device === "desktop") && (input.family === "gsm" || input.family === "unknown" || input.family == null);
  const settingsForEveryCall: SetupWay = hasSwitch && input.everyCall ? "settings" : "code";
  return {
    on: settingsForEveryCall,
    clear: hasSwitch ? "settings" : "code",
    off: settingsForEveryCall,
    clearFirst: hasSwitch && !input.everyCall && input.leavingEveryCall === true,
  };
}

/** After a ring-first test that never rang (see ringFirstTry in forwarding.ts): what comes next. */
export type RingFirstRetry = "clear" | "clear_again" | "instead" | "help";

export interface RingFirstNext {
  /** The step to show, or null when the latest test didn't find ring first failing. */
  retry: RingFirstRetry | null;
  /** A clear step may show (the off code or the switch). "instead" and "help" clear nothing. */
  mayClear: boolean;
  /** Clearing again is the all-forwarding code even on an iPhone: the switch was the first clear. */
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

/** Otto's number as the Forward To field takes it: 10 digits, no +1, no punctuation. */
export function forwardToDigits(number: string): string {
  const digits = number.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

export const OLDER_IPHONE_LINE = "Older iPhones: Settings › Phone.";
/** The steps after the number is copied. */
export const SETTINGS_ON_STEPS: readonly string[] = [
  "Open Settings › Apps › Phone.",
  "Tap Call Forwarding and turn it on.",
  "Tap Forward To and paste the number.",
];
export const SETTINGS_OFF_LINE = "Open Settings › Apps › Phone. Tap Call Forwarding and turn it off.";
/** The quiet link to the code flow: the Verizon-family and odd-carrier fallback. */
export const NO_SWITCH_LINK = "Don’t see Call Forwarding?";
/** On a computer the owner may not have an iPhone: the same link also says Android. */
export const NO_SWITCH_LINK_DESKTOP = "Android, or no Call Forwarding?";

/** The Settings steps as plain text, for the emailed steps (same words as the screens). */
export function settingsStepsText(ottoNumber: string): string {
  return [
    `On an iPhone, Otto's number is ${forwardToDigits(ottoNumber)}:`,
    ...SETTINGS_ON_STEPS.map((step, index) => `${index + 1}. ${step}`),
    OLDER_IPHONE_LINE,
  ].join("\n");
}
