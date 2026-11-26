import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";
import { renderForgotPassword } from "../src/admin/render.js";

describe("public copy only promises what is true today", () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = null; });

  it("homepage, terms and the password pages", async () => {
    const store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", SUPPORT_EMAIL: "hello@example.test" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => new Date("2026-11-23T15:00:00Z") }, integrations: {}, logger: () => undefined }));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const page = async (path: string) => (await fetch(`http://127.0.0.1:${address.port}${path}`)).text();
    const home = await page("/");
    for (const untrue of ["turns on by itself", "confirm each job by text", "A text for every new lead", "text you the job"]) expect(home).not.toContain(untrue);
    expect(home).toContain("<li>A phone alert for every new lead</li>");
    expect(home).not.toMatch(/and a text for each lead/);
    const terms = await page("/terms");
    expect(terms).toContain("Cancel anytime in the app: Settings → Plan and billing, then Cancel plan.");
    expect(terms).toContain("automated call to the owner mobile number");
    expect(await page("/reset?token=abc")).toContain("mailto:hello@example.test");
    expect(await page("/forgot")).toContain("hello@example.test");
  });

  it("forgot page shows the support email with email reset on too", () => {
    expect(renderForgotPassword({ emailEnabled: true, supportEmail: "hello@example.test" })).toContain("mailto:hello@example.test");
    expect(renderForgotPassword({ emailEnabled: true, sent: true, supportEmail: "hello@example.test" })).toContain("mailto:hello@example.test");
    expect(renderForgotPassword({ emailEnabled: true })).not.toContain("mailto:");
  });
});
