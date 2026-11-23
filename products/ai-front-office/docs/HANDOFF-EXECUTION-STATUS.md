# Critical handoff execution status

Source: Brock-supplied `AI-Front-Office-Codex-Handoff.md`, read in full on 2026-11-22. This checklist distinguishes implemented code from live proof. No checkbox below substitutes for a real call or payment.

## Scope decisions

- Solo receptionist remains first: answer overflow, collect details, verify one calendar, notify owner.
- $49/month, 200 connected minutes, $0.20/minute above, no trial or Founding 50.
- Direct instructions from Brock override the handoff's team/warm-transfer exclusions: build both, but do not advertise them as production-proven.
- Keep customer traffic gated while carrier approval and live acceptance evidence are incomplete. Never set proof flags merely to make a readiness endpoint green.

## 1. Core behavior and commercial gates

| Requirement | Implemented evidence | Remaining acceptance |
|---|---|---|
| Keep number; shop rings first | Overflow/after-hours configuration; conditional forwarding instructions | Verify each shop's actual carrier forwarding, ring timing and off-hours behavior |
| AI and recording disclosure | Direction-specific greeting; owner approval in `/app/setup`; refusal/recording-stop path | Jurisdiction-specific legal suitability and real recording behavior still require verification |
| Caller ID and full intake | Caller metadata, callback confirmation, address/category/equipment/access fields; transcription tuning | Live address, caller-ID and speech-quality tests on latest assistant configuration |
| Emergency overrides | Fixed gas/CO/fire/smoke/danger rules; sticky emergency state; immediate alert/callback; booking blocked | Real urgent SMS delivery within 60 seconds and spoken safety instruction tests |
| Exact service area | City+state and full ZIP matching; no radius or three-digit ZIP prefix expansion | Validate configured coverage with the first shop |
| Verified booking | Owner-confirm default; direct booking requires offered slot, confirmation, free/busy, write and readback | Real Google OAuth/write/readback/conflict proof |
| Approved prices/answers | Selection-only `/tools/approved-answer`; unknown keys refuse; no refund/discount tools | Free-form speech can still hallucinate; output enforcement and live red-team remain blockers to an absolute “never invents” claim |
| Evidence | Encrypted identity/transcript/recording references, tool events, booking evidence, notification states | Confirm actual recording retrieval and retention with live calls |
| Owned fallback | Durable callback even without SMS opt-in; emergency callbacks stay high priority | Provider-failure live call test |
| Isolated workspace | Self-serve signup, setup/settings, calls/usage, pause and individual call deletion | Full workspace export/deletion/offboarding still incomplete |
| Paid assisted activation | Active signed subscription required; no trial unlock; provisioning and live-proof gates | End-to-end live checkout/webhook/portal cancellation not exercised; owner pays before activation, with honest pending status |
| SMS approval | Fail-closed approval flag and separate customer-facing SMS flag | Campaign approval, sender assignment and real owner delivery still pending |
| Usage and overage | Dashboard metering and spam exclusion implemented | Automated overage invoices, subscription-cycle alignment and prepaid minute packs not implemented; current separate invoice workflow is operational/manual |

## 2. Security controls and adversarial evidence

- Automated backend suite tests discount injection, owner impersonation via unapproved keys, internal prompt/last-caller requests, absent privileged tools, emergency overwrite attempts, service boundaries, tenant/role boundaries and signed requests.
- New per-call locks serialize intake, handoff and booking state. Emergency status cannot be cleared by a later routine intake.
- Live assistant configuration updates serialize provider revision/rollback; config edits share tenant locks with team availability.
- Team identities and invitation secrets are encrypted; invitation tokens expire after 48 hours, are single-use and are consumed before account creation. Invitations are rate-limited.
- Native transfer targets start empty. Backend authorizes only the configured owner, excludes either call leg, canonicalizes phone formats and issues at most one transfer authorization per call. Durable callback/alert precedes transfer authorization.
- Important unresolved constraint: provider transfer response fields may expose the approved owner's number to the model. Warm transfer must not be described as satisfying strict hidden-destination isolation until provider behavior or server-side call control is verified.
- No live spoken red-team suite has passed. Tool tests do not prove that speech follows tool results, that the model always invokes triage immediately, or that it cannot reveal prompt text.
- After activation: review the first 20–50 consented calls for incorrect bookings, missed safety triggers, disclosure, invented answers, transcript/recording availability, notification latency, escalation loops, silence and hangup behavior. Log concrete failures and add regressions; never reuse private transcripts as public fixtures.

