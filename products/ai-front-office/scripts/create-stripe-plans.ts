/**
 * Sets up Front Office billing in Stripe as four products, so checkout pages and receipts name the plan:
 *   "Front Office Solo", "Front Office Team", "Front Office Fleet"  (one monthly price each)
 *   "Unlimited calls"                                              (the add-on: one price per plan, a second subscription item)
 * plus the "first month half off" coupon (50% off, duration once, no product restriction, so it covers the whole
 * first invoice, add-on included). Pro is no longer sold, so no Pro price is made (existing Pro prices keep working).
 *
 * Idempotent: products are found by metadata front_office_product=<solo|team|fleet|unlimited>, prices by lookup_key,
 * the coupon by its own id, and every create carries an idempotency key. A price whose lookup_key still sits on
 * another product (the old single "Front Office" product) gets a new price on the right product with
 * transfer_lookup_key=true. Only once every new price exists (and its env lines are printed) are the replaced prices and
 * the old product archived, and never a price the app's current env still points at: set the env, redeploy, rerun.
 *
 *   node --import tsx scripts/create-stripe-plans.ts            # dry run (the default): read-only lookups if a key is set
 *   node dist/scripts/create-stripe-plans.js                    # the same, compiled
 *   STRIPE_SECRET_KEY=sk_test_... node --import tsx scripts/create-stripe-plans.ts --create
 *   ... --create --archive-product prod_123                     # also archive a stale product and its active prices
 *   ... --image-url https://.../logo.png                        # same product image on all four (or FRONT_OFFICE_PRODUCT_IMAGE_URL)
 *
 * A live key (sk_live_ / rk_live_) also needs --live. Prices and calls come from PLAN_<ID>_PRICE_CENTS /
 * PLAN_<ID>_CALLS / PLAN_<ID>_LABEL / PLAN_<ID>_UNLIMITED_CENTS / OVERAGE_CENTS_PER_CALL when set, else the approved
 * defaults. A changed price gets a new lookup_key (the amount is part of it), so an old price is never silently
 * reused for a new amount.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_OVERAGE_CENTS_PER_CALL, DEFAULT_PLANS, FAIR_USE_LINE, FAIR_USE_MULTIPLIER, SOLD_PLAN_IDS, perCall, type PlanId } from "../src/domain/plans.js";

export type ProductKey = PlanId | "unlimited";
/** image: one https URL shown on checkout and receipts, the same on all four products (null: leave images alone). */
export interface PlannedProduct { key: ProductKey; name: string; description: string; image: string | null }
export interface PlannedPrice { plan: PlanId; kind: "plan" | "unlimited"; product: ProductKey; envName: string; label: string; unitAmount: number; includedCalls: number; lookupKey: string }
export interface StripePlansSetup { products: PlannedProduct[]; prices: PlannedPrice[]; coupon: { id: string; percentOff: number } }

/** The metadata key a Front Office product is found by. */
export const PRODUCT_METADATA_KEY = "front_office_product";
/** The metadata the one-product layout (before 2026-11-23) tagged its product with. */
const OLD_PRODUCT_METADATA = { key: "front_office", value: "plans" } as const;

