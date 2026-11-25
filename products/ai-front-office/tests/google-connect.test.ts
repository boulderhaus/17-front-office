import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { GOOGLE_CALENDAR_SCOPES, missingCalendarPermissions } from "../src/adapters/google-oauth-clients.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";
import type { Clock } from "../src/ports.js";

const ADMIN_TOKEN = "admin-token-abcdefghijklmnopqrstuvwxyz";
const EVENTS_OWNED = "https://www.googleapis.com/auth/calendar.events.owned";
const FREEBUSY = "https://www.googleapis.com/auth/calendar.freebusy";

describe("Google Calendar permissions", () => {
  it("asks only for busy times and events on calendars the person owns", () => {
    expect([...GOOGLE_CALENDAR_SCOPES]).toEqual([EVENTS_OWNED, FREEBUSY]);
  });

  it("treats a grant as usable only when both permissions came back", () => {
    expect(missingCalendarPermissions(`${EVENTS_OWNED} ${FREEBUSY}`)).toEqual([]);
    expect(missingCalendarPermissions(EVENTS_OWNED)).toEqual(["freebusy"]);
    expect(missingCalendarPermissions(FREEBUSY)).toEqual(["events"]);
    expect(missingCalendarPermissions("")).toEqual(["events", "freebusy"]);
    // An older, broader grant still covers what Otto does.
    expect(missingCalendarPermissions("https://www.googleapis.com/auth/calendar")).toEqual([]);
    // Google omitted the field: assume nothing is missing rather than block a working connection.
    expect(missingCalendarPermissions(undefined)).toEqual([]);
  });
});

describe("Google Calendar connect flow", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  const clock: Clock = { now: () => new Date("2026-01-15T08:00:00.000Z") };
  const realFetch = globalThis.fetch;
  let tokenReply: Record<string, unknown>;
  let revoked: string[];

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    tokenReply = {};
    revoked = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify(tokenReply), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://oauth2.googleapis.com/revoke") {
        revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
        return new Response("", { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const env = demoEnvironment({
      ADMIN_TOKEN,
      TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz",
      PUBLIC_BASE_URL: "http://127.0.0.1:8787",
      GOOGLE_CLIENT_ID: "synthetic-client-id",
      GOOGLE_CLIENT_SECRET: "synthetic-client-secret",
    });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: { Demo: true }, logger: () => undefined }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function signUp(): Promise<{ cookie: string; tenantId: string }> {
    const response = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Air", email: "owner@synthetic.example", password: "long-password-for-tests", consent: "yes" }) });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const account = await store.getOwnerAccountByEmail("owner@synthetic.example");
    return { cookie, tenantId: account!.tenantId };
  }

  async function startConnect(owner: { cookie: string }): Promise<{ location: URL; pkceCookie: string }> {
    const response = await fetch(`${baseUrl}/app/integrations/google/start`, { redirect: "manual", headers: { cookie: owner.cookie } });
    expect([302, 303]).toContain(response.status);
    return { location: new URL(response.headers.get("location")!), pkceCookie: response.headers.get("set-cookie")!.split(";")[0]! };
  }

  async function finishConnect(owner: { cookie: string }, start: { location: URL; pkceCookie: string }): Promise<Response> {
    const callback = new URL(`${baseUrl}/app/integrations/google/callback`);
    callback.searchParams.set("state", start.location.searchParams.get("state")!);
    callback.searchParams.set("code", "synthetic-code");
    return fetch(callback, { redirect: "manual", headers: { cookie: `${owner.cookie}; ${start.pkceCookie}` } });
  }

  it("sends owners and the admin to Google asking for exactly the two narrow permissions", async () => {
    const owner = await signUp();
    const { location } = await startConnect(owner);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("scope")).toBe(`${EVENTS_OWNED} ${FREEBUSY}`);
    expect(location.searchParams.get("client_id")).toBe("synthetic-client-id");

    const admin = await fetch(`${baseUrl}/admin/integrations/google/start`, { redirect: "manual", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect([302, 303]).toContain(admin.status);
    expect(new URL(admin.headers.get("location")!).searchParams.get("scope")).toBe(`${EVENTS_OWNED} ${FREEBUSY}`);
  });

  it("connects when both permissions are allowed", async () => {
    const owner = await signUp();
    tokenReply = { refresh_token: "synthetic-refresh", scope: `${FREEBUSY} ${EVENTS_OWNED}` };
    const response = await finishConnect(owner, await startConnect(owner));
    expect([302, 303]).toContain(response.status);
    expect(response.headers.get("location")).toBe("/app/settings");
    expect(await store.getIntegrationSecret(owner.tenantId, "google", "refresh_token")).toBeTruthy();
    expect(revoked).toEqual([]);
  });

  it("refuses a partial grant, hands it back to Google, and says to tick both boxes", async () => {
    const owner = await signUp();
    tokenReply = { refresh_token: "synthetic-partial", scope: EVENTS_OWNED };
    const response = await finishConnect(owner, await startConnect(owner));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("leave both boxes ticked");
    expect(await store.getIntegrationSecret(owner.tenantId, "google", "refresh_token")).toBeNull();
    expect(revoked).toEqual(["synthetic-partial"]);
  });
});
