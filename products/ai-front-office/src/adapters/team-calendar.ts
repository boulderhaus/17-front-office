import type { AvailabilitySlot, BookingAttempt } from "../domain/models.js";
import { createHash } from "node:crypto";
import type { CalendarPort, CallOptions, CreateEventOptions, Store } from "../ports.js";

/** BookingCoordinator owns the tenant-wide lock; assignment occurs inside it. */
export class TeamCalendar implements CalendarPort {
  constructor(private readonly store: Store, private readonly solo: CalendarPort, private readonly forAccount: (accountId: string, owner: boolean) => CalendarPort) {}

  private async members(tenantId: string) {
    const config = await this.store.getConfig(tenantId);
    const accounts = await this.store.listTeamAccounts(tenantId);
    return (config.schedulingCalendars ?? []).filter((member) => member.enabled && accounts.some((account) => account.id === member.accountId && account.status !== "suspended"))
      .map((member) => ({ ...member, calendar: this.forAccount(member.accountId, accounts.find((account) => account.id === member.accountId)?.role !== "member") }));
  }

  async listAvailableSlots(input: Parameters<CalendarPort["listAvailableSlots"]>[0], options?: CallOptions): Promise<AvailabilitySlot[]> {
    const config = await this.store.getConfig(input.tenantId);
    if (!config.schedulingCalendars?.length) return this.solo.listAvailableSlots(input, options);
    const members = await this.members(input.tenantId);
    const results = await Promise.allSettled(members.map((member) => member.calendar.listAvailableSlots({ ...input, bookableHours: member.hours }, options)));
    // A deadline is not a full calendar: never answer with the members that happened to finish first.
    options?.signal?.throwIfAborted();
    const successful = results.filter((result): result is PromiseFulfilledResult<AvailabilitySlot[]> => result.status === "fulfilled");
    if (!successful.length) throw new Error("No connected teammate calendar is available");
    return [...new Map(successful.flatMap((result) => result.value).map((slot) => [slot.start, slot])).values()].sort((a, b) => a.start.localeCompare(b.start)).slice(0, 3);
  }

  async isFree(input: Parameters<CalendarPort["isFree"]>[0], options?: CallOptions): Promise<boolean> {
    const config = await this.store.getConfig(input.tenantId);
    if (!config.schedulingCalendars?.length) return this.solo.isFree(input, options);
    return (await this.availableMembers(input, options)).length > 0;
  }

  private async availableMembers(input: { tenantId: string; slot: AvailabilitySlot }, options?: CallOptions) {
    const config = await this.store.getConfig(input.tenantId);
    const members = await this.members(input.tenantId);
    const results = await Promise.all(members.map(async (member) => {
      try {
        // Use each member's hours as well as free/busy. Never assign outside their availability.
        const slots = await member.calendar.listAvailableSlots({ tenantId: input.tenantId, windowStart: input.slot.start, windowEnd: input.slot.end, durationMinutes: (Date.parse(input.slot.end) - Date.parse(input.slot.start)) / 60_000, timezone: config.timezone, bookableHours: member.hours, minimumLeadTimeMinutes: 0, now: input.slot.start }, options);
        return slots.some((slot) => slot.start === input.slot.start && slot.end === input.slot.end) ? member : null;
      } catch {
        // A deadline must surface as the deadline, never as "this teammate is busy".
        options?.signal?.throwIfAborted();
        return null;
      }
    }));
    options?.signal?.throwIfAborted();
    return results.filter((member): member is NonNullable<typeof member> => member !== null);
  }