/** What the script will make, from env overrides and the approved defaults. Pure, so it is tested. */
export function planStripeSetup(env: Record<string, string | undefined>): StripePlansSetup {
  const number = (value: string | undefined, fallback: number): number => {
    const parsed = value === undefined || value === "" ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive whole number, got ${value}`);
    return parsed;
  };
  const overage = number(env.OVERAGE_CENTS_PER_CALL, DEFAULT_OVERAGE_CENTS_PER_CALL);
  const image = env.FRONT_OFFICE_PRODUCT_IMAGE_URL?.trim() || null;
  if (image !== null && !/^https:\/\/\S+$/.test(image)) throw new Error(`FRONT_OFFICE_PRODUCT_IMAGE_URL / --image-url must be an https URL, got ${image}`);
  const plans = SOLD_PLAN_IDS.map((plan) => {
    const key = plan.toUpperCase();
    return {
      plan,
      key,
      label: env[`PLAN_${key}_LABEL`]?.trim() || DEFAULT_PLANS[plan].label,
      unitAmount: number(env[`PLAN_${key}_PRICE_CENTS`], DEFAULT_PLANS[plan].priceCents),
      includedCalls: number(env[`PLAN_${key}_CALLS`], DEFAULT_PLANS[plan].includedCalls),
      addOn: number(env[`PLAN_${key}_UNLIMITED_CENTS`], DEFAULT_PLANS[plan].unlimitedAddOnCents ?? 0),
    };
  });
  const products: PlannedProduct[] = [
    ...plans.map((plan): PlannedProduct => ({
      key: plan.plan,
      name: `Front Office ${plan.label}`,
      description: `Up to ${plan.includedCalls} answered calls a month, then ${perCall(overage)} per extra call.`,
      image,
    })),
    { key: "unlimited", name: "Unlimited calls", description: `No extra-call charges on your Front Office plan. ${FAIR_USE_LINE}`, image },
  ];
  const prices: PlannedPrice[] = [
    ...plans.map((plan): PlannedPrice => ({
      plan: plan.plan, kind: "plan", product: plan.plan, envName: `STRIPE_PRICE_ID_${plan.key}`, label: plan.label, unitAmount: plan.unitAmount,
      includedCalls: plan.includedCalls, lookupKey: `front_office_${plan.plan}_${plan.unitAmount}_monthly`,
    })),
    ...plans.map((plan): PlannedPrice => ({
      plan: plan.plan, kind: "unlimited", product: "unlimited", envName: `STRIPE_PRICE_ID_UNLIMITED_${plan.key}`, label: `${plan.label} Unlimited calls`, unitAmount: plan.addOn,
      includedCalls: plan.includedCalls * FAIR_USE_MULTIPLIER, lookupKey: `front_office_unlimited_${plan.plan}_${plan.addOn}_monthly`,
    })),
  ];
  const percentOff = number(env.STRIPE_FIRST_MONTH_PERCENT_OFF, 50);
  if (percentOff > 100) throw new Error("STRIPE_FIRST_MONTH_PERCENT_OFF must be 1-100");
  return { products, prices, coupon: { id: `front_office_first_month_${percentOff}`, percentOff } };
}

/** The product fields we own: name, description and (when set) the image. */
export function productBody(product: PlannedProduct): URLSearchParams {
  return new URLSearchParams({ name: product.name, description: product.description, ...(product.image ? { "images[0]": product.image } : {}) });
}

/** The price body sent to Stripe: amount, interval, lookup key and the metadata the app and reports rely on. */
/** replaces: the price this one takes the lookup key from, recorded so an interrupted run can still archive it. */
export function priceBody(price: PlannedPrice, productId: string, replaces?: string): URLSearchParams {
  return new URLSearchParams({
    product: productId,
    currency: "usd",
    unit_amount: String(price.unitAmount),
    "recurring[interval]": "month",
    lookup_key: price.lookupKey,
    transfer_lookup_key: "true",
    nickname: price.kind === "plan" ? `${price.label} · ${price.includedCalls} answered calls` : `${price.label} · fair use ${price.includedCalls} calls`,
    "metadata[front_office]": price.kind === "plan" ? "plan" : "unlimited_addon",
    "metadata[plan]": price.plan,
    ...(price.kind === "plan" ? { "metadata[included_calls]": String(price.includedCalls) } : { "metadata[fair_use_calls]": String(price.includedCalls) }),
    ...(replaces ? { "metadata[replaces]": replaces } : {}),
  });
}

/**
 * True when this module is the program being run, from the .ts source (tsx) or the compiled .js. The old check
 * only matched ".ts", so `node dist/scripts/create-stripe-plans.js` silently did nothing.
 */
export function isDirectRun(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
  return real(fileURLToPath(moduleUrl)) === real(argv1);
}

type Json = Record<string, unknown> & { id?: string; error?: { message?: string } };
export type StripeCall = (method: "GET" | "POST", path: string, body?: URLSearchParams, idempotencyKey?: string) => Promise<{ status: number; json: Json }>;
interface StripeProduct { id: string; name?: string; description?: string | null; images?: string[]; active?: boolean; metadata?: Record<string, string> }
interface StripePrice { id: string; product?: string; unit_amount?: number; currency?: string; recurring?: { interval?: string } | null; lookup_key?: string | null; active?: boolean; metadata?: Record<string, string> }

/** Every page of a Stripe list (products, prices). */
async function listAll<T extends { id: string }>(stripe: StripeCall, path: string): Promise<T[]> {
  const items: T[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await stripe("GET", `${path}${path.includes("?") ? "&" : "?"}limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
    const data = (page.json.data as T[] | undefined) ?? [];
    items.push(...data);
    if (!page.json.has_more || data.length === 0) return items;
    after = data[data.length - 1]!.id;
  }
}

