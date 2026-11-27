import type { BookingRecord, CallbackTask, CallRecord, OutboxNotification, ToolEvent } from "./models.js";

/**
 * Otto's path through a call: the checkpoints every service call walks, each checked off from what the
 * server actually recorded (tool events, the booking, the callback task and the owner's alerts), never from
 * what the model says it did. The owner watches it tick live on the call page and reads it afterwards to
 * see what was skipped.
 */
export type CallPathStepKey = "greeting" | "service_check" | "problem" | "safety" | "caller" | "address" | "times" | "booking" | "wrap_up";
export type CallPathExtraKey = "price_question" | "owner_request";
/** waiting: reached, but the owner still has to act (a booking to OK). flagged: reached, needs attention. */
/** partial: Otto got some of the step (a name but no number), so it is neither done nor untouched. */
export type CallPathState = "done" | "waiting" | "flagged" | "partial" | "current" | "todo" | "skipped";

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
  /** Still being watched: the call is up, or it just ended and the record is settling. */
  live: boolean;
  /** The call is over (hung up, or the provider says so), even while the record settles. Never shown as live. */
  ended: boolean;
  /** Checkpoints reached (done, waiting or flagged). */
  done: number;
  startedAt: string;
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
/**
 * After hang-up the server is still writing the outcome, the callback task and the owner's alerts (separate
 * writes, no transaction). The path stays live this long so the page settles on the finished record.
 */
export const CALL_PATH_SETTLE_MS = 20_000;
/** A booking still being written keeps it live a little longer, never indefinitely. */
export const CALL_PATH_BOOKING_SETTLE_MS = 120_000;

/** What actually happened to the owner's alerts of one kind: never claim a text that wasn't sent. */
export type AlertStatus = "sent" | "sending" | "failed" | "not_sent" | "none";

function reachedOwner(item: OutboxNotification): boolean {
  if (item.state !== "sent" && item.state !== "delivered" && item.state !== "delivery_unconfirmed") return false;
  // A push to zero devices "sends" but reaches nobody.
  return !(item.channel === "push" && /:(?:0|none)$/.test(item.providerReceipt ?? ""));
}

