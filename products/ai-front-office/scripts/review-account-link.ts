import { reviewAccountToken } from "../src/application/review-account.js";

/**
 * Prints a link that makes the Google OAuth review account (reviewer@callotto.co), or gives it a new password, and
 * shows the password once. No admin session needed. It works for 24 hours (or --hours N, at most 24). Run with the
 * server's env, e.g.
 *   railway run node --import tsx scripts/review-account-link.ts
 * Prints only the URL. Open it in a browser (chat-app link previews are ignored); opening it again makes a new password.
 */
const key = process.env.SESSION_SIGNING_KEY;
const base = process.env.PUBLIC_BASE_URL;
if (!key || key.length < 32) throw new Error("SESSION_SIGNING_KEY is required (the server's value)");
if (!base || !/^https?:\/\//.test(base)) throw new Error("PUBLIC_BASE_URL is required");
const hoursIndex = process.argv.indexOf("--hours");
const hours = hoursIndex >= 0 ? Number(process.argv[hoursIndex + 1]) : 24;
if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error("--hours must be between 0 and 24");
const token = reviewAccountToken(key, new Date(), hours * 60 * 60_000);
console.log(`${base.replace(/\/$/, "")}/admin/review-account?k=${encodeURIComponent(token)}`);
