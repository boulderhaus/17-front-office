import type { CallPath } from "../domain/call-path.js";
import { ownerTaskReason } from "../domain/task-reason.js";
import { forwardingInstructions } from "../adapters/telnyx-provisioning.js";
import { CARRIER_CHOICES, everyCallProven, forwardingChoice, forwardingPlan, mayForwardAll, NOT_FORWARDING_AFTER_MS, ringFirstSeconds, type CarrierInfo, type ForwardingChoice, type ForwardingMode, type ForwardingPlan, type TestedFor } from "../domain/forwarding.js";
import { hasPlanAccess } from "../domain/billing.js";
import { describeHours } from "../domain/hours.js";
import { formatDaysOff, localDate, upcomingDaysOff, type DayOff } from "../domain/days-off.js";
import { fairUseCalls, type PlanId, type PriceQuote } from "../domain/plans.js";
import { extraCalls } from "../domain/usage.js";
import { COMPANY } from "../admin/footer.js";
import type { GuaranteeStatus } from "../application/billing-jobs.js";
import type { BookingRecord, BusinessConfig, CallbackTask, CallRecord, OutboxNotification, OwnerAccount, SubscriptionRecord, UsageSummary } from "../domain/models.js";

/** What the owner app may see about a call. No tenant ids, provider ids or internal flags. */
export interface ApiCall {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  outcome: CallRecord["outcome"];
  phone: string | null;
  fields: {
    callerName: string | null;
    problemDescription: string;
    address: string | null;
    serviceCategory: string | null;
    equipmentDetails: string | null;
    accessNotes: string | null;
    requestedStart: string | null;
  };
  emergency: { emergency: boolean; severity: "routine" | "urgent" | "life_safety"; immediateInstruction: string | null } | null;
  transcript: string | null;
}

export interface ApiTask {
  callId: string;
  reason: string;
  priority: CallbackTask["priority"];
  status: CallbackTask["status"];
  dueAt: string;
  completedAt: string | null;
  completionSource: CallbackTask["completionSource"];
  updatedAt: string;
}