export function ownerAlertStatus(notifications: OutboxNotification[], prefixes: readonly string[]): AlertStatus {
  const mine = notifications.filter((item) => prefixes.some((prefix) => item.idempotencyKey.startsWith(`${prefix}:`)));
  if (mine.length === 0) return "none";
  if (mine.some(reachedOwner)) return "sent";
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
  callbackTask?: CallbackTask | null;
  notifications: OutboxNotification[];
  now: Date;
  /** Steps the shop switched off ("What Otto does on a call"): left out unless this call recorded something for them. */
  off?: readonly CallPathStepKey[];
}): CallPath | null {
  const { call, booking } = input;
  // Calls from before checkpoints were recorded have no path: showing every step skipped would be untrue.
  if (!input.events.some((event) => event.tool === "call.start")) return null;
  const events = [...input.events].sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt));
  const first = (match: (event: ToolEvent) => boolean): ToolEvent | undefined => events.find(match);
  const last = (match: (event: ToolEvent) => boolean): ToolEvent | undefined => [...events].reverse().find(match);
  const ok = (event: ToolEvent): boolean => event.result === "success";
  const meta = (event: ToolEvent, key: string): unknown => event.metadata[key];
  const intake = (key: string): ToolEvent | undefined => first((event) => event.tool === "call.intake" && meta(event, key) === true);
  const withinWindow = input.now.getTime() - Date.parse(call.startedAt) < CALL_PATH_LIVE_WINDOW_MS;
  // Not the outcome (a request for the owner changes it mid-call): the call's end, plus a short settle so the
  // page never freezes on a half-written finish.
  const sinceEnd = call.endedAt === null ? 0 : input.now.getTime() - Date.parse(call.endedAt);
  // The provider said the call is over before its final payload arrived (call recovery): `ended` keeps it from
  // looking live, while `live` keeps the page polling until the record (transcript, callback task) lands.
  const providerEnded = events.some((event) => event.tool === "call.end");
  const live = withinWindow && (call.endedAt === null || sinceEnd < CALL_PATH_SETTLE_MS || (booking?.status === "checking" && sinceEnd < CALL_PATH_BOOKING_SETTLE_MS));
  // What the call record holds counts too: the end-of-call payload fills in details whose tool write failed or
  // never ran mid-call, and a step the record proves is never shown as skipped. No time: nothing stamped it.
  const hasProblem = problemCaptured(call);
  const hasName = Boolean(call.fields.callerName?.trim());
  const hasNumber = reachableNumber(call) !== null;
  const hasAddress = Boolean(call.fields.address?.trim());
  const spam = call.billingDisposition === "spam_excluded" || call.outcome === "ignored_spam";
  const emergency = call.emergency?.emergency === true;
  const handedOff = call.outcome === "handoff_queued" || call.fields.humanRequested || emergency;
  const taskHandled = input.callbackTask?.status === "completed";
  const liveAlert = ownerAlertStatus(input.notifications, LIVE_ALERT_KEYS);
  const summary = ownerAlertStatus(input.notifications, SUMMARY_ALERT_KEYS);
  type Found = { state: "done" | "waiting" | "flagged" | "partial" | "skipped"; at: string | null; note: string | null } | null;
  const found: Found[] = [];

  // 1. Greeting: the line answered.
  found.push({ state: "done", at: call.startedAt, note: null });

  // 2. Service check: a vendor, robocall or wrong number ends the path here.
  const spamEvent = first((event) => event.tool === "call.mark_spam" && ok(event));
  const customer = first((event) => CUSTOMER_TOOLS.has(event.tool) && ok(event));
  // Once the call is over, a caller whose problem, name or address is on the record was a customer.
  const customerOnRecord = !live && (hasProblem || hasName || hasAddress);
  found.push(spam
    ? { state: "flagged", at: spamEvent?.completedAt ?? null, note: "Not a service call, so Otto ended it" }
    : customer ? { state: "done", at: customer.completedAt, note: null }
      : customerOnRecord ? { state: "done", at: null, note: null } : null);

  // 3. The problem, once it is on the record (saved mid-call, or from the end-of-call payload).
  const problem = first((event) => (event.tool === "call.intake" && meta(event, "problem") === true) || event.tool === "call.triage");
  found.push(problem ? { state: "done", at: problem.completedAt, note: null }
    : !live && hasProblem ? { state: "done", at: null, note: null } : null);

  // 4. Safety check: the server's triage rules run on every intake, on triage_call and when the call ends; emergencies flagged.
  const triage = first((event) => event.tool === "call.triage") ?? (call.emergency ? intake("problem") : undefined);
  // The end-of-call triage ran on the captured problem: it counts when there was one to check.
  const checkedAtEnd = !live && call.emergency !== null && hasProblem;
  const caughtLive = first((event) => (event.tool === "call.triage" && meta(event, "emergency") === true) || (event.tool === "call.handoff" && meta(event, "reason") === "emergency"));
  if (emergency) {
    const kind = call.emergency?.severity === "life_safety" ? "Emergency" : "Urgent";
    const alert = liveAlert === "none" ? summary : liveAlert;
    found.push(caughtLive
      ? { state: "flagged", at: caughtLive.completedAt, note: `${kind}, ${alertWords(alert, "alert")}` }
      : { state: "flagged", at: call.endedAt, note: `${kind} found after the call, ${alertWords(alert, "alert")}` });
  } else {
    found.push(triage ? { state: "done", at: triage.completedAt, note: "No emergency" }
      : checkedAtEnd ? { state: "done", at: null, note: "No emergency" } : null);
  }

  // 5. Name and callback number (the caller ID counts once the caller says it's the best number, and once the
  // call is over: it is the number on the record).
  const caller = first((event) => event.tool === "call.intake" && meta(event, "name") === true && meta(event, "callback") === true);
  const named = intake("name") !== undefined || hasName;
  const numbered = intake("callback") !== undefined || hasNumber;
  found.push(caller ? { state: "done", at: caller.completedAt, note: null }
    : live ? null
      : named && numbered ? { state: "done", at: null, note: null }
        : named || numbered ? { state: "partial", at: null, note: named ? "Got the name, no callback number" : "Got the number, no name" } : null);

  // 6. Address, checked against the service area. The note follows the latest check (a corrected address).
  const coverage = (event: ToolEvent): boolean => event.tool === "coverage.check" && ok(event) && meta(event, "status") !== "incomplete";
  const firstCoverage = first(coverage);
  const lastCoverage = last(coverage);
  const addressTaken = intake("address");
  // Once the call is over, an area check with no address on the record is not a captured address.
  const areaOnly = !live && call.endedAt !== null && !hasAddress && !addressTaken;
  found.push(firstCoverage && lastCoverage && areaOnly
    ? { state: "skipped", at: null, note: "Area checked, no address saved" }
    : firstCoverage && lastCoverage
    ? { state: "done", at: firstCoverage.completedAt, note: coverageWords(meta(lastCoverage, "status")) }
    : addressTaken ? { state: "done", at: addressTaken.completedAt, note: "Address taken" }
      : !live && hasAddress ? { state: "done", at: null, note: "Address taken" } : null);

  // 7 and 8. Open times and the booking, unless the call went to the owner instead.
  const availability = (event: ToolEvent): boolean => event.tool === "calendar.availability" && ok(event);
  const firstTimes = first(availability);
  const lastTimes = last(availability);
  const offered = lastTimes ? Number(meta(lastTimes, "count") ?? 0) : 0;
  const book = first((event) => event.tool === "calendar.book");
  found.push(firstTimes ? { state: "done", at: firstTimes.completedAt, note: offered > 0 ? `Offered ${offered} time${offered === 1 ? "" : "s"}` : "No open times" }
    : handedOff && !booking ? { state: "skipped", at: null, note: null } : null);
  const bookedAt = book?.completedAt ?? booking?.createdAt ?? null;
  found.push(booking?.status === "confirmed" ? { state: "done", at: booking.writeVerifiedAt ?? bookedAt, note: "Booked on your calendar" }
    : booking?.status === "pending" ? (taskHandled ? { state: "done", at: bookedAt, note: "You handled it" } : { state: "waiting", at: bookedAt, note: "Waiting on your OK" })
      : booking?.status === "unknown" || (booking?.status === "checking" && !live) ? { state: "flagged", at: bookedAt, note: "May be on your calendar, check it" }
        : booking?.status === "conflict" ? { state: "flagged", at: bookedAt, note: "That time was taken, you pick one" }
          : handedOff && !booking ? { state: "skipped", at: null, note: taskHandled ? "You handled it" : "You're calling them back" } : null);

  // 9. Recap and the owner's summary: a recap only when Otto captured something, a text only once it was sent.
  const recovered = call.qualityFlags.includes("call_ended_without_final_provider_payload");
  const captured = events.some((event) => event.tool === "call.intake") || hasProblem || hasName || hasAddress;
  found.push(call.endedAt === null || live ? null
    : recovered ? { state: "flagged", at: call.endedAt, note: `Call dropped, ${summaryWords(summary)}` }
      : !captured ? { state: "skipped", at: null, note: summary === "none" ? null : `Nothing to recap, ${summaryWords(summary)}` }
        : { state: summary === "failed" ? "flagged" : "done", at: call.endedAt, note: `${recapLead(call, booking, taskHandled)}, ${summaryWords(summary)}` });

  const keys = Object.keys(CALL_PATH_LABELS) as CallPathStepKey[];
  // While the call is live, the first open checkpoint is where Otto is now.
  const ended = call.endedAt !== null || providerEnded;
  // A step the shop switched off is not part of its call: it shows only when this call recorded it anyway (a spam
  // mark, an address, a booking from before the switch). The service check then shows only a call Otto ended.
  const hidden = (index: number): boolean => Boolean(input.off?.includes(keys[index]!))
    && (keys[index] === "service_check" ? found[index]?.state !== "flagged" : !found[index] || found[index]!.state === "skipped");
  const currentIndex = live && !ended && !spam ? found.findIndex((item, index) => item === null && !hidden(index)) : -1;
  const steps: CallPathStep[] = keys.flatMap((key, index): CallPathStep[] => {
    if (hidden(index)) return [];
    // A spam call ends at the service check: nothing after it happened.
    const item = spam && index > 1 ? null : found[index] ?? null;
    if (item) return [{ key, label: CALL_PATH_LABELS[key], ...item }];
    const state: CallPathState = spam && index > 1 ? "skipped" : index === currentIndex ? "current" : live ? "todo" : "skipped";
    return [{ key, label: CALL_PATH_LABELS[key], state, at: null, note: null }];
  });

  const price = first((event) => event.tool === "answer.lookup" && meta(event, "kind") === "price");
  const ownerAsk = first((event) => event.tool === "call.handoff" && meta(event, "reason") === "explicit_request");
  const extras: Array<CallPathStep<CallPathExtraKey>> = [];
  if (price) extras.push({ key: "price_question", label: "Price question", state: "done", at: price.completedAt, note: meta(price, "approved") === true ? "Gave your approved price" : "No approved price, took a message" });
  if (ownerAsk) extras.push({ key: "owner_request", label: "Asked for you", state: liveAlert === "failed" ? "flagged" : "done", at: ownerAsk.completedAt, note: alertWords(liveAlert, "callback alert") });
  return { steps, extras, live, ended, done: steps.filter((step) => step.state === "done" || step.state === "waiting" || step.state === "flagged" || step.state === "partial").length, startedAt: call.startedAt };
}

