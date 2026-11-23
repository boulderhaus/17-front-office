/**
 * Creates the "first month half off" coupon (50% off, duration once) and prints the id to set as
 * STRIPE_FIRST_MONTH_COUPON_ID. Dry run by default: pass --create to actually call Stripe.
 *
 *   STRIPE_SECRET_KEY=sk_test_... node --import tsx scripts/create-first-month-coupon.ts --create
 *
 * A live key (sk_live_ / rk_live_) also needs --live, so it is never created against live Stripe by accident.
 */
const key = process.env.STRIPE_SECRET_KEY ?? "";
const percentOff = Number(process.env.STRIPE_FIRST_MONTH_PERCENT_OFF ?? "50");
const create = process.argv.includes("--create");
const live = /^(sk|rk)_live_/.test(key);
const body = new URLSearchParams({
  percent_off: String(percentOff),
  duration: "once",
  name: `First month ${percentOff}% off`,
  "metadata[front_office]": "first_month",
});

if (!key) throw new Error("Set STRIPE_SECRET_KEY");
if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) throw new Error("STRIPE_FIRST_MONTH_PERCENT_OFF must be 1-100");
console.log(`${live ? "LIVE" : "test"} mode · POST /v1/coupons ${body.toString()}`);
if (!create) {
  console.log("Dry run. Pass --create to create it.");
  process.exit(0);
}
if (live && !process.argv.includes("--live")) throw new Error("This is a live key. Add --live if you really mean to create the coupon in live Stripe.");
const response = await fetch("https://api.stripe.com/v1/coupons", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": `front-office-first-month-${percentOff}` },
  body,
});
const coupon = await response.json() as { id?: string; error?: { message?: string } };
if (!response.ok || !coupon.id) throw new Error(`Stripe coupon failed with HTTP ${response.status}: ${coupon.error?.message ?? "unknown error"}`);
console.log(`STRIPE_FIRST_MONTH_COUPON_ID=${coupon.id}`);
