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

/**
 * The tenant id for Call Otto's own secrets, not any shop's: the setup helper's assistant id and the founder's
 * Google calendars. Shop ids are always "shop_<uuid>" or the configured default, so it can't collide.
 */
export const PLATFORM_TENANT_ID = "platform";

export interface Store {
  ping(): Promise<void>;
  withLock<T>(key: string, task: () => Promise<T>): Promise<T>;
  claimWebhook(eventId: string): Promise<boolean>;
  listTenantIds(): Promise<string[]>;
  getConfig(tenantId: string): Promise<BusinessConfig>;
  saveConfig(config: BusinessConfig): Promise<void>;
  /** Encrypted per-shop secrets. Tenant PLATFORM_TENANT_ID holds platform-wide ones and needs no shop record. */
  getIntegrationSecret(tenantId: string, provider: string, key: string): Promise<string | null>;
  saveIntegrationSecret(tenantId: string, provider: string, key: string, value: string): Promise<void>;
  deleteIntegrationSecret(tenantId: string, provider: string, key: string): Promise<void>;
  /** The shop whose provisioned Call Otto number (telnyx/inbound_number) is this E.164 number. */
  getTenantIdByInboundNumber(phoneNumber: string): Promise<string | null>;
  /** Fill the number lookup for rows saved before it existed. Idempotent; duplicate numbers stay unindexed. */
  backfillInboundNumberLookups(): Promise<{ updated: number; conflicts: number }>;
  getCallByProviderId(providerCallId: string): Promise<CallRecord | null>;
  isProviderCallDeleted(providerCallId: string): Promise<boolean>;
  getCall(callId: string): Promise<CallRecord | null>;
  saveCall(call: CallRecord): Promise<void>;
  listCalls(tenantId: string, limit: number): Promise<CallRecord[]>;
  /** Every shop's calls still in progress that started at or after `startedAfter`, oldest first, at most `limit`. */
  listInProgressCalls(startedAfter: string, limit: number): Promise<CallRecord[]>;
  /**
   * Every shop's calls that never got an end (no end-of-call payload yet, whatever happened during the call)
   * and started at or after `startedAfter`, oldest first, at most `limit`.
   */
  listUnfinishedCalls(startedAfter: string, limit: number): Promise<CallRecord[]>;
  /** Calls that started in [from, to), oldest first, at most `limit` (callers treat a full page as incomplete). */
  listCallsStartedBetween(tenantId: string, from: string, to: string, limit: number): Promise<CallRecord[]>;
  /** The callback tasks of exactly these calls. */
  listCallbackTasksForCalls(tenantId: string, callIds: string[]): Promise<CallbackTask[]>;
  countCallsFromNumberSince(tenantId: string, phone: string, since: string): Promise<number>;
  /** Expired calls, skipping any whose deletion failed within the last 24 hours before `now`. */
  listExpiredCalls(tenantId: string, endedBefore: string, limit: number, now: string): Promise<CallRecord[]>;
  markRetentionFailed(callId: string, at: string): Promise<void>;
  /** Remove every record for a shop. Provider call IDs are kept as tombstones so late webhooks cannot recreate calls. */
  deleteWorkspace(tenantId: string): Promise<void>;
  deleteCall(tenantId: string, callId: string): Promise<boolean>;
  upsertCustomer(customer: CustomerRecord): Promise<void>;
  /** True when this number already has a customer record in this shop (a past non-spam call). */
  isKnownCustomer(tenantId: string, phone: string): Promise<boolean>;
  getBookingForCall(callId: string): Promise<BookingRecord | null>;
  listBookingsForTenant(tenantId: string): Promise<BookingRecord[]>;
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
  /** Atomically cancel a queued or retrying notification that is not being sent right now. True when it was cancelled. */
  cancelPendingNotification(idempotencyKey: string): Promise<boolean>;
  getNotificationByProviderReceipt(providerReceipt: string): Promise<OutboxNotification | null>;
  listNotifications(callId: string): Promise<OutboxNotification[]>;
  setSmsOptOut(tenantId: string, phone: string, optedOut: boolean): Promise<void>;
  isSmsOptedOut(tenantId: string, phone: string): Promise<boolean>;
  /**
   * This number's one-time STOP notice for a notification: true when this notification holds it. Only a first send
   * attempt may take a free notice (atomic across replicas); a retry just reads whether it already holds it, so a
   * retry always sends the same text as its first attempt.
   */
  claimSmsStopNotice(phone: string, notificationId: string, now: string, firstAttempt: boolean): Promise<boolean>;
  /** A notification that will never be sent gives its STOP notice back, so the next owner text carries it. */
  releaseSmsStopNotice(notificationId: string): Promise<void>;
  /** Forget a number's STOP notice so the next owner text carries it again (after the number re-subscribes). */
  resetSmsStopNotice(phone: string): Promise<void>;
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
  /** Store a hashed single-use reset token. */
  createPasswordReset(accountId: string, tokenHash: string, expiresAt: string): Promise<void>;
  /** Atomically mark an unexpired, unused token used; returns its account or null. */
  consumePasswordReset(tokenHash: string, now: string): Promise<string | null>;
  /** Replace the password, revoke every existing session, and void every outstanding reset link. */
  updateOwnerPassword(accountId: string, passwordHash: string, updatedAt: string): Promise<void>;
  revokeOwnerSessions(accountId: string, updatedAt: string): Promise<void>;
  /**
   * Record that the account's email was proved (Google, Microsoft, an email link or a reset link). With
   * replacePasswordHash, also swap the password and revoke every session in the same write.
   */
  markOwnerEmailVerified(accountId: string, verifiedAt: string, replacePasswordHash: string | null): Promise<void>;
  /**
   * Store a hashed single-use email sign-in link. The email may have no account yet (the link then opens sign-up).
   * Also purges spent links and day-old sign-in emails queued for addresses with no shop.
   */
  createSignInLink(tokenHash: string, email: string, expiresAt: string, now: string): Promise<void>;
  /** Atomically mark an unexpired, unused sign-in link used; returns its email or null. */
  consumeSignInLink(tokenHash: string, now: string): Promise<string | null>;
  getUsageSummary(tenantId: string, periodStart: string, periodEnd: string): Promise<UsageSummary>;
  saveProviderRoute(route: ProviderRoute): Promise<void>;
  getProviderRoute(provider: ProviderRoute["provider"], externalId: string): Promise<ProviderRoute | null>;
  getProviderRouteForTenant(provider: ProviderRoute["provider"], tenantId: string): Promise<ProviderRoute | null>;
  saveSubscription(subscription: SubscriptionRecord): Promise<void>;
  getSubscription(tenantId: string): Promise<SubscriptionRecord | null>;
  purgeWebhookEvents(before: string): Promise<number>;
  /** Add one to this phone call's count for a voice tool and return the new count. Atomic across replicas. */
  incrementToolCallCount(providerCallId: string, tool: string, now: string): Promise<number>;
  /**
   * Claim a voice-tool write before its side effect. Exactly one caller gets "claimed"; others see the pending
   * claim or the finished result. A pending claim older than `staleBefore` (its owner died) can be taken over.
   */
  claimToolResult(providerCallId: string, idempotencyKey: string, now: string, staleBefore: string): Promise<ToolClaim>;
  /** A claimed write: still pending, or done with its stored result. */
  getToolResult(providerCallId: string, idempotencyKey: string): Promise<{ status: "pending" } | { status: "done"; result: unknown } | null>;
  /** Store the claimed write's result (JSON). Only a pending claim is completed; a finished one keeps its result. */
  completeToolResult(providerCallId: string, idempotencyKey: string, result: unknown, now: string): Promise<void>;
  /** Drop a pending claim whose write did not happen, so a retry may try again. */
  releaseToolResult(providerCallId: string, idempotencyKey: string): Promise<void>;
  /** Drop tool budgets and results last touched before `before`. */
  purgeToolLedger(before: string): Promise<number>;
}

