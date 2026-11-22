# Solo-plan unit economics

Snapshot: 2026-11-21. Recheck vendor prices before changing the public plan.

## Why 200 Telnyx minutes cost about $12.70

The current quality-first stack is approximately $0.0636 per connected minute:

| Component | Published/estimated rate |
|---|---:|
| Telnyx Voice AI engine, including orchestration/STT/TTS | $0.0500 |
| Kimi-class LLM estimate | $0.0064 |
| Local inbound telephony | $0.0032 |
| Voice API platform fee | $0.0020 |
| Recording | $0.0020 |
| **Total** | **$0.0636** |

At that rate, 200 connected minutes cost $12.72. Telnyx rounds Voice AI usage by call to 60-second increments, so the product meter mirrors that conservative billing behavior.

Official inputs: [Telnyx Voice AI pricing](https://telnyx.com/pricing/voice-ai-agents), [Telnyx Voice API pricing](https://telnyx.com/pricing/call-control).

## Do small HVAC shops use 200 missed-call minutes?

There is no credible public dataset proving that a typical solo or 1–5-truck HVAC shop has 200 minutes of calls it currently misses. ServiceTitan reports roughly one in eight residential HVAC calls arrives after hours, and CallRail reported a 14% missed-call rate across home services; those percentages make the problem real but do not establish 200 minutes per shop.

Treat 200 as an included ceiling. Instrument pilots and track P25/P50/P75/P90 connected minutes, call count, average handled duration, spam exclusion, and seasonality before changing the allowance.

Evidence: [ServiceTitan call trends](https://www.servicetitan.com/guides/call-trends-in-the-trades), [CallRail benchmark report](https://www.callrail.com/blog/callrail-releases-benchmark-report).

## $49 plan contribution model

At the full 200-minute allowance, expected variable/shared cost is roughly:

| Cost | Monthly estimate |
|---|---:|
| Voice AI | $12.72 |
| Stripe Payments + Billing | $2.06 |
| Number + owner-alert messaging allowance | $1.50 |
| Shared hosting/database allowance | $2.00 |
| **Total** | **$18.28** |
| **Contribution before support/tax** | **$30.72 (62.7%)** |

At 50 connected minutes, the same model is about $8.74 total and 82% contribution margin. Actual pilot usage matters more than the advertised cap.

Stripe inputs: [Payments pricing](https://stripe.com/pricing), [Billing pricing](https://stripe.com/billing/pricing).

## Does one recovered job pay for the plan?

Use contribution margin, not net-profit theater. ServiceTitan’s contractor KPI playbook sets an HVAC service target of at least $375 per ticket and at least 72% gross margin. At those benchmarks, one incremental service call contributes about $270 before overhead, enough to cover a $49 month. Fully allocated net profit is different: NREL reports average HVAC-business net margins of roughly 2.5%–5%, which would be only $9–$19 on a $375 ticket.

Approved public wording: **“One recovered $375 service call can cover the month before overhead.”** Never say one average job necessarily nets the subscription price.

Evidence: [ServiceTitan contractor KPI playbook](https://www.servicetitan.com/guides/contractor-playbook/kpi-tracking), [NREL HVAC contractor business-model report](https://www.nrel.gov/docs/fy24osti/88387.pdf).

### The owner's break-even, in plain English

The relevant launch question is how much *incremental contribution* a recovered call produces after the direct cost of doing that job. At the ServiceTitan benchmark, the answer is simple: one new paying customer covers the $49 subscription.

| Completed ticket | Gross margin | Contribution before overhead | Customers needed to cover $49 |
|---:|---:|---:|---:|
| $375 | 72% | $270.00 | 1 |
| $150 | 50% | $75.00 | 1 |
| $99 | 50% | $49.50 | 1 |
| $89 | 50% | $44.50 | 2 |

At 72% gross margin, the break-even ticket is about $68. At 50%, it is $98. At 30%, it is about $164.

Denominators matter more than a single “conversion rate.” Invoca's 2026 home-services call analysis reports that 45% of answered HVAC calls are leads and 43% of those leads convert on the call. Multiplying those rates implies about 19% of all answered HVAC calls convert on the call. ServiceTitan's older shop-size analysis found that shops with fewer than five technicians booked 24% of calls overall, but only 9% after 6 p.m.

| Metric | Benchmark or launch assumption |
|---|---:|
| Answered HVAC calls that are leads | 45% |
| HVAC phone leads booked on the call | 43% |
| Implied bookings per answered HVAC call | about 19% |
| Fewer-than-five-tech shop booking rate | 24% |
| Small-shop booking rate after 6 p.m. | 9% |
| Front Office launch model: completed jobs per recovered missed/after-hours call | **10%** |

The 25% assumption was conservative only when the denominator was already-qualified phone leads. It was aggressive for all recovered missed and after-hours calls. Until pilot cohorts prove otherwise, model **ten recovered calls for one completed job**. Track answered calls, qualified opportunities, bookings, cancellations, completed jobs, ticket revenue, and repeat work separately.

Evidence: [Invoca 2026 Home Services Lead Conversion Benchmarks](https://www.invoca.com/reports/the-invoca-call-conversion-benchmarks-report-home-services-2025), [ServiceTitan call-booking analysis](https://www.servicetitan.com/blog/data-call-booking-rates).

## Why the same 200 minutes cannot cost $3 on current Telnyx Voice AI

The Telnyx Voice AI engine alone is $10 for 200 minutes before telephony, model, recording, number, messaging, or hosting. A $3 target therefore requires replacing the managed agent layer with a custom SIP/media pipeline—not a pricing tweak.

The R&D path is: Telnyx SIP/telephony only, self-hosted or lower-cost streaming STT, a small tool-calling model for ambiguous turns, cached high-quality TTS for common phrases, generated TTS only for variable content, aggressive spam blocking, and short human-style calls. That could target roughly 1.5–2.5¢/minute at meaningful scale, but $3 all-in is not yet proven and would trade managed reliability for engineering/operations burden.

## Decision

Launch on Telnyx quality. Reduce actual cost by answering only missed/after-hours calls, excluding spam, avoiding repetitive language, and measuring usage. Keep the custom pipeline as a parallel cost-down experiment only after real customers establish volume.
