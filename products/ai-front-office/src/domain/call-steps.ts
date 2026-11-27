import type { BusinessConfig, CollectedCallFields } from "./models.js";

/**
 * "What Otto does on a call" (Settings): the steps of a call each shop can switch on or off. A shop that never
 * touched them has every step on, which is exactly the call Otto ran before the switches existed.
 *
 * Never switchable: the safety step (gas, smoke or carbon monoxide: leave and call 911, owner alerted at once) and
 * taking the caller's name, number and problem.
 */
export interface CallSteps {
  /** Say goodbye to sales calls, robocalls and wrong numbers (mark_spam_call). Off: everyone gets a message taken. */
  screenSalesCalls: boolean;
  /** Ask for the service address. Off: never asked, and the service-area check is off with it. */
  askAddress: boolean;
  /** Check the address against the shop's cities and ZIP codes (check_service_area). Needs askAddress. */
  checkServiceArea: boolean;
  /** Offer open times and book or take a preferred time (check_availability, book_slot). Off: owner callback only. */
  offerTimes: boolean;
  /** Quote the owner's approved prices. Off: never a price, even when prices are saved. */
  quotePrices: boolean;
  /** Answer from the owner's approved answers. Off: a message is taken instead. */
  answerQuestions: boolean;
}

export const CALL_STEP_KEYS = ["screenSalesCalls", "askAddress", "checkServiceArea", "offerTimes", "quotePrices", "answerQuestions"] as const satisfies ReadonlyArray<keyof CallSteps>;
export type CallStepKey = (typeof CALL_STEP_KEYS)[number];

export const DEFAULT_CALL_STEPS: Readonly<CallSteps> = { screenSalesCalls: true, askAddress: true, checkServiceArea: true, offerTimes: true, quotePrices: true, answerQuestions: true };

/** "Ask every caller": how many questions an owner may add, and how long each may be after trimming. */
export const MAX_CUSTOM_QUESTIONS = 3;
export const MAX_CUSTOM_QUESTION_LENGTH = 80;
/** What a caller said to one of those questions, as kept on the call. */
export const MAX_EXTRA_ANSWER_LENGTH = 300;

/** The switches as saved: anything missing or not a boolean is on (today's call). */
export function normalizeCallSteps(value: unknown): CallSteps {
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const steps = { ...DEFAULT_CALL_STEPS };
  for (const key of CALL_STEP_KEYS) if (saved[key] === false) steps[key] = false;
  return steps;
}

/**
 * What Otto does for this shop. The saved service-area switch is kept while the address is off (so turning the
 * address back on brings it back), but it only counts when an address is asked for.
 */
export function callSteps(config: Pick<BusinessConfig, "callSteps">): CallSteps {
  const saved = normalizeCallSteps(config.callSteps);
  return { ...saved, checkServiceArea: saved.askAddress && saved.checkServiceArea };
}

/**
 * The service-call fee question (Calendar > Booking) reads the fee from the owner's prices, so it is off while
 * Otto quotes no prices.
 */
export function feeAcceptanceRequired(config: Pick<BusinessConfig, "callSteps" | "requireDiagnosticFeeAcceptance">): boolean {
  return config.requireDiagnosticFeeAcceptance && callSteps(config).quotePrices;
}

/**
 * The step a voice tool belongs to, or null for a tool no switch removes (save_intake, triage_call, request_human).
 * get_approved_answer serves two steps: prices and answers.
 */
export function stepForTool(tool: string, kind?: "price" | "answer"): CallStepKey | null {
  if (tool === "mark_spam_call") return "screenSalesCalls";
  if (tool === "check_service_area") return "checkServiceArea";
  if (tool === "check_availability" || tool === "book_slot") return "offerTimes";
  if (tool === "get_approved_answer") return kind === "price" ? "quotePrices" : kind === "answer" ? "answerQuestions" : null;
  return null;
}

