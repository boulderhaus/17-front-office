import { renderOwnerApp } from "./owner-app.js";
import { usageClass } from "../domain/usage.js";
import type { BookingRecord, BusinessConfig, CallbackTask, CallRecord, OutboxNotification, OwnerAccount, PilotSignup, SubscriptionRecord, ToolEvent, UsageSummary } from "../domain/models.js";
import type { ActivationReport } from "../application/readiness.js";
import { SIMULATION_SCENARIOS, type SimulationResult } from "../application/simulator.js";
import { buildTelnyxAssistantUpdate } from "../voice/system-prompt.js";
import { renderMarketing } from "./marketing.js";
import { COMPANY, companyStatementHtml } from "./footer.js";
import { OWNER_CALL_CONSENT_SIGNUP_LABEL } from "../domain/owner-call-consent.js";

/** Call Otto support on the Terms and Privacy pages: the company's own email and phone, never a placeholder. */
function supportContactHtml(): string {
  return `Call Otto support at <a href="mailto:${COMPANY.email}">${COMPANY.email}</a> or <a href="tel:${COMPANY.phoneE164}">${COMPANY.phoneDisplay}</a>`;
}
import { FAIR_USE_LINE, FAIR_USE_MULTIPLIER, LEAD_GUARANTEE, money, perCall, type Plan, type UnlimitedAddOn } from "../domain/plans.js";

type OwnerDashboardView = "today" | "pipeline" | "calendar";

export const renderLanding = renderMarketing;

/** A plan offered on the signup form, with the exact line shown under the button when it's picked. */
export interface SignupPlan { id: string; label: string; priceCents: number; firstMonthCents: number; includedCalls: number; blurb: string; who: string; chargeNote: string; unlimited?: UnlimitedAddOn | null; unlimitedChargeNote?: string | null }

/**
 * Who sign-up's second screen (the shop) is for: an email Google, Microsoft or an email link confirmed, or an email
 * and password typed on the first screen. Its account and workspace are made only when the shop screen is sent.
 */
export interface VerifiedSignupEmail { email: string; provider: "google" | "microsoft" | "email" | "password" }

/** Sign-up fields that can carry their own error, in page order. Email and password are on the first screen, the rest on the second. */
export const SIGNUP_FIELDS = ["businessName", "phone", "email", "password"] as const;
export type SignupField = (typeof SIGNUP_FIELDS)[number];
/** Per-field problems, each naming the fix ("Use at least 8 characters."). */
export type SignupFieldErrors = Partial<Record<SignupField, string>>;
const SIGNUP_FIELD_IDS: Record<SignupField, string> = { businessName: "signup-shop", phone: "signup-phone", email: "signup-email", password: "signup-password" };
/** The email error whose fix is signing in: both the field error and the summary link to /login. */
export const SIGNUP_EMAIL_TAKEN = "That email already has an account.";
/** Shortest password anyone may set (sign-up, reset, joining a team). */
export const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters.`;
/** An envelope, drawn like the provider logos beside it. */
const MAIL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`;

/**
 * Sign-up, in two screens. First the account: "Continue with Google" (and Microsoft when set up), or "Continue with
 * email", which opens the email box, then the password box, with an email link as the small second choice. Then,
 * once they're in, the shop: its name and the owner's mobile, with the text-message opt-in. No trade question: the
 * shop name sets it.
 */
export function renderOwnerSignup(error = "", values: Record<string, string> = {}, options: { supportEmail?: string | null; chargeNote?: string | null; plans?: SignupPlan[]; providers?: SignInProviders; verified?: VerifiedSignupEmail | null; fieldErrors?: SignupFieldErrors; emailLink?: boolean } = {}): string {
  const value = (name: string): string => escapeHtml(values[name] ?? "");
  const plans = options.plans ?? [];
  const picked = plans.find((plan) => plan.id === values.plan)?.id ?? plans[0]?.id;
  const dollars = (cents: number): string => cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
  // Which charge line shows follows the checked plan, in CSS only (strict CSP, no inline script).
  // The Unlimited toggle (off by default) picks the "+unlimited" line and swaps the shown prices.
  const anyUnlimited = plans.some((plan) => plan.unlimited);
  const planCss = anyUnlimited
    ? plans.map((plan) => `.publicform:has(#plan-${plan.id}:checked):not(:has(#unlimited:checked)) .charge[data-plan="${plan.id}"]{display:block}.publicform:has(#plan-${plan.id}:checked):has(#unlimited:checked) .charge[data-plan="${plan.id}${plan.unlimited ? "+unlimited" : ""}"]{display:block}`).join("")
      + `.publicform .unl{display:none}.publicform:has(#unlimited:checked) .std{display:none}.publicform:has(#unlimited:checked) .unl{display:inline}`
    : plans.map((plan) => `.publicform:has(#plan-${plan.id}:checked) .charge[data-plan="${plan.id}"]{display:block}`).join("");
  const style = `<style>
.onboard-steps{display:grid;gap:8px;margin:0 0 20px;font:800 13px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif}
.onboard-steps ol{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;list-style:none;margin:0;padding:0}
.onboard-steps li{height:6px;background:rgba(7,89,168,.18);font-size:0}.onboard-steps li.on{background:var(--blue)}
.optin{margin:2px 0 22px}
.publicform .optin label.check{margin:0;font:700 15px/1.35 ui-sans-serif,system-ui,-apple-system,sans-serif;align-items:flex-start}
.publicform .optin input{width:22px;height:22px;min-height:0;flex:none;margin:0}
.optin small{display:block;margin:6px 0 0 32px;font:500 13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}
.optin a{color:var(--blue)}
.publicform .plans{margin:0 0 20px;padding:0;border:0}
.plans legend{margin:0 0 8px;padding:0;font:800 15px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif}
.plangrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.publicform label.plan{position:relative;display:grid;align-content:start;gap:3px;margin:0;padding:12px 12px 12px;text-wrap:balance;background:var(--white);border:2px solid rgba(7,89,168,.45);cursor:pointer;font:600 14px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif}
.publicform label.plan:has(input:checked){border:3px solid var(--blue);padding:11px;box-shadow:4px 4px 0 var(--blue)}
.publicform label.plan input{position:absolute;top:12px;right:12px;width:20px;height:20px;min-height:0;margin:0;accent-color:var(--blue)}
.plan strong{font:800 16px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif;padding-right:24px}
.plan .price{font:900 22px/1.1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.02em}.plan .price small{font-size:13px;font-weight:700;letter-spacing:0}
.plan .intro{color:var(--red-strong);font-weight:800;font-size:13px}
.publicform .bigger{margin:10px 0 0}
.bigger summary{display:flex;align-items:center;min-height:44px;cursor:pointer;color:var(--blue);font:800 15px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;text-decoration:underline;text-underline-offset:4px}
.biglist{display:grid;gap:8px;margin-top:4px}
.publicform label.bigplan{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;margin:0;padding:10px 12px;min-height:52px;background:var(--white);border:2px solid rgba(7,89,168,.3);cursor:pointer;font:600 14px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif}
.publicform label.bigplan:has(input:checked){border-color:var(--blue);box-shadow:3px 3px 0 var(--blue)}
.publicform label.bigplan input{width:20px;height:20px;min-height:0;margin:0;accent-color:var(--blue)}
.bigplan small{display:block;font-weight:600;font-size:13px}.bigplan b{font:900 17px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;white-space:nowrap}.bigplan b small{display:inline;font-size:13px;font-weight:700}
.publicform .plans:has(.bigplan input:checked) label.plan{border:2px solid rgba(7,89,168,.25);padding:12px;box-shadow:none}
.publicform label.unltoggle{display:flex;align-items:center;gap:10px;min-height:44px;margin:14px 0 4px;font:800 15px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;cursor:pointer}
.publicform label.unltoggle input{width:22px;height:22px;min-height:0;margin:0;flex:none;accent-color:var(--blue)}
.unlrow{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px}.unlrow .fair{font:800 13px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;border:1.5px solid var(--blue);padding:2px 7px;background:var(--white)}
.unlnote{display:block;margin:2px 0 0;font:600 13px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}
.guarantee{margin:0 0 16px;text-align:center;text-wrap:balance;font:600 14px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}.guarantee b{font-weight:800}
.charge{display:none;margin:14px 0 0;text-align:center;text-wrap:balance;font:800 15px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}
.charge.always{display:block}
.agree{margin:8px 0 0;text-align:center;text-wrap:balance;font:600 14px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}
.verified{font-weight:700}
.signedin{margin:0 0 10px;font:600 15px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow-wrap:anywhere}.signedin b{font-weight:700}.signedin a{display:inline-flex;align-items:center;min-height:44px;color:#0b2545}
.optin label.check span{text-wrap:pretty}
${planCss}
</style>`;
  const verified = options.verified ?? null;
  // Each field's own problem sits under it; focus starts on the first one on this screen.
  const fieldErrors = options.fieldErrors ?? {};
  const screenFields: readonly SignupField[] = verified ? ["businessName", "phone"] : ["email", "password"];
  const firstBad = screenFields.find((name) => fieldErrors[name]);
  const emailTaken = fieldErrors.email === SIGNUP_EMAIL_TAKEN;
  const takenHtml = `${escapeHtml(SIGNUP_EMAIL_TAKEN)} <a href="/login">Sign in instead</a>`;
  const fieldProps = (name: SignupField): { id: string; name: SignupField; error: string | null; errorHtml?: string; autofocus: boolean } => ({ id: SIGNUP_FIELD_IDS[name], name, error: fieldErrors[name] ?? null, ...(name === "email" && emailTaken ? { errorHtml: takenHtml } : {}), autofocus: firstBad === name });
  const summary = errorSummary("signup-error", [
    ...SIGNUP_FIELDS.filter((name) => fieldErrors[name] && (screenFields.includes(name) || (name === "email" && emailTaken))).map((name) => name === "email" && emailTaken ? { message: `${SIGNUP_EMAIL_TAKEN} Sign in instead.`, href: "/login" } : { message: fieldErrors[name]!, field: SIGNUP_FIELD_IDS[name] }),
    ...(error ? [{ message: error }] : []),
  ], !firstBad);
  const agree = `<p class="agree">By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy notice</a>.</p>`;
  const linkPicks = new URLSearchParams();
  if (values.plan) linkPicks.set("plan", values.plan);
  if (values.unlimited === "yes") linkPicks.set("unlimited", "1");
  const picksField = linkPicks.toString() ? `<input type="hidden" name="picks" value="${escapeHtml(linkPicks.toString())}">` : "";

  if (!verified) {
    // Screen 1, the account. Two equal choices; email opens its box in place (no script), then the password box once
    // the email looks complete. The email link is the small second choice under the button.
    const providers = providerButtons({ ...options.providers, picks: { plan: values.plan, unlimited: values.unlimited === "yes" } });
    const typed = Boolean(values.email) || Boolean(fieldErrors.email) || Boolean(fieldErrors.password);
    // Email sent with no password yet (no script to open the box): the password box opens with the cursor in it.
    const askPassword = Boolean(values.email) && !firstBad && !error;
    const planFields = `${values.plan ? `<input type="hidden" name="plan" value="${value("plan")}">` : ""}${values.unlimited === "yes" ? `<input type="hidden" name="unlimited" value="yes">` : ""}`;
    const emailForm = `<form method="post" action="/signup" novalidate${typed ? ` class="pwopen"` : ""}><input type="hidden" name="step" value="account">${planFields}${picksField}${field({ ...fieldProps("email"), label: "Email", attrs: `${EMAIL_ATTRS} autocomplete="email" value="${value("email")}" required${providers && !typed ? " autofocus" : ""}` })}<div class="pwstep">${field({ ...fieldProps("password"), label: "Password", attrs: `type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" maxlength="200" required${askPassword ? " autofocus" : ""}`, hint: PASSWORD_HINT, password: true })}</div><button>Continue</button>${options.emailLink ? `<div class="pwstep"><button class="linkbtn" formaction="/login/email" formnovalidate>Email me a sign-in link instead</button></div>` : ""}</form>`;
    const email = providers
      ? `<details class="emailpath"${typed ? " open" : ""}><summary class="emailbtn">${MAIL_ICON}<span>Continue with email</span></summary>${emailForm}</details>`
      : `<div class="emailpath">${emailForm}</div>`;
    return publicLayout("Get started", `${style}${authHeader("login")}<main class="publicmain formpage authpage"><section class="formintro"><h1>Get your calls covered.</h1><p>Start with Google or your email.</p></section>${summary}<div class="publicform signupstart">${providers}${providers ? `<p class="ordivider">or</p>` : ""}${email}</div>${agree}<p class="authnote">Already have an account? <a class="textlink" href="/login">Sign in</a></p></main>`);
  }

  // Screen 2, the shop: they're in. Shop name and mobile, the text opt-in, the plan, then the card.
  const steps = `<div class="onboard-steps"><span>Step 1 of 3 · Your shop</span><ol aria-hidden="true"><li class="on">Your shop</li><li>Your card</li><li>Forward your calls</li></ol></div>`;
  const button = options.chargeNote ? "Continue to card" : "Continue";
  const verifiedBy = { google: " Verified with Google.", microsoft: " Verified with Microsoft.", email: " Verified by your email link.", password: "" }[verified.provider];
  const signedIn = `<p class="signedin">Signing up as <b>${escapeHtml(verified.email)}</b>.${verifiedBy} <a href="/signup?fresh=1">Use a different email</a></p>`;
  const optIn = `<div class="optin"><label class="check"><input name="ownerSmsConsent" type="checkbox" value="yes" ${values.ownerSmsConsent === "yes" ? "checked" : ""}><span>Send me Call Otto account notifications by text (new calls, appointments)—optional</span></label><small>By checking this, you agree to receive SMS account notifications from Call Otto by Dutchworks LLC. Msg frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. We won’t share mobile info with third parties for marketing. Not required to sign up. <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></small></div><div class="optin"><label class="check"><input name="ownerCallConsent" type="checkbox" value="yes" ${values.ownerCallConsent === "yes" ? "checked" : ""}><span>${escapeHtml(OWNER_CALL_CONSENT_SIGNUP_LABEL)}</span></label></div>`;
  // Solo is already picked, so it costs no tap; bigger shops open one compact line to choose Pro, Team or Fleet.
  const radio = (plan: SignupPlan): string => `<input type="radio" name="plan" id="plan-${escapeHtml(plan.id)}" value="${escapeHtml(plan.id)}" ${plan.id === picked ? "checked" : ""}>`;
  const [solo, ...bigger] = plans;
  const price = (plan: SignupPlan): string => plan.unlimited ? `<span class="std">${dollars(plan.priceCents)}</span><span class="unl">${dollars(plan.unlimited.priceCents)}</span>` : dollars(plan.priceCents);
  // Unlimited calls: an add-on, off unless the owner turns it on (here or on the pricing page). Fair use sits right next to it.
  const unlimitedOn = values.unlimited === "yes";
  // With Unlimited on, a plan's calls line says what they get then, not its included calls.
  const callsLine = (plan: SignupPlan, standard: string): string => plan.unlimited ? `<span class="std">${standard}</span><span class="unl">Unlimited calls, fair use up to ${plan.unlimited.fairUseCalls.toLocaleString("en-US")} a month</span>` : standard;
  const unlimitedToggle = plans.some((plan) => plan.unlimited)
    ? `<div class="unlrow"><label class="unltoggle" for="unlimited"><input type="checkbox" id="unlimited" name="unlimited" value="yes"${unlimitedOn ? " checked" : ""}><span>Unlimited calls</span></label><span class="fair">${escapeHtml(FAIR_USE_LINE)}</span></div><small class="unlnote">${plans.filter((plan) => plan.unlimited).map((plan) => `+${dollars(plan.unlimited!.addOnCents)} ${escapeHtml(plan.label)}`).join(", ")} a month. Off anytime in Settings.</small>`
    : "";
  const planPicker = solo && bigger.length > 0
    ? `<fieldset class="plans"><legend>Your plan</legend><label class="plan" for="plan-${escapeHtml(solo.id)}">${radio(solo)}<strong>${escapeHtml(solo.label)}</strong><span class="price">${price(solo)}<small>/mo</small></span>${solo.firstMonthCents < solo.priceCents ? `<span class="intro">Limited time: first month half off</span>` : ""}<span>${callsLine(solo, escapeHtml(solo.blurb))}</span></label><details class="bigger"${bigger.some((plan) => plan.id === picked) ? " open" : ""}><summary>Bigger shop? ${bigger.map((plan) => escapeHtml(plan.label)).join(", ")}</summary><div class="biglist">${bigger.map((plan) => `<label class="bigplan" for="plan-${escapeHtml(plan.id)}">${radio(plan)}<span><strong>${escapeHtml(plan.label)}</strong><small>${callsLine(plan, `${plan.includedCalls} calls a month`)} · ${escapeHtml(plan.who)}</small></span><b>${price(plan)}<small>/mo</small></b></label>`).join("")}</div></details>${unlimitedToggle}</fieldset>`
    : solo ? `<input type="hidden" name="plan" value="${escapeHtml(solo.id)}">` : "";
  const charges = plans.length > 1
    ? plans.map((plan) => `<p class="charge" data-plan="${escapeHtml(plan.id)}">${escapeHtml(plan.chargeNote)}</p>${plan.unlimited && plan.unlimitedChargeNote ? `<p class="charge" data-plan="${escapeHtml(plan.id)}+unlimited">${escapeHtml(plan.unlimitedChargeNote)}</p>` : ""}`).join("")
    : options.chargeNote ? `<p class="charge always">${escapeHtml(plans[0]?.chargeNote ?? options.chargeNote)}</p>` : "";
  const shopFields = `${field({ ...fieldProps("businessName"), label: "Shop name", attrs: `autocomplete="organization" maxlength="120" value="${value("businessName")}" required` })}${field({ ...fieldProps("phone"), label: "Your mobile number", attrs: `type="tel" autocomplete="tel" inputmode="tel" maxlength="30" data-phone-mask placeholder="e.g. (941) 555-0123" value="${value("phone")}" required`, hint: "Where we reach you about your line." })}`;
  return publicLayout("Get started", `${style}${authHeader("login")}<main class="publicmain formpage authpage"><section class="formintro">${steps}<h1>Set up your shop</h1><p>Two quick answers, then your card.</p></section>${summary}<form class="publicform" method="post" action="/signup" novalidate>${signedIn}<input type="hidden" name="timezone" value="${value("timezone")}">${shopFields}${optIn}<label class="trap" aria-hidden="true">Fax number<input name="faxNumber" tabindex="-1" autocomplete="off"></label>${planPicker}${plans.length ? `<p class="guarantee"><b>Lead guarantee:</b> no real customer lead in your first 30 days, and we refund your first month.</p>` : ""}<button>${button}</button>${charges}${agree}</form></main>`);
}

