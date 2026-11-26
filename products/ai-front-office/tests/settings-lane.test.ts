import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { runRetentionCycle } from "../src/application/retention.js";
import { demoEnvironment } from "../src/config/environment.js";
import { areaForPhone } from "../src/domain/area-cities.js";
import { createDemoConfig } from "../src/domain/config.js";
import { ALWAYS_ON_WORDS, EMERGENCY_CHOICES } from "../src/domain/emergency-choices.js";
import type { CallRecord } from "../src/domain/models.js";
import { otherServiceProblem } from "../src/domain/owner-inputs.js";
import { OWNER_CALL_CONSENT_SETTINGS_VERSION } from "../src/domain/owner-call-consent.js";
import { TRADES } from "../src/domain/trades.js";
import { triageEmergency } from "../src/domain/triage.js";
import { createRequestHandler } from "../src/http/app.js";
import type { Clock } from "../src/ports.js";
import { joinEmergencies, joinServices, otherServiceProblem as webOtherServiceProblem, splitEmergencies, splitServices } from "../web/src/lib/settings-picks.js";

describe("Where you work starts from the phone's area code", () => {
  it("maps known area codes to their cities, and unknown ones to nothing", () => {
    expect(areaForPhone("+19415550142")).toEqual(["Sarasota FL", "Bradenton FL", "Venice FL", "North Port FL"]);
    expect(areaForPhone("+19295550142")).toContain("New York NY");
    expect(areaForPhone("+19295550142")).toContain("Brooklyn NY");
    expect(areaForPhone("+16055550142")).toBeNull();
    expect(areaForPhone(null)).toBeNull();
  });
});

describe("Emergency tick boxes", () => {
  it("cover every phrase a trade starts with exactly once", () => {
    const owners = new Map<string, string>();
    for (const choice of EMERGENCY_CHOICES) for (const word of choice.words) {
      expect(owners.has(word), `${word} is in ${owners.get(word)} and ${choice.key}`).toBe(false);
      owners.set(word, choice.key);
    }
    for (const trade of TRADES) for (const word of trade.urgentWords) {
      expect(owners.has(word) || ALWAYS_ON_WORDS.includes(word), `${trade.key}: ${word}`).toBe(true);
    }
  });

  it("split a stored list into boxes and Other, and join it back without losing words", () => {
    const hvac = TRADES.find((trade) => trade.key === "hvac")!;
    const stored = [...hvac.urgentWords, "attic fan"].join(", ");
    const picks = splitEmergencies(stored, EMERGENCY_CHOICES as never, [...ALWAYS_ON_WORDS]);
    expect(picks.picked.sort()).toEqual(["frozen_pipes", "no_heat"]);
    expect(picks.other).toBe("attic fan");
    expect(picks.hidden).toEqual(["gas smell", "carbon monoxide"]);
    expect(joinEmergencies(picks, EMERGENCY_CHOICES as never).split(", ").sort()).toEqual(stored.split(", ").sort());
    // Unticking a box drops all its words; the always-on ones stay.
    const without = joinEmergencies({ ...picks, picked: ["frozen_pipes"] }, EMERGENCY_CHOICES as never);
    expect(without).not.toContain("heat went out");
    expect(without).toContain("gas smell");
  });
});

describe("Triage with the owner's ticks", () => {
  it("counts a ticked emergency however strict the setting is", () => {
    const decision = triageEmergency("The heat went out last night", { emergencyKeywords: ["heat went out"], emergencyThreshold: 0.9 });
    expect(decision.emergency).toBe(true);
    expect(decision.severity).toBe("urgent");
  });

  it("never weakens life-safety, even with nothing ticked and the strictest setting", () => {
    for (const sentence of ["I smell gas in the kitchen", "The carbon monoxide alarm is going off", "There's smoke coming from the furnace", "The garage is on fire"]) {
      const decision = triageEmergency(sentence, { emergencyKeywords: [], emergencyThreshold: 0.9 });
      expect(decision.severity, sentence).toBe("life_safety");
      expect(decision.emergency, sentence).toBe(true);
    }
  });

  it("leaves routine calls routine", () => {
    expect(triageEmergency("Can you quote a new thermostat?", { emergencyKeywords: ["heat went out"], emergencyThreshold: 0.5 }).emergency).toBe(false);
  });
});

