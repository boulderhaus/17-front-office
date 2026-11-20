import type {
  AvailabilitySlot,
  BookingAttempt,
  BookingRecord,
  BusinessConfig,
  CallbackTask,
  CallRecord,
  CustomerRecord,
  OutboxNotification,
  ToolEvent,
} from "./domain/models.js";

export interface Store {
  ping(): Promise<void>;
  withLock<T>(key: string, task: () => Promise<T>): Promise<T>;
  claimWebhook(eventId: string): Promise<boolean>;
  getConfig(tenantId: string): Promise<BusinessConfig>;
  saveConfig(config: BusinessConfig): Promise<void>;
  getIntegrationSecret(tenantId: string, provider: string, key: string): Promise<string | null>;
  saveIntegrationSecret(tenantId: string, provider: string, key: string, value: string): Promise<void>;
  getCallByProviderId(providerCallId: string): Promise<CallRecord | null>;
  getCall(callId: string): Promise<CallRecord | null>;
  saveCall(call: CallRecord): Promise<void>;
  listCalls(tenantId: string, limit: number): Promise<CallRecord[]>;
  upsertCustomer(customer: CustomerRecord): Promise<void>;
  getBookingForCall(callId: string): Promise<BookingRecord | null>;
  saveBooking(booking: BookingRecord): Promise<void>;
  getCallbackTaskForCall(callId: string): Promise<CallbackTask | null>;
  saveCallbackTask(task: CallbackTask): Promise<void>;
  addToolEvent(event: ToolEvent): Promise<void>;
  listToolEvents(callId: string): Promise<ToolEvent[]>;
  enqueueNotification(notification: OutboxNotification): Promise<boolean>;
  claimDueNotifications(now: string, limit: number): Promise<OutboxNotification[]>;
  requeueStaleNotifications(staleBefore: string, now: string): Promise<number>;
  saveNotification(notification: OutboxNotification): Promise<void>;
  listNotifications(callId: string): Promise<OutboxNotification[]>;
}

export interface CalendarPort {
  listAvailableSlots(input: {
    tenantId: string;
    windowStart: string;
    windowEnd: string;
    durationMinutes: number;
    timezone: string;
  }): Promise<AvailabilitySlot[]>;
  isFree(input: { tenantId: string; slot: AvailabilitySlot }): Promise<boolean>;
  createEvent(attempt: BookingAttempt): Promise<{ status: "confirmed" | "unknown"; providerEventId: string | null }>;
  verifyEvent(input: { tenantId: string; providerEventId: string; slot: AvailabilitySlot }): Promise<boolean>;
}

export interface NotificationPort {
  send(notification: OutboxNotification): Promise<{ providerReceipt: string }>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
