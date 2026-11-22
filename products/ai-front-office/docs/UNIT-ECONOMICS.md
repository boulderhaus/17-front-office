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

## Why the same 200 minutes cannot cost $3 on current Telnyx Voice AI

The Telnyx Voice AI engine alone is $10 for 200 minutes before telephony, model, recording, number, messaging, or hosting. A $3 target therefore requires replacing the managed agent layer with a custom SIP/media pipeline—not a pricing tweak.

The R&D path is: Telnyx SIP/telephony only, self-hosted or lower-cost streaming STT, a small tool-calling model for ambiguous turns, cached high-quality TTS for common phrases, generated TTS only for variable content, aggressive spam blocking, and short human-style calls. That could target roughly 1.5–2.5¢/minute at meaningful scale, but $3 all-in is not yet proven and would trade managed reliability for engineering/operations burden.

## Decision

Launch on Telnyx quality. Reduce actual cost by answering only missed/after-hours calls, excluding spam, avoiding repetitive language, and measuring usage. Keep the custom pipeline as a parallel cost-down experiment only after real customers establish volume.
