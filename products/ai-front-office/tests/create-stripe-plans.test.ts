import { describe, expect, it } from "vitest";
import { archiveProductArgs, imageUrlArg, planStripeSetup, reconcileStripePlans, type StripeCall } from "../scripts/create-stripe-plans.js";

interface FakeProduct { id: string; name: string; description: string | null; images?: string[]; default_price?: string | null; active: boolean; metadata: Record<string, string> }
interface FakePrice { id: string; product: string; unit_amount: number; currency: string; recurring: { interval: string }; lookup_key: string | null; active: boolean; metadata: Record<string, string> }

/** A tiny in-memory Stripe: products, prices (with lookup-key transfer), coupons, idempotency keys. */
function fakeStripe() {
  const products: FakeProduct[] = [];
  const prices: FakePrice[] = [];
  const coupons = new Map<string, Record<string, unknown>>();
  const replays = new Map<string, { status: number; json: Record<string, unknown> }>();
  const writes: string[] = [];
  const failures = { archive: 0 };
  let next = 0;
  const id = (prefix: string) => `${prefix}_${(next += 1).toString().padStart(4, "0")}`;
  const metadata = (body: URLSearchParams) => Object.fromEntries([...body.entries()].filter(([key]) => key.startsWith("metadata[")).map(([key, value]) => [key.slice(9, -1), value]));

  const call: StripeCall = async (method, path, body, idempotencyKey) => {
    if (idempotencyKey && replays.has(idempotencyKey)) return replays.get(idempotencyKey)!;
    const url = new URL(`https://api.stripe.com/v1/${path}`);
    const q = url.searchParams;
    const parts = url.pathname.split("/").slice(2);
    let out: { status: number; json: Record<string, unknown> } = { status: 404, json: { error: { message: "not found" } } };
    if (method === "GET" && parts[0] === "products" && parts.length === 1) {
      out = { status: 200, json: { data: products.filter((item) => q.get("active") !== "true" || item.active), has_more: false } };
    } else if (method === "GET" && parts[0] === "products") {
      const found = products.find((item) => item.id === parts[1]);
      if (found) out = { status: 200, json: { ...found } };
    } else if (method === "GET" && parts[0] === "prices" && parts.length === 2) {
      const found = prices.find((item) => item.id === parts[1]);
      if (found) out = { status: 200, json: { ...found } };
    } else if (method === "GET" && parts[0] === "prices") {
      const keys = q.getAll("lookup_keys[]");
      const data = prices.filter((item) => (q.get("active") !== "true" || item.active) && (!keys.length || keys.includes(item.lookup_key ?? "")) && (!q.get("product") || item.product === q.get("product")));
      out = { status: 200, json: { data, has_more: false } };
    } else if (method === "GET" && parts[0] === "coupons") {
      const found = coupons.get(parts[1]!);
      if (found) out = { status: 200, json: found };
    } else if (method === "POST" && parts[0] === "products" && parts.length === 1) {
      writes.push(`create product ${body!.get("name")}`);
      const product: FakeProduct = { id: id("prod"), name: body!.get("name")!, description: body!.get("description"), images: body!.has("images[0]") ? [body!.get("images[0]")!] : [], active: true, metadata: metadata(body!) };
      products.push(product);
      out = { status: 200, json: { ...product } };
    } else if (method === "POST" && parts[0] === "products") {
      const product = products.find((item) => item.id === parts[1])!;
      writes.push(`update product ${product.id} ${body!.toString()}`);
      if (body!.has("active")) product.active = body!.get("active") === "true";
      if (body!.has("name")) product.name = body!.get("name")!;
      if (body!.has("description")) product.description = body!.get("description");
      if (body!.has("images[0]")) product.images = [body!.get("images[0]")!];
      if (body!.has("default_price")) product.default_price = body!.get("default_price") || null;
      out = { status: 200, json: { ...product } };
    } else if (method === "POST" && parts[0] === "prices" && parts.length === 1) {
      const lookupKey = body!.get("lookup_key");
      const holder = prices.find((item) => item.lookup_key === lookupKey);
      if (holder && body!.get("transfer_lookup_key") !== "true") return { status: 400, json: { error: { message: "lookup_key in use" } } };
      if (holder) holder.lookup_key = null;
      writes.push(`create price ${lookupKey} on ${body!.get("product")}`);
      const price: FakePrice = { id: id("price"), product: body!.get("product")!, unit_amount: Number(body!.get("unit_amount")), currency: body!.get("currency")!, recurring: { interval: body!.get("recurring[interval]")! }, lookup_key: lookupKey, active: true, metadata: metadata(body!) };
      prices.push(price);
      out = { status: 200, json: { ...price } };
    } else if (method === "POST" && parts[0] === "prices") {
      const price = prices.find((item) => item.id === parts[1])!;
      if (failures.archive > 0) { failures.archive -= 1; throw new Error("synthetic network failure"); }
      // Like Stripe: a product's default price can't be archived.
      if (body!.get("active") === "false" && products.some((item) => item.default_price === price.id)) return { status: 400, json: { error: { message: "default price" } } };
      writes.push(`archive price ${price.id}`);
      price.active = body!.get("active") === "true";
      out = { status: 200, json: { ...price } };
    }
    if (idempotencyKey) replays.set(idempotencyKey, out);
    return out;
  };
  return { call, products, prices, coupons, writes, failures };
}

