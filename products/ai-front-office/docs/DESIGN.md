# Call Otto design rules

Read this before building or changing any Call Otto screen: marketing, sign-in, signup or the owner app. The rules come from Brock's corrections and the design skills he chose. Review your screenshots against this list before you ship.

Skills to load for UI work, all installed in `~/.claude/skills`:
- frontend-design
- shadcn
- tailwind-design-system
- accessibility
- web-design-guidelines
- vercel-react-best-practices
- vercel-composition-patterns
- design-motion-principles

## Brock's rules (from his own corrections)

- **Few words.** Every screen says one thing, in short plain lines a busy tradesperson reads in two seconds. Cut repeated explanations, and never stack three paragraphs under a button. Why: "we have way too many words."
  <!-- 2026-11-24: homepage copy too wordy; 2026-11-25: setup card too wordy -->
- **Never make the owner change phone settings to get started.** Fit the product around the phone they already have. A settings change can only be an option the owner picks, such as "Ring my phone first" needing Live Voicemail off. Why: "we can't have the user do a bunch of things to set it up."
  <!-- 2026-11-25 -->
- **Sign-in and sign-up are two choices: Google (and Microsoft), or Continue with email.** Email opens the email box, then the password box, with "Email me a sign-in link instead" as a small second choice. One "or" at most. Sign-up asks for the account first, then the shop (name and mobile) once they're in; never the trade. Why: "two buttons Google or email", three "or"s looked wrong (walk 11-26).
  <!-- 2026-11-25 -->
- **Fields must be easy to read.** Typed text is at least 16px (18px preferred), sans-serif, weight 500, dark ink on white, with a visible focus ring. Never a light, thin serif inside a field. Why: "why is it so hard to see my email in this box."
  <!-- 2026-11-25 -->
- **Owner app navigation is a left sidebar** on desktop and a left drawer behind a hamburger on phones, in the style of Cloudflare's dashboard. Use calm neutral surfaces and outline icons. A bottom tab bar only belongs in a native app.
  <!-- 2026-11-25: sent Cloudflare mobile screenshots -->
- **Speed is the product.** Setup steps and tests finish in seconds, and the screen says how long something takes ("Otto picks up in a few seconds").
- **Never show Brock's phone number or address** on the site or in emails, except where the law requires it on Terms and Privacy.
- **Make one tap do the whole job where the platform allows it.** Where it doesn't (iPhone blocks forwarding-code links), say exactly what to do in one line.

## Checklist (from the skills, measured)

- **Type:** body text at least 16px with line-height 1.4–1.6; nothing below 12px, consent text included. At most two typefaces, and the display face is for headings only. Headings use `text-wrap: balance`.
- **Color:** text contrast at least 4.5:1 (3:1 for 24px and up). Borders, focus rings and icons at least 3:1. Placeholders get an explicit color of at least 4.5:1 and are examples, never labels. Never show state by color alone. Use semantic tokens only.
- **Forms:**
  - Every control has a visible label tied to it with `for`/`id`; hints are linked by `aria-describedby`.
  - Use the right type, inputmode and autocomplete (`username`, `current-password`, `tel`, `one-time-code`). Email fields get `spellcheck="false" autocapitalize="none"`.
  - On error: keep what the user typed, show the error next to the field with `aria-invalid`, put a `role="alert"` summary at the top, and move focus to the first bad field. Error text names the fix.
  - The submit button shows a busy state and blocks double submits.
- **Focus and keyboard:** a `:focus-visible` outline of 2–3px with 2px offset on everything. Use native buttons and links only. Tab order follows the visual order.
- **Touch:** targets at least 44×44px with 8px between them, standalone links included. Design mobile-first and test at 320, 375, 768, 1024 and 1440px with no sideways scroll. Respect safe areas.
- **Semantics:** one h1 that names the task, headings in order, landmarks. Async updates go in one polite live region and one toast host.
- **Motion:** animate only transform and opacity, 150–300ms, never `transition: all`. Everything off under `prefers-reduced-motion`. No infinite pulses.
- **Owner app:** shadcn primitives before custom CSS (Button, Field, Sheet, Dialog with a title, Alert, Skeleton, sonner). Skeletons at final size. Explicit empty states.
- **Auth:** provider buttons follow each provider's official branding, with equal prominence and an "or" divider.
- **Ship gate:** render at 375px and 1280px, look at every screenshot, Tab through the page and check contrast for every new color pair.
