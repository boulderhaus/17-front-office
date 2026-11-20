# First-customer release packet

## Binary verdict

**NO-GO for customer traffic as of 2026-11-20 EST.** A dedicated fail-closed staging deployment and Telnyx number/assistant exist, but the production API connection, Google OAuth, messaging approval, consent approval, target-shop configuration, and live smoke evidence are incomplete. `/activationz` therefore returns `503` by design.

## Deployment status and exact blocker

- Staging URL: `https://ai-front-office-production.up.railway.app`.
- A new isolated Railway project, application service, Postgres service, domain, strong runtime secrets, and `/readyz` healthcheck exist. No existing Railway project was modified.
- The application runs in production mode with Postgres and starts paused. Runtime credentials live only in the deployment secret store.
- Live proof: `/readyz=200`, `/activationz=503`, `/privacy=200`, unauthenticated `/admin=401`, authenticated `/admin=200`, and deployed simulator 15/15 PASS.
- Customer GO now requires provider accounts/credentials, approved owner/test destinations, consent wording, phone routing, and the live smoke matrix. Buying a phone number or accepting provider checkout remains outside the completed staging step.

## Verified local evidence

- TypeScript compile and 45 automated tests pass, including Ed25519 signature, signed tool/init, assistant-config, idempotent SMS, and recording-proxy boundaries.
- All 15 credential-free launch scenarios pass in the in-app simulator.
- `npm audit --audit-level=high` reports zero vulnerabilities, and the final Docker image builds successfully.
- The final Docker image starts by applying the idempotent migration, then boots the server. The isolated Railway deployment applied that migration and reached SUCCESS.
- No live call, SMS, transfer, or Google write is claimed.

## 15-minute Brock self-test

1. Open `https://ai-front-office-production.up.railway.app`; retrieve `ADMIN_TOKEN` directly from the isolated Railway service's Variables screen and sign in. Do not paste that token into chat or source control.
2. Open **Simulator**, choose **Run all 15 launch scenarios**, and require 15 PASS rows.
3. Open **Readiness** and require NO-GO. Confirm `/activationz=503` while `/readyz=200`.
4. Open **Configuration**; verify the service starts paused, confirm mode is selected, and the kill switch, business identity, timezone, hours, overflow rings, service area, emergency rules, fee wording, support email, disclosure, retention, and flat price all save.
5. Open `/privacy` and `/terms`. Do not unpause or add customer routing during this credential-free review.
6. For a local source review, run `npm ci && npm run check && npm run build && npm run simulate:launch`.

## First-user onboarding checklist

- Approve business name, greeting, AI identity, recording disclosure, timezone, coverage hours, weekends/holidays, ring delay, service area, service categories, emergency keywords, exact diagnostic-fee wording, callback SLA, retention, support contact, and $49–$99 manual plan.
- Keep the service paused and booking in **confirm** mode.
- Use the existing isolated deployment/Postgres; the image applies the idempotent migration on boot.
- Configure the secret names below; connect Google Calendar in admin.
- Configure the Telnyx API/public keys, number, assistant, messaging profile, signed tools/webhook, and provider-native transfer with `npm run configure:telnyx -- --apply`.
- Set `PROVIDER_TEST_MODE=true`, unpause, then run every live smoke scenario with consenting test participants.
- After evidence review, set an ISO timestamp in `LIVE_PROVIDER_PROOF_AT`, set `PROVIDER_TEST_MODE=false`, redeploy, and require `/activationz` to return `200` before forwarding a customer number.

## Required runtime values

`PUBLIC_BASE_URL`, `DATABASE_URL`, `DATA_ENCRYPTION_KEY`, `ADMIN_TOKEN`, `TOOL_TOKEN`, `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_FROM_NUMBER`, `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_ASSISTANT_ID`, `TELNYX_MESSAGING_APPROVED`, `RECORDING_CONSENT_APPROVED`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, optional `GOOGLE_REFRESH_TOKEN`, `OWNER_DESTINATIONS_JSON`, `PROVIDER_TEST_MODE`, and—only after real proof—`LIVE_PROVIDER_PROOF_AT`.

## Live smoke evidence required for GO

- Routine call captured; owner SMS arrives within 60 seconds of call end.
- 2 a.m. no-heat, burst pipe, and gas-smell calls bypass booking and create the correct urgent/life-safety alert.
- Human request and forced transfer failure leave an owned callback.
- Google conflict, double-book race, calendar timeout, Telnyx failure, provider drop, malformed address, unknown price, angry/confused caller, no availability, and spam match the expected safe state.
- Transcript, recording, intake, fee acceptance, calendar write/read-back, and queued customer confirmation are all present before a call is counted BOOKED.

## Known launch limits

- Jobber and Housecall Pro connectors are not implemented; Google Calendar is the beta bridge.
- Warm transfer and carrier overflow/ring timing are provider-side and need live configuration.
- Telnyx Messages receives a stable idempotency key, but carrier delivery, opt-out, and campaign-compliance behavior still require live proof.
- Stripe, automated invoices, usage metering, email notifications, data export, and multi-location features are absent. Billing is manual.
- Consent/disclosure wording needs jurisdiction-specific review.

## Pause, rollback, and cancellation

- Immediate stop: set **Service state = paused** in admin. Provider tools/webhooks return `503`; history remains accessible.
- Infrastructure stop: remove forwarding, disable the Telnyx assistant/number assignment, then stop the application service. Do not delete Postgres as a rollback step.
- Rollback: deploy the prior known-good image/commit, keep paused, verify `/readyz`, then repeat provider smoke tests.
- Cancellation: pause immediately, stop billing manually, export anything contractually required, honor deletion requests, and delete retained call data through admin or the retention process.