/** The page behind "Call back" in an owner text: who called, about what, and one big Call button. */
export function renderCallbackLink(input: { shop: string; callerName: string | null; problem: string; address: string | null; phone: string | null; urgent: boolean; callId: string } | null): string {
  const style = `<style>.cb{max-width:520px;padding-top:28px}.cb h1{font-size:clamp(30px,9vw,46px);line-height:1.05;letter-spacing:-.03em;margin:6px 0 10px}.cb .shop{font:800 13px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;text-transform:uppercase;letter-spacing:.08em}.cb .urgent{display:inline-block;background:var(--red-strong);color:#fff;padding:4px 10px;font:800 13px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;margin-bottom:6px}.cb p{font-size:18px;margin:0 0 8px}.cb .call{display:flex;align-items:center;justify-content:center;gap:10px;min-height:64px;margin:22px 0 14px;background:var(--blue);color:#fff;text-decoration:none;font:800 22px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:6px 6px 0 var(--ink,#073a6d)}.cb .more{font:700 15px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}</style>`;
  if (!input) {
    return publicLayout("Link expired", `${style}<main class="publicmain cb"><h1>This link has expired.</h1><p>Call-back links work for 7 days. Open Call Otto to see the call.</p><p class="more"><a href="/app">Open Call Otto</a></p></main>`);
  }
  const us = input.phone ? /^\+1(\d{3})(\d{3})(\d{4})$/.exec(input.phone) : null;
  const display = us ? `(${us[1]}) ${us[2]}-${us[3]}` : input.phone;
  const name = input.callerName?.trim() || "the caller";
  return publicLayout("Call back", `${style}<main class="publicmain cb"><p class="shop">${escapeHtml(input.shop)}</p>${input.urgent ? `<span class="urgent">Urgent</span>` : ""}<h1>Call back ${escapeHtml(name)}</h1>${input.problem.trim() ? `<p>${escapeHtml(input.problem)}</p>` : ""}${input.address ? `<p>${escapeHtml(input.address)}</p>` : ""}${input.phone ? `<a class="call" href="tel:${escapeHtml(input.phone)}">Call ${escapeHtml(display ?? input.phone)}</a>` : `<p><strong>No callback number was captured.</strong></p>`}<p class="more"><a href="/app/calls/${encodeURIComponent(input.callId)}">See the full call in Call Otto</a></p></main>`);
}

/** Which sign-in options this server offers. A provider without an app registration is hidden. */
export interface SignInProviders { google?: boolean; microsoft?: boolean }

export interface LoginPageOptions extends SignInProviders {
  /** "Email me a sign-in link" (needs outgoing email). */
  emailLink?: boolean;
  /** Where to land after signing in: a path inside /app, already checked. */
  next?: string | null;
  /**
   * What the error is about: "link" and "password" mark a field on that form; "passwordEmail" is a malformed email
   * on the password form; "linkToken" is an emailed link that expired or broke, so nothing typed is wrong and focus
   * just goes to the email box to send a new one.
   */
  errorField?: "link" | "linkToken" | "password" | "passwordEmail";
  /** Show the password form open. */
  passwordOpen?: boolean;
  email?: string;
}

/** Google's multicolor "G" (Sign in with Google branding). */
const GOOGLE_G = `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/><path fill="none" d="M0 0h48v48H0z"/></svg>`;
/** Microsoft's four-square logo. */
const MICROSOFT_LOGO = `<svg viewBox="0 0 21 21" aria-hidden="true" focusable="false"><path fill="#f25022" d="M1 1h9v9H1z"/><path fill="#7fba00" d="M11 1h9v9h-9z"/><path fill="#00a4ef" d="M1 11h9v9H1z"/><path fill="#ffb900" d="M11 11h9v9h-9z"/></svg>`;

/**
 * "Continue with Google" / "Continue with Microsoft", in that order; empty when neither is set up. On sign-up they
 * carry the pricing page's picks (plan, Unlimited, trade), which the sign-in checks and hands back to sign-up.
 */
export function providerButtons(options: SignInProviders & { next?: string | null; picks?: { plan?: string | undefined; unlimited?: boolean; trade?: string | undefined } }): string {
  const picks = new URLSearchParams();
  if (options.picks?.plan) picks.set("plan", options.picks.plan);
  if (options.picks?.unlimited) picks.set("unlimited", "1");
  if (options.picks?.trade) picks.set("trade", options.picks.trade);
  const query = options.next ? `?next=${encodeURIComponent(options.next)}` : picks.toString() ? escapeHtml(`?${picks.toString()}`) : "";
  const buttons = `${options.google ? `<a class="google" href="/auth/google${query}">${GOOGLE_G}<span>Continue with Google</span></a>` : ""}${options.microsoft ? `<a class="microsoft" href="/auth/microsoft${query}">${MICROSOFT_LOGO}<span>Continue with Microsoft</span></a>` : ""}`;
  return buttons ? `<div class="idp">${buttons}</div>` : "";
}

const SIGN_IN_STYLE = `<style>
.signinform form{margin:0}
.signinform .hint{margin:12px 0 0;text-align:center;text-wrap:balance}
.pwd{margin-top:22px;padding-top:12px;border-top:2px solid rgba(7,89,168,.35)}
.pwd summary{display:flex;align-items:center;justify-content:center;min-height:44px;cursor:pointer;color:var(--blue);font:800 15px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;text-decoration:underline;text-underline-offset:4px}
.pwd[open] summary{margin-bottom:14px}
.publicform .small{margin:10px 0 0;text-align:center;font:700 15px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}
</style>`;

function authHeader(link: "signup" | "login"): string {
  return `${AUTH_APP_STYLE}<header class="publicnav"><a class="brand smallbrand" href="/"><span>Call</span> Otto</a><nav>${link === "signup" ? `<a href="/signup">Get started</a>` : `<a href="/login">Sign in</a>`}</nav></header>`;
}

/**
 * Sign-up, sign-in and password pages look like the owner app they lead into: its paper and ink, one sans face,
 * 17px weight-500 fields, calm ink buttons (never red, which reads as danger), no hard drop shadows. Layout and
 * words are unchanged, consent paragraphs included.
 */
const AUTH_APP_STYLE = `<style>
body:has(.authpage){background-image:none;background-color:#faf8f1}
body:has(.authpage) .publicnav{padding-top:10px;padding-bottom:10px;border-bottom:1px solid #e6e1d3;align-items:center}
body:has(.authpage) .brand.smallbrand{font:600 22px/44px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:-.01em;color:#0b2545;display:inline-block;min-height:44px}
body:has(.authpage) .brand.smallbrand span{font-style:normal}
body:has(.authpage) .publicnav nav a{display:inline-flex;align-items:center;min-height:44px;color:#0b2545}
.authpage{color:#0b2545}
.authpage .formintro h1{font:650 clamp(30px,7vw,40px)/1.15 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:-.02em}
.authpage .formintro>p:last-child,.authpage .formintro p{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:17px}
.authpage .eyebrow{text-transform:none;letter-spacing:0;font-weight:600;font-size:15px;color:#5d6676}
.authpage .publicform{background:#fff;border:1px solid #e6e1d3;border-radius:14px;box-shadow:none}
.authpage .publicform label,.authpage .publicform legend,.authpage .plans legend{color:#0b2545}
.authpage .publicform input:not([type=checkbox]):not([type=radio]),.authpage .publicform select,.authpage .publicform textarea{border:1px solid #c9c3b0;border-radius:10px;font:500 17px/1.35 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0b2545}
.authpage .publicform input:not([type=checkbox]):not([type=radio]):focus-visible,.authpage .publicform select:focus-visible,.authpage .publicform textarea:focus-visible{outline:2px solid #0b2545;outline-offset:2px;border-color:#0b2545}
.authpage .publicform button:not(.pwtoggle):not(.slotgrid button){background:#0b2545;color:#fff;border:0;border-radius:12px;box-shadow:none;text-transform:none;letter-spacing:0;font:650 17px/1.2 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.authpage .publicform button:not(.pwtoggle):not(.slotgrid button):hover{transform:none;box-shadow:none;background:#16365e}
.authpage .publicform button:focus-visible{outline:2px solid #0b2545;outline-offset:3px;transform:none}
.authpage .publicform label.plan,.authpage .publicform label.bigplan{border:1px solid #c9c3b0;border-radius:12px;box-shadow:none}
.authpage .publicform label.plan:has(input:checked),.authpage .publicform label.bigplan:has(input:checked){border:2px solid #0b2545;box-shadow:none}
.authpage .ordivider{text-transform:none;letter-spacing:0;font:600 15px/1.2 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#5d6676}.authpage .ordivider::before,.authpage .ordivider::after{border-top:1px solid #e6e1d3}.authpage .onboard-steps li.on{background:#0b2545}.authpage .onboard-steps{color:#0b2545}
.authpage .textlink,.authpage .optin a,.authpage .agree a,.authpage .bigger summary,.authpage .pwd summary{color:#0b2545}
.authpage .pwd{border-top:1px solid #e6e1d3}
.authpage .publicform input[aria-invalid="true"],.authpage .publicform select[aria-invalid="true"]{border:2px solid #b42318}
.authpage .selectwrap{position:relative;display:block}
.authpage .selectwrap select{-webkit-appearance:none;appearance:none;height:52px;padding-right:44px;background:#fff}
.authpage .selectwrap::after{content:"";position:absolute;right:18px;top:50%;width:9px;height:9px;margin-top:-1px;border-right:2px solid #0b2545;border-bottom:2px solid #0b2545;transform:translateY(-50%) rotate(45deg);pointer-events:none}
.authpage .emailbtn{display:flex;align-items:center;justify-content:center;gap:12px;min-height:48px;padding:10px 16px;border:1px solid #747775;border-radius:4px;background:#fff;color:#1f1f1f;cursor:pointer;font:600 16px/1.2 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.authpage .emailbtn:hover{background:#f6f8fa}.authpage .emailbtn:focus-visible{outline:3px solid var(--field-ink);outline-offset:2px}
.authpage .emailbtn svg{flex:none;width:20px;height:20px}
.authpage .emailpath>summary{list-style:none}.authpage .emailpath>summary::-webkit-details-marker{display:none}
.authpage .emailpath[open]>summary{display:none}
.authpage .emailpath .pwstep{display:none}
.authpage .emailpath form:has(input[type=email]:valid) .pwstep,.authpage .emailpath form.pwopen .pwstep{display:block}
.authpage .publicform .emailpath button.linkbtn.linkbtn{display:flex;align-items:center;justify-content:center;width:auto;min-height:44px;margin:10px auto 0;padding:0 8px;background:none;color:#0b2545;border:0;box-shadow:none;text-decoration:underline;text-underline-offset:4px;font:650 15px/1.3 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.authpage .publicform .emailpath button.linkbtn.linkbtn:hover{background:none;transform:none;box-shadow:none}
</style>`;

