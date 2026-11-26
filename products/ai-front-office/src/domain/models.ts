import type { PlanId } from "./plans.js";

export type CallOutcome =
  | "in_progress"
  | "booked"
  | "pending_confirmation"
  | "handoff_queued"
  | "ignored_spam"
  | "failed";

export type BookingStatus = "checking" | "confirmed" | "pending" | "conflict" | "unknown";
export type NotificationState =
  | "pending"
  | "sending"
  | "sent"
  | "delivered"
  | "delivery_failed"
  | "delivery_unconfirmed"
  | "retry"
  | "dead"
  /** Never sent and never retried: the channel isn't allowed yet (texts before carrier approval). */
  | "held"
  /** Superseded before sending (e.g. a voicemail fallback once the transcript arrived). */
  | "cancelled";

export interface CollectedCallFields {
  callerName: string | null;
  companyName: string | null;
  callbackNumber: string | null;
  address: string | null;
  serviceCategory: string | null;
  serviceCategoryConfidence: number;
  problemDescription: string;
  equipmentDetails: string | null;
  accessNotes: string | null;
  requestedStart: string | null;
  explicitSlotConfirmation: boolean;
  diagnosticFeeAccepted: boolean;
  humanRequested: boolean;
  confidence: number;
}

export interface EmergencyDecision {
  emergency: boolean;
  severity: "routine" | "urgent" | "life_safety";
  score: number;
  evidence: string[];
  immediateInstruction: string | null;
}

