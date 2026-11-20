# Provider decision

## Chosen v1 stack

- Voice orchestration: Retell behind the HTTP/tool adapter.
- Number ownership and SMS: Twilio-owned number where practical; retain portability and avoid locking the business identity to the voice vendor.
- Solo scheduling bridge: Google Calendar free/busy + deterministic event ID + serialized recheck + read-back verification.
- Durable state: Postgres.
- Admin: server-rendered authenticated UI in this service.

Retell was selected for low-latency voice tooling, signed webhook support, and provider-native transfer capability. The implementation keeps provider semantics outside the domain so Vapi or Bland can be evaluated without rewriting booking, triage, evidence, outbox, or admin logic.

## Jobber boundary

Jobber is a versioned GraphQL API at `https://api.getjobber.com/api/graphql`. It uses OAuth 2 authorization code flow, PKCE, one-hour access tokens, refresh-token rotation, app/account rate limits, and signed at-least-once webhooks. Draft apps are limited to five paying accounts before review. A production connector must:

1. Register an app and test account.
2. Select least-privilege scopes.
3. Use the current GraphiQL schema for client/property/request/job/visit operations.
4. Handle top-level GraphQL errors and mutation `userErrors`.
5. rotate refresh tokens atomically and encrypt them.
6. Handle `APP_DISCONNECT` and verify `X-Jobber-Hmac-SHA256` before a one-second acknowledgement.
7. Read back every created object before declaring success.

We intentionally do not ship guessed scheduling mutations.

## Primary sources

- Retell voice API: https://www.retellai.com/features/voice-ai-api
- Retell pricing: https://www.retellai.com/pricing
- Retell/SIP number ownership: https://www.retellai.com/learn/how-to-keep-your-existing-phone-number-using-a-sip-connection
- Twilio porting: https://www.twilio.com/docs/numbers-and-senders/port-host
- Twilio messaging API: https://www.twilio.com/docs/messaging/api
- Twilio Messages resource (no documented client idempotency parameter on create): https://www.twilio.com/docs/messaging/api/message-resource
- Twilio webhook security: https://www.twilio.com/docs/usage/webhooks/webhooks-security
- Google free/busy: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Google event creation: https://developers.google.com/workspace/calendar/api/guides/create-events
- Google OAuth: https://developers.google.com/workspace/calendar/api/auth
- Jobber developer docs: https://developer.getjobber.com/docs/
- Jobber authorization: https://developer.getjobber.com/docs/building_your_app/app_authorization/
- Jobber webhooks: https://developer.getjobber.com/docs/using_jobbers_api/setting_up_webhooks/
