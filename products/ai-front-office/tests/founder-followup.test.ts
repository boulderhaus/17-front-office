import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { FOUNDER_GOOGLE_PROVIDER } from "../src/adapters/founder-calendar.js";
import { ResendEmailAdapter, formatEmailBody, parseEmailBody } from "../src/adapters/resend.js";
import { SETUP_SORRY_SPEECH, setupInstructions, setupSorrySpeech } from "../src/adapters/telnyx-setup-call.js";
import { founderEmailSender, loadEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import {
  founderBookingToken,
  founderCallIcs,
  founderConfirmationEmail,
  founderConnectToken,
  founderConnectTokenValid,
  founderFollowupEmail,
  founderSlots,
  maskEmail,
  parseBookingWindows,
  readFounderBookingToken,
  signFounderToken,
  slotFullLabel,
} from "../src/domain/founder-booking.js";
import type { OutboxNotification } from "../src/domain/models.js";
import { createRequestHandler } from "../src/http/app.js";
import { PLATFORM_TENANT_ID } from "../src/ports.js";

const KEY = "session-signing-key-abcdefghijklmnopqrstuvwxyz";
const WINDOWS = parseBookingWindows("Mon-Fri 10:00-12:00,14:00-17:00");
const NY = "America/New_York";
const utcHour = (iso: string): string => iso.slice(11, 16);

describe("Brock's booking windows and open times", () => {
  it("reads the default windows and refuses ones it can't read", () => {
    expect(WINDOWS.get(1)).toEqual([[600, 720], [840, 1020]]);
    expect(WINDOWS.has(0)).toBe(false);
    expect(WINDOWS.has(6)).toBe(false);
    expect(parseBookingWindows("Mon-Fri 10:00-12:00; Sat 09:00-10:00").get(6)).toEqual([[540, 600]]);
    expect(() => parseBookingWindows("weekdays 10-12")).toThrow();
    expect(() => parseBookingWindows("Mon 12:00-10:00")).toThrow();
    expect(() => loadEnvironment({ ...baseEnv(), FOUNDER_BOOKING_WINDOWS: "nope" })).toThrow();
    expect(() => loadEnvironment({ ...baseEnv(), FOUNDER_TIMEZONE: "Mars/Olympus" })).toThrow();
  });

  it("offers three evenly spread 10-minute times a day, inside the windows, in Brock's zone", () => {
    // Monday Nov 30 2026, 8:00 AM Eastern (EST, UTC-5).
    const slots = founderSlots({ now: new Date("2026-11-30T13:00:00Z"), windows: WINDOWS, timeZone: NY });
    const monday = slots.filter((slot) => slot.start.startsWith("2026-11-30"));
    // 10:00, 14:30 and 16:45 EST: first, middle and last of the 20 quarter-hour starts.
    expect(monday.map((slot) => utcHour(slot.start))).toEqual(["15:00", "19:30", "21:45"]);
    expect(monday.every((slot) => Date.parse(slot.end) - Date.parse(slot.start) === 10 * 60_000)).toBe(true);
    // Five business days, Monday to Friday; nothing on the weekend.
    expect(new Set(slots.map((slot) => slot.start.slice(0, 10)))).toEqual(new Set(["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"]));
    expect(slots).toHaveLength(15);
  });

  it("keeps an hour of lead time", () => {
    // Monday 11:10 AM EST: nothing in the morning window is an hour out, so the day starts at 2 PM.
    const slots = founderSlots({ now: new Date("2026-11-30T16:10:00Z"), windows: WINDOWS, timeZone: NY });
    expect(slots[0]!.start).toBe("2026-11-30T19:00:00.000Z");
    // 1:30 PM EST: 2:30 PM is the first start an hour out.
    const afternoon = founderSlots({ now: new Date("2026-11-30T18:30:00Z"), windows: WINDOWS, timeZone: NY });
    expect(Date.parse(afternoon[0]!.start)).toBeGreaterThanOrEqual(Date.parse("2026-11-30T19:30:00Z"));
    expect(afternoon[0]!.start.slice(0, 10)).toBe("2026-11-30");
    // Late Friday 4:00 PM EST: Friday is done; the five days run Monday to Friday next week.
    const friday = founderSlots({ now: new Date("2026-12-04T21:00:00Z"), windows: WINDOWS, timeZone: NY });
    expect(friday[0]!.start.slice(0, 10)).toBe("2026-12-07");
    expect(new Set(friday.map((slot) => slot.start.slice(0, 10))).size).toBe(5);
  });

  it("follows daylight saving: 10 AM is 14:00 UTC before the change and 15:00 UTC after", () => {
    // Friday Oct 30 2026, 7:00 AM EDT. Clocks fall back Sunday Nov 1.
    const slots = founderSlots({ now: new Date("2026-10-30T11:00:00Z"), windows: WINDOWS, timeZone: NY });
    expect(slots.find((slot) => slot.start.startsWith("2026-10-30"))!.start).toBe("2026-10-30T14:00:00.000Z");
    expect(slots.find((slot) => slot.start.startsWith("2026-11-02"))!.start).toBe("2026-11-02T15:00:00.000Z");
    // Spring forward Sunday Mar 14 2027: Friday 10 AM EST is 15:00 UTC, Monday 10 AM EDT is 14:00 UTC.
    const spring = founderSlots({ now: new Date("2027-03-12T12:00:00Z"), windows: WINDOWS, timeZone: NY });
    expect(spring.find((slot) => slot.start.startsWith("2027-03-12"))!.start).toBe("2027-03-12T15:00:00.000Z");
    expect(spring.find((slot) => slot.start.startsWith("2027-03-15"))!.start).toBe("2027-03-15T14:00:00.000Z");
  });

  it("skips busy blocks from every calendar with 5 minutes either side", () => {
    const busy = [
      { start: "2026-11-30T15:00:00Z", end: "2026-11-30T16:00:00Z" }, // account A: 10-11 EST
      { start: "2026-11-30T19:00:00Z", end: "2026-11-30T22:00:00Z" }, // account B: 2-5 PM EST
    ];
    const slots = founderSlots({ now: new Date("2026-11-30T13:00:00Z"), windows: WINDOWS, timeZone: NY, busy });
    // 11:00 starts 5 minutes after a busy block ends, inside the buffer; 11:15, 11:30, 11:45 are clear.
    expect(slots.filter((slot) => slot.start.startsWith("2026-11-30")).map((slot) => utcHour(slot.start))).toEqual(["16:15", "16:30", "16:45"]);
  });

  it("shows each time in the owner's zone with a zone label", () => {
    expect(slotFullLabel("2026-11-30T15:00:00.000Z", "America/Chicago")).toBe("Mon, Nov 30 at 9:00 AM CST");
    expect(slotFullLabel("2026-07-01T15:00:00.000Z", "America/Los_Angeles")).toBe("Wed, Jul 1 at 8:00 AM PDT");
  });
});

describe("founder links", () => {
  const now = new Date("2026-11-30T13:00:00Z");

  it("booking links name one shop and last 7 days", () => {
    const token = founderBookingToken(KEY, "shop_abc", now);
    expect(readFounderBookingToken(KEY, token, now)).toEqual({ tenantId: "shop_abc" });
    expect(readFounderBookingToken(KEY, token, new Date(now.getTime() + 6.9 * 24 * 60 * 60_000))).not.toBeNull();
    expect(readFounderBookingToken(KEY, token, new Date(now.getTime() + 7 * 24 * 60 * 60_000 + 1))).toBeNull();
  });

  it("refuses a tampered link, another key, or a connect link used as a booking link", () => {
    const token = founderBookingToken(KEY, "shop_abc", now);
    const [payload, signature] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ t: "shop_other", exp: now.getTime() + 60_000 })).toString("base64url")}.${signature}`;
    expect(readFounderBookingToken(KEY, forged, now)).toBeNull();
    expect(readFounderBookingToken(KEY, `${payload}.${signature}x`, now)).toBeNull();
    expect(readFounderBookingToken(`${KEY}-other`, token, now)).toBeNull();
    expect(readFounderBookingToken(KEY, signFounderToken(KEY, "founder-connect", { t: "shop_abc", exp: now.getTime() + 60_000 }), now)).toBeNull();
  });

  it("connect links work for at most 24 hours", () => {
    const token = founderConnectToken(KEY, now, 48 * 60 * 60_000);
    expect(founderConnectTokenValid(KEY, token, now)).toBe(true);
    expect(founderConnectTokenValid(KEY, token, new Date(now.getTime() + 24 * 60 * 60_000 + 1))).toBe(false);
    // Signed with the key but minted for longer than a day: refused.
    expect(founderConnectTokenValid(KEY, signFounderToken(KEY, "founder-connect", { exp: now.getTime() + 3 * 24 * 60 * 60_000 }), now)).toBe(false);
    expect(founderConnectTokenValid(KEY, founderBookingToken(KEY, "shop_abc", now), now)).toBe(false);
  });
});

describe("Brock's emails", () => {
  it("one line on what happened, the link, and Brock's sign-off; never a spaced dash or his number", () => {
    const withLink = founderFollowupEmail({ firstName: "Mike", businessName: "Gulf Air", reason: "no_answer", link: "https://front-office.example/book-setup?t=abc" });
    expect(withLink.text).toMatch(/^Hi Mike,\n\nOur setup helper called you about call forwarding for Gulf Air and didn't reach you\.\n\n/);
    expect(withLink.text).toContain("https://front-office.example/book-setup?t=abc");
    expect(withLink.text.endsWith("The Call Otto team")).toBe(true);
    expect(withLink.text).not.toContain("Brock");
    const noCalendar = founderFollowupEmail({ firstName: null, businessName: "Gulf Air", reason: "call_unavailable", link: null });
    expect(noCalendar.text.startsWith("Hi there,")).toBe(true);
    expect(noCalendar.text).toContain("Just reply with a good time for a quick 10-minute call.");
    expect(noCalendar.text).not.toContain("http");
    for (const reason of ["call_unavailable", "helper_failed", "no_answer", "not_confirmed", "limit", "asked_for_team"] as const) {
      const email = founderFollowupEmail({ firstName: "Mike", businessName: "Gulf Air", reason, link: null });
      expect(`${email.subject}\n${email.text}`).not.toMatch(/ [—–] /);
      expect(email.text).not.toMatch(/\d{3}\D{0,2}\d{3}\D\d{4}/);
    }
    const confirmation = founderConfirmationEmail({ firstName: "Mike", businessName: "Gulf Air", when: "Mon, Nov 30 at 9:00 AM CST", callNumber: "(941) 555-0199" });
    expect(confirmation.text).toContain("You're set for Mon, Nov 30 at 9:00 AM CST. We'll call you at (941) 555-0199");
    expect(confirmation.text).not.toContain("Brock");
    expect(confirmation.text).not.toMatch(/ [—–] /);
  });

  it("sends as the Call Otto team, replying to support, with the calendar file attached", async () => {
    const env = loadEnvironment({ ...baseEnv(), RESEND_API_KEY: "re_synthetic", RESEND_FROM_EMAIL: "alerts@callotto.example", SUPPORT_EMAIL: "help@callotto.example" });
    const sender = founderEmailSender(env)!;
    expect(sender).toEqual({ from: "Call Otto team <team@callotto.example>", replyTo: "help@callotto.example" });
    expect(founderEmailSender(loadEnvironment({ ...baseEnv(), RESEND_API_KEY: "re_synthetic", RESEND_FROM_EMAIL: "alerts@callotto.example", FOUNDER_FROM_EMAIL: "founder@callotto.example", FOUNDER_REPLY_TO: "inbox@callotto.example" })))
      .toEqual({ from: "Call Otto team <founder@callotto.example>", replyTo: "inbox@callotto.example" });
    const sent: Array<Record<string, unknown>> = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    }) as typeof fetch;
    const adapter = new ResendEmailAdapter({ apiKey: "re_synthetic", from: "Call Otto <alerts@callotto.example>", founder: sender, fetcher });
    const ics = founderCallIcs({ uid: "u1", start: "2026-11-30T15:00:00.000Z", end: "2026-11-30T15:10:00.000Z", now: new Date("2026-11-30T13:00:00Z"), summary: "Call Otto setup call with Brock (10 min)", description: "Brock will call you." });
    const base: OutboxNotification = { id: "n1", tenantId: "shop_1", callId: null, channel: "email", destinationRef: "email:owner@example.com", body: formatEmailBody("You're set", "Hi", [{ filename: "call-otto-setup.ics", content: ics }]), priority: "high", state: "pending", attempts: 0, nextAttemptAt: "", idempotencyKey: "k1", providerReceipt: null, lastError: null, createdAt: "", sentAt: null };
    await adapter.send({ ...base, senderRef: "founder" });
    await adapter.send({ ...base, id: "n2", idempotencyKey: "k2", body: formatEmailBody("Plain", "Hello") });
    expect(sent[0]).toMatchObject({ from: "Call Otto team <team@callotto.example>", reply_to: "help@callotto.example", subject: "You're set", text: "Hi" });
    const attachments = sent[0]!.attachments as Array<{ filename: string; content: string }>;
    expect(attachments[0]!.filename).toBe("call-otto-setup.ics");
    const file = Buffer.from(attachments[0]!.content, "base64").toString("utf8");
    expect(file).toContain("DTSTART:20261130T150000Z");
    expect(file).not.toMatch(/ORGANIZER|ATTENDEE|mailto/);
    expect(sent[1]).toEqual({ from: "Call Otto <alerts@callotto.example>", to: ["owner@example.com"], subject: "Plain", text: "Hello" });
    // Bodies queued before attachments existed still read the same.
    expect(parseEmailBody("Subject: Old\n\nBody text")).toEqual({ subject: "Old", text: "Body text", attachments: [] });
  });

  it("a line break in a subject (a shop's name) can't add an attachment, and only Brock's own emails carry one", async () => {
    const body = formatEmailBody("Forwarding help: Acme\nAttachment: invoice.html; PGgxPmhpPC9oMT4=", "Synthetic text");
    expect(body.split("\n")[0]).toBe("Subject: Forwarding help: Acme Attachment: invoice.html; PGgxPmhpPC9oMT4=");
    expect(parseEmailBody(body).attachments).toEqual([]);
    expect(parseEmailBody(body).text).toBe("Synthetic text");
    const sent: Array<Record<string, unknown>> = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: `email-${sent.length}` }), { status: 200 });
    }) as typeof fetch;
    const adapter = new ResendEmailAdapter({ apiKey: "re_synthetic", from: "Call Otto <alerts@callotto.example>", fetcher });
    const withFile = formatEmailBody("Hi", "Text", [{ filename: "call-otto-setup.ics", content: "BEGIN:VCALENDAR" }]);
    const base: OutboxNotification = { id: "n1", tenantId: "shop_a", callId: null, channel: "email", destinationRef: "email:owner@synthetic.example", body: withFile, priority: "high", state: "pending", attempts: 0, nextAttemptAt: "2026-11-30T13:00:00.000Z", idempotencyKey: "k1", providerReceipt: null, lastError: null, createdAt: "2026-11-30T13:00:00.000Z", sentAt: null };
    await adapter.send(base);
    await adapter.send({ ...base, id: "n2", idempotencyKey: "k2", senderRef: "founder" });
    expect(sent[0]!.attachments).toBeUndefined();
    expect((sent[1]!.attachments as Array<{ filename: string }>)[0]!.filename).toBe("call-otto-setup.ics");
  });

  it("the apology says only what was sent: a link, a note asking for a reply, or nothing", () => {
    expect(setupSorrySpeech({ fresh: true, link: true })).toBe(SETUP_SORRY_SPEECH);
    expect(setupSorrySpeech({ fresh: true, link: false })).toBe("Hi, this is Call Otto. Our setup helper couldn't start just now. Our team just emailed you to set up a quick 10 minute call. Sorry about that. Goodbye.");
    expect(setupSorrySpeech({ fresh: false, link: true })).toContain("Our team emailed you a link earlier to book a quick 10 minute call.");
    expect(setupSorrySpeech(null)).toBe("Hi, this is Call Otto. Our setup helper couldn't start just now. Please try again later from the Call Otto app. Sorry about that. Goodbye.");
  });

  it("the setup helper offers a time with our team, never a person's name", () => {
    const instructions = setupInstructions({ businessName: "Gulf Air", businessNumber: "+19415550177", carrierName: "Spectrum", family: "office", code: null, offCode: null, confirm: null, ottoNumber: "+19415550123", device: "other" });
    expect(instructions).toContain("offer a quick 10-minute call with our team (get_open_times, then book_time)");
    expect(instructions).toContain("If it isn't working after about two minutes, or they ask for a person");
    expect(instructions).not.toMatch(/Brock|founder|person from Call Otto|follow up by email today/);
    expect(SETUP_SORRY_SPEECH).toBe("Hi, this is Call Otto. Our setup helper couldn't start just now. Our team just emailed you a link to book a quick 10 minute call. Sorry about that. Goodbye.");
  });
});

// ---- The app, end to end with fakes ----

type Recorded = { url: string; method: string; body: unknown; auth: string | undefined };

function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: "test", DEMO_MODE: "false", PUBLIC_BASE_URL: "https://front-office.example",
    ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz",
    SESSION_SIGNING_KEY: KEY, DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-secret",
  };
}

const realFetch = globalThis.fetch;
let server: Server | null = null;
afterEach(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function app(options: { setupCalls?: boolean; failDial?: boolean; failHelperStart?: boolean; founders?: Array<{ id: string; email: string; bookHere: boolean }> } = {}) {
  const store = new InMemoryStore();
  await store.saveConfig(createDemoConfig());
  const clock = { at: new Date("2026-11-30T13:00:00Z"), now() { return this.at; } };
  const keys = generateKeyPairSync("ed25519");
  const rawPublicKey = (keys.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("base64");
  const recorded: Recorded[] = [];
  /** Busy blocks each founder account's freeBusy reports, keyed by account id. */
  const busy: Record<string, Array<{ start: string; end: string }>> = {};
  let tokenReply: Record<string, unknown> = {};
  let dialFails = options.failDial ?? false;
  /** Events inserted on each founder account's main calendar, keyed by account id then event id. Google's busy times show them. */
  const events: Record<string, Map<string, { start: string; end: string; status: string }>> = {};
  /** While set, Google's event insert waits on it: holds a booking mid-flight. */
  let eventGate: Promise<void> | null = null;
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : null;
    let body: unknown = raw;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    recorded.push({ url, method, body, auth: headers.authorization });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === "https://api.telnyx.com/v2/calls") return dialFails ? json({ errors: [{}] }, 503) : json({ data: { call_control_id: "v3:help-call" } });
    if (url === "https://api.telnyx.com/v2/ai/assistants" && method === "POST") return json({ data: { id: "setup-assistant" } });
    if (url.endsWith("/actions/ai_assistant_start")) return options.failHelperStart ? json({ errors: [{}] }, 500) : json({ data: { result: "ok" } });
    if (/\/actions\/(speak|hangup)$/.test(url)) return json({ data: { result: "ok" } });
    if (url === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(raw ?? "");
      if (params.get("grant_type") === "refresh_token") return json({ access_token: `at-${params.get("refresh_token")}`, expires_in: 3600 });
      return json(tokenReply);
    }
    if (url === "https://oauth2.googleapis.com/revoke") return new Response("", { status: 200 });
    if (url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList")) return json({ error: { code: 403 } }, 403);
    const account = (headers.authorization ?? "").replace("Bearer at-refresh-", "");
    if (url === "https://www.googleapis.com/calendar/v3/freeBusy") {
      const items = (body as { items: Array<{ id: string }> }).items;
      const inserted = [...(events[account]?.values() ?? [])].filter((event) => event.status !== "cancelled").map(({ start, end }) => ({ start, end }));
      return json({ calendars: Object.fromEntries(items.map((item) => [item.id, { busy: [...(busy[account] ?? []), ...(item.id === "primary" ? inserted : [])] }])) });
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events/") && method === "GET") {
      const event = events[account]?.get(url.slice(url.lastIndexOf("/") + 1));
      return event ? json({ ...event, start: { dateTime: event.start }, end: { dateTime: event.end } }) : json({ error: { code: 404 } }, 404);
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events") && method === "POST") {
      if (eventGate) await eventGate;
      const event = body as { id: string; start: { dateTime: string }; end: { dateTime: string } };
      const calendar = events[account] ??= new Map();
      if (calendar.has(event.id)) return json({ error: { code: 409 } }, 409);
      calendar.set(event.id, { start: event.start.dateTime, end: event.end.dateTime, status: "confirmed" });
      return json({ id: event.id });
    }
    throw new Error(`Unexpected outbound request in test: ${method} ${url}`);
  }) as typeof fetch;
  globalThis.fetch = fake;
  const env = loadEnvironment({
    ...baseEnv(),
    TELNYX_API_KEY: "KEY_synthetic", TELNYX_PUBLIC_KEY: rawPublicKey, TELNYX_FROM_NUMBER: "+15555550199",
    ...(options.setupCalls === false ? {} : { TELNYX_CHECK_CONNECTION_ID: "check-connection" }),
    RESEND_API_KEY: "re_synthetic", RESEND_FROM_EMAIL: "alerts@callotto.example", SUPPORT_EMAIL: "help@callotto.example",
  });
  const logs: Array<Record<string, unknown>> = [];
  const handler = createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: (entry) => logs.push(entry), fetcher: fake });
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  if (options.founders) {
    await store.saveIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, "accounts", JSON.stringify(options.founders.map((founder) => ({ ...founder, calendars: ["primary"], calendarsSource: "primary", connectedAt: clock.now().toISOString() }))));
    for (const founder of options.founders) {
      await store.saveIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, `token:${founder.id}`, JSON.stringify({ v: 1, client: "legacy", refreshToken: `refresh-${founder.id}` }));
    }
  }

  async function owner(email = "owner@synthetic.example", businessName = "Gulf Air") {
    const signup = await fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName, email, password: "synthetic-password-42", consent: "yes", phone: "9415550199", ownerSmsConsent: "yes" }) });
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const account = (await store.getOwnerAccountByEmail(email))!;
    await store.saveConfig({ ...await store.getConfig(account.tenantId), timezone: "America/Chicago" });
    await store.saveIntegrationSecret(account.tenantId, "telnyx", "inbound_number", "+19415550123");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "business_number", "+19415550177");
    await store.saveIntegrationSecret(account.tenantId, "forwarding", "carrier", JSON.stringify({ name: "T-Mobile USA", lineType: "mobile", family: "gsm", chosen: false }));
    const api = async (path: string, body: unknown = {}) => {
      const csrf = ((await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json()) as { csrf: string }).csrf;
      return fetch(`${baseUrl}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
    };
    return { cookie, account, api };
  }

  const founderEmails = (tenantId?: string) => [...store.notifications.values()].filter((item) => item.senderRef === "founder" && item.channel === "email" && (!tenantId || item.tenantId === tenantId));
  const webhook = async (eventType: string, id: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify({ data: { record_type: "event", event_type: eventType, id, occurred_at: clock.now().toISOString(), payload } });
    return fetch(`${baseUrl}/webhooks/telnyx`, { method: "POST", headers: signed(body, keys.privateKey, clock.now()), body });
  };
  const dialState = () => (recorded.filter((call) => call.url === "https://api.telnyx.com/v2/calls").at(-1)?.body as { client_state: string }).client_state;
  /** The setup helper calling one of its tools, signed like Telnyx does. */
  const tool = async (name: string, payload: Record<string, unknown>, sign = true) => {
    const body = JSON.stringify(payload);
    return fetch(`${baseUrl}/setup-help/tools/${name}`, { method: "POST", headers: sign ? signed(body, keys.privateKey, clock.now()) : { "content-type": "application/json" }, body });
  };
  return { store, clock, baseUrl, handler, recorded, busy, events, logs, owner, founderEmails, webhook, dialState, tool, privateKey: keys.privateKey, setTokenReply: (value: Record<string, unknown>) => { tokenReply = value; }, setDialFails: (value: boolean) => { dialFails = value; },
    holdEvents: () => { let release = () => {}; eventGate = new Promise<void>((resolve) => { release = () => { eventGate = null; resolve(); }; }); return release; } };
}

