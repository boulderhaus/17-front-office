# Rosie (heyrosie.com): lessons for Front Office

Sources: founder walkthrough Rosie-walkthrough-Nov23.mov (16:16, screen only, no narration audio), rosie-voice-1.m4a (58 s), heyrosie.com (fetched 2026-11-23). Test business used: a real Sarasota HVAC shop's public website. Signup/account creation happened before the recording (URL opens on `setup?first_load=true`).

## Onboarding, step by step (video timestamps)

| # | Time | Screen | Asked | Clicks |
|---|---|---|---|---|
| 1 | 0:42 | "Welcome! Let's teach Rosie about your business." | Google Business Profile search AND/OR website URL. "Read-only scan" reassurance. | paste URL + Continue (2) |
| 2 | 0:50–1:45 | "Rosie is learning about your business." | Nothing. 4-step checklist (Analyzing / Processing / Optimizing for AI / Generating agent), progress bar, "this can take up to a minute or so", business card fills in live (logo, URL, address, overview). | 0, ~60 s wait |
| 3 | 1:47 | "Rosie is ready for a test call!" | Big "Tap to Call Rosie" + her number, 3 "Try asking..." questions tailored to the trade (e.g. "My AC stopped cooling the house"), "She won't have everything right yet, that's normal." On desktop the tel: link throws a Chrome "Open Phone?" dialog (founder cancelled). | 1 (Customize Rosie) |
| 4 | ~2:00 | Customize 1/5: agent name | Keep "Rosie" / choose my own | 1–2 |
| 5 | ~2:20 | 2/5: "How should Rosie sound?" | Female/Male tabs, ~12 voices with play previews (founder sampled ~8) | 2–10 |
| 6 | ~3:20 | 3/5: "Should Rosie help callers book appointments?" | Yes (then: Book directly / Text a booking link) / No / I'm not sure | 2–3 |
| 7 | ~3:50 | 4/5: "Should Rosie transfer callers to you?" | Yes / No / I'm not sure | 2 |
| 8 | ~4:05 | 5/5: "Should Rosie text info during the call?" | Yes / No / I'm not sure | 2 |
| 9 | 4:15 | Go Live = "What happens next?" + Choose a plan ($49/$149/$299) + "Finish setting up Rosie" checklist; app shell appears with persistent "7 days left in your free trial. Go live to accept customer calls." banner | Plan + credit card | not done |
| 10 | (not reached) | Settings > Launch Instructions | Forward Calls vs Use Rosie Number tile; Phone System Type dropdown; Provider dropdown; dial the shown code | ~5 + dialing |

- Time to "test-call ready": ~65 s, 2 clicks. Customize: ~2.5 min, ~10–15 clicks.
- Time to actually live: never reached in 16 min. Real path = 5 customize steps + plan + card checkout + separate Launch Instructions page with 2 dropdowns + dialing a code. Est. 20–25 clicks plus checkout plus leaving the app for carrier help docs.
- Before a card is added, only whitelisted test numbers ("Add Number") can reach Rosie.

## App layout / settings map

Left nav (5): Quick Start Guide, Conversations (empty inbox), Agent Settings, Integrations, Account. Plus a CRM-integration promo card and a trial/number footer.

Agent Settings (12 sub-pages, each a stack of cards, each card = Edit > modal > Save, then page-level Publish):
1. Business Information: training sources, name/address/phone/email/overview, core services, long "Agent Knowledge" blob, hours + holiday/special hours calendar, service areas.
2. Agent Profile: name, voice (~12), Tone (Casual/Cheerful/Formal), Talking Speed (5 steps), Background noise (Office/**Cafe**/None, "quiet, muffled cafe sounds"), Languages.
3. Greeting: Default vs Write My Own (tag editor), Legal Disclaimer toggle, Alternate Greeting by time of day.
4. FAQs. 5. Take a Message (named "scenarios" with "what should Rosie gather"). 6. Spam Filters (3 toggles + block list).
7. Appointments* (text booking link; direct calendar booking is Scale+). 8. Text a Link* (up to 20 link scenarios). 9. Transfer Calls* (Cold / Warm / Waterfall, up to 20 scenarios). 10. Custom Training* (file upload; "Custom Agent" $999+/mo). 11. Website Widgets (chat free, "website texting" $50/mo). 12. Launch Instructions.
(* = gold crown "Premium" badge.)

Account (4): Account settings (recordings clear, 3 "verification code" toggles for forwarding/Dialpad/Google Business Profile, SMS compliance), Notifications, Users (Admin only), Billing.

Count: ~16 settings pages, 20+ toggles/segmented controls, ~15 modals. Integrations: Acuity, Appointlet, Calendly, Google Calendar (OAuth took ~15 s), lead sources.

Publish model: edits are drafts until a top-right **Publish** button (turns green "Published"). Navigating away with unpublished edits fires a raw browser `confirm()`: "WARNING: You have unsaved changes..." (frame 04). Founder hit it while just browsing.

Readability: founder zoomed the browser to 67–90% about a dozen times; dense desktop UI with tiny gray type.

## Specific topics

**Recording disclosure**
- Default greeting: "Hello, thank you for calling {Company}. Our call may be recorded today for quality control purposes. My name is Rosie, how can I help you."
- Custom greeting editor uses tags [Company Name] [Legal Disclaimer] [Agent Name]; disclaimer toggle default ON with: "You can remove the disclaimer at any time, just know you assume any legal risk in doing so." Live text preview + audio Preview button (frame 03).
- Note: the voice-picker previews omit the disclaimer; the live greeting includes it.
- Site: "summary, transcript, and recording" for every call; no consent language on the marketing site.

