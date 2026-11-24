import { forwardingInstructions } from "../adapters/telnyx-provisioning.js";
import { CARRIER_CHOICES, forwardingPlan, type CarrierInfo, type ForwardingPlan } from "../domain/forwarding.js";
import { isPaidStatus } from "../domain/billing.js";
import { describeHours } from "../domain/hours.js";
import { fairUseCalls, type PlanId } from "../domain/plans.js";
import { extraCalls } from "../domain/usage.js";
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
    business: { number: string | null; carrier: CarrierInfo | null; plan: ForwardingPlan | null; choices: typeof CARRIER_CHOICES; suggested: string | null };
    /** When a call last proved forwarding works. */
    confirmedAt: string | null;
    check: { status: "idle" | "calling" | "passed" | "not_reached"; method: "auto" | "manual" | null; startedAt: string | null };
    helpRequestedAt: string | null;
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
    alertsOn: boolean;
    rulesSaved: boolean;
    greeting: string;
    hours: string;
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
  /** The Unlimited add-on on this plan (totals include the plan), or null where it isn't offered. */
  unlimited: { addOnCents: number; priceCents: number; firstMonthCents: number; fairUseCalls: number; chargeNote: string } | null;
}

export interface ApiCallDetail {
  call: ApiCall;
  recordingUrl: string | null;
  booking: { status: BookingRecord["status"]; requestedStart: string | null } | null;
  task: ApiTask | null;
  alerts: Array<{ priority: OutboxNotification["priority"]; state: OutboxNotification["state"] }>;
  canDelete: boolean;
}

export function apiCall(call: CallRecord): ApiCall {
  const raw = call.fields.callbackNumber ?? call.fromNumber;
  return {
    id: call.id,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    durationSeconds: call.durationSeconds,
    outcome: call.outcome,
    phone: raw && /^\+[1-9]\d{7,14}$/.test(raw) ? raw : null,
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
    reason: task.reason,
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
}): ApiDashboard {
  const c = input.config;
  const lineNumber = input.lineNumber ?? null;
  return {
    line: lineModel(lineNumber, c.operationMode, input.forwarding, input.now, input.account.role === "member" ? null : input.ownerMobile ?? null),
    csrf: input.csrf,
    now: input.now,
    preview: input.preview,
    viewer: { role: input.account.role === "member" ? "member" : "owner", status: input.account.status },
    shop: {
      businessName: c.businessName,
      timezone: c.timezone,
      paused: c.paused,
      pausedForBilling: c.pausedForBilling === true,
      alertsOn: c.ownerNotificationRefs.length > 0,
      rulesSaved: c.serviceAreaTerms.length > 0 && c.greeting.trim().length > 0,
      greeting: c.greeting,
      hours: describeHours(c.bookableHours),
      flatMonthlyPriceCents: c.flatMonthlyPriceCents,
      includedCalls: c.includedCalls,
      overageCentsPerCall: c.overageCentsPerCall,
    },
    googleConnected: input.googleConnected,
    googleAvailable: input.googleAvailable ?? false,
    paid: isPaidStatus(input.subscription?.status),
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

export interface ForwardingState {
  businessNumber: string | null;
  carrier: CarrierInfo | null;
  confirmedAt: string | null;
  check: { startedAt: string; method: "auto" | "manual" } | null;
  helpRequestedAt: string | null;
}

/** How long a check waits for the forwarded call before saying it didn't reach us. */
export const FORWARDING_CHECK_WINDOW_MS = 90_000;

function lineModel(lineNumber: string | null, mode: BusinessConfig["operationMode"], state: ForwardingState | undefined, now: string, ownerMobile: string | null): ApiDashboard["line"] {
  const check = state?.check ?? null;
  const confirmedAt = state?.confirmedAt ?? null;
  const status: ApiDashboard["line"]["check"]["status"] = !check ? "idle"
    : confirmedAt && confirmedAt >= check.startedAt ? "passed"
    : Date.parse(now) - Date.parse(check.startedAt) < FORWARDING_CHECK_WINDOW_MS ? "calling"
    : "not_reached";
  return {
    number: lineNumber,
    mode,
    forwarding: lineNumber ? forwardingInstructions(lineNumber, mode) : [],
    business: {
      number: state?.businessNumber ?? null,
      carrier: state?.carrier ?? null,
      plan: lineNumber && state?.carrier ? forwardingPlan(state.carrier.family, lineNumber, mode) : null,
      choices: CARRIER_CHOICES,
      suggested: state?.businessNumber ? null : ownerMobile,
    },
    confirmedAt,
    check: { status, method: check?.method ?? null, startedAt: check?.startedAt ?? null },
    helpRequestedAt: state?.helpRequestedAt ?? null,
  };
}

/** The owner settings form as plain values; the client posts the same names back. */
export function apiSettings(config: BusinessConfig): Record<string, string | boolean> {
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
    maxCallsPerCallerPerDay: String(config.maxCallsPerCallerPerDay),
    pronunciations: config.pronunciations.map((item) => `${item.term}: ${item.spokenAs}`).join("\n"),
    dataRetentionDays: String(config.dataRetentionDays),
    supportEmail: config.supportEmail ?? "",
    flatMonthlyPrice: String(Math.round(config.flatMonthlyPriceCents / 100)),
  };
}

const SETTINGS_FIELDS = new Set([
  "serviceState", "operationMode", "answerAfterRings", "weekends", "weekdayStart", "weekdayEnd", "holidayDates", "businessName", "timezone", "greeting", "recordingNotice", "serviceAreaTerms", "serviceCategories", "bookableWeekdayStart", "bookableWeekdayEnd", "defaultServiceDurationMinutes", "minimumLeadTimeMinutes", "bookableWeekends", "bookingMode", "requireDiagnosticFeeAcceptance", "priceSnippets", "approvedKnowledge", "ownerPhone", "ownerDailySmsEnabled", "ownerDailySmsHour", "ownerRealtimeSmsEnabled", "ownerWeeklyEmailEnabled", "usageAlertPercent", "emergencyKeywords", "emergencyThreshold", "maxCallsPerCallerPerDay", "pronunciations", "dataRetentionDays", "supportEmail", "flatMonthlyPrice",
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