export interface ApiDashboard {
  /** The shop's Call Otto number and the carrier codes that forward the owner's business line to it. */
  line: {
    number: string | null;
    mode: BusinessConfig["operationMode"];
    forwarding: Array<{ carrier: string; on: string; off: string }>;
    /** The owner's own business number and how to forward it. */
    business: {
      number: string | null; carrier: CarrierInfo | null; plan: ForwardingPlan | null; choices: typeof CARRIER_CHOICES; suggested: string | null;
      /**
       * Today's choice or code (every call, ring first, ring time) differs from what the last passed test was set up
       * for (or may be set up for: every call was picked when they left it, untested): dial plan.on once to apply it,
       * after clearFirst (the code that turns every call off) when leaving every call for ring first. leavingEveryCall without a code: an
       * office line turns off "forward all calls" in the website first. Stays until a test passes for the new choice.
       */
      update: { clearFirst: string | null; leavingEveryCall: boolean } | null;
      /** Forwarding works, and the last passed test was for every call. */
      everyCallOn: boolean;
      /** Our own timed test proved every call on: leaving it for ring first clears it first (see everyCallProven). */
      everyCallProven: boolean;
      /** Forwarding works, and the last passed test was for today's choice and code, so its ring time is what they get. */
      codeApplied: boolean;
      /**
       * Every call is picked, or the last passed test was for every call: calls to the business number may all go to
       * Otto. Otto never dials that number then, and pausing would leave those calls nowhere to go.
       */
      mayForwardAll: boolean;
      /** How long "Ring my phone first" would ring for this carrier (GSM timer, Verizon ~30 s), or null when unknown. */
      ringFirstSeconds: number | null;
      /** The last test that proved today's choice: when, and for ring first how long the phone rang first. */
      lastTest: { mode: ForwardingChoice; at: string; rangSeconds: number | null; timed: boolean } | null;
    };
    /** When a call last proved forwarding works. */
    confirmedAt: string | null;
    check: {
      status: ForwardingCheckStatus;
      method: "auto" | "manual" | null;
      startedAt: string | null;
      /** Seconds from dialing until something picked our test call up (a phone, a screener, a voicemail). */
      answeredAfterSec: number | null;
      /** The number our test call comes from, so the owner knows which call to let ring. */
      callerId: string | null;
      /** We tried to call the business phone and couldn't, so this test waits for a call from another phone. */
      autoFailed: boolean;
      /** What the owner was set up for when this test started: a result for another choice or code is stale. */
      choice: ForwardingChoice | null;
      code: string | null;
      /** Our check call reached Otto this many seconds after we placed it (timed tests only). */
      forwardedAfterSec: number | null;
    };
    helpRequestedAt: string | null;
    /** "Set it up with me" reaches our team by email (SUPPORT_EMAIL): only then may the app promise a reply. */
    helpTeam: boolean;
    /** Where an owner writes when "Set it up with me" reached no one: the company email published in the footer. */
    helpEmail: string;
    /** Otto's AI setup helper's last call to the owner: where, when, picked up, ended (null while it's still up), how. */
    helpCall: { to: string; startedAt: string; answeredAt: string | null; endedAt: string | null; outcome: "done" | "missed" | "voicemail" | "looped" | "failed" | null; booked: boolean } | null;
    /** "Book a time": the signed /book-setup link for this shop, when booking is set up. */
    helpBookUrl: string | null;
    /** Brock's follow-up email in the last 24 hours, and whether it has a booking link (no calendar connected: it asks for a reply). */
    founderEmail: { sentAt: string; link: boolean } | null;
  };
  csrf: string;
  now: string;
  preview: boolean;
  viewer: { role: "owner" | "member"; status: OwnerAccount["status"] };
  shop: {
    businessName: string;
    timezone: string;
    paused: boolean;
    pausedForBilling: boolean;
    /** The owner said yes to text alerts (consent on file) and texts go to their mobile. */
    alertsOn: boolean;
    /** Texts can be sent at all (carrier approval is recorded). Until then every text switch waits. */
    textsLive: boolean;
    rulesSaved: boolean;
    greeting: string;
    hours: string;
    /** Upcoming days off (whole days in the shop's time zone, both ends included). */
    daysOff: DayOff[];
    flatMonthlyPriceCents: number;
    includedCalls: number;
    overageCentsPerCall: number;
  };
  googleConnected: boolean;
  /** Google sign-in is configured on this server, so Today can offer the optional calendar card. */
  googleAvailable: boolean;
  paid: boolean;
  checkoutConfigured: boolean;
  /** Card status in plain terms: a trial counts as paid; trialEndsAt is when the first charge happens. */
  billing: { status: SubscriptionRecord["status"] | "none"; trialEndsAt: string | null; chargeNote: string | null; planId: PlanId; plans: ApiPlan[]; unlimited: boolean };
  /** The lead guarantee for this shop: watching the first 30 days, eligible for the refund (days 30–37), refunded, or closed. */
  guarantee: GuaranteeStatus;
  /** The new-owner flow: sign up → card → forward calls → hours → done. */
  onboarding: { hoursSet: boolean; completed: boolean };
  /**
   * This billing period in answered calls: countedCalls (answered, not spam, 15 s or longer) against the
   * plan's includedCalls, and the extra calls so far (billed after the period ends). Minutes stay internal.
   */
  usage: { countedCalls: number; includedCalls: number; extraCalls: number; extraCents: number; overageCentsPerCall: number; excludedSpamCalls: number; excludedShortCalls: number; periodEnd: string; unlimited: boolean; fairUseCalls: number | null };
  calls: ApiCall[];
  tasks: ApiTask[];
}

/** A plan on the card step: cheapest first, picked by default. chargeNote is the line under the button. */
export interface ApiPlan {
  id: PlanId; label: string; priceCents: number; firstMonthCents: number; includedCalls: number; overageCentsPerCall: number; blurb: string; who: string; chargeNote: string;
  /** What adding a card today costs on this plan (priceQuote): the one price summary reads this. */
  quote: PriceQuote;
  /** The Unlimited add-on on this plan (totals include the plan), or null where it isn't offered. */
  unlimited: { addOnCents: number; priceCents: number; firstMonthCents: number; fairUseCalls: number; chargeNote: string; quote: PriceQuote } | null;
}

