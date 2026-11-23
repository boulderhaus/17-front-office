import { describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { CallService } from "../src/application/call-service.js";
import { DataDeletionService } from "../src/application/data-deletion.js";
import { createDemoConfig } from "../src/domain/config.js";

const clock = { now: () => new Date("2026-01-15T14:00:00Z") };
const config = { ...createDemoConfig(), paused: false, bookingMode: "direct" as const, requireDiagnosticFeeAcceptance: false, serviceAreaTerms: ["Springfield IL", "62701"], dataRetentionDays: 7 };

async function bookedCall(store: InMemoryStore, calendar: InMemoryCalendar, providerCallId: string): Promise<string> {
  const service = new CallService(store, calendar, clock, "https://front-office.example");
  await service.recordStarted({ eventId: `start:${providerCallId}`, tenantId: "demo", providerCallId, fromNumber: "+12175550100", startedAt: clock.now().toISOString() });
  const availability = await service.checkAvailability({ tenantId: "demo", providerCallId, windowStart: "2026-01-29T14:00:00Z", windowEnd: "2026-01-30T23:00:00Z" });
  const booked = await service.bookConfirmedSlot({ tenantId: "demo", providerCallId, slotStart: availability.slots[0]!.start, callerName: "Synthetic Caller", callbackNumber: "+12175550100", address: "1 Main St, Springfield, IL 62701", serviceCategory: "HVAC maintenance", problemDescription: "Tune-up", explicitConfirmation: true, diagnosticFeeAccepted: true });
  expect(booked.status).toBe("confirmed");
  const call = (await store.getCallByProviderId(providerCallId))!;
  await store.saveCall({ ...call, endedAt: "2026-01-15T14:05:00Z" });
  return call.id;
}

describe("call data deletion", () => {
  it("retention never removes a booked appointment from the owner's calendar", async () => {
    const store = new InMemoryStore();
    const calendar = new InMemoryCalendar();
    await store.saveConfig(config);
    await bookedCall(store, calendar, "retained-appointment");
    const result = await new DataDeletionService(store, null).deleteExpired("demo", "2026-01-16T00:00:00Z", 100, "2026-01-23T00:00:00Z");
    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(calendar.events).toHaveLength(1);
  });

  it("deleting a call record keeps the appointment it created", async () => {
    const store = new InMemoryStore();
    const calendar = new InMemoryCalendar();
    await store.saveConfig(config);
    const callId = await bookedCall(store, calendar, "deleted-record");
    expect(await new DataDeletionService(store, null).deleteCall("demo", callId)).toBe(true);
    expect(calendar.events).toHaveLength(1);
  });

  it("backs off a call whose recording cannot be deleted instead of blocking newer deletions", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(config);
    const service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example");
    for (const id of ["recorded", "plain"]) {
      await service.recordStarted({ eventId: `start:${id}`, tenantId: "demo", providerCallId: id, fromNumber: "+12175550100", startedAt: clock.now().toISOString() });
    }
    const recorded = (await store.getCallByProviderId("recorded"))!;
    await store.saveCall({ ...recorded, endedAt: "2026-01-01T00:00:00Z", recordingUrl: "https://front-office.example/app/provider/telnyx/recordings/recorded" });
    let attempts = 0;
    const deletion = new DataDeletionService(store, { deleteForCall: async () => { attempts += 1; throw new Error("provider unavailable"); } });
    expect(await deletion.deleteExpired("demo", "2026-01-10T00:00:00Z", 1, "2026-01-12T00:00:00Z")).toEqual({ deleted: 0, failed: 1 });
    const plain = (await store.getCallByProviderId("plain"))!;
    await store.saveCall({ ...plain, endedAt: "2026-01-02T00:00:00Z" });
    expect(await deletion.deleteExpired("demo", "2026-01-10T00:00:00Z", 1, "2026-01-12T01:00:00Z")).toEqual({ deleted: 1, failed: 0 });
    expect(attempts).toBe(1);
    expect(await deletion.deleteExpired("demo", "2026-01-10T00:00:00Z", 1, "2026-01-13T01:00:00Z")).toEqual({ deleted: 0, failed: 1 });
    expect(attempts).toBe(2);
  });
});