/** The narrow page every sign-in, sign-up, password and booking screen shares: header, eyebrow, h1, then the card. */
export function authPage(title: string, input: { header: "signup" | "login"; eyebrow: string; heading: string; lede?: string; style?: string; body: string }): string {
  return publicLayout(title, `${input.style ?? ""}${authHeader(input.header)}<main class="publicmain formpage authpage"><section class="formintro"><p class="eyebrow">${escapeHtml(input.eyebrow)}</p><h1>${escapeHtml(input.heading)}</h1>${input.lede ?? ""}</section>${input.body}</main>`);
}

/**
 * One form field: label tied by for/id, hint and error outside the label and tied by aria-describedby,
 * aria-invalid on error. `attrs` goes on the input right after its name (tests read `<input name="…"`).
 */
function field(input: { id: string; name: string; label: string; attrs: string; hint?: string; hintHtml?: string; error?: string | null; errorHtml?: string; autofocus?: boolean; password?: boolean }): string {
  // A password's rule ("At least 8 characters.") is what its error repeats, so the error takes its place.
  const hintId = (input.hint || input.hintHtml) && !(input.password && input.error) ? `${input.id}-hint` : null;
  const errorId = input.error ? `${input.id}-error` : null;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ");
  const control = `<input name="${input.name}" id="${input.id}" ${input.attrs}${describedBy ? ` aria-describedby="${describedBy}"` : ""}${input.error ? ` aria-invalid="true"` : ""}${input.autofocus ? " autofocus" : ""}>`;
  return `<div class="field"><label for="${input.id}">${escapeHtml(input.label)}</label>${input.password ? `<div class="pwfield">${control}</div>` : control}${errorId ? `<span class="fielderror" id="${errorId}">${input.errorHtml ?? escapeHtml(input.error!)}</span>` : ""}${hintId ? `<span class="hint" id="${hintId}">${input.hintHtml ?? escapeHtml(input.hint!)}</span>` : ""}</div>`;
}

/** On a page-level error box that nothing else takes focus from. */
const FOCUS_ON_LOAD = ` tabindex="-1" autofocus`;

const EMAIL_ATTRS = `type="email" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="254"`;

/**
 * The error box at the top: role=alert, each problem a link to its field (or to its fix, such as /login).
 * `focus` when no field takes focus: screen readers skip an alert that is already there on load, so focus reads it.
 */
function errorSummary(id: string, items: Array<{ message: string; field?: string | null; href?: string }>, focus = false): string {
  if (items.length === 0) return "";
  const line = (item: { message: string; field?: string | null; href?: string }): string => {
    const href = item.href ?? (item.field ? `#${item.field}` : null);
    return href ? `<a href="${escapeHtml(href)}">${escapeHtml(item.message)}</a>` : escapeHtml(item.message);
  };
  return `<div class="formerror" role="alert" id="${id}"${focus ? FOCUS_ON_LOAD : ""}>${items.length === 1 ? `<p>${line(items[0]!)}</p>` : `<ul>${items.map((item) => `<li>${line(item)}</li>`).join("")}</ul>`}</div>`;
}

/**
 * Sign-in, laid out like sign-up's first screen: "Continue with Google" (and Microsoft), or "Continue with email",
 * which opens the email and password boxes, with "Email me a sign-in link instead" as the small second choice.
 */
export function renderOwnerLogin(error = "", options: LoginPageOptions = {}): string {
  const errorField = error ? options.errorField ?? null : null;
  const email = escapeHtml(options.email ?? "");
  // Focus lands on the field to fix: the password when the email was kept, otherwise the email.
  const focus = errorField === "link" || errorField === "linkToken" || errorField === "passwordEmail" ? "login-email"
    : errorField === "password" ? (options.email ? "password" : "login-email")
    // Email sent with no password yet (no script to open the box): the password box opens with the cursor in it.
    : !error && options.passwordOpen && options.email ? "password" : null;
  // The field that shows the error and that the summary links to; none when the emailed link itself failed.
  const fieldId = errorField === "linkToken" ? null : focus;
  // Fields marked wrong: a wrong email-or-password marks both; a malformed email only the email.
  const invalidIds = errorField === "link" || errorField === "passwordEmail" ? ["login-email"] : errorField === "password" ? ["login-email", "password"] : [];
  const invalid = (id: string): string => {
    if (errorField === "linkToken") return focus === id ? ` aria-describedby="login-error" autofocus` : "";
    return `${invalidIds.includes(id) ? ` aria-invalid="true" aria-describedby="${fieldId === id ? "login-field-error" : "login-error"}"` : ""}${focus === id ? " autofocus" : ""}`;
  };
  const inlineError = (id: string): string => fieldId === id ? `<span class="fielderror" id="login-field-error">${escapeHtml(error)}</span>` : "";
  const errorBox = error ? `<div class="formerror" role="alert" id="login-error"${focus ? "" : FOCUS_ON_LOAD}><p>${fieldId ? `<a href="#${fieldId}">${escapeHtml(error)}</a>` : escapeHtml(error)}</p></div>` : "";
  const next = options.next ? `<input type="hidden" name="next" value="${escapeHtml(options.next)}">` : "";
  const providers = providerButtons(options);
  const typed = Boolean(options.email) || errorField !== null || options.passwordOpen === true;
  const emailInput = `<div class="field"><label for="login-email">Email</label><input id="login-email" name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="254" value="${email}" required${invalid("login-email")}${providers && !typed ? " autofocus" : ""}>${inlineError("login-email")}</div>`;
  const linkButton = options.emailLink ? `<button class="linkbtn" formaction="/login/email" formnovalidate>Email me a sign-in link instead</button>` : "";
  const form = `<form method="post" action="/login" novalidate${typed ? ` class="pwopen"` : ""}>${next}${emailInput}<div class="pwstep"><div class="field"><label for="password">Password</label><div class="pwfield"><input id="password" name="password" type="password" autocomplete="current-password" maxlength="200" required${invalid("password")}></div>${inlineError("password")}</div></div><button>Sign in</button><div class="pwstep">${linkButton}<p class="small"><a href="/forgot">Forgot your password?</a></p></div></form>`;
  const card = providers
    ? `${providers}<p class="ordivider">or</p><details class="emailpath"${typed ? " open" : ""}><summary class="emailbtn">${MAIL_ICON}<span>Continue with email</span></summary>${form}</details>`
    : `<div class="emailpath">${form}</div>`;
  return authPage("Owner sign in", { header: "signup", style: SIGN_IN_STYLE, eyebrow: "Your calls. Your rules.", heading: "Sign in", body: `${errorBox}<div class="publicform signinform">${card}</div><p class="authnote">New to Call Otto? <a class="textlink" href="/signup">Get started</a></p>` });
}

/** After "Email me a sign-in link": the same answer whether or not the email has an account. */
/** `note`: one line on why a link went out instead (Google or Microsoft couldn't vouch for the address). */
export function renderSignInLinkSent(email: string, note?: string): string {
  return authPage("Check your email", { header: "signup", style: SIGN_IN_STYLE, eyebrow: "Your calls. Your rules.", heading: "Check your email", lede: `${note ? `<p>${escapeHtml(note)}</p>` : ""}<p>We sent a sign-in link to <strong>${escapeHtml(email)}</strong>. It works once, for 15 minutes.</p>`, body: `<p class="authnote">Nothing yet? Check spam, or <a class="textlink" href="/login">send a new link</a>.</p>` });
}

/** The page behind the emailed link. Signing in takes a tap, so link scanners that open it don't use it up. */
export function renderSignInLinkConfirm(token: string, next: string | null = null, picks = ""): string {
  const nextField = next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : "";
  const picksField = picks ? `<input type="hidden" name="picks" value="${escapeHtml(picks)}">` : "";
  return authPage("Sign in", { header: "signup", style: SIGN_IN_STYLE, eyebrow: "Your calls. Your rules.", heading: "One tap and you’re in.", body: `<form class="publicform signinform" method="post" action="/login/link"><input type="hidden" name="token" value="${escapeHtml(token)}">${nextField}${picksField}<button>Sign me in</button></form>` });
}

export function renderForgotPassword(input: { sent?: boolean; emailEnabled: boolean; supportEmail?: string | null; error?: string; email?: string }): string {
  const support = input.supportEmail ? `<a href="mailto:${escapeHtml(input.supportEmail)}">${escapeHtml(input.supportEmail)}</a>` : "Call Otto support";
  // An error about the typed email sits on the form; an expired link is a page-level problem.
  const fieldError = input.error && input.emailEnabled && !input.sent && input.email !== undefined ? input.error : null;
  const body = input.sent
    ? `<p class="lede">If that email has an account, we sent a reset link. It works for 30 minutes.</p>`
    : input.emailEnabled
      ? `${fieldError ? errorSummary("forgot-error", [{ message: fieldError, field: "forgot-email" }]) : ""}<form class="publicform" method="post" action="/forgot">${field({ id: "forgot-email", name: "email", label: "Email", attrs: `${EMAIL_ATTRS} autocomplete="username" value="${escapeHtml(input.email ?? "")}" required`, error: fieldError, autofocus: Boolean(fieldError) })}<button>Send reset link</button></form>`
      : `<p class="lede">Email reset isn’t switched on yet. Email ${support} from your account email and we’ll send a reset link.</p>`;
  const pageError = input.error && !fieldError ? errorSummary("forgot-error", [{ message: input.error }], true) : "";
  const help = input.supportEmail && (input.sent || input.emailEnabled) ? `<p class="authnote">Trouble? Email ${support}.</p>` : "";
  return authPage("Reset password", { header: "login", eyebrow: "Your calls. Your rules.", heading: "Reset your password", body: `${pageError}${body}${help}<p class="authnote"><a class="textlink" href="/login">Back to sign in</a></p>` });
}

export function renderResetPassword(token: string, error = "", supportEmail: string | null = null, errorField: "password" | "confirm" | null = null): string {
  const help = supportEmail ? `<p class="authnote">Link not working? Email <a class="textlink" href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>` : "";
  const fieldId = error && errorField ? `reset-${errorField}` : null;
  const summary = error ? errorSummary("reset-error", [{ message: error, field: fieldId }], !fieldId) : "";
  const fieldError = (name: "password" | "confirm"): string | null => error && errorField === name ? error : null;
  return authPage("Choose a new password", { header: "login", eyebrow: "Your calls. Your rules.", heading: "Choose a new password", body: `${summary}<form class="publicform" method="post" action="/reset"><input type="hidden" name="token" value="${escapeHtml(token)}">${field({ id: "reset-password", name: "password", label: "New password", attrs: `type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" maxlength="200" required`, hint: PASSWORD_HINT, error: fieldError("password"), autofocus: errorField === "password", password: true })}${field({ id: "reset-confirm", name: "confirm", label: "Type it again", attrs: `type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" maxlength="200" required`, error: fieldError("confirm"), autofocus: errorField === "confirm", password: true })}<button>Save and sign in again</button><p class="hint">This signs you out on every device.</p></form>${help}` });
}

export function renderAdminResetLink(email: string, link: string): string {
  return layout("Reset link", `<header><div><p class="eyebrow">Customer operations</p><h1>One-time reset link</h1></div><nav><a href="/admin/owners">Owner accounts</a></nav></header><main><section><p>Send this to <strong>${escapeHtml(email)}</strong> only, from the address on file. It works once and expires in 30 minutes.</p><pre>${escapeHtml(link)}</pre></section></main>`);
}

export function renderOwnerDashboard(input: Parameters<typeof renderOwnerApp>[0]): string {
  return renderOwnerApp(input);
}

export function renderStart(error = "", values: Record<string, string> = {}): string {
  const value = (name: string): string => escapeHtml(values[name] ?? "");
  return publicLayout("Start", `<div class="announcement">Founding pilot for local HVAC shops <span aria-hidden="true">→</span></div><header class="publicnav"><a class="brand smallbrand" href="/"><span>Call</span> Otto</a><nav><a href="/">Back home</a><a href="/privacy">Privacy</a></nav></header><main class="publicmain formpage"><section class="formintro"><p class="eyebrow">Let’s get your phone covered</p><h1>Tell us how your shop handles missed calls.</h1><p>This is an assisted setup for the first local shops. We’ll review your service area and call flow, then confirm a launch slot before any customer traffic is turned on.</p></section>${error ? `<p class="formerror">${escapeHtml(error)}</p>` : ""}<form class="publicform" method="post" action="/start"><div class="grid two"><label>Your name<input name="ownerName" autocomplete="name" maxlength="120" value="${value("ownerName")}" required></label><label>Business name<input name="businessName" autocomplete="organization" maxlength="120" value="${value("businessName")}" required></label></div><div class="grid two"><label>Email<input name="email" type="email" autocomplete="email" maxlength="254" value="${value("email")}" required></label><label>Mobile phone<input name="phone" type="tel" autocomplete="tel" maxlength="30" value="${value("phone")}" required></label></div><div class="grid two"><label>Trade<select name="trade" required>${selectOption("hvac", "HVAC", values.trade)}${selectOption("plumbing", "Plumbing", values.trade)}${selectOption("electrical", "Electrical", values.trade)}${selectOption("other", "Other home service", values.trade)}</select></label><label>Website, if you have one<input name="website" type="url" maxlength="300" placeholder="https://" value="${value("website")}"></label></div><label>Service area<input name="serviceArea" maxlength="500" placeholder="Towns, counties, or ZIP codes" value="${value("serviceArea")}" required></label><div class="grid two"><label>Where should the AI start?<select name="desiredMode" required>${selectOption("overflow", "Only when I miss the call", values.desiredMode)}${selectOption("after_hours", "After hours and weekends", values.desiredMode)}${selectOption("always", "Answer every call", values.desiredMode)}</select></label><label>Calendar<select name="calendarProvider" required>${selectOption("google", "Google Calendar", values.calendarProvider)}${selectOption("none", "No calendar yet", values.calendarProvider)}${selectOption("other", "Another calendar", values.calendarProvider)}</select></label></div><label>About how many calls do you miss in a normal week?<input name="missedCallsPerWeek" type="number" min="0" max="500" step="1" value="${value("missedCallsPerWeek")}"></label><label>Anything we should know?<textarea name="notes" maxlength="1500" placeholder="Current phone setup, hours, dispatch process, or the biggest call problem">${value("notes")}</textarea></label><label class="trap" aria-hidden="true">Fax number<input name="faxNumber" tabindex="-1" autocomplete="off"></label><label class="check"><input name="consent" type="checkbox" value="yes" required> You may contact me about setting up Call Otto. I agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy notice</a>.</label><button>Send my setup details <span aria-hidden="true">→</span></button></form></main>`);
}