## 3. Mobile self-serve funnel

- Implemented: yellow mobile hero, explicit $49 CTA, visible AI/price/emergency/spam signals, labeled example alert, no sales/demo requirement, simplified business/email/password signup, isolated paused workspace, guided hours/area/calendar/answers/disclosure setup, paid checkout and billing portal cancellation.
- Retired `/start` qualification form: old links/submissions redirect to `/signup`.
- Owner testing is optional, never a mandatory activation prerequisite.
- Missing: safe optional self-call UI after setup; automated phone ownership verification/provisioning; measured cold-user under-five-minute completion; public Google OAuth publication/verification proof; production payment/cancel proof.
- No same-day activation SLA is promised while provisioning and carrier review are unresolved.

## 4. Teams, handoff, post-call experience and Spanish

- Teams: owner/member accounts, invitations/removal, independent Google credentials and hours, free-calendar round robin, original-calendar readback/deletion. Database migration validated on disposable PostgreSQL. Real multi-calendar OAuth/scheduling and scale tests remain.
- Warm transfer: native provider configuration and authorization foundation implemented, disabled by default. Need real owner answer, decline, voicemail, timeout, self-call and provider-failure tests; validate TeXML transfer compatibility. Not a production-ready claim.
- Post-call: mobile inbox, transcript/recording access, callback tasks and SMS links exist. Routine instant SMS remains a disclosed $10 add-on; emergency/handoff alerts are included. This differs from the handoff's literal “text every call” hero; do not imply every routine instant text is included in $49.
- Spanish intake is deliberately pending until core safety and the paid mobile path pass live acceptance. Do not advertise multilingual support yet.

## 5. Verification and independent review

- Website source through `336c0255` was merged into main by PR #1. The yellow hero, explicit paid CTA, varied lower layout, centered FAQ and restored five-item mascot receipt are live. The final closeout commit adds the billing regression below; its exact main/deployment SHAs are supplied in the chat handoff rather than inferred from this document.
- Commercial activation still returns 503, `provider_test`, with two reported blocking checks. The readiness report is not a substitute for validating the external credentials.
- The previously failing Telnyx key was replaced in the protected runtime. Assistant reads and updates now return HTTP 200; independent revocation of the old key was not checked. The latest test-assistant configuration was applied and read back: seven named webhooks (including `get_approved_answer`), native transfer and hangup; Deepgram Flux, aicoustics suppression and full conversation history. Existing voice settings were unchanged. The pre-update assistant response is backed up in the encrypted integration-secret store under `assistant_backup_pre_handoff_20261122`.
- Assistant initialization, TeXML status and messaging callbacks were read back at the existing Railway URL's `/webhooks/telnyx`; all seven tool URLs point to that same app. The one configured number is connected to the assistant's TeXML application. There is only one provider route, for the operator test workspace; per-customer assistant/number provisioning remains manual.
- Critical recording gap: the provider still reports `recording_settings.enabled=true`. `RECORDING_CONSENT_APPROVED=false` blocks commercial activation but does not itself disable provider recording. Prior-consent behavior has not been proven. Do not open this setup to unconsented customer traffic.
- A dedicated Google project and calendar-agent OAuth client were created in the requested organization account. Calendar API is enabled; only `calendar.events` and `calendar.freebusy` were declared. Branding uses the approved launch domain. Consent remains External/Testing and is not verified. New credentials are staged in protected Railway variables `GOOGLE_CLIENT_ID_NEXT` and `GOOGLE_CLIENT_SECRET_NEXT`; the current active client remains unchanged to avoid invalidating existing refresh tokens. A synthetic invalid-refresh-token probe returned `invalid_grant`, not `invalid_client`; this checks credential recognition, not calendar authorization.
- The approved custom hostname is registered in Railway but is not live: DNS still returned NXDOMAIN. Namecheap requires a CNAME named `frontoffice` pointing to `g9dz19pg.up.railway.app`. The in-app Browser was not signed into Namecheap, so no DNS records were changed. Domain/TLS/ownership verification, OAuth publication/review and a fresh calendar grant remain pending.
- Stripe is live. All three configured prices were read back active, USD/monthly, at 4900/500/1000 cents. The base price has zero subscriptions. No real payment, checkout completion or cancellation was performed. The restricted runtime key cannot read webhook configuration (HTTP 403 `more_permissions_required`); the four snapshot events are supported by the prior Workbench screenshots, not a fresh API readback.
- Fixed a reproduced billing bug: a delayed checkout receipt could change active or canceled subscription state to `incomplete`. Non-subscription events now produce no subscription write. Synthetic HTTP coverage includes signup, forged-signature refusal, a signed active update, delayed checkout, cancellation and checkout replay; this is not a real Stripe payment test.

