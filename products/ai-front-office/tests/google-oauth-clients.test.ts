import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "../src/adapters/in-memory.js";
import { GoogleCalendarAdapter } from "../src/adapters/google-calendar.js";
import { clientForNewConnections, googleCredentials, saveGoogleConnection } from "../src/adapters/google-oauth-clients.js";
import { demoEnvironment } from "../src/config/environment.js";

const legacyOnly = demoEnvironment({ GOOGLE_CLIENT_ID: "legacy-id", GOOGLE_CLIENT_SECRET: "legacy-secret" });
const both = demoEnvironment({ GOOGLE_CLIENT_ID: "legacy-id", GOOGLE_CLIENT_SECRET: "legacy-secret", GOOGLE_CLIENT_ID_NEXT: "next-id", GOOGLE_CLIENT_SECRET_NEXT: "next-secret" });
const nextForNew = demoEnvironment({ GOOGLE_CLIENT_ID: "legacy-id", GOOGLE_CLIENT_SECRET: "legacy-secret", GOOGLE_CLIENT_ID_NEXT: "next-id", GOOGLE_CLIENT_SECRET_NEXT: "next-secret", GOOGLE_OAUTH_NEW_CONNECTIONS: "next" });

describe("Google OAuth client migration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps new connections on the legacy client until the switch is flipped", () => {
    expect(clientForNewConnections(both)?.name).toBe("legacy");
    expect(clientForNewConnections(nextForNew)?.name).toBe("next");
    expect(clientForNewConnections(legacyOnly)?.name).toBe("legacy");
  });

  it("redeems each refresh token with the client that issued it", async () => {
    const store = new InMemoryStore();
    await store.saveIntegrationSecret("shop_a", "google", "refresh_token", "old-token");
    await saveGoogleConnection(store, "shop_b", "refresh_token", "new-token", clientForNewConnections(nextForNew)!);
    expect((await googleCredentials(store, nextForNew, "shop_a", "refresh_token"))?.client.id).toBe("legacy-id");
    expect((await googleCredentials(store, nextForNew, "shop_b", "refresh_token"))?.client.id).toBe("next-id");
    await expect(googleCredentials(store, legacyOnly, "shop_b", "refresh_token")).rejects.toThrow("not configured");
    expect(await googleCredentials(store, nextForNew, "shop_c", "refresh_token")).toBeNull();
  });

  it("sends the token's own client to Google when refreshing", async () => {
    const store = new InMemoryStore();
    await saveGoogleConnection(store, "shop_b", "refresh_token", "new-token", clientForNewConnections(nextForNew)!);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        expect((init?.body as URLSearchParams).get("client_id")).toBe("next-id");
        return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }), { status: 200 });
    });
    const adapter = new GoogleCalendarAdapter({ calendarId: "primary", getCredentials: (tenantId) => googleCredentials(store, nextForNew, tenantId, "refresh_token") });
    expect(await adapter.isFree({ tenantId: "shop_b", slot: { start: "2026-01-15T15:00:00Z", end: "2026-01-15T16:00:00Z" } })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