export function renderStartReceived(checkoutUrl: string | null): string {
  const checkout = checkoutUrl
    ? `<a class="button" href="${escapeHtml(checkoutUrl)}" rel="noreferrer">Reserve the founding plan</a><p class="small">Use checkout only after we confirm that your shop fits the pilot and your launch slot is available.</p>`
    : `<p>We’ll review the setup and contact you with the exact launch plan and secure payment link.</p>`;
  return publicLayout("Setup received", `<div class="announcement">Setup received <span aria-hidden="true">✓</span></div><main class="publicmain"><section class="received"><p class="eyebrow">You’re on the list</p><h1>Your shop is in the queue.</h1><p>Nothing has been turned on or charged. We’ll confirm the call flow, service area, recording notice, and owner alert path before your line handles customers.</p><div class="actions">${checkout}<a class="textlink" href="/">Back home</a></div></section></main>`);
}

export function renderPilotSignups(signups: PilotSignup[]): string {
  const rows = signups.length === 0
    ? `<tr><td colspan="8">No founding-pilot applications yet.</td></tr>`
    : signups.map((item) => `<tr><td>${escapeHtml(formatDate(item.createdAt, "America/New_York"))}</td><td><strong>${escapeHtml(item.businessName)}</strong><br>${escapeHtml(item.ownerName)}</td><td>${escapeHtml(item.trade.toUpperCase())}</td><td>${escapeHtml(item.serviceArea)}</td><td><a href="mailto:${escapeHtml(item.email)}">${escapeHtml(item.email)}</a><br><a href="tel:${escapeHtml(item.phone)}">${escapeHtml(item.phone)}</a></td><td>${escapeHtml(item.desiredMode.replace("_", " "))}</td><td>${item.missedCallsPerWeek ?? "unknown"}</td><td>${escapeHtml(item.status)}</td></tr>`).join("");
  return layout("Pilot applications", `<header><div><p class="eyebrow">Founding pilot</p><h1>Applications</h1></div><nav><a href="/admin">Calls</a><a href="/admin/config">Configuration</a></nav></header><main><section><div class="table"><table><thead><tr><th>Received</th><th>Shop</th><th>Trade</th><th>Service area</th><th>Contact</th><th>Mode</th><th>Missed/week</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></section></main>`);
}

export function renderOwnerAccounts(accounts: OwnerAccount[], csrf: string): string {
  const rows = accounts.length === 0 ? `<tr><td colspan="5">No owner accounts yet.</td></tr>` : accounts.map((account) => `<tr><td><strong>${escapeHtml(account.displayName)}</strong><br>${escapeHtml(account.email)}</td><td><code>${escapeHtml(account.tenantId)}</code></td><td>${escapeHtml(account.status.replace("_", " "))}</td><td>${escapeHtml(formatDate(account.createdAt, "America/New_York"))}</td><td><form method="post" action="/admin/owners/${encodeURIComponent(account.id)}/reset-link"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button>Create reset link</button></form><form method="post" action="/admin/owners/${encodeURIComponent(account.id)}/status"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Status<select name="status"><option value="pending_activation" ${account.status === "pending_activation" ? "selected" : ""}>pending activation</option><option value="active" ${account.status === "active" ? "selected" : ""}>active</option><option value="suspended" ${account.status === "suspended" ? "selected" : ""}>suspended</option></select></label><label>Dedicated Telnyx number<input name="inboundNumber" type="tel" placeholder="+15555550100"></label><label>Existing Telnyx assistant ID<input name="assistantId" placeholder="Required to activate"></label><button>Save</button></form></td></tr>`).join("");
  return layout("Owner accounts", `<header><div><p class="eyebrow">Customer operations</p><h1>Owner accounts</h1></div><nav><a href="/admin">Calls</a><a href="/admin/signups">Pilot applications</a></nav></header><main><section><p>Activation is fail-closed. An account cannot be activated until its Telnyx assistant route, Google Calendar, owner alert phone, and service area are configured.</p><div class="table"><table><thead><tr><th>Owner</th><th>Tenant</th><th>Status</th><th>Created</th><th>Activation</th></tr></thead><tbody>${rows}</tbody></table></div></section></main>`);
}

export function renderLogin(error = ""): string {
  return layout("Sign in", `<main class="narrow"><h1>Call Otto</h1><p>Enter the admin token configured on the server.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="/admin/login"><label>Admin token<input name="token" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></main>`);
}

export function renderDashboard(input: {
  config: BusinessConfig;
  calls: CallRecord[];
  csrf: string;
  integrations: Record<string, boolean>;
  activation: ActivationReport;
}): string {
  const completedCalls = input.calls.filter((call) => call.endedAt !== null && call.billingDisposition !== "spam_excluded");
  const verifiedBookings = input.calls.filter((call) => call.outcome === "booked").length;
  const urgentEscalations = input.calls.filter((call) => call.billingDisposition !== "spam_excluded" && call.emergency?.emergency).length;
  const excludedSpam = input.calls.filter((call) => call.billingDisposition === "spam_excluded").length;
  const rows = input.calls.length === 0
    ? `<tr><td colspan="5">No calls yet. Use the simulator or connect Telnyx.</td></tr>`
    : input.calls.map((call) => `<tr><td><a href="/admin/calls/${encodeURIComponent(call.id)}">${escapeHtml(formatDate(call.startedAt, input.config.timezone))}</a></td><td>${escapeHtml(call.fields.callerName ?? "Unknown")}</td><td>${escapeHtml(call.fields.problemDescription || "No summary")}</td><td><span class="pill ${call.emergency?.emergency ? "danger" : ""}">${escapeHtml(call.emergency?.severity ?? "pending")}</span></td><td>${escapeHtml(call.outcome)}</td></tr>`).join("");
  const integrationItems = Object.entries(input.integrations).map(([name, ready]) => `<li>${escapeHtml(name)} <strong class="${ready ? "good" : "error"}">${ready ? "ready" : "missing"}</strong></li>`).join("");
  return layout("Calls", `<header><div><p class="eyebrow">${escapeHtml(input.config.businessName)}</p><h1>Call Otto</h1></div><nav><a href="/admin/config">Configuration</a><a href="/admin/readiness">Readiness</a><a href="/admin/owners">Owner accounts</a><a href="/admin/founder-calendars">Founder calendars</a><a href="/admin/signups">Pilot applications</a><a href="/admin/simulator">Simulator</a><a href="/admin/prompt">Telnyx setup</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/admin/logout">Sign out</a></nav></header><main><section class="status ${input.activation.go ? "goodbox" : "badbox"}"><h2>${input.activation.go ? "GO: first-customer activation gate passed" : `NO-GO: ${input.activation.blocking.length} launch blocker(s)`}</h2><p>Mode: ${escapeHtml(input.activation.mode.replace("_", " "))}. ${input.config.paused ? "Service is paused." : "Service is accepting eligible provider traffic."} <a href="/admin/readiness">Review gate</a></p></section><section class="grid"><article><h2>Calls captured</h2><p>${completedCalls.length}</p></article><article><h2>Verified bookings</h2><p>${verifiedBookings}</p></article><article><h2>Urgent escalations</h2><p>${urgentEscalations}</p></article></section><section class="grid"><article><h2>Coverage</h2><p>${escapeHtml(input.config.operationMode.replace("_", " "))} · ${input.config.answerAfterRings} rings</p></article><article><h2>Plan</h2><p>${money(input.config.flatMonthlyPriceCents)}/month · ${input.config.includedCalls} answered calls · ${excludedSpam} spam excluded</p></article><article><h2>Integrations</h2><ul>${integrationItems}</ul></article></section><section><h2>Recent calls</h2><div class="table"><table><thead><tr><th>When</th><th>Caller</th><th>Problem</th><th>Priority</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div></section></main>`);
}

export function renderConfig(
  config: BusinessConfig,
  csrf: string,
  integrations: { googleAvailable: boolean; googleConnected: boolean; ownerPhoneConfigured: boolean; weeklyEmailAvailable?: boolean; directBookingAvailable?: boolean },
  surface: "platform" | "owner" = "platform",
): string {
  const base = surface === "owner" ? "/app" : "/admin";
  const googleAction = integrations.googleConnected
    ? `<strong class="good">Connected</strong>`
    : integrations.googleAvailable
      ? `<a href="${base}/integrations/google/start">Connect Google Calendar</a>`
      : `<strong class="error">Google OAuth client not configured</strong>`;
  const platformNav = surface === "platform" ? `<a href="/admin/readiness">Readiness</a><a href="/admin/simulator">Simulator</a>` : "";
  const planField = surface === "platform"
    ? `<label>Flat monthly price ($49–$400)<input name="flatMonthlyPrice" type="number" min="49" max="400" step="1" value="${Math.round(config.flatMonthlyPriceCents / 100)}"></label>`
    : `<label>Plan<input value="${money(config.flatMonthlyPriceCents)}/month · ${config.includedCalls} answered calls included · ${perCall(config.overageCentsPerCall)} per extra call" disabled><input name="flatMonthlyPrice" type="hidden" value="${Math.round(config.flatMonthlyPriceCents / 100)}"></label>`;
  const customerSms = surface === "platform" ? `<label class="check"><input name="customerSmsEnabled" type="checkbox" ${config.customerSmsEnabled ? "checked" : ""}> Customer-facing appointment SMS enabled only after that shop’s carrier registration is approved</label>` : `<p class="small">Owner alerts are included. Customer-facing texts stay off until carrier registration is approved for your shop.</p>`;
  const hourOptions = Array.from({ length: 24 }, (_, hour) => `<option value="${hour}" ${config.ownerDailySmsHour === hour ? "selected" : ""}>${new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, hour)))}</option>`).join("");
  const disabled = (available: boolean | undefined): string => available ? "" : " disabled";
  const notificationSettings = `<section class="notification-options"><p class="eyebrow">Owner updates</p><h2>Choose how Call Otto keeps you on track</h2><label class="notification-option"><input name="ownerWeeklyEmailEnabled" type="checkbox" ${config.ownerWeeklyEmailEnabled ? "checked" : ""}${disabled(integrations.weeklyEmailAvailable)}><span><strong>Sunday week-ahead email <em>Included</em></strong><small>Open callbacks and the next seven days of appointments.</small>${integrations.weeklyEmailAvailable ? "" : "<small class=error>Email delivery is awaiting setup.</small>"}</span></label><label class="notification-option"><input name="ownerDailySmsEnabled" type="checkbox" ${config.ownerDailySmsEnabled ? "checked" : ""}><span><strong>Daily text recap <em>Included</em></strong><small>Follow-ups and appointments, once each morning.</small></span></label><label>Daily recap time<select name="ownerDailySmsHour">${hourOptions}</select></label><label class="notification-option"><input name="ownerRealtimeSmsEnabled" type="checkbox" ${config.ownerRealtimeSmsEnabled ? "checked" : ""}><span><strong>Instant lead texts <em>Included</em></strong><small>Routine new leads as they arrive. Emergency and handoff texts are always on.</small></span></label></section>`;
  return layout("Configuration", `<header><div><p class="eyebrow">Owner setup</p><h1>Configuration</h1></div><nav><a href="${base}">Calls</a>${platformNav}</nav></header><main><section><h2>Calendar</h2><p>${googleAction}</p><p>A booking counts only after a system-of-record write is read back, the recording and transcript exist, and intake is complete.</p></section><form method="post" action="${base}/config"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><div class="status ${config.paused ? "badbox" : "goodbox"}"><h2>${config.paused ? "Service paused" : "Service enabled"}</h2><label>Service state<select name="serviceState"><option value="paused" ${config.paused ? "selected" : ""}>paused—disconnect the AI line</option><option value="active" ${!config.paused ? "selected" : ""}>active—connect the AI line</option></select></label><p class="small">Paused means the AI cannot answer. New accounts stay paused until assisted activation is complete.</p></div><div class="grid two"><label>Business name<input name="businessName" value="${escapeHtml(config.businessName)}" required></label><label>Timezone<input name="timezone" value="${escapeHtml(config.timezone)}" required></label></div><label>Greeting<textarea name="greeting" required>${escapeHtml(config.greeting)}</textarea></label><div class="grid two"><label>Owner alert phone<input name="ownerPhone" type="tel" placeholder="${integrations.ownerPhoneConfigured ? "Configured—enter a replacement only" : "+15555550100"}"></label>${surface === "platform" || integrations.directBookingAvailable ? `<label>Booking mode<select name="bookingMode"><option value="confirm" ${config.bookingMode === "confirm" ? "selected" : ""}>confirm first</option><option value="direct" ${config.bookingMode === "direct" ? "selected" : ""}>direct booking</option></select></label>` : `<input type="hidden" name="bookingMode" value="confirm">`}</div><div class="grid two"><label>Coverage mode<select name="operationMode">${option("always", config.operationMode)}${option("after_hours", config.operationMode)}${option("overflow", config.operationMode)}</select></label><label>Answer after rings<input name="answerAfterRings" type="number" min="2" max="12" step="0.5" value="${config.answerAfterRings}"></label></div><div class="grid two">${planField}<label>Data retention (days)<input name="dataRetentionDays" type="number" min="7" max="365" step="1" value="${config.dataRetentionDays}"></label></div>${notificationSettings}<div class="grid two"><label>Default job duration (minutes)<input name="defaultServiceDurationMinutes" type="number" min="15" max="480" step="15" value="${config.defaultServiceDurationMinutes}"></label><label>Emergency score threshold<input name="emergencyThreshold" type="number" min="0.5" max="0.9" step="0.05" value="${config.emergencyThreshold}"></label></div><div class="grid two"><label>Calls allowed per caller per 24 hours<input name="maxCallsPerCallerPerDay" type="number" min="1" max="20" step="1" value="${config.maxCallsPerCallerPerDay}"></label><label>Support/cancellation email<input name="supportEmail" type="email" value="${escapeHtml(config.supportEmail ?? "")}" placeholder="support@example.com"></label></div>${customerSms}<label class="check"><input name="requireDiagnosticFeeAcceptance" type="checkbox" ${config.requireDiagnosticFeeAcceptance ? "checked" : ""}> Require diagnostic-fee acceptance</label><div class="grid two"><label>Covered city + state pairs and ZIP codes<textarea name="serviceAreaTerms" placeholder="Albany NY, 12207, 12208">${escapeHtml(config.serviceAreaTerms.join(", "))}</textarea><span class="small">Use city and state together. The agent never infers a radius.</span></label><label>Service categories (comma separated)<textarea name="serviceCategories">${escapeHtml(config.serviceCategories.join(", "))}</textarea></label></div><label>Emergency keywords (comma separated)<textarea name="emergencyKeywords">${escapeHtml(config.emergencyKeywords.join(", "))}</textarea></label><div class="grid two"><label>Approved price/script snippets (one Label: Exact wording per line)<textarea name="priceSnippets">${escapeHtml(config.priceSnippets.map((item) => `${item.label}: ${item.text}`).join("\n"))}</textarea></label><label>Owner-approved knowledge (one Topic: Answer per line)<textarea name="approvedKnowledge">${escapeHtml(config.approvedKnowledge.map((item) => `${item.topic}: ${item.text}`).join("\n"))}</textarea></label></div><label>Pronunciations (one Term: Spoken as per line)<textarea name="pronunciations">${escapeHtml(config.pronunciations.map((item) => `${item.term}: ${item.spokenAs}`).join("\n"))}</textarea></label><div class="grid two"><label>Weekday coverage starts<input name="weekdayStart" type="time" value="${escapeHtml(config.afterHours.weekdayStart)}"></label><label>Weekday coverage ends<input name="weekdayEnd" type="time" value="${escapeHtml(config.afterHours.weekdayEnd)}"></label></div><label>Holiday coverage dates (comma separated YYYY-MM-DD)<textarea name="holidayDates">${escapeHtml(config.afterHours.holidayDates.join(", "))}</textarea></label><label class="check"><input name="weekends" type="checkbox" ${config.afterHours.weekends ? "checked" : ""}> Cover weekends</label><h2>Appointments the agent may offer</h2><div class="grid two"><label>Bookable day starts<input name="bookableWeekdayStart" type="time" value="${escapeHtml(config.bookableHours.weekdayStart)}"></label><label>Bookable day ends<input name="bookableWeekdayEnd" type="time" value="${escapeHtml(config.bookableHours.weekdayEnd)}"></label></div><div class="grid two"><label>Minimum notice (minutes)<input name="minimumLeadTimeMinutes" type="number" min="0" max="10080" step="30" value="${config.minimumLeadTimeMinutes}"></label><label class="check"><input name="bookableWeekends" type="checkbox" ${config.bookableHours.weekends ? "checked" : ""}> Offer weekend appointments</label></div><label>Recording/AI disclosure<textarea name="recordingDisclosure" required>${escapeHtml(config.recordingDisclosure)}</textarea></label><button>Save configuration</button></form>${surface === "owner" ? `<section><h2>Your data</h2><p><a href="/app/account/export">Download all your call records and settings</a> (JSON).</p><form method="post" action="/app/account/sign-out-everywhere"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button>Sign out on every device</button></form><form method="post" action="/app/account/delete"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><h3>Delete your account</h3><p class="small">Cancel your subscription in Billing first. This disconnects your Call Otto line and permanently deletes every call record, transcript, recording, task and setting. Appointments already on your calendar stay there.</p><label>Type DELETE to confirm<input name="confirm" autocomplete="off" required></label><label>Your password<input name="password" type="password" autocomplete="current-password" required></label><button class="dangerbutton">Delete my account</button></form></section>` : ""}</main>`);
}

