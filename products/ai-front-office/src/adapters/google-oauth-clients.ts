import type { Environment } from "../config/environment.js";
import type { Store } from "../ports.js";

export type GoogleClientName = "legacy" | "next";
export interface GoogleOAuthClient { name: GoogleClientName; id: string; secret: string }

/**
 * Two Google OAuth clients can coexist during a migration. A refresh token only
 * works with the client that issued it, so each saved token records its client.
 * Tokens saved before this existed are legacy.
 */
export function googleClient(env: Environment, name: GoogleClientName): GoogleOAuthClient | null {
  if (name === "next") return env.GOOGLE_CLIENT_ID_NEXT && env.GOOGLE_CLIENT_SECRET_NEXT ? { name, id: env.GOOGLE_CLIENT_ID_NEXT, secret: env.GOOGLE_CLIENT_SECRET_NEXT } : null;
  return env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { name, id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET } : null;
}

/** The client used for new connections. */
export function clientForNewConnections(env: Environment): GoogleOAuthClient | null {
  return env.GOOGLE_OAUTH_NEW_CONNECTIONS === "next"
    ? googleClient(env, "next") ?? googleClient(env, "legacy")
    : googleClient(env, "legacy") ?? googleClient(env, "next");
}

export function anyGoogleClient(env: Environment): boolean {
  return Boolean(googleClient(env, "legacy") || googleClient(env, "next"));
}

/** Refresh token plus the client that must redeem it. */
export async function googleCredentials(store: Store, env: Environment, tenantId: string, tokenKey: string): Promise<{ refreshToken: string; client: GoogleOAuthClient } | null> {
  const refreshToken = await store.getIntegrationSecret(tenantId, "google", tokenKey)
    ?? (tokenKey === "refresh_token" && tenantId === env.DEFAULT_TENANT_ID ? env.GOOGLE_REFRESH_TOKEN ?? null : null);
  if (!refreshToken) return null;
  const recorded = await store.getIntegrationSecret(tenantId, "google", `${tokenKey}:client`);
  const client = googleClient(env, recorded === "next" ? "next" : "legacy");
  if (!client) throw new Error(`Google OAuth client "${recorded ?? "legacy"}" for this calendar is not configured`);
  return { refreshToken, client };
}

export async function saveGoogleConnection(store: Store, tenantId: string, tokenKey: string, refreshToken: string, client: GoogleOAuthClient): Promise<void> {
  await store.saveIntegrationSecret(tenantId, "google", `${tokenKey}:client`, client.name);
  await store.saveIntegrationSecret(tenantId, "google", tokenKey, refreshToken);
}
