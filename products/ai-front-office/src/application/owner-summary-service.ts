import { randomUUID } from "node:crypto";
import type { BusinessConfig, CallRecord, CallbackTask, OutboxNotification } from "../domain/models.js";
import type { Clock, Store } from "../ports.js";
import { formatEmailBody } from "../adapters/resend.js";
import { isPaidStatus } from "../domain/billing.js";

export class OwnerSummaryService {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly publicBaseUrl: string,
  ) {}

  async runOnce(): Promise<{ smsQueued: number; emailQueued: number }> {
    const result = { smsQueued: 0, emailQueued: 0 };
    for (const tenantId of await this.store.listTenantIds()) {
      const queued = await this.runTenant(tenantId);
      result.smsQueued += queued.smsQueued;
      result.emailQueued += queued.emailQueued;
    }
    return result;
  }

  private async runTenant(tenantId: string): Promise<{ smsQueued: number; emailQueued: number }> {
    const now = this.clock.now();
    const [config, account, subscription, tasks, calls] = await Promise.all([
      this.store.getConfig(tenantId),
      this.store.getOwnerAccountByTenant(tenantId),
      this.store.getSubscription(tenantId),
      this.store.listCallbackTasks(tenantId, 200),
      this.store.listCalls(tenantId, 250),
    ]);
    if (!account || account.status === "suspended") return { smsQueued: 0, emailQueued: 0 };
    const local = localParts(now, config.timezone);
    const openTasks = tasks.filter((task) => task.status === "open" || (task.status === "snoozed" && Date.parse(task.dueAt) <= now.getTime()));
    const upcoming = upcomingBookedCalls(calls, now, 7);
    let smsQueued = 0;
    let emailQueued = 0;

    // The daily recap is included in every plan: it goes to live shops that are paying (or have no Stripe
    // subscription at all, e.g. set up by hand), never to an unpaid signup or a lapsed shop.
    const paying = account.status === "active" && (!subscription || isPaidStatus(subscription.status));
    if (paying && config.ownerDailySmsEnabled && local.hour >= config.ownerDailySmsHour) {
      const body = dailySmsBody(openTasks, upcomingBookedCalls(calls, now, 1), this.dashboardUrl());
      for (const destinationRef of config.ownerNotificationRefs) {
        if (await this.store.enqueueNotification(notification({
          tenantId,
          channel: "sms",
          destinationRef,
          body,
          idempotencyKey: `owner-daily-digest:${tenantId}:${local.date}:${destinationRef}`,
          now,
        }))) smsQueued += 1;
      }
    }

    if (config.ownerWeeklyEmailEnabled && local.weekday === "Sun" && local.hour >= 7) {
      const body = formatEmailBody(
        `${config.businessName}: your week ahead`,
        weeklyEmailBody(config, openTasks, upcoming, this.dashboardUrl(), now),
      );
      if (await this.store.enqueueNotification(notification({
        tenantId,
        channel: "email",
        destinationRef: `email:${account.email}`,
        body,
        idempotencyKey: `owner-weekly-email:${tenantId}:${local.date}`,
        now,
      }))) emailQueued += 1;
    }
    return { smsQueued, emailQueued };
  }

  private dashboardUrl(): string {
    return `${this.publicBaseUrl.replace(/\/$/, "")}/app`;
  }
}

function notification(input: {
  tenantId: string;
  channel: "sms" | "email";
  destinationRef: string;
  body: string;
  idempotencyKey: string;
  now: Date;
}): OutboxNotification {
  const stamp = input.now.toISOString();
  return {
    id: randomUUID(), tenantId: input.tenantId, callId: null, channel: input.channel,
    destinationRef: input.destinationRef, body: input.body, priority: "normal", state: "pending",
    attempts: 0, nextAttemptAt: stamp, idempotencyKey: input.idempotencyKey,
    providerReceipt: null, lastError: null, createdAt: stamp, sentAt: null,
  };
}

function localParts(at: Date, timeZone: string): { date: string; weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${read("year")}-${read("month")}-${read("day")}`, weekday: read("weekday"), hour: Number(read("hour")) };
}

function upcomingBookedCalls(calls: CallRecord[], now: Date, days: number): CallRecord[] {
  const end = now.getTime() + days * 24 * 60 * 60_000;
  return calls.filter((call) => {
    const start = call.fields.requestedStart ? Date.parse(call.fields.requestedStart) : Number.NaN;
    return call.outcome === "booked" && start >= now.getTime() && start < end;
  }).sort((left, right) => (left.fields.requestedStart ?? "").localeCompare(right.fields.requestedStart ?? ""));
}

function dailySmsBody(tasks: CallbackTask[], appointments: CallRecord[], dashboardUrl: string): string {
  const urgent = tasks.filter((task) => task.priority === "high").length;
  return [
    "Front Office: Today",
    `${tasks.length} follow-up${tasks.length === 1 ? "" : "s"}${urgent ? ` (${urgent} urgent)` : ""}`,
    `${appointments.length} appointment${appointments.length === 1 ? "" : "s"} in the next 24 hours`,
    dashboardUrl,
  ].join("\n");
}

function weeklyEmailBody(config: BusinessConfig, tasks: CallbackTask[], appointments: CallRecord[], dashboardUrl: string, now: Date): string {
  const format = (value: string): string => new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
  const appointmentLines = appointments.slice(0, 12).map((call) => `- ${format(call.fields.requestedStart!)} — ${call.fields.callerName ?? "Caller"}: ${call.fields.problemDescription || "Service appointment"}`);
  return [
    `Here’s what ${config.businessName} has coming up for the next seven days.`,
    "",
    `${tasks.length} open follow-up${tasks.length === 1 ? "" : "s"}`,
    `${appointments.length} booked appointment${appointments.length === 1 ? "" : "s"}`,
    ...(appointmentLines.length ? ["", "Appointments", ...appointmentLines] : []),
    "",
    `Open Front Office: ${dashboardUrl}`,
    "",
    `Prepared ${new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, dateStyle: "medium" }).format(now)}.`,
  ].join("\n");
}