export interface ApiCallDetail {
  call: ApiCall;
  recordingUrl: string | null;
  booking: { status: BookingRecord["status"]; requestedStart: string | null } | null;
  task: ApiTask | null;
  alerts: Array<{ priority: OutboxNotification["priority"]; state: OutboxNotification["state"] }>;
  canDelete: boolean;
  /** Otto's path through the call; null for calls from before paths were recorded, and in the demo. */
  path: CallPath | null;
}

export function apiCall(call: CallRecord): ApiCall {
  // The number the caller gave, else the number that called: a callback number that isn't a number never hides it.
  const phone = [call.fields.callbackNumber, call.fromNumber].find((value) => value && /^\+[1-9]\d{7,14}$/.test(value)) ?? null;
  return {
    id: call.id,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    durationSeconds: call.durationSeconds,
    outcome: call.outcome,
    phone,
    fields: {
      callerName: call.fields.callerName,
      problemDescription: call.fields.problemDescription,
      address: call.fields.address,
      serviceCategory: call.fields.serviceCategory,
      equipmentDetails: call.fields.equipmentDetails,
      accessNotes: call.fields.accessNotes,
      requestedStart: call.fields.requestedStart,
    },
    emergency: call.emergency ? { emergency: call.emergency.emergency, severity: call.emergency.severity, immediateInstruction: call.emergency.immediateInstruction } : null,
    transcript: call.transcript,
  };
}

export function apiTask(task: CallbackTask): ApiTask {
  return {
    callId: task.callId,
    reason: ownerTaskReason(task.reason),
    priority: task.priority,
    status: task.status,
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    completionSource: task.completionSource,
    updatedAt: task.updatedAt,
  };
}

export function apiDashboard(input: {
  account: Pick<OwnerAccount, "role" | "status">;
  config: BusinessConfig;
  calls: CallRecord[];
  tasks: CallbackTask[];
  usage: UsageSummary;
  googleConnected: boolean;
  subscription: SubscriptionRecord | null;
  csrf: string;
  checkoutConfigured: boolean;
  now: string;
  preview: boolean;
  lineNumber?: string | null | undefined;
  forwarding?: ForwardingState | undefined;
  /** The owner's mobile from signup: the first guess at the number customers call. */
  ownerMobile?: string | null | undefined;
  googleAvailable?: boolean | undefined;
  chargeNote?: string | null | undefined;
  plans?: ApiPlan[] | undefined;
  guarantee?: GuaranteeStatus | undefined;
  onboarding?: { hoursSet: boolean; completed: boolean } | undefined;
  checkCallerId?: string | null | undefined;
  /** Consent to owner texts is on file (owner_sms_consent). Without it, texts are off whatever the config says (the SMS sender holds them too). */
  smsConsent?: boolean | undefined;
  textsLive?: boolean | undefined;
  helpTeam?: boolean | undefined;
  helpBookUrl?: string | null | undefined;
}): ApiDashboard {
  const c = input.config;
  const lineNumber = input.lineNumber ?? null;
  return {
    line: { ...lineModel(lineNumber, c, input.forwarding, input.now, input.account.role === "member" ? null : input.ownerMobile ?? null, input.checkCallerId ?? null), helpTeam: input.helpTeam === true, helpEmail: COMPANY.email, helpBookUrl: input.account.role === "member" ? null : input.helpBookUrl ?? null },
    csrf: input.csrf,
    now: input.now,
    preview: input.preview,
    viewer: { role: input.account.role === "member" ? "member" : "owner", status: input.account.status },
    shop: {
      businessName: c.businessName,
      timezone: c.timezone,
      paused: c.paused,
      pausedForBilling: c.pausedForBilling === true,
      alertsOn: textsOn(c, input.smsConsent === true),
      textsLive: input.textsLive === true,
      rulesSaved: c.serviceAreaTerms.length > 0 && c.greeting.trim().length > 0,
      greeting: c.greeting,
      hours: describeHours(c.bookableHours),
      daysOff: upcomingDaysOff(c.daysOff, localDate(new Date(input.now), c.timezone)),
      flatMonthlyPriceCents: c.flatMonthlyPriceCents,
      includedCalls: c.includedCalls,
      overageCentsPerCall: c.overageCentsPerCall,
    },
    googleConnected: input.googleConnected,
    googleAvailable: input.googleAvailable ?? false,
    // Paid or complimentary (the review account): the app shows no card step either way.
    paid: hasPlanAccess(input.subscription?.status),
    checkoutConfigured: input.checkoutConfigured,
    billing: {
      status: input.subscription?.status ?? "none",
      trialEndsAt: input.subscription?.status === "trialing" ? input.subscription.currentPeriodEnd : null,
      chargeNote: input.chargeNote ?? null,
      planId: c.planId ?? "solo",
      plans: input.plans ?? [],
      unlimited: c.unlimitedCalls === true,
    },
    onboarding: input.onboarding ?? { hoursSet: false, completed: false },
    guarantee: input.guarantee ?? { state: "none", leads: 0, complete: true, windowEndsAt: null, claimUntil: null, refund: null },
    usage: {
      countedCalls: input.usage.billableCalls,
      includedCalls: c.includedCalls,
      // With Unlimited, nothing is extra until fair use (3× the plan's calls).
      extraCalls: extraCalls(input.usage.billableCalls, c.unlimitedCalls ? fairUseCalls(c.includedCalls) : c.includedCalls),
      extraCents: extraCalls(input.usage.billableCalls, c.unlimitedCalls ? fairUseCalls(c.includedCalls) : c.includedCalls) * c.overageCentsPerCall,
      overageCentsPerCall: c.overageCentsPerCall,
      excludedSpamCalls: input.usage.excludedSpamCalls,
      excludedShortCalls: input.usage.excludedShortCalls,
      periodEnd: input.usage.periodEnd,
      unlimited: c.unlimitedCalls === true,
      fairUseCalls: c.unlimitedCalls ? fairUseCalls(c.includedCalls) : null,
    },
    calls: input.calls.map(apiCall),
    tasks: input.tasks.map(apiTask),
  };
}