describe("What you fix", () => {
  it("ticks a trade only when all its services are in the list, and keeps the rest in Other", () => {
    const trades = TRADES.filter((trade) => trade.key !== "other");
    const picks = splitServices("HVAC repair, HVAC maintenance, Installs and replacements, Pool repair, other", trades);
    expect(picks.picked).toEqual(["hvac"]);
    expect(picks.other).toBe("Pool repair");
    expect(picks.hidden).toEqual(["other"]);
    // Handyman and remodelers share "Repairs": ticking one never ticks the other.
    const handyman = joinServices({ picked: ["handyman"], other: "", hidden: [] }, trades);
    expect(splitServices(handyman, trades).picked).toEqual(["handyman"]);
  });

  it("rejects junk in Other the same way in the app and on the server", () => {
    for (const list of [["Hitman"], ["hit man"], ["https://spam.example"], ["x"], ["Pool repair", "Septic"], ["Gutter cleaning"], ["12345"]]) {
      expect(webOtherServiceProblem(list), list.join()).toBe(otherServiceProblem(list));
    }
    expect(otherServiceProblem(["Hitman"])).toContain("isn’t a service");
    expect(otherServiceProblem(["Pool repair", "Gutter cleaning"])).toBeNull();
  });

  it("lets real trade work through the junk check", () => {
    for (const item of ["Weed killing", "Rodent killing", "Kill switch install", "Hack saw", "Meth lab cleanup", "Assassin bug treatment"]) {
      expect(otherServiceProblem([item]), item).toBeNull();
      expect(webOtherServiceProblem([item]), item).toBeNull();
    }
  });
});

describe("Retention", () => {
  const now = new Date("2026-11-26T12:00:00.000Z");
  function fakeStore(tenants: Record<string, { account: boolean; sub?: { status: string; updatedAt: string } }>) {
    return {
      listTenantIds: async () => Object.keys(tenants),
      getConfig: async () => ({ ...createDemoConfig(), dataRetentionDays: 30 }),
      getOwnerAccountByTenant: async (tenantId: string) => (tenants[tenantId]!.account ? ({ tenantId } as never) : null),
      getSubscription: async (tenantId: string) => (tenants[tenantId]!.sub ?? null) as never,
      purgeWebhookEvents: async () => 0,
      purgeToolLedger: async () => 0,
    };
  }

  it("keeps every call of a live shop, and still clears demo and long-cancelled shops", async () => {
    const cleared: string[] = [];
    const deletion = { deleteExpired: async (tenantId: string) => { cleared.push(tenantId); return { deleted: 1, failed: 0 }; } };
    const store = fakeStore({
      live: { account: true, sub: { status: "active", updatedAt: "2025-01-01T00:00:00.000Z" } },
      trial: { account: true },
      justCancelled: { account: true, sub: { status: "canceled", updatedAt: "2026-11-20T00:00:00.000Z" } },
      longCancelled: { account: true, sub: { status: "canceled", updatedAt: "2026-09-01T00:00:00.000Z" } },
      demo: { account: false },
    });
    const result = await runRetentionCycle(store, now, deletion);
    expect(cleared.sort()).toEqual(["demo", "longCancelled"]);
    expect(result.purgedCalls).toBe(2);
  });

  it("keeps a live shop's old call in the real store", async () => {
    const store = new InMemoryStore();
    await store.saveConfig({ ...createDemoConfig(), dataRetentionDays: 7 });
    const call = { id: "33333333-3333-4333-8333-333333333333", tenantId: "demo", providerCallId: "v3:old", fromNumber: "+15555550123", fromNumberVerified: true, startedAt: "2025-01-01T10:00:00.000Z", endedAt: "2025-01-01T10:05:00.000Z", durationSeconds: 300, fields: {}, emergency: null, outcome: "message_taken", transcript: "Synthetic", recordingUrl: null, consentState: "unknown", billingDisposition: "billable", qualityFlags: [], createdAt: "2025-01-01T10:00:00.000Z", updatedAt: "2025-01-01T10:05:00.000Z" } as unknown as CallRecord;
    await store.saveCall(call);
    await runRetentionCycle(store, now);
    expect(await store.getCall(call.id)).not.toBeNull();
  });
});

