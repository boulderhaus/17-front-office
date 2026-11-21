import { randomUUID } from "node:crypto";
import type { CalendarPort, NotificationPort, Store } from "../ports.js";
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
} from "../domain/models.js";
import { normalizeBusinessConfig } from "../domain/config.js";

class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

export class InMemoryStore implements Store {
  readonly calls = new Map<string, CallRecord>();
  readonly bookings = new Map<string, BookingRecord>();
  readonly callbackTasks = new Map<string, CallbackTask>();
  readonly toolEvents = new Map<string, ToolEvent[]>();
  readonly notifications = new Map<string, OutboxNotification>();
  readonly configs = new Map<string, BusinessConfig>();
  readonly customers = new Map<string, CustomerRecord>();
  readonly webhookEvents = new Map<string, string>();
  readonly deletedProviderCalls = new Set<string>();
  readonly integrationSecrets = new Map<string, string>();
  readonly smsOptOuts = new Map<string, boolean>();
  readonly #mutex = new KeyedMutex();

  async ping(): Promise<void> {}

  async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    return this.#mutex.run(key, task);
  }

  async claimWebhook(eventId: string): Promise<boolean> {
    if (this.webhookEvents.has(eventId)) return false;
    this.webhookEvents.set(eventId, new Date().toISOString());
    return true;
  }

  async getConfig(tenantId: string): Promise<BusinessConfig> {
    const config = this.configs.get(tenantId);
    if (!config) throw new Error(`No business configuration for tenant ${tenantId}`);
    return structuredClone(normalizeBusinessConfig(config));
  }

  async saveConfig(config: BusinessConfig): Promise<void> {
    this.configs.set(config.tenantId, structuredClone(config));
  }

  async getIntegrationSecret(tenantId: string, provider: string, key: string): Promise<string | null> {
    return this.integrationSecrets.get(`${tenantId}:${provider}:${key}`) ?? null;
  }

  async saveIntegrationSecret(tenantId: string, provider: string, key: string, value: string): Promise<void> {
    this.integrationSecrets.set(`${tenantId}:${provider}:${key}`, value);
  }

  async getCallByProviderId(providerCallId: string): Promise<CallRecord | null> {
    return structuredClone([...this.calls.values()].find((call) => call.providerCallId === providerCallId) ?? null);
  }

  async isProviderCallDeleted(providerCallId: string): Promise<boolean> {
    return this.deletedProviderCalls.has(providerCallId);
  }

  async getCall(callId: string): Promise<CallRecord | null> {
    return structuredClone(this.calls.get(callId) ?? null);
  }

  async saveCall(call: CallRecord): Promise<void> {
    this.calls.set(call.id, structuredClone(call));
  }

  async listCalls(tenantId: string, limit: number): Promise<CallRecord[]> {
    return [...this.calls.values()]
      .filter((call) => call.tenantId === tenantId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((call) => structuredClone(call));
  }

  async countCallsFromNumberSince(tenantId: string, phone: string, since: string): Promise<number> {
    return [...this.calls.values()].filter((call) => call.tenantId === tenantId && call.fromNumber === phone && call.startedAt >= since).length;
  }

  async listExpiredCalls(tenantId: string, endedBefore: string, limit: number): Promise<CallRecord[]> {
    return [...this.calls.values()]
      .filter((call) => call.tenantId === tenantId && call.endedAt !== null && call.endedAt < endedBefore)
      .sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? ""))
      .slice(0, limit)
      .map((call) => structuredClone(call));
  }

  async deleteCall(tenantId: string, callId: string): Promise<boolean> {
    const call = this.calls.get(callId);
    if (!call || call.tenantId !== tenantId) return false;
    this.deletedProviderCalls.add(call.providerCallId);
    this.calls.delete(callId);
    for (const [id, booking] of this.bookings) if (booking.callId === callId) this.bookings.delete(id);
    for (const [id, task] of this.callbackTasks) if (task.callId === callId) this.callbackTasks.delete(id);
    this.toolEvents.delete(callId);
    for (const [id, notification] of this.notifications) if (notification.callId === callId) this.notifications.delete(id);
    for (const [key, customer] of this.customers) if (customer.lastCallId === callId) this.customers.delete(key);
    return true;
  }

  async deleteExpiredCalls(tenantId: string, endedBefore: string): Promise<number> {
    const ids = [...this.calls.values()]
      .filter((call) => call.tenantId === tenantId && call.endedAt !== null && call.endedAt < endedBefore)
      .map((call) => call.id);
    for (const id of ids) await this.deleteCall(tenantId, id);
    return ids.length;
  }

  async upsertCustomer(customer: CustomerRecord): Promise<void> {
    const key = `${customer.tenantId}:${customer.phone}`;
    const existing = this.customers.get(key);
    this.customers.set(key, structuredClone(existing ? { ...customer, id: existing.id, createdAt: existing.createdAt } : customer));
  }

  async getBookingForCall(callId: string): Promise<BookingRecord | null> {
    return structuredClone([...this.bookings.values()].find((booking) => booking.callId === callId) ?? null);
  }

  async saveBooking(booking: BookingRecord): Promise<void> {
    this.bookings.set(booking.id, structuredClone(booking));
  }

  async getCallbackTaskForCall(callId: string): Promise<CallbackTask | null> {
    return structuredClone([...this.callbackTasks.values()].find((task) => task.callId === callId) ?? null);
  }

  async saveCallbackTask(task: CallbackTask): Promise<void> {
    const existing = [...this.callbackTasks.values()].find((item) => item.callId === task.callId);
    this.callbackTasks.set(existing?.id ?? task.id, structuredClone(existing ? { ...task, id: existing.id, createdAt: existing.createdAt } : task));
  }

  async addToolEvent(event: ToolEvent): Promise<void> {
    const events = this.toolEvents.get(event.callId) ?? [];
    events.push(structuredClone(event));
    this.toolEvents.set(event.callId, events);
  }

  async listToolEvents(callId: string): Promise<ToolEvent[]> {
    return structuredClone(this.toolEvents.get(callId) ?? []);
  }

  async enqueueNotification(notification: OutboxNotification): Promise<boolean> {
    if ([...this.notifications.values()].some((item) => item.idempotencyKey === notification.idempotencyKey)) return false;
    this.notifications.set(notification.id, structuredClone(notification));
    return true;
  }

  async claimDueNotifications(now: string, limit: number): Promise<OutboxNotification[]> {
    const candidates = [...this.notifications.values()]
      .filter((item) => (item.state === "pending" || item.state === "retry") && item.nextAttemptAt <= now)
      .sort((left, right) => (left.priority === right.priority ? left.createdAt.localeCompare(right.createdAt) : left.priority === "high" ? -1 : 1))
      .slice(0, limit);
    for (const item of candidates) {
      item.state = "sending";
      item.attempts += 1;
      this.notifications.set(item.id, item);
    }
    return structuredClone(candidates);
  }

  async requeueStaleNotifications(staleBefore: string, now: string): Promise<number> {
    let count = 0;
    for (const [id, notification] of this.notifications) {
      if (notification.state !== "sending" || notification.nextAttemptAt > staleBefore) continue;
      this.notifications.set(id, { ...notification, state: "retry", nextAttemptAt: now, lastError: "Recovered after interrupted delivery" });
      count += 1;
    }
    return count;
  }

  async saveNotification(notification: OutboxNotification): Promise<void> {
    this.notifications.set(notification.id, structuredClone(notification));
  }

  async getNotificationByProviderReceipt(providerReceipt: string): Promise<OutboxNotification | null> {
    return structuredClone([...this.notifications.values()].find((item) => item.providerReceipt === providerReceipt) ?? null);
  }

  async listNotifications(callId: string): Promise<OutboxNotification[]> {
    return [...this.notifications.values()]
      .filter((item) => item.callId === callId)
      .map((item) => structuredClone(item));
  }


  async setSmsOptOut(tenantId: string, phone: string, optedOut: boolean): Promise<void> {
    this.smsOptOuts.set(`${tenantId}:${phone}`, optedOut);
  }

  async isSmsOptedOut(tenantId: string, phone: string): Promise<boolean> {
    return this.smsOptOuts.get(`${tenantId}:${phone}`) === true;
  }

  async purgeWebhookEvents(before: string): Promise<number> {
    let purged = 0;
    for (const [eventId, receivedAt] of this.webhookEvents) {
      if (receivedAt >= before) continue;
      this.webhookEvents.delete(eventId);
      purged += 1;
    }
    return purged;
  }
}

