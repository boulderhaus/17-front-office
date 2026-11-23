import { randomBytes } from "node:crypto";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:8787"),
  DEFAULT_TENANT_ID: z.string().min(1).default("demo"),
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
  TELNYX_MESSAGING_APPROVED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
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
  FOUNDER_WELCOME_TEMPLATE: z.string().max(500).default("Welcome to Front Office. I'm {founder_name}. This is my number if you need anything or have an idea for making this more useful for {business_name}. Reply STOP to opt out."),
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
  STRIPE_DAILY_SMS_PRICE_ID: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("price_").optional()),
  STRIPE_REALTIME_SMS_PRICE_ID: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("price_").optional()),
  RESEND_API_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("re_").optional()),
  RESEND_FROM_EMAIL: z.preprocess((value) => value === "" ? undefined : value, z.string().email().optional()),
});

export type Environment = z.infer<typeof schema>;

export function loadEnvironment(values: NodeJS.ProcessEnv): Environment {
  const parsed = schema.parse(values);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: parsed.DEFAULT_TIMEZONE }).format();
  } catch {
    throw new Error("DEFAULT_TIMEZONE must be a valid IANA timezone");
  }
  if (parsed.ADMIN_TOKEN === parsed.TOOL_TOKEN) throw new Error("ADMIN_TOKEN and TOOL_TOKEN must be different");
  if (parsed.SESSION_SIGNING_KEY && (parsed.SESSION_SIGNING_KEY === parsed.ADMIN_TOKEN || parsed.SESSION_SIGNING_KEY === parsed.TOOL_TOKEN)) {
    throw new Error("SESSION_SIGNING_KEY must be distinct from ADMIN_TOKEN and TOOL_TOKEN");
  }
  const stripeValues = [parsed.STRIPE_SECRET_KEY, parsed.STRIPE_WEBHOOK_SECRET, parsed.STRIPE_PRICE_ID].filter(Boolean).length;
  if (stripeValues !== 0 && stripeValues !== 3) throw new Error("STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_PRICE_ID must be configured together");
  if ((parsed.STRIPE_DAILY_SMS_PRICE_ID || parsed.STRIPE_REALTIME_SMS_PRICE_ID) && stripeValues !== 3) {
    throw new Error("Stripe add-on prices require the base Stripe configuration");
  }
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
