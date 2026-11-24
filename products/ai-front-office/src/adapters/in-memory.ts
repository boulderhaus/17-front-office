import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { CalendarPort, CallOptions, CreateEventOptions, NotificationPort, Store, ToolClaim } from "../ports.js";
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
} from "../domain/models.js";
import { normalizeBusinessConfig } from "../domain/config.js";
import { billedMinutesFor, usageClass } from "../domain/usage.js";

/** Re-entrant per async call chain, like the Postgres store's session-level advisory locks. */
class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #held = new AsyncLocalStorage<ReadonlySet<string>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const held = this.#held.getStore() ?? new Set<string>();
    if (held.has(key)) return task();
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await this.#held.run(new Set([...held, key]), task);
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
  readonly pilotSignups = new Map<string, PilotSignup>();
  readonly ownerAccounts = new Map<string, OwnerAccount>();
  readonly providerRoutes = new Map<string, ProviderRoute>();
  readonly subscriptions = new Map<string, SubscriptionRecord>();
  readonly retentionFailures = new Map<string, string>();
  readonly toolCallCounts = new Map<string, { count: number; updatedAt: string }>();
  readonly toolResults = new Map<string, { result: string | null; claimedAt: string; createdAt: string }>();
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

  async listTenantIds(): Promise<string[]> {
    return [...this.configs.keys()].sort();
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

  async deleteIntegrationSecret(tenantId: string, provider: string, key: string): Promise<void> {
    this.integrationSecrets.delete(`${tenantId}:${provider}:${key}`);
  }

  async backfillInboundNumberLookups(): Promise<{ updated: number; conflicts: number }> {
    return { updated: 0, conflicts: 0 }; // lookups read the values directly
  }

  async getTenantIdByInboundNumber(phoneNumber: string): Promise<string | null> {
    for (const [key, value] of this.integrationSecrets) {
      if (key.endsWith(":telnyx:inbound_number") && value === phoneNumber) return key.slice(0, -":telnyx:inbound_number".length);
    }
    return null;
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

  async listInProgressCalls(startedAfter: string, limit: number): Promise<CallRecord[]> {
    const after = Date.parse(startedAfter);
    return [...this.calls.values()]
      .filter((call) => call.outcome === "in_progress" && Date.parse(call.startedAt) >= after)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .slice(0, limit)
      .map((call) => structuredClone(call));
  }

  async listCallsStartedBetween(tenantId: string, from: string, to: string, limit: number): Promise<CallRecord[]> {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    return [...this.calls.values()]
      .filter((call) => call.tenantId === tenantId && Date.parse(call.startedAt) >= fromMs && Date.parse(call.startedAt) < toMs)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .slice(0, limit)
      .map((call) => structuredClone(call));
  }

  async listCallbackTasksForCalls(tenantId: string, callIds: string[]): Promise<CallbackTask[]> {
    const wanted = new Set(callIds);
    return structuredClone([...this.callbackTasks.values()].filter((task) => task.tenantId === tenantId && wanted.has(task.callId)));
  }

  async countCallsFromNumberSince(tenantId: string, phone: string, since: string): Promise<number> {
    return [...this.calls.values()].filter((call) => call.tenantId === tenantId && call.fromNumber === phone && call.startedAt >= since).length;
  }

  async listExpiredCalls(tenantId: string, endedBefore: string, limit: number, now: string): Promise<CallRecord[]> {
    const retryAfter = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
    return [...this.calls.values()]
      .filter((call) => call.tenantId === tenantId && call.endedAt !== null && call.endedAt < endedBefore)
      .filter((call) => { const failed = this.retentionFailures.get(call.id); return !failed || failed < retryAfter; })
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

  async deleteWorkspace(tenantId: string): Promise<void> {
    for (const call of [...this.calls.values()].filter((item) => item.tenantId === tenantId)) await this.deleteCall(tenantId, call.id);
    for (const [id, notification] of this.notifications) if (notification.tenantId === tenantId) this.notifications.delete(id);
    for (const key of [...this.integrationSecrets.keys()]) if (key.startsWith(`${tenantId}:`)) this.integrationSecrets.delete(key);
    for (const key of [...this.smsOptOuts.keys()]) if (key.startsWith(`${tenantId}:`)) this.smsOptOuts.delete(key);
    for (const [key, route] of this.providerRoutes) if (route.tenantId === tenantId) this.providerRoutes.delete(key);
    for (const [id, account] of this.ownerAccounts) if (account.tenantId === tenantId) this.ownerAccounts.delete(id);
    this.subscriptions.delete(tenantId);
    this.configs.delete(tenantId);
  }

  async markRetentionFailed(callId: string, at: string): Promise<void> {
    if (this.calls.has(callId)) this.retentionFailures.set(callId, at);
  }

  async upsertCustomer(customer: CustomerRecord): Promise<void> {
    const key = `${customer.tenantId}:${customer.phone}`;
    const existing = this.customers.get(key);
    this.customers.set(key, structuredClone(existing ? { ...customer, id: existing.id, createdAt: existing.createdAt } : customer));
  }

  async isKnownCustomer(tenantId: string, phone: string): Promise<boolean> {
    return this.customers.has(`${tenantId}:${phone}`);
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

  async listOpenCallbackTasks(tenantId: string, limit: number): Promise<CallbackTask[]> {
    return structuredClone([...this.callbackTasks.values()]
      .filter((task) => task.tenantId === tenantId && task.status === "open")
      .sort((left, right) => {
        if (left.priority !== right.priority) return left.priority === "high" ? -1 : 1;
        return left.dueAt.localeCompare(right.dueAt);
      })
      .slice(0, limit));
  }

  async listCallbackTasks(tenantId: string, limit: number): Promise<CallbackTask[]> {
    return structuredClone([...this.callbackTasks.values()]
      .filter((task) => task.tenantId === tenantId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit));
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

  async cancelPendingNotification(idempotencyKey: string): Promise<boolean> {
    const item = [...this.notifications.values()].find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (!item || (item.state !== "pending" && item.state !== "retry")) return false;
    item.state = "cancelled";
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

  async savePilotSignup(signup: PilotSignup): Promise<void> {
    const key = signup.email.toLowerCase();
    const existing = this.pilotSignups.get(key);
    this.pilotSignups.set(key, structuredClone(existing
      ? { ...signup, id: existing.id, status: existing.status, createdAt: existing.createdAt }
      : signup));
  }

  async listPilotSignups(limit: number): Promise<PilotSignup[]> {
    return [...this.pilotSignups.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((signup) => structuredClone(signup));
  }

  async createOwnerWorkspace(input: OwnerWorkspaceInput): Promise<boolean> {
    const emailKey = input.account.email.trim().toLowerCase();
    if ([...this.ownerAccounts.values()].some((account) => account.email.toLowerCase() === emailKey || account.tenantId === input.account.tenantId)) return false;
    this.configs.set(input.config.tenantId, structuredClone(input.config));
    if (input.ownerPhone) this.integrationSecrets.set(`${input.config.tenantId}:notifications:owner-primary`, input.ownerPhone);
    this.ownerAccounts.set(input.account.id, structuredClone(input.account));
    return true;
  }

  async getOwnerAccountByEmail(email: string): Promise<OwnerAccount | null> {
    const normalized = email.trim().toLowerCase();
    return structuredClone([...this.ownerAccounts.values()].find((account) => account.email.toLowerCase() === normalized) ?? null);
  }

  async createTeamAccount(account: OwnerAccount): Promise<boolean> {
    if (await this.getOwnerAccountByEmail(account.email) || !this.configs.has(account.tenantId)) return false;
    this.ownerAccounts.set(account.id, structuredClone({ ...account, role: "member" }));
    return true;
  }

  async listTeamAccounts(tenantId: string): Promise<OwnerAccount[]> {
    return structuredClone([...this.ownerAccounts.values()].filter((account) => account.tenantId === tenantId));
  }

  async getOwnerAccountById(accountId: string): Promise<OwnerAccount | null> {
    return structuredClone(this.ownerAccounts.get(accountId) ?? null);
  }

  async getOwnerAccountByTenant(tenantId: string): Promise<OwnerAccount | null> {
    return structuredClone([...this.ownerAccounts.values()].find((account) => account.tenantId === tenantId && account.role !== "member") ?? null);
  }

  async listOwnerAccounts(limit: number): Promise<OwnerAccount[]> {
    return [...this.ownerAccounts.values()]
      .filter((account) => account.role !== "member")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((account) => structuredClone(account));
  }

  readonly passwordResets = new Map<string, { accountId: string; expiresAt: string; usedAt: string | null }>();

  async createPasswordReset(accountId: string, tokenHash: string, expiresAt: string): Promise<void> {
    this.passwordResets.set(tokenHash, { accountId, expiresAt, usedAt: null });
  }

  async consumePasswordReset(tokenHash: string, now: string): Promise<string | null> {
    const reset = this.passwordResets.get(tokenHash);
    if (!reset || reset.usedAt || reset.expiresAt <= now) return null;
    reset.usedAt = now;
    return reset.accountId;
  }

  async updateOwnerPassword(accountId: string, passwordHash: string, updatedAt: string): Promise<void> {
    const account = this.ownerAccounts.get(accountId);
    if (account) this.ownerAccounts.set(accountId, { ...account, passwordHash, sessionVersion: (account.sessionVersion ?? 0) + 1, updatedAt });
    for (const [hash, reset] of this.passwordResets) if (reset.accountId === accountId) this.passwordResets.delete(hash);
  }

  async listBookingsForTenant(tenantId: string): Promise<BookingRecord[]> {
    return [...this.bookings.values()].filter((booking) => booking.tenantId === tenantId).map((booking) => structuredClone(booking));
  }

  async revokeOwnerSessions(accountId: string, updatedAt: string): Promise<void> {
    const account = this.ownerAccounts.get(accountId);
    if (account) this.ownerAccounts.set(accountId, { ...account, sessionVersion: (account.sessionVersion ?? 0) + 1, updatedAt });
  }

  async updateOwnerAccountStatus(accountId: string, status: OwnerAccount["status"], updatedAt: string): Promise<boolean> {
    const account = this.ownerAccounts.get(accountId);
    if (!account) return false;
    this.ownerAccounts.set(accountId, { ...account, status, updatedAt });
    return true;
  }

  async getUsageSummary(tenantId: string, periodStart: string, periodEnd: string): Promise<UsageSummary> {
    const calls = [...this.calls.values()].filter((call) => call.tenantId === tenantId && call.startedAt >= periodStart && call.startedAt < periodEnd);
    const billable = calls.filter((call) => usageClass(call) === "billable");
    return {
      periodStart,
      periodEnd,
      billableCalls: billable.length,
      excludedSpamCalls: calls.filter((call) => usageClass(call) === "spam").length,
      excludedShortCalls: calls.filter((call) => usageClass(call) === "short").length,
      billedMinutes: billable.reduce((total, call) => total + billedMinutesFor(call), 0),
    };
  }

  async saveProviderRoute(route: ProviderRoute): Promise<void> {
    this.providerRoutes.set(`${route.provider}:${route.externalId}`, structuredClone(route));
  }

  async getProviderRoute(provider: ProviderRoute["provider"], externalId: string): Promise<ProviderRoute | null> {
    return structuredClone(this.providerRoutes.get(`${provider}:${externalId}`) ?? null);
  }

  async getProviderRouteForTenant(provider: ProviderRoute["provider"], tenantId: string): Promise<ProviderRoute | null> {
    return structuredClone([...this.providerRoutes.values()].find((route) => route.provider === provider && route.tenantId === tenantId) ?? null);
  }

  async saveSubscription(subscription: SubscriptionRecord): Promise<void> {
    const existing = this.subscriptions.get(subscription.tenantId);
    if (existing && existing.providerEventCreatedAt > subscription.providerEventCreatedAt) return;
    this.subscriptions.set(subscription.tenantId, structuredClone(subscription));
  }

  async getSubscription(tenantId: string): Promise<SubscriptionRecord | null> {
    return structuredClone(this.subscriptions.get(tenantId) ?? null);
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

  async incrementToolCallCount(providerCallId: string, tool: string, now: string): Promise<number> {
    const key = `${providerCallId}\u0000${tool}`;
    const count = (this.toolCallCounts.get(key)?.count ?? 0) + 1;
    this.toolCallCounts.set(key, { count, updatedAt: now });
    return count;
  }

  async claimToolResult(providerCallId: string, idempotencyKey: string, now: string, staleBefore: string): Promise<ToolClaim> {
    const key = `${providerCallId}\u0000${idempotencyKey}`;
    const existing = this.toolResults.get(key);
    if (!existing) {
      this.toolResults.set(key, { result: null, claimedAt: now, createdAt: now });
      return { status: "claimed" };
    }
    if (existing.result === null && Date.parse(existing.claimedAt) < Date.parse(staleBefore)) {
      existing.claimedAt = now;
      return { status: "claimed" };
    }
    return existing.result === null ? { status: "pending" } : { status: "done", result: JSON.parse(existing.result) as unknown };
  }

  async getToolResult(providerCallId: string, idempotencyKey: string): Promise<{ status: "pending" } | { status: "done"; result: unknown } | null> {
    const existing = this.toolResults.get(`${providerCallId}\u0000${idempotencyKey}`);
    if (!existing) return null;
    return existing.result === null ? { status: "pending" } : { status: "done", result: JSON.parse(existing.result) as unknown };
  }

  async completeToolResult(providerCallId: string, idempotencyKey: string, result: unknown, _now: string): Promise<void> {
    const existing = this.toolResults.get(`${providerCallId}\u0000${idempotencyKey}`);
    // Serialized like the jsonb column, so both stores hand back the same value.
    if (existing && existing.result === null) existing.result = JSON.stringify(result ?? null);
  }

  async releaseToolResult(providerCallId: string, idempotencyKey: string): Promise<void> {
    const key = `${providerCallId}\u0000${idempotencyKey}`;
    if (this.toolResults.get(key)?.result === null) this.toolResults.delete(key);
  }

  async purgeToolLedger(before: string): Promise<number> {
    let purged = 0;
    for (const [key, entry] of this.toolCallCounts) {
      if (Date.parse(entry.updatedAt) >= Date.parse(before)) continue;
      this.toolCallCounts.delete(key);
      purged += 1;
    }
    for (const [key, entry] of this.toolResults) {
      if (Date.parse(entry.createdAt) >= Date.parse(before)) continue;
      this.toolResults.delete(key);
      purged += 1;
    }
    return purged;
  }
}

export class InMemoryCalendar implements CalendarPort {
  readonly events: Array<{ slot: AvailabilitySlot; eventId: string; idempotencyKey?: string }> = [];
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
  }, options?: CallOptions): Promise<AvailabilitySlot[]> {
    options?.signal?.throwIfAborted();
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

  async isFree(input: { tenantId: string; slot: AvailabilitySlot }, options?: CallOptions): Promise<boolean> {
    options?.signal?.throwIfAborted();
    if (this.failAvailability) throw new Error("Calendar unavailable");
    const start = Date.parse(input.slot.start);
    const end = Date.parse(input.slot.end);
    return !this.events.some((event) => start < Date.parse(event.slot.end) && end > Date.parse(event.slot.start));
  }

  async createEvent(attempt: BookingAttempt, options?: CreateEventOptions): Promise<{ status: "confirmed" | "unknown"; providerEventId: string | null }> {
    options?.signal?.throwIfAborted();
    if (this.failCreate === "known") throw new Error("Calendar rejected event");
    if (this.failCreate === "unknown") return { status: "unknown", providerEventId: null };
    // Like Google's 409 on a client-chosen id: the same idempotency key is the same event.
    const eventId = `demo-${createHash("sha256").update(attempt.idempotencyKey).digest("hex").slice(0, 32)}`;
    if (this.events.some((event) => event.eventId === eventId)) return { status: "confirmed", providerEventId: eventId };
    if (!(await this.isFree({ tenantId: attempt.tenantId, slot: attempt.slot }))) throw new Error("Calendar conflict");
    options?.onDispatch?.(eventId);
    this.events.push({ slot: structuredClone(attempt.slot), eventId, idempotencyKey: attempt.idempotencyKey });
    return { status: "confirmed", providerEventId: eventId };
  }

  async findEvent(attempt: BookingAttempt, options?: CallOptions): Promise<string | null> {
    options?.signal?.throwIfAborted();
    return this.events.find((event) => event.idempotencyKey === attempt.idempotencyKey)?.eventId ?? null;
  }

  async verifyEvent(input: { providerEventId: string; slot: AvailabilitySlot }, options?: CallOptions): Promise<boolean> {
    options?.signal?.throwIfAborted();
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
  if (weekday === "Sun" && !hours.weekends) return false;
  if (weekday === "Sat" && !hours.weekends && !hours.saturday) return false;
  const minute = Number(read("hour")) * 60 + Number(read("minute"));
  const toMinute = (value: string): number => {
    const [h = "0", m = "0"] = value.split(":");
    return Number(h) * 60 + Number(m);
  };
  const end = weekday === "Sat" && !hours.weekends && hours.saturdayEnd ? hours.saturdayEnd : hours.weekdayEnd;
  return minute >= toMinute(hours.weekdayStart) && minute < toMinute(end);
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
