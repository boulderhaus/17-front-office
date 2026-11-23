import { createHash } from "node:crypto";
import type { AvailabilitySlot, BookingAttempt, BusinessConfig } from "../domain/models.js";
import type { CalendarPort } from "../ports.js";
import { withTimeout } from "../application/retry.js";

interface GoogleCalendarOptions {
  clientId: string;
  clientSecret: string;
  getRefreshToken: (tenantId: string) => Promise<string | null>;
  calendarId: string;
}

export class GoogleCalendarAdapter implements CalendarPort {
  readonly #cachedAccessTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly options: GoogleCalendarOptions) {}

  async listAvailableSlots(input: {
    tenantId: string;
    windowStart: string;
    windowEnd: string;
    durationMinutes: number;
    timezone: string;
    bookableHours: BusinessConfig["bookableHours"];
    minimumLeadTimeMinutes: number;
    now: string;
  }): Promise<AvailabilitySlot[]> {
    const busy = await this.queryBusy(input.tenantId, input.windowStart, input.windowEnd);
    const slots: AvailabilitySlot[] = [];
    const stepMs = 30 * 60_000;
    const durationMs = input.durationMinutes * 60_000;
    const earliest = Math.max(Date.parse(input.windowStart), Date.parse(input.now) + input.minimumLeadTimeMinutes * 60_000);
    const firstCursor = Math.ceil(earliest / stepMs) * stepMs;
    for (let cursor = firstCursor; cursor + durationMs <= Date.parse(input.windowEnd) && slots.length < 3; cursor += stepMs) {
      const end = cursor + durationMs;
      if (isWithinBookableHours(new Date(cursor), input.timezone, input.bookableHours)
        && isWithinBookableHours(new Date(end - 1), input.timezone, input.bookableHours)
        && !busy.some((period) => cursor < Date.parse(period.end) && end > Date.parse(period.start))) {
        slots.push({ start: new Date(cursor).toISOString(), end: new Date(end).toISOString() });
      }
    }
    return slots;
  }

  async isFree(input: { tenantId: string; slot: AvailabilitySlot }): Promise<boolean> {
    return (await this.queryBusy(input.tenantId, input.slot.start, input.slot.end)).length === 0;
  }

  async createEvent(attempt: BookingAttempt): Promise<{ status: "confirmed" | "unknown"; providerEventId: string | null }> {
    const accessToken = await this.accessToken(attempt.tenantId);
    const eventId = createHash("sha256").update(attempt.idempotencyKey).digest("hex").slice(0, 32);
    const response = await withTimeout(fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.options.calendarId)}/events?sendUpdates=none`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: eventId,
          summary: `Service call — ${attempt.callerName}`,
          description: `Callback: ${attempt.callbackNumber}\nProblem: ${attempt.problemDescription}\nSource call: ${attempt.providerCallId}`,
          location: attempt.address,
          start: { dateTime: attempt.slot.start },
          end: { dateTime: attempt.slot.end },
          visibility: "private",
        }),
      },
    ), 5_000);
    if (response.status === 409) return { status: "confirmed", providerEventId: eventId };
    if (!response.ok) throw new Error(`Google Calendar insert failed with HTTP ${response.status}`);
    const event = await response.json() as { id?: string };
    return { status: "confirmed", providerEventId: event.id ?? eventId };
  }

  async verifyEvent(input: { tenantId: string; providerEventId: string; slot: AvailabilitySlot }): Promise<boolean> {
    const accessToken = await this.accessToken(input.tenantId);
    const response = await withTimeout(fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.options.calendarId)}/events/${encodeURIComponent(input.providerEventId)}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    ), 4_000);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Google Calendar verification failed with HTTP ${response.status}`);
    const event = await response.json() as { status?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
    return event.status !== "cancelled"
      && Boolean(event.start?.dateTime)
      && Boolean(event.end?.dateTime)
      && new Date(event.start!.dateTime!).toISOString() === new Date(input.slot.start).toISOString()
      && new Date(event.end!.dateTime!).toISOString() === new Date(input.slot.end).toISOString();
  }

  async deleteEvent(input: { tenantId: string; providerEventId: string }): Promise<void> {
    const accessToken = await this.accessToken(input.tenantId);
    const response = await withTimeout(fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.options.calendarId)}/events/${encodeURIComponent(input.providerEventId)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } },
    ), 4_000);
    if (response.status !== 404 && !response.ok) throw new Error(`Google Calendar delete failed with HTTP ${response.status}`);
  }

  private async queryBusy(tenantId: string, start: string, end: string): Promise<Array<{ start: string; end: string }>> {
    const accessToken = await this.accessToken(tenantId);
    const response = await withTimeout(fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: start, timeMax: end, items: [{ id: this.options.calendarId }] }),
    }), 4_000);
    if (!response.ok) throw new Error(`Google Calendar freeBusy failed with HTTP ${response.status}`);
    const payload = await response.json() as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> };
    const calendar = payload.calendars?.[this.options.calendarId];
    if (!calendar || (calendar.errors?.length ?? 0) > 0) throw new Error("Google Calendar freeBusy returned an incomplete calendar result");
    return calendar.busy ?? [];
  }

  private async accessToken(tenantId: string): Promise<string> {
    const cached = this.#cachedAccessTokens.get(tenantId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const refreshToken = await this.options.getRefreshToken(tenantId);
    if (!refreshToken) throw new Error("Google Calendar is not connected");
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    const response = await withTimeout(fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }), 4_000);
    if (!response.ok) throw new Error(`Google OAuth refresh failed with HTTP ${response.status}`);
    const payload = await response.json() as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new Error("Google OAuth response did not include an access token");
    const token = payload.access_token;
    this.#cachedAccessTokens.set(tenantId, { token, expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 3_600) * 1_000 });
    return token;
  }
}

function isWithinBookableHours(value: Date, timeZone: string, hours: BusinessConfig["bookableHours"]): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = read("weekday");
  if ((weekday === "Sat" || weekday === "Sun") && !hours.weekends) return false;
  const minute = Number(read("hour")) * 60 + Number(read("minute"));
  const toMinute = (time: string): number => {
    const [hour = "0", minuteValue = "0"] = time.split(":");
    return Number(hour) * 60 + Number(minuteValue);
  };
  return minute >= toMinute(hours.weekdayStart) && minute < toMinute(hours.weekdayEnd);
}