function signed(body: string, privateKey: KeyObject, now: Date): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  return { "content-type": "application/json", "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64") };
}

const BROCK = [{ id: "a", email: "brock.personal@example.com", bookHere: true }, { id: "b", email: "brock@work.example", bookHere: false }];

describe("Brock emails when the AI setup helper can't finish", () => {
  it("the help call can't be placed (not set up): Brock emails a booking link right away, once a day", async () => {
    const made = await app({ setupCalls: false, founders: BROCK });
    const { account, api } = await made.owner();
    expect((await api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
    const emails = made.founderEmails(account.tenantId);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.destinationRef).toBe("email:owner@synthetic.example");
    expect(emails[0]!.body).toContain("couldn't call you");
    expect(emails[0]!.body).toMatch(/https:\/\/front-office\.example\/book-setup\?t=\S+/);
    // Asking again the same day sends nothing more, even after the 20-minute loop.
    expect((await api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
    made.clock.at = new Date(made.clock.at.getTime() + 25 * 60_000);
    await made.handler.runFounderFollowups();
    expect(made.founderEmails(account.tenantId)).toHaveLength(1);
  });

  it("the dial fails: the owner app says Brock just emailed, and one email goes", async () => {
    const made = await app({ failDial: true, founders: BROCK });
    const { account, api } = await made.owner();
    const reply = await api("/api/app/line/help", { device: "android" });
    const line = ((await reply.json()) as { line: { helpRequestedAt: string | null; helpCall: unknown } }).line;
    // helpRequestedAt with no helpCall is what makes the app show "Brock, our founder, just emailed you...".
    expect(line.helpRequestedAt).toBeTruthy();
    expect(line.helpCall).toBeNull();
    expect(made.founderEmails(account.tenantId)).toHaveLength(1);
  });

  it("the helper can't start on an answered call: Brock emails first, then the short apology says so", async () => {
    const made = await app({ failHelperStart: true, founders: BROCK });
    const { account, api } = await made.owner();
    await api("/api/app/line/help", { device: "iphone" });
    expect(made.founderEmails(account.tenantId)).toHaveLength(0);
    expect((await made.webhook("call.answered", "evt-answered", { call_control_id: "v3:help-call", client_state: made.dialState() })).status).toBe(200);
    const speak = made.recorded.find((call) => call.url.endsWith("/actions/speak"));
    expect((speak?.body as { payload: string }).payload).toBe(SETUP_SORRY_SPEECH);
    const emails = made.founderEmails(account.tenantId);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.body).toContain("Our setup helper couldn't start on your call just now.");
    // The hang-up after the apology, a webhook retry, and the 20-minute loop add nothing.
    const sorryState = (speak?.body as { client_state: string }).client_state;
    await made.webhook("call.hangup", "evt-sorry-hangup", { call_control_id: "v3:help-call", client_state: sorryState, hangup_cause: "normal_clearing" });
    await made.webhook("call.answered", "evt-answered", { call_control_id: "v3:help-call", client_state: made.dialState() });
    made.clock.at = new Date(made.clock.at.getTime() + 21 * 60_000);
    await made.handler.runFounderFollowups();
    expect(made.founderEmails(account.tenantId)).toHaveLength(1);
  });

  it("the owner doesn't pick up (rang out, busy, declined): Brock emails as soon as the call ends", async () => {
    const made = await app({ founders: BROCK });
    const { account, api } = await made.owner();
    await api("/api/app/line/help", { device: "iphone" });
    expect((await made.webhook("call.hangup", "evt-no-answer", { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "timeout" })).status).toBe(200);
    const emails = made.founderEmails(account.tenantId);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.body).toContain("didn't reach you");
    made.clock.at = new Date(made.clock.at.getTime() + 21 * 60_000);
    await made.handler.runFounderFollowups();
    expect(made.founderEmails(account.tenantId)).toHaveLength(1);
  });

  it("an answered call that ends normally sends nothing; forwarding still off 20 minutes after asking sends one", async () => {
    const made = await app({ founders: BROCK });
    const { account, api } = await made.owner();
    await api("/api/app/line/help", { device: "iphone" });
    await made.webhook("call.answered", "evt-ok", { call_control_id: "v3:help-call", client_state: made.dialState() });
    expect(made.recorded.some((call) => call.url.endsWith("/actions/ai_assistant_start"))).toBe(true);
    await made.webhook("call.hangup", "evt-ok-hangup", { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "normal_clearing" });
    expect(made.founderEmails(account.tenantId)).toHaveLength(0);
    made.clock.at = new Date(made.clock.at.getTime() + 19 * 60_000);
    expect(await made.handler.runFounderFollowups()).toEqual({ queued: 0 });
    made.clock.at = new Date(made.clock.at.getTime() + 2 * 60_000);
    expect(await made.handler.runFounderFollowups()).toEqual({ queued: 1 });
    expect(await made.handler.runFounderFollowups()).toEqual({ queued: 0 });
    const emails = made.founderEmails(account.tenantId);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.body).toContain("We don't see call forwarding working for Gulf Air yet.");
  });

  it("the loop leaves alone shops whose forwarding got confirmed, and old requests", async () => {
    const made = await app({ founders: BROCK });
    const first = await made.owner();
    const second = await made.owner("second@synthetic.example", "Bay Plumbing");
    await first.api("/api/app/line/help", { device: "iphone" });
    await made.store.saveIntegrationSecret(first.account.tenantId, "forwarding", "confirmed_at", new Date(made.clock.at.getTime() + 5 * 60_000).toISOString());
    await made.store.saveIntegrationSecret(second.account.tenantId, "forwarding", "help_requested_at", new Date(made.clock.at.getTime() - 7 * 60 * 60_000).toISOString());
    made.clock.at = new Date(made.clock.at.getTime() + 30 * 60_000);
    expect(await made.handler.runFounderFollowups()).toEqual({ queued: 0 });
    expect(made.founderEmails()).toHaveLength(0);
  });

  it("a hang-up only means 'didn't reach you' for rang out, busy or declined; one that beats the answer sends nothing and starts nothing", async () => {
    for (const cause of ["user_busy", "call_rejected"]) {
      const made = await app({ founders: BROCK });
      const { account, api } = await made.owner();
      await api("/api/app/line/help", { device: "iphone" });
      await made.webhook("call.hangup", `evt-${cause}`, { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: cause });
      expect(made.founderEmails(account.tenantId)).toHaveLength(1);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    const made = await app({ founders: BROCK });
    const { account, api } = await made.owner();
    await api("/api/app/line/help", { device: "iphone" });
    // Picked up and hung up fast: Telnyx's hang-up lands before its answer. No "didn't reach you" email...
    await made.webhook("call.hangup", "evt-early-hangup", { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "normal_clearing" });
    expect(made.founderEmails(account.tenantId)).toHaveLength(0);
    // ...and the late answer doesn't start the helper on a call that's already over.
    await made.webhook("call.answered", "evt-late-answer", { call_control_id: "v3:help-call", client_state: made.dialState() });
    expect(made.recorded.some((call) => call.url.endsWith("/actions/ai_assistant_start"))).toBe(false);
    // A redelivered hang-up adds nothing either; the 20-minute check is the backstop.
    await made.webhook("call.hangup", "evt-early-hangup", { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "timeout" });
    expect(made.founderEmails(account.tenantId)).toHaveLength(0);
    made.clock.at = new Date(made.clock.at.getTime() + 21 * 60_000);
    expect(await made.handler.runFounderFollowups()).toEqual({ queued: 1 });
  });

  it("asking again while Otto's call is still ringing never dials over it or clears it", async () => {
    const made = await app({ founders: BROCK });
    const { account, api } = await made.owner();
    const dials = () => made.recorded.filter((call) => call.url === "https://api.telnyx.com/v2/calls").length;
    await api("/api/app/line/help", { device: "iphone" });
    expect(dials()).toBe(1);
    // A second tap (another device) whose dial would fail: the ringing call stays, nothing is emailed.
    made.setDialFails(true);
    made.clock.at = new Date(made.clock.at.getTime() + 20_000);
    const again = await api("/api/app/line/help", { device: "iphone" });
    expect(((await again.json()) as { line: { helpCall: { to: string } | null } }).line.helpCall).toMatchObject({ to: "+19415550199" });
    expect(dials()).toBe(1);
    expect(made.founderEmails(account.tenantId)).toHaveLength(0);
    expect(JSON.parse((await made.store.getIntegrationSecret(account.tenantId, "forwarding", "setup_call"))!)).toMatchObject({ callControlId: "v3:help-call" });
    // The owner picks up: the helper starts on that call.
    await made.webhook("call.answered", "evt-answered", { call_control_id: "v3:help-call", client_state: made.dialState() });
    expect(made.recorded.some((call) => call.url.endsWith("/actions/ai_assistant_start"))).toBe(true);
    // Later, with that call over, a failed dial clears it and Brock emails.
    await made.webhook("call.hangup", "evt-done", { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "normal_clearing" });
    made.clock.at = new Date(made.clock.at.getTime() + 3 * 60_000);
    await api("/api/app/line/help", { device: "iphone" });
    expect(dials()).toBe(2);
    expect(await made.store.getIntegrationSecret(account.tenantId, "forwarding", "setup_call")).toBeNull();
    expect(made.founderEmails(account.tenantId)).toHaveLength(1);
  });

  it("the app, the 'called you a few times' message and the apology only mention a link when the email had one", async () => {
    // Three support calls a day per shop (each rang and ended), then our team's email carries it.
    const useUpCalls = async (made: Awaited<ReturnType<typeof app>>, owner: Awaited<ReturnType<Awaited<ReturnType<typeof app>>["owner"]>>) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await owner.api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
        await made.webhook("call.hangup", `evt-used-${attempt}`, { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "normal_clearing" });
      }
      expect(made.recorded.filter((call) => call.url === "https://api.telnyx.com/v2/calls")).toHaveLength(3);
    };
    const withLink = await app({ founders: BROCK });
    const linked = await withLink.owner();
    await useUpCalls(withLink, linked);
    const limited = await linked.api("/api/app/line/help", { device: "iphone" });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe("Otto has called you a few times today. Our team emailed you a link to book a 10-minute call.");
    expect(withLink.recorded.filter((call) => call.url === "https://api.telnyx.com/v2/calls")).toHaveLength(3);
    const linkedLine = ((await (await fetch(`${withLink.baseUrl}/api/app/dashboard`, { headers: { cookie: linked.cookie } })).json()) as { line: { founderEmail: unknown } }).line;
    expect(linkedLine.founderEmail).toEqual({ sentAt: withLink.clock.now().toISOString(), link: true });
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    // No founder calendar connected yet: the email asks for a reply, so nothing claims a link.
    const noCalendar = await app({ setupCalls: false });
    const unlinked = await noCalendar.owner();
    const line = ((await (await unlinked.api("/api/app/line/help", { device: "iphone" })).json()) as { line: { founderEmail: unknown } }).line;
    expect(line.founderEmail).toEqual({ sentAt: noCalendar.clock.now().toISOString(), link: false });
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const noCalendarCalls = await app({});
    const unlinkedCalls = await noCalendarCalls.owner();
    await useUpCalls(noCalendarCalls, unlinkedCalls);
    const limitedNoLink = await unlinkedCalls.api("/api/app/line/help", { device: "iphone" });
    expect(limitedNoLink.status).toBe(429);
    expect(((await limitedNoLink.json()) as { error: string }).error).toBe("Otto has called you a few times today. Our team emailed you to set up a quick call.");
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    const helperFails = await app({ failHelperStart: true });
    const owner = await helperFails.owner();
    await owner.api("/api/app/line/help", { device: "iphone" });
    await helperFails.webhook("call.answered", "evt-answered", { call_control_id: "v3:help-call", client_state: helperFails.dialState() });
    const speak = helperFails.recorded.find((call) => call.url.endsWith("/actions/speak"));
    expect((speak?.body as { payload: string }).payload).toBe(setupSorrySpeech({ fresh: true, link: false }));
    expect(helperFails.founderEmails(owner.account.tenantId)).toHaveLength(1);
  });

  it("with no founder calendar connected, the email asks for a reply instead of a link, and says why in the log", async () => {
    const made = await app({ setupCalls: false });
    const { account, api } = await made.owner();
    await api("/api/app/line/help", { device: "iphone" });
    const emails = made.founderEmails(account.tenantId);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.body).toContain("Just reply with a good time for a quick 10-minute call.");
    expect(emails[0]!.body).not.toContain("book-setup");
    expect(made.logs.some((entry) => entry.event === "founder_calendar_not_connected" && entry.level === "warn")).toBe(true);
  });
});

