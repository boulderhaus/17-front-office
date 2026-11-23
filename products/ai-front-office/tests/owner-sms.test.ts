import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { CallService } from "../src/application/call-service.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";
import { callbackLinkMatches, callbackLinkToken, callerFirstName, gsm7, ownerCallSms, readCallbackLinkToken, shortWhen, streetAndCity, urgentReason } from "../src/domain/owner-sms.js";
import type { CollectedCallFields, EmergencyDecision } from "../src/domain/models.js";

const fields: CollectedCallFields = {
  callerName: "María Gonzalez", companyName: null, callbackNumber: "+15555550142", address: "41 Palm Ave, Sarasota, FL 34236",
  serviceCategory: "HVAC repair", serviceCategoryConfidence: 0.9, problemDescription: "AC not cooling", equipmentDetails: null,
  accessNotes: null, requestedStart: null, explicitSlotConfirmation: false, diagnosticFeeAccepted: false, humanRequested: false, confidence: 0.9,
};
const GSM7_ONE_SEGMENT = /^[A-Za-z0-9 !"#%&'()*+,\-./:;<=>?@$_\n]+$/;

describe("owner new-call text", () => {
  it("reads in short lines with a blank line before the link, and never includes the caller's number", () => {
    const body = ownerCallSms({ call: { fields, emergency: null }, wants: "Wants someone today", link: "https://front-office.example/c/abc" });
    expect(body).toBe([
      "New call: Maria",
      "- AC not cooling",
      "- 41 Palm Ave, Sarasota",
      "- Wants someone today",
      "",
      "Call back: https://front-office.example/c/abc",
    ].join("\n"));
    expect(body).not.toContain("555");
    expect(body).toMatch(GSM7_ONE_SEGMENT);
  });

  it("says when the AI booked a time and links the confirmation", () => {
    const body = ownerCallSms({ call: { fields: { ...fields, callerName: "Bob Smith" }, emergency: null }, booked: "tomorrow 10a", link: "https://front-office.example/c/abc" });
    expect(body).toBe([
      "New call: Bob",
      "- AC not cooling",
      "- 41 Palm Ave, Sarasota",
      "- Booked tomorrow 10a",
      "",
      "Confirmation: https://front-office.example/c/abc",
    ].join("\n"));
  });

  it("starts urgent calls with URGENT and the reason, then the caller's first name and the same bullets", () => {
    const emergency: EmergencyDecision = { emergency: true, severity: "urgent", score: 0.9, evidence: ["gas smell"], immediateInstruction: null };
    const body = ownerCallSms({ call: { fields, emergency }, urgentReason: urgentReason({ fields, emergency }, false), wants: "Wants someone today", link: "https://x.example/c/t" });
    expect(body).toBe(["URGENT: gas smell", "New call: Maria", "- AC not cooling", "- 41 Palm Ave, Sarasota", "- Wants someone today", "", "Call back: https://x.example/c/t"].join("\n"));
    expect(urgentReason({ fields, emergency: { ...emergency, severity: "life_safety", evidence: ["carbon monoxide"] } }, false)).toBe("safety risk, carbon monoxide");
    expect(urgentReason({ fields, emergency: null }, true)).toBe("caller asked for you");
    expect(urgentReason({ fields, emergency: null }, false)).toBeNull();
  });

  it("keeps the problem to about 40 characters and everything GSM-7", () => {
    const long = { ...fields, callerName: "Jo", problemDescription: "Upstairs unit blowing warm air since Tuesday, thermostat says “cool” — maybe refrigerant", address: null };
    const body = ownerCallSms({ call: { fields: long, emergency: null }, link: "https://x.example/c/t" });
    const lines = body.split("\n");
    expect(lines[0]).toBe("New call: Jo");
    expect(lines[1]!.length).toBeLessThanOrEqual(42);
    expect(lines[1]).toMatch(/^- .*\.\.\.$/);
    expect(lines.slice(2)).toEqual(["", "Call back: https://x.example/c/t"]);
    expect(body).toMatch(GSM7_ONE_SEGMENT);
    expect(gsm7("75¢ “quote” – Ñandú")).toBe('75 "quote" - Nandu');
    expect(callerFirstName(null)).toBe("Unknown caller");
    expect(callerFirstName("  josé  maría lópez ")).toBe("jose");
    expect(streetAndCity("")).toBeNull();
  });

  it("writes times short, in the shop's timezone", () => {
    const now = new Date("2026-11-23T15:00:00Z"); // Monday 10 AM in New York
    const tz = "America/New_York";
    expect(shortWhen("2026-11-23T20:00:00Z", now, tz)).toBe("today 3p");
    expect(shortWhen("2026-11-24T15:00:00Z", now, tz)).toBe("tomorrow 10a");
    expect(shortWhen("2026-11-24T15:30:00Z", now, tz)).toBe("tomorrow 10:30a");
    expect(shortWhen("2026-11-25T19:00:00Z", now, tz)).toBe("Wed 2p");
    expect(shortWhen("2026-12-04T17:00:00Z", now, tz)).toBe("Dec 4 12p");
    // Late evening UTC is still "today" in Los Angeles.
    expect(shortWhen("2026-11-24T04:00:00Z", new Date("2026-11-23T20:00:00Z"), "America/Los_Angeles")).toBe("today 8p");
  });
});

describe("owner new-call text, end to end", () => {
  const key = "callback-link-key-abcdefghijklmnopqrstuvwxyz";
  const now = new Date("2026-01-15T08:00:00.000Z");
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = null; });

  it("texts the owner without the caller's number and links to a signed page with a big Call button", async () => {
    const store = new InMemoryStore();
    const tenantId = "shop_sms";
    await store.createOwnerWorkspace({
      account: { id: randomUUID(), tenantId, email: "owner@example.test", displayName: "Owner", passwordHash: "synthetic", role: "owner", status: "active", createdAt: now.toISOString(), updatedAt: now.toISOString() },
      config: { ...createDemoConfig(tenantId), businessName: "Suncoast Heating", timezone: "America/New_York", ownerNotificationRefs: ["owner-primary"], ownerRealtimeSmsEnabled: true },
      ownerPhone: "+15555550100",
    });
    const clock = { now: () => now };
    const service = new CallService(store, new InMemoryCalendar(), clock, "https://front-office.example", { callbackLinkKey: key });
    const call = await service.finalize({
      webhookEventId: "end:sms-1", tenantId, providerCallId: "sms-1", fromNumber: "+15555550142", startedAt: "2026-01-15T07:50:00.000Z", endedAt: now.toISOString(), durationSeconds: 95,
      fields: { ...fields, requestedStart: "2026-01-15T17:00:00.000Z" }, transcript: "Synthetic", recordingUrl: null, consentState: "disclosed",
    });
    const sms = [...store.notifications.values()].find((item) => item.channel === "sms" && item.callId === call.id)!;
    const lines = sms.body.split("\n");
    expect(lines.slice(0, 5)).toEqual(["New call: Maria", "- AC not cooling", "- 41 Palm Ave, Sarasota", "- Wants someone today", ""]);
    expect(lines[5]).toMatch(/^Call back: https:\/\/front-office\.example\/c\/[A-Za-z0-9_-]{22}\.[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
    expect(sms.body).not.toMatch(/555.?0142|\+1/);
    expect(sms.body).toMatch(GSM7_ONE_SEGMENT);

    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", SESSION_SIGNING_KEY: key });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const path = new URL(lines[5]!.slice("Call back: ".length)).pathname;
    const page = await fetch(`http://127.0.0.1:${address.port}${path}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-store");
    const html = await page.text();
    expect(html).toContain('href="tel:+15555550142"');
    expect(html).toContain("Call (555) 555-0142");
    expect(html).toContain("Call back María Gonzalez");
    // Tampered, or the same call claimed by another shop: not found.
    expect((await fetch(`http://127.0.0.1:${address.port}${path.replace(/.$/, (c) => (c === "A" ? "B" : "A"))}`)).status).toBe(404);
    const otherShop = callbackLinkToken({ tenantId: "shop_other", callId: call.id, now, key });
    expect((await fetch(`http://127.0.0.1:${address.port}/c/${otherShop}`)).status).toBe(404);
  });
});

describe("call-back link", () => {
  const tenantId = "shop_a";
  const callId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const now = new Date("2026-11-23T12:00:00Z");

  it("is short, names the call, and only verifies for that shop with this key", () => {
    const token = callbackLinkToken({ tenantId, callId, now, key: "k".repeat(40) });
    expect(token.length).toBeLessThan(60);
    const parsed = readCallbackLinkToken(token, now)!;
    expect(parsed.callId).toBe(callId);
    expect(callbackLinkMatches(parsed, tenantId, "k".repeat(40))).toBe(true);
    expect(callbackLinkMatches(parsed, "shop_b", "k".repeat(40))).toBe(false);
    expect(callbackLinkMatches(parsed, tenantId, "x".repeat(40))).toBe(false);
    expect(readCallbackLinkToken(token.replace(/.$/, (c) => c === "A" ? "B" : "A"), now) && callbackLinkMatches(readCallbackLinkToken(token.replace(/.$/, (c) => c === "A" ? "B" : "A"), now)!, tenantId, "k".repeat(40))).toBe(false);
  });

  it("expires after 7 days", () => {
    const token = callbackLinkToken({ tenantId, callId, now, key: "k".repeat(40) });
    expect(readCallbackLinkToken(token, new Date(now.getTime() + 6.9 * 86_400_000))).not.toBeNull();
    expect(readCallbackLinkToken(token, new Date(now.getTime() + 7.1 * 86_400_000))).toBeNull();
    expect(readCallbackLinkToken("not-a-token", now)).toBeNull();
  });
});
