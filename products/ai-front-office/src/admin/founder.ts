import type { FounderAccount } from "../adapters/founder-calendar.js";
import { maskEmail, slotDayLabel, slotFullLabel, slotTimeLabel, zoneLabel, type FounderSlot } from "../domain/founder-booking.js";
import { escapeHtml, layout, publicLayout } from "./render.js";

const BOOKING_STYLE = `<style>
.booking{max-width:560px}.booking .formintro{padding:26px 0 18px}
.booking .formintro h1{font-size:clamp(30px,8.6vw,52px);line-height:1.02;letter-spacing:-.035em}
.booking .formintro p:last-child{font-size:18px;margin:12px 0 0}
.booking p{font-size:17px}
.booking .zone{font:700 16px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;margin:0 0 14px}
.slotday{margin:0 0 20px}
.slotday h2{margin:0 0 10px;font:800 17px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif}
.slotgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.publicform .slotgrid button{width:100%;min-height:52px;padding:12px 10px;font-size:17px;text-transform:none;letter-spacing:0}
.booking .done{font-size:20px;font-weight:700}
@media(max-width:480px){.publicnav,.publicmain{padding-left:16px;padding-right:16px}.booking .publicform{padding:18px 16px}}
</style>`;

const HEADER = `<header class="publicnav"><a class="brand smallbrand" href="/"><span>Call</span> Otto</a><nav><a href="/login">Sign in</a></nav></header>`;

function page(title: string, eyebrow: string, heading: string, body: string): string {
  return publicLayout(title, `${BOOKING_STYLE}${HEADER}<main class="publicmain formpage booking"><section class="formintro"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(heading)}</h1></section>${body}</main>`);
}

export type FounderBookingView =
  | { state: "pick"; token: string; businessName: string; timeZone: string; slots: FounderSlot[]; taken?: boolean }
  | { state: "booked"; slot: FounderSlot; timeZone: string; callNumber: string | null; justBooked: boolean }
  | { state: "expired" }
  | { state: "reply"; reason: "no_calendar" | "unavailable" | "nothing_open" };

/** /book-setup: pick a 10-minute call with Brock, shown in the owner's own time zone. */
export function renderFounderBooking(view: FounderBookingView): string {
  if (view.state === "expired") {
    return page("Link expired", "Setup call", "This link has expired.", `<p>Booking links work for 7 days. Reply to Brock's email and he'll find a time with you.</p>`);
  }
  if (view.state === "reply") {
    const why = view.reason === "nothing_open"
      ? "Brock's open times are all taken this week."
      : view.reason === "unavailable" ? "We couldn't load Brock's open times just now." : "Online booking isn't open yet.";
    return page("Book a setup call", "Setup call", "Reply with a good time.", `<p>${why} Reply to Brock's email with a good time for a 10-minute call and he'll call you.</p>`);
  }
  if (view.state === "booked") {
    const when = slotFullLabel(view.slot.start, view.timeZone);
    const call = view.callNumber ? `Brock will call you at <span style="white-space:nowrap">${escapeHtml(view.callNumber)}</span>.` : "Brock will call you.";
    const sent = view.justBooked ? " We emailed you a confirmation with a calendar invite." : "";
    return page("You're set", "Setup call", "You're set.", `<p class="done">${escapeHtml(when)}</p><p>${call}${sent} It takes about 10 minutes.</p><p>Need a different time? Reply to Brock's email.</p>`);
  }
  const days = new Map<string, FounderSlot[]>();
  for (const slot of view.slots) {
    const label = slotDayLabel(slot.start, view.timeZone);
    days.set(label, [...(days.get(label) ?? []), slot]);
  }
  const zone = view.slots[0] ? zoneLabel(view.slots[0].start, view.timeZone) : "";
  const groups = [...days.entries()].map(([label, slots]) => `<div class="slotday" role="group" aria-label="${escapeHtml(label)}"><h2>${escapeHtml(label)}</h2><div class="slotgrid">${slots.map((slot) => `<button name="start" value="${escapeHtml(slot.start)}">${escapeHtml(slotTimeLabel(slot.start, view.timeZone))}</button>`).join("")}</div></div>`).join("");
  return page(
    "Book a setup call",
    "Setup call",
    "Book a 10-minute call with Brock.",
    `${view.taken ? `<p class="formerror" role="alert">That time just got taken. Pick another.</p>` : ""}<p>Brock, our founder, will call you and get call forwarding on for ${escapeHtml(view.businessName)}. Pick a time.</p>${zone ? `<p class="zone">Times are in your time zone (${escapeHtml(zone)}).</p>` : ""}<form class="publicform" method="post" action="/book-setup"><input type="hidden" name="t" value="${escapeHtml(view.token)}">${groups}</form>`,
  );
}

