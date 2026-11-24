import type { BookingRecord, CallRecord, ToolEvent } from "./models.js";

/**
 * Otto's path through a call: the checkpoints every service call walks, each checked off from what the
 * server actually recorded (tool events and the call record), never from what the model says it did.
 * The owner watches it tick live on the call page and reads it afterwards to see what was skipped.
 */
export type CallPathStepKey = "greeting" | "service_check" | "problem" | "safety" | "caller" | "address" | "times" | "booking" | "wrap_up";
export type CallPathExtraKey = "price_question" | "owner_request";
export type CallPathState = "done" | "current" | "todo" | "skipped" | "flagged";

export interface CallPathStep<K extends string = CallPathStepKey> {
  key: K;
  label: string;
  state: CallPathState;
  at: string | null;
  note: string | null;
}

export interface CallPath {
  steps: CallPathStep[];
  /** Can happen at any point in the call, like a pricing question. */
  extras: Array<CallPathStep<CallPathExtraKey>>;
  live: boolean;
  done: number;
}

export const CALL_PATH_LABELS: Readonly<Record<CallPathStepKey, string>> = {
  greeting: "Greeting",
  service_check: "Service check",
  problem: "The problem",
  safety: "Safety check",
  caller: "Name & number",
  address: "Address & area",
  times: "Open times",
  booking: "Booking",
  wrap_up: "Recap & owner text",
};

/** Tool events that mean a real customer is on the line (any of these passes the service check). */
const CUSTOMER_TOOLS = new Set(["call.intake", "call.triage", "call.handoff", "coverage.check", "calendar.availability", "calendar.book", "answer.lookup"]);

/** Calls are cut at seven minutes; one that never reported its end stops showing as live after this. */
export const CALL_PATH_LIVE_WINDOW_MS = 15 * 60_000;

