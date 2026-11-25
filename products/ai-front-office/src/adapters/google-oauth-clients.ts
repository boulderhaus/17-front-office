import type { Environment } from "../config/environment.js";
import type { Store } from "../ports.js";

export type GoogleClientName = "legacy" | "next";
export interface GoogleOAuthClient { name: GoogleClientName; id: string; secret: string }
const CLIENT_NAMES: GoogleClientName[] = ["legacy", "next"];

/**
 * The only Google permissions Call Otto asks for: busy times (never event details) and
 * events on calendars the person owns (Otto adds bookings to their own calendar and reads
 * back only the events it created). Both consent flows, /app and /admin, use this list.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const;

const GRANTS_EVENTS = new Set(["https://www.googleapis.com/auth/calendar.events.owned", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar"]);
const GRANTS_FREEBUSY = new Set(["https://www.googleapis.com/auth/calendar.freebusy", "https://www.googleapis.com/auth/calendar.events.freebusy", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar"]);

/**
 * Google's consent screen lets people untick a permission. Without busy times Otto can't offer
 * open slots, and without events it can't book, so a partial grant must not count as connected.
 * `granted` is the space-separated `scope` from Google's token response; when Google omits it,
 * nothing is assumed missing.
 */
export function missingCalendarPermissions(granted: string | undefined): Array<"events" | "freebusy"> {
  if (granted === undefined) return [];
  const scopes = granted.split(/\s+/).filter(Boolean);
  const missing: Array<"events" | "freebusy"> = [];
  if (!scopes.some((scope) => GRANTS_EVENTS.has(scope))) missing.push("events");
  if (!scopes.some((scope) => GRANTS_FREEBUSY.has(scope))) missing.push("freebusy");
  return missing;
}

/**
 * Two Google OAuth clients can coexist during a project migration. A refresh
 * token only works with the client that issued it, so the token and its client
 * are stored together as one value. Plain values saved before this are legacy.
 */
export function googleClient(env: Environment, name: GoogleClientName): GoogleOAuthClient | null {
  if (name === "next") return env.GOOGLE_CLIENT_ID_NEXT && env.GOOGLE_CLIENT_SECRET_NEXT ? { name, id: env.GOOGLE_CLIENT_ID_NEXT, secret: env.GOOGLE_CLIENT_SECRET_NEXT } : null;
  return env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { name, id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET } : null;
}

/** The client for new connections. No silent fallback to the other project. */
export function clientForNewConnections(env: Environment): GoogleOAuthClient | null {
  return googleClient(env, env.GOOGLE_OAUTH_NEW_CONNECTIONS);
}

export function anyGoogleClient(env: Environment): boolean {
  return Boolean(googleClient(env, "legacy") || googleClient(env, "next"));
}

/** HMAC key for an OAuth attempt, bound to the client that started it. */
export function oauthAttemptKey(base: string, client: GoogleClientName): string {
  return `${base}:google-client:${client}`;
}

/** Find which client started this attempt; the callback must redeem the code with that client. */
export function clientForAttempt<T>(env: Environment, base: string, verify: (key: string) => T | null): { client: GoogleOAuthClient; result: T } | null {
  for (const name of CLIENT_NAMES) {
    const result = verify(oauthAttemptKey(base, name));
    const client = googleClient(env, name);
    if (result !== null && client) return { client, result };
  }
  return null;
}

export function encodeGoogleConnection(refreshToken: string, client: GoogleOAuthClient): string {
  return JSON.stringify({ v: 1, client: client.name, refreshToken });
}

/** Refresh token plus the client that must redeem it. */
export async function googleCredentials(store: Store, env: Environment, tenantId: string, tokenKey: string): Promise<{ refreshToken: string; client: GoogleOAuthClient } | null> {
  const saved = await store.getIntegrationSecret(tenantId, "google", tokenKey);
  if (!saved) {
    const envToken = tokenKey === "refresh_token" && tenantId === env.DEFAULT_TENANT_ID ? env.GOOGLE_REFRESH_TOKEN : undefined;
    if (!envToken) return null;
    const legacy = googleClient(env, "legacy");
    if (!legacy) throw new Error("Google OAuth client \"legacy\" for this calendar is not configured");
    return { refreshToken: envToken, client: legacy };
  }
  let name: GoogleClientName = "legacy";
  let refreshToken = saved;
  if (saved.startsWith("{")) {
    const parsed = JSON.parse(saved) as { client?: unknown; refreshToken?: unknown };
    if (typeof parsed.refreshToken !== "string" || (parsed.client !== "legacy" && parsed.client !== "next")) throw new Error("Stored Google connection is malformed");
    name = parsed.client;
    refreshToken = parsed.refreshToken;
  }
  const client = googleClient(env, name);
  if (!client) throw new Error(`Google OAuth client "${name}" for this calendar is not configured`);
  return { refreshToken, client };
}