- Latest closeout run: 94 tests passed, one PostgreSQL integration test skipped; TypeScript build and 15/15 local launch simulations passed. An earlier full run passed 91 tests with disposable PostgreSQL enabled. No production database was used for tests. Simulations are not live provider proof.
- All migrations applied successfully to an empty PostgreSQL 17 database and reran without reapplication.
- Mobile landing and simplified signup inspected in the in-app Browser. No Chrome access used.
- Gemini 3.1 Pro reviewed selected new source files, not the entire repository. Findings covered synchronization races, rollback uncertainty, phone normalization, invite spam, malformed event IDs and partial invite acceptance. Concrete fixes were added; rollback during total DB outage remains a fail-closed incident requiring reconciliation.
- Claude review unavailable: CLI returned HTTP 400, “Credit balance is too low.” No Claude approval claimed.
- Grok authored the supplied handoff; no separate completed code review by Grok is claimed.

## 6. Unresolved billing and cutover risks

- Subscription updates still trust snapshots rather than reconciling current provider state. Same-second subscription events/replays and processing-before-deduplication need an idempotent, tenant-serialized design; the checkout fix above does not solve these cases.
- Period-end parsing still reads only subscription-level `current_period_end`. Current Stripe API versions moved periods to subscription items; select the configured base-price item's period and add realistic API-version fixtures before relying on renewal dates.
- Signed subscription events are not yet strictly bound to the configured Front Office base price and existing customer/subscription identity. This matters because the Stripe account contains unrelated products. Checkout retries also use a new idempotency key per request, so durable session reuse remains open.
- The production database contains one configured operator test workspace, no owner/member accounts and no subscription rows. There are no onboarded customer tenants; external carrier forwarding has not been independently audited.
- Effective flags remain provider-test=true, messaging-approved=false, recording-approved=false, demo=false, founder-welcome=false (default/unset). The existing live-provider proof timestamp is set but does not certify the newly applied assistant configuration.
- Railway service source has no GitHub repo or image configured. Deploys are manual CLI uploads; pushing main does not deploy. PostgreSQL migrations run at container startup before the HTTP server. No down-migration/automatic database restore is supplied.

## Next release order

1. Verify the final source/deployment identifiers supplied in the chat handoff; preserve provider-test/commercial approval flags.
2. Latest assistant config is applied and inspected; run real calls only with consenting test participants.
3. Close speech-output enforcement and minimal-context gaps; run the full live adversarial/smoke matrix.
4. Verify Google booking, SMS delivery, checkout, webhook state, cancellation and per-shop routing.
5. Implement safe optional self-call, subscription-cycle overage billing and full offboarding; prove mobile setup time.
6. Verify warm transfer and team calendars, then add Spanish intake with bilingual safety tests.
7. Only after all commercial gates pass, record actual proof and disable provider-test mode.
