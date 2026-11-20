# First-user onboarding

## Owner session

1. Keep the service paused and use confirm-first booking.
2. Configure identity/greeting, timezone, hours, weekends/holidays, overflow rings, service area, categories, emergency rules, exact fee language, notification phone, support email, disclosure, retention, and plan price.
3. Connect Google Calendar and confirm the intended calendar account.
4. Review the generated Telnyx update; apply it with `npm run configure:telnyx -- --apply`.
5. Configure carrier/Telnyx after-hours or overflow forwarding to match the admin policy.

## Test session

1. Run all 15 simulator scenarios and save the PASS evidence.
2. Enable `PROVIDER_TEST_MODE`, unpause, and use a dedicated test number only.
3. Run the live smoke matrix in `RELEASE-PACKET.md`; verify owner SMS timing and the protected evidence record after every call.
4. Correct the approved knowledge/rules; do not enable direct booking.
5. Record consent approval and live proof. Disable provider test mode, set `LIVE_PROVIDER_PROOF_AT`, and require `/activationz=200`.

## First 14 customer days

- Confirmation mode only; review transcripts and failures daily.
- Keep the pause switch and carrier rollback instructions available to the owner.
- Reconcile manual billing; do not describe the plan as an automated subscription.
- Enable direct booking only after the owner signs off on observed calls and the complete booking evidence contract consistently passes.
