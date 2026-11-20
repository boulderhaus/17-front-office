import type { AvailabilitySlot, BookingAttempt, OutboxNotification } from "../domain/models.js";
import type { CalendarPort, NotificationPort } from "../ports.js";

export class UnavailableCalendar implements CalendarPort {
  async listAvailableSlots(_input: { tenantId: string; windowStart: string; windowEnd: string; durationMinutes: number; timezone: string }): Promise<AvailabilitySlot[]> {
    throw new Error("Calendar integration is not configured");
  }

  async isFree(_input: { tenantId: string; slot: AvailabilitySlot }): Promise<boolean> {
    throw new Error("Calendar integration is not configured");
  }

  async createEvent(_attempt: BookingAttempt): Promise<{ status: "confirmed" | "unknown"; providerEventId: string | null }> {
    throw new Error("Calendar integration is not configured");
  }

  async verifyEvent(_input: { tenantId: string; providerEventId: string; slot: AvailabilitySlot }): Promise<boolean> {
    throw new Error("Calendar integration is not configured");
  }
}

export class UnavailableNotificationSender implements NotificationPort {
  async send(_notification: OutboxNotification): Promise<{ providerReceipt: string }> {
    throw new Error("SMS integration is not configured");
  }
}
