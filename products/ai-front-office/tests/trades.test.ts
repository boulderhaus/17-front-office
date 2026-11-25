import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { findTrade, TRADES } from "../src/domain/trades.js";
import { triageEmergency } from "../src/domain/triage.js";
import { renderMarketing } from "../src/admin/marketing.js";
import { createRequestHandler } from "../src/http/app.js";

describe("trades", () => {
  it("gives every trade services with a catch-all and specific urgent phrases that triage right", () => {
    expect(new Set(TRADES.map((trade) => trade.key)).size).toBe(TRADES.length);
    for (const trade of TRADES) {
      expect(trade.services.map((service) => service.toLowerCase())).toContain("other");
      expect(trade.urgentWords.length).toBeGreaterThan(1);
      for (const word of trade.urgentWords) {
        const decision = triageEmergency(`Caller says: ${word} at the house`, { emergencyKeywords: trade.urgentWords, emergencyThreshold: 0.7 });
        expect(decision.emergency, `${trade.key}: ${word}`).toBe(true);
      }
      // The two shown on the homepage are the trade's own, not the always-on life-safety rules.
      for (const word of trade.urgentWords.slice(0, 2)) expect(triageEmergency(word, { emergencyKeywords: [], emergencyThreshold: 0.7 }).severity, `${trade.key}: ${word}`).not.toBe("life_safety");
      // An urgent-sounding homepage call trips its own trade's words; the routine ones are named here.
      if (trade.call && !["construction", "handyman"].includes(trade.key)) {
        expect(triageEmergency(trade.call, { emergencyKeywords: trade.urgentWords, emergencyThreshold: 0.7 }).emergency, `${trade.key}: ${trade.call}`).toBe(true);
      }
    }
    // Phrases, not bare words: none may page the owner for an ordinary call.
    const calm = [
      "It's not an emergency, whenever works.", "Our emergency contact is my wife.", "Small leak, no water damage yet.",
      "No power issues, just want an outlet added.", "We have no heat pump yet and want a quote.", "We have no water heater, want one installed.",
      "We have no power outlet in the garage.", "Gutters are dripping a little.", "Can't get in touch with my landlord, can you quote?",
      "The price came down so we're ready to book.", "Birds nesting in the eaves, routine visit.", "Faucet is dripping in the bathroom.",
    ];
    for (const sentence of calm) {
      // Only the trade phrases are under test here; the built-in rules are covered in triage tests.
      for (const trade of TRADES) expect(triageEmergency(sentence, { emergencyKeywords: trade.urgentWords, emergencyThreshold: 0.7 }).evidence.filter((item) => item.startsWith("configured keyword")), `${trade.key}: ${sentence}`).toEqual([]);
    }
    // Curly, straight or missing apostrophes are the same words.
    const garage = findTrade("garage")!;
    for (const note of ["Door won’t close", "door won't close", "DOOR WONT CLOSE", "door will not  close"]) {
      expect(triageEmergency(note, { emergencyKeywords: garage.urgentWords, emergencyThreshold: 0.7 }).emergency, note).toBe(true);
    }
    expect(findTrade(" Plumbing ")?.key).toBe("plumbing");
    expect(findTrade("submarines")).toBeNull();
    expect(findTrade(null)).toBeNull();
  });

  it("puts every trade on the homepage, each linking to signup with it picked", () => {
    const html = renderMarketing(createDemoConfig(), []);
    expect(html).toContain('id="trades"');
    expect(html).toContain('<a href="#trades">Trades</a>');
    for (const trade of TRADES) expect(html).toContain(`href="/signup?trade=${trade.key}"`);
    expect(html).toContain("Sewage is backing up into the tub.");
    expect(html).toContain("<b>Marked urgent</b><span>burst pipe</span><span>sewage</span>");
    expect(html).toContain("<span>won’t close</span>");
    expect(html).toContain("Contractors &#38; remodelers");
    // Strict CSP: icons are inline SVG, never a script.
    expect(html).not.toMatch(/<script(?![^>]*src=)/);
  });
});

describe("signup by trade", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock: { now: () => new Date("2026-01-15T08:00:00.000Z") }, integrations: { Demo: true }, logger: () => undefined }));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const signup = (fields: Record<string, string>) => fetch(`${baseUrl}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ businessName: "Synthetic Shop", password: "long-password-for-tests", consent: "yes", ...fields }) });

  it("asks for the trade, and a homepage tile arrives with it picked", async () => {
    const plain = await (await fetch(`${baseUrl}/signup`)).text();
    expect(plain).toContain('<select name="trade" required>');
    expect(plain).toContain('<option value="" selected disabled>Pick one</option>');
    expect(plain).toContain("Five quick answers.");
    const picked = await (await fetch(`${baseUrl}/signup?trade=plumbing`)).text();
    expect(picked).toContain('<option value="plumbing" selected>Plumbing</option>');
    expect(picked).toContain('<option value="" disabled>Pick one</option>');
    const unknown = await (await fetch(`${baseUrl}/signup?trade=%22%3E%3Cscript%3E`)).text();
    expect(unknown).toContain('<option value="" selected disabled>Pick one</option>');
    expect(unknown).not.toContain('"><script>');
  });

  it("starts the shop with its trade's services and urgent words", async () => {
    expect((await signup({ email: "sparky@synthetic.example", trade: "electrical" })).status).toBe(303);
    const account = await store.getOwnerAccountByEmail("sparky@synthetic.example");
    const config = await store.getConfig(account!.tenantId);
    expect(config.serviceCategories).toEqual(findTrade("electrical")!.services);
    expect(config.emergencyKeywords).toEqual(findTrade("electrical")!.urgentWords);
  });

  it("keeps the old defaults when no trade or an unknown one is sent, and explicit lists still win", async () => {
    expect((await signup({ email: "none@synthetic.example" })).status).toBe(303);
    const none = await store.getConfig((await store.getOwnerAccountByEmail("none@synthetic.example"))!.tenantId);
    expect(none.serviceCategories).toEqual(["HVAC repair", "HVAC maintenance"]);
    expect((await signup({ email: "odd@synthetic.example", trade: "submarines" })).status).toBe(303);
    const odd = await store.getConfig((await store.getOwnerAccountByEmail("odd@synthetic.example"))!.tenantId);
    expect(odd.serviceCategories).toEqual(["HVAC repair", "HVAC maintenance"]);
    expect((await signup({ email: "explicit@synthetic.example", trade: "plumbing", serviceCategories: "Septic pumping, Other" })).status).toBe(303);
    const explicit = await store.getConfig((await store.getOwnerAccountByEmail("explicit@synthetic.example"))!.tenantId);
    expect(explicit.serviceCategories).toEqual(["Septic pumping", "Other"]);
    expect(explicit.emergencyKeywords).toEqual(findTrade("plumbing")!.urgentWords);
  });

  it("keeps the picked trade when the form comes back with an error", async () => {
    const failed = await signup({ email: "short@synthetic.example", trade: "roofing", password: "short" });
    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain('<option value="roofing" selected>Roofing</option>');
  });
});
