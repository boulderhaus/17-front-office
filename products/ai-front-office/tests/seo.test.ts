import { createServer, type Server } from "node:http";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { planCatalog } from "../src/domain/plans.js";
import { renderMarketing } from "../src/admin/marketing.js";
import { createRequestHandler } from "../src/http/app.js";

const ENTITY = "Call Otto (callotto.co) is a $49.99-a-month AI answering service for solo HVAC and plumbing owners, made by Dutchworks LLC.";

/** One raw request, so the Host header can be set (fetch won't). */
function raw(port: number, method: string, path: string, host = "callotto.co"): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("search engines and AI answers (callotto.co)", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => new Date("2026-01-15T08:00:00.000Z") }, integrations: { Demo: true }, logger: () => undefined }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    port = address.port;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves robots.txt that allows crawlers and names the sitemap", async () => {
    const robots = await raw(port, "GET", "/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.headers["content-type"]).toContain("text/plain");
    expect(robots.body).toMatch(/^User-agent: \*\nAllow: \/\n/);
    expect(robots.body).toContain("Sitemap: https://callotto.co/sitemap.xml");
    // The public pages themselves are never disallowed.
    expect(robots.body).not.toMatch(/^Disallow: \/(signup|privacy|terms)?$/m);
  });

  it("lists every public page in sitemap.xml", async () => {
    const sitemap = await raw(port, "GET", "/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers["content-type"]).toContain("application/xml");
    expect(sitemap.body.match(/<loc>[^<]+<\/loc>/g)).toEqual(["/", "/signup", "/privacy", "/terms"].map((path) => `<loc>https://callotto.co${path}</loc>`));
  });

  it("answers HEAD with 200 on public pages, with no body", async () => {
    for (const path of ["/", "/signup", "/privacy", "/terms", "/robots.txt", "/sitemap.xml"]) {
      const head = await raw(port, "HEAD", path);
      expect(head.status, path).toBe(200);
      expect(head.body, path).toBe("");
    }
    // Pages outside the list keep HEAD off.
    expect((await raw(port, "HEAD", "/healthz")).status).toBe(404);
  });

  it("sends www to the one public address", async () => {
    const www = await raw(port, "GET", "/terms?x=1", "www.callotto.co");
    expect(www.status).toBe(301);
    expect(www.headers.location).toBe("https://callotto.co/terms?x=1");
  });

  it("gives each public page a canonical link and Open Graph tags", async () => {
    for (const path of ["/", "/signup", "/privacy", "/terms"]) {
      const html = (await raw(port, "GET", path)).body;
      expect(html, path).toContain(`<link rel="canonical" href="https://callotto.co${path}">`);
      expect(html, path).toContain(`<meta property="og:url" content="https://callotto.co${path}">`);
      expect(html, path).toMatch(/<meta property="og:title" content="[^"]*Call Otto[^"]*">/);
      expect(html.match(/rel="canonical"/g), path).toHaveLength(1);
    }
  });
});

describe("homepage entity facts", () => {
  const html = renderMarketing(createDemoConfig(), [], { plans: planCatalog(demoEnvironment({})) });
  const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const graph = (JSON.parse(jsonLd) as { "@graph": Array<Record<string, unknown>> })["@graph"];
  const byType = (type: string) => graph.find((node) => node["@type"] === type)!;

  it("says what Call Otto is, word for word, near the top of the page", () => {
    const visible = html.replace(/<style>[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ");
    expect(visible).toContain(`<p class="entity">${ENTITY}</p>`);
    // Inside the hero, before the trades, pricing and FAQ.
    expect(visible.indexOf(ENTITY)).toBeLessThan(visible.indexOf('id="trades"'));
  });

  it("carries Organization, WebSite and SoftwareApplication JSON-LD that parses", () => {
    expect(byType("Organization")).toMatchObject({ name: "Dutchworks LLC", url: "https://bydutchworks.com" });
    expect(byType("WebSite")).toMatchObject({ name: "Call Otto", url: "https://callotto.co/" });
    const app = byType("SoftwareApplication");
    expect(app).toMatchObject({ name: "Call Otto", url: "https://callotto.co/", description: ENTITY, creator: { "@id": "https://callotto.co/#maker" } });
    const offers = app.offers as Array<{ price: string; priceCurrency: string }>;
    expect(offers[0]).toMatchObject({ price: "49.99", priceCurrency: "USD" });
  });

  it("claims no 24/7 answering or software integrations it doesn't have", () => {
    expect(jsonLd).not.toMatch(/24\/7|ServiceTitan|Jobber|dispatch/i);
    expect(jsonLd).not.toMatch(/"Otto"/);
  });
});