/**
 * passed: the test call reached Call Otto. phone_answers: the business phone answered it itself (iOS call
 * screening or Live Voicemail, Pixel Call Screen, or a person, watch or car), so carrier forwarding never got a
 * chance. you_answered: a person picked it up (most likely the owner). voicemail: a voicemail answered it.
 * declined: it was declined but nothing forwarded it. not_reached: it rang out and never reached us.
 * forwards_all: ring first was picked, but our call reached Otto with no ring: every call is still forwarded.
 * rings_first: every call was picked, but our call rang the phone first: the every-call code isn't on yet.
 */
export type ForwardingCheckStatus = "idle" | "calling" | "passed" | "phone_answers" | "you_answered" | "voicemail" | "declined" | "not_reached" | "forwards_all" | "rings_first";

/** The stored check, as the check endpoint and the check call's webhooks write it. */
export interface ForwardingCheckRecord {
  startedAt: string;
  method: "auto" | "manual";
  callControlId?: string | null;
  answeredAt?: string | null;
  endedAt?: string | null;
  hangupCause?: string | null;
  /** When Telnyx heard the phone's own screener (iOS Call Screening or Live Voicemail) answer. */
  screenedAt?: string | null;
  /** Premium AMD's verdict on whatever answered: human_residence, human_business, machine, silence, not_sure... */
  amdResult?: string | null;
  /** The code on screen when the owner started this test. */
  code?: string | null;
  /** What the owner picked when they started this test: a pass records it as what they're set up for. */
  choice?: ForwardingChoice | null;
  /** Our call to the business phone couldn't be placed, so the owner calls from another phone instead. */
  autoFailed?: boolean | null;
  /** Our own check call reached Otto this many ms after it was placed. */
  forwardedAfterMs?: number | null;
  /** Ring first was picked and that was too fast to have rung: every call is still forwarded. */
  atOnce?: boolean | null;
  /** Every call was picked and our call rang the phone first: the every-call code isn't on. */
  rangFirst?: boolean | null;
}

