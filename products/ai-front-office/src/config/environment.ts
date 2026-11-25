import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DEFAULT_TELNYX_VOICE } from "../voice/system-prompt.js";
import { validVapidKeys } from "../adapters/web-push.js";
import { parseBookingWindows } from "../domain/founder-booking.js";

export { DEFAULT_TELNYX_VOICE };

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:8787"),
  DEFAULT_TENANT_ID: z.string().min(1).default("demo"),
  /**
   * The public demo line (anyone may call it to hear Call Otto). It keeps answering outside provider test mode
   * without the paid/readiness gate, and never texts, emails or calls anyone. Only a tenant with no owner account
   * qualifies, so a real shop can never be exempted by mistake.
   */
  PUBLIC_DEMO_TENANT_ID: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).max(100).optional()),
  DEFAULT_BUSINESS_NAME: z.string().min(1).max(120).default("Your Service Business"),
  DEFAULT_TIMEZONE: z.string().min(1).default("America/Chicago"),
  DEMO_MODE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  PROVIDER_TEST_MODE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  LIVE_PROVIDER_PROOF_AT: z.preprocess((value) => value === "" ? undefined : value, z.string().datetime({ offset: true }).optional()),
  DATABASE_URL: z.string().optional(),
  DATA_ENCRYPTION_KEY: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().refine((value) => Buffer.from(value, "base64").length === 32, "DATA_ENCRYPTION_KEY must decode to exactly 32 bytes").optional(),
  ),
  ADMIN_TOKEN: z.string().min(20),
  TOOL_TOKEN: z.string().min(20),
  SESSION_SIGNING_KEY: z.string().min(32).optional(),
  TELNYX_API_KEY: z.string().optional(),
  TELNYX_PUBLIC_KEY: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().refine((value) => Buffer.from(value, "base64").length === 32, "TELNYX_PUBLIC_KEY must decode to exactly 32 bytes").optional(),
  ),
  TELNYX_FROM_NUMBER: z.string().optional(),
  TELNYX_MESSAGING_PROFILE_ID: z.string().uuid().optional(),
  TELNYX_ASSISTANT_ID: z.string().min(1).optional(),
  TELNYX_TEMPLATE_ASSISTANT_ID: z.string().min(1).optional(),
  TELNYX_CAMPAIGN_ID: z.string().min(1).optional(),
  /** Call Control connection used for the owner's one-tap forwarding check call. Without it, owners test by calling themselves. */
  TELNYX_CHECK_CONNECTION_ID: z.string().min(1).optional(),
  /**
   * Voice for every assistant we create or push (voice_settings.voice). The voice lab (research/voice-lab)
   * left the timbre to the founder, so the default stays the current Ultra voice. Never turn on
   * expressive_mode: it leaks <break> tags into transcripts.
   */
  TELNYX_VOICE: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).default(DEFAULT_TELNYX_VOICE)),
  /**
   * Shared TeXML app (scripts/configure-voicemail-app.ts) that answers a lapsed shop's number with
   * a voicemail for 30 days instead of disconnecting it. Without it, a billing lapse disconnects.
   */
  TELNYX_VOICEMAIL_APP_ID: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  TELNYX_MESSAGING_APPROVED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  /**
   * Telnyx Inbound Call Screening on shop numbers. "flag" (default) labels likely spam and still lets it
   * reach the assistant, which checks intent sooner. "reject" drops it at the carrier with no record or
   * alert, so a forwarded or new-mobile emergency caller could be lost; opt in only deliberately.
   */
  CALL_SCREENING_MODE: z.preprocess((value) => value === "" ? undefined : value, z.enum(["flag", "reject", "off"]).default("flag")),
  FOUNDER_WELCOME_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  SUPPORT_EMAIL: z.preprocess((value) => value === "" ? undefined : value, z.string().email().optional()),
  // Owner-facing controls stay hidden until each capability passes live acceptance.
  DIRECT_BOOKING_BETA: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  WARM_TRANSFER_BETA: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  FOUNDER_WELCOME_FROM_NUMBER: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().regex(/^\+[1-9]\d{7,14}$/, "FOUNDER_WELCOME_FROM_NUMBER must use E.164 format").optional(),
  ),
  FOUNDER_WELCOME_NAME: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).max(80).optional()),
  FOUNDER_WELCOME_TEMPLATE: z.string().max(500).default("Welcome to Call Otto. I'm {founder_name}. This is my number if you need anything or have an idea for making this more useful for {business_name}. Reply STOP to opt out."),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // A second OAuth client for migrating projects; existing tokens keep their own client.
  GOOGLE_CLIENT_ID_NEXT: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  GOOGLE_CLIENT_SECRET_NEXT: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  GOOGLE_OAUTH_NEW_CONNECTIONS: z.enum(["legacy", "next"]).default("legacy"),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default("primary"),
  OWNER_DESTINATIONS_JSON: z.string().default("{}"),
  FOUNDING_CHECKOUT_URL: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().url().refine((value) => value.startsWith("https://"), "FOUNDING_CHECKOUT_URL must use HTTPS").optional(),
  ),
  STRIPE_SECRET_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().min(20).optional()),
  STRIPE_WEBHOOK_SECRET: z.preprocess((value) => value === "" ? undefined : value, z.string().min(20).optional()),
  STRIPE_PRICE_ID: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("price_").optional()),
  /** Pro plan, old name. Used when STRIPE_PRICE_ID_PRO is unset. Pro is no longer sold; its prices stay recognized. */
  STRIPE_PRICE_ID_PLUS: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("price_").optional()),
  /** The monthly plan prices (scripts/create-stripe-plans.ts). Solo falls back to STRIPE_PRICE_ID. Pro is legacy (recognized, never sold) and falls back to STRIPE_PRICE_ID_PLUS. A plan without a price isn't sold. */
  STRIPE_PRICE_ID_SOLO: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("price_").optional()),
  STRIPE_PRICE_ID_PRO: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("price_").optional()),
  STRIPE_PRICE_ID_TEAM: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("price_").optional()),
  STRIPE_PRICE_ID_FLEET: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("price_").optional()),
  /** The Unlimited calls add-on, one monthly price per plan (a second subscription item). Unset: that plan doesn't offer it. */
  STRIPE_PRICE_ID_UNLIMITED_SOLO: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("price_").optional()),
  STRIPE_PRICE_ID_UNLIMITED_TEAM: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("price_").optional()),
  STRIPE_PRICE_ID_UNLIMITED_FLEET: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("price_").optional()),
  /** Coupon applied once at checkout (50% off, duration once): "first month half off". Created by scripts/create-stripe-plans.ts. */
  STRIPE_FIRST_MONTH_COUPON_ID: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional()),
  /** Limited-time switch for the first-month offer. false: no coupon at checkout and no "half off" copy anywhere. */
  FIRST_MONTH_OFFER_ENABLED: z.preprocess((value) => value === "" ? undefined : value, z.enum(["true", "false"]).default("true").transform((value) => value === "true")),
  /** Percent the first-month coupon takes off, for the prices shown on our pages. Must match the coupon. */
  STRIPE_FIRST_MONTH_PERCENT_OFF: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(1).max(100).default(50)),
  /** Free days before the first charge. Hard paywall by default (0): the card is charged at checkout. */
  STRIPE_TRIAL_DAYS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(0).max(90).default(0)),
  /** What each plan is called, costs and includes, shown on the homepage, card step and Settings. Must match the Stripe prices. */
  PLAN_SOLO_LABEL: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).max(40).default("Solo")),
  PLAN_SOLO_PRICE_CENTS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(100).max(1_000_000).default(4_999)),
  PLAN_SOLO_CALLS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(1).max(100_000).default(60)),
  PLAN_PRO_LABEL: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).max(40).default("Pro")),
  PLAN_PRO_PRICE_CENTS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(100).max(1_000_000).default(9_999)),
  PLAN_PRO_CALLS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(1).max(100_000).default(125)),
  PLAN_TEAM_LABEL: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).max(40).default("Team")),
  PLAN_TEAM_PRICE_CENTS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(100).max(1_000_000).default(17_999)),
  PLAN_TEAM_CALLS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(1).max(100_000).default(250)),
  PLAN_FLEET_LABEL: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).max(40).default("Fleet")),
  PLAN_FLEET_PRICE_CENTS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(100).max(1_000_000).default(34_999)),
  PLAN_FLEET_CALLS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(1).max(100_000).default(500)),
  /** What the Unlimited add-on adds to each plan per month. Must match the STRIPE_PRICE_ID_UNLIMITED_* prices. */
  PLAN_SOLO_UNLIMITED_CENTS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(100).max(1_000_000).default(5_000)),
  PLAN_TEAM_UNLIMITED_CENTS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(100).max(1_000_000).default(7_500)),
  PLAN_FLEET_UNLIMITED_CENTS: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(100).max(1_000_000).default(12_500)),
  /** Each answered call past the plan's included calls, billed at the end of the billing period. */
  OVERAGE_CENTS_PER_CALL: z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().min(0).max(1_000).default(75)),
  /** Web push for owner call alerts (scripts/generate-vapid-keys.ts). Both or neither; unset hides "Turn on call alerts". */
  VAPID_PUBLIC_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^[A-Za-z0-9_-]{87}$/, "VAPID_PUBLIC_KEY must be a base64url P-256 public key").optional()),
  VAPID_PRIVATE_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^[A-Za-z0-9_-]{43}$/, "VAPID_PRIVATE_KEY must be a base64url P-256 private key").optional()),
  VAPID_SUBJECT: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^(mailto:\S+@\S+|https:\/\/\S+)$/).default("mailto:hello@bydutchworks.com")),
  RESEND_API_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("re_").optional()),
  RESEND_FROM_EMAIL: z.preprocess((value) => value === "" ? undefined : value, z.string().email().optional()),
  /** Display name on owner emails: "Call Otto <hello@callotto.co>". No angle brackets or quotes, so it cannot break the header. */
  RESEND_FROM_NAME: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).max(60).regex(/^[^<>"\r\n]+$/, "RESEND_FROM_NAME must be plain text").default("Call Otto")),
  /**
   * Brock's follow-up when the AI setup helper can't finish: sent as "Brock from Call Otto" from this address
   * (default brock@ + the domain of RESEND_FROM_EMAIL), replies to FOUNDER_REPLY_TO (default SUPPORT_EMAIL).
   */
  FOUNDER_FROM_EMAIL: z.preprocess((value) => value === "" ? undefined : value, z.string().email().optional()),
  FOUNDER_REPLY_TO: z.preprocess((value) => value === "" ? undefined : value, z.string().email().optional()),
  /** When owners may book a 10-minute setup call with Brock, in FOUNDER_TIMEZONE: "Mon-Fri 10:00-12:00,14:00-17:00". */
  FOUNDER_BOOKING_WINDOWS: z.preprocess((value) => value === "" ? undefined : value, z.string().max(300).default("Mon-Fri 10:00-12:00,14:00-17:00")),
  FOUNDER_TIMEZONE: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).default("America/New_York")),
  // Product analytics + error tracking. Unset = everything off (tests, local).
  POSTHOG_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^phc_[A-Za-z0-9_-]{8,}$/, "POSTHOG_KEY must be a PostHog project API key (phc_...)").optional()),
  // Only PostHog Cloud ingestion hosts: the /ingest proxy forwards here, so it must never be arbitrary.
  POSTHOG_HOST: z.preprocess((value) => value === "" ? undefined : typeof value === "string" ? value.replace(/\/$/, "") : value, z.enum(["https://us.i.posthog.com", "https://eu.i.posthog.com"]).default("https://us.i.posthog.com")),
});

