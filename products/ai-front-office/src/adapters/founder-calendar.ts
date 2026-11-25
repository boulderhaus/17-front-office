import { createHash } from "node:crypto";
import type { Environment } from "../config/environment.js";
import type { BusyPeriod } from "../domain/founder-booking.js";
import { maskEmail, overlapsBusy } from "../domain/founder-booking.js";
import { PLATFORM_TENANT_ID, type Clock, type Store } from "../ports.js";
import { withTimeout } from "../application/retry.js";
import { googleEventId } from "./google-calendar.js";
import { encodeGoogleConnection, googleClient, missingCalendarPermissions, type GoogleClientName, type GoogleOAuthClient } from "./google-oauth-clients.js";

/**
 * Brock's own Google calendars, for booking 10-minute setup calls with owners. Several accounts can be connected:
 * busy times come from all of them, and new calls go on the one marked "book here". Refresh tokens are encrypted
 * platform secrets (tenant "platform", provider "google-founder"), one key per account, plus a small index.
 */
export const FOUNDER_GOOGLE_PROVIDER = "google-founder";
/**
 * Busy times, events on calendars the account owns (setup calls go on its main calendar), and which Google account
 * this is. Nothing else: the same calendar permissions as GOOGLE_CALENDAR_SCOPES, the ones on the consent screen.
 */
export const FOUNDER_GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
] as const;
const INDEX_KEY = "accounts";
const BOOKED_KEY = "booked";
const tokenKey = (id: string): string => `token:${id}`;

/** One connected account couldn't be read; names it (masked) so the admin page can say which. */
export class FounderCalendarReadError extends Error {
  constructor(readonly accountId: string, readonly account: string, readonly reason: string) {
    super(`Couldn't read ${account}: ${reason}`);
  }
}

export interface FounderAccount {
  id: string;
  email: string;
  bookHere: boolean;
  /** Calendars whose busy times count: the ones this account owns or shows, or only "primary" when Google won't list them. */
  calendars: string[];
  calendarsSource: "list" | "primary";
  connectedAt: string;
}

/** Shown to the person connecting; the message is safe to put on the page. */
export class FounderConnectError extends Error {}