export type ToolClaim = { status: "claimed" } | { status: "pending" } | { status: "done"; result: unknown };

/** Lets a voice tool's deadline cancel provider HTTP calls still in flight. */
export interface CallOptions {
  signal?: AbortSignal | undefined;
}

export interface CreateEventOptions extends CallOptions {
  /** Called with the event's provider id just before the insert is sent, so an abort can still record it. */
  onDispatch?: ((providerEventId: string) => void) | undefined;
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
    /** The shop's days off: no slot may touch one (whole days in `timezone`). */
    daysOff?: BusinessConfig["daysOff"];
  }, options?: CallOptions): Promise<AvailabilitySlot[]>;
  isFree(input: { tenantId: string; slot: AvailabilitySlot }, options?: CallOptions): Promise<boolean>;
  /** Inserts with an id derived only from attempt.idempotencyKey; a repeat of the same key never makes a second event. */
  createEvent(attempt: BookingAttempt, options?: CreateEventOptions): Promise<{ status: "confirmed" | "unknown"; providerEventId: string | null }>;
  /** The provider event id an earlier createEvent for this idempotency key left behind, or null. */
  findEvent(attempt: BookingAttempt, options?: CallOptions): Promise<string | null>;
  verifyEvent(input: { tenantId: string; providerEventId: string; slot: AvailabilitySlot }, options?: CallOptions): Promise<boolean>;
  deleteEvent(input: { tenantId: string; providerEventId: string }): Promise<void>;
}

export interface NotificationPort {
  send(notification: OutboxNotification): Promise<{ providerReceipt: string }>;
}

/**
 * The sender refused on purpose and must not be retried: texting is not approved by the carriers yet (10DLC),
 * so an owner or caller text is held, never sent. The outbox records it as "held" and moves on.
 */
export class NotificationHeldError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotificationHeldError";
  }
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
