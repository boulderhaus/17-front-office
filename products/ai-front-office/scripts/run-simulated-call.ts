import { CapturingNotificationSender, InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { CallService } from "../src/application/call-service.js";
import { OutboxWorker } from "../src/application/outbox-worker.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { Clock } from "../src/ports.js";

const now = new Date("2026-01-15T08:00:00.000Z");
const clock: Clock = { now: () => new Date(now) };
const store = new InMemoryStore();
const calendar = new InMemoryCalendar();
const sender = new CapturingNotificationSender();
await store.saveConfig({
  ...createDemoConfig(),
  bookingMode: "direct",
  priceSnippets: [{ label: "Diagnostic", text: "The diagnostic visit is $89." }],
});
const service = new CallService(store, calendar, clock, "http://127.0.0.1:8787");
const call = await service.recordStarted({ eventId: "demo-start", tenantId: "demo", providerCallId: "demo-call", fromNumber: "+15555550100", startedAt: now.toISOString() });
const slot = "2026-01-15T15:00:00.000Z";
await service.bookConfirmedSlot({ tenantId: "demo", providerCallId: call.providerCallId, slotStart: slot, callerName: "Demo Caller", callbackNumber: "+15555550100", address: "100 Main St, Springfield", serviceCategory: "HVAC maintenance", problemDescription: "Routine HVAC maintenance", explicitConfirmation: true, diagnosticFeeAccepted: true });
now.setUTCMinutes(now.getUTCMinutes() + 4);
const finalized = await service.finalize({
  webhookEventId: "demo-ended",
  tenantId: "demo",
  providerCallId: call.providerCallId,
  fromNumber: "+15555550100",
  startedAt: call.startedAt,
  endedAt: now.toISOString(),
  durationSeconds: 240,
  fields: {
    callerName: "Demo Caller",
    companyName: null,
    callbackNumber: "+15555550100",
    address: "100 Main St, Springfield",
    serviceCategory: "HVAC maintenance",
    serviceCategoryConfidence: 0.98,
    problemDescription: "Routine HVAC maintenance",
    equipmentDetails: "Residential forced-air system",
    accessNotes: null,
    requestedStart: slot,
    explicitSlotConfirmation: true,
    diagnosticFeeAccepted: true,
    humanRequested: false,
    confidence: 0.96,
  },
  transcript: "Synthetic demo transcript: caller requests routine HVAC maintenance and confirms the offered appointment.",
  recordingUrl: "https://example.invalid/demo-recording",
  consentState: "disclosed",
});
await new OutboxWorker(store, sender, clock).runOnce();
console.log(JSON.stringify({ outcome: finalized.outcome, emergency: finalized.emergency?.severity, notificationsSent: sender.sent.length, calendarEvents: calendar.events.length }, null, 2));
