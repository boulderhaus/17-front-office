import { describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { BookingCoordinator } from "../src/application/booking-coordinator.js";
import { createDemoConfig } from "../src/domain/config.js";

const clock = { now: () => new Date("2026-01-15T08:00:00Z") };
const input = (callId: string) => ({ tenantId: "demo", callId, providerCallId: `p-${callId}`, requestedStart: "2026-01-15T15:00:00.000Z", durationMinutes: 60, callerName: "Synthetic", callbackNumber: "+12175550100", address: "1 Main St, Springfield IL", problemDescription: "Tune-up" });

describe("booking under failure", () => {
  it("keeps the event id and marks the booking unknown when read-back fails after the write", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const calendar = new InMemoryCalendar();
    calendar.verifyEvent = async () => { throw new Error("Operation timed out after 1200ms"); };
    const booking = await new BookingCoordinator(store, calendar, clock).book(input("c1"));
    expect(booking.status).toBe("unknown");
    expect(booking.providerEventId).toBeTruthy();
    expect(calendar.events).toHaveLength(1);
    // A retry must not report a conflict against the shop's own event or write a second one.
    const retry = await new BookingCoordinator(store, calendar, clock).book(input("c1"));
    expect(retry.status).toBe("unknown");
    expect(calendar.events).toHaveLength(1);
  });

  it("falls back to owner confirmation instead of failing when the calendar lock is busy", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    store.withLock = async () => { throw new Error("Lock wait timed out for calendar"); };
    const booking = await new BookingCoordinator(store, new InMemoryCalendar(), clock).book(input("c2"));
    expect(booking.status).toBe("pending");
    expect(booking.failureReason).toContain("busy");
  });

  it("never lets a failed audit write turn a confirmed booking into pending", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    store.addToolEvent = async () => { throw new Error("audit write failed"); };
    const booking = await new BookingCoordinator(store, new InMemoryCalendar(), clock).book(input("c3"));
    expect(booking.status).toBe("confirmed");
  });
});