describe("Owner settings API", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  const clock: Clock = { now: () => new Date("2026-11-26T15:00:00.000Z") };

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  async function signUp(phone: string) {
    const email = `owner-${Math.random().toString(36).slice(2, 8)}@synthetic.example`;
    const response = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", email, password: "long-password-for-tests", phone, trade: "hvac" }) });
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const account = (await store.getOwnerAccountByEmail(email))!;
    const settings = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie } })).json() as { csrf: string; values: Record<string, unknown>; catalog: { trades: unknown[]; emergencies: unknown[] }; areaSuggestion: string | null };
    const put = (values: Record<string, unknown>) => fetch(`${baseUrl}/api/app/settings`, { method: "PUT", headers: { cookie, "content-type": "application/json", "x-csrf-token": settings.csrf }, body: JSON.stringify(values) });
    return { cookie, tenantId: account.tenantId, settings, put };
  }

  it("starts a new shop's area from its area code, not just the state", async () => {
    const shop = await signUp("(941) 555-0142");
    expect((await store.getConfig(shop.tenantId)).serviceAreaTerms).toEqual(["Sarasota FL", "Bradenton FL", "Venice FL", "North Port FL"]);
    expect(shop.settings.catalog.trades.length).toBeGreaterThan(10);
    expect(shop.settings.catalog.emergencies.length).toBe(EMERGENCY_CHOICES.length);
  });

  it("offers the area to a shop that only has a state", async () => {
    const shop = await signUp("(941) 555-0142");
    await store.saveIntegrationSecret(shop.tenantId, "notifications", "owner-primary", "+19415550142");
    await store.saveConfig({ ...await store.getConfig(shop.tenantId), serviceAreaTerms: ["FL"] });
    const settings = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie: shop.cookie } })).json() as { areaSuggestion: string | null };
    expect(settings.areaSuggestion).toBe("Sarasota FL, Bradenton FL, Venice FL, North Port FL");
  });

  it("never offers one state's cities to a shop that covers several states", async () => {
    const shop = await signUp("(941) 555-0142");
    await store.saveIntegrationSecret(shop.tenantId, "notifications", "owner-primary", "+19415550142");
    for (const terms of [["FL", "GA"], ["GA"]]) {
      await store.saveConfig({ ...await store.getConfig(shop.tenantId), serviceAreaTerms: terms });
      const settings = await (await fetch(`${baseUrl}/api/app/settings`, { headers: { cookie: shop.cookie } })).json() as { areaSuggestion: string | null };
      expect(settings.areaSuggestion, terms.join()).toBeNull();
    }
  });

  it("saves several trades ticked at once, and every emergency box without dropping Other", async () => {
    const shop = await signUp("(941) 555-0142");
    const services = TRADES.filter((trade) => trade.key !== "other").flatMap((trade) => trade.services);
    const every = [...EMERGENCY_CHOICES.flatMap((choice) => choice.words), ...ALWAYS_ON_WORDS, "basement flooding"];
    const saved = await shop.put({ ...shop.settings.values, serviceCategories: [...new Set(services)].join(", "), emergencyKeywords: every.join(", ") });
    expect(saved.status).toBe(200);
    const config = await store.getConfig(shop.tenantId);
    expect(config.emergencyKeywords).toContain("basement flooding");
    expect(config.emergencyKeywords.length).toBe(every.length);
    expect(config.serviceCategories.length).toBe(new Set(services).size);
  });

  it("refuses a half-filled price or answer instead of dropping it", async () => {
    const shop = await signUp("(941) 555-0142");
    const price = await shop.put({ ...shop.settings.values, priceSnippets: "Service call: $89\nTune-up: " });
    expect(price.status).toBe(400);
    expect(((await price.json()) as { error: string }).error).toContain("Tune-up");
    expect((await shop.put({ ...shop.settings.values, approvedKnowledge: ": We service all brands." })).status).toBe(400);
    expect((await shop.put({ ...shop.settings.values, priceSnippets: "Service call: $89" })).status).toBe(200);
  });

  it("no longer shows or changes the repeat-caller limit or call retention", async () => {
    const shop = await signUp("(941) 555-0142");
    expect(shop.settings.values).not.toHaveProperty("maxCallsPerCallerPerDay");
    expect(shop.settings.values).not.toHaveProperty("dataRetentionDays");
    const before = await store.getConfig(shop.tenantId);
    const saved = await shop.put({ ...shop.settings.values, maxCallsPerCallerPerDay: "1", dataRetentionDays: "7", greeting: "Thanks for calling Synthetic Air." });
    expect(saved.status).toBe(200);
    const after = await store.getConfig(shop.tenantId);
    expect(after.greeting).toBe("Thanks for calling Synthetic Air.");
    expect(after.maxCallsPerCallerPerDay).toBe(before.maxCallsPerCallerPerDay);
    expect(after.dataRetentionDays).toBe(before.dataRetentionDays);
  });

  it("refuses junk services and an empty list, but an old entry never blocks a save", async () => {
    const shop = await signUp("(941) 555-0142");
    const junk = await shop.put({ ...shop.settings.values, serviceCategories: "HVAC repair, Hitman" });
    expect(junk.status).toBe(400);
    expect(((await junk.json()) as { error: string }).error).toContain("Hitman");
    expect((await shop.put({ ...shop.settings.values, serviceCategories: "" })).status).toBe(400);
    await store.saveConfig({ ...await store.getConfig(shop.tenantId), serviceCategories: ["HVAC repair", "Hitman"] });
    expect((await shop.put({ ...shop.settings.values, serviceCategories: "HVAC repair, Hitman", greeting: "Thanks for calling Synthetic Air." })).status).toBe(200);
  });

  it("records the Settings wording when the owner turns on emergency calls", async () => {
    const shop = await signUp("(941) 555-0142");
    await store.saveIntegrationSecret(shop.tenantId, "notifications", "owner-primary", "+19415550142");
    const response = await fetch(`${baseUrl}/api/app/alerts/urgent-calls`, { method: "POST", headers: { cookie: shop.cookie, "content-type": "application/json", "x-csrf-token": shop.settings.csrf }, body: JSON.stringify({ on: true }) });
    expect(response.status).toBe(200);
    const record = JSON.parse((await store.getIntegrationSecret(shop.tenantId, "notifications", "owner_call_consent"))!) as { wording: string };
    expect(record.wording).toBe(OWNER_CALL_CONSENT_SETTINGS_VERSION);
  });
});
