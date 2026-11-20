# Research decision delta

Source packet (read-only provenance): `research/muse-avoca-2026-11-19/smb-ai-market`. Evidence labels are preserved as official statistics, behavioral data, vendor/company claim, owner allegation, weak survey, or inference. No owner quote is treated as market truth.

## Confirmed

| Decision | Evidence | Grade |
|---|---|---|
| Start with after-hours/overflow answering, not a general AI employee | Phone answering is the narrow customer-facing job already delegated; autonomy elsewhere remains shallow | Cross-source synthesis; vendor + owner-allegation evidence |
| Target tiny existing shops with calls and revenue to lose | 64,871 plumbing/HVAC establishments have 1–4 employees; 20,587 have 5–9 | Census CBP 2023, official statistics |
| Use flat public pricing and strong failure visibility | Median paid AI spend is $28/month; opaque metering/billing is a repeated complaint | JPMorgan transaction data + owner-allegation corpus |
| Make proof the product | Wrong-booking complaints center on writes that never happened; owners demand recordings, transcripts, and logs | Owner-allegation corpus; directional |
| Keep a human escape hatch | Reputation/accuracy fears and complaint patterns converge on supervised autonomy | Fed/vendor surveys + owner allegations |

## Changed because of research

| Before | Now | Why |
|---|---|---|
| Google Calendar as primary architecture | Google is solo-mode bridge; Jobber is the intended launch system of record | Jobber is the incumbent distribution/data surface for the ICP |
| Direct booking by default | Confirm mode by default; direct booking is explicit opt-in after testing | 59% prefer approve-every-action and 68% want extensive testing first (vendor survey) |
| Calendar success meant booked | Write/read-back + recording + transcript + intake + fee acceptance + customer confirmation | Prevents the documented “booking did not happen” failure class |
| Emergency was a label attached after the call | Emergency tool alerts owner immediately and booking is bypassed | Highest-value failure needs deterministic routing, not post-hoc analytics |
| All calls produced an owner summary | Spam is silently excluded from billing and owner alerts | Spam consuming paid allowance is a known trust failure |
| Provider webhook was the only close path | Stale-call recovery creates caller text-back and owned callback | Prevents provider/system drops from disappearing |
| Generic prompt knowledge | Owner-approved knowledge and pronunciation lists | Grounding and local credibility beat a broad hallucinating agent |

## Rejected

- “Runs your business while you sleep”: rejected as a trust-destroying promise. The system automates doing and gates committing.
- Sales-led/demo-gated pricing: rejected for a micro-shop self-serve wedge.
- Unapproved price invention, diagnosis, response-time promises, or legal/regulated advice: rejected architecturally.
- Treating vendor traction, promotional testimonials, or a single social post as fact: rejected under REA's observation/derivation/inference/unknown discipline.
- Guessing Jobber mutations from stale examples: rejected. The versioned GraphiQL schema is the authority.

## Unresolved

- Jurisdiction-specific call recording/AI disclosure language needs legal review.
- Jobber app credentials, scopes, test account, exact scheduling mutation, OAuth rotation, and disconnect handling need live verification.
- Real Retell warm-transfer behavior, latency, interruption quality, and failure callbacks need provider test calls.
- Real Twilio deliverability and STOP/compliance behavior need a provisioned sender.
