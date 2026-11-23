# AI Front Office commercial position

Snapshot: 2026-11-21

## The position

AI Front Office is the missed-call and after-hours receptionist for solo owners and 1–10 person home-service shops that do not need an enterprise call center.

The plain-English pitch:

> Your phone rings first. If you cannot answer, the AI picks up, gets the customer’s name, address, and problem, checks the rules you approved, and leaves you the transcript, recording, urgency, and booking status. Start with missed calls only. Keep your current number.

Do not sell it as an Avoca replacement. Sell it as the narrow first step for an owner who is still answering the phone from an attic, truck, or job site.

## Best first buyer

- Solo HVAC owner or 1–5 truck shop
- Owner still receives most calls
- Misses calls while driving or working
- Uses Google Calendar or is willing to start there
- Wants overflow or after-hours coverage before 24/7 automation
- Does not need ServiceTitan, a call center, or several departments on day one

Avoid shops that require live human transfers, Spanish, ServiceTitan customer history, multiple locations, or a guaranteed SLA until those capabilities exist.

## What the product does

| Area | Current behavior |
|---|---|
| Voice | Answers Telnyx calls with an owner-approved greeting and explicit AI/recording disclosure |
| Intake | Captures caller ID, callback confirmation, name, address, problem, category, equipment details, and access notes |
| Safety | Uses deterministic rules for gas, carbon monoxide, fire, smoke, and immediate danger; urgent calls skip booking |
| Service area | Checks only owner-configured cities and ZIP codes; never invents a radius |
| Scheduling | Checks Google Calendar; direct booking requires explicit caller confirmation and a verified write/read-back |
| Owner rules | Repeats only approved prices, policies, service categories, and answers |
| Evidence | Stores encrypted call details, transcript, recording link, outcome, booking evidence, and notification status |
| Follow-up | Creates an owned callback when automation cannot safely finish |
| Control | Each owner has an isolated account to set hours, service area, greeting, rules, prices, and appointment windows; inspect usage/calls; pause; and delete call data |
| Signup | Self-serve owner workspace plus an assisted activation gate; the line cannot receive customer traffic before provisioning |
| Payment | Stripe Checkout and signed subscription state are implemented and remain hidden until production credentials/price are configured |

## What it does not do yet

- No live human or warm transfer
- No Spanish or multilingual calls
- No Jobber, Housecall Pro, or ServiceTitan write path
- No mobile app, website chat, outbound campaigns, or CSR coaching
- No multi-location or shared team permissions
- No instant self-serve Telnyx number/assistant provisioning; account and tenant creation are self-serve, line activation is assisted
- No production SMS until the carrier approves the Telnyx campaign
- No customer traffic until recording language is approved and the live smoke gate passes

## Competitive map

| Product | Public offer | Where it wins today | Where AI Front Office can win |
|---|---|---|---|
| Avoca | Sales-led AI front office for home services; voice, text, chat, outbound, coaching, human-in-the-loop, and deep field-service integrations | Proven enterprise deployments, ServiceTitan context, live-human coverage, omnichannel, high call volume | Owner-operated shops that do not use ServiceTitan and want a smaller, cheaper overflow product |
| Rosie | $49/month for 250 minutes and message-taking; $149/month adds direct calendar booking and warm/live transfers; apps, Spanish, Zapier, recordings, and notifications | Broad small-business feature set, self-serve trial, mobile apps, transfers, multilingual support | HVAC-specific guardrails, explicit owner rules, deterministic emergency handling, and assisted local setup |
| Goodcall | $79/month starter with 100 unique customers and unlimited minutes; flow builder, forwarding, team access, and integrations | Mature self-serve product, predictable usage model, flexible flows, many businesses served | A narrower workflow with less configuration burden and hands-on setup for small local shops |
| Sameday | $449/month for 500 minutes after hours; $789/month for 1,000 minutes and full coverage; home-service scheduling integrations | Home-service specialization, ServiceTitan-class scheduling, higher-volume operations | Shops priced out of an enterprise system that need only missed-call intake and Google Calendar |

Official sources:

- [Avoca](https://www.avoca.ai/)
- [Avoca HVAC](https://www.avoca.ai/inbound/hvac)
- [Avoca customer stories](https://www.avoca.ai/customers)
- [Rosie pricing and features](https://heyrosie.com/solutions/ai-receptionist)
- [Goodcall pricing](https://www.goodcall.com/pricing)
- [Sameday pricing](https://sameday.ai/pricing)

## Monday offer

Founding plan: $49/month for the first local shops.

- 200 connected AI minutes; $0.20/minute after; spam excluded
- Assisted setup
- Overflow or after-hours first
- Existing number stays in place
- Google Calendar connection
- Call transcript and recording
- Owner-approved service area, prices, and answers
- Month to month

Do not promise unlimited use, instant phone-line activation, live transfer, direct FSM booking, or a specific revenue result.

## Buyer FAQ

**Do I change my number?**

No. The shop keeps its number and forwards missed or after-hours calls to the AI line.

**Will it tell customers it is AI?**

Yes. The first greeting uses the approved AI and recording disclosure.

**Can it book jobs?**

It can check Google Calendar. A slot is called booked only after the customer confirms it and the calendar write is read back successfully. The safer starting mode asks the owner to confirm.

**What if someone smells gas or reports a fire?**

Deterministic safety rules tell the caller to leave and contact emergency services or the gas utility. The call skips ordinary booking and creates a high-priority owner alert.

**Can it quote my diagnostic fee?**

Only the exact wording the owner approves. If no price is configured, it takes a message instead of guessing.

**Does it replace my office staff?**

No. It handles the first missed or after-hours conversation and organizes the follow-up.

## Commercial release gate

Marketing can recruit founding pilots now. Customer traffic and billing must wait for all of these:

1. Telnyx campaign approved and a real owner SMS delivered.
2. Jurisdiction-specific recording disclosure approved.
3. Google Calendar connected and a real write/read-back verified.
4. Live tests pass for emergency, routine booking, explicit human request, unclear address, price question, calendar conflict, provider failure, voicemail, and hangup.
5. Provider test mode disabled and `/activationz` returns 200.
6. Checkout terms match the actual product, cancellation path, and usage policy.
