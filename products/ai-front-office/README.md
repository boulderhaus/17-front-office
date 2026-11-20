# AI Front Office

A narrow, supervised AI receptionist for solo and 1–10-person home-service shops. It answers overflow/after-hours calls, performs deterministic emergency triage, captures a complete request, books only when the configured system of record proves the write, and notifies the owner through a durable SMS outbox.

## Honest status

The application is buildable, tested, containerized, and deployed to a fail-closed Railway staging service with isolated Postgres and public HTTPS. Telnyx is the single voice, number, recording, transfer, webhook, and SMS provider; Google Calendar is the solo-mode scheduling bridge. It is not approved for customer traffic until the Telnyx account/messaging campaign, Google OAuth, owner destination, recording-consent language, and live smoke matrix pass the launch gate. Jobber remains the intended primary system of record after its registered-app mutations are validated in Jobber GraphiQL.

## Product rules

- Default to after-hours coverage and owner-confirmation booking.
- Disclose that the caller is speaking to the owner's AI assistant.
- Never improvise a price, availability, service promise, or safety instruction.
- Life-safety and urgent calls bypass booking and alert the owner.
- A verified booking requires: calendar write/read-back, transcript, recording, complete intake, diagnostic-fee acceptance when enabled, and a queued customer confirmation.
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

## Architecture

```text
caller -> Telnyx number/assistant -> Ed25519-signed webhook + tools
                         -> deterministic triage
                         -> confirm mode OR Google booking + read-back
                         -> encrypted Postgres record + callback task
                         -> durable idempotent SMS outbox -> Telnyx -> owner/caller
                         -> authenticated admin evidence surface
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
- Flat product pricing is configuration only; subscriptions and usage enforcement are not implemented. The beta must be billed manually.

The service is paused by default. The authenticated admin provides **Readiness**, **Simulator**, configuration, call history, and permanent call deletion; public `/privacy` and `/terms` pages describe the current beta boundaries.

See `docs/RELEASE-PACKET.md`, `docs/FIRST-USER-ONBOARDING.md`, `docs/REQUIREMENTS.md`, `docs/DECISION-DELTA.md`, `docs/REA-METHOD.md`, `docs/PROVIDER-DECISION.md`, `docs/PRODUCT-STRATEGY.md`, and `docs/LAUNCH-CHECKLIST.md`.
