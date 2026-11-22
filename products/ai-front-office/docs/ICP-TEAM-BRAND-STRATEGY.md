# ICP, team, pricing, and brand strategy

Snapshot: 2026-11-22. This records product decisions and founder research inputs; it is not a claim that unbuilt features are live.

## ICP operating model

The first buyer is a solo owner or 1–5-truck HVAC shop where the owner still answers most calls, misses some while driving or working, and has one public business number. The product should fit the shop's existing behavior:

1. The public number rings the owner or office first.
2. Missed, overflow, or after-hours calls forward to Front Office.
3. Front Office answers, qualifies, records, and either verifies a calendar booking or creates a callback.
4. One owner or dispatcher receives alerts and works the queue.
5. Technicians do not all receive every call.

The current $49 plan supports that centralized model: one shared line, one shared Google Calendar, one owner/dispatcher alert destination, 200 connected AI minutes, and no per-employee charge. It does **not** support five independent users, five calendars, round-robin assignment, or on-call rotations.

## Team and five-person pricing decision

Price team access separately from call usage because an additional login or calendar has little marginal infrastructure cost; connected voice minutes remain the main cost driver.

| Offer | Price | Included |
|---|---:|---|
| Shared Line | $49/month | Owner account, one calendar, one dispatcher destination, 200 connected minutes |
| Active teammate | +$5/month each | Login, personal calendar and availability, round-robin eligibility, job assignment and acknowledgement; no added voice minutes |
| Crew bundle | $99/month | Up to 10 people, 400 connected minutes, on-call rotation, multiple alert destinations, and priority routing |

A five-person shop can pay $69 for the owner plus four teammate seats while retaining the 200-minute allowance. It can choose the $99 Crew bundle when the extra 200 minutes and dispatch controls are worth more than the difference. Do not impose a $99 cliff merely because a fourth person joins; the usage and workflow bundle should earn the upgrade.

Team functionality is not live until these capabilities exist and pass production tests:

- named owner, dispatcher, and technician roles;
- per-user Google Calendar authorization and visible connection health;
- availability-aware round-robin or priority-first assignment;
- rotating on-call schedule and deterministic emergency escalation order;
- per-call assignment, reassignment, and acknowledgement history;
- tenant-scoped invitations, removal, and access revocation;
- billing that adds or removes the $5 seat only after the corresponding membership change succeeds;
- multiple alert destinations without blasting the whole crew.

Calendly charges $16 per seat per month for its Teams plan, so $5 is intentionally aggressive. It is viable only because Front Office remains narrower and minutes are priced separately. At the current ~$0.0636/minute voice cost, 400 voice minutes cost about $25.44; a $99 plan can retain roughly the same contribution-margin shape as Solo after payment, messaging, and shared infrastructure allowances.

Do not sell either team offer before invitations, calendar isolation, assignment fairness, authorization, billing-webhook replay, and member-removal tests pass.

## What to learn from Calendly

Calendly's relevant lesson is not its meeting-page UI. It is the progression from a single person's availability to reliable team routing:

- **Fast first success:** ask only for the business facts needed to start safely, run automated checks behind the scenes, and keep an owner test call optional. Reveal advanced rules only when they are needed.
- **Availability as a reusable object:** separate shop hours, bookable hours, appointment duration, minimum notice, travel buffer, holidays, and one-off date overrides.
- **Routing before booking:** service type, ZIP code, urgency, and caller preference determine which calendar or on-call person should receive the job.
- **Round robin with an explanation:** show who received a job and why; allow priority-first or balanced distribution.
- **One owner, explicit roles:** owners control billing and policy; dispatchers work the queue; technicians see only assigned jobs.
- **No customer account required:** callers book through the conversation; confirmations and change links should be usable without a login.
- **Workflow templates:** reminders and follow-ups should start from safe HVAC defaults, remain editable, and never silently change an appointment.
- **Visible connection health:** show whether each calendar is connected and when it last synced.

Official references: [Calendly scheduling FAQ](https://calendly.com/help/scheduling-faq), [multi-person scheduling](https://calendly.com/help/multi-person-scheduling-options-for-your-organization), [roles and permissions](https://calendly.com/help/user-roles-and-permissions), and [buffers](https://calendly.com/help/how-to-use-buffers).

## Prepaid-minute packs

Keep pay-as-you-go overage as the default. After the usage ledger and Stripe overage path are proven, offer an optional 50-minute pack for $9: the ordinary 50-minute overage is $10 at $0.20/minute, so $9 is a 10% prepayment discount. Credits should:

- be purchased explicitly, never silently;
- be consumed FIFO after included minutes and before overage;
- roll over for 90 days;
- be tenant-scoped, idempotent, and visible in the dashboard;
- trigger an offer at 80% usage, not interrupt coverage;
- remain unavailable until payment, credit-ledger, refund, and webhook-replay tests pass.

At current cost, 50 minutes consume about $3.18 of voice usage, leaving enough room for payment fees and support. This pack is a roadmap decision, not a live feature.

## Website and brand direction

Borrow Stuut's useful principles without copying its identity: one outcome-led headline, a recurring coworker character, plain proof, numbered differentiation, product evidence, and repeated “does the work / knows your business / follows your rules” framing. The current site already has a dedicated **Compare** section in the main navigation and a six-question FAQ; keep both short enough to scan on a phone.

The mascot should feel like a helpful shop coworker: flat 2D, warm, recognizable at 48px, minimal internal detail, no glossy 3D finish, no skeptical eyebrow, and no human gender cue.

Founder-provided Grok research suggested personified names such as Callie and a broader company name such as Ally. Those are research inputs, not facts or decisions. **Callie and Ally are rejected** because they feel generic, gendered, and too close to the usual AI-assistant naming pattern.

Naming constraints for a future rename:

- one or two syllables;
- easy to hear, spell, and repeat over a phone;
- useful beyond answering calls;
- playful but credible to a trade owner;
- not a human-assistant cliché;
- screened for trademark, domain, app, and telecom conflicts before adoption.

Working shortlist for testing, not clearance: **Rivet**, **Relay**, **Rilo**, **Tuck**, **Scout**, and **Bench**. Keep **Front Office** as the descriptive working name until owner interviews produce a clear winner.

Official brand reference: [Stuut](https://www.stuut.ai/).
