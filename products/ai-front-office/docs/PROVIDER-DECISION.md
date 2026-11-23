# Provider decision

## Chosen v1 stack

- Voice, number, recording, transfer, and SMS: Telnyx behind the HTTP/tool adapter.
- Solo scheduling bridge: Google Calendar free/busy + deterministic event ID + serialized recheck + read-back verification.
- Durable state: Postgres.
- Admin: server-rendered authenticated UI in this service.

Telnyx replaces the former two-vendor voice/SMS plan. One provider now owns the number path, assistant, Ed25519-signed webhooks/tools, recording, transfer, and idempotent Messages API. Provider semantics remain outside the domain so the booking, triage, evidence, outbox, and admin logic stay portable.

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

- Telnyx AI Assistants: https://developers.telnyx.com/docs/inference/ai-assistants
- Telnyx dynamic variables and signed tools: https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables
- Telnyx webhook signatures: https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks
- Telnyx Messages API: https://developers.telnyx.com/api-reference/messages/send-a-message
- Telnyx call recordings: https://developers.telnyx.com/api-reference/call-recordings/list-call-recordings
- Google free/busy: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Google event creation: https://developers.google.com/workspace/calendar/api/guides/create-events
- Google OAuth: https://developers.google.com/workspace/calendar/api/auth
- Jobber developer docs: https://developer.getjobber.com/docs/
- Jobber authorization: https://developer.getjobber.com/docs/building_your_app/app_authorization/
- Jobber webhooks: https://developer.getjobber.com/docs/using_jobbers_api/setting_up_webhooks/
