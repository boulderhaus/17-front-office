import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { createTelemetry, noopTelemetry, redactContactDetails, sanitizeProperties, type Telemetry, type TelemetryOptions } from "../src/adapters/posthog.js";
import { demoEnvironment, loadEnvironment, type Environment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";
import { injectAnalytics, posthogTargetUrl } from "../src/http/posthog-proxy.js";
import type { Clock } from "../src/ports.js";

const KEY = "phc_syntheticTestKey123";
const toolToken = "tool-token-abcdefghijklmnopqrstuvwxyz";
const clock: Clock = { now: () => new Date("2026-01-15T08:00:00.000Z") };
const ALLOWED_ORIGINS = new Set(["https://us.i.posthog.com", "https://us-assets.i.posthog.com"]);

// Synthetic PII, defined once and away from the capture call sites: exception events carry the
// surrounding source lines, so a literal next to captureException() would show up in the payload.
const PII = {
  ownerEmail: ["owner", "synthetic.example"].join("@"),
  ownerName: "Synthetic " + "Owner",
  business: "Synthetic " + "Heating Co",
  ownerPhone: "(555) 555-" + "0177",
  callerPhone: "+1555555" + "0110",
  callerName: "Pat " + "Quinn",
  street: "100 Main " + "St",
  city: "Spring" + "field",
  problem: "Furnace " + "rattling",
};
const FORBIDDEN = [PII.ownerEmail, "synthetic.example", PII.ownerName, PII.business, "5555550110", "555-0110", "5555550177", "555-0177", PII.callerName, PII.street, PII.city, "rattling"];

type Sent = { url: string; body: string };

function fakePostHogFetch(sent: Sent[]): NonNullable<TelemetryOptions["fetch"]> {
  return async (url, options) => {
    sent.push({ url, body: typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? null) });
    return { status: 200, text: async () => "{}", json: async () => ({}) };
  };
}

