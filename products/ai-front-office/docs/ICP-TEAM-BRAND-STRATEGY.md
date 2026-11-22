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

## Five-person plan decision

Keep the $49 Shared Line plan for any shop that uses one dispatcher. A later $99 Crew plan is viable only after these features exist and pass live tests:

- up to five named users with owner, dispatcher, and technician permissions;
- multiple calendars with availability-aware round-robin or priority routing;
- rotating on-call schedule and emergency escalation order;
- per-call assignment, reassignment, and acknowledgements;
- 400 included connected minutes;
- multiple alert destinations without blasting the whole crew.

Do not sell Crew before those capabilities exist. At the current ~$0.0636/minute voice cost, 400 voice minutes cost about $25.44; a $99 plan can retain roughly the same contribution-margin shape as Solo after payment, messaging, and shared infrastructure allowances.

## What to learn from Calendly

Calendly's relevant lesson is not its meeting-page UI. It is the progression from a single person's availability to reliable team routing:

- **Fast first success:** ask for only the information needed to run a safe test call, then reveal advanced rules after the owner hears it work.
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
