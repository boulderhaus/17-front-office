/**
 * What a voice tool route answers when it cannot do its job. The voice lab (research/voice-lab) saw
 * the model call check_availability 60+ times in a row, and invent slots, when a tool result was
 * unreadable. So every failure is a short, plain-English result the model can act on, and each tool
 * has a per-call budget after which it gets a fixed "stop, take a message" result.
 */
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
  status: "unavailable" | "limit_reached";
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

/**
 * The per-call counts live in the store (tool_call_budgets), so they hold across replicas and restarts.
 * Calls are capped at six minutes; the retention loop drops ledger rows untouched for two hours.
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
