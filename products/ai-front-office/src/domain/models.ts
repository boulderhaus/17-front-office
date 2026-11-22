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
  | "dead";

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
  channel: "sms" | "email" | "voice";
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
  calendarConnectionRef: string | null;
  bookingMode: "confirm" | "direct";
  operationMode: "after_hours" | "overflow" | "always";
  answerAfterRings: number;
  afterHours: {
    weekdayStart: string;
    weekdayEnd: string;
    weekends: boolean;
    holidayDates: string[];
  };
  bookableHours: {
    weekdayStart: string;
    weekdayEnd: string;
    weekends: boolean;
  };
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
  includedMinutes: number;
  overageCentsPerMinute: number;
  customerSmsEnabled: boolean;
  ownerWeeklyEmailEnabled: boolean;
  ownerDailySmsEnabled: boolean;
  ownerDailySmsHour: number;
  ownerRealtimeSmsEnabled: boolean;
  maxCallsPerCallerPerDay: number;
}

export interface OwnerAccount {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  passwordHash: string;
  status: "pending_activation" | "active" | "suspended";
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
  billableCalls: number;
  excludedSpamCalls: number;
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
  status: "not_started" | "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "unpaid";
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