export function renderCallDetail(input: {
  config: BusinessConfig;
  call: CallRecord;
  booking: BookingRecord | null;
  callbackTask: CallbackTask | null;
  events: ToolEvent[];
  notifications: OutboxNotification[];
  csrf: string;
  surface?: "platform" | "owner";
  canDelete?: boolean;
}): string {
  const call = input.call;
  const eventRows = input.events.map((event) => `<tr><td>${escapeHtml(event.tool)}</td><td>${escapeHtml(event.result)}</td><td>${event.latencyMs} ms</td><td>${escapeHtml(event.redactedError ?? "")}</td></tr>`).join("") || `<tr><td colspan="4">No tool events.</td></tr>`;
  const notificationRows = input.notifications.map((item) => `<tr><td>${escapeHtml(item.channel)}</td><td>${escapeHtml(item.priority)}</td><td>${escapeHtml(item.state)}</td><td>${escapeHtml(item.sentAt ? formatDate(item.sentAt, input.config.timezone) : item.lastError ?? "queued")}</td></tr>`).join("") || `<tr><td colspan="4">No notifications.</td></tr>`;
  const storedRecording = safeHttpsUrl(call.recordingUrl);
  const recording = input.surface === "owner" ? storedRecording?.replace("/admin/provider/", "/app/provider/") ?? null : storedRecording;
  const base = input.surface === "owner" ? "/app" : "/admin";
  return layout("Call", `<header><div><p class="eyebrow">${escapeHtml(formatDate(call.startedAt, input.config.timezone))}</p><h1>${escapeHtml(call.fields.callerName ?? "Unknown caller")}</h1></div><nav><a href="${base}">Calls</a></nav></header><main><section class="grid"><article><h2>Outcome</h2><p>${escapeHtml(call.outcome)}</p></article><article><h2>Priority</h2><p>${escapeHtml(call.emergency?.severity ?? "not classified")}</p></article><article><h2>Booking</h2><p>${escapeHtml(input.booking?.status ?? "none")}</p></article></section>${input.callbackTask ? `<section><h2>Owned callback</h2><p>${escapeHtml(input.callbackTask.ownerRef)} · due ${escapeHtml(formatDate(input.callbackTask.dueAt, input.config.timezone))} · ${escapeHtml(input.callbackTask.reason)}</p></section>` : ""}<section class="grid two"><article><h2>Caller</h2><dl><dt>Phone</dt><dd>${escapeHtml(call.fields.callbackNumber ?? call.fromNumber)}</dd><dt>Address</dt><dd>${escapeHtml(call.fields.address ?? "Not confirmed")}</dd><dt>Category</dt><dd>${escapeHtml(call.fields.serviceCategory ?? "Not classified")}</dd><dt>Problem</dt><dd>${escapeHtml(call.fields.problemDescription || "Not captured")}</dd></dl></article><article><h2>Evidence</h2><dl><dt>Verification gaps</dt><dd>${escapeHtml(call.qualityFlags.join(", ") || "None")}</dd><dt>Emergency evidence</dt><dd>${escapeHtml(call.emergency?.evidence.join(", ") || "None")}</dd><dt>Consent</dt><dd>${escapeHtml(call.consentState)}</dd><dt>Billing</dt><dd>${escapeHtml(call.billingDisposition)}${usageClass(call) === "short" ? " (under 15 seconds, not counted)" : ""}</dd><dt>Recording</dt><dd>${recording ? `<a href="${escapeHtml(recording)}" rel="noreferrer">Open recording</a>` : "Unavailable"}</dd></dl></article></section><section><h2>Transcript</h2><pre>${escapeHtml(call.transcript ?? "Transcript unavailable")}</pre></section><section><h2>Tool events</h2><div class="table"><table><tbody>${eventRows}</tbody></table></div></section><section><h2>Owner alerts</h2><div class="table"><table><tbody>${notificationRows}</tbody></table></div></section>${input.canDelete === false ? "" : `<form method="post" action="${base}/calls/${encodeURIComponent(call.id)}/delete"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><h2>Delete call data</h2><p>This permanently removes the call record, transcript, recording, callback, tool events, notifications, and any customer record whose latest call is this one. Appointments already on your calendar stay on your calendar.</p><label class="check"><input name="confirm" type="checkbox" value="delete" required> I understand this cannot be undone.</label><button class="dangerbutton">Delete permanently</button></form>`}</main>`);
}

export function renderReadiness(report: ActivationReport, config: BusinessConfig): string {
  const rows = report.checks.map((item) => `<tr><td><strong class="${item.status === "pass" ? "good" : item.status === "block" ? "error" : ""}">${escapeHtml(item.status.toUpperCase())}</strong></td><td>${escapeHtml(item.label)}</td><td>${escapeHtml(item.detail)}</td></tr>`).join("");
  return layout("Readiness", `<header><div><p class="eyebrow">Commercial activation</p><h1>${report.go ? "GO" : "NO-GO"}</h1></div><nav><a href="/admin">Calls</a><a href="/admin/config">Configuration</a><a href="/admin/simulator">Simulator</a></nav></header><main><section class="status ${report.go ? "goodbox" : "badbox"}"><h2>${report.go ? "First-customer gate passed" : `${report.blocking.length} blocking requirement(s)`}</h2><p>Runtime mode: ${escapeHtml(report.mode.replace("_", " "))}. Service state: ${config.paused ? "paused" : "enabled"}. Warnings remain visible but do not turn a proven live system into NO-GO.</p></section><section><h2>Activation checks</h2><div class="table"><table><thead><tr><th>Status</th><th>Check</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div></section></main>`);
}

export function renderSimulator(results: SimulationResult[] | null, csrf: string): string {
  const options = SIMULATION_SCENARIOS.map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`).join("");
  const output = results === null ? "" : `<section><h2>${results.every((item) => item.passed) ? "All selected scenarios passed" : "One or more scenarios failed"}</h2><div class="table"><table><thead><tr><th>Result</th><th>Scenario</th><th>Expected</th><th>Observed</th></tr></thead><tbody>${results.map((item) => `<tr><td><strong class="${item.passed ? "good" : "error"}">${item.passed ? "PASS" : "FAIL"}</strong></td><td>${escapeHtml(item.label)}</td><td>${escapeHtml(item.expected)}</td><td>${escapeHtml(item.observed)}</td></tr>`).join("")}</tbody></table></div></section>`;
  return layout("Simulator", `<header><div><p class="eyebrow">Credential-free test bench</p><h1>Launch simulator</h1></div><nav><a href="/admin">Calls</a><a href="/admin/readiness">Readiness</a></nav></header><main><section><p>Runs synthetic data in an isolated in-memory store. It never calls Telnyx, Google, or the production database.</p><form method="post" action="/admin/simulator"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Scenario<select name="scenario"><option value="all">Run all 15 launch scenarios</option>${options}</select></label><button>Run simulator</button></form></section>${output}</main>`);
}

/** Google's policy that the Limited Use statement on the Privacy page points to. */
export const GOOGLE_USER_DATA_POLICY_URL = "https://developers.google.com/terms/api-services-user-data-policy";
const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

/** Every outside company that handles Call Otto data (src/adapters, src/http/posthog-proxy.ts). Keep in step with the code. */
const SERVICE_PROVIDERS: ReadonlyArray<readonly [name: string, role: string]> = [
  ["Telnyx", "phone numbers, answering calls with the AI voice assistant, transcripts and recordings, text messages, and automated owner calls"],
  ["Google", "Google Calendar, only for people who connect it (see Google Calendar data)"],
  ["Stripe", "subscription payments. Card details go straight to Stripe; Call Otto never sees or stores full card numbers"],
  ["Resend", "account email"],
  ["Railway", "hosting for the app and its database"],
  ["PostHog", "product analytics and error tracking (see Analytics)"],
  ["Browser push services (Apple, Google, Mozilla or Microsoft, depending on the device)", "delivering encrypted app notifications to phones where the owner turns them on"],
];

/** What Google's OAuth verification asks a privacy policy to say about Google user data, for the two Calendar scopes we request. */
function googleCalendarPrivacyHtml(support: string): string {
  return `<h2 id="google-calendar">Google Calendar data</h2><p>Connecting Google Calendar is optional. An owner or team member connects it in Settings and approves access on Google's own consent screen. Call Otto asks for two Google permissions and no others, and it connects only when both are allowed:</p><ul><li><strong>Free/busy times</strong> (calendar.freebusy). Call Otto checks when the connected calendar is busy, so the assistant offers callers only open times. This shows busy periods, not event titles, details or guests.</li><li><strong>Events on calendars you own</strong> (calendar.events.owned). When a caller books a job, Call Otto adds it to your own calendar with the caller's name, callback number, address and problem. It reads back only the events it created, to confirm each booking. It does not read, change or delete any other events.</li></ul><p><strong>How it is used.</strong> Call Otto uses Google user data only to check availability and to add booked jobs. It does not sell Google user data, use it for advertising, or use it to develop, improve or train AI or machine learning models. The only part that leaves Call Otto is the open times the assistant offers on a call, which pass through our voice provider, Telnyx, so the caller can hear them. Call Otto staff do not read Google user data unless the owner asks us to for support, it is needed for security, or the law requires it.</p><p><strong>Storage and protection.</strong> Call Otto keeps Google's access grant (a refresh token) encrypted with AES-256 in its database. It never stores the calendar's busy times. Call Otto connects to Google over HTTPS. The open times offered on a call and the id of each event Call Otto created are saved with that call's record.</p><p><strong>Retention and deletion.</strong> Those call details follow the retention period below and are deleted with the call. Jobs added to the calendar stay there until the owner removes them. The access grant is deleted when the account is deleted, when a teammate is removed, and the next time Call Otto tries to use it after access was removed.</p><p><strong>Disconnecting.</strong> Remove Call Otto's access anytime at <a href="${GOOGLE_PERMISSIONS_URL}">myaccount.google.com/permissions</a>. Call Otto then stops checking and adding to that calendar. You can also ask ${support} to disconnect it, or delete your account in Settings.</p><p>Call Otto's use and transfer of information received from Google APIs to any other app will adhere to the <a href="${GOOGLE_USER_DATA_POLICY_URL}">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>`;
}

/** Privacy and Terms: the brand with a way home, and lines a readable length (about 70 characters). Layout only. */
const LEGAL_TOP = `<style>.legaltop{display:flex;align-items:center;min-height:56px;padding:0 16px;border-bottom:1px solid #e6e1d3;background:#faf8f1}.legaltop a{display:inline-flex;align-items:center;min-height:44px;color:#0b2545;font:600 20px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;text-decoration:none}.legaltop em{font-family:Georgia,serif;font-weight:500}.legalpage{max-width:70ch;margin:0 auto;padding:0 16px}.legalpage header,.legalpage main{max-width:none;padding-inline:0}</style><div class="legaltop"><a href="/">Call&nbsp;<em>Otto</em></a></div>`;