export interface CallRecord {
  id: string;
  tenantId: string;
  providerCallId: string;
  fromNumber: string;
  fromNumberVerified: boolean;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  fields: CollectedCallFields;
  emergency: EmergencyDecision | null;
  outcome: CallOutcome;
  transcript: string | null;
  recordingUrl: string | null;
  consentState: "unknown" | "disclosed" | "declined";
  billingDisposition: "not_billable" | "billable" | "spam_excluded";
  qualityFlags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomerRecord {
  id: string;
  tenantId: string;
  phone: string;
  name: string | null;
  address: string | null;
  lastCallId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookingRecord {
  id: string;
  tenantId: string;
  callId: string;
  requestedStart: string | null;
  requestedEnd: string | null;
  status: BookingStatus;
  providerEventId: string | null;
  writeVerifiedAt: string | null;
  confirmationNotificationId: string | null;
  verificationFailures: string[];
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CallbackTask {
  id: string;
  tenantId: string;
  callId: string;
  ownerRef: string;
  reason: string;
  priority: "normal" | "high";
  status: "open" | "snoozed" | "completed" | "cancelled";
  dueAt: string;
  completedAt: string | null;
  completionSource: "owner" | "verified_booking" | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolEvent {
  id: string;
  tenantId: string;
  callId: string;
  tool: string;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  result: "success" | "failed" | "unknown";
  metadata: Record<string, unknown>;
  redactedError: string | null;
}

export interface OutboxNotification {
  id: string;
  tenantId: string;
  callId: string | null;
  channel: "sms" | "email" | "voice" | "push";
  senderRef?: "default" | "founder";
  destinationRef: string;
  body: string;
  priority: "normal" | "high";
  state: NotificationState;
  attempts: number;
  nextAttemptAt: string;
  idempotencyKey: string;
  providerReceipt: string | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface BusinessConfig {
  tenantId: string;
  paused: boolean;
  businessName: string;
  greeting: string;
  timezone: string;
  serviceAreaTerms: string[];
  emergencyKeywords: string[];
  emergencyThreshold: number;
  defaultServiceDurationMinutes: number;
  ownerNotificationRefs: string[];
  ownerTransferNumberRef: string | null;
  warmTransferEnabled?: boolean;
  /** True only when billing (not the owner) paused coverage, so payment can restore it. */
  pausedForBilling?: boolean;
  schedulingCalendars?: Array<{ accountId: string; enabled: boolean; hours: BusinessConfig["bookableHours"] }>;
  calendarConnectionRef: string | null;
  /** "direct": Otto books open times on a connected calendar; without one it takes the details and the owner confirms. */
  bookingMode: "confirm" | "direct";
  /**
   * 2 once booking defaults are current. Shops saved before it were all forced to "confirm" (the owner never had
   * the choice), so reading one without it moves it to "direct" once; an owner's later choice then sticks.
   */
  bookingDefaultsVersion?: number;
  operationMode: "after_hours" | "overflow" | "always";
  answerAfterRings: number;
  afterHours: {
    weekdayStart: string;
    weekdayEnd: string;
    weekends: boolean;
    /** With weekends on: Saturday keeps weekday hours instead of being covered all day. */
    workSaturday?: boolean;
    /** When workSaturday: after-hours starts at this time on Saturday instead of weekdayStart. */
    saturdayEnd?: string | undefined;
    holidayDates: string[];
  };
  bookableHours: {
    weekdayStart: string;
    weekdayEnd: string;
    weekends: boolean;
    /** Saturday is bookable even when weekends are off (a Mon–Sat shop). */
    saturday?: boolean;
    /** Saturday closes earlier than weekdays (e.g. "12:00" for Saturday mornings). */
    saturdayEnd?: string | undefined;
  };
  /** Whole days (in `timezone`) when Otto offers and books no visits: holidays, a trade show, a week away. */
  daysOff?: Array<{ start: string; end: string }>;
  minimumLeadTimeMinutes: number;
  priceSnippets: Array<{ label: string; text: string }>;
  approvedKnowledge: Array<{ topic: string; text: string }>;
  pronunciations: Array<{ term: string; spokenAs: string }>;
  serviceCategories: string[];
  requireDiagnosticFeeAcceptance: boolean;
  recordingDisclosure: string;
  dataRetentionDays: number;
  supportEmail: string | null;
  flatMonthlyPriceCents: number;
  /** The plan the owner picked ("solo" when unset). Old configs may still say "standard"/"plus"; normalizeBusinessConfig maps them. */
  planId?: PlanId;
  /** Answered calls (non-spam, 15 s or longer) included each billing period. */
  includedCalls: number;
  /** Each counted call past includedCalls, billed at period end. */
  overageCentsPerCall: number;
  /**
   * The Unlimited calls add-on (a second Stripe subscription item): no extra-call charges up to 3× includedCalls.
   * Before the first payment it is the owner's pick for checkout; after, it follows what Stripe bills.
   */
  unlimitedCalls?: boolean;
  /** Percent of included calls (50–95) that triggers the first usage alert each billing period; 100% always alerts. */
  usageAlertPercent: number;
  customerSmsEnabled: boolean;
  ownerWeeklyEmailEnabled: boolean;
  ownerDailySmsEnabled: boolean;
  ownerDailySmsHour: number;
  /** Texts on every new lead: on by default (the core product), still sent only to numbers the owner consented for. */
  ownerRealtimeSmsEnabled: boolean;
  /** True once the owner (or admin) changed the lead-texts toggle, so a default-on rollout never overrides their choice. */
  ownerRealtimeSmsSetByOwner?: boolean;
  maxCallsPerCallerPerDay: number;
}

export interface OwnerAccount {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role?: "owner" | "member";
  status: "pending_activation" | "active" | "suspended";
  /** Incremented to revoke every existing session (password reset, sign out everywhere). */
  sessionVersion?: number;
  /**
   * When the owner proved they control the email (Google, Microsoft, an email link or a reset link). Null for
   * a password sign-up or invite nobody has proved yet: the first proof drops that password.
   */
  emailVerifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerWorkspaceInput {
  account: OwnerAccount;
  config: BusinessConfig;
  ownerPhone: string | null;
}

export interface UsageSummary {
  periodStart: string;
  periodEnd: string;
  /** Calls that count against the plan: answered, not spam and connected at least 15 seconds. */
  billableCalls: number;
  excludedSpamCalls: number;
  /** Calls under 15 seconds, which never count. */
  excludedShortCalls: number;
  /** Minutes of the counted calls (every started minute): kept for our provider cost, never shown to owners. */
  billedMinutes: number;
}

export interface ProviderRoute {
  provider: "telnyx";
  externalId: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRecord {
  tenantId: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  /**
   * Stripe's status, except "comp": a complimentary account we made ourselves (the Google OAuth review account),
   * written only by the signed admin link and never by Stripe or an owner. It opens the owner app as if paid,
   * but is never billed, never gets a phone line and never sends anything (see domain/billing.ts).
   */
  status: "not_started" | "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "comp";
  currentPeriodEnd: string | null;
  providerEventCreatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PilotSignup {
  id: string;
  ownerName: string;
  businessName: string;
  email: string;
  phone: string;
  website: string | null;
  trade: "hvac" | "plumbing" | "electrical" | "other";
  serviceArea: string;
  desiredMode: "after_hours" | "overflow" | "always";
  missedCallsPerWeek: number | null;
  calendarProvider: "google" | "none" | "other";
  notes: string | null;
  status: "new" | "contacted" | "approved" | "declined" | "activated";
  source: "website";
  consentedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CallSummaryInput {
  webhookEventId: string;
  tenantId: string;
  providerCallId: string;
  fromNumber: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number | null;
  fields: CollectedCallFields;
  transcript: string | null;
  recordingUrl: string | null;
  consentState: CallRecord["consentState"];
  llmEmergencyScore?: number;
  llmEmergencyReason?: string;
  isSpam?: boolean;
}

export interface AvailabilitySlot {
  start: string;
  end: string;
}

export interface BookingAttempt {
  tenantId: string;
  callId: string;
  providerCallId: string;
  slot: AvailabilitySlot;
  callerName: string;
  callbackNumber: string;
  address: string;
  problemDescription: string;
  idempotencyKey: string;
}