export class FounderCalendars {
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly options: { store: Store; env: Environment; clock: Clock; fetcher?: typeof fetch | undefined; log?: ((entry: Record<string, unknown>) => void) | undefined }) {}

  async accounts(): Promise<FounderAccount[]> {
    const raw = await this.options.store.getIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, INDEX_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as FounderAccount[];
      return Array.isArray(parsed) ? parsed.filter((account) => typeof account?.id === "string" && typeof account.email === "string") : [];
    } catch {
      return [];
    }
  }

  async connected(): Promise<boolean> {
    return (await this.accounts()).length > 0;
  }

  /** Redeem Google's code: the refresh token, and which account it is (from the ID token Google just sent us). */
  async exchangeCode(client: GoogleOAuthClient, code: string, verifier: string, redirectUri: string): Promise<{ refreshToken: string; email: string; subject: string }> {
    const response = await withTimeout(this.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri }),
    }), 5_000);
    const payload = await response.json().catch(() => ({})) as { refresh_token?: string; scope?: string; id_token?: string };
    if (!response.ok || !payload.refresh_token) throw new FounderConnectError("Google didn't return a refresh token. Connect again and approve the request.");
    if (missingCalendarPermissions(payload.scope).length > 0) {
      await withTimeout(this.fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: payload.refresh_token }),
      }), 5_000).catch(() => undefined);
      throw new FounderConnectError("That calendar isn't connected. Booking needs both calendar permissions, busy times and adding events. Connect again and leave both boxes ticked.");
    }
    const claims = decodeIdToken(payload.id_token);
    const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
    const subject = typeof claims.sub === "string" ? claims.sub : email;
    if (!subject) throw new FounderConnectError("Google didn't say which account this is. Connect again.");
    return { refreshToken: payload.refresh_token, email, subject };
  }

  /** Save (or replace) an account. The first one connected takes bookings until another is picked. */
  async connect(input: { client: GoogleOAuthClient; refreshToken: string; email: string; subject: string }): Promise<FounderAccount> {
    const id = createHash("sha256").update(`google-founder:${input.subject}`).digest("hex").slice(0, 16);
    const { store } = this.options;
    await store.saveIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, tokenKey(id), encodeGoogleConnection(input.refreshToken, input.client));
    this.#tokens.delete(id);
    const calendars = await this.calendarIds({ id, client: input.client, refreshToken: input.refreshToken }).catch(() => ({ ids: ["primary"], source: "primary" as const }));
    return store.withLock("founder-calendars", async () => {
      const accounts = await this.accounts();
      const existing = accounts.find((account) => account.id === id);
      const account: FounderAccount = {
        id, email: input.email || existing?.email || "", bookHere: existing?.bookHere ?? !accounts.some((item) => item.bookHere),
        calendars: calendars.ids, calendarsSource: calendars.source, connectedAt: this.options.clock.now().toISOString(),
      };
      await this.saveIndex([...accounts.filter((item) => item.id !== id), account]);
      return account;
    });
  }

  async disconnect(id: string): Promise<void> {
    const { store } = this.options;
    const saved = await this.credentials(id).catch(() => null);
    await store.withLock("founder-calendars", async () => {
      const remaining = (await this.accounts()).filter((account) => account.id !== id);
      if (remaining.length > 0 && !remaining.some((account) => account.bookHere)) remaining[0] = { ...remaining[0]!, bookHere: true };
      await this.saveIndex(remaining);
      await store.deleteIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, tokenKey(id));
    });
    this.#tokens.delete(id);
    // Hand the grant back to Google too; the account is gone here either way.
    if (saved) {
      await withTimeout(this.fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: saved.refreshToken }),
      }), 5_000).catch(() => undefined);
    }
  }

  async setBookHere(id: string): Promise<boolean> {
    return this.options.store.withLock("founder-calendars", async () => {
      const accounts = await this.accounts();
      if (!accounts.some((account) => account.id === id)) return false;
      await this.saveIndex(accounts.map((account) => ({ ...account, bookHere: account.id === id })));
      return true;
    });
  }

  /**
   * Busy across every connected account (each account's listed calendars), plus setup calls already booked here
   * that Google may not report yet. Fails rather than guessing when an account can't be read.
   */
  /** Busy blocks from the last busy() read, per account id, so the admin page can show which calendar blocks what. */
  lastBusyByAccount = new Map<string, BusyPeriod[]>();

  /** exceptTenant: that shop's own holds don't count (a booking cut off before it was saved left one behind). */
  async busy(timeMin: string, timeMax: string, exceptTenant?: string): Promise<BusyPeriod[]> {
    const busy: BusyPeriod[] = [];
    const byAccount = new Map<string, BusyPeriod[]>();
    for (const account of await this.accounts()) {
      const before = busy.length;
      const label = account.email ? maskEmail(account.email) : "a Google account";
      const accessToken = await this.accessToken(account.id).catch((error: unknown) => {
        throw new FounderCalendarReadError(account.id, label, error instanceof Error ? error.message : "token refresh failed");
      });
      const items = (account.calendars.length > 0 ? account.calendars : ["primary"]).map((id) => ({ id }));
      const response = await withTimeout(this.fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ timeMin, timeMax, items }),
      }), 5_000);
      if (!response.ok) throw new FounderCalendarReadError(account.id, label, `freeBusy HTTP ${response.status}`);
      const payload = await response.json() as { calendars?: Record<string, { busy?: BusyPeriod[]; errors?: Array<{ reason?: unknown }> }> };
      const calendars = payload.calendars ?? {};
      for (const { id } of items) {
        // Google may key the main calendar by the account's address instead of "primary".
        const calendar = calendars[id] ?? (id === "primary" ? calendars[account.email] ?? (Object.keys(calendars).length === 1 ? Object.values(calendars)[0] : undefined) : undefined);
        const reasons = (calendar?.errors ?? []).map((error) => String(error?.reason ?? "unknown"));
        if (calendar && reasons.length === 0) {
          busy.push(...(calendar.busy ?? []));
          continue;
        }
        // A secondary calendar that's gone or no longer shared with this account (notFound, forbidden) is skipped. So is
        // a main calendar Google says doesn't exist (an account with Calendar turned off has nothing to clash with).
        // Anything else fails closed: a calendar Google can't read right now may hold appointments.
        const gone = reasons.length > 0 && reasons.every((reason) => reason === "notFound" || (id !== "primary" && reason === "forbidden"));
        if (gone) {
          this.options.log?.({ level: "warn", event: "founder_calendar_skipped", accountId: account.id, calendar: id === "primary" ? "primary" : "secondary", reasons: reasons.join(",") });
          continue;
        }
        const which = id === "primary" ? "main calendar" : "another calendar";
        throw new FounderCalendarReadError(account.id, label, reasons.length > 0 ? `${which}: ${reasons.join(", ")}` : `${which} missing from Google's answer`);
      }
      byAccount.set(account.id, busy.slice(before));
    }
    this.lastBusyByAccount = byAccount;
    const held = (await this.booked()).filter((item) => !exceptTenant || item.tenantId !== exceptTenant);
    return [...busy, ...held.map(({ start, end }) => ({ start, end }))];
  }

  /** Setup calls booked through Otto that haven't happened yet, with the shop each is for (older entries have none). */
  async booked(): Promise<Array<BusyPeriod & { tenantId?: string }>> {
    const raw = await this.options.store.getIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, BOOKED_KEY);
    try {
      const list = raw ? JSON.parse(raw) as Array<BusyPeriod & { tenantId?: string }> : [];
      const now = this.options.clock.now().getTime();
      return list.filter((item) => typeof item?.start === "string" && typeof item.end === "string" && Date.parse(item.end) > now);
    } catch {
      return [];
    }
  }

  /** Callers hold the "founder-booking" lock: re-check busy, then this. */
  async rememberBooked(slot: BusyPeriod, tenantId: string): Promise<void> {
    await this.options.store.saveIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, BOOKED_KEY, JSON.stringify([...await this.booked(), { start: slot.start, end: slot.end, tenantId }]));
  }

  /** True when the slot (with its buffer) is clear on every account and of every call booked here for another shop. */
  async isFree(slot: { start: string; end: string }, bufferMinutes: number, forTenant?: string): Promise<boolean> {
    const buffer = bufferMinutes * 60_000;
    const busy = await this.busy(new Date(Date.parse(slot.start) - buffer).toISOString(), new Date(Date.parse(slot.end) + buffer).toISOString(), forTenant);
    return !overlapsBusy({ start: Date.parse(slot.start), end: Date.parse(slot.end) }, busy, bufferMinutes);
  }

  /**
   * Put the call on the "book here" account's main calendar. No attendees, so no one's email address is shared and
   * Google sends no invites. The event id comes from the key, so a retry never makes a second event.
   */
  async createEvent(input: { key: string; start: string; end: string; summary: string; description: string }): Promise<string> {
    const account = (await this.accounts()).find((item) => item.bookHere);
    if (!account) throw new Error("No founder calendar takes bookings");
    const accessToken = await this.accessToken(account.id);
    const id = googleEventId(input.key);
    const response = await withTimeout(this.fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        id, summary: input.summary, description: input.description,
        start: { dateTime: input.start }, end: { dateTime: input.end },
        visibility: "private",
      }),
    }), 5_000);
    if (response.status === 409) return id;
    if (!response.ok) throw new Error(`Google Calendar insert failed with HTTP ${response.status}`);
    return id;
  }

  /** Calendars the account owns or has switched on. Google only lists them with a broader grant; else just "primary". */
  private async calendarIds(account: { id: string; client: GoogleOAuthClient; refreshToken: string }): Promise<{ ids: string[]; source: "list" | "primary" }> {
    const accessToken = await this.refresh(account.id, account.client, account.refreshToken);
    const response = await withTimeout(this.fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250", {
      headers: { authorization: `Bearer ${accessToken}` },
    }), 5_000);
    if (!response.ok) return { ids: ["primary"], source: "primary" };
    const payload = await response.json().catch(() => ({})) as { items?: Array<{ id?: string; primary?: boolean; selected?: boolean; accessRole?: string; deleted?: boolean }> };
    const ids = (payload.items ?? [])
      .filter((item) => typeof item.id === "string" && !item.deleted && (item.primary || item.accessRole === "owner" || item.selected))
      // Holidays, birthdays and week numbers aren't Brock being busy.
      .filter((item) => !/#(holiday|contacts|weeknum)@/.test(item.id!))
      .map((item) => item.primary ? "primary" : item.id!);
    return { ids: [...new Set(["primary", ...ids])], source: "list" };
  }

  private async credentials(id: string): Promise<{ client: GoogleOAuthClient; refreshToken: string }> {
    const saved = await this.options.store.getIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, tokenKey(id));
    if (!saved) throw new Error("Founder calendar is not connected");
    const parsed = JSON.parse(saved) as { client?: unknown; refreshToken?: unknown };
    if (typeof parsed.refreshToken !== "string" || (parsed.client !== "legacy" && parsed.client !== "next")) throw new Error("Stored founder calendar is malformed");
    const client = googleClient(this.options.env, parsed.client as GoogleClientName);
    if (!client) throw new Error(`Google OAuth client "${String(parsed.client)}" is not configured`);
    return { client, refreshToken: parsed.refreshToken };
  }

  private async accessToken(id: string): Promise<string> {
    const cached = this.#tokens.get(id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const { client, refreshToken } = await this.credentials(id);
    return this.refresh(id, client, refreshToken);
  }

  private async refresh(id: string, client: GoogleOAuthClient, refreshToken: string): Promise<string> {
    const response = await withTimeout(this.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    }), 5_000);
    const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
    if (!response.ok || !payload.access_token) {
      throw new Error(payload.error === "invalid_grant" ? "A founder calendar's Google access was revoked; reconnect it" : `Google OAuth refresh failed with HTTP ${response.status}`);
    }
    this.#tokens.set(id, { token: payload.access_token, expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 3_600) * 1_000 });
    return payload.access_token;
  }

  private async saveIndex(accounts: FounderAccount[]): Promise<void> {
    await this.options.store.saveIntegrationSecret(PLATFORM_TENANT_ID, FOUNDER_GOOGLE_PROVIDER, INDEX_KEY, JSON.stringify(accounts));
  }

  private fetch(url: string, init?: RequestInit): Promise<Response> {
    return (this.options.fetcher ?? fetch)(url, init);
  }
}

/** The ID token came straight from Google's token endpoint over TLS, so its claims are read without re-verifying. */
function decodeIdToken(token: string | undefined): Record<string, unknown> {
  const payload = token?.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
