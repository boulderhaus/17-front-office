import { escapeHtml } from "./render.js";

export type ReviewAccountView =
  | { state: "ready"; email: string; password: string; loginUrl: string; created: boolean }
  | { state: "error"; message: string };

const STYLE = `<style>
:root{color-scheme:light}*{box-sizing:border-box}
body{margin:0;background:#f1efe7;color:#073f77;font:17px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px 48px}
.eyebrow{margin:0 0 8px;font-weight:800;font-size:13px;letter-spacing:.1em;text-transform:uppercase}
h1{margin:0 0 20px;font-size:clamp(30px,7vw,44px);line-height:1.05;letter-spacing:-.03em}
.card{background:#fffef8;border:2px solid #0759a8;box-shadow:6px 6px 0 #0759a8;padding:20px;margin:0 0 24px}
dl{margin:0}dt{font-weight:800;font-size:14px;margin:0 0 4px}dd{margin:0 0 16px}dd:last-child{margin:0}
code{display:inline-block;max-width:100%;overflow-wrap:anywhere;padding:8px 10px;background:#fff;border:2px solid #0759a8;font:600 18px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#0a2540;user-select:all}
.note{font-size:15px}.error{border-color:#b42318;box-shadow:6px 6px 0 #b42318;color:#a41d12}
ol{margin:0;padding-left:22px}li+li{margin-top:6px}a{color:#0759a8}
</style>`;

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>Google OAuth review account · Call Otto</title>${STYLE}</head><body><main><p class="eyebrow">Call Otto admin</p><h1>Google OAuth review account</h1>${body}</main></body></html>`;
}

/** /admin/review-account: the review account's sign-in, shown once. Opening the link again makes a new password. */
export function renderReviewAccount(view: ReviewAccountView): string {
  if (view.state === "error") return page(`<section class="card error" role="alert"><p>${escapeHtml(view.message)}</p></section>`);
  return page(`<p>${view.created ? "Created." : "Ready. This is a new password; the one before it no longer works."}</p>
<section class="card"><dl><dt>Email</dt><dd><code>${escapeHtml(view.email)}</code></dd><dt>Password</dt><dd><code>${escapeHtml(view.password)}</code></dd></dl></section>
<p class="note"><strong>Shown once.</strong> Copy it now. Opening this link again makes a new password and the old one stops working.</p>
<section class="card"><ol><li>Sign in at <a href="${escapeHtml(view.loginUrl)}">${escapeHtml(view.loginUrl.replace(/^https?:\/\//, ""))}</a> with the email and password above.</li><li>Open Settings, then Calendar.</li><li>Tap Connect Google Calendar and approve both permissions on Google’s screen.</li></ol></section>
<p class="note">This account is complimentary. It is never billed, has no phone line, and Call Otto sends no texts, calls or emails from it.</p>`);
}
