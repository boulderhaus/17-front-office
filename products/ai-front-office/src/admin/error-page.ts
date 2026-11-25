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
.brand{display:inline-flex;align-items:center;min-height:44px;color:var(--ink);font-weight:650;font-size:18px;text-decoration:none}.brand em{font-family:Georgia,serif;font-style:italic;font-weight:500}
main{max-width:34rem;margin:0 auto;padding:48px 16px}
h1{margin:0 0 8px;font-size:28px;line-height:1.2;letter-spacing:-.01em;text-wrap:balance}
p{margin:0 0 24px;color:var(--muted)}
.back{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 20px;border-radius:10px;background:var(--yellow);color:var(--ink);font-weight:650;text-decoration:none}
a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
</style></head><body><header><a class="brand" href="/">Call&nbsp;<em>Otto</em></a></header><main><h1>${e(input.title)}</h1><p>${e(input.message)}</p><a class="back" href="${e(input.back.href)}">${e(input.back.label)}</a></main></body></html>`;
}

/**
 * The phone side of the computer's QR: the forwarding code for one business number, big, with the one way this phone
 * can dial it (Android: a link that opens the dialer filled in; iPhone: press and hold to copy, then paste in Phone).
 * Leaving every call for ring first, the clear-it-first code comes first, as on the computer (forward-all wins over
 * the ring-first code).
 */
export function renderDialHandoff(input: { businessNumber: string; code: string | null; what: string; dialLink: string | null; device: "iphone" | "android" | "other"; clearFirst?: { code: string; dialLink: string | null } | null }): string {
  const chunks = input.code ? e(input.code) : "";
  const action = !input.code ? `<p>${e(input.what)}</p>`
    : input.device === "android" && input.dialLink ? `<a class="back" href="${e(input.dialLink)}">Tap to dial</a><p class="next">Then tap Call.</p>`
      : input.device === "iphone" ? `<p class="next">Press and hold the code, tap Copy, then paste it in Phone › Keypad and tap Call.</p>`
        : `<p class="next">Dial it in your Phone app’s keypad and tap Call.</p>`;
  const clear = input.clearFirst
    ? `<p class="next">Dialed the every-call code before? First dial this to clear it:</p><div class="code">${e(input.clearFirst.code)}</div>${input.device === "android" && input.clearFirst.dialLink ? `<a class="back alt" href="${e(input.clearFirst.dialLink)}">Tap to dial ${e(input.clearFirst.code)}</a>` : ""}<p class="next">Then:</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="format-detection" content="telephone=no"><title>Your forwarding code · Call Otto</title><style>
:root{--ink:#0b2545;--paper:#faf8f1;--muted:#5d6676;--yellow:#e9f447;--border:#e6e1d3}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:var(--paper);color:var(--ink);font:400 17px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;min-height:56px;padding:0 16px;border-bottom:1px solid var(--border)}
.brand{font-weight:650;font-size:18px}.brand em{font-family:Georgia,serif;font-style:italic;font-weight:500}
main{max-width:34rem;margin:0 auto;padding:28px 16px 48px;display:grid;gap:14px}
h1{margin:0;font-size:24px;line-height:1.25;text-wrap:balance}
.code{padding:14px 8px;border:2px solid var(--ink);border-radius:12px;background:var(--yellow);text-align:center;font:700 clamp(20px,6.4vw,28px)/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:all;-webkit-user-select:all;overflow-wrap:anywhere}
p{margin:0}.next{font-weight:600}.muted{color:var(--muted);font-size:15px}
.back{display:flex;align-items:center;justify-content:center;min-height:52px;border-radius:10px;background:var(--ink);color:#fff;font-weight:650;text-decoration:none}
.back.alt{background:#fff;color:var(--ink);border:2px solid var(--ink)}
a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
</style></head><body><header><span class="brand">Call&nbsp;<em>Otto</em></span></header><main><h1>Dial this on ${e(input.businessNumber)}</h1>${clear}${input.code ? `<div class="code">${chunks}</div>` : ""}${action}<p class="muted">This link works for 15 minutes.</p></main></body></html>`;
}
