# Goodcall teardown: lessons for Front Office

Sources: founder screen recording 2026-11-23 (15:00, no audio track, so no narration to transcribe), 3 voice samples (transcribed locally with faster-whisper small.en), goodcall.com home, /pricing and /how-it-works (fetched 2026-11-23).

Heads-up: the website sells a newer product ("Gabi" builds your agent by chat). The app in the recording is the older `ai.goodcall.com` wizard and dashboard. The app's prices don't match the site's (see Pricing).

## 1. Onboarding, step by step (recording 5:18–11:30)

| Time | Screen | What happened |
|---|---|---|
| 5:18 | Log in (Welcome Back) | The site's "Get started" lands on a **login** page. The user has to find "Sign up" |
| 5:21 | Step 1/5: "Let's start with your business phone number" | Google Maps lookup by phone. Plan: "I'm not on Google Maps" |
| 5:30–6:00 | (detour) | Founder opened another tab to look up the shop's number |
| 6:05 | Step 2/5: "I didn't find your #… learn from a website" | Pastes URL, "Train from site" |
| 6:15–7:20 | Step 3/5: "Choose your Goodcall agent" | 6 cartoon avatars (Rosie, Alex, Graham, Hero, Johnny, Bella). A full-width blue Preview bar plays each voice. ~1 min spent auditioning |
| 7:23–7:58 | Training interstitial, ~35 s | "Learning the basics… building profile… understanding goals… loading preview" |
| 8:00 | "Double check… info I pulled from your site" | Name, address and phone prefilled from scrape, then "Preview agent" |
| 8:15–9:30 | "Preview what I've learned" | 3 play buttons (Greeting, Appointment, Pricing), then "Get full demo". **Good: you hear it before signup** (frames/01) |
| 9:35 | Step 4/5: "Demo calls require a verified cell" | Cell number + 4-digit SMS code |
| 9:44–10:50 | (detour) Tried the new "Talk to Gabi" flow in another tab | One centered column: business name/category/timezone → "Welcome to Goodcall" build animation → persona pick (Bree/Dash/Vera) **with a "Not saying '[shop]' right?" link** (frames/02) → verify phone. Abandoned it and went back to the old wizard |
| 10:55–11:30 | Step 5/5: "Sign up to unlock your full demo" | Google SSO or a name/email/password form, then the browser's save-password popup, then the dashboard |
| 11:45 | Dashboard | The **"Get Goodcall #"** red button leads to "Try 14 days free" → plan picker (with a countdown: the number is held for 1:56) → Stripe card form → "Start 14 day trial" |

- **Time to go live: never reached in 15 min.** About 6 min of pure wizard (5:18→11:30, ignoring detours) gets you a *demo* agent only. Going live needs a card, a plan, and then forwarding setup, none of which was reached on camera.
- **Clicks:** ~18–22 clicks plus 5 typed fields (phone, URL, cell, OTP, account) before the dashboard, then ~5 more plus card entry for a number. Our target is 3.
- Two onboarding flows exist at the same time (old 5-step wizard and new Gabi chat). The site's CTA and the post-login flow disagree. That's confusing.

## 2. Dashboard / settings map (old app)

Left nav: **Skills** (badge "Review") · Documents · Flows · Directory · Performance · Tools · Settings. Footer: "Starter / Demo" plan pill.

- **Skills / Knowledge** (frames/03): source chips (Google Places, Website, Zapier), then two lists of "skills". Each row is a trigger phrase plus an action chip.
  - Greeting / Operator / Goodbye
  - Appointment (Form) / Location (Answer) / Pricing (Form) / Spam Blocker (Block) / Take Message
  - "+" opens "Teach your agent new skills": Open Hours, Take Orders, Change Appointment, Business Description… or "Create your own skill"