/** The step that switches this tool off for this shop, or null when the shop still has it. */
export function switchedOffStep(config: Pick<BusinessConfig, "callSteps">, tool: string, kind?: "price" | "answer"): CallStepKey | null {
  const step = stepForTool(tool, kind);
  return step && !callSteps(config)[step] ? step : null;
}

/**
 * One owner-written question, safe to sit in Otto's instructions as a quoted list item: a single line, no control
 * characters, no template braces and no double quotes (compatibility forms folded first, so a full-width brace or
 * a curly quote can't turn into one later). Never trusted as an instruction.
 */
export function cleanCustomQuestion(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/[{}<>\\`]/g, "")
    .replace(/["\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Questions as saved: cleaned, empty ones dropped, clipped to the limits. Never throws (old or hand-edited configs). */
export function normalizeCustomQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const questions: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const question = cleanCustomQuestion(item).slice(0, MAX_CUSTOM_QUESTION_LENGTH).trim();
    if (question && !questions.includes(question)) questions.push(question);
    if (questions.length === MAX_CUSTOM_QUESTIONS) break;
  }
  return questions;
}

/**
 * Questions as an owner typed them in Settings (one per line). Too many or too long is refused in plain words
 * instead of being cut short behind their back.
 */
export function parseCustomQuestions(raw: string): string[] {
  const questions = raw.split(/\r?\n/).map(cleanCustomQuestion).filter(Boolean);
  if (questions.length > MAX_CUSTOM_QUESTIONS) throw new Error(`You can add up to ${MAX_CUSTOM_QUESTIONS} questions. Remove one, then save again.`);
  const long = questions.findIndex((question) => question.length > MAX_CUSTOM_QUESTION_LENGTH);
  if (long >= 0) throw new Error(`Question ${long + 1} is ${questions[long]!.length} characters. Keep each question to ${MAX_CUSTOM_QUESTION_LENGTH} or less.`);
  return [...new Set(questions)];
}

export type ExtraAnswer = NonNullable<CollectedCallFields["extraAnswers"]>[number];

/** A caller's answer as kept on the call: one line, no control characters, clipped. */
export function cleanExtraAnswer(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_EXTRA_ANSWER_LENGTH).trim();
}

/**
 * Answers by position (extra_answer_1 is the answer to the shop's first question) paired with the question as
 * the shop has it now. An answer with no question behind it is dropped.
 */
export function pairExtraAnswers(questions: readonly string[], answers: ReadonlyArray<string | null | undefined>): ExtraAnswer[] {
  const paired: ExtraAnswer[] = [];
  questions.slice(0, MAX_CUSTOM_QUESTIONS).forEach((question, index) => {
    const answer = cleanExtraAnswer(answers[index] ?? "");
    if (answer) paired.push({ question, answer });
  });
  return paired;
}

/** Later answers replace earlier ones to the same question; the rest are kept, in the order first given. */
export function mergeExtraAnswers(existing: readonly ExtraAnswer[] | undefined, incoming: readonly ExtraAnswer[] | undefined): ExtraAnswer[] {
  const merged = (existing ?? []).map((item) => ({ ...item }));
  for (const item of incoming ?? []) {
    const at = merged.findIndex((kept) => kept.question === item.question);
    if (at >= 0) merged[at] = { ...item };
    else merged.push({ ...item });
  }
  return merged.slice(0, MAX_CUSTOM_QUESTIONS);
}

/**
 * Steps of Otto's path (domain/call-path.ts) this shop switched off: left out of a call's path unless the call
 * recorded something for them anyway (a call from before the switch).
 */
export function hiddenCallPathSteps(config: Pick<BusinessConfig, "callSteps">): Array<"service_check" | "address" | "times" | "booking"> {
  const steps = callSteps(config);
  return [
    ...(steps.screenSalesCalls ? [] : ["service_check" as const]),
    ...(steps.askAddress ? [] : ["address" as const]),
    ...(steps.offerTimes ? [] : ["times" as const, "booking" as const]),
  ];
}
