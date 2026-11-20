# AI Front Office

A narrow, supervised AI receptionist for solo and 1–10-person home-service shops. It answers overflow/after-hours calls, performs deterministic emergency triage, captures a complete request, books only when the configured system of record proves the write, and notifies the owner through a durable SMS outbox.

## Honest status

The application is buildable, tested, containerized, and deployable to staging. It is not a proven live production service until real Retell, Google, Twilio, Postgres, public HTTPS, recording-consent language, and a target shop's routing configuration complete the launch checklist below. Jobber is the intended primary system of record; Google Calendar is the working solo-mode bridge because Jobber mutations require a registered app, OAuth credentials, scopes, and schema validation in Jobber GraphiQL.

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
4. Put the service behind public HTTPS and verify `/healthz` and `/readyz`.
5. In Retell, paste the prompt from `/admin/prompt`, configure every authenticated custom tool with `TOOL_TOKEN`, configure provider-native warm transfer, and point signed webhooks to `/webhooks/retell`.
6. Connect Google Calendar through `/admin/config` or inject a refresh token server-side.
7. Configure Twilio sender credentials and named owner destinations.
8. Run every acceptance scenario in `docs/LAUNCH-CHECKLIST.md` with a test number before forwarding the shop's line.

## Architecture

```text
caller -> Retell/Twilio -> signed webhook + authenticated tools
                         -> deterministic triage
                         -> confirm mode OR Google booking + read-back
                         -> encrypted Postgres record + callback task
                         -> durable SMS outbox -> Twilio -> owner/caller
                         -> authenticated admin evidence surface
```

The application ports isolate the voice provider, calendar/system of record, notification sender, clock, and durable store. External calls have timeouts and bounded retries. Webhooks and notification creation are locally deduplicated; interrupted sends are re-queued; ambiguous calendar outcomes fail closed.

## Known limitations

- No real provider call, SMS, or deployment has been performed in this repository because credentials and a live destination were not provided.
- Jobber write operations are not implemented. Do not guess its GraphQL mutations; validate them in the registered app's versioned GraphiQL schema first.
- Housecall Pro is not implemented.
- Legal recording/consent language is configurable but must be reviewed for every launch jurisdiction.
- Retell warm transfer is provider-native; this service creates the callback safety net but cannot prove transfer behavior without a configured agent and test call.
- Twilio's documented Programmable Messaging create endpoint does not expose a client idempotency key. The durable outbox prevents duplicate jobs inside this service, but an accepted request followed by a lost HTTP response can still produce a duplicate SMS when retried. Validate this failure mode with a provisioned sender and keep messages safe to receive twice.
- Coverage schedules and ring-delay/overflow routing must also be configured at the carrier, Twilio, or Retell layer; the admin mode records the desired policy but cannot force an upstream phone carrier to forward a call.
- Flat product pricing is configuration only; subscriptions and usage enforcement are not implemented.

See `docs/REQUIREMENTS.md`, `docs/DECISION-DELTA.md`, `docs/REA-METHOD.md`, `docs/PROVIDER-DECISION.md`, `docs/PRODUCT-STRATEGY.md`, and `docs/LAUNCH-CHECKLIST.md`.