- **Skill editor** (frames/04): the Action dropdown offers Give quick answer / Send link / Take message / Transfer call / Form / Logic. "Logic to follow", "Agent will say", "Then agent will ask". This is a node editor wearing a list costume.
- **Flows:** Forms (1/1 used) and Logic (1/1 used) are plan-capped, plus a "How to activate?" link. The cap is hit on the free tier immediately.
- **Performance:** Total calls, action breakdown, interaction rate, flows started, completion rate, links sent, clickthrough. All zeros, four donut charts.
- **Tools:** Google Sheets connector ("Trigger advanced automation using formulas").
- **Settings:** Agent profile (location name, type, business #), Link tracking (Goodcall branding toggle), Manage users.
- **Account:** General (personal info, **Call reports: Daily/Weekly, SMS/Email**), Plans & Billing, Team, red "DELETE YOUR ACCOUNT".

### Layout problems (desktop vs phone)
- **Giant full-width "Preview" bar** (frames/04): a ~790px saturated blue pill across the whole content column, the loudest thing on the page, above a plain dropdown. The same full-width primary bars appear in the wizard ("Choose Rosie", "Get full demo"). On desktop they read as banners, not buttons. They only make sense at phone width.
- **The founder zoomed the browser to 75% and then 67%** to fit dashboard screens. The type and spacing scale is off for a laptop.
- **The red "Get Goodcall #" button sits on every screen** (top right), competing with each page's own primary action.
- **The wizard frame floats** a white card between huge decorative teal and navy triangles. Half the viewport is ornament, and on desktop the card is small while the mascot is huge.
- **Jargon** the owner has to learn: skills, flows, forms, logic, directory contacts, workers, external tools.
- **Empty dashboards** (4 donuts at 0%) on day one instead of "here's what happens on your first call".
- **The new Gabi flow is a single 360px centered column on desktop**: phone-first, but it looks like a lost mobile page on a 1440px screen.

## 3. Numbers, forwarding, SMS, recording, publish

- **Number options:** a new local Goodcall number (included in every plan), or forward your existing line. The site claims guides for 24 carriers. You choose "answer every call" or "only when busy/no answer". The product hides forwarding behind the card paywall, so it wasn't seen in the recording.
- **Number hold countdown** ("held for 1:56") on the plan picker is a pressure tactic.
- **SMS:** a verified cell is required for the demo (OTP). Owner gets call reports by SMS/email (daily or weekly, sent at 10:00 am). The site says leads are texted and emailed *during* the call, and failed transfers text you.
- **Transfers:** up to 3 people in sequence, with a retry on busy (site).
- **AI disclosure:** the HVAC sample opens with "an AI agent for [shop]". The FAQ says callers are told it's an AI. The site's dental and realty greetings don't disclose.
- **Recording:** "Every call recorded and transcribed." There's no consent or "this call may be recorded" line in any sample, and the site doesn't address it (Florida is two-party consent, so we must).
- **Publish model:** site: "nothing changes until you approve it", with **Publish / Roll back** and a before/after diff. Old app: per-skill Save ("Skill saved successfully" toast), no staging.

## 4. Voice

| Sample | Content |
|---|---|
| voice-1 (23 s) | Two site demo greetings: "[Dental office], this is Alex. How can I help you?" / "Good afternoon. Thanks for calling [realty]. This is Hiro speaking. How can I help you?" Short, human, no AI disclosure |
| voice-2 (48 s) | Persona audition blurbs (Alan/Rosie/Hiro/Graham): "go-to summer intern…", "blend of class, quiet confidence". Marketing fluff an HVAC owner won't care about |
| voice-3 (76 s) | Real-ish HVAC call. Greeting: "Hi, I'm Graham, an AI agent for [shop]. I can help with appointments, pricing or answer any questions you may have. How can I help you?" (**8 s greeting**) |

**Latency** (voice-3; time from end of caller speech to agent's first word, from whisper word timestamps, about ±0.15 s): 0.78, 0.62, 0.78, 0.46, 0.42, 0.62, 0.76, 0.70 s. **Median ~0.65 s, range 0.42–0.78 s.** That's fast and doesn't feel laggy. (silencedetect was unusable because the clip has a high noise floor.)

**Quality / robotic tells (voice-3):**
- A rigid form script: phone OK? → first name → last name → service → timeline → phone again.
- **Asked "is this the best number" twice** in one call.
- **Ignored a real question** ("what services do you offer?") and moved to the next form field.
- **Caller asked "What are your prices?" mid-form, and the bot restarted the whole intake from the top** ("I can help with that. I just need to collect a few quick pieces…").
- Splits first and last name into two turns. Never confirms address or problem.
- The voice timbre is natural. The *dialogue logic* is what sounds robotic.

## 5. Website

### Pricing (site, current)
| Plan | $/mo | Included | Overage | ≈calls |
|---|---|---|---|---|
| Starter | $79 | 100 unique callers | 79¢ each | ~150 |
| Growth (most popular) | $129 | 500 | 26¢ | ~750 |
| Scale | $299 | 2,000 | 15¢ | ~3,000 |
| Enterprise | custom | >2,000, SLA | volume | |

- The billing unit is a **unique caller per month**: repeat callers count once, and spam and wrong numbers are free. No minutes, calls or tokens.
- Feature caps are expressed in jargon: workers, external tools, "5× AI usage", team members, call-history days.
- Trial: a free demo agent, and you pay only when you connect a number.
- **The in-app plan picker disagrees with the site:** $79/100, $129/**250**, $**249**/**500**, a flat $0.50/customer overage, "unlimited minutes and tokens", and annual billing saves 15% (frames/05 vs frames/06). That kind of mismatch erodes trust.
- Why it reads easily: one headline promise ("No per-minute charges. A bill you can predict."), one number per tier, a tagline that names the buyer ("solo operator who misses calls on the job"), and a FAQ that does the math against a live answering service ($1.50–$1.90/min vs ~13¢/min).

### FAQ lists
- **Home:** What is a Goodcall number? · Can I keep my existing business number? · How do callers react to an AI? · Can I change what my agent says? · What happens when my agent can't answer something?
- **How it works:** What is an AI answering service? · Will it sound robotic? · What happens when it can't answer? · Can it book appointments? · What languages? (English only) · Do I need a new phone number? · How much does it cost?
- **Pricing:** What counts as a unique customer? · Any charges for minutes, calls or tokens? · What if I go over? · How does this compare to an answering service? · Do I pay for a number? · External tool? · Worker? · Agent-powered edits? · AI usage? · Free trial?

### Copy and animation patterns that work
- **The hero mock is a live animated card** ("Rosie's Plumbing · Example") that cycles through tabs *Build → Capture → Book*. It types the greeting, then plays a short transcript ("do you do water heater installs?"), then shows a calendar booking. The whole product is shown in a ~10 s loop without reading anything.
- **3-step strip:** Build · Test · Approve, each with an icon and one sentence. How-it-works expands this to Build/Test/Launch/Learn plus a **call timeline with timestamps** (0:00 greet → 0:04 asks → 1:32 lead texted → 1:40 transfer), which makes "what happens on a call" concrete.
- **"Pick a job" tabs** (Lead capture / Booking / CRM / E-commerce): each tab swaps in a small "Example" panel with numbered steps.
- **"Change it by saying so"**: a before/after diff card with strike-through and Publish/Roll back. It makes editing feel safe.
- **"Practice calls" card**: scenario list (leaking water heater, asks for prices, after hours, wants the owner), each with a green "Passed".
- **Headlines are short and plain:** "Brief it like a new hire." "It asks what you'd ask." "Every call, on the record." "Your next customer is already dialing."
- Every mock is labelled "Example", so it's honest without disclaimers.
- Trust block: "Born at Google" (2017), SOC 2 / HIPAA chips, two press links. It's one compact section, not a logo wall.
- Weak spots: the hero subhead uses "voice agent technology" jargon, the bottom of the page has dev-blog filler ("GoHighLevel MCP", "Voice Activity Detection"), and "Talk to Gabi" is an ambiguous CTA for a 60-year-old.

## 6. Steal (max 8)
1. **Hear it before signup.** Scrape the site, play Greeting / Appointment / Pricing clips with no account needed. An owner trusts what he hears.
2. **Prefill from Google listing / website, then "double check".** He confirms instead of typing. That's the right effort for a truck-cab user.
3. **"Not saying [shop] right?" link.** A one-tap pronunciation fix. Mangling the name is the #1 embarrassment risk.
4. **Unique-caller pricing told as one sentence** ("no per-minute charges, a bill you can predict") **plus an answering-service cost comparison.** Owners already think in "what does my answering service cost me".
5. **Animated example card in the hero** that plays a real-looking HVAC call → text to owner → calendar booking. It shows the whole promise in 10 s.
6. **Timestamped call timeline** ("0:04 asks for address… 1:32 texts you the lead") to explain triage and the owner text.
7. **Plain-English FAQ that names the fears:** "Will it sound robotic?", "Can I keep my number?", "What if it can't answer?", "What if I go over?"
8. **Approve-before-live with one-tap Roll back.** It lowers the owner's fear of the AI saying something wrong.

## 7. Avoid (max 8)
1. **A 5-step wizard plus a separate account step plus a card wall before a number.** That's ~25 clicks and >6 min with no live line. Ours is 3 clicks.
2. **A login page as the landing for "Get started"** and two competing onboarding flows.
3. **Full-width saturated buttons and bars on desktop** (Preview bar, Choose X). Cap the button width and let the layout breathe at 1280+ while staying phone-first.
4. **Skills / Flows / Forms / Logic / Directory jargon and plan caps on them.** Our owner wants intake + booking, not a bot builder.
5. **A rigid form script that ignores questions and restarts on interruption.** Answer the question, then resume where it left off, and never re-ask a captured field.
6. **An 8-second greeting that lists capabilities.** Keep "Thanks for calling {shop}. How can I help?" (with a short AI/recording disclosure that fits Florida consent).
7. **Pressure and mismatch tactics:** number-hold countdowns, and in-app prices that differ from the website. Owners 45–65 smell this.
8. **Six-avatar voice auditions and persona bios** ("summer intern"). Pick one good default voice and offer a swap later.

## Frames
- `frames/01-preview-agent-before-signup.png`: hear-before-signup panel (steal)
- `frames/02-persona-pick-plus-pronunciation-fix.png`: new Gabi flow, pronunciation-fix link (steal); centered narrow column on desktop
- `frames/03-skills-dashboard.png`: skills list, jargon chips, red "Get Goodcall #" on every page
- `frames/04-fullwidth-preview-bar.png`: the giant full-width button and the node-editor dropdown
- `frames/05-inapp-plans-number-countdown.png`: in-app prices ≠ site, number-hold countdown (number redacted)
- `frames/06-site-pricing-table.jpg`: site pricing table (the presentation the founder liked)