/** This shop's forwarding plan: its carrier (family and name) and how many ring-first tests in a row missed. */
export function shopForwardingPlan(carrier: CarrierInfo, lineNumber: string, mode: ForwardingMode, answerAfterRings: number | null | undefined, misses?: number | null): ForwardingPlan {
  return forwardingPlan(carrier.family, lineNumber, mode, answerAfterRings, { carrierName: carrier.name, misses: misses ?? 0 });
}

export interface ForwardingState {
  businessNumber: string | null;
  carrier: CarrierInfo | null;
  confirmedAt: string | null;
  check: { startedAt: string; method: "auto" | "manual"; answeredAt?: string | null; endedAt?: string | null; hangupCause?: string | null; screenedAt?: string | null; amdResult?: string | null; code?: string | null; choice?: ForwardingChoice | null; autoFailed?: boolean | null; forwardedAfterMs?: number | null; atOnce?: boolean | null; rangFirst?: boolean | null } | null;
  helpRequestedAt: string | null;
  helpCall?: { to: string; startedAt: string; answeredAt: string | null; endedAt: string | null; outcome: "done" | "missed" | "voicemail" | "looped" | "failed" | null; booked: boolean } | null;
  /** What the owner was set up for when a test last passed (see TestedFor). */
  testedFor?: TestedFor | null;
  /** Timed ring-first tests in a row that found the phone never rang (see ringFirstTry). */
  ringFirstMisses?: number;
  founderEmail?: { sentAt: string; link: boolean } | null;
}

/**
 * How long a check waits for the forwarded call before saying it didn't reach us: our call rings up to 60 s, and a
 * test from another phone needs time to find that phone and dial (ring first adds up to 30 s of ringing). The server
 * accepts the forwarded call for this long too, so the card never says "didn't reach Otto" while a pass can still land.
 */
export const FORWARDING_CHECK_WINDOW_MS = 100_000;

/** A saved mobile, enough to recognise it: "(941) •••-0177". Never the whole number. */
export function maskedPhone(e164: string): string {
  const us = /^\+1(\d{3})\d{3}(\d{4})$/.exec(e164);
  if (us) return `(${us[1]}) •••-${us[2]}`;
  return `•••${e164.slice(-4)}`;
}

/** Owner texts are on only with consent on file and a mobile to send to: the one rule the banner, switches and copy share. */
export function textsOn(config: Pick<BusinessConfig, "ownerNotificationRefs">, consent: boolean): boolean {
  return consent && config.ownerNotificationRefs.length > 0;
}
/** Picked up sooner than this: the phone itself (a person, a screener). Later: a voicemail. */
const PHONE_PICKUP_MS = 12_000;

export function forwardingCheckStatus(check: ForwardingState["check"], confirmedAt: string | null, now: string): ForwardingCheckStatus {
  if (!check) return "idle";
  // Ring first, and our call reached Otto with no ring: forwarding works, but not the way they picked.
  if (check.atOnce) return "forwards_all";
  // Every call, and our call rang the phone first: calls reach Otto, but not the way they picked.
  if (check.rangFirst) return "rings_first";
  if (confirmedAt && confirmedAt >= check.startedAt) return "passed";
  // The phone's own screener answered: say so right away, while our short explanation plays and we hang up.
  if (check.method === "auto" && check.screenedAt) return "phone_answers";
  const elapsed = Date.parse(now) - Date.parse(check.startedAt);
  // Our own call, nothing picked it up and nothing reached Otto after the longest ring-first wait: not forwarding.
  const gaveUp = check.method === "auto" && !check.answeredAt && elapsed >= NOT_FORWARDING_AFTER_MS;
  const finished = Boolean(check.endedAt) || gaveUp || elapsed >= FORWARDING_CHECK_WINDOW_MS;
  if (!finished) return "calling";
  if (check.method !== "auto") return "not_reached";
  if (check.answeredAt) {
    // No screening heard: a machine is a voicemail greeting (carrier voicemail, or Live Voicemail we couldn't tell
    // apart); a person is someone picking up, most likely the owner. Without a verdict, a fast pick-up is the phone.
    if (check.amdResult === "machine") return "voicemail";
    if (check.amdResult?.startsWith("human")) return "you_answered";
    return Date.parse(check.answeredAt) - Date.parse(check.startedAt) < PHONE_PICKUP_MS ? "phone_answers" : "voicemail";
  }
  if (check.hangupCause === "user_busy" || check.hangupCause === "call_rejected") return "declined";
  return "not_reached";
}

