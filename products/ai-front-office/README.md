# AI Front Office

A narrow, supervised AI receptionist for solo and 1–10-person home-service shops. It answers overflow/after-hours calls, performs deterministic emergency triage, captures a complete request, books only when the configured system of record proves the write, and routes owner updates through a durable multi-channel outbox.

## Honest status

The application is buildable, tested, containerized, and deployed to a fail-closed Railway staging service with isolated Postgres and public HTTPS. Owners can create an isolated account, enter their own hours/service area/rules, connect Google Calendar, work an automatically prioritized callback inbox, inspect usage and call evidence, and start checkout when Stripe is configured. Telnyx remains the voice, number, recording, webhook, and owner-alert provider. Each shop stays paused until its assistant route, calendar, owner destination, subscription, recording language, and live smoke matrix pass the activation gate.

## Product rules

- Default to after-hours coverage and owner-confirmation booking.
- Disclose that the caller is speaking to the owner's AI assistant.
- Never improvise a price, availability, service promise, or safety instruction.
- Life-safety, urgent, failed, and human-handoff calls bypass paid notification gates and alert the owner immediately.
- Routine instant lead texts cost $10/month; a daily SMS recap costs $5/month; a Sunday week-ahead email is included when enabled.
- A verified booking requires: calendar write/read-back, transcript, recording, complete intake, and diagnostic-fee acceptance when enabled. Customer confirmation SMS is an optional carrier-registered add-on, not a Solo-plan dependency.
- A failure becomes an owned callback with a due time; it never disappears behind a green status.
- Spam is neither billed nor pushed to the owner.
- Raw call data and notification destinations are encrypted at rest.

## Run locally

```bash
npm ci
npm run build
npm run check
npm run demo
npm run simulate:launch
```

The deterministic demo needs no external credentials. For the admin UI:

```bash
DEMO_MODE=true \
ADMIN_TOKEN='replace-with-20-plus-characters' \
TOOL_TOKEN='replace-with-another-20-plus-characters' \
PUBLIC_BASE_URL='http://127.0.0.1:8787' \
npm run dev
```

Open `http://127.0.0.1:8787/admin` and sign in with `ADMIN_TOKEN`.

## Production setup

1. Copy `.env.example` to a private environment store; never commit it.
2. Provision Postgres and run `npm run migrate` once.
3. Start the server with `npm start` or `docker compose up --build`.
4. Put the service behind public HTTPS and verify `/healthz` and `/readyz`. `/activationz` must remain `503` until real provider proof is recorded.
5. Configure `TELNYX_*`, run `npm run configure:telnyx` to inspect the generated update, then `npm run configure:telnyx -- --apply`. It installs the signed dynamic-variable/tool webhook, full-history end webhook, transfer, hangup, and dual-channel recording settings.
6. Connect Google Calendar through `/admin/config` or inject a refresh token server-side.
7. Configure named owner destinations and keep `TELNYX_MESSAGING_APPROVED=false` until the account and applicable US A2P campaign are approved.
8. Keep the service paused, run `npm run simulate:launch`, then use `PROVIDER_TEST_MODE=true` for the live smoke matrix in `docs/LAUNCH-CHECKLIST.md`.
9. Only after the live smoke matrix passes: record its ISO timestamp in `LIVE_PROVIDER_PROOF_AT`, disable provider-test mode, unpause, and require `/activationz=200` before forwarding the shop's line.
10. To sell self-serve subscriptions, run `node --import tsx scripts/create-stripe-plans.ts` (or `node dist/scripts/create-stripe-plans.js`; dry run; add `--create` to make the "Front Office" product, the Solo/Team/Fleet monthly prices and the three "Unlimited calls" add-on prices by lookup key, and the 50%-once coupon), then set the printed `STRIPE_PRICE_ID_SOLO/TEAM/FLEET`, `STRIPE_PRICE_ID_UNLIMITED_SOLO/TEAM/FLEET` and `STRIPE_FIRST_MONTH_COUPON_ID` with `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, and register `/webhooks/stripe`. Plans are priced by answered calls (not spam, 15 s or longer); `PLAN_<ID>_LABEL/PRICE_CENTS/CALLS` must match the Stripe prices. Extra calls (`OVERAGE_CENTS_PER_CALL`, default 75) are billed once after each period closes as their own invoice. Unlimited calls is a second subscription item (off by default, toggled at checkout or by the owner in Settings, prorated): while it is on, no extra calls are billed up to fair use (3× the plan's calls). Pro is no longer sold; subscriptions on a Pro price keep working. Hard paywall, no trial by default (`STRIPE_TRIAL_DAYS=0`); `FIRST_MONTH_OFFER_ENABLED=false` ends the limited-time half-off. Lead guarantee refunds: owner button on days 30–37 with zero real leads, support via `POST /admin/owners/<id>/lead-refund` (same check). Add `STRIPE_DAILY_SMS_PRICE_ID` and `STRIPE_REALTIME_SMS_PRICE_ID` before exposing those paid toggles.
11. To offer the included Sunday week-ahead email, configure `RESEND_API_KEY` and a verified `RESEND_FROM_EMAIL`. Summary enqueueing is tenant-timezone aware and idempotent.
12. Optional founder welcomes require explicit signup consent plus `FOUNDER_WELCOME_ENABLED=true`, an approved Telnyx sender in `FOUNDER_WELCOME_FROM_NUMBER`, and `FOUNDER_WELCOME_NAME`. A personal wireless number cannot be assumed to be an approved sender.
13. Analytics and error tracking (PostHog) turn on with `POSTHOG_KEY` (project API key, `phc_...`) and optional `POSTHOG_HOST` (`https://us.i.posthog.com` default, or EU). Browsers reach PostHog only through `/ingest` on this server, so the CSP stays `'self'`. Server events carry the opaque tenant id only: `owner_signed_up`, `go_live_attempted`/`go_live_result`, `call_finalized`, `checkout_started`/`checkout_completed`, `subscription_status_changed`, plus `$exception` for 5xx responses, background-job failures and uncaught errors. Caller screens are `ph-no-capture` in replay. In PostHog: keep "Capture network body/headers" and "Capture console logs" off, turn on session replay and exception autocapture, add an Error tracking "Issue created or reopened" notification and a spike alert, and add trend alerts on `$exception`, `go_live_result` with `result != live`, and `call_finalized` volume dropping to zero.

