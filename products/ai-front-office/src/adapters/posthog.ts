import { PostHog } from "posthog-node";
import type { Environment } from "../config/environment.js";
import { redactError } from "../application/retry.js";

/**
 * Product analytics and error tracking. Everything is a no-op without POSTHOG_KEY.
 *
 * Privacy contract: server events carry the opaque tenant id and a small set of
 * allowlisted, non-identifying properties. Caller names, phone numbers, addresses,
 * emails and transcript text are never sent: unknown keys are dropped and string
 * values that look like contact details are removed before anything is queued.
 */
export type ServerEvent =
  | "owner_signed_up"
  | "go_live_attempted"
  | "go_live_result"
  | "call_finalized"
  | "checkout_started"
  | "checkout_completed"
  | "onboarding_completed"
  | "subscription_status_changed";

export type SafeValue = string | number | boolean | null;

export interface Telemetry {
  readonly enabled: boolean;
  /** `distinctId` is an opaque account id or tenant id, never an email or phone. */
  capture(event: ServerEvent, distinctId: string, tenantId: string | null, properties?: Record<string, unknown>): void;
  /** `route` is a route key or background job name, e.g. "owner:api" or "job:outbox". */
  captureException(error: unknown, context: { route: string; method?: string; status?: number; requestId?: string; tenantId?: string }): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export const noopTelemetry: Telemetry = {
  enabled: false,
  capture: () => undefined,
  captureException: () => undefined,
  flush: async () => undefined,
  shutdown: async () => undefined,
};

/** The only property keys a server event may carry. */
const ALLOWED_PROPERTIES = new Set([
  "tenant_id",
  "operation_mode",
  "result",
  "http_status",
  "outcome",
  "emergency",
  "duration_seconds",
  "consent_state",
  "billing_disposition",
  "channel",
  "status",
  "stripe_event_type",
  "route",
  "method",
  "request_id",
]);

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
// US numbers in any common format, plus E.164. Boundaries keep uuid and timestamp digits intact.
const PHONE = /(?<![\w-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])|\+\d{8,15}\b/g;
const CONTACT_PATTERNS = [EMAIL, PHONE];

export function looksLikeContactDetail(value: string): boolean {
  return CONTACT_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

/** Keeps only allowlisted keys with short, non-identifying scalar values. */
export function sanitizeProperties(properties: Record<string, unknown>): Record<string, SafeValue> {
  const safe: Record<string, SafeValue> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!ALLOWED_PROPERTIES.has(key)) continue;
    if (value === null || typeof value === "boolean") safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    // Ids (uuids, shop_<uuid>) are safe; free text longer than a short code is not.
    else if (typeof value === "string" && value.length <= 80 && (key === "tenant_id" || key === "request_id" || !looksLikeContactDetail(value))) safe[key] = value;
  }
  return safe;
}

/** Strips contact details from free text such as an exception message. */
export function redactContactDetails(value: string): string {
  return CONTACT_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactContactDetails(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, depth + 1)]));
}

function sanitizedError(error: unknown): Error {
  const source = error instanceof Error ? error : new Error("Non-error thrown");
  const message = redactContactDetails(redactError(source));
  const copy = new Error(message);
  copy.name = source.name;
  const frames = source.stack?.split("\n").filter((line) => /^\s+at /.test(line)) ?? [];
  copy.stack = [`${source.name}: ${message}`, ...frames].join("\n");
  return copy;
}

export interface TelemetryOptions {
  /** Outbound HTTP; tests inject a fake. */
  fetch?: (url: string, options: { method: string; headers: Record<string, string>; body?: unknown }) => Promise<{ status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;
  flushAt?: number;
}

export function createTelemetry(env: Pick<Environment, "POSTHOG_KEY" | "POSTHOG_HOST" | "NODE_ENV">, options: TelemetryOptions = {}): Telemetry {
  if (!env.POSTHOG_KEY) return noopTelemetry;
  const client = new PostHog(env.POSTHOG_KEY, {
    host: env.POSTHOG_HOST,
    flushAt: options.flushAt ?? 20,
    flushInterval: 10_000,
    // Uncaught exceptions and unhandled rejections outside a request.
    enableExceptionAutocapture: true,
    ...(options.fetch ? { fetch: options.fetch as never, disableCompression: true } : {}),
    // Autocaptured exceptions bypass sanitizedError(), and stack frames carry source lines:
    // redact contact details from every string in an exception event.
    before_send: (event) => (event?.event === "$exception" && event.properties ? { ...event, properties: redactDeep(event.properties) as Record<string, unknown> } : event),
  });
  return {
    enabled: true,
    capture(event, distinctId, tenantId, properties = {}) {
      // Only opaque ids ever become a PostHog identity.
      const opaque = (value: string | null | undefined) => typeof value === "string" && /^[A-Za-z0-9_:.-]{1,80}$/.test(value) && !looksLikeContactDetail(value);
      if (!opaque(distinctId) || (tenantId && !opaque(tenantId))) return;
      client.capture({
        distinctId,
        event,
        properties: {
          ...sanitizeProperties({ ...properties, tenant_id: tenantId }),
          environment: env.NODE_ENV,
          // Tenant-level events must not create a person per shop.
          ...(distinctId === tenantId ? { $process_person_profile: false } : {}),
        },
        ...(tenantId ? { groups: { tenant: tenantId } } : {}),
      });
    },
    captureException(error, context) {
      const { route, method, status, requestId, tenantId } = context;
      client.captureException(sanitizedError(error), undefined, {
        ...sanitizeProperties({ route, method, http_status: status, request_id: requestId, tenant_id: tenantId }),
        environment: env.NODE_ENV,
      });
    },
    flush: () => client.flush(),
    shutdown: () => client.shutdown(5_000),
  };
}
