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
  RETELL_API_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default("primary"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_USER: z.string().optional(),
  TWILIO_AUTH_SECRET: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  OWNER_DESTINATIONS_JSON: z.string().default("{}"),
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
  if (!parsed.DEMO_MODE) {
    for (const key of ["DATABASE_URL", "DATA_ENCRYPTION_KEY"] as const) {
      if (!parsed[key]) throw new Error(`${key} is required outside demo mode`);
    }
    if (parsed.TWILIO_FROM_NUMBER && !/^\+[1-9]\d{7,14}$/.test(parsed.TWILIO_FROM_NUMBER)) throw new Error("TWILIO_FROM_NUMBER must use E.164 format");
    if (!parsed.PUBLIC_BASE_URL.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must use HTTPS outside demo mode");
    parseOwnerDestinations(parsed.OWNER_DESTINATIONS_JSON, false);
    if (parsed.PROVIDER_TEST_MODE && !hasProviderTestConfiguration(parsed)) {
      throw new Error("PROVIDER_TEST_MODE requires Retell, Google, Twilio, sender, and owner destination configuration");
    }
  }
  return parsed;
}

function hasProviderTestConfiguration(env: Environment): boolean {
  return Boolean(
    env.RETELL_API_KEY
    && env.GOOGLE_CLIENT_ID
    && env.GOOGLE_CLIENT_SECRET
    && env.TWILIO_ACCOUNT_SID
    && env.TWILIO_AUTH_SECRET
    && (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID)
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
    ...overrides,
  });
}
