/**
 * What a voice tool route answers when it cannot do its job. The voice lab (research/voice-lab) saw
 * the model call check_availability 60+ times in a row, and invent slots, when a tool result was
 * unreadable. So every failure is a short, plain-English result the model can act on, and each tool
 * has a per-call budget after which it gets a fixed "stop, take a message" result.
 */
import type { CallStepKey } from "../domain/call-steps.js";

export type VoiceToolName =
  | "save_intake"
  | "get_approved_answer"
  | "check_service_area"
  | "check_availability"
  | "triage_call"
  | "book_slot"
  | "request_human"
  | "mark_spam_call";

/** Route path under /tools/ to the tool name the assistant knows. */
export const TOOL_ROUTES: Readonly<Record<string, VoiceToolName>> = {
  "save-intake": "save_intake",
  "approved-answer": "get_approved_answer",
  "check-service-area": "check_service_area",
  "check-availability": "check_availability",
  triage: "triage_call",
  book: "book_slot",
  "request-human": "request_human",
  "mark-spam": "mark_spam_call",
};

/**
 * Calls allowed per tool per phone call. The prompt says "never more than twice"; save_intake must run
 * on each detail change, and get_approved_answer once per topic, so they get more room. Anything past
 * the budget is a loop.
 */
export const TOOL_CALL_LIMITS: Readonly<Record<VoiceToolName, number>> = {
  save_intake: 8,
  get_approved_answer: 4,
  check_service_area: 2,
  check_availability: 2,
  triage_call: 2,
  book_slot: 2,
  request_human: 2,
  mark_spam_call: 2,
};

/** Answer before the provider's 5 s webhook timeout so the model never gets an empty result. */
export const TOOL_DEADLINE_MS = 4_000;

export interface ToolFailure {
  ok: false;
  /** switched_off: the shop turned this step off in "What Otto does on a call"; not a failure of the tool. */
  status: "unavailable" | "limit_reached" | "switched_off";
  /** One short line the assistant can say to the caller. */
  say: string;
  /** What the assistant does next. */
  instruction: string;
}

const FALLBACK: Readonly<Record<VoiceToolName, { say: string; instruction: string }>> = {
  check_availability: {
    say: "I can't see the calendar right now; the owner will confirm a time with you.",
    instruction: "Do not call check_availability again. Never invent or suggest a time. Save the caller's preferred time with save_intake and continue the intake.",
  },
  book_slot: {
    say: "I can't lock that time in right now; the owner will confirm it with you.",
    instruction: "Do not call book_slot again and never say the job is booked. Save the preferred time with save_intake and continue.",
  },
  check_service_area: {
    say: "I'll have the owner confirm you're in our area.",
    instruction: "Do not call check_service_area again. Do not promise coverage or book; continue the intake.",
  },
  get_approved_answer: {
    say: "I don't have that answer handy; the owner will get back to you on it.",
    instruction: "Do not quote a price or policy. Note the question with save_intake and continue.",
  },
  triage_call: {
    say: "Okay, let me get a few details for the owner.",
    instruction: "Triage is unavailable. Follow the SAFETY rules yourself: for gas, carbon monoxide, smoke, fire or danger, tell the caller to leave and call 911 or the gas utility. Otherwise continue the intake.",
  },
  request_human: {
    say: "I'll pass this to the owner so they can call you back.",
    instruction: "Do not call request_human again and do not transfer. Save the intake with human_requested=true and continue.",
  },
  mark_spam_call: {
    say: "Sorry about that. How can we help today?",
    instruction: "The call was not marked as spam. Do not hang up; continue the normal intake.",
  },
  save_intake: {
    say: "Got it.",
    instruction: "Saving failed; do not retry save_intake right now. Keep going and finish the call normally.",
  },
};

/** The result for any failed tool request. */
export function toolFailure(tool: VoiceToolName): ToolFailure {
  return { ok: false, status: "unavailable", ...FALLBACK[tool] };
}