  /**
   * The teammate is chosen from the booking's idempotency key (a stable hash ranking of the roster), never
   * from mutable state, so a retry or another replica lands on the same calendar with the same event id.
   * The key goes to the teammate's calendar unchanged: the event id never depends on who got the job.
   */
  async createEvent(attempt: BookingAttempt, options?: CreateEventOptions): Promise<{ status: "confirmed" | "unknown"; providerEventId: string | null }> {
    const config = await this.store.getConfig(attempt.tenantId);
    if (!config.schedulingCalendars?.length) return this.solo.createEvent(attempt, options);
    const members = await this.availableMembers(attempt, options);
    if (!members.length) throw new Error("No teammate remains available for the selected time");
    const chosen = rankByKey(members, attempt.idempotencyKey)[0]!;
    // Never try a second calendar after an ambiguous write: that would create two jobs.
    const result = await chosen.calendar.createEvent(attempt, {
      signal: options?.signal,
      onDispatch: (eventId) => options?.onDispatch?.(teamEventReference(chosen.accountId, eventId)),
    });
    if (!result.providerEventId) return result;
    return { ...result, providerEventId: teamEventReference(chosen.accountId, result.providerEventId) };
  }

  /** Looks on every teammate calendar (assignment may have changed since) for the event this key created. */
  async findEvent(attempt: BookingAttempt, options?: CallOptions): Promise<string | null> {
    const config = await this.store.getConfig(attempt.tenantId);
    if (!config.schedulingCalendars?.length) return this.solo.findEvent(attempt, options);
    const accounts = await this.store.listTeamAccounts(attempt.tenantId);
    const roster = (config.schedulingCalendars ?? [])
      .map((member) => ({ accountId: member.accountId, account: accounts.find((account) => account.id === member.accountId) }))
      .filter((member) => member.account)
      .map((member) => ({ accountId: member.accountId, calendar: this.forAccount(member.accountId, member.account!.role !== "member") }));
    for (const member of rankByKey(roster, attempt.idempotencyKey)) {
      const eventId = await member.calendar.findEvent(attempt, options);
      if (eventId) return teamEventReference(member.accountId, eventId);
    }
    return null;
  }

  private async eventCalendar(tenantId: string, providerEventId: string): Promise<{ calendar: CalendarPort; eventId: string }> {
    if (!providerEventId.startsWith("fo-team:")) return { calendar: this.solo, eventId: providerEventId };
    if (providerEventId.length > 2048 || !/^fo-team:[A-Za-z0-9_-]+$/.test(providerEventId)) throw new Error("Invalid team calendar event reference");
    let value: { accountId?: unknown; eventId?: unknown };
    try { value = JSON.parse(Buffer.from(providerEventId.slice(8), "base64url").toString("utf8")) as typeof value; }
    catch { throw new Error("Invalid team calendar event reference"); }
    if (!value || typeof value.accountId !== "string" || typeof value.eventId !== "string" || !value.eventId) throw new Error("Invalid team calendar event reference");
    const account = await this.store.getOwnerAccountById(value.accountId);
    if (!account || account.tenantId !== tenantId) throw new Error("Calendar event belongs to another shop");
    return { calendar: this.forAccount(account.id, account.role !== "member"), eventId: value.eventId };
  }

  async verifyEvent(input: Parameters<CalendarPort["verifyEvent"]>[0], options?: CallOptions): Promise<boolean> {
    const target = await this.eventCalendar(input.tenantId, input.providerEventId);
    return target.calendar.verifyEvent({ ...input, providerEventId: target.eventId }, options);
  }

  async deleteEvent(input: Parameters<CalendarPort["deleteEvent"]>[0]): Promise<void> {
    const target = await this.eventCalendar(input.tenantId, input.providerEventId);
    return target.calendar.deleteEvent({ ...input, providerEventId: target.eventId });
  }
}

function teamEventReference(accountId: string, eventId: string): string {
  return `fo-team:${Buffer.from(JSON.stringify({ accountId, eventId })).toString("base64url")}`;
}

/** Stable order per booking: the same idempotency key always ranks the roster the same way. */
function rankByKey<T extends { accountId: string }>(members: T[], idempotencyKey: string): T[] {
  const rank = (accountId: string) => createHash("sha256").update(`${idempotencyKey}\u0000${accountId}`).digest("hex");
  return [...members].sort((left, right) => rank(left.accountId).localeCompare(rank(right.accountId)));
}