export function renderPrivacy(config: BusinessConfig): string {
  const support = supportContactHtml();
  const providers = SERVICE_PROVIDERS.map(([name, role]) => `<li><strong>${escapeHtml(name)}</strong>: ${escapeHtml(role)}.</li>`).join("");
  return layout("Privacy", `${LEGAL_TOP}<div class="legalpage"><header><div><p class="eyebrow">${escapeHtml(config.businessName)}</p><h1>Privacy notice</h1></div><nav><a href="/terms">Terms</a></nav></header><main><section><h2>Who we are</h2><p>${companyStatementHtml()}</p><h2>What is collected</h2><p>Owner accounts store encrypted contact and business settings plus a one-way password hash. The call service may store caller phone number, name, service address, problem description, transcript, recording link, call outcome, booking evidence, and notification status.</p><h2>Who processes it</h2><p>The configured voice, telephony/SMS, calendar, hosting, database, and payment providers process only the data needed for their role. The service does not sell caller or owner data.</p><p>These are the service providers Call Otto uses:</p><ul>${providers}</ul>${googleCalendarPrivacyHtml(support)}<h2>Email</h2><p>Call Otto sends account email (password resets, call and booking notifications, an optional weekly summary, and usage, billing and service messages) through Resend, from a callotto.co address. It goes to the account email and may include the caller details the owner needs to follow up. Call Otto does not email callers. Ask ${support} to stop emails.</p><h2>Analytics</h2><p>Call Otto uses PostHog to count visits, see how the app is used, and catch errors. On the public site, analytics store nothing in your browser and record no sessions. In the owner app, PostHog may record sessions with all text and typed input masked and call screens hidden. Call Otto removes emails and phone numbers from analytics events. Analytics use an account id, never an email or phone number. Caller details and Google user data are never sent to PostHog.</p><h2>SMS consent data</h2><p>Phone numbers and SMS opt-in or consent records are not sold, rented, or shared with third parties or affiliates for marketing or promotional purposes. They are shared only with service providers that must process them to operate the requested messaging service.</p><h2>Retention and deletion</h2><p>Call records are retained for ${config.dataRetentionDays} days unless legal or customer obligations require a different period. The owner can delete a call immediately from its protected detail page. Appointments written to the owner's Google Calendar are kept in that calendar and managed by the owner; deleting a call record does not remove them. Contact ${support} for access, correction, export, or deletion requests.</p><h2>Recordings</h2><p>Calls answered for the business are transcribed so the owner can follow up, and recorded unless the business has chosen transcript-only. If a call is transferred to the business, the caller may hear a short recording notice first. If a caller objects to being recorded, that call's recording is deleted after the call.</p><h2>Changes</h2><p>Updated November 24, 2026. If Call Otto changes how it uses Google user data, this page will be updated and owners will be told by email before the change applies.</p></section></main></div>`);
}

export function renderTerms(config: BusinessConfig, plans: Plan[] = []): string {
  const support = supportContactHtml();
  const overage = perCall(plans[0]?.overageCentsPerCall ?? config.overageCentsPerCall);
  const planList = plans.length
    ? plans.map((plan) => `${escapeHtml(plan.label)} is ${money(plan.priceCents)} per month and includes ${plan.includedCalls} answered calls`).join("; ")
    : `The plan is ${money(config.flatMonthlyPriceCents)} per month and includes ${config.includedCalls} answered calls`;
  const intro = plans.some((plan) => plan.firstMonthCents < plan.priceCents) ? " Limited time: the first month of every plan is half price (a one-time discount on the whole first invoice, the Unlimited calls add-on included)." : "";
  const addOns = plans.filter((plan) => plan.unlimited);
  const unlimited = addOns.length
    ? `<h2>Unlimited calls add-on</h2><p>Any plan can add Unlimited calls: ${addOns.map((plan) => `${escapeHtml(plan.label)} plus ${money(plan.unlimited!.addOnCents)} per month (${money(plan.unlimited!.priceCents)} in total)`).join("; ")}. It is off unless the owner turns it on at checkout or in Settings, and turning it on or off is prorated by Stripe. While it is on, no extra-call charge applies to counted calls up to fair use: ${FAIR_USE_MULTIPLIER} times the plan’s included calls in a billing period. Each counted call beyond fair use is ${overage}. Calls answered while the add-on was off count against the plan’s included calls as usual.</p>`
    : "";
  const pricing = `<h2>Pricing and usage</h2><p>${planList}.${intro} There is no free trial: the first month is charged at checkout. A call counts toward the plan only when Call Otto answers it, it is not spam, and it lasts at least 15 seconds. Each counted call beyond the plan’s included calls is ${overage}; extra calls are shown in the owner dashboard as they happen and billed on a separate invoice after the billing period ends. Team members are free on every plan; the price is per shop line. Plans can be changed in Settings; Stripe prorates the difference. Customer-facing SMS is disabled unless the shop’s carrier registration is approved.</p>${unlimited}<h2>Lead guarantee</h2><p>${escapeHtml(LEAD_GUARANTEE)} A real lead is an answered, non-spam call of at least 15 seconds in which Call Otto captured the caller’s name and a description of the problem, or that created a booking or callback task. The refund covers the first month’s charge, can be requested from day 30 to day 37 after the first payment (in the app, or by replying to the receipt), and applies once per shop. The subscription continues unless the owner cancels it.</p>`;
  return layout("Terms", `${LEGAL_TOP}<div class="legalpage"><header><div><p class="eyebrow">${escapeHtml(config.businessName)}</p><h1>Service terms</h1></div><nav><a href="/privacy">Privacy</a></nav></header><main><section><h2>Who we are</h2><p>${companyStatementHtml()}</p><h2>Scope</h2><p>This service is an AI-assisted receptionist. It is not emergency dispatch, a licensed trade professional, or a guarantee that an appointment is booked. Only a verified system write and explicit confirmation count as booked.</p><h2>Owner authorization</h2><p>By creating an account, activating service, or paying for a subscription, the owner authorizes Call Otto and its service providers to answer eligible calls with an automated assistant and to record and transcribe those calls. Call recording, monitoring and caller-notice rules vary by state. Call Otto offers an optional recording notice; the owner decides whether to use it, is solely responsible for giving any notice and obtaining any consent their callers' jurisdictions require, and agrees to indemnify and hold Call Otto harmless from claims arising from that choice.</p><h2>Caller recordings</h2><p>If a caller objects to being recorded, the recording of that call is deleted after the call; the transcript of the request is kept so the owner can follow up.</p>${pricing}<h2>Account text notifications</h2><p>Call Otto, a product of Dutchworks LLC, sends account notifications (new-call, urgent-call and booking notifications, an optional daily recap, and service messages) by text to the owner number that opted in. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Contact ${support} for help.</p><h2>Other account notifications</h2><p>Call Otto also sends account notifications by app notification to phones where the owner turns them on, by email to the account email, and, for emergency calls, by an automated call to the owner mobile number (see Automated emergency calls). Turn app notifications off in Settings on each phone; ask ${support} to stop emails.</p><h2>Automated emergency calls</h2><p>Only if the owner agrees (an unchecked box at signup, or a switch in Settings), Call Otto by Dutchworks LLC calls the owner mobile number with an automated, artificial-voice message when a caller has an emergency or life-safety problem. Each call reads a short summary and is limited to emergencies, at most three an hour. Agreeing is not a condition of purchase. To stop, press 9 during any of these calls, turn the switch off in Settings, or contact ${support}. We record when and how the owner agreed.</p><h2>Google Calendar</h2><p>Connecting Google Calendar is optional. By connecting it, the owner or team member authorizes Call Otto to check when that calendar is busy and to add booked jobs to it, as described in the <a href="/privacy">Privacy notice</a>. Remove access anytime at <a href="${GOOGLE_PERMISSIONS_URL}">myaccount.google.com/permissions</a> or through ${support}. Jobs already added stay on the calendar.</p><h2>Cancellation and support</h2><p>Cancel anytime in the app: Settings → Plan and billing, then Manage billing or cancel. Pause anytime in Settings. You can also cancel or pause through ${support}. Pausing rejects new provider traffic; data follows the published retention/deletion process.</p><h2>Availability</h2><p>Voice, carrier, SMS, calendar, and hosting providers can fail. The product records failures and creates follow-up work, but it cannot guarantee uninterrupted delivery.</p></section></main></div>`);
}

export function renderPrompt(config: BusinessConfig, publicBaseUrl: string, voice?: string): string {
  return layout("Telnyx setup", `<header><div><p class="eyebrow">Provider setup</p><h1>Telnyx assistant configuration</h1></div><nav><a href="/admin">Calls</a></nav></header><main><p>This is the exact idempotent assistant update generated from the owner configuration. Apply it with <code>npm run configure:telnyx -- --apply</code>; never paste secrets into this page.</p><pre>${escapeHtml(JSON.stringify(buildTelnyxAssistantUpdate(config, publicBaseUrl, { voice }), null, 2))}</pre></main>`);
}