**SMS / text messages**
- To callers: booking-link text ("{Business}: Schedule an appointment with the following link"), link scenarios ("{Business}: Here's the link you requested"), US/Canada numbers only.
- Double opt-in ON by default: first text "{Business}: Reply YES to receive info requested during call. May include promos. Msg & data rates may apply. STOP to cancel. Need help? {business phone}." Can be turned off with the same "you assume any legal risk" warning (frame 06).
- To owner: Notifications page with Email and Text (mobile number) channels, per-recipient type toggles: Message, Appointment, Call Transfers ON; Spam, Hang-ups OFF by default. Site also claims push via native iOS/Android apps.
- Warm transfer: "Save this number": Rosie calls the owner from one fixed number and announces caller name + reason before connecting.

**Call forwarding UX** (frame 05)
- Tile: "Forward Calls: send calls from your existing number to Rosie." Then Phone System Type (Cell Phone Networks / VoIP) + Provider dropdown (AT&T, Verizon, T-Mobile, Boost, Mint, Cricket, Consumer Cellular, Sprint, Vonage, Xfinity, US Cellular, OpenPhone, RingCentral, Google Voice, Dialpad...).
- Shows codes per carrier with Rosie's number embedded: unconditional, conditional (busy / no-answer separately), and the **disable** code; carrier notes ("Verizon doesn't support the iPhone call-forwarding toggle", "test from another phone", "iPhone: turn off Live Voicemail").
- "Need help?" and "Detailed instructions" go to an Intercom article (leaves the app). No automatic "is forwarding working?" check seen. Account page has opt-in toggles to receive carrier SMS verification codes (Google Voice) and Dialpad verification.

**"Use our number as your business number"**
- Second tile: "Use Rosie Number: share the agent's number as your new business line" > shows number + Copy button. Plans: "Pick your area code."
- Account toggle "Google Business Profile Verification": lets Google's verification call reach Rosie so the owner can put the Rosie number on his GBP listing. Smart detail for a new-number path.
- Forward and new-number can be combined ("or a combination of both").

## Voice

- The 58 s clip is **not a live call**. It is ~7 voice-picker previews back to back: identical script, pitch per clip ≈ 193, 267, 139, 147, 165, 134, 242 Hz (female, female, 4 male, female), matching the founder clicking through the "How should Rosie sound?" list at ~2:20–3:20.
- Greeting script: "Hi, thanks for calling {Business}. My name is Rosie. How can I help you today?" (~3–4 s each).
- Latency: **not measurable** from this sample (no caller turns; gaps are clicks). Rosie publishes no latency figures. Need a real call recording to measure turn gaps.
- Quality: clean enough that even whisper tiny.en transcribed every clip verbatim; natural prosody. Tells to note: optional fake "cafe" background noise (default selection in Agent Profile), persona name "Rosie" on every call.

## Steal (fits a 55-year-old owner in a truck)

1. Paste website or Google listing > auto-fill services, hours, service area, overview. Zero typing.
2. Test call before paying, with 2–3 trade-specific "try saying" prompts and the line "she won't be perfect yet."
3. Show the carrier's **turn-off** code next to the turn-on code; add their iPhone Live Voicemail + "test from another phone" notes to our "Check it for me."
4. Recording disclosure baked into the default greeting, on by default (Florida is all-party consent).
5. "Use this as your new business number" option with one Copy button and area-code pick; help him verify it on his Google listing.
6. Caller texts start with a compliant opt-in (Reply YES / STOP / HELP) by default, no setting exposed.
7. Owner alert defaults: messages + bookings on, spam + hang-ups off. Ship the defaults, hide the toggles.
8. Pricing contrast: Rosie gates calendar booking behind $149 Scale; we include it at $49. Say it.

## Avoid

1. 16 settings pages, 12 Agent Settings sub-sections, modal-per-edit.
2. Draft/Publish model with browser "unsaved changes" alerts. Autosave everything.
3. Crown badges, upgrade buttons, trial banner and CRM promo on every screen.
4. Voice/name/tone/speed/background-noise pickers in onboarding (12 voices, 5 speeds).
5. Go-live buried after checkout on a separate page with 2 dropdowns and an external help article.
6. "I'm not sure" tri-state questions and scenario builders (message, link, transfer, waterfall).
7. Tiny desktop-first UI; tel: test-call link that pops a desktop dialog.
8. Fake ambient noise and test calls locked to whitelisted numbers until a card is added.

## Frames

- `frames/01-ready-for-test-call.jpg`: instant test-call screen with tailored prompts.
- `frames/02-onboarding-booking-question.jpg`: one-question-per-screen customize step (3/5).
- `frames/03-greeting-recording-disclaimer.jpg`: greeting tags + Legal Disclaimer toggle + legal-risk warning.
- `frames/04-settings-nav-unsaved-changes-publish.jpg`: full settings tree, premium badges, unsaved-changes alert.
- `frames/05-launch-forwarding-instructions.jpg`: Forward vs Use Rosie Number, carrier dropdowns, Verizon codes incl. disable.
- `frames/06-sms-double-optin.jpg`: SMS double opt-in default text (business phone redacted).
