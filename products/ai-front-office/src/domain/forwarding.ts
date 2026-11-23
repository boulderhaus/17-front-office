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
  /** Android-safe tel: link for the on code. iPhones refuse forwarding codes in links. */
  dialLink: string | null;
  offDialLink: string | null;
  /** Plain-English line under the code. */
  what: string;
  /** Short tips shown under the code. */
  tips: string[];
  /** Shown only on iPhones: Live Voicemail answers before carrier forwarding can. */
  iphoneTip: string | null;
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

export function forwardingPlan(family: CarrierFamily, frontOfficeNumber: string, mode: ForwardingMode): ForwardingPlan {
  const digits = frontOfficeNumber.replace(/^\+1/, "").replace(/\D/g, "");
  const always = mode === "always";
  const iphoneTip = "On an iPhone, also turn off Live Voicemail: Settings › Apps › Phone › Live Voicemail. Otherwise your iPhone answers before we can.";
  const ringTip = "Calls ring your phone first. If you don’t pick up, we answer.";
  if (family === "verizon") {
    const on = `${always ? "*72" : "*71"}${digits}`;
    return {
      family, on, off: "*73", dialLink: telLink(on), offDialLink: telLink("*73"),
      what: always ? "Every call goes straight to Front Office." : ringTip,
      tips: [], iphoneTip,
    };
  }
  if (family === "gsm") {
    // **004 covers no answer, busy (tapping Decline) and no signal (attics, basements) in one code.
    const on = always ? `**21*1${digits}#` : `**004*1${digits}#`;
    const off = always ? "##21#" : "##004#";
    return {
      family, on, off, dialLink: telLink(on), offDialLink: telLink(off),
      what: always ? "Every call goes straight to Front Office." : `${ringTip} Same if you tap Decline or have no signal.`,
      tips: [], iphoneTip,
    };
  }
  if (family === "office") {
    return {
      family, on: null, off: null, dialLink: null, offDialLink: null,
      what: always
        ? `In your phone company’s website or app, find Call Forwarding and forward all calls to ${pretty(frontOfficeNumber)}.`
        : `In your phone company’s website or app, find Call Forwarding › “when not answered” (or “no answer”) and forward to ${pretty(frontOfficeNumber)}.`,
      tips: ["Not sure where that is? Tap “Set it up with me” and we’ll do it together on the phone."],
      iphoneTip: null,
    };
  }
  return {
    family, on: null, off: null, dialLink: null, offDialLink: null,
    what: "Which phone company do you pay for this number?",
    tips: [], iphoneTip: null,
  };
}

/** The one line we text an owner who stops paying, so callers never hit a dead number. */
export function forwardingOffInstruction(family: CarrierFamily | null): string {
  if (family === "verizon") return "To stop forwarding, dial *73 on your business phone and press Call.";
  if (family === "gsm") return "To stop forwarding, dial ##004# on your business phone and press Call.";
  return "To stop forwarding, turn off call forwarding for your business number (dial *73 on Verizon, ##004# on AT&T or T-Mobile, or use your phone company’s website).";
}

/** Android dials * and # only when they are percent-encoded. */
function telLink(code: string): string {
  return `tel:${code.replace(/\*/g, "%2A").replace(/#/g, "%23")}`;
}

function pretty(phone: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}
