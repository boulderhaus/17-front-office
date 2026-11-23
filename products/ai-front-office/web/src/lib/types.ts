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

export interface ApiDashboard {
  line: { number: string | null; mode: "overflow" | "after_hours" | "always"; forwarding: ForwardingCode[] }
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
    flatMonthlyPriceCents: number
    includedMinutes: number
    overageCentsPerMinute: number
  }
  googleConnected: boolean
  paid: boolean
  checkoutConfigured: boolean
  /** Spam and calls under 15 seconds are left out of billedMinutes; the counts say how many. */
  usage: { billedMinutes: number; billableCalls: number; excludedSpamCalls: number; excludedShortCalls: number }
  /** Present only when analytics is on: opaque account and shop ids for PostHog. */
  analytics?: { distinctId: string; tenantId: string }
  calls: ApiCall[]
  tasks: ApiTask[]
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
  plan: { flatMonthlyPriceCents: number; includedMinutes: number; overageCentsPerMinute: number; paid: boolean }
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
