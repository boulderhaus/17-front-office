import { NO_SWITCH_LINK, OLDER_IPHONE_LINE, SETTINGS_OFF_LINE, SETTINGS_ON_STEPS } from "../domain/forwarding-steps.js";
import { escapeHtml as e } from "./render.js";

/**
 * A browser that asked for a page and hit an error gets a page, never raw JSON: the app's paper and ink, one line on
 * what happened, and a way back. JSON clients (the owner app's API, webhooks, voice tools) keep the JSON error.
 */
export function renderErrorPage(input: { status: number; title: string; message: string; back: { href: string; label: string } }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(input.title)} · Call Otto</title><style>
:root{--ink:#0b2545;--paper:#faf8f1;--muted:#5d6676;--yellow:#e9f447;--border:#e6e1d3}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:var(--paper);color:var(--ink);font:400 17px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;min-height:56px;padding:0 16px;border-bottom:1px solid var(--border)}
.brand{display:inline-flex;align-items:center;gap:10px;min-height:44px;color:var(--ink);font-weight:650;font-size:18px;text-decoration:none}.brand em{font-family:Georgia,serif;font-style:italic;font-weight:600}.brand b{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:var(--yellow);color:var(--ink);font:900 13px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.02em}
main{max-width:34rem;margin:0 auto;padding:48px 16px}
h1{margin:0 0 8px;font-size:28px;line-height:1.2;letter-spacing:-.01em;text-wrap:balance}
p{margin:0 0 24px;color:var(--muted)}
.back{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 20px;border-radius:10px;background:var(--yellow);color:var(--ink);font-weight:650;text-decoration:none}
a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
</style></head><body><header><a class="brand" href="/"><b aria-hidden="true">CO</b><span>Call&nbsp;<em>Otto</em></span></a></header><main><h1>${e(input.title)}</h1><p>${e(input.message)}</p><a class="back" href="${e(input.back.href)}">${e(input.back.label)}</a></main></body></html>`;
}

/**
 * The phone side of the computer's QR (and the "Email me these steps" link): one forwarding code for one business
 * number, big, with the one way this phone can dial it (Android: a link that opens the dialer filled in; iPhone:
 * press and hold to copy, then paste in Phone). One code per screen, never two that could be dialed as one string:
 * when our test found every call still forwarded, the clear code comes first and "Next" opens the shop's code.
 * `settings` (every call, or clearing it, on a GSM-family iPhone): the iPhone's Call Forwarding switch instead, with
 * the code flow unchanged behind "Don't see Call Forwarding?" (forwardingSteps decides).
 */
export function renderDialHandoff(input: { businessNumber: string; code: string | null; what: string; dialLink: string | null; device: "iphone" | "android" | "other"; family?: string | null; clearFirst?: { code: string; dialLink: string | null } | null; nextHref?: string | null; settings?: { ottoNumber: string; digits: string } | null; retry?: "clear" | "clear_again" | "instead" | "help" | null }): string {
  const clearing = Boolean(input.clearFirst);
  // Ring first that never rang, tried again: the all-forwarding clear code, another code, or no more codes.
  const retry = input.retry ?? null;
  const code = clearing ? input.clearFirst!.code : input.code;
  const link = clearing ? input.clearFirst!.dialLink : input.dialLink;
  // What the carrier shows once a code goes through, said before they dial it.
  const after = input.family === "verizon" ? "You’ll hear a tone. Hang up and come back here." : input.device === "iphone" ? "Your carrier shows a gray box that says Succeeded. Tap Dismiss and come back here." : "Your phone shows a message that it worked. Close it and come back here.";
  const how = input.device === "android" && link ? `<a class="back" href="${e(link)}">Tap to dial</a><p class="next">Then tap Call.</p>`
    : input.device === "iphone" ? `<ol><li>Press and hold the code, tap Copy.</li><li>Open Phone, tap Keypad.</li><li>Press and hold the number line, tap Paste, then Call.</li></ol>`
      : `<p class="next">Dial it in your Phone app’s keypad and tap Call.</p>`;
  const next = clearing && input.nextHref ? `<a class="back alt" href="${e(input.nextHref)}">Next: your code</a>` : "";
  const lead = clearing
    ? (retry === "clear_again" ? "Your phone still never rang. Dial this first to clear all forwarding." : "Every call is still being forwarded. Dial this first to clear it.")
    : retry === "instead" ? "That code didn’t work on this phone. Try this code instead." : "";
  const codeFlow = retry === "help" && !clearing ? `<p class="next">Ring first didn’t work on this phone.</p><p>On the setup page, tap Call me now and our team helps you set it up. Or pick Otto answers every call.</p>`
    : !code ? `<p>${e(input.what)}</p>`
    : `${lead ? `<p class="next">${e(lead)}</p>` : ""}<div class="code">${e(code)}</div>${how}<p class="muted">${e(after)}</p>${next}`;
  const settings = input.settings && code ? input.settings : null;
  const body = !settings ? codeFlow
    : clearing
      ? `<p class="next">Every call is still being forwarded. Turn that off first.</p><p>${e(SETTINGS_OFF_LINE)}</p>${next}<details><summary>${e(NO_SWITCH_LINK)}</summary><div class="alt-flow">${codeFlow.replace(next, "")}</div></details>`
      : `<div class="num">${e(settings.ottoNumber)}</div><button type="button" class="back" data-copy="${e(settings.digits)}" hidden>Copy number</button><p class="muted" data-copy-hint>Press and hold the number, tap Copy.</p><ol>${SETTINGS_ON_STEPS.map((step) => `<li>${e(step)}</li>`).join("")}</ol><p class="muted">${e(OLDER_IPHONE_LINE)}</p><details><summary>${e(NO_SWITCH_LINK)}</summary><div class="alt-flow">${codeFlow}</div></details><script src="/assets/copy-number.js" defer></script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="format-detection" content="telephone=no"><title>Your forwarding code · Call Otto</title><style>
:root{--ink:#0b2545;--paper:#faf8f1;--muted:#5d6676;--yellow:#e9f447;--border:#e6e1d3}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:var(--paper);color:var(--ink);font:400 17px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;min-height:56px;padding:0 16px;border-bottom:1px solid var(--border)}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:650;font-size:18px;color:inherit;text-decoration:none}.brand em{font-family:Georgia,serif;font-style:italic;font-weight:600}.brand b{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:var(--yellow);color:var(--ink);font:900 13px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.02em}
main{max-width:34rem;margin:0 auto;padding:28px 16px 48px;display:grid;gap:14px}
h1{margin:0;font-size:24px;line-height:1.25;text-wrap:balance}
.code,.num{padding:14px 8px;border:2px solid var(--ink);border-radius:12px;background:var(--yellow);text-align:center;font:700 clamp(20px,6.4vw,28px)/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:all;-webkit-user-select:all;overflow-wrap:anywhere}
p{margin:0}.next{font-weight:600}.muted{color:var(--muted);font-size:15px}
ol{margin:0;padding-left:1.3em;display:grid;gap:6px;font-weight:600}
.back{display:flex;align-items:center;justify-content:center;min-height:52px;border-radius:10px;background:var(--ink);color:#fff;font-weight:650;text-decoration:none}
.back.alt{background:#fff;color:var(--ink);border:2px solid var(--ink)}
button.back{width:100%;border:0;font:inherit;font-weight:650;cursor:pointer}button.back[hidden]{display:none}
.num{font-family:inherit;white-space:nowrap}
details summary{display:flex;align-items:center;min-height:44px;cursor:pointer;font-weight:600;text-decoration:underline;text-underline-offset:4px}
details .alt-flow{display:grid;gap:14px;padding-top:6px}
summary:focus-visible,button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
</style></head><body><header><span class="brand"><b aria-hidden="true">CO</b><span>Call&nbsp;<em>Otto</em></span></span></header><main><h1>${retry === "help" && !clearing ? "Let’s set up" : clearing ? "Clear the old forwarding on" : retry === "instead" ? "Try this code on" : settings ? "Forward calls on" : "Dial this on"} ${e(input.businessNumber)}</h1>${body}<p class="muted">This link stops working soon. Get a new one on your computer.</p></main></body></html>`;
}
