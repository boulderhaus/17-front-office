/**
 * Sets up Front Office billing in Stripe: one product "Front Office", the four monthly plan prices
 * (Solo, Pro, Team, Fleet; found again by lookup_key, so running twice never duplicates them) and the
 * "first month half off" coupon (50% off, duration once). Prints the env lines to set.
 *
 *   node --import tsx scripts/create-stripe-plans.ts            # dry run: what it would create (read-only lookups if a key is set)
 *   STRIPE_SECRET_KEY=sk_test_... node --import tsx scripts/create-stripe-plans.ts --create
 *
 * A live key (sk_live_ / rk_live_) also needs --live. Prices and calls come from PLAN_<ID>_PRICE_CENTS /
 * PLAN_<ID>_CALLS / PLAN_<ID>_LABEL when set, else the approved defaults. A changed price gets a new lookup_key
 * (the amount is part of it), so an old price is never silently reused for a new amount.
 */
import { DEFAULT_PLANS, PLAN_IDS, type PlanId } from "../src/domain/plans.js";

export interface PlannedPrice { plan: PlanId; envName: string; label: string; unitAmount: number; includedCalls: number; lookupKey: string }
export interface StripePlansSetup { productName: string; prices: PlannedPrice[]; coupon: { id: string; percentOff: number } }

/** What the script will make, from env overrides and the approved defaults. Pure, so it is tested. */
export function planStripeSetup(env: Record<string, string | undefined>): StripePlansSetup {
  const number = (value: string | undefined, fallback: number): number => {
    const parsed = value === undefined || value === "" ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive whole number, got ${value}`);
    return parsed;
  };
  const prices = PLAN_IDS.map((plan): PlannedPrice => {
    const key = plan.toUpperCase();
    const unitAmount = number(env[`PLAN_${key}_PRICE_CENTS`], DEFAULT_PLANS[plan].priceCents);
    return {
      plan,
      envName: `STRIPE_PRICE_ID_${key}`,
      label: env[`PLAN_${key}_LABEL`]?.trim() || DEFAULT_PLANS[plan].label,
      unitAmount,
      includedCalls: number(env[`PLAN_${key}_CALLS`], DEFAULT_PLANS[plan].includedCalls),
      lookupKey: `front_office_${plan}_${unitAmount}_monthly`,
    };
  });
  const percentOff = number(env.STRIPE_FIRST_MONTH_PERCENT_OFF, 50);
  if (percentOff > 100) throw new Error("STRIPE_FIRST_MONTH_PERCENT_OFF must be 1-100");
  return { productName: "Front Office", prices, coupon: { id: `front_office_first_month_${percentOff}`, percentOff } };
}

type Json = Record<string, unknown> & { id?: string; error?: { message?: string } };

async function main(): Promise<void> {
  const setup = planStripeSetup(process.env);
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const create = process.argv.includes("--create");
  const live = /^(sk|rk)_live_/.test(key);
  console.log(`${key ? (live ? "LIVE" : "test") : "no key"} mode · ${create ? "CREATE" : "dry run"}`);
  console.log(`Product: ${setup.productName} (metadata front_office=plans)`);
  for (const price of setup.prices) console.log(`Price: ${price.label} $${(price.unitAmount / 100).toFixed(2)}/month, ${price.includedCalls} answered calls · lookup_key ${price.lookupKey}`);
  console.log(`Coupon: ${setup.coupon.id} · ${setup.coupon.percentOff}% off, duration once`);
  if (create && !key) throw new Error("Set STRIPE_SECRET_KEY");
  if (create && live && !process.argv.includes("--live")) throw new Error("This is a live key. Add --live if you really mean to create these in live Stripe.");
  if (!key) {
    console.log("Dry run. Set STRIPE_SECRET_KEY to see what already exists, and pass --create to create what's missing.");
    return;
  }

  const stripe = async (method: "GET" | "POST", path: string, body?: URLSearchParams, idempotencyKey?: string): Promise<{ status: number; json: Json }> => {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      ...(body ? { body } : {}),
    });
    const json = await response.json().catch(() => ({})) as Json;
    if (!response.ok && response.status !== 404) throw new Error(`Stripe ${method} /${path.split("?")[0]} failed with HTTP ${response.status}: ${json.error?.message ?? "unknown error"}`);
    return { status: response.status, json };
  };

  // Product: the one tagged front_office=plans, or a new one.
  const products = await stripe("GET", "products?active=true&limit=100");
  let productId = (products.json.data as Array<{ id: string; metadata?: Record<string, string> }> | undefined)?.find((item) => item.metadata?.front_office === "plans")?.id ?? null;
  if (!productId) {
    if (!create) console.log("Would create product Front Office.");
    else {
      const product = await stripe("POST", "products", new URLSearchParams({ name: setup.productName, "metadata[front_office]": "plans" }), "front-office-plans-product-v1");
      productId = product.json.id ?? null;
      console.log(`Created product ${productId}`);
    }
  } else console.log(`Found product ${productId}`);

  const envLines: string[] = [];
  for (const price of setup.prices) {
    const found = await stripe("GET", `prices?active=true&lookup_keys[]=${encodeURIComponent(price.lookupKey)}&limit=1`);
    let priceId = (found.json.data as Array<{ id: string }> | undefined)?.[0]?.id ?? null;
    if (priceId) console.log(`Found ${price.label}: ${priceId}`);
    else if (!create || !productId) console.log(`Would create ${price.label} price (${price.lookupKey}).`);
    else {
      const createdPrice = await stripe("POST", "prices", new URLSearchParams({
        product: productId,
        currency: "usd",
        unit_amount: String(price.unitAmount),
        "recurring[interval]": "month",
        lookup_key: price.lookupKey,
        nickname: `${price.label} · ${price.includedCalls} answered calls`,
        "metadata[front_office]": "plan",
        "metadata[plan]": price.plan,
        "metadata[included_calls]": String(price.includedCalls),
      }), `front-office-price-${price.lookupKey}`);
      priceId = createdPrice.json.id ?? null;
      console.log(`Created ${price.label}: ${priceId}`);
    }
    if (priceId) envLines.push(`${price.envName}=${priceId}`);
  }

  // Coupon with our own id, so it is found again instead of created twice.
  const coupon = await stripe("GET", `coupons/${encodeURIComponent(setup.coupon.id)}`);
  let couponId = coupon.status === 200 ? coupon.json.id ?? null : null;
  if (couponId) console.log(`Found coupon ${couponId}`);
  else if (!create) console.log(`Would create coupon ${setup.coupon.id}.`);
  else {
    const createdCoupon = await stripe("POST", "coupons", new URLSearchParams({
      id: setup.coupon.id,
      percent_off: String(setup.coupon.percentOff),
      duration: "once",
      name: `First month ${setup.coupon.percentOff}% off`,
      "metadata[front_office]": "first_month",
    }), `front-office-coupon-${setup.coupon.id}`);
    couponId = createdCoupon.json.id ?? null;
    console.log(`Created coupon ${couponId}`);
  }
  if (couponId) envLines.push(`STRIPE_FIRST_MONTH_COUPON_ID=${couponId}`, `STRIPE_FIRST_MONTH_PERCENT_OFF=${setup.coupon.percentOff}`);

  console.log(envLines.length ? `\nSet these env vars:\n${envLines.join("\n")}` : "\nNothing to set yet. Pass --create to create the missing objects.");
}

if (process.argv[1]?.endsWith("create-stripe-plans.ts")) await main();