/** inUse: price ids the running app is configured with (never archived, so checkout keeps working until env moves). */
export interface ReconcileOptions { create: boolean; archiveProducts?: string[]; inUse?: string[]; log?: (line: string) => void }
export interface ReconcileResult { productIds: Partial<Record<ProductKey, string>>; priceIds: Record<string, string>; couponId: string | null; envLines: string[] }

/**
 * Brings Stripe to the four-product layout. With create=false it only reads and says what it would do.
 * Exported so the whole flow is tested against a fake Stripe.
 */
export async function reconcileStripePlans(setup: StripePlansSetup, stripe: StripeCall, options: ReconcileOptions): Promise<ReconcileResult> {
  const log = options.log ?? console.log;
  const { create } = options;
  const result: ReconcileResult = { productIds: {}, priceIds: {}, couponId: null, envLines: [] };

  // Products, by metadata (never by name: an old product may share a name).
  const activeProducts = await listAll<StripeProduct>(stripe, "products?active=true");
  for (const planned of setup.products) {
    const found = activeProducts.filter((item) => item.metadata?.[PRODUCT_METADATA_KEY] === planned.key);
    if (found.length > 1) throw new Error(`More than one active product has ${PRODUCT_METADATA_KEY}=${planned.key}: ${found.map((item) => item.id).join(", ")}. Archive the extras first.`);
    const existing = found[0];
    if (existing) {
      result.productIds[planned.key] = existing.id;
      const sameImage = planned.image === null || (existing.images?.length === 1 && existing.images[0] === planned.image);
      if (existing.name === planned.name && (existing.description ?? "") === planned.description && sameImage) { log(`Found product ${planned.name}: ${existing.id}`); continue; }
      if (!create) { log(`Would update product ${existing.id} to "${planned.name}" / "${planned.description}"${planned.image ? ` / image ${planned.image}` : ""}.`); continue; }
      await stripe("POST", `products/${encodeURIComponent(existing.id)}`, productBody(planned));
      log(`Updated product ${planned.name}: ${existing.id}`);
      continue;
    }
    if (!create) { log(`Would create product "${planned.name}" (${planned.description})${planned.image ? ` with image ${planned.image}` : ""}.`); continue; }
    const body = productBody(planned);
    body.set(`metadata[${PRODUCT_METADATA_KEY}]`, planned.key);
    // The key carries a hash of the body: Stripe rejects a reused key with a changed body (e.g. a new image).
    const created = await stripe("POST", "products", body, `front-office-product-${planned.key}-${createHash("sha256").update(body.toString()).digest("hex").slice(0, 12)}`);
    if (!created.json.id) throw new Error(`Stripe did not return an id for product ${planned.name}`);
    result.productIds[planned.key] = created.json.id;
    log(`Created product ${planned.name}: ${created.json.id}`);
  }

  // Prices, by lookup key. One on the right product is reused; one elsewhere is replaced (and archived below).
  const displaced = new Set<string>();
  for (const price of setup.prices) {
    const productId = result.productIds[price.product];
    const found = await stripe("GET", `prices?active=true&lookup_keys[]=${encodeURIComponent(price.lookupKey)}&limit=1`);
    const existing = (found.json.data as StripePrice[] | undefined)?.[0];
    if (existing && productId && existing.product === productId) {
      if (existing.unit_amount !== price.unitAmount || existing.currency !== "usd" || existing.recurring?.interval !== "month") {
        throw new Error(`Price ${existing.id} has lookup_key ${price.lookupKey} but is not ${price.unitAmount} usd monthly. Fix it by hand.`);
      }
      log(`Found ${price.label}: ${existing.id}`);
      result.priceIds[price.envName] = existing.id;
      // A run that died between the move and the archive left the price it replaced active: finish that here.
      if (existing.metadata?.replaces) displaced.add(existing.metadata.replaces);
      continue;
    }
    const move = existing ? ` (moving lookup_key from ${existing.id} on ${existing.product})` : "";
    if (!create || !productId) {
      log(`Would create ${price.label} price $${(price.unitAmount / 100).toFixed(2)}/month on "${setup.products.find((item) => item.key === price.product)!.name}" (${price.lookupKey})${move}.`);
      if (existing) displaced.add(existing.id);
      continue;
    }
    const created = await stripe("POST", "prices", priceBody(price, productId, existing?.id), `front-office-price-${price.lookupKey}-${productId}`);
    if (!created.json.id) throw new Error(`Stripe did not return an id for price ${price.lookupKey}`);
    result.priceIds[price.envName] = created.json.id;
    if (existing) displaced.add(existing.id);
    log(`Created ${price.label}: ${created.json.id}${move}`);
  }

  // Coupon with our own id, so it is found again instead of created twice. Never changed once it exists.
  const coupon = await stripe("GET", `coupons/${encodeURIComponent(setup.coupon.id)}`);
  result.couponId = coupon.status === 200 ? coupon.json.id ?? null : null;
  if (result.couponId) log(`Found coupon ${result.couponId}`);
  else if (!create) log(`Would create coupon ${setup.coupon.id}.`);
  else {
    const createdCoupon = await stripe("POST", "coupons", new URLSearchParams({
      id: setup.coupon.id,
      percent_off: String(setup.coupon.percentOff),
      duration: "once",
      name: `First month ${setup.coupon.percentOff}% off`,
      "metadata[front_office]": "first_month",
    }), `front-office-coupon-${setup.coupon.id}`);
    result.couponId = createdCoupon.json.id ?? null;
    log(`Created coupon ${result.couponId}`);
  }

  for (const price of setup.prices) if (result.priceIds[price.envName]) result.envLines.push(`${price.envName}=${result.priceIds[price.envName]}`);
  // STRIPE_PRICE_ID is the Solo fallback the readiness check reads; keep it on the current Solo price.
  if (result.priceIds.STRIPE_PRICE_ID_SOLO) result.envLines.push(`STRIPE_PRICE_ID=${result.priceIds.STRIPE_PRICE_ID_SOLO}`);
  if (result.couponId) result.envLines.push(`STRIPE_FIRST_MONTH_COUPON_ID=${result.couponId}`, `STRIPE_FIRST_MONTH_PERCENT_OFF=${setup.coupon.percentOff}`);
  const allPriced = setup.prices.every((price) => result.priceIds[price.envName]);
  // Printed before anything is archived, so a failure below never loses the new ids.
  if (create && result.envLines.length) log(`\nSet these env vars:\n${result.envLines.join("\n")}\n`);

  // Archive: the prices that were replaced, and the old single product (and any named product) with all its active
  // prices. Only once every planned price exists, and never a price the running app's env still points at.
  const ours = new Set(Object.values(result.productIds));
  for (const id of options.archiveProducts ?? []) if (ours.has(id)) throw new Error(`${id} is one of the four Front Office products; refusing to archive it.`);
  if (create && !allPriced) { log("Not archiving anything: not every planned price exists yet."); return result; }
  const inUse = new Set(options.inUse ?? []);
  const keepBecauseInUse = (priceId: string): boolean => {
    if (!inUse.has(priceId)) return false;
    log(`Keeping price ${priceId} active: the app's env still uses it. Set the env vars above, redeploy, then rerun to archive it.`);
    return true;
  };
  const archivePrice = async (priceId: string): Promise<void> => {
    if (!create) { log(`Would archive price ${priceId}.`); return; }
    await stripe("POST", `prices/${encodeURIComponent(priceId)}`, new URLSearchParams({ active: "false" }));
    log(`Archived price ${priceId}`);
  };
  const oldProducts = activeProducts.filter((item) => item.metadata?.[OLD_PRODUCT_METADATA.key] === OLD_PRODUCT_METADATA.value && !ours.has(item.id)).map((item) => item.id);
  const handled = new Set<string>();
  for (const productId of new Set([...oldProducts, ...(options.archiveProducts ?? [])])) {
    const product = await stripe("GET", `products/${encodeURIComponent(productId)}`);
    if (product.status !== 200 || product.json.active === false) { log(`Product ${productId} is already archived or missing.`); continue; }
    const active = await listAll<StripePrice>(stripe, `prices?product=${encodeURIComponent(productId)}&active=true`);
    let kept = false;
    // Stripe won't archive a product's default price, so the default is cleared first (only when it is archivable).
    const defaultPrice = typeof product.json.default_price === "string" ? product.json.default_price : null;
    if (defaultPrice && active.some((item) => item.id === defaultPrice) && !inUse.has(defaultPrice)) {
      if (!create) log(`Would clear the default price ${defaultPrice} of ${productId}.`);
      else {
        await stripe("POST", `products/${encodeURIComponent(productId)}`, new URLSearchParams({ default_price: "" }));
        log(`Cleared the default price ${defaultPrice} of ${productId}`);
      }
    }
    for (const item of active) {
      handled.add(item.id);
      if (keepBecauseInUse(item.id)) { kept = true; continue; }
      await archivePrice(item.id);
    }
    if (kept) { log(`Keeping product ${productId} "${String(product.json.name)}" until its prices can be archived.`); continue; }
    if (!create) { log(`Would archive product ${productId} "${String(product.json.name)}".`); continue; }
    await stripe("POST", `products/${encodeURIComponent(productId)}`, new URLSearchParams({ active: "false" }));
    log(`Archived product ${productId} "${String(product.json.name)}"`);
  }
  for (const priceId of displaced) {
    if (handled.has(priceId)) continue;
    const price = await stripe("GET", `prices/${encodeURIComponent(priceId)}`);
    if (price.status !== 200 || price.json.active === false) continue;
    if (!keepBecauseInUse(priceId)) await archivePrice(priceId);
  }
  return result;
}