export class InMemoryCalendar implements CalendarPort {
  readonly events: Array<{ slot: AvailabilitySlot; eventId: string }> = [];
  failAvailability = false;
  failCreate: "none" | "known" | "unknown" = "none";
  failVerify = false;

  async listAvailableSlots(input: {
    windowStart: string;
    windowEnd: string;
    durationMinutes: number;
    timezone: string;
    bookableHours: BusinessConfig["bookableHours"];
    minimumLeadTimeMinutes: number;
    now: string;
  }): Promise<AvailabilitySlot[]> {
    if (this.failAvailability) throw new Error("Calendar unavailable");
    const earliest = Date.parse(input.now) + input.minimumLeadTimeMinutes * 60_000;
    const start = new Date(Math.max(Date.parse(input.windowStart), earliest));
    const end = new Date(start.getTime() + input.durationMinutes * 60_000);
    if (end.toISOString() > input.windowEnd) return [];
    const slot = { start: start.toISOString(), end: end.toISOString() };
    const available = isWithinBookableHours(slot.start, input.timezone, input.bookableHours)
      && await this.isFree({ tenantId: "demo", slot });
    return available ? [slot] : [];
  }

  async isFree(input: { tenantId: string; slot: AvailabilitySlot }): Promise<boolean> {
    if (this.failAvailability) throw new Error("Calendar unavailable");
    const start = Date.parse(input.slot.start);
    const end = Date.parse(input.slot.end);
    return !this.events.some((event) => start < Date.parse(event.slot.end) && end > Date.parse(event.slot.start));
  }