/**
 * A problem Otto captured. When none was saved, the end-of-call payload fills the field with everything the
 * caller said: that is the transcript (a "Hello?" on a hang-up), not a captured problem.
 */
function problemCaptured(call: Pick<CallRecord, "fields" | "transcript">): boolean {
  const squash = (value: string): string => value.replace(/\s+/g, " ").trim();
  const problem = squash(call.fields.problemDescription);
  if (!problem) return false;
  const transcript = call.transcript ?? "";
  let callerTurn = false;
  const said: string[] = [];
  for (const line of transcript.split("\n")) {
    const speaker = /^(Caller|Otto|AI assistant):/.exec(line);
    if (speaker) callerTurn = speaker[1] === "Caller";
    if (callerTurn) said.push(speaker ? line.slice(speaker[0].length) : line);
  }
  return problem !== squash(said.join(" ")) && problem !== squash(transcript);
}

function coverageWords(status: unknown): string {
  if (status === "covered") return "In your area";
  if (status === "outside") return "Outside your area, your call";
  return "You confirm the area";
}

function alertWords(status: AlertStatus, what: string): string {
  if (status === "sent") return what === "alert" ? "you were alerted" : `${what} sent`;
  if (status === "sending") return `${what} sending`;
  if (status === "failed") return `${what} didn't go through`;
  return "no alert went out";
}

function summaryWords(status: AlertStatus): string {
  if (status === "sent") return "summary sent";
  if (status === "sending") return "summary sending";
  if (status === "failed") return "summary didn't go through";
  return "summary is here";
}

function recapLead(call: CallRecord, booking: BookingRecord | null, taskHandled: boolean): string {
  if (booking?.status === "confirmed") return "Booked";
  if (booking?.status === "pending") return taskHandled ? "Handled" : "Waiting on your OK";
  if (booking?.status === "unknown" || booking?.status === "conflict" || booking?.status === "checking") return "Check the booking";
  if (call.outcome === "handoff_queued") return taskHandled ? "Handled" : "Call them back";
  if (call.outcome === "pending_confirmation") return taskHandled ? "Handled" : "Needs your OK";
  if (call.outcome === "failed") return "Call dropped";
  return "Done";
}

/**
 * The number to reach the caller on: the callback number when it is a real number, else the number that called.
 * An old record's callback number written in words ("same number") never hides the caller ID.
 */
export function reachableNumber(call: { fields: { callbackNumber: string | null }; fromNumber: string }): string | null {
  return [call.fields.callbackNumber, call.fromNumber].find((value) => value && /^\+[1-9]\d{7,14}$/.test(value)) ?? null;
}