describe("booking a call with Brock", () => {
  async function bookingLink(made: Awaited<ReturnType<typeof app>>, tenantId: string): Promise<string> {
    const body = made.founderEmails(tenantId)[0]!.body;
    return `${made.baseUrl}/book-setup?t=${/book-setup\?t=(\S+)/.exec(body)![1]}`;
  }
  const starts = (html: string): string[] => [...html.matchAll(/name="start" value="([^"]+)"/g)].map((match) => match[1]!);

  it("shows open times from both calendars in the owner's zone, books on the 'book here' account with no guests, and confirms by email", async () => {
    const made = await app({ setupCalls: false, founders: BROCK });
    // Account B is busy all Monday afternoon (2-5 PM Eastern).
    made.busy.b = [{ start: "2026-11-30T19:00:00Z", end: "2026-11-30T22:00:00Z" }];
    const { account, api } = await made.owner();
    await api("/api/app/line/help", { device: "iphone" });
    const link = await bookingLink(made, account.tenantId);
    const page = await fetch(link);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Book a 10-minute call with our team.");
    expect(html).not.toContain("Brock");
    expect(html).toContain("Times are in your time zone (CST).");
    // Monday in Chicago: 9:00 AM (10 Eastern) and the morning picks; nothing in Brock's busy afternoon.
    expect(html).toContain(">9:00 AM<");
    const offered = starts(html);
    expect(offered.filter((start) => start.startsWith("2026-11-30")).every((start) => Date.parse(start) < Date.parse("2026-11-30T19:00:00Z"))).toBe(true);
    expect(html).not.toContain("brock.personal@example.com");

    const picked = offered[0]!;
    const booked = await fetch(`${made.baseUrl}/book-setup`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: new URL(link).searchParams.get("t")!, start: picked }) });
    expect(booked.status).toBe(200);
    expect(await booked.text()).toContain("Mon, Nov 30 at 9:00 AM CST");
    const insert = made.recorded.find((call) => call.method === "POST" && call.url.includes("/calendars/primary/events"))!;
    expect(insert.url).toContain("sendUpdates=none");
    expect(insert.auth).toBe("Bearer at-refresh-a");
    const event = insert.body as Record<string, unknown>;
    expect(event.attendees).toBeUndefined();
    expect(event.summary).toBe("Call Otto setup: Gulf Air (10 min)");
    expect(event.description).toContain("Call them at: (941) 555-0199");
    expect(event.description).toContain("Carrier: T-Mobile USA");
    expect(event.description).toContain("Forwarding code: **21*19415550123#");
    const confirmation = made.founderEmails(account.tenantId).find((item) => item.idempotencyKey.endsWith(":confirmation"))!;
    expect(confirmation.body).toContain("You're set for Mon, Nov 30 at 9:00 AM CST. We'll call you at (941) 555-0199");
    expect(parseEmailBody(confirmation.body).attachments[0]!.filename).toBe("call-otto-setup.ics");
    // Opening the link again shows the booking instead of booking twice.
    expect(await (await fetch(link)).text()).toContain("<h1>You’re set.</h1>");
  });

  it("a time that just got taken asks for another, whether Google says so or another shop booked it first", async () => {
    const made = await app({ setupCalls: false, founders: BROCK });
    const first = await made.owner();
    const second = await made.owner("second@synthetic.example", "Bay Plumbing");
    await first.api("/api/app/line/help", { device: "iphone" });
    await second.api("/api/app/line/help", { device: "iphone" });
    const firstLink = new URL(await bookingLink(made, first.account.tenantId));
    const secondLink = new URL(await bookingLink(made, second.account.tenantId));
    const offered = starts(await (await fetch(firstLink)).text());
    const post = (link: URL, start: string) => fetch(`${made.baseUrl}/book-setup`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: link.searchParams.get("t")!, start }) });

    // Brock's other calendar filled the slot after the page loaded.
    made.busy.b = [{ start: offered[0]!, end: new Date(Date.parse(offered[0]!) + 30 * 60_000).toISOString() }];
    const taken = await post(firstLink, offered[0]!);
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain("That time just got taken. Pick another.");
    made.busy.b = [];

    // Two shops race for the same time: the first books it; the second is told to pick again, even before Google shows it busy.
    const [one, two] = await Promise.all([post(firstLink, offered[1]!), post(secondLink, offered[1]!)]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(made.recorded.filter((call) => call.method === "POST" && call.url.includes("/calendars/primary/events"))).toHaveLength(1);
  });

  it("a double tap books once: another time or the same one shows the booked call, never a second event", async () => {
    const made = await app({ setupCalls: false, founders: BROCK });
    const { account, api } = await made.owner();
    await api("/api/app/line/help", { device: "iphone" });
    const link = new URL(await bookingLink(made, account.tenantId));
    const offered = starts(await (await fetch(link)).text());
    const post = (start: string) => fetch(`${made.baseUrl}/book-setup`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: link.searchParams.get("t")!, start }) });
    // The first tap is mid-booking (Google hasn't answered yet) when the second, for another time, arrives.
    const release = made.holdEvents();
    const firstTap = post(offered[0]!);
    while (!made.recorded.some((call) => call.method === "POST" && call.url.includes("/calendars/primary/events"))) await new Promise((resolve) => setTimeout(resolve, 5));
    const secondTap = post(offered[1]!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [one, two] = await Promise.all([firstTap, secondTap]);
    expect([one.status, two.status]).toEqual([200, 200]);
    const [first, second] = [await one.text(), await two.text()];
    const label = /<p class="done">([^<]+)<\/p>/;
    expect(label.exec(first)?.[1]).toBeTruthy();
    expect(label.exec(second)?.[1]).toBe(label.exec(first)?.[1]);
    // The same time again on a slow connection: still "you're set", not "that time just got taken".
    const retap = await post(offered[0]!);
    expect(retap.status).toBe(200);
    expect(await retap.text()).not.toContain("just got taken");
    expect(made.recorded.filter((call) => call.method === "POST" && call.url.includes("/calendars/primary/events"))).toHaveLength(1);
    expect(made.founderEmails(account.tenantId).filter((item) => item.idempotencyKey.endsWith(":confirmation"))).toHaveLength(1);
  });

  it("never offers Thanksgiving or the day after, and refuses a crafted POST for a holiday time", async () => {
    const made = await app({ setupCalls: false, founders: BROCK });
    // Wednesday Nov 25 2026, 9:00 AM Eastern.
    made.clock.at = new Date("2026-11-25T14:00:00Z");
    const { account, api } = await made.owner();
    await api("/api/app/line/help", { device: "iphone" });
    const link = new URL(await bookingLink(made, account.tenantId));
    const offered = starts(await (await fetch(link)).text());
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.filter((start) => start.startsWith("2026-11-26") || start.startsWith("2026-11-27"))).toEqual([]);
    expect(offered.some((start) => start.startsWith("2026-11-30"))).toBe(true);
    // Thanksgiving 10:00 AM Eastern: on the grid, inside the windows, within five business days, and still refused.
    const crafted = await fetch(`${made.baseUrl}/book-setup`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: link.searchParams.get("t")!, start: "2026-11-26T15:00:00.000Z" }) });
    expect(crafted.status).toBe(409);
    expect(await crafted.text()).toContain("Pick another.");
    expect(made.recorded.filter((call) => call.method === "POST" && call.url.includes("/calendars/primary/events"))).toHaveLength(0);
    expect(await made.store.getIntegrationSecret(account.tenantId, "founder", "booking")).toBeNull();
    expect(made.founderEmails(account.tenantId).filter((item) => item.idempotencyKey.endsWith(":confirmation"))).toHaveLength(0);
  });

  it("a tampered or expired link shows a plain expired page", async () => {
    const made = await app({ setupCalls: false, founders: BROCK });
    const { account, api } = await made.owner();
    await api("/api/app/line/help", { device: "iphone" });
    const link = new URL(await bookingLink(made, account.tenantId));
    const tampered = await fetch(`${made.baseUrl}/book-setup?t=${encodeURIComponent(`${link.searchParams.get("t")!}x`)}`);
    expect(tampered.status).toBe(404);
    expect(await tampered.text()).toContain("This link has expired.");
    made.clock.at = new Date(made.clock.at.getTime() + 8 * 24 * 60 * 60_000);
    expect((await fetch(link)).status).toBe(404);
  });

  it("with no founder calendar connected, the page asks for a reply", async () => {
    const made = await app({ setupCalls: false });
    const { account } = await made.owner();
    const token = founderBookingToken(KEY, account.tenantId, made.clock.now());
    const html = await (await fetch(`${made.baseUrl}/book-setup?t=${encodeURIComponent(token)}`)).text();
    expect(html).toContain("Online booking isn’t open yet. Reply to our team’s email with a good time and we’ll call you.");
  });
});

