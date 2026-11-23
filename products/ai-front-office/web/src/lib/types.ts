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
}

export interface ApiDashboard {
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
    check: { status: "idle" | "calling" | "passed" | "not_reached"; method: "auto" | "manual" | null; startedAt: string | null }
    helpRequestedAt: string | null
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
    includedMinutes: number
    overageCentsPerMinute: number
  }
  googleConnected: boolean
  googleAvailable: boolean
  paid: boolean
  checkoutConfigured: boolean
  billing: { status: string; trialEndsAt: string | null; chargeNote: string | null; planId: PlanId; plans: ApiPlan[] }
  onboarding: { hoursSet: boolean; completed: boolean }
  /** Spam and calls under 15 seconds are left out of billedMinutes; the counts say how many. */
  usage: { billedMinutes: number; billableCalls: number; excludedSpamCalls: number; excludedShortCalls: number }
  /** Present only when analytics is on: opaque account and shop ids for PostHog. */
  analytics?: { distinctId: string; tenantId: string }
  calls: ApiCall[]
  tasks: ApiTask[]
}

export type PlanId = "standard" | "plus"

/** A plan on the card step: cheapest first and picked by default. chargeNote is the line under the button. */
export interface ApiPlan { id: PlanId; label: string; priceCents: number; firstMonthCents: number; blurb: string; chargeNote: string }

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
}

export type SettingsValues = Record<string, string | boolean>

export interface ApiSettings {
  csrf: string
  values: SettingsValues
  status: string
  businessName: string
  /** This shop's id, for its own calls export. */
  shopId: string
  plan: { label: string; flatMonthlyPriceCents: number; includedMinutes: number; overageCentsPerMinute: number; paid: boolean }
  integrations: {
    googleAvailable: boolean
    googleConnected: boolean
    ownerPhoneConfigured: boolean
    weeklyEmailAvailable: boolean
    dailySmsAvailable: boolean
    realtimeSmsAvailable: boolean
    directBookingAvailable: boolean
  }
}
