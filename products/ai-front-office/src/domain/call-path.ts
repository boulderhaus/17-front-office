import type { BookingRecord, CallRecord, OutboxNotification, ToolEvent } from "./models.js";

/**
 * Otto's path through a call: the checkpoints every service call walks, each checked off from what the
 * server actually recorded (tool events, the call record, the booking and the owner's alerts), never from
 * what the model says it did. The owner watches it tick live on the call page and reads it afterwards to
 * see what was skipped.
 */
export type CallPathStepKey = "greeting" | "service_check" | "problem" | "safety" | "caller" | "address" | "times" | "booking" | "wrap_up";
export type CallPathExtraKey = "price_question" | "owner_request";
/** waiting: reached, but the owner still has to act (a booking to OK). flagged: reached, needs attention. */
export type CallPathState = "done" | "waiting" | "flagged" | "current" | "todo" | "skipped";

export interface CallPathStep<K extends string = CallPathStepKey> {
  key: K;
  label: string;
  state: CallPathState;
  at: string | null;
  note: string | null;
}

export interface CallPath {
  steps: CallPathStep[];
  /** Things that can come up at any point in a call, listed only once they did. */
  extras: Array<CallPathStep<CallPathExtraKey>>;
  live: boolean;
  /** Checkpoints reached (done, waiting or flagged). */
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

const E164 = /^\+[1-9]\d{7,14}$/;

/** What actually happened to the owner's alerts of one kind: never claim a text that wasn't sent. */
export type AlertStatus = "sent" | "sending" | "failed" | "not_sent" | "none";

export function ownerAlertStatus(notifications: OutboxNotification[], prefixes: readonly string[]): AlertStatus {
  const mine = notifications.filter((item) => prefixes.some((prefix) => item.idempotencyKey.startsWith(`${prefix}:`)));
  if (mine.length === 0) return "none";
  if (mine.some((item) => item.state === "sent" || item.state === "delivered" || item.state === "delivery_unconfirmed")) return "sent";
  if (mine.some((item) => item.state === "pending" || item.state === "sending" || item.state === "retry")) return "sending";
  if (mine.some((item) => item.state === "delivery_failed" || item.state === "dead")) return "failed";
  return "not_sent";
}

/** Owner alerts raised during the call (an emergency or a request for the owner). */
export const LIVE_ALERT_KEYS = ["human-handoff", "urgent-owner-call"] as const;
/** The owner's after-call summary. */
export const SUMMARY_ALERT_KEYS = ["call-summary", "recovery-summary"] as const;

export function buildCallPath(input: {
  call: CallRecord;
  events: ToolEvent[];
  booking: BookingRecord | null;
  notifications: OutboxNotification[];
  now: Date;
}): CallPath {
  const { call, booking } = input;
  const events = [...input.events].sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt));
  const first = (match: (event: ToolEvent) => boolean): ToolEvent | undefined => events.find(match);
  const ok = (event: ToolEvent): boolean => event.result === "success";
  const meta = (event: ToolEvent, key: string): unknown => event.metadata[key];
  const intake = (key: string): ToolEvent | undefined => first((event) => event.tool === "call.intake" && meta(event, key) === true);
  // Not the outcome: a request for the owner changes it mid-call. Only the call's end does.
  const live = call.endedAt === null && input.now.getTime() - Date.parse(call.startedAt) < CALL_PATH_LIVE_WINDOW_MS;
  const spam = call.billingDisposition === "spam_excluded" || call.outcome === "ignored_spam";
  const emergency = call.emergency?.emergency === true;
  const handedOff = call.outcome === "handoff_queued" || call.fields.humanRequested || emergency;
  const liveAlert = ownerAlertStatus(input.notifications, LIVE_ALERT_KEYS);
  type Found = { state: "done" | "waiting" | "flagged" | "skipped"; at: string | null; note: string | null } | null;
  const found: Found[] = [];

  // 1. Greeting: the line answered.
  found.push({ state: "done", at: call.startedAt, note: null });

  // 2. Service check: a vendor, robocall or wrong number ends the path here.
  const spamEvent = first((event) => event.tool === "call.mark_spam" && ok(event));
  const customer = first((event) => CUSTOMER_TOOLS.has(event.tool) && ok(event));
  found.push(spam
    ? { state: "flagged", at: spamEvent?.completedAt ?? null, note: "Not a service call, so Otto ended it" }
    : customer ? { state: "done", at: customer.completedAt, note: null }
      : call.fields.problemDescription.trim() ? { state: "done", at: null, note: null } : null);

  // 3. The problem.
  const problem = first((event) => (event.tool === "call.intake" && meta(event, "problem") === true) || event.tool === "call.triage");
  found.push(problem ? { state: "done", at: problem.completedAt, note: null } : call.fields.problemDescription.trim() ? { state: "done", at: null, note: null } : null);

  // 4. Safety check: the server's triage rules run on every intake and on triage_call; emergencies flagged.
  const triage = first((event) => event.tool === "call.triage") ?? (call.emergency ? intake("problem") : undefined);
  const emergencyAt = first((event) => event.tool === "call.handoff" && meta(event, "reason") === "emergency")?.completedAt ?? triage?.completedAt ?? null;
  found.push(emergency
    ? { state: "flagged", at: emergencyAt, note: `${call.emergency?.severity === "life_safety" ? "Emergency: told to get safe" : "Urgent"}, ${alertWords(liveAlert, "alert")}` }
    : triage ? { state: "done", at: triage.completedAt, note: "No emergency" } : null);

  // 5. Name and callback number (the caller ID counts once the caller says it's the best number).
  const caller = first((event) => event.tool === "call.intake" && meta(event, "name") === true && meta(event, "callback") === true);
  const hasName = Boolean(call.fields.callerName?.trim());
  const hasNumber = E164.test(call.fields.callbackNumber ?? call.fromNumber);
  found.push(caller ? { state: "done", at: caller.completedAt, note: null }
    : hasName && hasNumber ? { state: "done", at: null, note: null }
      : live ? null
        : hasName || hasNumber ? { state: "skipped", at: null, note: hasName ? "Got the name, no callback number" : "Got the number, no name" } : null);

  // 6. Address, checked against the service area.
  const coverage = first((event) => event.tool === "coverage.check" && ok(event));
  const addressTaken = intake("address");
  found.push(coverage
    ? { state: "done", at: coverage.completedAt, note: meta(coverage, "status") === "covered" ? "In your area" : "You confirm the area" }
    : addressTaken ? { state: "done", at: addressTaken.completedAt, note: "Address taken" }
      : call.fields.address?.trim() ? { state: "done", at: null, note: "Address taken" } : null);

  // 7 and 8. Open times and the booking, unless the call went to the owner instead.
  const times = first((event) => event.tool === "calendar.availability" && ok(event));
  const offered = times ? Number(meta(times, "count") ?? 0) : 0;
  const book = first((event) => event.tool === "calendar.book");
  const toOwner = handedOff && !booking && !times;
  found.push(times ? { state: "done", at: times.completedAt, note: offered > 0 ? `Offered ${offered} time${offered === 1 ? "" : "s"}` : "No open times" }
    : toOwner ? { state: "skipped", at: null, note: null } : null);
  found.push(booking?.status === "confirmed"
    ? { state: "done", at: booking.writeVerifiedAt ?? book?.completedAt ?? booking.updatedAt, note: "Booked on your calendar" }
    : booking?.status === "pending" ? { state: "waiting", at: book?.completedAt ?? booking.createdAt, note: "Waiting on your OK" }
      : booking && booking.status !== "checking" ? { state: "flagged", at: book?.completedAt ?? booking.updatedAt, note: "Couldn't book it, you confirm the time" }
        : handedOff && !booking ? { state: "skipped", at: null, note: "You're calling them back" } : null);

  // 9. Recap and the owner's summary, only claimed once it was sent.
  found.push(call.endedAt === null ? null
    : spam ? { state: "skipped", at: null, note: null }
      : wrapUp(call, ownerAlertStatus(input.notifications, SUMMARY_ALERT_KEYS)));

  const keys = Object.keys(CALL_PATH_LABELS) as CallPathStepKey[];
  // A spam call ends at the service check: nothing after it is pending.
  const stopAfter = spam ? 1 : keys.length;
  // While the call is live, the first open checkpoint is where Otto is now.
  const currentIndex = live && !spam ? found.findIndex((item) => item === null) : -1;
  const steps: CallPathStep[] = keys.map((key, index) => {
    const item = found[index] ?? null;
    if (item) return { key, label: CALL_PATH_LABELS[key], ...item };
    const state: CallPathState = index > stopAfter ? "skipped" : index === currentIndex ? "current" : live ? "todo" : "skipped";
    return { key, label: CALL_PATH_LABELS[key], state, at: null, note: null };
  });

  const price = first((event) => event.tool === "answer.lookup" && meta(event, "kind") === "price");
  const ownerAsk = first((event) => event.tool === "call.handoff" && meta(event, "reason") === "explicit_request");
  const extras: Array<CallPathStep<CallPathExtraKey>> = [];
  if (price) extras.push({ key: "price_question", label: "Price question", state: "done", at: price.completedAt, note: meta(price, "approved") === true ? "Gave your approved price" : "No approved price, took a message" });
  if (ownerAsk) extras.push({ key: "owner_request", label: "Asked for you", state: liveAlert === "failed" ? "flagged" : "done", at: ownerAsk.completedAt, note: alertWords(liveAlert, "callback alert") });
  return { steps, extras, live, done: steps.filter((step) => step.state === "done" || step.state === "waiting" || step.state === "flagged").length };
}

function alertWords(status: AlertStatus, what: string): string {
  if (status === "sent") return what === "alert" ? "you were alerted" : `${what} sent`;
  if (status === "sending") return `${what} sending`;
  if (status === "failed") return `${what} didn't go through`;
  return "no alert went out";
}

function wrapUp(call: CallRecord, summary: AlertStatus): { state: "done" | "flagged"; at: string | null; note: string } {
  const lead = call.outcome === "booked" ? "Booked" : call.outcome === "pending_confirmation" ? "Waiting on your OK" : call.outcome === "handoff_queued" ? "Call them back" : call.outcome === "failed" ? "Call dropped" : "Done";
  if (summary === "failed") return { state: "flagged", at: call.endedAt, note: `${lead}. Your summary didn't go through` };
  const tail = summary === "sent" ? "summary sent" : summary === "sending" ? "summary sending" : "summary is here";
  return { state: "done", at: call.endedAt, note: `${lead}, ${tail}` };
}