describe("PostHog analytics", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function start(env: Environment, extra: { fetcher?: typeof fetch; telemetry?: Telemetry } = {}): Promise<{ baseUrl: string; port: number; store: InMemoryStore }> {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined, ...extra }));
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    return { baseUrl: `http://127.0.0.1:${address.port}`, port: address.port, store };
  }

  /** Raw request so the path reaches the server exactly as written (fetch would normalize it). */
  function rawRequest(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(init.body);
    });
  }

  describe("with POSTHOG_KEY unset", () => {
    it("builds a no-op client that never makes a request", async () => {
      const sent: Sent[] = [];
      const telemetry = createTelemetry(demoEnvironment(), { fetch: fakePostHogFetch(sent), flushAt: 1 });
      expect(telemetry).toBe(noopTelemetry);
      telemetry.capture("owner_signed_up", "account-1", "shop_1");
      telemetry.captureException(new Error("boom"), { route: "owner:api", status: 500 });
      await telemetry.flush();
      await telemetry.shutdown();
      expect(sent).toEqual([]);
    });

    it("adds nothing to pages and does not proxy or serve the loader", async () => {
      const calls: string[] = [];
      const fetcher = (async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response("{}");
      }) as typeof fetch;
      const { baseUrl, port } = await start(demoEnvironment(), { fetcher });
      for (const path of ["/", "/signup"]) {
        const html = await (await fetch(`${baseUrl}${path}`)).text();
        expect(html, path).not.toContain("posthog");
        expect(html, path).not.toContain("/assets/analytics.js");
      }
      expect((await fetch(`${baseUrl}/assets/analytics.js`)).status).toBe(404);
      expect((await rawRequest(port, "/ingest/e/", { method: "POST", body: "{}" })).status).toBe(404);
      expect((await rawRequest(port, "/ingest/static/array.js")).status).toBe(404);
      expect(calls).toEqual([]);
    });
  });

  describe("reverse proxy", () => {
    it("only accepts PostHog Cloud ingestion hosts in config", () => {
      const base = { DEMO_MODE: "true", ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: toolToken };
      expect(loadEnvironment({ ...base, POSTHOG_KEY: KEY }).POSTHOG_HOST).toBe("https://us.i.posthog.com");
      expect(loadEnvironment({ ...base, POSTHOG_KEY: KEY, POSTHOG_HOST: "https://eu.i.posthog.com/" }).POSTHOG_HOST).toBe("https://eu.i.posthog.com");
      for (const host of ["https://evil.example", "http://us.i.posthog.com", "https://us.i.posthog.com.evil.example", "http://169.254.169.254"]) {
        expect(() => loadEnvironment({ ...base, POSTHOG_KEY: KEY, POSTHOG_HOST: host }), host).toThrow();
      }
      expect(() => loadEnvironment({ ...base, POSTHOG_KEY: "\"><script>alert(1)</script>" })).toThrow();
    });

    it("maps paths to the ingestion or assets host and rejects anything that could leave them", () => {
      const host = "https://us.i.posthog.com";
      expect(posthogTargetUrl("/ingest/e/?ip=1&_=1700000000000", host)?.href).toBe("https://us.i.posthog.com/e/?ip=1&_=1700000000000");
      expect(posthogTargetUrl("/ingest/static/array.js", host)?.href).toBe("https://us-assets.i.posthog.com/static/array.js");
      expect(posthogTargetUrl("/ingest/array/phc_x/config.js", host)?.origin).toBe("https://us-assets.i.posthog.com");
      expect(posthogTargetUrl("/ingest/e/?next=https://evil.example", host)?.origin).toBe("https://us.i.posthog.com");
      expect(posthogTargetUrl("/ingest/static/array.js", "https://eu.i.posthog.com")?.origin).toBe("https://eu-assets.i.posthog.com");
      for (const path of [
        "/ingest//evil.example/x",
        "/ingest/@evil.example/x",
        "/ingest/\\evil.example",
        "/ingest/\\\\evil.example",
        "/ingest/%2fevil.example",
        "/ingest/%2e%2e/admin",
        "/ingest/../admin",
        "/ingest/static/../../x",
        "/ingest/:@evil.example",
        "/ingestevil.example/e",
        "/ingest",
        "/ingest/",
        "https://evil.example/ingest/e",
      ]) {
        expect(posthogTargetUrl(path, host), path).toBeNull();
      }
    });

    it("forwards only to the two PostHog origins, strips credentials and never passes a redirect on", async () => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init: init ?? {} });
        if (url.endsWith("/redirect-me")) return new Response(null, { status: 302, headers: { location: "https://evil.example" } });
        return new Response(url.includes("/static/") ? "/* sdk */" : "{\"status\":1}", { status: 200, headers: { "content-type": url.includes("/static/") ? "application/javascript" : "application/json", "set-cookie": "upstream=1" } });
      }) as typeof fetch;
      const { port } = await start(demoEnvironment({ POSTHOG_KEY: KEY }), { fetcher });

      const event = await rawRequest(port, "/ingest/e/?compression=gzip-js", {
        method: "POST",
        headers: { "content-type": "text/plain", cookie: "afo_owner=secret-session", authorization: "Bearer owner-secret" },
        body: "payload",
      });
      expect(event.status).toBe(200);
      const sdk = await rawRequest(port, "/ingest/static/array.js");
      expect(sdk.status).toBe(200);
      expect(sdk.body).toBe("/* sdk */");

      for (const path of ["/ingest//evil.example/x", "/ingest/@evil.example", "/ingest/\\evil.example"]) {
        expect((await rawRequest(port, path)).status, path).toBe(404);
      }
      // The URL parser resolves this to /admin, which our own router handles: it is never proxied.
      expect((await rawRequest(port, "/ingest/%2e%2e/admin")).status).not.toBe(200);
      expect((await rawRequest(port, "/ingest/e/", { method: "DELETE" })).status).toBe(405);
      expect((await rawRequest(port, "/ingest/redirect-me")).status).toBe(502);

      expect(calls.length).toBe(3);
      for (const call of calls) {
        expect(ALLOWED_ORIGINS.has(new URL(call.url).origin), call.url).toBe(true);
        expect(call.init.redirect).toBe("manual");
        const headers = call.init.headers as Record<string, string>;
        expect(headers.cookie).toBeUndefined();
        expect(headers.authorization).toBeUndefined();
      }
      expect(calls[0]!.url).toBe("https://us.i.posthog.com/e/?compression=gzip-js");
      expect(Buffer.from(calls[0]!.init.body as Uint8Array).toString()).toBe("payload");
      expect(calls[1]!.url).toBe("https://us-assets.i.posthog.com/static/array.js");
    });

    it("puts the public key and same-site loader on public pages when configured", async () => {
      const { baseUrl } = await start(demoEnvironment({ POSTHOG_KEY: KEY }));
      const html = await (await fetch(`${baseUrl}/`)).text();
      expect(html).toContain(`<meta name="posthog-key" content="${KEY}">`);
      expect(html).toContain(`<script src="/assets/analytics.js" defer></script>`);
      const loader = await fetch(`${baseUrl}/assets/analytics.js`);
      expect(loader.status).toBe(200);
      expect(loader.headers.get("content-type")).toContain("javascript");
      expect(loader.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(injectAnalytics("<html><head></head></html>", { key: "phc_bad\"key", ingestionHost: "https://us.i.posthog.com", loader: true })).toBe("<html><head></head></html>");
    });
  });

  describe("server events", () => {
    it("report 5xx responses as exceptions with route and request id only", async () => {
      const captured: Array<{ error: unknown; context: Record<string, unknown> }> = [];
      const telemetry: Telemetry = { ...noopTelemetry, enabled: true, captureException: (error, context) => captured.push({ error, context }) };
      const { baseUrl, store } = await start(demoEnvironment({ POSTHOG_KEY: KEY }), { telemetry });
      store.getConfig = async () => { throw new Error("database unavailable"); };
      expect((await fetch(`${baseUrl}/`, { headers: { "x-request-id": "req-500" } })).status).toBe(500);
      expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.context).toEqual({ route: "/", method: "GET", status: 500, requestId: "req-500" });
    });

    it("keep only allowlisted, non-identifying properties", () => {
      expect(sanitizeProperties({
        tenant_id: "shop_6d0c6a52-0d0e-4c43-9a3e-1d2f5c7b8a90",
        outcome: "booked",
        emergency: false,
        duration_seconds: 120,
        transcript: "Hi, this is Pat at 100 Main St",
        caller_name: "Pat",
        caller_phone: "+15555550110",
        email: "owner@synthetic.example",
        status: "call me at (555) 555-0110",
        result: "owner@synthetic.example",
      })).toEqual({ tenant_id: "shop_6d0c6a52-0d0e-4c43-9a3e-1d2f5c7b8a90", outcome: "booked", emergency: false, duration_seconds: 120 });
      expect(redactContactDetails("Failed for owner@synthetic.example at +15555550110 or 555.555.0110 (call 6d0c6a52-0d0e-4c43-9a3e-1d2f5c7b8a90)"))
        .toBe("Failed for [REDACTED] at [REDACTED] or [REDACTED] (call 6d0c6a52-0d0e-4c43-9a3e-1d2f5c7b8a90)");
    });

    it("never send caller or owner PII from signup, a finished call or a server error", async () => {
      const sent: Sent[] = [];
      const env = demoEnvironment({ POSTHOG_KEY: KEY, TOOL_TOKEN: toolToken });
      const telemetry = createTelemetry(env, { fetch: fakePostHogFetch(sent), flushAt: 1 });
      const { baseUrl } = await start(env, { telemetry });

      const signup = await fetch(`${baseUrl}/signup`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ businessName: PII.business, displayName: PII.ownerName, email: PII.ownerEmail, password: "long-password-for-tests", phone: PII.ownerPhone, consent: "yes" }),
      });
      expect(signup.status).toBe(303);
      const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
      const dashboard = await (await fetch(`${baseUrl}/api/app/dashboard`, { headers: { cookie } })).json() as { analytics?: { distinctId: string; tenantId: string } };
      expect(dashboard.analytics?.tenantId).toMatch(/^shop_/);
      expect(JSON.stringify(dashboard.analytics)).not.toContain(PII.ownerEmail);

      const ended = await fetch(`${baseUrl}/webhooks/telnyx`, {
        method: "POST",
        headers: { authorization: `Bearer ${toolToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          data: {
            record_type: "event", event_type: "call.conversation.ended", id: "evt-pii", occurred_at: "2026-01-15T08:02:00.000Z",
            payload: {
              assistant_id: "assistant-synthetic", call_control_id: "telnyx-call-pii", from: PII.callerPhone, duration_sec: 95,
              messages: [
                { role: "user", content: `${PII.problem} at ${PII.street}, call ${PII.callerName} back`, timestamp: "2026-01-15T08:00:10.000Z" },
                { role: "assistant", timestamp: "2026-01-15T08:00:30.000Z", tool_calls: [{ id: "tool-1", type: "function", function: { name: "save_intake", arguments: JSON.stringify({
                  caller_name: PII.callerName, callback_number: PII.callerPhone, service_address: `${PII.street}, ${PII.city}`,
                  service_category: "HVAC repair", problem_description: PII.problem, recording_disclosure_given: true,
                }) } }] },
              ],
            },
          },
        }),
      });
      expect(ended.status).toBe(200);

      telemetry.captureException(new Error(`Lookup failed for ${PII.ownerEmail} (${PII.callerPhone})`), { route: "owner:api", method: "GET", status: 500, requestId: "req-1" });
      await telemetry.flush();
      await telemetry.shutdown();

      const payload = sent.map((item) => item.body).join("\n");
      for (const event of ["owner_signed_up", "call_finalized", "$exception"]) expect(payload).toContain(event);
      for (const forbidden of FORBIDDEN) expect(payload, forbidden).not.toContain(forbidden);
      for (const item of sent) expect(new URL(item.url).origin).toBe("https://us.i.posthog.com");
    });
  });
});
