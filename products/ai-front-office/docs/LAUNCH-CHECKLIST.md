# Launch checklist

## Automated gate

- `npm ci`
- `npm audit --audit-level=high`
- `npm run check`
- `npm run demo`
- `npm run simulate:launch` returns 15/15 PASS.
- Build container and apply migration to a disposable Postgres database.

## Provider gate

- Public HTTPS URL and stable DNS.
- Telnyx Ed25519-signed webhook and every tool reject bad, missing, and stale signatures.
- Warm transfer succeeds; forced transfer failure creates a callback task.
- Telnyx sends owner and caller SMS with a stable idempotency key; forced provider failure retries then raises owner alert; opt-out and campaign-compliance behavior are verified.
- Google OAuth reconnects; conflict race yields exactly one write; created event is read back.
- Forwarding/overflow timing works from the real shop number.
- Carrier/Telnyx coverage hours and ring delay match the admin policy; test business-hours pickup, after-hours pickup, owner-busy overflow, and forwarding failure.

## Scenario gate

- 2 a.m. no heat with infant: urgent owner alert, no autonomous booking.
- Gas/CO/fire: leave/call 911 instruction, immediate owner route, no troubleshooting.
- Routine maintenance: confirm mode proposes but does not promise; direct mode books only after all verification gates.
- Human request, angry/confused caller, hard address, unapproved price, no availability, API failure, call drop, transcript loss, recording loss, SMS failure, duplicate webhook, and spam all match `docs/REQUIREMENTS.md`.
- Owner receives the final call summary within 60 seconds under normal provider conditions.

## Human launch gate

- The service starts paused; `/readyz=200` is not customer approval. `/activationz` must remain `503` until the complete provider gate is proven.
- Owner approves greeting, knowledge, pronunciation, service area, emergency rules, fee language, schedule, destination numbers, and callback SLA.
- Counsel/qualified reviewer approves disclosure and recording consent for operating jurisdictions.
- Use `PROVIDER_TEST_MODE=true` only on the dedicated test number. Record `LIVE_PROVIDER_PROOF_AT`, disable test mode, and require `/activationz=200` before customer forwarding.
- Start in confirmation mode for the first 14 days; review transcripts daily; record every correction in the approved knowledge/rules.
- Only enable direct booking after the owner signs off on observed calls.