export type Environment = z.infer<typeof schema>;

export function loadEnvironment(values: NodeJS.ProcessEnv): Environment {
  const parsed = schema.parse(values);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: parsed.DEFAULT_TIMEZONE }).format();
  } catch {
    throw new Error("DEFAULT_TIMEZONE must be a valid IANA timezone");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: parsed.FOUNDER_TIMEZONE }).format();
  } catch {
    throw new Error("FOUNDER_TIMEZONE must be a valid IANA timezone");
  }
  parseBookingWindows(parsed.FOUNDER_BOOKING_WINDOWS);
  if (parsed.ADMIN_TOKEN === parsed.TOOL_TOKEN) throw new Error("ADMIN_TOKEN and TOOL_TOKEN must be different");
  if (parsed.SESSION_SIGNING_KEY && (parsed.SESSION_SIGNING_KEY === parsed.ADMIN_TOKEN || parsed.SESSION_SIGNING_KEY === parsed.TOOL_TOKEN)) {
    throw new Error("SESSION_SIGNING_KEY must be distinct from ADMIN_TOKEN and TOOL_TOKEN");
  }
  const stripeValues = [parsed.STRIPE_SECRET_KEY, parsed.STRIPE_WEBHOOK_SECRET, parsed.STRIPE_PRICE_ID_SOLO ?? parsed.STRIPE_PRICE_ID].filter(Boolean).length;
  if (stripeValues !== 0 && stripeValues !== 3) throw new Error("STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_PRICE_ID_SOLO (or STRIPE_PRICE_ID) must be configured together");
  if ((parsed.STRIPE_PRICE_ID_PLUS || parsed.STRIPE_PRICE_ID_PRO || parsed.STRIPE_PRICE_ID_TEAM || parsed.STRIPE_PRICE_ID_FLEET || parsed.STRIPE_PRICE_ID_UNLIMITED_SOLO || parsed.STRIPE_PRICE_ID_UNLIMITED_TEAM || parsed.STRIPE_PRICE_ID_UNLIMITED_FLEET || parsed.STRIPE_FIRST_MONTH_COUPON_ID) && stripeValues !== 3) {
    throw new Error("The Unlimited add-on prices, the bigger plans and the first-month coupon require the base Stripe configuration");
  }
  if (Boolean(parsed.VAPID_PUBLIC_KEY) !== Boolean(parsed.VAPID_PRIVATE_KEY)) throw new Error("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured together");
  if (parsed.VAPID_PUBLIC_KEY && parsed.VAPID_PRIVATE_KEY && !validVapidKeys(parsed.VAPID_PUBLIC_KEY, parsed.VAPID_PRIVATE_KEY)) throw new Error("VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY");
  if (Boolean(parsed.RESEND_API_KEY) !== Boolean(parsed.RESEND_FROM_EMAIL)) {
    throw new Error("RESEND_API_KEY and RESEND_FROM_EMAIL must be configured together");
  }
  if (parsed.GOOGLE_OAUTH_NEW_CONNECTIONS === "next" && !(parsed.GOOGLE_CLIENT_ID_NEXT && parsed.GOOGLE_CLIENT_SECRET_NEXT)) {
    throw new Error("GOOGLE_OAUTH_NEW_CONNECTIONS=next requires GOOGLE_CLIENT_ID_NEXT and GOOGLE_CLIENT_SECRET_NEXT");
  }
  if (!parsed.DEMO_MODE) {
    for (const key of ["DATABASE_URL", "DATA_ENCRYPTION_KEY", "SESSION_SIGNING_KEY"] as const) {
      if (!parsed[key]) throw new Error(`${key} is required outside demo mode`);
    }
    if (parsed.TELNYX_FROM_NUMBER && !/^\+[1-9]\d{7,14}$/.test(parsed.TELNYX_FROM_NUMBER)) throw new Error("TELNYX_FROM_NUMBER must use E.164 format");
    if (!parsed.PUBLIC_BASE_URL.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must use HTTPS outside demo mode");
    parseOwnerDestinations(parsed.OWNER_DESTINATIONS_JSON, false);
    if (parsed.PROVIDER_TEST_MODE && !hasProviderTestConfiguration(parsed)) {
      throw new Error("PROVIDER_TEST_MODE requires Telnyx voice/SMS, Google, sender, and owner destination configuration");
    }
  }
  return parsed;
}