/** Live Stripe before the split: one "Front Office" product holding all six prices, plus stale products. */
function seedOneProductLayout(stripe: ReturnType<typeof fakeStripe>) {
  const setup = planStripeSetup({});
  stripe.products.push({ id: "prod_old", name: "Front Office", description: null, active: true, metadata: { front_office: "plans" } });
  stripe.products.push({ id: "prod_legacy_solo", name: "Front Office Solo", description: "old", default_price: "price_legacy49", active: true, metadata: {} });
  stripe.prices.push({ id: "price_legacy49", product: "prod_legacy_solo", unit_amount: 4_900, currency: "usd", recurring: { interval: "month" }, lookup_key: null, active: true, metadata: {} });
  setup.prices.forEach((price, index) => stripe.prices.push({ id: `price_old${index}`, product: "prod_old", unit_amount: price.unitAmount, currency: "usd", recurring: { interval: "month" }, lookup_key: price.lookupKey, active: true, metadata: { plan: price.plan } }));
  stripe.coupons.set("front_office_first_month_50", { id: "front_office_first_month_50", percent_off: 50 });
}

describe("scripts/create-stripe-plans.ts four-product layout", () => {
  it("names one product per plan plus Unlimited calls, with short customer-facing descriptions", () => {
    const setup = planStripeSetup({});
    expect(setup.products).toEqual([
      { key: "solo", name: "Front Office Solo", description: "Up to 60 answered calls a month, then 75¢ per extra call.", image: null },
      { key: "team", name: "Front Office Team", description: "Up to 250 answered calls a month, then 75¢ per extra call.", image: null },
      { key: "fleet", name: "Front Office Fleet", description: "Up to 500 answered calls a month, then 75¢ per extra call.", image: null },
      { key: "unlimited", name: "Unlimited calls", description: "No extra-call charges on your Front Office plan. Fair use: up to 3× your plan’s calls.", image: null },
    ]);
    expect(setup.prices.map((price) => price.product)).toEqual(["solo", "team", "fleet", "unlimited", "unlimited", "unlimited"]);
  });

  it("dry run changes nothing and says what it would do", async () => {
    const stripe = fakeStripe();
    seedOneProductLayout(stripe);
    const lines: string[] = [];
    const result = await reconcileStripePlans(planStripeSetup({}), stripe.call, { create: false, log: (line) => lines.push(line) });
    expect(stripe.writes).toEqual([]);
    expect(lines.filter((line) => line.startsWith("Would create product"))).toHaveLength(4);
    expect(lines.some((line) => line.includes("Would archive product prod_old"))).toBe(true);
    expect(result.envLines).toEqual(["STRIPE_FIRST_MONTH_COUPON_ID=front_office_first_month_50", "STRIPE_FIRST_MONTH_PERCENT_OFF=50"]);
  });

  it("moves every lookup key onto the right product, archives the old prices and product, keeps the coupon, and is idempotent", async () => {
    const stripe = fakeStripe();
    seedOneProductLayout(stripe);
    const setup = planStripeSetup({});
    const first = await reconcileStripePlans(setup, stripe.call, { create: true, log: () => {}, archiveProducts: ["prod_legacy_solo"] });

    const byName = Object.fromEntries(stripe.products.filter((item) => item.active).map((item) => [item.name, item]));
    expect(Object.keys(byName).sort()).toEqual(["Front Office Fleet", "Front Office Solo", "Front Office Team", "Unlimited calls"]);
    expect(byName["Front Office Solo"]!.id).not.toBe("prod_legacy_solo");
    for (const price of setup.prices) {
      const holder = stripe.prices.find((item) => item.lookup_key === price.lookupKey)!;
      expect(holder.active).toBe(true);
      expect(holder.product).toBe(first.productIds[price.product]);
      expect(holder.unit_amount).toBe(price.unitAmount);
      expect(holder.metadata).toMatchObject({ plan: price.plan, front_office: price.kind === "plan" ? "plan" : "unlimited_addon" });
    }
    expect(stripe.prices.filter((item) => item.product === "prod_old" || item.product === "prod_legacy_solo").every((item) => !item.active)).toBe(true);
    expect(stripe.products.find((item) => item.id === "prod_old")!.active).toBe(false);
    expect(stripe.products.find((item) => item.id === "prod_legacy_solo")!.active).toBe(false);
    expect(stripe.coupons.get("front_office_first_month_50")).toEqual({ id: "front_office_first_month_50", percent_off: 50 });
    expect(first.envLines).toContain(`STRIPE_PRICE_ID=${first.priceIds.STRIPE_PRICE_ID_SOLO}`);
    expect(first.envLines).toContain(`STRIPE_PRICE_ID_UNLIMITED_TEAM=${first.priceIds.STRIPE_PRICE_ID_UNLIMITED_TEAM}`);

    const writes = stripe.writes.length;
    const second = await reconcileStripePlans(setup, stripe.call, { create: true, log: () => {} });
    expect(stripe.writes.length).toBe(writes);
    expect(second.envLines).toEqual(first.envLines);
  });

  it("never archives a price the app's env still uses, and archives it on the rerun after the env moves", async () => {
    const stripe = fakeStripe();
    seedOneProductLayout(stripe);
    const lines: string[] = [];
    const inUse = ["price_old0", "price_legacy49"];
    const first = await reconcileStripePlans(planStripeSetup({}), stripe.call, { create: true, inUse, archiveProducts: ["prod_legacy_solo"], log: (line) => lines.push(line) });
    expect(stripe.prices.find((item) => item.id === "price_old0")!.active).toBe(true);
    expect(stripe.prices.find((item) => item.id === "price_legacy49")!.active).toBe(true);
    expect(stripe.prices.filter((item) => /^price_old[1-5]$/.test(item.id)).every((item) => !item.active)).toBe(true);
    expect(stripe.products.find((item) => item.id === "prod_old")!.active).toBe(true);
    expect(stripe.products.find((item) => item.id === "prod_legacy_solo")!.active).toBe(true);
    // The env lines come out before any archive line.
    expect(lines.findIndex((line) => line.includes("Set these env vars"))).toBeLessThan(lines.findIndex((line) => line.startsWith("Archived")));
    expect(first.envLines).toHaveLength(9);

    await reconcileStripePlans(planStripeSetup({}), stripe.call, { create: true, inUse: [first.priceIds.STRIPE_PRICE_ID_SOLO!], archiveProducts: ["prod_legacy_solo"], log: () => {} });
    expect(stripe.prices.filter((item) => item.product === "prod_old" || item.product === "prod_legacy_solo").every((item) => !item.active)).toBe(true);
    expect(stripe.products.filter((item) => item.id === "prod_old" || item.id === "prod_legacy_solo").every((item) => !item.active)).toBe(true);
  });

  it("finishes the archive on a rerun after a run died between the move and the archive", async () => {
    const stripe = fakeStripe();
    seedOneProductLayout(stripe);
    stripe.failures.archive = 1;
    await expect(reconcileStripePlans(planStripeSetup({}), stripe.call, { create: true, log: () => {} })).rejects.toThrow(/synthetic/);
    expect(stripe.prices.filter((item) => item.product === "prod_old" && item.active).length).toBeGreaterThan(0);
    await reconcileStripePlans(planStripeSetup({}), stripe.call, { create: true, log: () => {} });
    expect(stripe.prices.filter((item) => item.product === "prod_old").every((item) => !item.active)).toBe(true);
    expect(stripe.products.find((item) => item.id === "prod_old")!.active).toBe(false);
    expect(stripe.products.filter((item) => item.active && item.metadata.front_office_product)).toHaveLength(4);
  });

  it("refuses to archive one of its own products", async () => {
    const stripe = fakeStripe();
    seedOneProductLayout(stripe);
    const first = await reconcileStripePlans(planStripeSetup({}), stripe.call, { create: true, log: () => {} });
    await expect(reconcileStripePlans(planStripeSetup({}), stripe.call, { create: true, log: () => {}, archiveProducts: [first.productIds.solo!] })).rejects.toThrow(/refusing/);
  });

  it("puts the same image on all four products, adds it to existing ones once, and rejects a non-https URL", async () => {
    const stripe = fakeStripe();
    seedOneProductLayout(stripe);
    await reconcileStripePlans(planStripeSetup({}), stripe.call, { create: true, log: () => {} });
    const image = "https://example.com/front-office.png";
    const setup = planStripeSetup({ FRONT_OFFICE_PRODUCT_IMAGE_URL: image });
    expect(setup.products.every((product) => product.image === image)).toBe(true);
    await reconcileStripePlans(setup, stripe.call, { create: true, log: () => {} });
    const ours = stripe.products.filter((item) => item.active && item.metadata.front_office_product);
    expect(ours).toHaveLength(4);
    expect(ours.every((item) => item.images?.[0] === image)).toBe(true);
    const writes = stripe.writes.length;
    await reconcileStripePlans(setup, stripe.call, { create: true, log: () => {} });
    expect(stripe.writes.length).toBe(writes);
    expect(() => planStripeSetup({ FRONT_OFFICE_PRODUCT_IMAGE_URL: "http://example.com/x.png" })).toThrow(/https/);
    expect(imageUrlArg(["--image-url", image])).toBe(image);
    expect(imageUrlArg([`--image-url=${image}`])).toBe(image);
    expect(imageUrlArg([])).toBeUndefined();
  });

  it("reads --archive-product in both spellings and only takes prod_ ids", () => {
    expect(archiveProductArgs(["node", "x", "--archive-product", "prod_a", "--archive-product=prod_b"])).toEqual(["prod_a", "prod_b"]);
    expect(() => archiveProductArgs(["--archive-product", "price_a"])).toThrow(/prod_/);
  });
});
