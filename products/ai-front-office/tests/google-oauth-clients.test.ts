import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { GoogleCalendarAdapter } from "../src/adapters/google-calendar.js";
import { clientForAttempt, clientForNewConnections, encodeGoogleConnection, googleClient, googleCredentials, oauthAttemptKey } from "../src/adapters/google-oauth-clients.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createGoogleOAuthAttempt, verifyGoogleOAuthAttempt } from "../src/http/security.js";

const legacyOnly = demoEnvironment({ GOOGLE_CLIENT_ID: "legacy-id", GOOGLE_CLIENT_SECRET: "legacy-secret" });
const both = demoEnvironment({ GOOGLE_CLIENT_ID: "legacy-id", GOOGLE_CLIENT_SECRET: "legacy-secret", GOOGLE_CLIENT_ID_NEXT: "next-id", GOOGLE_CLIENT_SECRET_NEXT: "next-secret" });
const nextForNew = demoEnvironment({ GOOGLE_CLIENT_ID: "legacy-id", GOOGLE_CLIENT_SECRET: "legacy-secret", GOOGLE_CLIENT_ID_NEXT: "next-id", GOOGLE_CLIENT_SECRET_NEXT: "next-secret", GOOGLE_OAUTH_NEW_CONNECTIONS: "next" });

describe("Google OAuth client migration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses only the configured client for new connections and refuses a half-configured switch", () => {
    expect(clientForNewConnections(both)?.name).toBe("legacy");
    expect(clientForNewConnections(nextForNew)?.name).toBe("next");
    expect(() => demoEnvironment({ GOOGLE_CLIENT_ID: "legacy-id", GOOGLE_CLIENT_SECRET: "legacy-secret", GOOGLE_OAUTH_NEW_CONNECTIONS: "next" })).toThrow("GOOGLE_CLIENT_ID_NEXT");
  });

  it("stores the token and its client as one value and reads old plain tokens as legacy", async () => {
    const store = new InMemoryStore();
    await store.saveIntegrationSecret("shop_a", "google", "refresh_token", "old-plain-token");
    await store.saveIntegrationSecret("shop_b", "google", "refresh_token", encodeGoogleConnection("new-token", googleClient(nextForNew, "next")!));
    expect(await googleCredentials(store, nextForNew, "shop_a", "refresh_token")).toMatchObject({ refreshToken: "old-plain-token", client: { id: "legacy-id" } });
    expect(await googleCredentials(store, nextForNew, "shop_b", "refresh_token")).toMatchObject({ refreshToken: "new-token", client: { id: "next-id" } });
    await expect(googleCredentials(store, legacyOnly, "shop_b", "refresh_token")).rejects.toThrow("not configured");
    expect(await googleCredentials(store, nextForNew, "shop_c", "refresh_token")).toBeNull();
  });

  it("redeems the OAuth code with the client that started the attempt, even if the switch flips mid-flow", () => {
    const base = "session-signing-key-for-tests:account";
    const started = createGoogleOAuthAttempt(oauthAttemptKey(base, "legacy"), false);
    const cookieValue = /afo_google_pkce=([^;]+)/.exec(started.cookie)![1]!;
    const attempt = clientForAttempt(nextForNew, base, (key) => verifyGoogleOAuthAttempt(started.state, cookieValue, key));
    expect(attempt?.client.name).toBe("legacy");
    expect(clientForAttempt(nextForNew, "someone-else", (key) => verifyGoogleOAuthAttempt(started.state, cookieValue, key))).toBeNull();
  });

  it("sends the token's own client to Google and forgets a revoked token", async () => {
    const store = new InMemoryStore();
    await store.saveIntegrationSecret("shop_b", "google", "refresh_token", encodeGoogleConnection("new-token", googleClient(nextForNew, "next")!));
    let revoked = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        expect((init?.body as URLSearchParams).get("client_id")).toBe("next-id");
        return revoked
          ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
          : new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }), { status: 200 });
    });
    const adapter = () => new GoogleCalendarAdapter({
      calendarId: "primary",
      getCredentials: (tenantId) => googleCredentials(store, nextForNew, tenantId, "refresh_token"),
      onRevoked: (tenantId) => store.deleteIntegrationSecret(tenantId, "google", "refresh_token"),
    });
    const slot = { start: "2026-01-15T15:00:00Z", end: "2026-01-15T16:00:00Z" };
    expect(await adapter().isFree({ tenantId: "shop_b", slot })).toBe(true);
    revoked = true;
    await expect(adapter().isFree({ tenantId: "shop_b", slot })).rejects.toThrow("reconnect");
    expect(await store.getIntegrationSecret("shop_b", "google", "refresh_token")).toBeNull();
  });
});
