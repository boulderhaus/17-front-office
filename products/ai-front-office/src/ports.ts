import type {
  AvailabilitySlot,
  BookingAttempt,
  BookingRecord,
  BusinessConfig,
  CallbackTask,
  CallRecord,
  CustomerRecord,
  OutboxNotification,
  OwnerAccount,
  OwnerWorkspaceInput,
  PilotSignup,
  ProviderRoute,
  SubscriptionRecord,
  ToolEvent,
  UsageSummary,
} from "./domain/models.js";

export interface Store {
  ping(): Promise<void>;
  withLock<T>(key: string, task: () => Promise<T>): Promise<T>;
  claimWebhook(eventId: string): Promise<boolean>;
  listTenantIds(): Promise<string[]>;
  getConfig(tenantId: string): Promise<BusinessConfig>;
  saveConfig(config: BusinessConfig): Promise<void>;
  getIntegrationSecret(tenantId: string, provider: string, key: string): Promise<string | null>;
  saveIntegrationSecret(tenantId: string, provider: string, key: string, value: string): Promise<void>;
  getCallByProviderId(providerCallId: string): Promise<CallRecord | null>;
  isProviderCallDeleted(providerCallId: string): Promise<boolean>;
  getCall(callId: string): Promise<CallRecord | null>;
  saveCall(call: CallRecord): Promise<void>;
  listCalls(tenantId: string, limit: number): Promise<CallRecord[]>;
  countCallsFromNumberSince(tenantId: string, phone: string, since: string): Promise<number>;
  /** Expired calls, skipping any whose deletion failed within the last 24 hours before `now`. */
  listExpiredCalls(tenantId: string, endedBefore: string, limit: number, now: string): Promise<CallRecord[]>;
  markRetentionFailed(callId: string, at: string): Promise<void>;
  deleteCall(tenantId: string, callId: string): Promise<boolean>;
  upsertCustomer(customer: CustomerRecord): Promise<void>;
  getBookingForCall(callId: string): Promise<BookingRecord | null>;
  saveBooking(booking: BookingRecord): Promise<void>;
  getCallbackTaskForCall(callId: string): Promise<CallbackTask | null>;
  listOpenCallbackTasks(tenantId: string, limit: number): Promise<CallbackTask[]>;
  listCallbackTasks(tenantId: string, limit: number): Promise<CallbackTask[]>;
  saveCallbackTask(task: CallbackTask): Promise<void>;
  addToolEvent(event: ToolEvent): Promise<void>;
  listToolEvents(callId: string): Promise<ToolEvent[]>;
  enqueueNotification(notification: OutboxNotification): Promise<boolean>;
  claimDueNotifications(now: string, limit: number): Promise<OutboxNotification[]>;
  requeueStaleNotifications(staleBefore: string, now: string): Promise<number>;
  saveNotification(notification: OutboxNotification): Promise<void>;
  getNotificationByProviderReceipt(providerReceipt: string): Promise<OutboxNotification | null>;
  listNotifications(callId: string): Promise<OutboxNotification[]>;
  setSmsOptOut(tenantId: string, phone: string, optedOut: boolean): Promise<void>;
  isSmsOptedOut(tenantId: string, phone: string): Promise<boolean>;
  savePilotSignup(signup: PilotSignup): Promise<void>;
  listPilotSignups(limit: number): Promise<PilotSignup[]>;
  createOwnerWorkspace(input: OwnerWorkspaceInput): Promise<boolean>;
  createTeamAccount(account: OwnerAccount): Promise<boolean>;
  listTeamAccounts(tenantId: string): Promise<OwnerAccount[]>;
  getOwnerAccountByEmail(email: string): Promise<OwnerAccount | null>;
  getOwnerAccountById(accountId: string): Promise<OwnerAccount | null>;
  getOwnerAccountByTenant(tenantId: string): Promise<OwnerAccount | null>;
  listOwnerAccounts(limit: number): Promise<OwnerAccount[]>;
  updateOwnerAccountStatus(accountId: string, status: OwnerAccount["status"], updatedAt: string): Promise<boolean>;
  getUsageSummary(tenantId: string, periodStart: string, periodEnd: string): Promise<UsageSummary>;
  saveProviderRoute(route: ProviderRoute): Promise<void>;
  getProviderRoute(provider: ProviderRoute["provider"], externalId: string): Promise<ProviderRoute | null>;
  getProviderRouteForTenant(provider: ProviderRoute["provider"], tenantId: string): Promise<ProviderRoute | null>;
  saveSubscription(subscription: SubscriptionRecord): Promise<void>;
  getSubscription(tenantId: string): Promise<SubscriptionRecord | null>;
  purgeWebhookEvents(before: string): Promise<number>;
}

export interface CalendarPort {
  listAvailableSlots(input: {
    tenantId: string;
    windowStart: string;
    windowEnd: string;
    durationMinutes: number;
    timezone: string;
    bookableHours: BusinessConfig["bookableHours"];
    minimumLeadTimeMinutes: number;
    now: string;
  }): Promise<AvailabilitySlot[]>;
  isFree(input: { tenantId: string; slot: AvailabilitySlot }): Promise<boolean>;
  createEvent(attempt: BookingAttempt): Promise<{ status: "confirmed" | "unknown"; providerEventId: string | null }>;
  verifyEvent(input: { tenantId: string; providerEventId: string; slot: AvailabilitySlot }): Promise<boolean>;
  deleteEvent(input: { tenantId: string; providerEventId: string }): Promise<void>;
}

export interface NotificationPort {
  send(notification: OutboxNotification): Promise<{ providerReceipt: string }>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