function lineModel(lineNumber: string | null, config: Pick<BusinessConfig, "operationMode" | "answerAfterRings">, state: ForwardingState | undefined, now: string, ownerMobile: string | null, checkCallerId: string | null): Omit<ApiDashboard["line"], "helpTeam" | "helpEmail" | "helpBookUrl"> {
  const mode = config.operationMode;
  const check = state?.check ?? null;
  const confirmedAt = state?.confirmedAt ?? null;
  const status = forwardingCheckStatus(check, confirmedAt, now);
  const answeredAfterSec = check?.answeredAt ? Math.max(0, Math.round((Date.parse(check.answeredAt) - Date.parse(check.startedAt)) / 1_000)) : null;
  const plan = lineNumber && state?.carrier ? shopForwardingPlan(state.carrier, lineNumber, mode, config.answerAfterRings, state.ringFirstMisses) : null;
  const testedFor = state?.testedFor ?? null;
  const update = forwardingUpdate(plan, mode, testedFor);
  return {
    number: lineNumber,
    mode,
    forwarding: lineNumber ? forwardingInstructions(lineNumber, mode) : [],
    business: {
      number: state?.businessNumber ?? null,
      carrier: state?.carrier ?? null,
      plan,
      choices: CARRIER_CHOICES,
      suggested: state?.businessNumber ? null : ownerMobile,
      update,
      everyCallOn: Boolean(confirmedAt) && testedFor?.mode === "every-call",
      everyCallProven: Boolean(confirmedAt) && everyCallProven(testedFor),
      codeApplied: Boolean(confirmedAt && plan && testedFor) && !update,
      mayForwardAll: mayForwardAll({ mode, testedFor }),
      ringFirstSeconds: state?.carrier ? ringFirstSeconds(state.carrier.family, config.answerAfterRings) : null,
      lastTest: confirmedAt && plan && testedFor && !update && testedFor.at ? { mode: testedFor.mode, at: testedFor.at, rangSeconds: testedFor.mode === "ring-first" ? testedFor.rangSeconds ?? null : null, timed: testedFor.timed === true } : null,
    },
    confirmedAt,
    check: { status, method: check?.method ?? null, startedAt: check?.startedAt ?? null, answeredAfterSec, callerId: checkCallerId, autoFailed: check?.autoFailed === true, choice: check?.choice ?? null, code: check?.code ?? null, forwardedAfterSec: typeof check?.forwardedAfterMs === "number" ? Math.max(0, Math.round(check.forwardedAfterMs / 1_000)) : null },
    helpRequestedAt: state?.helpRequestedAt ?? null,
    helpCall: state?.helpCall ?? null,
    founderEmail: state?.founderEmail ?? null,
  };
}

/**
 * Today's choice or code differs from what the last passed test was set up for (or what the phone may be set up
 * for, see rememberLegacyTestedFor): dial the new code once (office lines: change it in the phone company's website).
 * Leaving every call for ring first turns forward-all off first, since it wins over every conditional code: the
 * every-call off code (clearFirst), or for office lines "forward all calls" in the website (leavingEveryCall, no code). Never
 * inferred from test timing.
 */
export function forwardingUpdate(plan: ForwardingPlan | null, mode: ForwardingMode, testedFor: TestedFor | null): { clearFirst: string | null; leavingEveryCall: boolean } | null {
  if (!plan || !testedFor || plan.family === "unknown") return null;
  const choice = forwardingChoice(mode);
  if (testedFor.mode === choice && testedFor.code === plan.on) return null;
  const leavingEveryCall = testedFor.mode === "every-call" && choice === "ring-first";
  // The code that turns every call off, the one the screen shows (forwardingClear): ring first's own clear code
  // (T-Mobile's ##004#) leaves forward-all on.
  return { clearFirst: leavingEveryCall ? plan.everyCallOff ?? plan.off : null, leavingEveryCall };
}