## Architecture

```text
caller -> Telnyx number/assistant -> Ed25519-signed webhook + tools
                         -> deterministic triage
                         -> confirm mode OR Google booking + read-back
                         -> encrypted Postgres record + callback task
                         -> durable idempotent outbox -> Telnyx SMS / Resend email
                         -> isolated owner account, usage meter, and evidence surface
```

The application ports isolate the voice provider, calendar/system of record, notification sender, clock, and durable store. External calls have timeouts and bounded retries. Webhooks and notification creation are locally deduplicated; interrupted sends are re-queued; ambiguous calendar outcomes fail closed.

## Known limitations

- Staging is live at `https://ai-front-office-production.up.railway.app`; `/activationz` remains `503` until every live gate passes. A Telnyx number and assistant exist, but no production call, compliant SMS campaign, transfer, or Google write is claimed until the smoke evidence is recorded.
- Jobber write operations are not implemented. Do not guess its GraphQL mutations; validate them in the registered app's versioned GraphiQL schema first.
- Housecall Pro is not implemented.
- Legal recording/consent language is configurable but must be reviewed for every launch jurisdiction.
- Telnyx transfer and interruption quality still require real calls. Every failed transfer retains the owner alert and callback task.
- Telnyx Messages receives the outbox notification UUID as its API idempotency key; delivery status and STOP/compliance behavior still require a provisioned, approved sender test.
- Coverage schedules and ring-delay/overflow routing must also be configured on the Telnyx number or upstream carrier; the admin mode records the desired policy but cannot force upstream forwarding.
- Stripe Checkout and signed subscription webhooks are implemented but remain hidden until credentials and the production price are configured. Usage is measured per connected call with provider-style minute rounding; hard cutoffs and automatic overage invoicing are intentionally not enabled yet.

The service is paused by default. The authenticated admin provides **Readiness**, **Simulator**, configuration, call history, and permanent call deletion; public `/privacy` and `/terms` pages describe the current beta boundaries.

The public `/signup` flow creates an encrypted owner workspace; `/login` opens the tenant-scoped dashboard. Callback work is ordered by urgency and due time, tied to the underlying call, and can be completed, undone, or snoozed. A task closes automatically only when the booking write is verified. The older `/start` pilot application remains available for assisted prospects and appears only at `/admin/signups`.

See `docs/DASHBOARD-INBOX.md`, `docs/UNIT-ECONOMICS.md`, `docs/ICP-TEAM-BRAND-STRATEGY.md`, `docs/COMMERCIAL-POSITIONING.md`, `docs/RELEASE-PACKET.md`, `docs/FIRST-USER-ONBOARDING.md`, `docs/REQUIREMENTS.md`, `docs/DECISION-DELTA.md`, `docs/REA-METHOD.md`, `docs/PROVIDER-DECISION.md`, `docs/PRODUCT-STRATEGY.md`, and `docs/LAUNCH-CHECKLIST.md`.
