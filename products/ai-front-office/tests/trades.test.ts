import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { tradeForShopName, findTrade, TRADES } from "../src/domain/trades.js";
import { triageEmergency } from "../src/domain/triage.js";
import { renderMarketing } from "../src/admin/marketing.js";
import { createRequestHandler } from "../src/http/app.js";
import { shopStepPage } from "./signup-steps.js";

describe("trades", () => {
  it("gives every trade its services (no bookable catch-all) and specific urgent phrases that triage right", () => {
    expect(new Set(TRADES.map((trade) => trade.key)).size).toBe(TRADES.length);
    for (const trade of TRADES) {
      // "other" is the agent's unsure fallback; it must never become a bookable category.
      expect(trade.services.map((service) => service.toLowerCase())).not.toContain("other");
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
    // Phrases, not bare words, and never negated: none may page the owner for an ordinary call.
    const calm = [
      "It's not an emergency, whenever works.", "Our emergency contact is my wife.", "Small leak, no water damage yet.",
      "No power issues, just want an outlet added.", "We have no heat pump yet and want a quote.", "We have no water heater, want one installed.",
      "We have no power outlet in the garage.", "Gutters are dripping a little.", "Can't get in touch with my landlord, can you quote?",
      "The price came down so we're ready to book.", "Birds nesting in the eaves, routine visit.", "Faucet is dripping in the bathroom.",
      "No flooding, just a slow drain.", "Slow kitchen drain. Not flooding, whenever works this week.", "Dishwasher not draining, no flooding.",
      "Gas dryer not heating. Caller confirmed no gas smell.", "No sparking, outlet is just dead.", "No sparking, just want two outlets added.",
      "I'm not locked out, I just want my locks rekeyed.", "Wants a keypad lock so the kids don't get locked out again.",
      "Kitchen remodel quote; inspector found no structural damage.", "Small ceiling stain, no water coming in right now.",
      "Wants a quote to replace the sewage ejector pump.", "Wants a backwater valve installed to prevent basement flooding.",
      "Wants the oak trimmed back from the power line along the driveway.", "Need branches trimmed back from the power lines, whenever.",
      "Wasp nest under the deck, next week is fine.", "Hornets nest up in the oak out back, schedule whenever.", "Want a quote to spray for hornets next week, no rush.",
      "Need a broken window pane replaced.", "Wants the drywall patched where there was a water leak last year.", "Back door won't lock right.",
      "Need a broken spring replaced on the garage door.", "Wants a quote on a standby generator; they lost power for three days last winter.",
      "Heat output seems low in the back bedroom.", "Mold inspection, there was standing water last month.", "Need the dead tree taken down before winter.",
      "I want to run power out to my shed.", "We get water coming in the basement when it rains, want a waterproofing estimate.", "Fridge stopped making ice.",
      "Can you cut a dead tree down next month?", "Want better locks to prevent a break-in.", "Want to insulate the crawlspace to prevent frozen pipes.",
      "Some exposed wires in the unfinished basement need covering.", "Wants a power outage plan.",
    ];
    for (const sentence of calm) {
      // Only the trade phrases are under test here; the built-in rules are covered in triage tests.
      for (const trade of TRADES) expect(triageEmergency(sentence, { emergencyKeywords: trade.urgentWords, emergencyThreshold: 0.7 }).evidence.filter((item) => item.startsWith("configured keyword")), `${trade.key}: ${sentence}`).toEqual([]);
    }
    // Real emergencies the way callers say them: contractions, "is" dropped, one word or two.
    const urgent: Record<string, string[]> = {
      hvac: ["Our heat went out last night and it's freezing.", "Caller has frozen pipes in the crawlspace.", "Furnace stopped working and it's 50 degrees in the house.", "There's no heat in the house."],
      plumbing: ["Caller has frozen pipes in the crawlspace and no water to the kitchen.", "Toilet is overflowing and won't stop.", "Sewer is backing up into the basement floor drain.", "The water heater burst in the garage.", "I can't shut the water off."],
      electrical: ["The power's out in half the house.", "My son got shocked by the outlet and it's hot to the touch.", "Outlet is sparking."],
      roofing: ["The roof's leaking into the kids' bedroom.", "Water's coming in through the ceiling.", "Shingles blew off in the storm and we need a tarp on tonight.", "Active leak during the storm, water dripping into the bedroom."],
      restoration: ["My basement is underwater.", "There's water everywhere in the basement.", "There are two inches of water in the basement."],
      garage: ["Door won't close and it's getting dark.", "The garage door is stuck open."],
      landscaping: ["A tree fell on the house.", "Power lines down across the yard."],
      pest: ["There's a snake in the house.", "Bees are in the house and my daughter got stung."],
      locksmith: ["Someone broke in last night.", "Residential lockout, caller waiting outside.", "Locked my keys in the car with the engine running.", "Need help after a break in, the door was kicked in."],
      appliance: ["Washing machine overflowed and water is all over the laundry room.", "Refrigerator stopped cooling and all the food's going bad."],
    };
    for (const [key, sentences] of Object.entries(urgent)) {
      const trade = findTrade(key)!;
      for (const sentence of sentences) expect(triageEmergency(sentence, { emergencyKeywords: trade.urgentWords, emergencyThreshold: 0.7 }).evidence.some((item) => item.startsWith("configured keyword")), `${key}: ${sentence}`).toBe(true);
    }
    // A "no" on one line never cancels the next; "won't stop" means it keeps going; a negated phrase survives a double negative.
    for (const [key, sentence] of [
      ["plumbing", "No\nPipes froze and the kitchen is wet"], ["hvac", "Annual tune-up, nothing urgent\nHeat went out last night actually"],
      ["electrical", "The outlet won't stop sparking"], ["appliance", "Dishwasher won't stop overflowing"], ["plumbing", "We don't have no running water"],
      ["landscaping", "The tree's down across the driveway"], ["locksmith", "We had a break-in last night"],
    ] as const) expect(triageEmergency(sentence, { emergencyKeywords: findTrade(key)!.urgentWords, emergencyThreshold: 0.7 }).evidence.some((item) => item.startsWith("configured keyword")), `${key}: ${sentence}`).toBe(true);
    for (const [stem, sentence] of [["drip", "Ceiling is dripping in the kitchen"], ["trap", "Kid trapped in the garage"], ["trip", "Breaker keeps tripping"], ["clog", "Toilet clogged"], ["burn", "smells burnt"], ["leak", "Faucet won't stop leaking"]]) {
      expect(triageEmergency(sentence!, { emergencyKeywords: [stem!], emergencyThreshold: 0.7 }).emergency, `${stem}: ${sentence}`).toBe(true);
    }
    // Long negated input stays fast.
    const started = performance.now();
    triageEmergency("no sparking ".repeat(9000), { emergencyKeywords: findTrade("electrical")!.urgentWords, emergencyThreshold: 0.7 });
    expect(performance.now() - started).toBeLessThan(500);
    // An owner's own stem still covers its forms, but a phrase never runs into a longer word.
    expect(triageEmergency("Basement is flooding", { emergencyKeywords: ["flood"], emergencyThreshold: 0.7 }).emergency).toBe(true);
    expect(triageEmergency("Pipe leaked overnight", { emergencyKeywords: ["leak"], emergencyThreshold: 0.7 }).emergency).toBe(true);
    expect(triageEmergency("Wants a power outage plan", { emergencyKeywords: ["power out"], emergencyThreshold: 0.7 }).emergency).toBe(false);
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
    // "Why Call Otto" stays first: tablet widths hide the first nav link, and Trades must stay visible.
    expect(html).toContain('<nav aria-label="Main"><a href="#compare">Why Call Otto</a><a href="#trades">Trades</a>');
    expect(html).not.toContain("get started\"");
    expect(html).toContain("Water damage &#38; mold");
    expect(html).not.toMatch(/fire restoration|Fire and smoke/i);
    for (const trade of TRADES) expect(html).toContain(`href="/signup?trade=${trade.key}"`);
    expect(html).toContain("Sewage is backing up into the tub.");
    expect(html).toContain("<b>Urgent if they say</b><span>burst pipe</span><span>sewage is backing up</span>");
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

  it("never asks for the trade, and an old ?trade= link opens sign-up as usual", async () => {
    // Walk 11-26 (SIGNUP-01): no trade question on either sign-up screen.
    const plain = await (await fetch(`${baseUrl}/signup`)).text();
    const shop = await shopStepPage(baseUrl);
    for (const page of [plain, shop]) {
      expect(page).not.toContain('name="trade"');
      expect(page).not.toContain("Pick one");
      expect(page).not.toContain("Sets your services and emergency words.");
    }
    const tile = await fetch(`${baseUrl}/signup?trade=plumbing`);
    expect(tile.status).toBe(200);
    expect(await tile.text()).not.toContain('name="trade"');
    const odd = await (await fetch(`${baseUrl}/signup?trade=%22%3E%3Cscript%3E`)).text();
    expect(odd).not.toContain('"><script>');
  });

  it("starts the shop with the trade its name says, ignoring any trade sent", async () => {
    expect((await signup({ email: "sparky@synthetic.example", businessName: "Bright Spark Electric", trade: "roofing" })).status).toBe(303);
    const config = await store.getConfig((await store.getOwnerAccountByEmail("sparky@synthetic.example"))!.tenantId);
    expect(config.serviceCategories).toEqual(findTrade("electrical")!.services);
    expect(config.emergencyKeywords).toEqual(findTrade("electrical")!.urgentWords);
  });

  it("a name that says nothing gets general home services, and explicit lists still win", async () => {
    expect((await signup({ email: "none@synthetic.example", businessName: "Synthetic Brothers" })).status).toBe(303);
    const none = await store.getConfig((await store.getOwnerAccountByEmail("none@synthetic.example"))!.tenantId);
    expect(none.serviceCategories).toEqual(findTrade("other")!.services);
    expect(none.emergencyKeywords).toEqual(findTrade("other")!.urgentWords);
    expect((await signup({ email: "explicit@synthetic.example", businessName: "Gulf Plumbing", serviceCategories: "Septic pumping, Other" })).status).toBe(303);
    const explicit = await store.getConfig((await store.getOwnerAccountByEmail("explicit@synthetic.example"))!.tenantId);
    expect(explicit.serviceCategories).toEqual(["Septic pumping", "Other"]);
    expect(explicit.emergencyKeywords).toEqual(findTrade("plumbing")!.urgentWords);
  });
});

describe("trade from the shop name", () => {
  it("reads the obvious trade words, first one in the name wins, and never guesses from parts of words", () => {
    const cases: Array<[string, string]> = [
      ["Gulf Air", "hvac"], ["Sunshine A/C & Heating", "hvac"], ["Comfort HVAC", "hvac"],
      ["ABC Plumbing & Heating", "plumbing"], ["Rapid Rooter", "plumbing"],
      ["Bright Electric LLC", "electrical"], ["Top Notch Roofing", "roofing"], ["Smith Remodeling", "construction"],
      ["Coastal Restoration", "restoration"], ["Pro Garage Doors", "garage"], ["Mike’s Handyman Service", "handyman"],
      ["Green Lawns", "landscaping"], ["Bug Busters", "pest"], ["Key Locksmith", "locksmith"], ["Acme Appliance Repair", "appliance"],
      // Nothing to go on, or a trade word only inside another word: general home services.
      ["Synthetic Brothers", "other"], ["Blockbuster Repair", "other"], ["Airtight Sealing", "other"], ["Power Washing Pros", "other"], ["", "other"],
    ];
    for (const [name, key] of cases) expect(tradeForShopName(name).key, name).toBe(key);
  });
});