export function buildCallPath(input: { call: CallRecord; events: ToolEvent[]; booking: BookingRecord | null; now: Date }): CallPath {
  const { call, booking } = input;
  const events = [...input.events].sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt));
  const first = (match: (event: ToolEvent) => boolean): ToolEvent | undefined => events.find(match);
  const ok = (event: ToolEvent): boolean => event.result === "success";
  const meta = (event: ToolEvent, key: string): unknown => event.metadata[key];
  // Not the outcome: a request for the owner changes it mid-call. Only the call's end does.
  const live = call.endedAt === null && input.now.getTime() - Date.parse(call.startedAt) < CALL_PATH_LIVE_WINDOW_MS;
  const spam = call.billingDisposition === "spam_excluded" || call.outcome === "ignored_spam";
  type Partial = { state: "done" | "flagged" | "skipped"; at: string | null; note: string | null } | null;
  const found: Partial[] = [];

  // 1. Greeting: the line answered.
  found.push({ state: "done", at: call.startedAt, note: null });

  // 2. Service check: a vendor, robocall or wrong number ends the path here.
  const spamEvent = first((event) => event.tool === "call.mark_spam" && ok(event));
  const customer = first((event) => CUSTOMER_TOOLS.has(event.tool) && ok(event));
  found.push(spam
    ? { state: "flagged", at: spamEvent?.completedAt ?? null, note: "Not a service call, so Otto ended it" }
    : customer ? { state: "done", at: customer.completedAt, note: null } : null);

  // 3. The problem.
  const problem = first((event) => (event.tool === "call.intake" && meta(event, "problem") === true) || event.tool === "call.triage");
  found.push(problem ? { state: "done", at: problem.completedAt, note: null } : call.fields.problemDescription.trim() ? { state: "done", at: null, note: null } : null);

  // 4. Safety check: deterministic triage, emergencies flagged.
  const triage = first((event) => event.tool === "call.triage");
  const emergency = call.emergency?.emergency === true;
  const severity = call.emergency?.severity ?? (triage ? String(meta(triage, "severity") ?? "routine") : null);
  found.push(emergency
    ? { state: "flagged", at: first((event) => event.tool === "call.handoff" && meta(event, "reason") === "emergency")?.completedAt ?? triage?.completedAt ?? null, note: severity === "life_safety" ? "Emergency: told to get safe, you were alerted" : "Urgent: you were alerted" }
    : triage ? { state: "done", at: triage.completedAt, note: "No emergency" } : null);

  // 5. Name and callback number.
  const caller = first((event) => event.tool === "call.intake" && meta(event, "name") === true && meta(event, "callback") === true);
  found.push(caller ? { state: "done", at: caller.completedAt, note: null } : null);

  // 6. Address, checked against the service area.
  const coverage = first((event) => event.tool === "coverage.check" && ok(event));
  const addressTaken = first((event) => event.tool === "call.intake" && meta(event, "address") === true);
  found.push(coverage
    ? { state: "done", at: coverage.completedAt, note: meta(coverage, "status") === "covered" ? "In your area" : "You confirm the area" }
    : addressTaken ? { state: "done", at: addressTaken.completedAt, note: "Address taken" } : null);

  // 7. Open times from the calendar.
  const times = first((event) => event.tool === "calendar.availability" && ok(event));
  const offered = times ? Number(meta(times, "count") ?? 0) : 0;
  found.push(times ? { state: "done", at: times.completedAt, note: offered > 0 ? `Offered ${offered} time${offered === 1 ? "" : "s"}` : "No open times" } : null);

  // 8. Booking: confirmed on the calendar, or waiting on the owner.
  const book = first((event) => event.tool === "calendar.book");
  const handedOff = call.outcome === "handoff_queued" || call.fields.humanRequested;
  found.push(booking?.status === "confirmed"
    ? { state: "done", at: booking.writeVerifiedAt ?? book?.completedAt ?? booking.updatedAt, note: "Booked on your calendar" }
    : booking ? { state: "done", at: book?.completedAt ?? booking.createdAt, note: "Waiting on your OK" }
      : !live && handedOff ? { state: "skipped", at: null, note: "You're calling them back" } : null);

  // 9. Recap and the owner's text.
  found.push(call.endedAt === null ? null : spam ? { state: "skipped", at: null, note: null } : { state: "done", at: call.endedAt, note: wrapUpNote(call.outcome) });

  const keys = Object.keys(CALL_PATH_LABELS) as CallPathStepKey[];
  // While the call is live, the first open checkpoint is where Otto is now.
  const currentIndex = live ? found.findIndex((item) => item === null) : -1;
  const steps: CallPathStep[] = keys.map((key, index) => {
    const item = found[index] ?? null;
    if (item) return { key, label: CALL_PATH_LABELS[key], ...item };
    const state: CallPathState = index === currentIndex ? "current" : live ? "todo" : "skipped";
    return { key, label: CALL_PATH_LABELS[key], state, at: null, note: null };
  });

  const price = first((event) => event.tool === "answer.lookup" && meta(event, "kind") === "price");
  const ownerAsk = first((event) => event.tool === "call.handoff" && meta(event, "reason") === "explicit_request");
  const extras: Array<CallPathStep<CallPathExtraKey>> = [
    { key: "price_question", label: "Price question", state: price ? "done" : live ? "todo" : "skipped", at: price?.completedAt ?? null, note: price ? (meta(price, "approved") === true ? "Gave your approved price" : "No approved price, took a message") : null },
    { key: "owner_request", label: "Asked for you", state: ownerAsk ? "done" : live ? "todo" : "skipped", at: ownerAsk?.completedAt ?? null, note: ownerAsk ? "You were alerted to call back" : null },
  ];
  return { steps, extras, live, done: steps.filter((step) => step.state === "done" || step.state === "flagged").length };
}

function wrapUpNote(outcome: CallRecord["outcome"]): string {
  if (outcome === "booked") return "Recap given, you got the summary";
  if (outcome === "pending_confirmation") return "Recap given, waiting on your OK";
  if (outcome === "handoff_queued") return "You got the summary to call back";
  if (outcome === "failed") return "Call dropped, you got what was captured";
  return "You got the summary";
}