/** The --image-url value (either spelling), or undefined. */
export function imageUrlArg(argv: string[]): string | undefined {
  const index = argv.indexOf("--image-url");
  if (index >= 0) return argv[index + 1];
  return argv.find((arg) => arg.startsWith("--image-url="))?.slice("--image-url=".length);
}

/** The repeated --archive-product prod_... values. */
export function archiveProductArgs(argv: string[]): string[] {
  const ids: string[] = [];
  argv.forEach((arg, index) => {
    const value = arg === "--archive-product" ? argv[index + 1] : arg.startsWith("--archive-product=") ? arg.slice("--archive-product=".length) : null;
    if (value === null) return;
    if (!value?.startsWith("prod_")) throw new Error(`--archive-product needs a prod_ id, got ${value}`);
    ids.push(value);
  });
  return ids;
}

async function main(): Promise<void> {
  const imageUrl = imageUrlArg(process.argv);
  const setup = planStripeSetup(imageUrl === undefined ? process.env : { ...process.env, FRONT_OFFICE_PRODUCT_IMAGE_URL: imageUrl });
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const create = process.argv.includes("--create");
  const archiveProducts = archiveProductArgs(process.argv);
  const live = /^(sk|rk)_live_/.test(key);
  console.log(`${key ? (live ? "LIVE" : "test") : "no key"} mode · ${create ? "CREATE" : "dry run"}`);
  for (const product of setup.products) console.log(`Product: ${product.name} · ${product.description}${product.image ? ` · image ${product.image}` : ""} (metadata ${PRODUCT_METADATA_KEY}=${product.key})`);
  for (const price of setup.prices) console.log(price.kind === "plan"
    ? `Price: ${price.label} $${(price.unitAmount / 100).toFixed(2)}/month, ${price.includedCalls} answered calls · lookup_key ${price.lookupKey}`
    : `Add-on: ${price.label} +$${(price.unitAmount / 100).toFixed(2)}/month, fair use ${price.includedCalls} calls · lookup_key ${price.lookupKey}`);
  console.log(`Coupon: ${setup.coupon.id} · ${setup.coupon.percentOff}% off, duration once`);
  if (create && !key) throw new Error("Set STRIPE_SECRET_KEY");
  if (create && live && !process.argv.includes("--live")) throw new Error("This is a live key. Add --live if you really mean to change live Stripe.");
  if (!key) {
    console.log("Dry run. Set STRIPE_SECRET_KEY to see what already exists, and pass --create to make the changes.");
    console.log(`\nThe env vars it will print:\n${[...setup.prices.map((price) => `${price.envName}=price_...`), "STRIPE_PRICE_ID=price_... (the Solo price)", `STRIPE_FIRST_MONTH_COUPON_ID=${setup.coupon.id}`, `STRIPE_FIRST_MONTH_PERCENT_OFF=${setup.coupon.percentOff}`].join("\n")}`);
    return;
  }

  const stripe: StripeCall = async (method, path, body, idempotencyKey) => {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      ...(body ? { body } : {}),
    });
    const json = await response.json().catch(() => ({})) as Json;
    // Only a GET may miss (a coupon or product that isn't there yet); any failed write stops the run.
    if (!response.ok && !(method === "GET" && response.status === 404)) throw new Error(`Stripe ${method} /${path.split("?")[0]} failed with HTTP ${response.status}: ${json.error?.message ?? "unknown error"}`);
    return { status: response.status, json };
  };

  // Every price id the app is configured with right now: never archived by this run.
  const inUse = Object.entries(process.env).filter(([name, value]) => /^STRIPE_.*PRICE_ID/.test(name) && value?.startsWith("price_")).map(([, value]) => value!);
  await reconcileStripePlans(setup, stripe, { create, archiveProducts, inUse });
  if (!create) console.log("\nDry run: nothing changed. Pass --create (and --live for a live key) to make these changes.");
}

if (isDirectRun(import.meta.url, process.argv[1])) await main();
