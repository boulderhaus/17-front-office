import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { FOUNDER_GOOGLE_PROVIDER, FounderCalendarReadError, FounderCalendars } from "../src/adapters/founder-calendar.js";
import { loadEnvironment } from "../src/config/environment.js";
import { PLATFORM_TENANT_ID } from "../src/ports.js";

const env = loadEnvironment({
  NODE_ENV: "test", DEMO_MODE: "false", PUBLIC_BASE_URL: "https://front-office.example",
  ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz",
  SESSION_SIGNING_KEY: "k".repeat(48), DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-secret",
});
const clock = { now: () => new Date("2026-11-30T13:00:00Z") };

type Answer = Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason: string }> }>;

async function calendars(answers: Record<string, Answer>) {
  const store = new InMemoryStore();
  const accounts = Object.keys(answers).map((id) => ({ id, email: `${id}@synthetic.example`, bookHere: id === "a", calendars: ["primary"], calendarsSource: "primary", connectedAt: clock.now().toISOString() }));
  await store.saveIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, "accounts", JSON.stringify(accounts));
  for (const { id } of accounts) await store.saveIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, `token:${id}`, JSON.stringify({ v: 1, client: "legacy", refreshToken: `refresh-${id}` }));
  const logs: Array<Record<string, unknown>> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: `at-${new URLSearchParams(String(init?.body)).get("refresh_token")}`, expires_in: 3600 });
    if (url === "https://www.googleapis.com/calendar/v3/freeBusy") {
      const account = String((init?.headers as Record<string, string>).authorization).replace("Bearer at-refresh-", "");
      return json({ calendars: answers[account] });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { founder: new FounderCalendars({ store, env, clock, fetcher, log: (entry) => logs.push(entry) }), logs };
}

const block = { start: "2026-11-30T15:00:00Z", end: "2026-11-30T15:30:00Z" };

describe("reading Brock's connected calendars", () => {
  it("accepts a main calendar Google keys by the account's address instead of \"primary\"", async () => {
    const { founder } = await calendars({ a: { primary: { busy: [block] } }, b: { "b@synthetic.example": { busy: [block] } } });
    expect(await founder.busy("2026-11-30T00:00:00Z", "2026-12-05T00:00:00Z")).toHaveLength(2);
  });

  it("skips an account whose main calendar Google says doesn't exist, and logs it", async () => {
    const { founder, logs } = await calendars({ a: { primary: { busy: [block] } }, m: { primary: { errors: [{ reason: "notFound" }] } } });
    expect(await founder.busy("2026-11-30T00:00:00Z", "2026-12-05T00:00:00Z")).toEqual([block]);
    expect(logs).toEqual([expect.objectContaining({ event: "founder_calendar_skipped", accountId: "m", reasons: "notFound" })]);
  });

  it("fails closed on any other error and names the account, masked", async () => {
    const { founder } = await calendars({ a: { primary: { busy: [] } }, h: { primary: { errors: [{ reason: "internalError" }] } } });
    const error = await founder.busy("2026-11-30T00:00:00Z", "2026-12-05T00:00:00Z").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FounderCalendarReadError);
    expect((error as FounderCalendarReadError).account).toBe("h***@synthetic.example");
    expect((error as FounderCalendarReadError).reason).toContain("internalError");
  });
});
