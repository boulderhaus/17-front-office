import type { CaptureResult, PostHog } from "posthog-js"

/**
 * PostHog for the owner app. Off unless the server put a project key in the page
 * (POSTHOG_KEY), so local dev and the static build send nothing.
 *
 * Callers' details never leave the browser:
 * - the call screens render inside `ph-no-capture` (replay shows a blank box, autocapture skips them);
 * - autocapture keeps no element text or attributes (tel: links, aria-labels with names);
 * - every input is masked in replay; console logs and network bodies are not recorded;
 * - a last-line filter strips anything shaped like an email or phone number from event properties.
 *
 * The SDK is a separate chunk, fetched only when analytics is on.
 */

const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g
const PHONE = /(?<![\w-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])|\+\d{8,15}\b/g

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.replace(EMAIL, "[REDACTED]").replace(PHONE, "[REDACTED]")
  if (depth > 6 || value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, depth + 1)]))
}

function beforeSend(event: CaptureResult | null): CaptureResult | null {
  // Replay snapshots are already masked/blocked at record time.
  if (!event || event.event === "$snapshot") return event
  return { ...event, properties: scrub(event.properties) as CaptureResult["properties"] }
}

let client: Promise<PostHog> | null = null

export function startAnalytics(): void {
  const key = document.querySelector('meta[name="posthog-key"]')?.getAttribute("content")
  if (!key || client) return
  const preview = window.location.pathname.startsWith("/demo")
  client = import("posthog-js").then(({ default: posthog }) => {
    posthog.init(key, {
      api_host: "/ingest",
      ui_host: document.querySelector('meta[name="posthog-ui-host"]')?.getAttribute("content") ?? "https://us.posthog.com",
      defaults: "2026-01-30",
      capture_pageview: "history_change",
      capture_pageleave: true,
      // Anonymous demo visitors get no cookies or storage; signed-in owners keep one id across visits.
      persistence: preview ? "memory" : "localStorage",
      person_profiles: "identified_only",
      autocapture: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      capture_exceptions: true,
      disable_surveys: true,
      enable_recording_console_log: false,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: ".ph-mask",
        recordHeaders: false,
        recordBody: false,
      },
      before_send: beforeSend,
    })
    return posthog
  })
}

/** Opaque ids only: the account id and the shop (tenant) id. Never an email or phone. */
export function identifyOwner(identity: { distinctId: string; tenantId: string } | undefined): void {
  if (!client || !identity) return
  void client.then((posthog) => {
    if (posthog.get_distinct_id() !== identity.distinctId) {
      // A different owner signed in on this device: start a fresh identity instead of merging.
      if (posthog.get_property("$user_state") === "identified") posthog.reset()
      posthog.identify(identity.distinctId)
    }
    posthog.group("tenant", identity.tenantId)
    posthog.register({ tenant_id: identity.tenantId })
  })
}