export function publicLayout(title: string, body: string): string {
  body = `<style>
    .mascot-stage{position:relative;display:grid;place-items:center;min-height:430px}
    .mascot-stage img{display:block;width:min(100%,390px);height:auto;filter:drop-shadow(10px 10px 0 rgba(7,89,168,.14))}
    .mascot-bubble{position:absolute;top:4%;right:-4%;margin:0;background:var(--white);border:3px solid var(--blue);padding:11px 14px;box-shadow:4px 4px 0 var(--blue);font:900 14px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif;transform:rotate(2deg)}
    .mini-receipt{position:absolute;left:-3%;bottom:2%;display:grid;gap:4px;width:min(280px,78%);background:var(--yellow);border:3px solid var(--blue);padding:14px;box-shadow:6px 6px 0 var(--blue);transform:rotate(-2deg);font:800 14px/1.25 ui-sans-serif,system-ui,-apple-system,sans-serif}
    .mini-receipt span{font-weight:600}
    .ticker .ticker-track{display:flex;min-width:max-content;width:max-content;padding:0;animation:marquee 56s linear infinite;will-change:transform}
    .ticker-track span{display:block;flex:none;min-width:max-content;padding:14px 0;font:900 15px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.08em}
    .publicform fieldset{margin:0 0 28px;padding:0 0 8px;border:0;border-bottom:2px solid rgba(7,89,168,.28)}
    .publicform fieldset:last-child{margin-bottom:0;padding-bottom:0;border-bottom:0}
    .publicform legend{display:flex;align-items:center;gap:10px;width:100%;margin:0 0 22px;padding:0;color:var(--blue);font:900 20px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif}
    .publicform legend span{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--blue);color:white;font-size:13px}
    .form-reassurance{margin:0 0 22px;padding:13px 14px;border:2px solid var(--blue);background:var(--white);font:700 14px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}
    .publicform.is-enhanced fieldset{display:none;margin:0;padding:0;border:0}
    .publicform.is-enhanced fieldset.active{display:block}
    .wizard-progress{display:grid;gap:8px;max-width:920px;margin:0 auto 14px;font:800 13px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif}
    .wizard-progress i{display:block;height:6px;background:rgba(7,89,168,.16);overflow:hidden}
    .wizard-progress i b{display:block;width:var(--progress);height:100%;background:var(--blue);transition:width .2s ease}
    .wizard-actions{display:flex;justify-content:space-between;gap:14px;margin-top:8px}
    .wizard-actions .wizard-back{background:var(--white);color:var(--blue);box-shadow:none}
    .faq details{border-top:2px solid var(--blue);padding:20px 0}
    .faq details:last-child{border-bottom:2px solid var(--blue)}
    .faq summary{cursor:pointer;font:900 20px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif}
    .faq details p{max-width:760px}
    @media(max-width:800px){.mascot-stage{min-height:380px}.mascot-bubble{right:0}.mini-receipt{left:0}}
    @media(prefers-reduced-motion:reduce){.ticker .ticker-track{animation:none}}
  </style>${body}<script src="/assets/signup-wizard.js" defer></script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f1efe7"><meta name="description" content="An AI receptionist for local trade and home-service shops that handles missed and after-hours calls."><title>${escapeHtml(title)} · Call Otto</title><style>:root{color-scheme:light;--blue:#0759a8;--yellow:#e7f34b;--red:#e53221;--red-strong:#b42318;--error-ink:#a41d12;--paper:#f1efe7;--ink:#073f77;--white:#fffef8;--field-ink:#0a2540;--line:#0759a8;--shadow:6px 6px 0 var(--blue)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background-color:var(--paper);background-image:radial-gradient(rgba(7,89,168,.07) .7px,transparent .8px),linear-gradient(90deg,rgba(255,255,255,.24),rgba(7,89,168,.025));background-size:5px 5px,100% 100%;font:17px/1.42 Georgia,"Times New Roman",serif}.announcement{background:var(--red-strong);color:white;text-align:center;text-transform:uppercase;letter-spacing:.05em;font:800 13px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:11px 16px}.announcement span{display:inline-block;margin-left:10px}.publicnav,.publicmain{max-width:1240px;margin:auto;padding-left:28px;padding-right:28px}.publicnav{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-top:24px;padding-bottom:18px;border-bottom:2px solid var(--blue)}.publicnav nav{display:flex;gap:24px;align-items:center;font:700 15px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif}.publicnav a,.publicfooter a,.textlink{color:var(--blue);text-underline-offset:4px}.brand{font:italic 900 clamp(42px,7vw,82px)/.8 Georgia,"Times New Roman",serif;text-decoration:none;letter-spacing:-.07em;white-space:nowrap}.brand span{font-style:normal}.smallbrand{font-size:clamp(36px,5vw,58px)}.navbutton{background:var(--yellow);border:2px solid var(--blue);padding:11px 15px;text-decoration:none;box-shadow:3px 3px 0 var(--blue);text-transform:uppercase}.publichero{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);gap:clamp(36px,8vw,100px);align-items:center;padding:clamp(64px,10vw,130px) 0 80px}.eyebrow{font:900 13px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif;text-transform:uppercase;letter-spacing:.11em;margin:0 0 14px}.publichero h1,.formintro h1,.received h1{text-wrap:balance;font:900 clamp(52px,8.6vw,112px)/.88 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.065em;margin:0;max-width:980px}.publichero h1 em{display:block;color:var(--red);font:italic 900 1.02em/.92 Georgia,"Times New Roman",serif;letter-spacing:-.055em}.lede{font-size:clamp(20px,2.2vw,29px);max-width:760px;margin:28px 0}.actions{display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin:28px 0 18px}.button,.publicform button{display:inline-block;background:var(--yellow);color:var(--blue);border:2px solid var(--blue);box-shadow:var(--shadow);padding:15px 20px;text-decoration:none;text-transform:uppercase;font:900 14px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.03em;cursor:pointer;transition:transform .16s,box-shadow .16s}.button:hover,.button:focus-visible,.publicform button:hover,.publicform button:focus-visible{transform:translate(3px,3px);box-shadow:3px 3px 0 var(--blue)}.button:focus-visible,.publicform button:focus-visible{outline:3px solid var(--field-ink);outline-offset:3px}.publicnav a:focus-visible,.publicmain a:focus-visible,.publicmain summary:focus-visible{outline:3px solid var(--field-ink);outline-offset:2px}.textlink{font-weight:700}.small{font-size:14px}.call-card{position:relative;background:var(--yellow);border:3px solid var(--blue);box-shadow:12px 12px 0 var(--blue);padding:24px;transform:rotate(2deg)}.call-top{font:900 12px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif;text-transform:uppercase;letter-spacing:.08em}.live-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--red);margin-right:7px}.caller{font:900 clamp(28px,4vw,48px)/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.04em;margin:30px 0}.call-card dl{margin:0;border-top:2px solid var(--blue)}.call-card dl div{display:flex;justify-content:space-between;gap:20px;border-bottom:2px solid var(--blue);padding:10px 0}.call-card dt{font-weight:700}.call-card dd{margin:0;text-align:right}.call-stamp{display:inline-block;margin:28px 0 0;border:3px solid var(--red);color:var(--red);font:900 16px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:8px 10px;transform:rotate(-5deg)}.ticker{overflow:hidden;border-block:3px solid var(--blue);background:var(--blue);color:var(--yellow);margin-inline:calc(50% - 50vw);white-space:nowrap}.ticker div{display:inline-block;min-width:200%;padding:14px 0;font:900 15px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.08em;animation:marquee 26s linear infinite}@keyframes marquee{to{transform:translateX(-50%)}}.publicsection{padding:clamp(70px,10vw,130px) 0;border-bottom:2px solid var(--blue)}.publicsection>h2,.rules h2,.steps h2{font:900 clamp(40px,6vw,76px)/.95 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.055em;max-width:940px;margin:0 0 46px}.feature-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.feature-grid article{min-height:310px;background:var(--white);border:3px solid var(--blue);padding:24px;box-shadow:8px 8px 0 var(--blue)}.feature-grid article.yellow{background:var(--yellow);transform:rotate(-1deg)}.feature-grid article.red{background:var(--red);color:white;transform:rotate(1.2deg)}.number{display:block;font:900 15px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;margin-bottom:80px}.feature-grid h3{font:900 clamp(30px,4vw,48px)/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.045em;margin:0 0 14px}.feature-grid p{margin:0}.rules{display:grid;grid-template-columns:1fr 1fr;gap:clamp(40px,10vw,130px);align-items:center}.rules h2{margin:0}.rules div:last-child{font-size:clamp(20px,2.2vw,27px)}.steps ol{list-style:none;padding:0;margin:0;border-top:2px solid var(--blue)}.steps li{display:grid;grid-template-columns:1fr 1.3fr;gap:40px;padding:24px 0;border-bottom:2px solid var(--blue)}.steps strong{font:900 clamp(22px,3vw,34px)/1.1 ui-sans-serif,system-ui,-apple-system,sans-serif}.pricing{display:grid;grid-template-columns:1fr 1fr;gap:clamp(40px,10vw,130px);align-items:center;background:var(--yellow);margin-inline:calc(50% - 50vw);padding-left:max(28px,calc((100vw - 1184px)/2));padding-right:max(28px,calc((100vw - 1184px)/2))}.pricing h2{font:900 clamp(70px,10vw,132px)/.8 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.075em;margin:0}.pricing h2 span{font-size:.18em;letter-spacing:0}.publicfooter{display:flex;justify-content:space-between;gap:24px;padding:32px 0 48px;font:700 14px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif}.publicfooter div{display:flex;gap:20px}.formpage{max-width:980px}.formintro,.received{padding:clamp(60px,9vw,120px) 0 45px}.formintro h1,.received h1{font-size:clamp(48px,8vw,96px)}.formintro>p:last-child,.received>p{font-size:21px;max-width:740px}.publicform{background:var(--yellow);border:3px solid var(--blue);box-shadow:12px 12px 0 var(--blue);padding:clamp(22px,5vw,48px);margin:0 0 80px}.grid{display:grid;gap:18px}.grid.two{grid-template-columns:repeat(2,1fr)}.publicform label{display:block;font:800 14px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;margin-bottom:20px}.publicform input,.publicform textarea,.publicform select{display:block;width:100%;min-height:48px;margin-top:8px;padding:12px 14px;border:2px solid var(--blue);border-radius:0;background:#fff;color:var(--field-ink);caret-color:var(--field-ink);font:500 18px/1.35 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,Arial,sans-serif;font-variant-numeric:lining-nums}.publicform input:-webkit-autofill{-webkit-text-fill-color:var(--field-ink);box-shadow:0 0 0 100px #fff inset}.publicform input::placeholder,.publicform textarea::placeholder{color:#5b6779;opacity:1}.publicform input:focus-visible,.publicform textarea:focus-visible,.publicform select:focus-visible{outline:3px solid var(--field-ink);outline-offset:2px}.publicform input[readonly]{background:#eef3f8}.publicform input[aria-invalid="true"],.publicform select[aria-invalid="true"]{border:3px solid var(--error-ink)}.publicform .hint{display:block;margin:6px 0 0;font:600 13px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}.publicform .fielderror{display:block;margin:6px 0 0;color:var(--error-ink);font:800 14px/1.35 ui-sans-serif,system-ui,-apple-system,sans-serif}.publicform a{color:var(--blue)}.publicform .fielderror a{display:inline-flex;align-items:center;min-height:44px;white-space:nowrap}.publicform .small a{display:inline-flex;align-items:center;min-height:44px}.publicform textarea{min-height:110px}.publicform .check{display:flex;gap:10px;align-items:flex-start;font-weight:600}.publicform .check input{width:auto;min-height:0;margin:4px 0 0}.publicform button{background:var(--red-strong);color:white}.idp{display:grid;gap:12px}.idp a{display:flex;align-items:center;justify-content:center;gap:12px;min-height:48px;padding:10px 16px;border-radius:4px;background:#fff;text-decoration:none;font:600 16px/1.2 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}.idp a:hover{background:#f6f8fa}.idp a:focus-visible{outline:3px solid var(--field-ink);outline-offset:2px}.idp svg{flex:none;width:20px;height:20px}.idp .google{border:1px solid #747775;color:#1f1f1f}.idp .microsoft{border:1px solid #747775;color:#1f1f1f}.ordivider{display:flex;align-items:center;gap:12px;margin:22px 0;font:800 13px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;text-transform:uppercase;letter-spacing:.08em}.ordivider::before,.ordivider::after{content:"";flex:1;border-top:2px solid rgba(7,89,168,.35)}.verified{color:#0b6b3a}.verified a{color:var(--blue)}.formerror a{color:var(--error-ink)}.formerror p{margin:0}.formerror ul{margin:0;padding:0 0 0 20px}.formerror li+li{margin-top:6px}.trap{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.formerror{background:#fff;border:3px solid var(--red);color:var(--error-ink);padding:16px;margin:0 0 22px;font:700 16px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}.formerror:focus-visible{outline:3px solid var(--field-ink);outline-offset:2px}.received{max-width:900px;min-height:80vh}.received .button{margin-right:14px}.received .small{max-width:620px}.received .actions{align-items:flex-start;flex-direction:column}.formpage.authpage{max-width:560px}.authpage .formintro{padding:30px 0 22px}.authpage .formintro h1{font-size:clamp(36px,9.6vw,60px);line-height:.95;letter-spacing:-.05em}.authpage .formintro>p:last-child{font-size:18px;margin:14px 0 0;max-width:none;text-wrap:pretty}.authpage .formintro strong{overflow-wrap:anywhere}.authpage .lede{font-size:18px;margin:0 0 22px}.authpage .lede a{color:var(--blue);font-weight:700}.authpage .publicform{padding:24px;margin-bottom:24px}.publicform>p.hint{margin:12px 0 0;text-align:center}.authpage .publicform label{font-size:15px}.authpage .publicform input:not([type=checkbox]):not([type=radio]),.authpage .publicform select{min-height:52px}.authpage .publicform button{width:100%;min-height:56px;font-size:16px}.publicform .field{margin-bottom:18px}.publicform .field>label{margin:0}.pwfield{position:relative;margin-top:8px}.publicform .pwfield input{margin-top:0;padding-right:88px}.publicform .pwfield button.pwtoggle{position:absolute;top:4px;right:4px;bottom:4px;width:auto;min-width:72px;min-height:44px;padding:0 12px;background:#fff;color:var(--blue);border:0;box-shadow:none;transform:none;text-transform:none;letter-spacing:0;font:800 15px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;text-decoration:underline;text-underline-offset:4px}.publicform .pwfield button.pwtoggle:hover{transform:none;box-shadow:none}.publicform .pwfield button.pwtoggle:focus-visible{outline-offset:-3px;transform:none}.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.formpage.authpage{padding-bottom:24px}.authnote{margin:0 0 8px;padding-block:4px;text-align:center;text-wrap:balance;font:700 15px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}.authnote a{display:inline-flex;align-items:center;min-height:44px;color:var(--blue)}.publicnav nav a{display:inline-flex;align-items:center;min-height:44px}.publicform button[aria-busy="true"]{cursor:progress}@media(max-width:800px){.publicnav{align-items:flex-start}.publicnav nav a:not(.navbutton){display:none}.publichero,.rules,.pricing{grid-template-columns:1fr}.publichero{padding-top:55px}.call-card{transform:none}.feature-grid{grid-template-columns:1fr}.feature-grid article.yellow,.feature-grid article.red{transform:none}.steps li{grid-template-columns:1fr;gap:10px}.grid.two{grid-template-columns:1fr}.publicfooter{flex-direction:column}.pricing{padding-top:70px;padding-bottom:70px}}@media(max-width:480px){.publicnav,.publicmain{padding-left:18px;padding-right:18px}.authpage .publicform{padding:20px 16px;box-shadow:8px 8px 0 var(--blue)}.brand{font-size:38px}.navbutton{padding:9px 10px;font-size:12px}.publichero h1{font-size:50px}.publicfooter div{flex-wrap:wrap}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.ticker div{animation:none}.button,.publicform button{transition:none}}</style></head><body>${body}</body></html>`;
}