/** The fixed result once a tool has used its per-call budget. */
export function toolLimitReached(tool: VoiceToolName): ToolFailure {
  return {
    ok: false,
    status: "limit_reached",
    say: tool === "save_intake" ? "Got it." : "Let me have the owner follow up on that; the owner will get back to you.",
    instruction: `Do not call ${tool} again on this call. Never invent times, prices or answers. Take a message: save the intake, tell the caller the owner will follow up, and wrap up.`,
  };
}

const SWITCHED_OFF: Readonly<Record<CallStepKey, { say: string; instruction: string }>> = {
  screenSalesCalls: {
    say: "Sorry about that. How can I help?",
    instruction: "This shop takes a message from every caller. The call was not marked as spam: do not hang up and do not call mark_spam_call again. Take a name, a number and a short message, and save it with save_intake.",
  },
  askAddress: {
    say: "Okay.",
    instruction: "This shop does not take an address. Do not ask for one; continue the intake.",
  },
  checkServiceArea: {
    say: "Okay.",
    instruction: "This shop does not check its service area. Do not call check_service_area again and never say an address is outside the area; continue the intake.",
  },
  offerTimes: {
    say: "The owner will call you back to set up a time.",
    instruction: "This shop does not book over the phone. Do not call check_availability or book_slot again, and never offer, suggest or confirm a time. Save the details with save_intake and continue.",
  },
  quotePrices: {
    say: "The owner will go over pricing when they call you back.",
    instruction: "This shop does not quote prices over the phone. Never quote or estimate a price and do not ask get_approved_answer for one again. Note the question with save_intake and continue.",
  },
  answerQuestions: {
    say: "The owner will answer that when they call you back.",
    instruction: "This shop takes a message for questions like this. Do not answer it and do not ask get_approved_answer for an answer again. Note the question with save_intake and continue.",
  },
};

/**
 * The result when a shop switched this tool's step off ("What Otto does on a call") and the tool is called anyway:
 * the same ok=false shape, with a line to say and what to do next. Its status is not a failed one: nothing broke.
 */
export function toolSwitchedOff(step: CallStepKey): ToolFailure {
  return { ok: false, status: "switched_off", ...SWITCHED_OFF[step] };
}

/**
 * The tool_events row our server adds to a call when it answers one of its voice tools with toolFailure or
 * toolLimitReached. The model only hears the fixed result and the real status goes to the log; this row is the
 * call's own record of it. A speech-to-speech call's tool calls never show in the provider's conversation history,
 * so it is the one place the post-deploy selftest can see that a tool did not work.
 */
export const TOOL_FAILED_EVENT = "tool.failed";

/**
 * Tool answer statuses that mean the tool did not work. The post-deploy selftests fail on them, and a support call's
 * record never drops one to make room for later answers.
 */
export const FAILED_TOOL_STATUSES: ReadonlySet<string> = new Set(["unavailable", "error", "failed", "invalid", "rejected"]);

/**
 * The per-call counts live in the store (tool_call_budgets), so they hold across replicas and restarts.
 * Calls end by about six minutes (seven at the Telnyx backstop); the retention loop drops ledger rows untouched for two hours.
 */
export const TOOL_LEDGER_RETENTION_MS = 2 * 60 * 60_000;

/** Telnyx call-control ids are short; anything longer is not a call id and gets no budget row. */
export const MAX_PROVIDER_CALL_ID_LENGTH = 200;

/** True while a tool's per-call count (after this call) is inside its budget. */
export function withinToolBudget(tool: VoiceToolName, count: number): boolean {
  return count <= TOOL_CALL_LIMITS[tool];
}

/** Why a tool answered take-a-message instead of running. Logged, never shown to the model. */
export type ToolLimitReason = "budget" | "budget_unavailable" | "missing_call_id" | "rate_limited" | "deadline";