/** The owner settings form as plain values; the client posts the same names back. */
export function apiSettings(config: BusinessConfig, now: Date = new Date()): Record<string, string | boolean> {
  return {
    serviceState: config.paused ? "paused" : "active",
    operationMode: config.operationMode,
    answerAfterRings: String(config.answerAfterRings),
    weekends: config.afterHours.weekends,
    weekdayStart: config.afterHours.weekdayStart,
    weekdayEnd: config.afterHours.weekdayEnd,
    holidayDates: config.afterHours.holidayDates.join(", "),
    businessName: config.businessName,
    timezone: config.timezone,
    greeting: config.greeting,
    recordingNotice: config.recordingDisclosure.trim().length > 0,
    serviceAreaTerms: config.serviceAreaTerms.join(", "),
    serviceCategories: config.serviceCategories.join(", "),
    bookableWeekdayStart: config.bookableHours.weekdayStart,
    bookableWeekdayEnd: config.bookableHours.weekdayEnd,
    defaultServiceDurationMinutes: String(config.defaultServiceDurationMinutes),
    minimumLeadTimeMinutes: String(config.minimumLeadTimeMinutes),
    bookableWeekends: config.bookableHours.weekends,
    // Upcoming only: a day that has passed drops off the list on its own.
    daysOff: formatDaysOff(upcomingDaysOff(config.daysOff, localDate(now, config.timezone))),
    bookingMode: config.bookingMode,
    requireDiagnosticFeeAcceptance: config.requireDiagnosticFeeAcceptance,
    priceSnippets: config.priceSnippets.map((item) => `${item.label}: ${item.text}`).join("\n"),
    approvedKnowledge: config.approvedKnowledge.map((item) => `${item.topic}: ${item.text}`).join("\n"),
    ownerPhone: "",
    ownerDailySmsEnabled: config.ownerDailySmsEnabled,
    ownerDailySmsHour: String(config.ownerDailySmsHour),
    ownerRealtimeSmsEnabled: config.ownerRealtimeSmsEnabled,
    ownerWeeklyEmailEnabled: config.ownerWeeklyEmailEnabled,
    usageAlertPercent: String(config.usageAlertPercent),
    emergencyKeywords: config.emergencyKeywords.join(", "),
    emergencyThreshold: String(config.emergencyThreshold),
    pronunciations: config.pronunciations.map((item) => `${item.term}: ${item.spokenAs}`).join("\n"),
    supportEmail: config.supportEmail ?? "",
    flatMonthlyPrice: String(Math.round(config.flatMonthlyPriceCents / 100)),
  };
}

// Not here on purpose: repeat-caller limits and call retention are fixed by Call Otto, not owner settings.
const SETTINGS_FIELDS = new Set([
  "serviceState", "operationMode", "answerAfterRings", "weekends", "weekdayStart", "weekdayEnd", "holidayDates", "businessName", "timezone", "greeting", "recordingNotice", "serviceAreaTerms", "serviceCategories", "bookableWeekdayStart", "bookableWeekdayEnd", "defaultServiceDurationMinutes", "minimumLeadTimeMinutes", "bookableWeekends", "daysOff", "bookingMode", "requireDiagnosticFeeAcceptance", "priceSnippets", "approvedKnowledge", "ownerPhone", "ownerDailySmsEnabled", "ownerDailySmsHour", "ownerRealtimeSmsEnabled", "ownerWeeklyEmailEnabled", "usageAlertPercent", "emergencyKeywords", "emergencyThreshold", "pronunciations", "supportEmail", "flatMonthlyPrice",
]);

/**
 * Turn the JSON settings body into the exact form the HTML page posts: true checkboxes become "on",
 * false ones are left out, unknown keys are dropped (owners never send free-text recording notices).
 */
export function settingsForm(body: unknown): URLSearchParams {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Settings must be an object");
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!SETTINGS_FIELDS.has(key)) continue;
    if (value === true) form.set(key, "on");
    else if (value === false || value === null || value === undefined) continue;
    else if (typeof value === "string" || typeof value === "number") form.set(key, String(value));
    else throw new Error(`Invalid value for ${key}`);
  }
  return form;
}
