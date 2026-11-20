# Launch checklist

## Automated gate

- `npm ci`
- `npm audit --audit-level=high`
- `npm run check`
- `npm run demo`
- Build container and apply migration to a disposable Postgres database.

## Provider gate

- Public HTTPS URL and stable DNS.
- Retell signed webhook rejects bad signatures.
- Every custom tool rejects missing/wrong bearer token.
- Warm transfer succeeds; forced transfer failure creates a callback task.
- Twilio sends owner and caller SMS; forced provider failure retries then raises owner alert; an accepted-request/lost-response drill confirms duplicate-safe message copy and operator handling.
- Google OAuth reconnects; conflict race yields exactly one write; created event is read back.
- Forwarding/overflow timing works from the real shop number.
- Carrier/Twilio/Retell coverage hours and ring delay match the admin policy; test business-hours pickup, after-hours pickup, owner-busy overflow, and forwarding failure.

## Scenario gate

- 2 a.m. no heat with infant: urgent owner alert, no autonomous booking.
- Gas/CO/fire: leave/call 911 instruction, immediate owner route, no troubleshooting.
- Routine maintenance: confirm mode proposes but does not promise; direct mode books only after all verification gates.
- Human request, angry/confused caller, hard address, unapproved price, no availability, API failure, call drop, transcript loss, recording loss, SMS failure, duplicate webhook, and spam all match `docs/REQUIREMENTS.md`.
- Owner receives the final call summary within 60 seconds under normal provider conditions.

## Human launch gate

- Owner approves greeting, knowledge, pronunciation, service area, emergency rules, fee language, schedule, destination numbers, and callback SLA.
- Counsel/qualified reviewer approves disclosure and recording consent for operating jurisdictions.
- Start in confirmation mode for the first 14 days; review transcripts daily; record every correction in the approved knowledge/rules.
- Only enable direct booking after the owner signs off on observed calls.