export interface FounderCalendarsView {
  accounts: FounderAccount[];
  /** Admin session CSRF, or the signed connect link standing in for it. */
  auth: { csrf: string } | { k: string };
  connectHref: string;
  windows: string;
  timeZone: string;
  preview: FounderSlot[] | null;
  /** Which account couldn't be read, when that's why there's no preview. */
  readError?: string | null | undefined;
  /** How many open times each account leaves on its own; 0 means that calendar blocks every booking. */
  perAccount?: Record<string, number> | undefined;
  notice?: string | undefined;
  error?: string | undefined;
}

/** /admin/founder-calendars: Brock's Google accounts for setup calls, which one takes bookings, and his windows. */
export function renderFounderCalendars(view: FounderCalendarsView): string {
  const hidden = "csrf" in view.auth
    ? `<input type="hidden" name="csrf" value="${escapeHtml(view.auth.csrf)}">`
    : `<input type="hidden" name="k" value="${escapeHtml(view.auth.k)}">`;
  const rows = view.accounts.length === 0
    ? `<tr><td colspan="3">No Google account connected yet. Owners who need setup help get an email asking them to reply with a good time.</td></tr>`
    : view.accounts.map((account) => {
      const checks = account.calendarsSource === "primary" ? "Main calendar only" : `${account.calendars.length} calendar${account.calendars.length === 1 ? "" : "s"} (main and ones you own or show)`;
      const book = account.bookHere
        ? `<span class="pill">Takes bookings</span>`
        : `<form method="post" action="/admin/founder-calendars/book-here">${hidden}<input type="hidden" name="account" value="${escapeHtml(account.id)}"><button>Book here</button></form>`;
      return `<tr><td>${escapeHtml(account.email ? maskEmail(account.email) : "Google account")}<br><span class="small">Busy times from: ${escapeHtml(checks)}</span>${view.perAccount?.[account.id] === 0 ? `<br><span class="small"><strong>This calendar is busy across all your booking hours, so it blocks every booking.</strong></span>` : ""}</td><td>${book}</td><td><form method="post" action="/admin/founder-calendars/disconnect">${hidden}<input type="hidden" name="account" value="${escapeHtml(account.id)}"><button class="dangerbutton">Disconnect</button></form></td></tr>`;
    }).join("");
  const preview = view.preview === null
    ? `<p class="small">${escapeHtml(view.readError ?? "Couldn't read the calendars just now.")}</p>`
    : view.preview.length === 0
      ? `<p class="small">${view.accounts.length === 0 ? "Connect a calendar to see open times." : "Nothing open in the next five business days."}</p>`
      : `<ul>${view.preview.slice(0, 9).map((slot) => `<li>${escapeHtml(slotFullLabel(slot.start, view.timeZone))}</li>`).join("")}</ul>`;
  return layout("Founder calendars", `<header><div><p class="eyebrow">Setup calls with Brock</p><h1>Founder calendars</h1></div><nav>${"csrf" in view.auth ? `<a href="/admin">Admin</a>` : ""}</nav></header><main>${view.notice ? `<section class="status goodbox"><p>${escapeHtml(view.notice)}</p></section>` : ""}${view.error ? `<section class="status badbox"><p>${escapeHtml(view.error)}</p></section>` : ""}<section><h2>Google accounts</h2><p>Owners can only book times that are free on every account here. Calls go on the account marked "Takes bookings", with no guests, so no email address is shared.</p><table><tbody>${rows}</tbody></table><p><a class="button" href="${escapeHtml(view.connectHref)}">Connect a Google account</a></p></section><section><h2>When owners can book</h2><p>${escapeHtml(view.windows)} (${escapeHtml(view.timeZone)}). 10-minute calls, at least 1 hour out, 5 minutes clear of anything on your calendars, about three choices a day over the next five business days. Change with FOUNDER_BOOKING_WINDOWS and FOUNDER_TIMEZONE.</p><h3>Next open times</h3>${preview}</section></main>`);
}
