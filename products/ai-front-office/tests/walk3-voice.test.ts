import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { CALENDAR_UNAVAILABLE_MESSAGE, CallService, NO_SLOTS_MESSAGE } from "../src/application/call-service.js";
import { createDemoConfig, normalizeBusinessConfig } from "../src/domain/config.js";
import type { BusinessConfig } from "../src/domain/models.js";
import type { Clock } from "../src/ports.js";
import { buildTelnyxAssistantUpdate, buildVoiceSystemPrompt } from "../src/voice/system-prompt.js";
import { TOOL_DEADLINE_MS } from "../src/voice/tool-results.js";

// Walk 3 (Nov 26): Otto asked "how urgent is it?", missed short answers and sat silent, and promised a
// callback although the shop's calendar was connected.

class MutableClock implements Clock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value); }
  advance(milliseconds: number): void { this.value = new Date(this.value.getTime() + milliseconds); }
}

describe("Otto works out urgency itself", () => {
  const prompt = buildVoiceSystemPrompt(createDemoConfig());

  it("never tells Otto to ask the caller how urgent or serious it is", () => {
    expect(prompt).not.toMatch(/and how urgent it is/);
    expect(prompt).toContain("Never ask how urgent or serious it is; judge it from their words and call triage_call.");
    expect(prompt).toContain('Ask one fact only if it matters ("Is water still coming in?").');
  });

  it("keeps every life-safety rule word for word", () => {
    expect(prompt).toContain("If the caller reports gas odor, carbon monoxide, smoke, fire, or immediate danger, tell them to leave the building and call 911 or the gas utility. Do not troubleshoot.");
    expect(prompt).toContain("Call triage_call as soon as the problem is clear. Its deterministic life-safety rules always win over your judgment.");
    expect(prompt).toContain("If it returns emergency=true, call request_human with reason=emergency and the caller's exact emergency words, then promise only that the owner has been alerted.");
  });
});

describe("Otto never leaves dead air and re-asks what it missed", () => {
  const config = createDemoConfig();
  const prompt = buildVoiceSystemPrompt(config);

  it("checks in after 3 seconds of silence, not 4", () => {
    const update = buildTelnyxAssistantUpdate(config, "https://front-office.example") as { telephony_settings: { user_idle_reply_secs: number } };
    expect(update.telephony_settings.user_idle_reply_secs).toBe(3);
  });

  it("re-asks the one thing it missed, once, instead of guessing or going quiet", () => {
    expect(prompt).toContain("Missed an answer? Say so and re-ask it once. Never guess.");
  });

  it("checks in once on silence, then saves and hangs up, inside the 10 s idle cap", () => {
    expect(prompt).toContain(`If the caller goes silent, check in once: "Are you still there?" plus your last question in a few words. If still silent, save any intake, say "I'll let you go. Goodbye.", and invoke the built-in hangup tool in the same turn.`);
    expect(prompt).not.toContain("repeat it once in a few words");
  });
});

describe("booking never outranks safety", () => {
  it("never books an emergency and keeps the 911 rule and wrap-up line on top", () => {
    const prompt = buildVoiceSystemPrompt(createDemoConfig());
    expect(prompt).not.toContain("Don't promise a callback while you can book.");
    expect(prompt).toContain("triage_call found no emergency, book an offered slot they pick instead of promising a callback. Safety and wrap-up rules win.");
    expect(prompt).toContain("If the caller reports gas odor, carbon monoxide, smoke, fire, or immediate danger, tell them to leave the building and call 911 or the gas utility.");
  });

  it("a full window looks once more before falling back to the owner confirming", () => {
    expect(NO_SLOTS_MESSAGE).toContain("call check_availability once more with a window from the next day to a week out");
    expect(NO_SLOTS_MESSAGE).toContain("never suggest a time");
    expect(NO_SLOTS_MESSAGE).toContain("access_notes");
    expect(CALENDAR_UNAVAILABLE_MESSAGE).toContain("access_notes");
  });
});

describe("booking defaults", () => {
  it("books on the calendar for a new shop", () => {
    expect(createDemoConfig().bookingMode).toBe("direct");
  });

  it("moves a shop saved before owners could choose (forced to confirm) to direct, once", () => {
    const { bookingDefaultsVersion: _version, ...legacy } = { ...createDemoConfig("shop_legacy"), bookingMode: "confirm" as const };
    const read = normalizeBusinessConfig(legacy);
    expect(read.bookingMode).toBe("direct");
    expect(read.bookingDefaultsVersion).toBe(2);
  });

  it("keeps an owner's own confirm choice", () => {
    expect(normalizeBusinessConfig({ ...createDemoConfig("shop_choice"), bookingMode: "confirm" }).bookingMode).toBe("confirm");
  });
});