  async createEvent(attempt: BookingAttempt): Promise<{ status: "confirmed" | "unknown"; providerEventId: string | null }> {
    if (this.failCreate === "known") throw new Error("Calendar rejected event");
    if (this.failCreate === "unknown") return { status: "unknown", providerEventId: null };
    if (!(await this.isFree({ tenantId: attempt.tenantId, slot: attempt.slot }))) throw new Error("Calendar conflict");
    const eventId = `demo-${randomUUID()}`;
    this.events.push({ slot: structuredClone(attempt.slot), eventId });
    return { status: "confirmed", providerEventId: eventId };
  }

  async verifyEvent(input: { providerEventId: string; slot: AvailabilitySlot }): Promise<boolean> {
    if (this.failVerify) return false;
    return this.events.some((event) => event.eventId === input.providerEventId && event.slot.start === input.slot.start && event.slot.end === input.slot.end);
  }

  async deleteEvent(input: { tenantId: string; providerEventId: string }): Promise<void> {
    const index = this.events.findIndex((event) => event.eventId === input.providerEventId);
    if (index >= 0) this.events.splice(index, 1);
  }
}

function isWithinBookableHours(start: string, timeZone: string, hours: BusinessConfig["bookableHours"]): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(start));
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = read("weekday");
  if ((weekday === "Sat" || weekday === "Sun") && !hours.weekends) return false;
  const minute = Number(read("hour")) * 60 + Number(read("minute"));
  const toMinute = (value: string): number => {
    const [h = "0", m = "0"] = value.split(":");
    return Number(h) * 60 + Number(m);
  };
  return minute >= toMinute(hours.weekdayStart) && minute < toMinute(hours.weekdayEnd);
}

export class CapturingNotificationSender implements NotificationPort {
  readonly sent: OutboxNotification[] = [];
  fail = false;

  async send(notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    if (this.fail) throw new Error("SMS provider timeout");
    this.sent.push(structuredClone(notification));
    return { providerReceipt: `demo-message-${this.sent.length}` };
  }
}