export function layout(title: string, body: string): string {
  body = `<style>
    .owner-app{--ink:#18181b;--muted:#71717a;--line:#e4e4e7;--paper:#fafafa;--accent:#2563eb;--danger:#b42318;display:grid;grid-template-columns:256px minmax(0,1fr);min-height:100dvh;background:var(--paper)}
    .app-content{min-width:0;background:var(--paper)}
    .app-sidebar{position:sticky;top:0;display:flex;flex-direction:column;height:100dvh;padding:12px 10px;border-right:1px solid var(--line);background:#fff}
    .app-mark{display:flex;align-items:center;gap:10px;padding:8px 8px 18px;color:var(--ink);text-decoration:none}
    .app-mark>span{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:var(--ink);color:#fff;font-size:11px;font-weight:800;letter-spacing:.03em}
    .app-mark>strong{font-size:15px;font-weight:650}
    .app-sidebar nav{display:grid;gap:2px}
    .app-sidebar nav a,.sidebar-bottom a{display:flex;align-items:center;gap:10px;min-height:38px;padding:8px 10px;border-radius:7px;color:#52525b;font-size:14px;font-weight:500;text-decoration:none}
    .app-sidebar nav a:hover,.app-sidebar nav a:focus-visible,.sidebar-bottom a:hover,.sidebar-bottom a:focus-visible{background:#f4f4f5;color:var(--ink)}
    .app-sidebar nav a.active{background:#f4f4f5;color:var(--ink);font-weight:600}
    .app-sidebar nav a b{display:grid;place-items:center;min-width:20px;height:20px;margin-left:auto;border-radius:999px;background:var(--ink);color:white;font-size:10px}
    .app-sidebar svg,.mobile-app-nav svg{width:18px;height:18px;flex:none}
    .sidebar-bottom{display:grid;gap:2px;margin-top:auto;padding-top:10px;border-top:1px solid var(--line)}
    .app-header{position:sticky;top:0;z-index:40;width:100%;max-width:none;height:56px;margin:0;padding:0 24px;align-items:center;border-bottom:1px solid var(--line);background:rgba(255,255,255,.94);backdrop-filter:blur(12px)}
    .app-header>div:first-child{display:flex;align-items:center;gap:10px}
    .app-header .eyebrow{margin:0;padding-right:10px;border-right:1px solid var(--line);font-size:12px;font-weight:500;letter-spacing:0;text-transform:none}
    .app-header h1{font-size:15px;font-weight:600;line-height:1}
    .header-status{display:flex;align-items:center;padding:6px 10px;border:1px solid var(--line);border-radius:7px;background:#fff;font-size:12px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
    .dashboard-main{width:100%;max-width:1540px;margin:0 auto;padding:24px 24px 48px}
    .demo-notice,.toast,.coach-tip{display:flex;align-items:center;gap:12px;border:1px solid var(--line);border-radius:9px;background:#fff;padding:10px 12px;margin-bottom:16px;box-shadow:0 1px 2px rgba(0,0,0,.02)}
    .demo-notice{background:#eff6ff;border-color:#bfdbfe;color:#1e3a8a}
    .demo-notice span,.coach-tip span{color:var(--muted)}
    .coverage-state{font-weight:650}
    .coverage-state i{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--danger);margin-right:7px}
    .coverage-state.on i{background:#16a34a}
    .overview-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:0 0 20px!important;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important}
    .overview-grid article{display:grid;grid-template-rows:auto 1fr auto;gap:8px;min-height:132px;margin:0;padding:20px;border:1px solid var(--line);border-radius:12px;background:linear-gradient(180deg,#fff 55%,#fafafa);box-shadow:0 1px 2px rgba(0,0,0,.03)}
    .overview-grid article>span,.overview-grid small{color:var(--muted);font-size:13px}
    .overview-grid article>strong{align-self:center;font-size:30px;font-weight:650;line-height:1.05;letter-spacing:-.025em;font-variant-numeric:tabular-nums}
    .overview-grid .coverage-state{font-size:24px}
    .setup-guide{background:#fff;border:1px solid var(--line);border-radius:9px;margin-bottom:16px;box-shadow:0 1px 2px rgba(0,0,0,.02)}
    .setup-guide summary{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;cursor:pointer;list-style:none;font-size:13px}
    .setup-guide summary::-webkit-details-marker{display:none}
    .setup-guide summary span:first-child{display:grid;gap:1px}
    .setup-guide summary small{color:var(--muted);font-weight:400}
    .setup-steps{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 12px;border-top:1px solid var(--line);font-size:13px}
    .setup-steps>span{color:var(--muted)}
    .setup-steps .done{color:var(--accent);font-weight:650}
    .coach-tip{display:block;padding:0}
    .coach-tip summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;cursor:pointer;list-style:none;font-size:13px}
    .coach-tip summary::-webkit-details-marker{display:none}.coach-tip p{margin:0;padding:0 12px 11px;color:var(--muted);font-size:13px}
    .dashboard-shell{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(320px,.8fr);grid-template-areas:"inbox call" "recent activity" "recent usage";gap:20px;align-items:start}
    .dashboard-primary,.dashboard-side{display:contents}
    .inbox-panel{grid-area:inbox}.recent-panel{grid-area:recent}.call-preview{grid-area:call}.activity-panel{grid-area:activity}.usage-panel{grid-area:usage}
    .dashboard-main section{margin:0}
    .inbox-panel,.recent-panel,.call-preview,.activity-panel,.usage-panel,.workspace-panel{padding:0;overflow:visible;border:1px solid var(--line);border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.03)}
    .section-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 18px;margin:0;border-bottom:1px solid var(--line)}
    .section-heading .eyebrow{margin-bottom:2px;font-size:11px;font-weight:500;letter-spacing:0;text-transform:none}
    .section-heading h2{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em}
    .section-heading p{margin:4px 0 0;font-size:13px}
    .inbox-list,.recent-list{display:grid}
    .inbox-row{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 16px;border:0;border-bottom:1px solid var(--line);border-radius:0;margin:0;background:#fff}
    .inbox-row:last-child{border-bottom:0}
    .inbox-row:hover,.recent-row:hover{background:#fafafa}
    .inbox-row.urgent{box-shadow:inset 4px 0 0 var(--danger);background:#fff9f8}
    .inbox-copy{display:grid;gap:2px;min-width:0;color:var(--ink);text-decoration:none}
    .inbox-copy>span:not(.small){white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .inbox-title{display:flex;align-items:center;gap:8px}
    .task-check{width:30px;height:30px;border:1px solid #a1a1aa;border-radius:7px;padding:0;background:#fff;color:transparent;cursor:pointer}
    .task-check:hover,.task-check:focus-visible{border-color:var(--accent);color:var(--accent);background:#eff6ff}
    .task-check:disabled{cursor:not-allowed;opacity:.55}
    .row-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px;font-size:12px}
    .row-actions>a,.action-menu>summary{white-space:nowrap}
    .inline-form{display:inline;margin:0;padding:0;border:0;background:transparent}
    .inline-form button{padding:8px 11px}
    .action-menu{position:relative}
    .action-menu summary{color:var(--accent);cursor:pointer;list-style:none}
    .action-menu summary::-webkit-details-marker{display:none}
    .action-menu form{position:absolute;z-index:20;right:0;top:28px;display:grid;min-width:140px;margin:0;padding:6px;border:1px solid var(--line);border-radius:8px;background:white;box-shadow:0 10px 24px rgba(0,0,0,.12)}
    .action-menu form button{background:white;color:var(--ink);text-align:left;padding:9px 10px}
    .action-menu form button:hover{background:var(--paper)}
    .queue-empty{display:grid;gap:4px;padding:28px;color:var(--muted)}
    .recent-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 16px;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none}
    .recent-row:last-child{border-bottom:0}
    .recent-row.selected{background:#eff6ff;box-shadow:inset 3px 0 0 var(--accent)}
    .recent-row>span{display:grid;min-width:0}
    .recent-row small{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:58ch}
    .recent-row time,.activity-panel time{color:var(--muted);font-size:12px;white-space:nowrap}
    .call-preview>.section-heading,.activity-panel>.section-heading{padding-bottom:12px}
    .call-preview>p,.call-preview>dl,.call-preview>.quick-actions,.call-preview>.transcript{margin-inline:18px}
    .call-problem{font-size:15px;font-weight:600;margin-top:16px}
    .compact-details{display:grid;grid-template-columns:72px 1fr;gap:6px 10px;padding-block:12px;border-block:1px solid var(--line)}
    .compact-details dt{color:var(--muted);font-weight:500}
    .compact-details dd{margin:0;overflow-wrap:anywhere}
    .quick-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-block:13px}
    .quick-actions .button{padding:9px 12px}
    .transcript{padding:10px 0 15px}
    .transcript summary{cursor:pointer;color:var(--accent);font-weight:650}
    .transcript p{max-height:180px;overflow:auto;color:var(--muted)}
    .activity-panel ul{list-style:none;margin:0;padding:0}
    .activity-panel li{display:flex;justify-content:space-between;gap:12px;padding:11px 16px;border-bottom:1px solid var(--line)}
    .activity-panel li:last-child{border-bottom:0}
    .usage-panel{display:grid;grid-template-columns:repeat(3,1fr)}
    .usage-panel>div{display:grid;gap:2px;padding:16px;border-right:1px solid var(--line)}
    .usage-panel>div:last-child{border-right:0}
    .usage-panel strong{font-size:20px}
    .usage-panel span{font-size:12px;color:var(--muted)}
    .info-tip{position:relative;display:inline}
    .info-tip summary{display:inline-grid;place-items:center;width:17px;height:17px;margin-left:3px;border:1px solid #9aaba0;border-radius:50%;cursor:pointer;list-style:none;font-size:11px;font-style:normal}
    .info-tip p{position:absolute;z-index:10;right:0;top:20px;width:220px;margin:0;padding:10px;border:1px solid var(--line);border-radius:8px;background:white;color:var(--ink);box-shadow:0 8px 22px rgba(20,34,27,.12)}
    .workspace-shell{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,360px);gap:20px;align-items:start}
    .workspace-panel{overflow:hidden}
    .workspace-side{display:grid;gap:20px}
    .pipeline-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:16px;background:#fff}
    .pipeline-column{min-width:0;padding:0;border:1px solid var(--line);border-radius:10px;background:#f4f4f5}
    .pipeline-column>header,.calendar-day>header{display:flex;align-items:center;justify-content:space-between;gap:8px;max-width:none;margin:0;padding:10px 11px;border-bottom:1px solid var(--line);font-size:13px;font-weight:750}
    .pipeline-column>header strong{display:grid;place-items:center;min-width:22px;height:22px;border-radius:99px;background:white;font-size:11px}
    .pipeline-column>div{display:grid;gap:8px;padding:8px}
    .pipeline-card{display:grid;gap:6px;padding:11px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    .pipeline-card:hover,.pipeline-card:focus-visible{border-color:#a1a1aa;box-shadow:0 4px 12px rgba(0,0,0,.07)}
    .pipeline-card.urgent{border-left:3px solid var(--danger)}
    .pipeline-card-top{display:flex;align-items:center;justify-content:space-between;gap:6px}
    .pipeline-card>span:not(.pipeline-card-top){display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2}
    .pipeline-card small,.pipeline-empty{color:var(--muted);font-size:12px}
    .pipeline-empty{margin:4px;padding:8px}
    .calendar-board{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:1px;background:var(--line);border-top:1px solid var(--line)}
    .calendar-day{min-width:0;min-height:220px;padding:0;border:0;border-radius:0;background:#fff}
    .calendar-day.today>header{box-shadow:inset 0 3px 0 var(--accent)}
    .calendar-day>header{display:grid;gap:0;justify-items:start;background:#fafafa}
    .calendar-day>header span{color:var(--muted);font-size:11px;text-transform:uppercase}
    .calendar-day>div{display:grid;gap:7px;padding:8px}
    .calendar-event{display:grid;gap:1px;padding:8px;border-left:3px solid var(--accent);border-radius:5px;background:#eff6ff;color:var(--ink);font-size:12px;text-decoration:none}
    .calendar-event span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .calendar-event small,.calendar-empty{color:var(--muted);font-size:11px}
    .calendar-empty{padding:4px}
    .toast{position:sticky;top:64px;z-index:30;justify-content:space-between;border-color:#bbf7d0;background:#f0fdf4}
    .mobile-app-nav{display:none}
    @media(max-width:1100px){.dashboard-shell,.workspace-shell{grid-template-columns:1fr}.dashboard-shell{grid-template-areas:"inbox" "call" "recent" "activity" "usage"}.pipeline-board{grid-template-columns:repeat(2,minmax(0,1fr))}.calendar-board{grid-template-columns:repeat(4,minmax(0,1fr))}}
    @media(max-width:900px){body{padding-bottom:76px}.owner-app{grid-template-columns:1fr}.app-sidebar{display:none}.mobile-app-nav{position:fixed;z-index:60;display:grid;grid-template-columns:repeat(4,1fr);left:0;right:0;bottom:0;padding:5px max(8px,env(safe-area-inset-right)) calc(5px + env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left));background:rgba(255,255,255,.97);border-top:1px solid var(--line);backdrop-filter:blur(12px)}.mobile-app-nav a{display:grid;place-items:center;gap:2px;min-height:54px;color:var(--muted);font-size:11px;font-weight:650;text-decoration:none}.mobile-app-nav a.active{color:var(--accent)}.mobile-app-nav span{line-height:1}}
    @media(max-width:720px){.app-header{height:52px;align-items:center;flex-direction:row;padding:0 14px}.app-header .eyebrow{display:none}.app-header h1{font-size:15px}.header-status{padding:5px 7px;font-size:11px}.dashboard-main{padding:12px 10px 28px}.demo-notice{align-items:flex-start}.overview-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:12px!important}.overview-grid article{min-height:102px;padding:13px}.overview-grid article>strong{font-size:23px}.overview-grid article>span,.overview-grid small{font-size:11px}.setup-guide summary{padding:10px}.setup-steps{display:grid;gap:8px}.section-heading{align-items:flex-start;padding:13px 14px}.section-heading p{font-size:12px}.dashboard-shell{gap:12px}.inbox-row{grid-template-columns:40px minmax(0,1fr);padding:12px}.task-check{width:36px;height:36px}.row-actions{grid-column:2;justify-content:flex-start;flex-wrap:wrap;min-height:42px;gap:14px}.row-actions a,.row-actions summary{display:inline-flex;align-items:center;min-height:42px}.action-menu form{position:fixed;left:12px;right:12px;top:auto;bottom:78px;min-width:0}.action-menu form button{min-height:48px}.call-preview>p,.call-preview>dl,.call-preview>.quick-actions,.call-preview>.transcript{margin-inline:14px}.quick-actions a{display:inline-flex;align-items:center;min-height:42px}.recent-row{min-height:58px;padding:10px 14px}.recent-row small{max-width:24ch}.activity-panel li{padding:10px 14px}.usage-panel{grid-template-columns:repeat(3,1fr)}.usage-panel>div{padding:12px 8px;border-right:1px solid var(--line);border-bottom:0}.usage-panel strong{font-size:18px}.pipeline-board,.calendar-board{grid-template-columns:1fr}.pipeline-column,.calendar-day{min-height:auto}.pipeline-column>div{padding:7px}.calendar-day>div:has(.calendar-empty){display:none}}
  </style>${body}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Call Otto</title><style>:root{color-scheme:light;--ink:#14221b;--muted:#627067;--line:#dfe7e1;--paper:#f6f8f5;--accent:#176b45;--danger:#a42b2b}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}header,main,.narrow{max-width:1120px;margin:auto;padding:28px}header{display:flex;align-items:end;justify-content:space-between;gap:20px}footer{display:flex;gap:18px;padding:12px 4px 40px}nav{display:flex;gap:16px;flex-wrap:wrap}a{color:var(--accent)}h1{font-size:clamp(28px,5vw,48px);line-height:1.05;margin:0}h2{font-size:clamp(18px,2.3vw,28px);line-height:1.2;margin:0 0 10px}.eyebrow{color:var(--muted);margin:0 0 4px;text-transform:uppercase;letter-spacing:.08em}.hero{padding:clamp(24px,6vw,64px)}.lede{font-size:clamp(18px,3vw,25px);max-width:820px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}.button{display:inline-block;background:var(--accent);color:white;text-decoration:none;font-weight:750;padding:12px 18px;border-radius:10px}.button.secondary{background:var(--ink)}.small{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px}.grid.two{grid-template-columns:repeat(2,1fr)}article,form,section{background:white;border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}.status{border-width:2px}.goodbox{border-color:#74b58f;background:#f1fbf5}.badbox{border-color:#d99b9b;background:#fff6f6}.narrow{max-width:560px;padding-top:12vh}label{display:block;font-weight:650;margin-bottom:16px}input,textarea,select{display:block;width:100%;margin-top:7px;padding:11px;border:1px solid #aebbb2;border-radius:8px;font:inherit}input:disabled{opacity:.58}textarea{min-height:92px}button{background:var(--ink);color:white;border:0;border-radius:9px;padding:12px 18px;font-weight:700}.dangerbutton{background:var(--danger)}.check{display:flex;gap:8px;align-items:flex-start}.check input{width:auto;margin:5px 0 0}.notification-options{background:#f8fbf9;border:1px solid var(--line);padding:18px;margin:4px 0 22px}.notification-option{display:grid;grid-template-columns:24px 1fr;gap:10px;padding:12px 0;border-bottom:1px solid var(--line)}.notification-option input{width:20px;height:20px;margin:2px 0}.notification-option span{display:grid;gap:2px}.notification-option em{float:right;color:var(--accent);font-style:normal}.notification-option small{color:var(--muted);font-weight:400}.table{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line);vertical-align:top}.pill{display:inline-block;background:#e7eee9;border-radius:99px;padding:2px 8px}.danger,.error,.formerror{color:var(--danger)}.formerror{max-width:1120px;margin:0 auto 18px;padding:14px 20px;background:#fff6f6;border:1px solid #d99b9b;border-radius:10px}.good{color:var(--accent)}.trap{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#102019;color:#e9f4ed;border-radius:10px;padding:16px}dt{font-weight:700}dd{margin:0 0 10px}@media(max-width:720px){header{align-items:start;flex-direction:column}.grid,.grid.two{grid-template-columns:1fr}header,main{padding:14px}.notification-options{padding:14px}}</style></head><body>${body}</body></html>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function safeHttpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function dashboardIcon(name: "today" | "pipeline" | "calendar" | "calls" | "settings"): string {
  const paths = {
    today: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    pipeline: '<rect x="3" y="4" width="6" height="16" rx="2"/><rect x="15" y="4" width="6" height="10" rx="2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
    calls: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.8a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.33 1.84.56 2.8.69A2 2 0 0 1 22 16.92z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.09A1.7 1.7 0 0 0 8.97 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.09A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 8.97 4.6 1.7 1.7 0 0 0 10 3.04V3h4v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 7l-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03H21v4h-.09A1.7 1.7 0 0 0 19.4 15z"/>',
  } as const;
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

function formatDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatCompactDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function option(value: BusinessConfig["operationMode"], current: BusinessConfig["operationMode"]): string {
  return `<option value="${value}" ${value === current ? "selected" : ""}>${escapeHtml(value.replace("_", " "))}</option>`;
}

function selectOption(value: string, label: string, current: string | undefined): string {
  return `<option value="${escapeHtml(value)}" ${current === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
}