/** Who Brock's follow-up emails come from and where replies go. Null when email isn't set up. */
export function founderEmailSender(env: Environment): { from: string; replyTo: string | null } | null {
  const domain = env.RESEND_FROM_EMAIL?.split("@")[1];
  const address = env.FOUNDER_FROM_EMAIL ?? (domain ? `brock@${domain}` : null);
  if (!address) return null;
  return { from: `${FOUNDER_FROM_NAME} <${address}>`, replyTo: env.FOUNDER_REPLY_TO ?? env.SUPPORT_EMAIL ?? null };
}

export const FOUNDER_FROM_NAME = "Brock from Call Otto";

function hasProviderTestConfiguration(env: Environment): boolean {
  return Boolean(
    env.TELNYX_API_KEY
    && env.TELNYX_PUBLIC_KEY
    && env.TELNYX_FROM_NUMBER
    && env.TELNYX_MESSAGING_PROFILE_ID
    && env.TELNYX_ASSISTANT_ID
    && env.GOOGLE_CLIENT_ID
    && env.GOOGLE_CLIENT_SECRET
    && Object.keys(parseOwnerDestinations(env.OWNER_DESTINATIONS_JSON, false)).length > 0,
  );
}

export function parseOwnerDestinations(value: string, requireAtLeastOne: boolean): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("OWNER_DESTINATIONS_JSON must be valid JSON");
  }
  const destinations = z.record(z.string().min(1), z.string().regex(/^\+[1-9]\d{7,14}$/, "Owner numbers must use E.164 format")).parse(parsed);
  if (requireAtLeastOne && Object.keys(destinations).length === 0) throw new Error("OWNER_DESTINATIONS_JSON must configure at least one owner number");
  return destinations;
}

export function demoEnvironment(overrides: Partial<NodeJS.ProcessEnv> = {}): Environment {
  return loadEnvironment({
    NODE_ENV: "development",
    DEMO_MODE: "true",
    ADMIN_TOKEN: randomBytes(24).toString("base64url"),
    TOOL_TOKEN: randomBytes(24).toString("base64url"),
    SESSION_SIGNING_KEY: randomBytes(32).toString("base64url"),
    ...overrides,
  });
}
