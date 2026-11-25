// Mirrors src/http/owner-api-model.ts on the server.
export type Outcome = "in_progress" | "booked" | "pending_confirmation" | "handoff_queued" | "ignored_spam" | "failed"

export interface ApiCall {
  id: string
  startedAt: string
  endedAt: string | null
  durationSeconds: number | null
  outcome: Outcome
  phone: string | null
  fields: {
    callerName: string | null
    problemDescription: string
    address: string | null
    serviceCategory: string | null
    equipmentDetails: string | null
    accessNotes: string | null
    requestedStart: string | null
  }
  emergency: { emergency: boolean; severity: "routine" | "urgent" | "life_safety"; immediateInstruction: string | null } | null
  transcript: string | null
}

export interface ApiTask {
  callId: string
  reason: string
  priority: "normal" | "high"
  status: "open" | "snoozed" | "completed" | "cancelled"
  dueAt: string
  completedAt: string | null
  completionSource: "owner" | "verified_booking" | null
  updatedAt: string
}

export interface ForwardingCode {
  carrier: string
  on: string
  off: string
}

export type CarrierFamily = "verizon" | "gsm" | "office" | "unknown"

export interface ForwardingPlan {
  family: CarrierFamily
  on: string | null
  off: string | null
  dialLink: string | null
  offDialLink: string | null
  what: string
  tips: string[]
  iphoneTip: string | null
  confirm: string | null
}

export interface ApiDashboard {
  /** Web push call alerts: the VAPID key (null: not offered yet) and how many phones have them on. */
  push?: { publicKey: string | null; devices: number }
  line: {
    number: string | null
    mode: "overflow" | "after_hours" | "always"
    forwarding: ForwardingCode[]
    business: {
      number: string | null
      carrier: { name: string | null; lineType: string | null; family: CarrierFamily; chosen: boolean } | null
      plan: ForwardingPlan | null
      choices: Array<{ family: Exclude<CarrierFamily, "unknown">; label: string }>
      /** The owner's mobile from signup, offered as the number customers call. */
      suggested: string | null
    }
    confirmedAt: string | null
    check: {
      status: "idle" | "calling" | "passed" | "picked_up" | "voicemail" | "declined" | "not_reached"
      method: "auto" | "manual" | null
      startedAt: string | null
      answeredAfterSec: number | null
      callerId: string | null
    }
    helpRequestedAt: string | null
    helpCall: { to: string; startedAt: string } | null
    /** Brock's follow-up email in the last 24 hours, and whether it has a booking link. */
    founderEmail?: { sentAt: string; link: boolean } | null
  }
  csrf: string
  now: string
  preview: boolean
  viewer: { role: "owner" | "member"; status: "pending" | "active" | "suspended" | string }
  shop: {
    businessName: string
    timezone: string
    paused: boolean
    pausedForBilling: boolean
    alertsOn: boolean
    rulesSaved: boolean
    greeting: string
    hours: string
    flatMonthlyPriceCents: number
    includedCalls: number
    overageCentsPerCall: number
  }
  googleConnected: boolean
  googleAvailable: boolean
  paid: boolean
  checkoutConfigured: boolean
  billing: { status: string; trialEndsAt: string | null; chargeNote: string | null; planId: PlanId; plans: ApiPlan[]; unlimited: boolean }
  /** The lead guarantee, decided by the server: the refund button shows only when state is "eligible". */
  guarantee: Guarantee
  onboarding: { hoursSet: boolean; completed: boolean }
  /** This billing period in answered calls (spam and calls under 15 seconds never count). Extra calls are billed after the period ends. */
  usage: { countedCalls: number; includedCalls: number; extraCalls: number; extraCents: number; overageCentsPerCall: number; excludedSpamCalls: number; excludedShortCalls: number; periodEnd: string; unlimited: boolean; fairUseCalls: number | null }
  /** Present only when analytics is on: opaque account and shop ids for PostHog. */
  analytics?: { distinctId: string; tenantId: string }
  calls: ApiCall[]
  tasks: ApiTask[]
}

export type PlanId = "solo" | "pro" | "team" | "fleet"

/** A plan: Solo first and picked by default. chargeNote is the line under the card button. */
export interface ApiPlan {
  id: PlanId; label: string; priceCents: number; firstMonthCents: number; includedCalls: number; overageCentsPerCall: number; blurb: string; who: string; chargeNote: string
  /** The Unlimited calls add-on on this plan (totals include the plan), or null where it isn't offered. */
  unlimited: { addOnCents: number; priceCents: number; firstMonthCents: number; fairUseCalls: number; chargeNote: string } | null
}

export interface Guarantee {
  state: "none" | "watching" | "eligible" | "pending" | "refunded" | "closed"
  /** False when the server could not read every call in the window: never eligible then. */
  complete: boolean
  /** Real customer leads in the first 30 days so far. */
  leads: number
  windowEndsAt: string | null
  claimUntil: string | null
  refund: { amountCents: number; at: string } | null
}

export interface Activation {
  status: "live" | "waiting" | "blocked" | "failed"
  message: string | null
}

export interface ApiCallDetail {
  call: ApiCall
  recordingUrl: string | null
  booking: { status: string; requestedStart: string | null } | null
  task: ApiTask | null
  alerts: Array<{ priority: "normal" | "high"; state: string }>
  canDelete: boolean
  /** Otto's path through the call; null for calls from before paths were recorded, and in the demo. */
  path?: ApiCallPath | null
}

export type ApiCallPathState = "done" | "waiting" | "flagged" | "current" | "todo" | "skipped"

export interface ApiCallPathStep {
  key: string
  label: string
  state: ApiCallPathState
  at: string | null
  note: string | null
}

export interface ApiCallPath {
  steps: ApiCallPathStep[]
  extras: ApiCallPathStep[]
  live: boolean
  done: number
  startedAt: string
}

export type SettingsValues = Record<string, string | boolean>

export interface ApiSettings {
  /** Automated emergency calls to the owner's mobile: offered, and on only with the owner's recorded consent. */
  urgentCalls?: { available: boolean; on: boolean; disclosure: string }
  csrf: string
  values: SettingsValues
  status: string
  businessName: string
  /** This shop's id, for its own calls export. */
  shopId: string
  plan: {
    id: PlanId; label: string; flatMonthlyPriceCents: number; includedCalls: number; overageCentsPerCall: number; paid: boolean; plans: ApiPlan[]
    /** False for a legacy plan (Pro) the shop keeps but nobody can buy. */
    sold: boolean
    unlimited: boolean
    unlimitedOffer: { addOnCents: number; priceCents: number; fairUseCalls: number } | null
  }
  integrations: {
    googleAvailable: boolean
    googleConnected: boolean
    ownerPhoneConfigured: boolean
    weeklyEmailAvailable: boolean
    directBookingAvailable: boolean
  }
}