describe("Otto books instead of promising a callback", () => {
  let store: InMemoryStore;
  let calendar: InMemoryCalendar;
  let clock: MutableClock;
  let service: CallService;
  const slot = "2026-01-15T15:00:00.000Z"; // Thursday 9 AM in the demo shop's Chicago time

  const withFee = (overrides: Partial<BusinessConfig> = {}): BusinessConfig => ({
    ...createDemoConfig(),
    priceSnippets: [{ label: "Diagnostic", text: "The diagnostic visit is $89." }],
    ...overrides,
  });

  beforeEach(async () => {
    store = new InMemoryStore();
    calendar = new InMemoryCalendar();
    clock = new MutableClock(new Date("2026-01-15T08:00:00.000Z"));
    await store.saveConfig(withFee());
    service = new CallService(store, calendar, clock, "https://front-office.example");
  });

  async function start(providerCallId: string): Promise<void> {
    await service.recordStarted({ eventId: `start:${providerCallId}`, tenantId: "demo", providerCallId, fromNumber: "+15555550100", startedAt: clock.now().toISOString() });
  }

  async function offer(providerCallId: string, at = slot) {
    return service.checkAvailability({ tenantId: "demo", providerCallId, windowStart: at, windowEnd: new Date(Date.parse(at) + 3 * 60 * 60_000).toISOString() });
  }

  function book(providerCallId: string, at = slot) {
    return service.bookConfirmedSlot({
      tenantId: "demo", providerCallId, slotStart: at, callerName: "Test Caller", callbackNumber: "+15555550100",
      address: "100 Main St, Springfield, IL", serviceCategory: "HVAC repair", problemDescription: "Furnace makes a rattling noise",
      explicitConfirmation: true, diagnosticFeeAccepted: true,
    });
  }

  it("books an offered time on a default shop's calendar", async () => {
    await start("default-books");
    expect((await offer("default-books")).status).toBe("available");
    const result = await book("default-books");
    expect(result.status).toBe("confirmed");
    expect(calendar.events).toHaveLength(1);
  });

  it("never books for a caller who asked for a person", async () => {
    await start("asked-for-owner");
    await service.saveIntake({ tenantId: "demo", providerCallId: "asked-for-owner", fromNumber: "+15555550100", fields: { problemDescription: "Furnace makes a rattling noise", humanRequested: true } });
    await offer("asked-for-owner");
    const result = await book("asked-for-owner");
    expect(result.status).toBe("pending");
    expect(calendar.events).toHaveLength(0);
  });

  it("never books outside the shop's hours, even a time offered earlier in the call", async () => {
    await start("hours-changed");
    await offer("hours-changed");
    await store.saveConfig(withFee({ bookableHours: { weekdayStart: "10:00", weekdayEnd: "17:00", weekends: false } }));
    const result = await book("hours-changed");
    expect(result.status).toBe("pending");
    expect(result.message).toContain("outside the shop's hours or notice");
    expect(calendar.events).toHaveLength(0);
  });

  it("never books inside the notice period", async () => {
    await start("short-notice");
    await offer("short-notice");
    clock.advance(5.5 * 60 * 60_000); // 13:30Z: the 15:00Z slot is now 90 minutes out; notice is 120
    const result = await book("short-notice");
    expect(result.status).toBe("pending");
    expect(calendar.events).toHaveLength(0);
  });

  it("a failed calendar write tells the caller the owner will follow up, never that it is booked", async () => {
    await start("write-fails");
    await offer("write-fails");
    calendar.failCreate = "unknown";
    const result = await book("write-fails");
    expect(result.status).toBe("unknown");
    expect(result.message).toContain("the owner will follow up");
    expect(result.message).not.toMatch(/appointment is confirmed|is booked/i);
  });

  it("answers take-a-message before the tool deadline when the calendar hangs", async () => {
    await start("slow-calendar");
    calendar.listAvailableSlots = () => new Promise(() => undefined);
    const began = Date.now();
    const result = await offer("slow-calendar");
    expect(Date.now() - began).toBeLessThan(TOOL_DEADLINE_MS);
    expect(result).toMatchObject({ status: "pending", slots: [], message: CALENDAR_UNAVAILABLE_MESSAGE });
  }, 10_000);
});
