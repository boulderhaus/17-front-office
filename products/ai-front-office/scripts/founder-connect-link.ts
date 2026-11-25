import { founderConnectToken } from "../src/domain/founder-booking.js";

/**
 * Prints a link that opens Google sign-in to connect one of the founder's calendars for setup calls, with no admin
 * session needed. It works for 24 hours (or --hours N, at most 24). Run with the server's env, e.g.
 *   railway run node --import tsx scripts/founder-connect-link.ts
 * Prints only the URL.
 */
const key = process.env.SESSION_SIGNING_KEY;
const base = process.env.PUBLIC_BASE_URL;
if (!key || key.length < 32) throw new Error("SESSION_SIGNING_KEY is required (the server's value)");
if (!base || !/^https?:\/\//.test(base)) throw new Error("PUBLIC_BASE_URL is required");
const hoursIndex = process.argv.indexOf("--hours");
const hours = hoursIndex >= 0 ? Number(process.argv[hoursIndex + 1]) : 24;
if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error("--hours must be between 0 and 24");
const token = founderConnectToken(key, new Date(), hours * 60 * 60_000);
console.log(`${base.replace(/\/$/, "")}/admin/founder-calendars/connect?k=${encodeURIComponent(token)}`);
