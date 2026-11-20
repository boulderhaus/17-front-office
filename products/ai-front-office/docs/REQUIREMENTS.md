# Launch requirements

## Binding product rules

1. ICP: solo and 1–5-truck home-service shops; HVAC is the first launch vertical.
2. Default coverage: overflow/after-hours. AI is not the first impression unless the owner explicitly selects 24/7.
3. Identity: disclose “the owner's AI assistant” in the first breath; never impersonate staff.
4. Systems of record: Jobber first, Housecall Pro second. Google Calendar is the working solo/beta bridge, not the long-term integration moat.
5. Price: published flat $49 Solo / $99 Crew target, month-to-month, no setup fee, no demo gate, no surprise meter or silent shutoff.
6. Setup: under 30 minutes once phone/provider credentials exist; under one hour with Google Calendar and forwarding.
7. Booking proof: recording and transcript; required intake; system-of-record write and read-back; required fee acceptance; customer confirmation queued or an explicit send-failure alert. Anything less is pending.
8. Emergency: deterministic safety rules override model judgment. Life-safety/urgent calls skip booking and go straight to owner/human escape.
9. Pricing and knowledge: quote only owner-approved text. Refuse and route when an answer is not grounded.
10. Spam: exclude from billing, owner alerts, and headline capture metrics.
11. Scope: no outbound campaigns, Coach product, deep ServiceTitan work, enterprise multi-location, or unverified traction claims.
12. Reliability: every failure yields a visible outcome and an owned callback task with owner, reason, priority, and due time.

## Original v1 acceptance

- Live inbound flow captures name, phone, address, and problem.
- Hybrid emergency triage and human handoff.
- Google availability, booking, conflict handling, and pending fallback.
- Owner SMS within 60 seconds of call end under normal provider conditions.
- After-hours/overflow schedule.
- Admin configuration, recent calls, recording, transcript, outcome, tool log, notification status, and callback task.
- Structured logs, rate limits, provider timeouts/retries, idempotent webhooks/outbox, health/readiness, environment secrets, encryption at rest.

## Required scenarios

- No heat/no AC at 2 a.m.
- Gas/CO/fire life safety.
- Routine maintenance during business hours.
- Caller asks for a human immediately.
- Angry/confused caller.
- Hard-to-parse/out-of-area address.
- Price question outside approved snippets.
- Slot race and calendar conflict.
- Calendar API failure mid-call.
- Warm-transfer failure.
- Provider call drop before final webhook.
- Recording-only or transcript-only evidence.
- Customer SMS failure.
- Spam classification.