describe("connecting Brock's calendars", () => {
  it("a signed link starts Google sign-in on the one registered redirect URI with its own cookie, no admin session needed", async () => {
    const made = await app({ setupCalls: false });
    expect((await fetch(`${made.baseUrl}/admin/founder-calendars/connect?k=forged`, { redirect: "manual" })).status).toBe(401);
    const k = founderConnectToken(KEY, made.clock.now());
    const start = await fetch(`${made.baseUrl}/admin/founder-calendars/connect?k=${encodeURIComponent(k)}`, { redirect: "manual" });
    expect(start.status).toBe(303);
    const google = new URL(start.headers.get("location")!);
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("redirect_uri")).toBe("https://front-office.example/app/integrations/google/callback");
    expect(google.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events.owned");
    expect(google.searchParams.get("access_type")).toBe("offline");
    expect(google.searchParams.get("prompt")).toBe("consent");
    const [cookie, returnCookie] = start.headers.getSetCookie();
    expect(cookie).toMatch(/^afo_google_founder=[^;]+; Path=\/app\/integrations\/google; HttpOnly; SameSite=Lax; Max-Age=600/);
    expect(returnCookie).toMatch(/^afo_google_founder_k=[^;]+; Path=\/app\/integrations\/google; HttpOnly; SameSite=Lax; Max-Age=600/);

    const idToken = `x.${Buffer.from(JSON.stringify({ sub: "google-sub-1", email: "Brock.Personal@example.com" })).toString("base64url")}.y`;
    made.setTokenReply({ refresh_token: "refresh-new", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events.owned", id_token: idToken });
    const callback = new URL(`${made.baseUrl}/app/integrations/google/callback`);
    callback.searchParams.set("state", google.searchParams.get("state")!);
    callback.searchParams.set("code", "synthetic-code");
    const done = await fetch(callback, { redirect: "manual", headers: { cookie: `${cookie!.split(";")[0]!}; ${returnCookie!.split(";")[0]!}` } });
    expect(done.status).toBe(303);
    const back = done.headers.get("location")!;
    // Back with the very link it started with: the return trip never mints a new one.
    expect(back).toBe(`/admin/founder-calendars?k=${encodeURIComponent(k)}&done=connected`);
    expect(done.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^afo_google_founder=; Path=\/app\/integrations\/google;.*Max-Age=0/),
      expect.stringMatching(/^afo_google_founder_k=; Path=\/app\/integrations\/google;.*Max-Age=0/),
    ]);
    const accounts = JSON.parse((await made.store.getIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, "accounts"))!) as Array<{ id: string; email: string; bookHere: boolean; calendarsSource: string }>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ email: "brock.personal@example.com", bookHere: true, calendarsSource: "primary" });
    expect(await made.store.getIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, `token:${accounts[0]!.id}`)).toContain("refresh-new");

    const page = await (await fetch(`${made.baseUrl}${back}`)).text();
    expect(page).toContain(maskEmail("brock.personal@example.com"));
    expect(page).not.toContain("brock.personal@example.com");
    expect(page).toContain("Main calendar only");
    expect(page).toContain("Mon-Fri 10:00-12:00,14:00-17:00 (America/New_York)");
  });

  it("picks which account takes bookings and disconnects, with the link as the form's proof", async () => {
    const made = await app({ setupCalls: false, founders: BROCK });
    const k = founderConnectToken(KEY, made.clock.now());
    const post = (path: string, fields: Record<string, string>) => fetch(`${made.baseUrl}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
    expect((await post("/admin/founder-calendars/book-here", { account: "b" })).status).toBe(401);
    expect((await post("/admin/founder-calendars/book-here", { k, account: "b" })).status).toBe(303);
    const read = async () => JSON.parse((await made.store.getIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, "accounts"))!) as Array<{ id: string; bookHere: boolean }>;
    expect((await read()).find((account) => account.bookHere)?.id).toBe("b");
    expect((await post("/admin/founder-calendars/disconnect", { k, account: "b" })).status).toBe(303);
    expect((await read()).map((account) => ({ id: account.id, bookHere: account.bookHere }))).toEqual([{ id: "a", bookHere: true }]);
    expect(await made.store.getIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, "token:b")).toBeNull();
  });

  it("Google's return never renews a link: same link back, and none once it ran out", async () => {
    const made = await app({ setupCalls: false });
    const k = founderConnectToken(KEY, made.clock.now(), 60 * 60_000);
    const begin = async (headers: Record<string, string>, query = "") => {
      const start = await fetch(`${made.baseUrl}/admin/founder-calendars/connect${query}`, { redirect: "manual", headers });
      expect(start.status).toBe(303);
      const [cookie, returnCookie] = start.headers.getSetCookie().map((value) => value.split(";")[0]!);
      return { state: new URL(start.headers.get("location")!).searchParams.get("state")!, cookie: cookie!, returnCookie: returnCookie! };
    };
    const finish = async (attempt: { state: string; cookie: string }, cookies: string) => {
      const callback = new URL(`${made.baseUrl}/app/integrations/google/callback`);
      callback.searchParams.set("state", attempt.state);
      callback.searchParams.set("error", "access_denied");
      const done = await fetch(callback, { redirect: "manual", headers: { cookie: `${attempt.cookie}; ${cookies}` } });
      expect(done.status).toBe(303);
      return done.headers.get("location")!;
    };

    // Cancelled at Google (or replayed with a made-up error, no Google needed): the same link back, not a fresh one.
    const viaLink = await begin({}, `?k=${encodeURIComponent(k)}`);
    expect(await finish(viaLink, viaLink.returnCookie)).toBe(`/admin/founder-calendars?k=${encodeURIComponent(k)}&error=declined`);
    // Without the return cookie, or with one that isn't a valid link: no link at all.
    expect(await finish(await begin({}, `?k=${encodeURIComponent(k)}`), "")).toBe("/admin/founder-calendars?error=declined");
    expect(await finish(await begin({}, `?k=${encodeURIComponent(k)}`), "afo_google_founder_k=forged")).toBe("/admin/founder-calendars?error=declined");
    // The link ran out while at Google: back without it (sign in as admin), never renewed.
    const short = founderConnectToken(KEY, made.clock.now(), 60_000);
    const late = await begin({}, `?k=${encodeURIComponent(short)}`);
    made.clock.at = new Date(made.clock.at.getTime() + 2 * 60_000);
    expect(await finish(late, late.returnCookie)).toBe("/admin/founder-calendars?error=declined");
  });

  it("leaves the owner's own calendar connect exactly as it was, with or without a stray founder cookie", async () => {
    const made = await app({ setupCalls: false });
    const { cookie, account } = await made.owner();
    made.setTokenReply({ refresh_token: "owner-refresh", scope: "https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy" });
    for (const extra of ["", "; afo_google_founder=stray-value"]) {
      await made.store.deleteIntegrationSecret(account.tenantId, "google", "refresh_token");
      const start = await fetch(`${made.baseUrl}/app/integrations/google/start`, { redirect: "manual", headers: { cookie } });
      const google = new URL(start.headers.get("location")!);
      expect(google.searchParams.get("redirect_uri")).toBe("https://front-office.example/app/integrations/google/callback");
      const pkce = start.headers.get("set-cookie")!.split(";")[0]!;
      const callback = new URL(`${made.baseUrl}/app/integrations/google/callback`);
      callback.searchParams.set("state", google.searchParams.get("state")!);
      callback.searchParams.set("code", "owner-code");
      const done = await fetch(callback, { redirect: "manual", headers: { cookie: `${cookie}; ${pkce}${extra}` } });
      expect(done.status).toBe(303);
      expect(done.headers.get("location")).toBe("/app/settings");
      expect(await made.store.getIntegrationSecret(account.tenantId, "google", "refresh_token")).toContain("owner-refresh");
    }
    expect(await made.store.getIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, "accounts")).toBeNull();
    // Signed out, with only a stray founder cookie: still the owner sign-in redirect, as before.
    const signedOut = await fetch(`${made.baseUrl}/app/integrations/google/callback?state=x&code=y`, { redirect: "manual", headers: { cookie: "afo_google_founder=stray-value" } });
    expect(signedOut.headers.get("location")).toBe("/login");
  });
});

describe("founder review fixes", () => {
  it("an admin connect goes back with no link in the address: its own page hops back, so the admin session opens it", async () => {
    const made = await app({ setupCalls: false });
    const begin = async () => {
      const start = await fetch(`${made.baseUrl}/admin/founder-calendars/connect`, { redirect: "manual", headers: { authorization: `Bearer ${baseEnv().ADMIN_TOKEN}` } });
      expect(start.status).toBe(303);
      const [cookie, returnCookie] = start.headers.getSetCookie().map((value) => value.split(";")[0]!);
      // Nothing in the return cookie works as a link either.
      expect(founderConnectTokenValid(KEY, decodeURIComponent(returnCookie!.slice(returnCookie!.indexOf("=") + 1)), made.clock.now())).toBe(false);
      return { state: new URL(start.headers.get("location")!).searchParams.get("state")!, cookies: `${cookie}; ${returnCookie}` };
    };
    const finish = async (attempt: { state: string; cookies: string }, params: Record<string, string>) => {
      const callback = new URL(`${made.baseUrl}/app/integrations/google/callback`);
      callback.searchParams.set("state", attempt.state);
      for (const [name, value] of Object.entries(params)) callback.searchParams.set(name, value);
      return fetch(callback, { redirect: "manual", headers: { cookie: attempt.cookies } });
    };
    const idToken = `x.${Buffer.from(JSON.stringify({ sub: "google-sub-1", email: "brock.personal@example.com" })).toString("base64url")}.y`;
    made.setTokenReply({ refresh_token: "refresh-new", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events.owned", id_token: idToken });
    for (const [params, query] of [[{ code: "synthetic-code" }, "done=connected"], [{ error: "access_denied" }, "error=declined"]] as const) {
      const done = await finish(await begin(), params);
      expect(done.status).toBe(200);
      expect(done.headers.get("location")).toBeNull();
      const html = await done.text();
      expect(html).toContain(`<meta http-equiv="refresh" content="0;url=/admin/founder-calendars?${query}">`);
      expect(html).not.toMatch(/[?&;]k=/);
    }
    expect(JSON.parse((await made.store.getIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, "accounts"))!)).toHaveLength(1);
  });

  it("a booking whose confirmation can't be queued still books, and reopening the link queues it once", async () => {
    const made = await app({ setupCalls: false, founders: BROCK });
    const { account, api } = await made.owner();
    await api("/api/app/line/help", { device: "iphone" });
    const link = `${made.baseUrl}/book-setup?t=${/book-setup\?t=(\S+)/.exec(made.founderEmails(account.tenantId)[0]!.body)![1]}`;
    const offered = [...(await (await fetch(link)).text()).matchAll(/name="start" value="([^"]+)"/g)].map((match) => match[1]!);
    const enqueue = made.store.enqueueNotification.bind(made.store);
    let failConfirmation = true;
    made.store.enqueueNotification = async (notification) => {
      if (failConfirmation && notification.idempotencyKey.endsWith(":confirmation")) {
        failConfirmation = false;
        throw new Error("outbox unavailable");
      }
      return enqueue(notification);
    };
    const booked = await fetch(`${made.baseUrl}/book-setup`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: new URL(link).searchParams.get("t")!, start: offered[0]! }) });
    expect(booked.status).toBe(200);
    expect(await booked.text()).toContain("<h1>You’re set.</h1>");
    expect(made.logs.some((entry) => entry.event === "founder_confirmation_failed" && entry.level === "error")).toBe(true);
    const confirmations = () => made.founderEmails(account.tenantId).filter((item) => item.idempotencyKey.endsWith(":confirmation"));
    expect(confirmations()).toHaveLength(0);
    for (let open = 0; open < 2; open += 1) expect(await (await fetch(link)).text()).toContain("<h1>You’re set.</h1>");
    expect(confirmations()).toHaveLength(1);
  });

  it("a booking cut off before the shop's record was saved books the same time on retry, never 'taken' by its own hold", async () => {
    const made = await app({ setupCalls: false, founders: BROCK });
    const first = await made.owner();
    const second = await made.owner("second@synthetic.example", "Bay Plumbing");
    await first.api("/api/app/line/help", { device: "iphone" });
    await second.api("/api/app/line/help", { device: "iphone" });
    const linkFor = (tenantId: string) => new URL(`${made.baseUrl}/book-setup?t=${/book-setup\?t=(\S+)/.exec(made.founderEmails(tenantId)[0]!.body)![1]}`);
    const firstLink = linkFor(first.account.tenantId);
    const offered = [...(await (await fetch(firstLink)).text()).matchAll(/name="start" value="([^"]+)"/g)].map((match) => match[1]!);
    const post = (link: URL, start: string) => fetch(`${made.baseUrl}/book-setup`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t: link.searchParams.get("t")!, start }) });
    const save = made.store.saveIntegrationSecret.bind(made.store);
    let dies = true;
    made.store.saveIntegrationSecret = async (tenantId, provider, key, value) => {
      if (dies && provider === "founder" && key === "booking") {
        dies = false;
        throw new Error("process died");
      }
      return save(tenantId, provider, key, value);
    };
    expect((await post(firstLink, offered[0]!)).status).toBe(503);
    // Google's busy times now show the shop's own event: the retry finds it's theirs instead of calling the time taken.
    expect([...made.events.a!.values()].map((event) => event.start)).toEqual([offered[0]!]);
    const retry = await post(firstLink, offered[0]!);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain("<h1>You’re set.</h1>");
    const inserts = made.recorded.filter((call) => call.method === "POST" && call.url.includes("/calendars/primary/events")).map((call) => (call.body as { id: string }).id);
    expect(new Set(inserts).size).toBe(1);
    expect(made.recorded.filter((call) => call.method === "GET" && call.url.endsWith(`/calendars/primary/events/${inserts[0]!}`))).toHaveLength(1);
    expect(made.events.a!.size).toBe(1);
    expect(made.founderEmails(first.account.tenantId).filter((item) => item.idempotencyKey.endsWith(":confirmation"))).toHaveLength(1);

    // A hold left behind by an older cut-off booking never blocks its own shop, and still blocks every other shop.
    const held = offered[2]!;
    const stored = JSON.parse((await made.store.getIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, "booked"))!) as Array<Record<string, string>>;
    await made.store.saveIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, "booked", JSON.stringify([...stored, { start: held, end: new Date(Date.parse(held) + 10 * 60_000).toISOString(), tenantId: second.account.tenantId }]));
    const third = await made.owner("third@synthetic.example", "Cove Electric");
    await third.api("/api/app/line/help", { device: "iphone" });
    expect((await post(linkFor(third.account.tenantId), held)).status).toBe(409);
    expect((await post(linkFor(second.account.tenantId), held)).status).toBe(200);
  });
});

describe("Call me now: Otto's support call", () => {
  type Line = { helpCall: { to: string; answeredAt: string | null; endedAt: string | null; outcome: string | null; booked: boolean } | null; helpBookUrl: string | null };
  const line = async (made: Awaited<ReturnType<typeof app>>, cookie: string) => ((await (await fetch(`${made.baseUrl}/api/app/dashboard`, { headers: { cookie } })).json()) as { line: Line }).line;
  const dials = (made: Awaited<ReturnType<typeof app>>) => made.recorded.filter((call) => call.url === "https://api.telnyx.com/v2/calls" && Buffer.from(String((call.body as { client_state?: string }).client_state ?? ""), "base64").toString().startsWith("setup-help:"));
  const hangups = (made: Awaited<ReturnType<typeof app>>) => made.recorded.filter((call) => call.url.endsWith("/calls/v3%3Ahelp-call/actions/hangup")).length;
  /** A shop that tapped Call me now and picked up. */
  async function onTheCall(options: Parameters<typeof app>[0] = {}) {
    const made = await app(options);
    const owner = await made.owner();
    expect((await owner.api("/api/app/line/help", { device: "android" })).status).toBe(200);
    await made.webhook("call.answered", "evt-answered", { call_control_id: "v3:help-call", client_state: made.dialState() });
    return { ...made, ...owner };
  }

  it("only a signed-in owner can start it, and it rings only the saved owner mobile, capped at six minutes, listening for voicemail", async () => {
    const made = await app();
    const unsigned = await fetch(`${made.baseUrl}/api/app/line/help`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unsigned.status).toBe(401);
    const owner = await made.owner();
    expect((await owner.api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
    const dial = dials(made)[0]!.body as Record<string, unknown>;
    // The saved owner mobile, never the business number on file.
    expect(dial).toMatchObject({ to: "+19415550199", from: "+15555550199", time_limit_secs: 360, answering_machine_detection: "premium" });
    // The screen: calling, masked on the screen side, with the booking fallback.
    const calling = await line(made, owner.cookie);
    expect(calling.helpCall).toMatchObject({ to: "+19415550199", answeredAt: null, endedAt: null, outcome: null });
    expect(calling.helpBookUrl).toMatch(/^\/book-setup\?t=/);
    // A second tap while it rings never dials again.
    await owner.api("/api/app/line/help", { device: "iphone" });
    expect(dials(made)).toHaveLength(1);
    await made.webhook("call.answered", "evt-answered", { call_control_id: "v3:help-call", client_state: made.dialState() });
    expect((await line(made, owner.cookie)).helpCall).toMatchObject({ answeredAt: made.clock.now().toISOString(), endedAt: null });
    // On the call: still one call, even minutes in.
    made.clock.at = new Date(made.clock.at.getTime() + 4 * 60_000);
    await owner.api("/api/app/line/help", { device: "iphone" });
    expect(dials(made)).toHaveLength(1);
    await made.webhook("call.hangup", "evt-hangup", { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "normal_clearing" });
    expect((await line(made, owner.cookie)).helpCall).toMatchObject({ outcome: "done", booked: false });
    // Logged with its outcome, never the number.
    const ended = made.logs.find((entry) => entry.event === "setup_call_ended")!;
    expect(ended).toMatchObject({ outcome: "done", talkedSec: 240 });
    expect(JSON.stringify(made.logs)).not.toContain("9415550199");
  });

  it("no saved owner mobile: no call, our team's email instead", async () => {
    const made = await app({ founders: BROCK });
    const owner = await made.owner();
    await made.store.deleteIntegrationSecret(owner.account.tenantId, "notifications", "owner-primary");
    expect((await owner.api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
    expect(dials(made)).toHaveLength(0);
    expect(made.founderEmails(owner.account.tenantId)).toHaveLength(1);
  });

  it("voicemail answers: we hang up, never start the helper, and the screen offers a time", async () => {
    const made = await app();
    const owner = await made.owner();
    await owner.api("/api/app/line/help", { device: "iphone" });
    await made.webhook("call.machine.premium.detection.ended", "evt-amd", { call_control_id: "v3:help-call", client_state: made.dialState(), result: "machine" });
    expect(hangups(made)).toBe(1);
    await made.webhook("call.answered", "evt-answered-late", { call_control_id: "v3:help-call", client_state: made.dialState() });
    expect(made.recorded.some((call) => call.url.endsWith("/actions/ai_assistant_start"))).toBe(false);
    await made.webhook("call.hangup", "evt-hangup", { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "normal_clearing" });
    expect((await line(made, owner.cookie)).helpCall).toMatchObject({ outcome: "voicemail" });
    // A person picking up is left alone.
    const person = await app();
    const other = await person.owner();
    await other.api("/api/app/line/help", { device: "iphone" });
    await person.webhook("call.machine.premium.detection.ended", "evt-amd", { call_control_id: "v3:help-call", client_state: person.dialState(), result: "human_residence" });
    expect(person.recorded.filter((call) => call.url.endsWith("/actions/hangup"))).toHaveLength(0);
  });

  it("voicemail after the helper started: a retried event hangs up again, and no tool runs on the machine", async () => {
    const made = await onTheCall();
    await made.webhook("call.machine.premium.detection.ended", "evt-amd", { call_control_id: "v3:help-call", client_state: made.dialState(), result: "machine" });
    await made.webhook("call.machine.premium.detection.ended", "evt-amd", { call_control_id: "v3:help-call", client_state: made.dialState(), result: "machine" });
    expect(hangups(made)).toBe(2);
    const before = made.recorded.filter((call) => call.url === "https://api.telnyx.com/v2/calls").length;
    expect(await (await made.tool("start_forwarding_test", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "unavailable" });
    expect(made.recorded.filter((call) => call.url === "https://api.telnyx.com/v2/calls")).toHaveLength(before);
    await made.webhook("call.hangup", "evt-hangup", { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "normal_clearing" });
    await made.webhook("call.machine.premium.detection.ended", "evt-amd", { call_control_id: "v3:help-call", client_state: made.dialState(), result: "machine" });
    expect(hangups(made)).toBe(2);
  });

  it("a saved mobile that is one of Otto's own numbers is never dialed", async () => {
    for (const number of ["+19415550123", "+15555550199"]) {
      const made = await app();
      const owner = await made.owner();
      await made.store.saveIntegrationSecret(owner.account.tenantId, "notifications", "owner-primary", number);
      expect((await owner.api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
      expect(dials(made)).toHaveLength(0);
      expect((await line(made, owner.cookie)).helpCall).toMatchObject({ outcome: "looped" });
    }
  });

  it("a dial that fails still counts toward today's calls (it may have rung)", async () => {
    const made = await app();
    const owner = await made.owner();
    made.setDialFails(true);
    for (let tap = 0; tap < 3; tap += 1) {
      await owner.api("/api/app/line/help", { device: "iphone" });
      made.clock.at = new Date(made.clock.at.getTime() + 3 * 60_000);
    }
    made.setDialFails(false);
    expect((await owner.api("/api/app/line/help", { device: "iphone" })).status).toBe(429);
  });

  it("their phone forwards every call to Otto: no call (it would come back to Otto), and the screen says so plainly", async () => {
    const made = await app({ founders: BROCK });
    const owner = await made.owner();
    // The owner's mobile IS the business number, and every call is picked.
    await made.store.saveIntegrationSecret(owner.account.tenantId, "forwarding", "business_number", "+19415550199");
    await made.store.saveConfig({ ...await made.store.getConfig(owner.account.tenantId), operationMode: "always" });
    expect((await owner.api("/api/app/line/help", { device: "iphone" })).status).toBe(200);
    expect(dials(made)).toHaveLength(0);
    expect((await line(made, owner.cookie)).helpCall).toMatchObject({ outcome: "looped", endedAt: made.clock.now().toISOString() });
    expect(made.founderEmails(owner.account.tenantId)).toHaveLength(0);
  });

  it("tools only run for the live support call they were started on, signed by Telnyx", async () => {
    const made = await onTheCall({ founders: BROCK });
    expect((await made.tool("get_test_result", { provider_call_id: "v3:help-call" }, false)).status).toBe(401);
    expect(await (await made.tool("get_test_result", { provider_call_id: "v3:someone-else" })).json()).toMatchObject({ status: "unavailable" });
    expect((await made.tool("delete_everything", { provider_call_id: "v3:help-call" })).status).toBe(404);
    // A signed body without the call id never picks the shop from an unsigned header.
    const bare = JSON.stringify({});
    const viaHeader = await fetch(`${made.baseUrl}/setup-help/tools/get_test_result`, { method: "POST", headers: { ...signed(bare, made.privateKey, made.clock.now()), "x-telnyx-call-control-id": "v3:help-call" }, body: bare });
    expect(await viaHeader.json()).toMatchObject({ status: "unavailable" });
    expect(await (await made.tool("get_test_result", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "idle", minutes_on_call: 0, offer_team_time: false });
    await made.webhook("call.hangup", "evt-hangup", { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "normal_clearing" });
    // Over: nothing more runs on it.
    expect(await (await made.tool("email_steps", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "unavailable" });
  });

  it("a call that rang but was never answered can't run tools", async () => {
    const made = await app();
    const owner = await made.owner();
    await owner.api("/api/app/line/help", { device: "iphone" });
    expect(await (await made.tool("start_forwarding_test", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "unavailable" });
    expect(made.recorded.filter((call) => call.url === "https://api.telnyx.com/v2/calls")).toHaveLength(1);
  });

  it("start_forwarding_test rings the business phone and get_test_result reads it; after two minutes it says to offer our team", async () => {
    const made = await onTheCall();
    const started = await (await made.tool("start_forwarding_test", { provider_call_id: "v3:help-call" })).json() as Record<string, unknown>;
    expect(started).toMatchObject({ status: "calling" });
    const check = made.recorded.filter((call) => call.url === "https://api.telnyx.com/v2/calls").at(-1)!.body as Record<string, unknown>;
    expect(check.to).toBe("+19415550177");
    expect(Buffer.from(String(check.client_state), "base64").toString()).not.toMatch(/^setup-help:/);
    expect(await (await made.tool("get_test_result", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "calling" });
    made.clock.at = new Date(made.clock.at.getTime() + 2 * 60_000 + 5_000);
    expect(await (await made.tool("get_test_result", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "not_reached", minutes_on_call: 2.1, offer_team_time: true });
  });

  it("email_steps emails the owner the forwarding steps", async () => {
    const made = await onTheCall();
    expect(await (await made.tool("email_steps", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "sent" });
    const email = [...made.store.notifications.values()].find((item) => item.idempotencyKey.startsWith("handoff-email:"))!;
    expect(email.destinationRef).toBe("email:owner@synthetic.example");
    expect(email.body).toContain("Your Call Otto forwarding");
  });

  it("keeps each helper tool's name and status on the call's record (what the selftest reads for a speech-to-speech helper), and never shows it to the owner", async () => {
    const made = await onTheCall();
    const record = async () => JSON.parse((await made.store.getIntegrationSecret(made.account.tenantId, "forwarding", "setup_call"))!) as { tools?: Array<{ name: string; status: string }>; stepsEmailedAt?: string; callControlId?: string };
    expect((await record()).tools).toBeUndefined();
    expect(await (await made.tool("get_test_result", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "idle" });
    expect(await (await made.tool("email_steps", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "sent" });
    expect(await (await made.tool("email_steps", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "already_sent" });
    // A refused call (not this shop's live call) records nothing.
    expect(await (await made.tool("get_test_result", { provider_call_id: "v3:someone-else" })).json()).toMatchObject({ status: "unavailable" });
    expect(await record()).toMatchObject({ callControlId: "v3:help-call", stepsEmailedAt: expect.any(String), tools: [{ name: "get_test_result", status: "idle" }, { name: "email_steps", status: "sent" }, { name: "email_steps", status: "already_sent" }] });
    expect((await record()).tools).toHaveLength(3);
    expect(JSON.stringify((await line(made, made.cookie)).helpCall)).not.toContain("tools");
    // The record keeps only the latest answers of a runaway call.
    for (let repeat = 0; repeat < 45; repeat += 1) await made.tool("get_test_result", { provider_call_id: "v3:help-call" });
    expect((await record()).tools).toHaveLength(40);
    // Still there after hang-up, when the selftest reads it; nothing more is added once the call is over.
    await made.webhook("call.hangup", "evt-hangup", { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "normal_clearing" });
    expect(await (await made.tool("get_test_result", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "unavailable" });
    expect(await record()).toMatchObject({ endedAt: expect.any(String), outcome: "done" });
    expect((await record()).tools).toHaveLength(40);
  });

  it("a helper tool that was refused, rate limited or threw is kept on the call's record too, and later answers never push it off", async () => {
    type Kept = { tools?: Array<{ name: string; status: string }> };
    const kept = async (made: Awaited<ReturnType<typeof onTheCall>>) => (JSON.parse((await made.store.getIntegrationSecret(made.account.tenantId, "forwarding", "setup_call"))!) as Kept).tools;
    const help = { provider_call_id: "v3:help-call" };

    // The tool throws on a live call (the store is down for one read): a 500 as before, and the record says so.
    const thrown = await onTheCall();
    expect(await (await thrown.tool("get_test_result", help)).json()).toMatchObject({ status: "idle" });
    const getConfig = thrown.store.getConfig.bind(thrown.store);
    let down = true;
    thrown.store.getConfig = async (tenantId) => {
      if (down && tenantId === thrown.account.tenantId) { down = false; throw new Error("store unavailable"); }
      return getConfig(tenantId);
    };
    expect((await thrown.tool("email_steps", help)).status).toBe(500);
    expect(await kept(thrown)).toEqual([{ name: "get_test_result", status: "idle" }, { name: "email_steps", status: "error" }]);
    // The support-call selftest reads exactly this record for a speech-to-speech helper: one failed tool fails it.
    const { setupVerdict } = await import("../scripts/selftest-setup-call.js");
    const verdictFor = (tools: Kept["tools"]) => setupVerdict({ tools: [], record: { answeredAt: "a", endedAt: "b", outcome: "done", ...(tools ? { tools } : {}) }, book: false, elapsedMs: 60_000, speechToSpeech: true });
    expect(verdictFor([{ name: "get_test_result", status: "idle" }])).toMatchObject({ pass: true, tools_ok: true });
    expect(verdictFor(await kept(thrown))).toMatchObject({ pass: false, tools_ok: false });
    // A runaway call's later answers never push the failed one off the record.
    for (let repeat = 0; repeat < 45; repeat += 1) await thrown.tool("get_test_result", help);
    expect(await kept(thrown)).toHaveLength(40);
    expect((await kept(thrown))![0]).toEqual({ name: "email_steps", status: "error" });
    expect(verdictFor(await kept(thrown)).tools_ok).toBe(false);

    // Rate limited (more than 60 tool calls a minute on one call): answered "unavailable", kept once.
    const flooded = await onTheCall();
    for (let repeat = 0; repeat < 60; repeat += 1) await flooded.tool("get_test_result", help);
    expect((await kept(flooded))!.every((item) => item.status === "idle")).toBe(true);
    for (let repeat = 0; repeat < 3; repeat += 1) expect(await (await flooded.tool("book_time", help)).json()).toMatchObject({ status: "unavailable", say: "One moment, then try again." });
    expect((await kept(flooded))!.filter((item) => item.status === "unavailable")).toEqual([{ name: "book_time", status: "unavailable" }]);
    expect(await kept(flooded)).toHaveLength(40);
    expect(verdictFor(await kept(flooded)).tools_ok).toBe(false);

    // Refused on this shop's own call (rung, not picked up yet), and for a suspended account: kept as "unavailable".
    const early = await app();
    const owner = await early.owner();
    expect((await owner.api("/api/app/line/help", { device: "android" })).status).toBe(200);
    expect(await (await early.tool("get_test_result", help)).json()).toMatchObject({ status: "unavailable" });
    expect(await kept({ ...early, ...owner } as Awaited<ReturnType<typeof onTheCall>>)).toEqual([{ name: "get_test_result", status: "unavailable" }]);
    const suspended = await onTheCall();
    await suspended.store.updateOwnerAccountStatus(suspended.account.id, "suspended", suspended.clock.now().toISOString());
    expect(await (await suspended.tool("get_test_result", help)).json()).toMatchObject({ status: "unavailable" });
    expect(await kept(suspended)).toEqual([{ name: "get_test_result", status: "unavailable" }]);
  });

  it("email_steps sends once per support call: a repeat sends nothing and says it's already sent; the app's button keeps its own limit", async () => {
    const made = await onTheCall();
    const stepEmails = () => [...made.store.notifications.values()].filter((item) => item.idempotencyKey.startsWith("handoff-email:"));
    expect(await (await made.tool("email_steps", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "sent" });
    for (let repeat = 0; repeat < 2; repeat += 1) {
      made.clock.at = new Date(made.clock.at.getTime() + 7_000);
      expect(await (await made.tool("email_steps", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "already_sent", say: "It's already in your email." });
    }
    expect(stepEmails()).toHaveLength(1);
    // Two at once still queue one.
    const again = await onTheCall();
    const both = await Promise.all([again.tool("email_steps", { provider_call_id: "v3:help-call" }), again.tool("email_steps", { provider_call_id: "v3:help-call" })]);
    expect((await Promise.all(both.map((item) => item.json() as Promise<{ status: string }>))).map((item) => item.status).sort()).toEqual(["already_sent", "sent"]);
    expect([...again.store.notifications.values()].filter((item) => item.idempotencyKey.startsWith("handoff-email:"))).toHaveLength(1);
    // "Email me these steps" in the app is the owner asking: it still sends.
    made.clock.at = new Date(made.clock.at.getTime() + 1_000);
    expect((await made.api("/api/app/line/handoff/email")).status).toBe(200);
    expect(stepEmails()).toHaveLength(2);
  });

  it("start_forwarding_test asked again while the test still rings never hangs up and dials a second one", async () => {
    const made = await onTheCall();
    const checkDials = () => made.recorded.filter((call) => call.url === "https://api.telnyx.com/v2/calls" && (call.body as { to?: string }).to === "+19415550177");
    expect(await (await made.tool("start_forwarding_test", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "calling" });
    for (let repeat = 0; repeat < 2; repeat += 1) {
      made.clock.at = new Date(made.clock.at.getTime() + 3_000);
      expect(await (await made.tool("start_forwarding_test", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "already_calling", say: "The test is already calling. Wait for it." });
    }
    expect(checkDials()).toHaveLength(1);
    expect(made.recorded.filter((call) => /\/actions\/hangup$/.test(call.url))).toHaveLength(0);
    // Two at once while nothing rings: still one test call.
    const fresh = await onTheCall();
    const freshDials = () => fresh.recorded.filter((call) => call.url === "https://api.telnyx.com/v2/calls" && (call.body as { to?: string }).to === "+19415550177");
    const pair = await Promise.all([0, 1].map(async () => (await fresh.tool("start_forwarding_test", { provider_call_id: "v3:help-call" })).json() as Promise<{ status: string }>));
    expect(pair.map((item) => item.status).sort()).toEqual(["already_calling", "calling"]);
    expect(freshDials()).toHaveLength(1);
    // Once that test is over, a new one may start.
    made.clock.at = new Date(made.clock.at.getTime() + 3 * 60_000);
    expect(await (await made.tool("start_forwarding_test", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "calling" });
    expect(checkDials()).toHaveLength(2);
  });

  it("get_open_times with no team calendar, asked three times, sends our team's email once", async () => {
    const made = await onTheCall();
    for (let repeat = 0; repeat < 3; repeat += 1) expect(await (await made.tool("get_open_times", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "no_calendar" });
    expect(made.founderEmails(made.account.tenantId)).toHaveLength(1);
  });

  it("book_time asked three times books once: one event, one confirmation, one team email, and a short final repeat", async () => {
    const made = await onTheCall({ founders: BROCK });
    const open = await (await made.tool("get_open_times", { provider_call_id: "v3:help-call" })).json() as { times: Array<{ slot_start: string; label: string }> };
    const book = async (slot: string) => await (await made.tool("book_time", { provider_call_id: "v3:help-call", slot_start: slot, explicit_confirmation: true })).json() as { status: string; say: string; when: string };
    expect((await book(open.times[0]!.slot_start)).status).toBe("booked");
    for (const slot of [open.times[0]!.slot_start, open.times[1]!.slot_start]) {
      expect(await book(slot)).toMatchObject({ status: "already_booked", when: open.times[0]!.label, say: "You're already booked. That's all set." });
    }
    expect(made.recorded.filter((call) => call.method === "POST" && call.url.includes("/calendars/primary/events"))).toHaveLength(1);
    expect(made.founderEmails(made.account.tenantId).filter((item) => item.idempotencyKey.endsWith(":confirmation"))).toHaveLength(1);
    expect([...made.store.notifications.values()].filter((item) => item.destinationRef === "email:help@callotto.example" && item.idempotencyKey.startsWith("setup-help-booking:"))).toHaveLength(1);
    // Our team's email never got queued (the outbox failed): the repeat sends it, once.
    const teamEmails = () => [...made.store.notifications.values()].filter((item) => item.idempotencyKey.startsWith("setup-help-booking:"));
    for (const item of teamEmails()) made.store.notifications.delete(item.id);
    expect(teamEmails()).toHaveLength(0);
    expect((await book(open.times[0]!.slot_start)).status).toBe("already_booked");
    expect((await book(open.times[0]!.slot_start)).status).toBe("already_booked");
    expect(teamEmails()).toHaveLength(1);
  });

  it("book_time books inside our team's windows, says the time, and emails the owner and the support inbox with a calendar invite", async () => {
    const made = await onTheCall({ founders: BROCK });
    const open = await (await made.tool("get_open_times", { provider_call_id: "v3:help-call" })).json() as { status: string; times: Array<{ slot_start: string; label: string }> };
    expect(open.status).toBe("open");
    expect(open.times.length).toBeGreaterThan(0);
    expect(open.times.length).toBeLessThanOrEqual(3);
    expect(open.times[0]!.label).toMatch(/ at \d{1,2}:\d{2} (AM|PM) C[SD]T$/);
    // Never without a yes.
    expect(await (await made.tool("book_time", { provider_call_id: "v3:help-call", slot_start: open.times[0]!.slot_start, explicit_confirmation: false })).json()).toMatchObject({ status: "needs_confirmation" });
    expect(made.recorded.some((call) => call.method === "POST" && call.url.includes("/calendars/primary/events"))).toBe(false);
    // A time outside the windows is refused.
    expect(await (await made.tool("book_time", { provider_call_id: "v3:help-call", slot_start: "2026-11-29T03:00:00.000Z", explicit_confirmation: true })).json()).toMatchObject({ status: "invalid" });
    const booked = await (await made.tool("book_time", { provider_call_id: "v3:help-call", slot_start: open.times[0]!.slot_start, explicit_confirmation: true })).json() as { status: string; say: string; when: string };
    expect(booked.status).toBe("booked");
    expect(booked.say).toBe(`You're booked for ${open.times[0]!.label}. Our team will call you at the number ending in 0 1 9 9. A confirmation email is on its way.`);
    expect(booked.say).not.toMatch(/Brock/);
    const event = made.recorded.find((call) => call.method === "POST" && call.url.includes("/calendars/primary/events"))!.body as { summary: string };
    expect(event.summary).toBe("Call Otto setup: Gulf Air (10 min)");
    const confirmation = made.founderEmails(made.account.tenantId).find((item) => item.idempotencyKey.endsWith(":confirmation"))!;
    expect(confirmation.destinationRef).toBe("email:owner@synthetic.example");
    expect(parseEmailBody(confirmation.body).attachments[0]!.filename).toBe("call-otto-setup.ics");
    const team = [...made.store.notifications.values()].find((item) => item.destinationRef === "email:help@callotto.example" && item.idempotencyKey.endsWith(":team"))!;
    expect(team.senderRef).toBe("founder");
    const invite = Buffer.from(parseEmailBody(team.body).attachments[0]!.content, "base64").toString("utf8");
    expect(invite).toContain("BEGIN:VEVENT");
    expect(invite).toContain(`DTSTART:${open.times[0]!.slot_start.replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
    expect(invite).toContain("SUMMARY:Call Otto setup: Gulf Air (10 min)");
    for (const item of [confirmation, team]) expect(parseEmailBody(item.body).text).not.toContain("Brock");
    // The screen shows it once the call ends.
    await made.webhook("call.hangup", "evt-hangup", { call_control_id: "v3:help-call", client_state: made.dialState(), hangup_cause: "normal_clearing" });
    expect((await line(made, made.cookie)).helpCall).toMatchObject({ outcome: "done", booked: true });
  });

  it("no team calendar connected: our team emails instead of booking", async () => {
    const made = await onTheCall();
    expect(await (await made.tool("get_open_times", { provider_call_id: "v3:help-call" })).json()).toMatchObject({ status: "no_calendar" });
    const email = made.founderEmails(made.account.tenantId).at(-1)!;
    expect(email.body).toContain("you asked for a time with our team");
  });
});
