import type { BookingRecord, BusinessConfig, CallbackTask, CallRecord, OutboxNotification, OwnerAccount, PilotSignup, SubscriptionRecord, ToolEvent, UsageSummary } from "../domain/models.js";
import type { ActivationReport } from "../application/readiness.js";
import { SIMULATION_SCENARIOS, type SimulationResult } from "../application/simulator.js";
import { buildTelnyxAssistantUpdate } from "../voice/system-prompt.js";
import { renderMarketing } from "./marketing.js";

type OwnerDashboardView = "today" | "pipeline" | "calendar";

export const renderLanding = renderMarketing;

export function renderOwnerSignup(error = "", values: Record<string, string> = {}): string {
  const value = (name: string): string => escapeHtml(values[name] ?? "");
  return publicLayout("Get started", `<style>.formintro{padding-top:44px}.formintro h1{font-size:48px}.formpage{max-width:680px}.publicform{padding:28px}.publicform button{width:100%;min-height:50px}.publicform details{margin:22px 0}.publicform summary{min-height:44px;cursor:pointer;font:700 15px/1.4 system-ui}</style><header class="publicnav"><a class="brand smallbrand" href="/"><span>Front</span> Office</a><nav><a href="/login">Sign in</a></nav></header><main class="publicmain formpage"><section class="formintro"><p class="eyebrow">$49/month · 200 AI minutes</p><h1>Get your calls covered.</h1><p>Create your account. Set up now or later. No demo or sales call.</p></section>${error ? `<p class="formerror" role="alert">${escapeHtml(error)}</p>` : ""}<form class="publicform" method="post" action="/signup"><label>Business name<input name="businessName" autocomplete="organization" maxlength="120" value="${value("businessName")}" required></label><label>Email<input name="email" type="email" autocomplete="email" maxlength="254" value="${value("email")}" required></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required><span class="small">At least 12 characters.</span></label><details><summary>Optional: add text alerts</summary><label>Mobile number <span class="small">(optional)</span><input name="phone" type="tel" autocomplete="tel" inputmode="tel" value="${value("phone")}"></label><label class="check"><input name="ownerSmsConsent" type="checkbox" value="yes" ${values.ownerSmsConsent === "yes" ? "checked" : ""}>Send operational account alerts from Front Office by Dutchworks LLC. Message frequency varies; message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase. We do not share mobile information with third parties for marketing or promotional purposes. See <a href="/terms">Terms</a> and <a href="/privacy">Privacy</a>.</label></details><label class="trap" aria-hidden="true">Fax number<input name="faxNumber" tabindex="-1" autocomplete="off"></label><label class="check"><input name="consent" type="checkbox" value="yes" required>I agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy notice</a>.</label><button>Continue</button><p class="small">No charge yet. Set your call rules, then choose secure $49 month-to-month checkout. Before customer calls, we verify the line; hearing a test call yourself is optional.</p></form></main>`);
}

export function renderOwnerLogin(error = ""): string {
  return publicLayout("Owner sign in", `<header class="publicnav"><a class="brand smallbrand" href="/"><span>Front</span> Office</a><nav><a href="/signup">Get started</a></nav></header><main class="publicmain formpage"><section class="formintro"><p class="eyebrow">Owner sign in</p><h1>Your calls. Your rules.</h1></section>${error ? `<p class="formerror">${escapeHtml(error)}</p>` : ""}<form class="publicform" method="post" action="/login"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></main>`);
}

export function renderOwnerDashboard(input: {
  account: OwnerAccount;
  config: BusinessConfig;
  calls: CallRecord[];
  tasks: CallbackTask[];
  usage: UsageSummary;
  googleConnected: boolean;
  subscription: SubscriptionRecord | null;
  csrf: string;
  checkoutConfigured: boolean;
  checkoutUrl: string | null;
  now: string;
  selectedCallId?: string | null;
  recentlyCompletedCallId?: string | null;
  view?: OwnerDashboardView;
  preview?: boolean;
}): string {
  const preview = input.preview === true;
  const view = input.view ?? "today";
  const nowMs = Date.parse(input.now);
  const used = input.usage.billedMinutes;
  const remaining = Math.max(0, input.config.includedMinutes - used);
  const projectedOverage = Math.max(0, used - input.config.includedMinutes) * input.config.overageCentsPerMinute;
  const paid = input.subscription?.status === "active";
  const callsById = new Map(input.calls.map((call) => [call.id, call]));
  const actionableTasks = input.tasks
    .filter((task) => task.status === "open" || (task.status === "snoozed" && Date.parse(task.dueAt) <= nowMs))
    .sort((left, right) => left.priority === right.priority ? left.dueAt.localeCompare(right.dueAt) : left.priority === "high" ? -1 : 1);
  const snoozedTasks = input.tasks.filter((task) => task.status === "snoozed" && Date.parse(task.dueAt) > nowMs);
  const completedTasks = input.tasks.filter((task) => task.status === "completed");
  const selectedCall = callsById.get(input.selectedCallId ?? "")
    ?? callsById.get(actionableTasks[0]?.callId ?? "")
    ?? input.calls[0]
    ?? null;
  const recentlyCompleted = completedTasks.find((task) => task.callId === input.recentlyCompletedCallId);
  const base = preview ? "/demo" : "/app";
  const dashboardLink = (targetView: OwnerDashboardView, callId?: string): string => {
    const params = new URLSearchParams();
    if (targetView !== "today") params.set("view", targetView);
    if (callId) params.set("call", callId);
    const query = params.toString();
    return `${base}${query ? `?${query}` : ""}`;
  };
  const shopRulesSaved = input.config.serviceAreaTerms.length > 0 && /\bAI\b/i.test(input.config.greeting);
  const setupSteps = [shopRulesSaved, input.googleConnected, paid];
  const setupComplete = setupSteps.filter(Boolean).length;
  const phoneFor = (call: CallRecord): string | null => {
    const phone = call.fields.callbackNumber ?? call.fromNumber;
    return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
  };
  const taskRows = actionableTasks.length === 0
    ? `<div class="queue-empty"><strong>You’re caught up.</strong><span>New emergencies, callbacks, and unconfirmed appointments will appear here automatically.</span></div>`
    : actionableTasks.map((task) => {
      const call = callsById.get(task.callId);
      const phone = call ? phoneFor(call) : null;
      const overdue = Date.parse(task.dueAt) <= nowMs;
      const rowLink = `${dashboardLink(view, task.callId)}#call-preview`;
      const complete = preview
        ? `<button class="task-check" type="button" disabled aria-label="Read-only example">✓</button>`
        : `<form class="inline-form" method="post" action="/app/calls/${encodeURIComponent(task.callId)}/task/complete"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><button class="task-check" aria-label="Mark ${escapeHtml(call?.fields.callerName ?? "call")} handled">✓</button></form>`;
      const snooze = preview ? "" : `<details class="action-menu"><summary>Later</summary><form method="post" action="/app/calls/${encodeURIComponent(task.callId)}/task/snooze"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><button name="minutes" value="60">In 1 hour</button><button name="minutes" value="240">In 4 hours</button><button name="minutes" value="1440">Tomorrow</button></form></details>`;
      return `<article class="inbox-row ${task.priority === "high" ? "urgent" : ""}">${complete}<a class="inbox-copy" href="${rowLink}"><span class="inbox-title"><strong>${escapeHtml(call?.fields.callerName ?? "Unknown caller")}</strong><span class="pill ${task.priority === "high" ? "danger" : ""}">${task.priority === "high" ? "Urgent" : "Follow up"}</span></span><span>${escapeHtml(call?.fields.problemDescription || task.reason)}</span><span class="small">${escapeHtml(task.reason)} · ${overdue ? "Due now" : `Due ${formatCompactDate(task.dueAt, input.config.timezone)}`}</span></a><div class="row-actions">${phone ? `<a href="tel:${escapeHtml(phone)}">Call back</a>` : ""}${snooze}<a href="${rowLink}">Open</a></div></article>`;
    }).join("");
  const recentCalls = input.calls.slice(0, 8).map((call) => {
    const selected = selectedCall?.id === call.id;
    return `<a class="recent-row ${selected ? "selected" : ""}" href="${dashboardLink("today", call.id)}#call-preview"><span><strong>${escapeHtml(call.fields.callerName ?? "Unknown caller")}</strong><small>${escapeHtml(call.fields.problemDescription || "No summary")}</small></span><time>${escapeHtml(formatCompactDate(call.startedAt, input.config.timezone))}</time></a>`;
  }).join("") || `<div class="queue-empty"><strong>No calls yet.</strong><span>Your first handled call will appear here.</span></div>`;
  const selectedPhone = selectedCall ? phoneFor(selectedCall) : null;
  const selectedAddress = selectedCall?.fields.address?.trim() || null;
  const callPreview = selectedCall ? `<section id="call-preview" class="call-preview"><div class="section-heading"><div><p class="eyebrow">Selected call</p><h2>${escapeHtml(selectedCall.fields.callerName ?? "Unknown caller")}</h2></div><span class="pill ${selectedCall.emergency?.emergency ? "danger" : ""}">${escapeHtml(selectedCall.emergency?.severity ?? "routine")}</span></div><p class="call-problem">${escapeHtml(selectedCall.fields.problemDescription || "No problem summary captured")}</p><dl class="compact-details"><dt>Phone</dt><dd>${escapeHtml(selectedPhone ?? "Not confirmed")}</dd><dt>Address</dt><dd>${escapeHtml(selectedAddress ?? "Not confirmed")}</dd><dt>Outcome</dt><dd>${escapeHtml(selectedCall.outcome.replaceAll("_", " "))}</dd></dl><div class="quick-actions">${selectedPhone ? `<a class="button" href="tel:${escapeHtml(selectedPhone)}">Call back</a>` : ""}${selectedAddress ? `<a href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(selectedAddress)}" target="_blank" rel="noreferrer">Open Maps</a>` : ""}${preview ? "" : `<a href="/app/calls/${encodeURIComponent(selectedCall.id)}">Full record</a>`}</div><details class="transcript"><summary>Read transcript</summary><p>${escapeHtml(selectedCall.transcript ?? "Transcript unavailable")}</p></details></section>` : `<section class="call-preview"><h2>No call selected</h2><p>Calls will appear here after Front Office answers.</p></section>`;
  const activities = [
    ...input.calls.filter((call) => call.endedAt).map((call) => ({
      at: call.endedAt!,
      text: call.outcome === "booked" ? `Booked ${call.fields.callerName ?? "caller"}` : `Captured ${call.fields.callerName ?? "a caller"}`,
    })),
    ...completedTasks.map((task) => ({
      at: task.completedAt ?? task.updatedAt,
      text: task.completionSource === "verified_booking" ? "Follow-up closed after verified booking" : `Marked ${callsById.get(task.callId)?.fields.callerName ?? "call"} handled`,
    })),
  ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 5);
  const activityRows = activities.map((activity) => `<li><span>${escapeHtml(activity.text)}</span><time>${escapeHtml(formatCompactDate(activity.at, input.config.timezone))}</time></li>`).join("") || `<li><span>No activity yet</span></li>`;
  const upcomingAppointments = input.calls
    .filter((call) => call.fields.requestedStart && Date.parse(call.fields.requestedStart) >= nowMs && Date.parse(call.fields.requestedStart) < nowMs + 7 * 24 * 60 * 60_000)
    .sort((left, right) => left.fields.requestedStart!.localeCompare(right.fields.requestedStart!));
  const bookedAppointmentCount = upcomingAppointments.filter((call) => call.outcome === "booked").length;
  const proposedAppointmentCount = upcomingAppointments.length - bookedAppointmentCount;
  const pipelineCard = (call: CallRecord | undefined, label: string, meta: string, urgent = false): string => {
    if (!call) return "";
    return `<a class="pipeline-card ${urgent ? "urgent" : ""}" href="${dashboardLink("pipeline", call.id)}#call-preview"><span class="pipeline-card-top"><strong>${escapeHtml(call.fields.callerName ?? "Unknown caller")}</strong><span class="pill ${urgent ? "danger" : ""}">${escapeHtml(label)}</span></span><span>${escapeHtml(call.fields.problemDescription || "No summary captured")}</span><small>${escapeHtml(meta)}</small></a>`;
  };
  const needsReplyCards = actionableTasks.map((task) => pipelineCard(callsById.get(task.callId), task.priority === "high" ? "Urgent" : "Follow up", task.reason, task.priority === "high")).join("");
  const waitingCards = snoozedTasks.map((task) => pipelineCard(callsById.get(task.callId), "Waiting", `Returns ${formatCompactDate(task.dueAt, input.config.timezone)}`)).join("");
  const bookedCards = upcomingAppointments.filter((call) => call.outcome === "booked").map((call) => pipelineCard(call, "Booked", formatDate(call.fields.requestedStart!, input.config.timezone))).join("");
  const handledCards = completedTasks.filter((task) => callsById.get(task.callId)?.outcome !== "booked").slice(0, 8).map((task) => pipelineCard(callsById.get(task.callId), "Handled", formatCompactDate(task.completedAt ?? task.updatedAt, input.config.timezone))).join("");
  const pipelineColumn = (title: string, count: number, cards: string, empty: string): string => `<section class="pipeline-column"><header><span>${escapeHtml(title)}</span><strong>${count}</strong></header><div>${cards || `<p class="pipeline-empty">${escapeHtml(empty)}</p>`}</div></section>`;
  const pipelineBoard = `<section class="workspace-panel pipeline-panel"><div class="section-heading"><div><p class="eyebrow">Pipeline</p><h2>Every job at a glance</h2><p class="small">System-sorted from real call and follow-up status. Open a card to act on it.</p></div></div><div class="pipeline-board">${pipelineColumn("Needs reply", actionableTasks.length, needsReplyCards, "Nothing needs a response.")}${pipelineColumn("Waiting", snoozedTasks.length, waitingCards, "Nothing is snoozed.")}${pipelineColumn("Booked", upcomingAppointments.filter((call) => call.outcome === "booked").length, bookedCards, "No upcoming bookings.")}${pipelineColumn("Handled", completedTasks.filter((task) => callsById.get(task.callId)?.outcome !== "booked").length, handledCards, "No completed follow-ups yet.")}</div></section>`;
  const dateKey = (value: string | Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: input.config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(typeof value === "string" ? new Date(value) : value);
  const calendarDays = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(nowMs + index * 24 * 60 * 60_000);
    const key = dateKey(day);
    const appointments = upcomingAppointments.filter((call) => dateKey(call.fields.requestedStart!) === key);
    const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: input.config.timezone, weekday: "short" }).format(day);
    const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: input.config.timezone, month: "short", day: "numeric" }).format(day);
    const events = appointments.map((call) => `<a class="calendar-event" href="${dashboardLink("calendar", call.id)}#call-preview"><strong>${escapeHtml(new Intl.DateTimeFormat("en-US", { timeZone: input.config.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(call.fields.requestedStart!)))}</strong><span>${escapeHtml(call.fields.callerName ?? "Unknown caller")}</span><small>${escapeHtml(call.outcome === "booked" ? "Booked" : "Awaiting confirmation")}</small></a>`).join("");
    return `<section class="calendar-day ${index === 0 ? "today" : ""}"><header><span>${escapeHtml(dayLabel)}</span><strong>${escapeHtml(dateLabel)}</strong></header><div>${events || `<span class="calendar-empty">No appointments</span>`}</div></section>`;
  }).join("");
  const calendarBoard = `<section class="workspace-panel calendar-panel"><div class="section-heading"><div><p class="eyebrow">Calendar</p><h2>Next seven days</h2><p class="small">Booked and proposed appointment times from the calls Front Office handled.</p></div></div><div class="calendar-board">${calendarDays}</div></section>`;
  const billingAction = !preview && input.account.role !== "member" && input.checkoutConfigured && !paid ? `<form class="inline-form" method="post" action="/app/billing/checkout"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><button>Start $${(input.config.flatMonthlyPriceCents / 100).toFixed(0)} plan</button></form>` : "";
  const portalAction = !preview && input.account.role !== "member" && paid ? `<form class="inline-form" method="post" action="/app/billing/portal"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><button>Manage billing or cancel</button></form>` : "";
  const setupGuide = input.account.role === "member" ? "" : `<details class="setup-guide" ${setupComplete < 3 ? "open" : ""}><summary><span><strong>Setup ${setupComplete}/3 complete</strong><small>${setupComplete === 3 ? "Setup saved. Activation is checked separately." : "Finish these steps before customer traffic starts"}</small></span><span>${setupComplete === 3 ? "Ready" : "Continue"}</span></summary><div class="setup-steps"><span class="${shopRulesSaved ? "done" : ""}">${shopRulesSaved ? "✓ Call setup saved" : preview ? "Shop rules" : '<a href="/app/setup">Set your call rules</a>'}</span><span class="${input.googleConnected ? "done" : ""}">${input.googleConnected ? "✓" : "2"} ${input.googleConnected ? "Calendar connected" : preview ? "Connect calendar during setup" : '<a href="/app/integrations/google/start">Connect Google Calendar</a>'}</span><span class="${paid ? "done" : ""}">${paid ? "✓ Subscription active" : "3 Start subscription"}</span>${billingAction}${portalAction}${preview ? "" : '<a href="/app/setup">Edit call setup</a><a href="/app/team">Team & calendars</a>'}</div>${preview || input.account.status === "active" ? "" : "<p style=\"padding:0 14px 14px\">We’ll turn the line on after a quick setup check. Your dashboard will show when coverage is on. A test call is optional.</p>"}</details>`;
  const undo = recentlyCompleted && !preview ? `<div class="toast" role="status"><span>Marked handled.</span><form class="inline-form" method="post" action="/app/calls/${encodeURIComponent(recentlyCompleted.callId)}/task/reopen"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><button>Undo</button></form></div>` : "";
  const demoNotice = preview ? `<div class="demo-notice"><strong>Read-only demo</strong><span>Synthetic calls only. Real owners can complete and snooze work.</span></div>` : "";
  const sidebar = `<aside class="app-sidebar"><a class="app-mark" href="${dashboardLink("today")}"><span>FO</span><strong>Front Office</strong></a><nav aria-label="Main navigation"><a class="${view === "today" ? "active" : ""}" href="${dashboardLink("today")}">${dashboardIcon("today")}<span>Today</span>${actionableTasks.length ? `<b>${actionableTasks.length}</b>` : ""}</a><a class="${view === "pipeline" ? "active" : ""}" href="${dashboardLink("pipeline")}">${dashboardIcon("pipeline")}<span>Pipeline</span></a><a class="${view === "calendar" ? "active" : ""}" href="${dashboardLink("calendar")}">${dashboardIcon("calendar")}<span>Calendar</span></a><a href="${dashboardLink("today")}#recent-calls">${dashboardIcon("calls")}<span>Calls</span></a></nav><div class="sidebar-bottom">${preview ? `<a href="/">Back to site</a><a href="/signup">Get started</a>` : `<a href="/app/settings">${dashboardIcon("settings")}<span>Settings</span></a><a href="/app/team">Team & calendars</a><a href="/logout">Sign out</a>`}</div></aside>`;
  const alertsOff = !preview && input.config.ownerNotificationRefs.length === 0
    ? `<section class="alerts-off" role="alert" style="border:2px solid #b42318;background:#fff4f2;border-radius:14px;padding:14px 16px;margin-bottom:14px"><strong>Urgent alerts are off.</strong> <span>Emergencies will only appear here, and your line can’t be turned on until you add a mobile number for alerts.</span> <a href="/app/setup">Turn on alerts</a></section>`
    : "";
  const overview = `<section class="overview-grid" aria-label="Shop overview"><article><span>Coverage</span><strong class="coverage-state ${input.account.status === "active" && !input.config.paused ? "on" : ""}"><i></i>${input.account.status === "active" && !input.config.paused ? "On" : "Pending"}</strong><small>AI line status</small></article><article><span>Needs attention</span><strong>${actionableTasks.length}</strong><small>${actionableTasks.filter((task) => task.priority === "high").length} urgent</small></article><article><span>Next 7 days</span><strong>${upcomingAppointments.length}</strong><small>${bookedAppointmentCount} booked${proposedAppointmentCount ? ` · ${proposedAppointmentCount} proposed` : ""}</small></article><article><span>AI minutes left</span><strong>${remaining}</strong><small>${input.usage.billableCalls} calls handled</small></article></section>`;
  const todayView = `<div class="dashboard-shell"><div class="dashboard-primary"><section id="inbox" class="inbox-panel"><div class="section-heading"><div><p class="eyebrow">Today</p><h2>Needs your attention</h2><p class="small">Front Office sorts this automatically. Nothing disappears until it is handled or safely snoozed.</p></div><strong>${actionableTasks.length}</strong></div><div class="inbox-list">${taskRows}</div></section><section id="recent-calls" class="recent-panel"><div class="section-heading"><div><p class="eyebrow">History</p><h2>Recent calls</h2></div><span>${input.calls.length} shown</span></div><div class="recent-list">${recentCalls}</div></section></div><aside class="dashboard-side">${callPreview}<section class="activity-panel"><div class="section-heading"><div><p class="eyebrow">Automatic record</p><h2>Recent activity</h2></div></div><ul>${activityRows}</ul></section><section class="usage-panel"><div><strong>${remaining}</strong><span>AI minutes left <details class="info-tip"><summary aria-label="What are AI minutes?">i</summary><p>Only connected AI call time counts.</p></details></span></div><div><strong>${input.usage.billableCalls}</strong><span>handled calls</span></div><div><strong>$${(projectedOverage / 100).toFixed(2)}</strong><span>current overage</span></div></section></aside></div>`;
  const alternateView = `<div class="workspace-shell">${view === "pipeline" ? pipelineBoard : calendarBoard}<aside class="workspace-side">${callPreview}</aside></div>`;
  const coach = view === "today" ? `<details class="coach-tip" data-dashboard-tip><summary><strong>How Today works</strong><span>Tap for help</span></summary><p>Urgent and overdue work stays at the top. Check it off when handled or choose Later.</p></details>` : "";
  const mobileNav = `<nav class="mobile-app-nav" aria-label="Dashboard"><a class="${view === "today" ? "active" : ""}" href="${dashboardLink("today")}">${dashboardIcon("today")}<span>Today</span></a><a class="${view === "pipeline" ? "active" : ""}" href="${dashboardLink("pipeline")}">${dashboardIcon("pipeline")}<span>Pipeline</span></a><a class="${view === "calendar" ? "active" : ""}" href="${dashboardLink("calendar")}">${dashboardIcon("calendar")}<span>Calendar</span></a>${preview ? `<a href="/signup">${dashboardIcon("settings")}<span>Start</span></a>` : `<a href="/app/settings">${dashboardIcon("settings")}<span>Settings</span></a>`}</nav>`;
  return layout("Owner dashboard", `<div class="owner-app">${sidebar}<div class="app-content"><header class="app-header"><div><p class="eyebrow">${escapeHtml(input.config.businessName)}</p><h1>${view === "today" ? "Today" : view === "pipeline" ? "Pipeline" : "Calendar"}</h1></div><div class="header-status"><span class="coverage-state ${input.account.status === "active" && !input.config.paused ? "on" : ""}"><i></i>${input.account.status === "active" && !input.config.paused ? "AI coverage on" : "Activation pending"}</span></div></header><main class="dashboard-main">${demoNotice}${alertsOff}${overview}${setupGuide}${undo}${coach}${view === "today" ? todayView : alternateView}</main></div></div>${mobileNav}`);
}

export function renderStart(error = "", values: Record<string, string> = {}): string {
  const value = (name: string): string => escapeHtml(values[name] ?? "");
  return publicLayout("Start", `<div class="announcement">Founding pilot for local HVAC shops <span aria-hidden="true">→</span></div><header class="publicnav"><a class="brand smallbrand" href="/"><span>Front</span> Office</a><nav><a href="/">Back home</a><a href="/privacy">Privacy</a></nav></header><main class="publicmain formpage"><section class="formintro"><p class="eyebrow">Let’s get your phone covered</p><h1>Tell us how your shop handles missed calls.</h1><p>This is an assisted setup for the first local shops. We’ll review your service area and call flow, then confirm a launch slot before any customer traffic is turned on.</p></section>${error ? `<p class="formerror">${escapeHtml(error)}</p>` : ""}<form class="publicform" method="post" action="/start"><div class="grid two"><label>Your name<input name="ownerName" autocomplete="name" maxlength="120" value="${value("ownerName")}" required></label><label>Business name<input name="businessName" autocomplete="organization" maxlength="120" value="${value("businessName")}" required></label></div><div class="grid two"><label>Email<input name="email" type="email" autocomplete="email" maxlength="254" value="${value("email")}" required></label><label>Mobile phone<input name="phone" type="tel" autocomplete="tel" maxlength="30" value="${value("phone")}" required></label></div><div class="grid two"><label>Trade<select name="trade" required>${selectOption("hvac", "HVAC", values.trade)}${selectOption("plumbing", "Plumbing", values.trade)}${selectOption("electrical", "Electrical", values.trade)}${selectOption("other", "Other home service", values.trade)}</select></label><label>Website, if you have one<input name="website" type="url" maxlength="300" placeholder="https://" value="${value("website")}"></label></div><label>Service area<input name="serviceArea" maxlength="500" placeholder="Towns, counties, or ZIP codes" value="${value("serviceArea")}" required></label><div class="grid two"><label>Where should the AI start?<select name="desiredMode" required>${selectOption("overflow", "Only when I miss the call", values.desiredMode)}${selectOption("after_hours", "After hours and weekends", values.desiredMode)}${selectOption("always", "Answer every call", values.desiredMode)}</select></label><label>Calendar<select name="calendarProvider" required>${selectOption("google", "Google Calendar", values.calendarProvider)}${selectOption("none", "No calendar yet", values.calendarProvider)}${selectOption("other", "Another calendar", values.calendarProvider)}</select></label></div><label>About how many calls do you miss in a normal week?<input name="missedCallsPerWeek" type="number" min="0" max="500" step="1" value="${value("missedCallsPerWeek")}"></label><label>Anything we should know?<textarea name="notes" maxlength="1500" placeholder="Current phone setup, hours, dispatch process, or the biggest call problem">${value("notes")}</textarea></label><label class="trap" aria-hidden="true">Fax number<input name="faxNumber" tabindex="-1" autocomplete="off"></label><label class="check"><input name="consent" type="checkbox" value="yes" required> You may contact me about setting up AI Front Office. I agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy notice</a>.</label><button>Send my setup details <span aria-hidden="true">→</span></button></form></main>`);
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
  const rows = accounts.length === 0 ? `<tr><td colspan="5">No owner accounts yet.</td></tr>` : accounts.map((account) => `<tr><td><strong>${escapeHtml(account.displayName)}</strong><br>${escapeHtml(account.email)}</td><td><code>${escapeHtml(account.tenantId)}</code></td><td>${escapeHtml(account.status.replace("_", " "))}</td><td>${escapeHtml(formatDate(account.createdAt, "America/New_York"))}</td><td><form method="post" action="/admin/owners/${encodeURIComponent(account.id)}/status"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Status<select name="status"><option value="pending_activation" ${account.status === "pending_activation" ? "selected" : ""}>pending activation</option><option value="active" ${account.status === "active" ? "selected" : ""}>active</option><option value="suspended" ${account.status === "suspended" ? "selected" : ""}>suspended</option></select></label><label>Dedicated Telnyx number<input name="inboundNumber" type="tel" placeholder="+15555550100"></label><label>Existing Telnyx assistant ID<input name="assistantId" placeholder="Required to activate"></label><button>Save</button></form></td></tr>`).join("");
  return layout("Owner accounts", `<header><div><p class="eyebrow">Customer operations</p><h1>Owner accounts</h1></div><nav><a href="/admin">Calls</a><a href="/admin/signups">Pilot applications</a></nav></header><main><section><p>Activation is fail-closed. An account cannot be activated until its Telnyx assistant route, Google Calendar, owner alert phone, and service area are configured.</p><div class="table"><table><thead><tr><th>Owner</th><th>Tenant</th><th>Status</th><th>Created</th><th>Activation</th></tr></thead><tbody>${rows}</tbody></table></div></section></main>`);
}

export function renderLogin(error = ""): string {
  return layout("Sign in", `<main class="narrow"><h1>Front Office</h1><p>Enter the admin token configured on the server.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="/admin/login"><label>Admin token<input name="token" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></main>`);
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
  return layout("Calls", `<header><div><p class="eyebrow">${escapeHtml(input.config.businessName)}</p><h1>AI Front Office</h1></div><nav><a href="/admin/config">Configuration</a><a href="/admin/readiness">Readiness</a><a href="/admin/owners">Owner accounts</a><a href="/admin/signups">Pilot applications</a><a href="/admin/simulator">Simulator</a><a href="/admin/prompt">Telnyx setup</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/admin/logout">Sign out</a></nav></header><main><section class="status ${input.activation.go ? "goodbox" : "badbox"}"><h2>${input.activation.go ? "GO: first-customer activation gate passed" : `NO-GO: ${input.activation.blocking.length} launch blocker(s)`}</h2><p>Mode: ${escapeHtml(input.activation.mode.replace("_", " "))}. ${input.config.paused ? "Service is paused." : "Service is accepting eligible provider traffic."} <a href="/admin/readiness">Review gate</a></p></section><section class="grid"><article><h2>Calls captured</h2><p>${completedCalls.length}</p></article><article><h2>Verified bookings</h2><p>${verifiedBookings}</p></article><article><h2>Urgent escalations</h2><p>${urgentEscalations}</p></article></section><section class="grid"><article><h2>Coverage</h2><p>${escapeHtml(input.config.operationMode.replace("_", " "))} · ${input.config.answerAfterRings} rings</p></article><article><h2>Plan</h2><p>$${(input.config.flatMonthlyPriceCents / 100).toFixed(0)}/month · ${input.config.includedMinutes} minutes · ${excludedSpam} spam excluded</p></article><article><h2>Integrations</h2><ul>${integrationItems}</ul></article></section><section><h2>Recent calls</h2><div class="table"><table><thead><tr><th>When</th><th>Caller</th><th>Problem</th><th>Priority</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div></section></main>`);
}

export function renderConfig(
  config: BusinessConfig,
  csrf: string,
  integrations: { googleAvailable: boolean; googleConnected: boolean; ownerPhoneConfigured: boolean; weeklyEmailAvailable?: boolean; dailySmsAvailable?: boolean; realtimeSmsAvailable?: boolean; directBookingAvailable?: boolean },
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
    ? `<label>Flat monthly price ($49–$99)<input name="flatMonthlyPrice" type="number" min="49" max="99" step="1" value="${Math.round(config.flatMonthlyPriceCents / 100)}"></label>`
    : `<label>Plan<input value="$${Math.round(config.flatMonthlyPriceCents / 100)}/month · ${config.includedMinutes} minutes included · $${(config.overageCentsPerMinute / 100).toFixed(2)}/minute after" disabled><input name="flatMonthlyPrice" type="hidden" value="${Math.round(config.flatMonthlyPriceCents / 100)}"></label>`;
  const customerSms = surface === "platform" ? `<label class="check"><input name="customerSmsEnabled" type="checkbox" ${config.customerSmsEnabled ? "checked" : ""}> Customer-facing appointment SMS enabled only after that shop’s carrier registration is approved</label>` : `<p class="small">Owner alerts are included. Customer-facing texts stay off until carrier registration is approved for your shop.</p>`;
  const hourOptions = Array.from({ length: 24 }, (_, hour) => `<option value="${hour}" ${config.ownerDailySmsHour === hour ? "selected" : ""}>${new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, hour)))}</option>`).join("");
  const disabled = (available: boolean | undefined): string => available ? "" : " disabled";
  const notificationSettings = `<section class="notification-options"><p class="eyebrow">Owner updates</p><h2>Choose how Front Office keeps you on track</h2><label class="notification-option"><input name="ownerWeeklyEmailEnabled" type="checkbox" ${config.ownerWeeklyEmailEnabled ? "checked" : ""}${disabled(integrations.weeklyEmailAvailable)}><span><strong>Sunday week-ahead email <em>Included</em></strong><small>Open callbacks and the next seven days of appointments.</small>${integrations.weeklyEmailAvailable ? "" : "<small class=error>Email delivery is awaiting setup.</small>"}</span></label><label class="notification-option"><input name="ownerDailySmsEnabled" type="checkbox" ${config.ownerDailySmsEnabled ? "checked" : ""}${disabled(integrations.dailySmsAvailable)}><span><strong>Daily text recap <em>+$5/mo</em></strong><small>Follow-ups and appointments, once each morning.</small>${integrations.dailySmsAvailable ? "" : "<small class=error>Billing setup is not complete.</small>"}</span></label><label>Daily recap time<select name="ownerDailySmsHour">${hourOptions}</select></label><label class="notification-option"><input name="ownerRealtimeSmsEnabled" type="checkbox" ${config.ownerRealtimeSmsEnabled ? "checked" : ""}${disabled(integrations.realtimeSmsAvailable)}><span><strong>Instant lead texts <em>+$10/mo</em></strong><small>Routine new leads as they arrive. Emergency and handoff texts stay included.</small>${integrations.realtimeSmsAvailable ? "" : "<small class=error>Billing setup is not complete.</small>"}</span></label></section>`;
  return layout("Configuration", `<header><div><p class="eyebrow">Owner setup</p><h1>Configuration</h1></div><nav><a href="${base}">Calls</a>${platformNav}</nav></header><main><section><h2>Calendar</h2><p>${googleAction}</p><p>A booking counts only after a system-of-record write is read back, the recording and transcript exist, and intake is complete.</p></section><form method="post" action="${base}/config"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><div class="status ${config.paused ? "badbox" : "goodbox"}"><h2>${config.paused ? "Service paused" : "Service enabled"}</h2><label>Service state<select name="serviceState"><option value="paused" ${config.paused ? "selected" : ""}>paused—disconnect the AI line</option><option value="active" ${!config.paused ? "selected" : ""}>active—connect the AI line</option></select></label><p class="small">Paused means the AI cannot answer. New accounts stay paused until assisted activation is complete.</p></div><div class="grid two"><label>Business name<input name="businessName" value="${escapeHtml(config.businessName)}" required></label><label>Timezone<input name="timezone" value="${escapeHtml(config.timezone)}" required></label></div><label>Greeting<textarea name="greeting" required>${escapeHtml(config.greeting)}</textarea></label><div class="grid two"><label>Owner alert phone<input name="ownerPhone" type="tel" placeholder="${integrations.ownerPhoneConfigured ? "Configured—enter a replacement only" : "+15555550100"}"></label>${surface === "platform" || integrations.directBookingAvailable ? `<label>Booking mode<select name="bookingMode"><option value="confirm" ${config.bookingMode === "confirm" ? "selected" : ""}>confirm first</option><option value="direct" ${config.bookingMode === "direct" ? "selected" : ""}>direct booking</option></select></label>` : `<input type="hidden" name="bookingMode" value="confirm">`}</div><div class="grid two"><label>Coverage mode<select name="operationMode">${option("always", config.operationMode)}${option("after_hours", config.operationMode)}${option("overflow", config.operationMode)}</select></label><label>Answer after rings<input name="answerAfterRings" type="number" min="2" max="12" step="1" value="${config.answerAfterRings}"></label></div><div class="grid two">${planField}<label>Data retention (days)<input name="dataRetentionDays" type="number" min="7" max="365" step="1" value="${config.dataRetentionDays}"></label></div>${notificationSettings}<div class="grid two"><label>Default job duration (minutes)<input name="defaultServiceDurationMinutes" type="number" min="15" max="480" step="15" value="${config.defaultServiceDurationMinutes}"></label><label>Emergency score threshold<input name="emergencyThreshold" type="number" min="0.5" max="0.9" step="0.05" value="${config.emergencyThreshold}"></label></div><div class="grid two"><label>Calls allowed per caller per 24 hours<input name="maxCallsPerCallerPerDay" type="number" min="1" max="20" step="1" value="${config.maxCallsPerCallerPerDay}"></label><label>Support/cancellation email<input name="supportEmail" type="email" value="${escapeHtml(config.supportEmail ?? "")}" placeholder="support@example.com"></label></div>${customerSms}<label class="check"><input name="requireDiagnosticFeeAcceptance" type="checkbox" ${config.requireDiagnosticFeeAcceptance ? "checked" : ""}> Require diagnostic-fee acceptance</label><div class="grid two"><label>Covered city + state pairs and ZIP codes<textarea name="serviceAreaTerms" placeholder="Albany NY, 12207, 12208">${escapeHtml(config.serviceAreaTerms.join(", "))}</textarea><span class="small">Use city and state together. The agent never infers a radius.</span></label><label>Service categories (comma separated)<textarea name="serviceCategories">${escapeHtml(config.serviceCategories.join(", "))}</textarea></label></div><label>Emergency keywords (comma separated)<textarea name="emergencyKeywords">${escapeHtml(config.emergencyKeywords.join(", "))}</textarea></label><div class="grid two"><label>Approved price/script snippets (one Label: Exact wording per line)<textarea name="priceSnippets">${escapeHtml(config.priceSnippets.map((item) => `${item.label}: ${item.text}`).join("\n"))}</textarea></label><label>Owner-approved knowledge (one Topic: Answer per line)<textarea name="approvedKnowledge">${escapeHtml(config.approvedKnowledge.map((item) => `${item.topic}: ${item.text}`).join("\n"))}</textarea></label></div><label>Pronunciations (one Term: Spoken as per line)<textarea name="pronunciations">${escapeHtml(config.pronunciations.map((item) => `${item.term}: ${item.spokenAs}`).join("\n"))}</textarea></label><div class="grid two"><label>Weekday coverage starts<input name="weekdayStart" type="time" value="${escapeHtml(config.afterHours.weekdayStart)}"></label><label>Weekday coverage ends<input name="weekdayEnd" type="time" value="${escapeHtml(config.afterHours.weekdayEnd)}"></label></div><label>Holiday coverage dates (comma separated YYYY-MM-DD)<textarea name="holidayDates">${escapeHtml(config.afterHours.holidayDates.join(", "))}</textarea></label><label class="check"><input name="weekends" type="checkbox" ${config.afterHours.weekends ? "checked" : ""}> Cover weekends</label><h2>Appointments the agent may offer</h2><div class="grid two"><label>Bookable day starts<input name="bookableWeekdayStart" type="time" value="${escapeHtml(config.bookableHours.weekdayStart)}"></label><label>Bookable day ends<input name="bookableWeekdayEnd" type="time" value="${escapeHtml(config.bookableHours.weekdayEnd)}"></label></div><div class="grid two"><label>Minimum notice (minutes)<input name="minimumLeadTimeMinutes" type="number" min="0" max="10080" step="30" value="${config.minimumLeadTimeMinutes}"></label><label class="check"><input name="bookableWeekends" type="checkbox" ${config.bookableHours.weekends ? "checked" : ""}> Offer weekend appointments</label></div><label>Recording/AI disclosure<textarea name="recordingDisclosure" required>${escapeHtml(config.recordingDisclosure)}</textarea></label><button>Save configuration</button></form>${surface === "owner" ? `<section><h2>Your data</h2><p><a href="/app/account/export">Download all your call records and settings</a> (JSON).</p><form method="post" action="/app/account/delete"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><h3>Delete your account</h3><p class="small">Cancel your subscription in Billing first. This disconnects your Front Office line and permanently deletes every call record, transcript, recording, task and setting. Appointments already on your calendar stay there.</p><label>Type DELETE to confirm<input name="confirm" autocomplete="off" required></label><label>Your password<input name="password" type="password" autocomplete="current-password" required></label><button class="dangerbutton">Delete my account</button></form></section>` : ""}</main>`);
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
  return layout("Call", `<header><div><p class="eyebrow">${escapeHtml(formatDate(call.startedAt, input.config.timezone))}</p><h1>${escapeHtml(call.fields.callerName ?? "Unknown caller")}</h1></div><nav><a href="${base}">Calls</a></nav></header><main><section class="grid"><article><h2>Outcome</h2><p>${escapeHtml(call.outcome)}</p></article><article><h2>Priority</h2><p>${escapeHtml(call.emergency?.severity ?? "not classified")}</p></article><article><h2>Booking</h2><p>${escapeHtml(input.booking?.status ?? "none")}</p></article></section>${input.callbackTask ? `<section><h2>Owned callback</h2><p>${escapeHtml(input.callbackTask.ownerRef)} · due ${escapeHtml(formatDate(input.callbackTask.dueAt, input.config.timezone))} · ${escapeHtml(input.callbackTask.reason)}</p></section>` : ""}<section class="grid two"><article><h2>Caller</h2><dl><dt>Phone</dt><dd>${escapeHtml(call.fields.callbackNumber ?? call.fromNumber)}</dd><dt>Address</dt><dd>${escapeHtml(call.fields.address ?? "Not confirmed")}</dd><dt>Category</dt><dd>${escapeHtml(call.fields.serviceCategory ?? "Not classified")}</dd><dt>Problem</dt><dd>${escapeHtml(call.fields.problemDescription || "Not captured")}</dd></dl></article><article><h2>Evidence</h2><dl><dt>Verification gaps</dt><dd>${escapeHtml(call.qualityFlags.join(", ") || "None")}</dd><dt>Emergency evidence</dt><dd>${escapeHtml(call.emergency?.evidence.join(", ") || "None")}</dd><dt>Consent</dt><dd>${escapeHtml(call.consentState)}</dd><dt>Billing</dt><dd>${escapeHtml(call.billingDisposition)}</dd><dt>Recording</dt><dd>${recording ? `<a href="${escapeHtml(recording)}" rel="noreferrer">Open recording</a>` : "Unavailable"}</dd></dl></article></section><section><h2>Transcript</h2><pre>${escapeHtml(call.transcript ?? "Transcript unavailable")}</pre></section><section><h2>Tool events</h2><div class="table"><table><tbody>${eventRows}</tbody></table></div></section><section><h2>Owner alerts</h2><div class="table"><table><tbody>${notificationRows}</tbody></table></div></section>${input.canDelete === false ? "" : `<form method="post" action="${base}/calls/${encodeURIComponent(call.id)}/delete"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><h2>Delete call data</h2><p>This permanently removes the call record, transcript, recording, callback, tool events, notifications, and any customer record whose latest call is this one. Appointments already on your calendar stay on your calendar.</p><label class="check"><input name="confirm" type="checkbox" value="delete" required> I understand this cannot be undone.</label><button class="dangerbutton">Delete permanently</button></form>`}</main>`);
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

export function renderPrivacy(config: BusinessConfig): string {
  const support = config.supportEmail ? `<a href="mailto:${escapeHtml(config.supportEmail)}">${escapeHtml(config.supportEmail)}</a>` : "the support contact supplied during onboarding";
  return layout("Privacy", `<header><div><p class="eyebrow">${escapeHtml(config.businessName)}</p><h1>Privacy notice</h1></div><nav><a href="/terms">Terms</a></nav></header><main><section><h2>What is collected</h2><p>Owner accounts store encrypted contact and business settings plus a one-way password hash. The call service may store caller phone number, name, service address, problem description, transcript, recording link, call outcome, booking evidence, and notification status.</p><h2>Who processes it</h2><p>The configured voice, telephony/SMS, calendar, hosting, database, and payment providers process only the data needed for their role. The service does not sell caller or owner data.</p><h2>SMS consent data</h2><p>Phone numbers and SMS opt-in or consent records are not sold, rented, or shared with third parties or affiliates for marketing or promotional purposes. They are shared only with service providers that must process them to operate the requested messaging service.</p><h2>Retention and deletion</h2><p>Call records are retained for ${config.dataRetentionDays} days unless legal or customer obligations require a different period. The owner can delete a call immediately from its protected detail page. Appointments written to the owner's Google Calendar are kept in that calendar and managed by the owner; deleting a call record does not remove them. Contact ${support} for access, correction, export, or deletion requests.</p><h2>Recording and AI disclosure</h2><p>${escapeHtml(config.recordingDisclosure)} A caller who objects is told that the recorded AI line cannot continue; the recording is deleted and automated intake ends.</p></section></main>`);
}

export function renderTerms(config: BusinessConfig): string {
  const support = config.supportEmail ? `<a href="mailto:${escapeHtml(config.supportEmail)}">${escapeHtml(config.supportEmail)}</a>` : "the support contact supplied during onboarding";
  return layout("Terms", `<header><div><p class="eyebrow">${escapeHtml(config.businessName)}</p><h1>Service terms</h1></div><nav><a href="/privacy">Privacy</a></nav></header><main><section><h2>Scope</h2><p>This service is an AI-assisted overflow receptionist. It is not emergency dispatch, a licensed trade professional, or a guarantee that an appointment is booked. Only a verified system write and explicit confirmation count as booked.</p><h2>Owner authorization</h2><p>By creating an account, activating service, or paying for a subscription, the owner authorizes Front Office and its service providers to answer eligible calls using an identified AI assistant and to record and transcribe calls after the required caller disclosure. The owner agrees not to remove or weaken the mandatory disclosure and remains responsible for using the service only where permitted by applicable law.</p><h2>Caller disclosure</h2><p>${escapeHtml(config.recordingDisclosure)} A caller who continues after this notice is treated as consenting. If a caller objects, automated intake ends and the retained recording is deleted.</p><h2>Pricing and usage</h2><p>The Solo plan is $${(config.flatMonthlyPriceCents / 100).toFixed(0)} per month and includes ${config.includedMinutes} connected AI minutes. Additional connected minutes are $${(config.overageCentsPerMinute / 100).toFixed(2)} each and appear in the owner dashboard before a separate monthly overage invoice. Customer-facing SMS is disabled unless the shop’s carrier registration is approved.</p><h2>Operational text alerts</h2><p>Front Office sends call alerts and service messages to the owner number that opted in during setup. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Contact ${support} for support.</p><h2>Cancellation and support</h2><p>Cancel month to month or request a pause through ${support}. Pausing rejects new provider traffic; data follows the published retention/deletion process.</p><h2>Availability</h2><p>Voice, carrier, SMS, calendar, and hosting providers can fail. The product records failures and creates follow-up work, but it cannot guarantee uninterrupted delivery.</p></section></main>`);
}

export function renderPrompt(config: BusinessConfig, publicBaseUrl: string): string {
  return layout("Telnyx setup", `<header><div><p class="eyebrow">Provider setup</p><h1>Telnyx assistant configuration</h1></div><nav><a href="/admin">Calls</a></nav></header><main><p>This is the exact idempotent assistant update generated from the owner configuration. Apply it with <code>npm run configure:telnyx -- --apply</code>; never paste secrets into this page.</p><pre>${escapeHtml(JSON.stringify(buildTelnyxAssistantUpdate(config, publicBaseUrl), null, 2))}</pre></main>`);
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="An AI receptionist for local HVAC and home-service shops that handles missed and after-hours calls."><title>${escapeHtml(title)} · Front Office</title><style>:root{color-scheme:light;--blue:#0759a8;--yellow:#e7f34b;--red:#e53221;--paper:#f1efe7;--ink:#073f77;--white:#fffef8;--line:#0759a8;--shadow:6px 6px 0 var(--blue)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background-color:var(--paper);background-image:radial-gradient(rgba(7,89,168,.07) .7px,transparent .8px),linear-gradient(90deg,rgba(255,255,255,.24),rgba(7,89,168,.025));background-size:5px 5px,100% 100%;font:17px/1.42 Georgia,"Times New Roman",serif}.announcement{background:var(--red);color:white;text-align:center;text-transform:uppercase;letter-spacing:.05em;font:800 13px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:11px 16px}.announcement span{display:inline-block;margin-left:10px}.publicnav,.publicmain{max-width:1240px;margin:auto;padding-left:28px;padding-right:28px}.publicnav{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-top:24px;padding-bottom:18px;border-bottom:2px solid var(--blue)}.publicnav nav{display:flex;gap:24px;align-items:center;font:700 15px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif}.publicnav a,.publicfooter a,.textlink{color:var(--blue);text-underline-offset:4px}.brand{font:italic 900 clamp(42px,7vw,82px)/.8 Georgia,"Times New Roman",serif;text-decoration:none;letter-spacing:-.07em;white-space:nowrap}.brand span{font-style:normal}.smallbrand{font-size:clamp(36px,5vw,58px)}.navbutton{background:var(--yellow);border:2px solid var(--blue);padding:11px 15px;text-decoration:none;box-shadow:3px 3px 0 var(--blue);text-transform:uppercase}.publichero{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);gap:clamp(36px,8vw,100px);align-items:center;padding:clamp(64px,10vw,130px) 0 80px}.eyebrow{font:900 13px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif;text-transform:uppercase;letter-spacing:.11em;margin:0 0 14px}.publichero h1,.formintro h1,.received h1{font:900 clamp(52px,8.6vw,112px)/.88 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.065em;margin:0;max-width:980px}.publichero h1 em{display:block;color:var(--red);font:italic 900 1.02em/.92 Georgia,"Times New Roman",serif;letter-spacing:-.055em}.lede{font-size:clamp(20px,2.2vw,29px);max-width:760px;margin:28px 0}.actions{display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin:28px 0 18px}.button,.publicform button{display:inline-block;background:var(--yellow);color:var(--blue);border:2px solid var(--blue);box-shadow:var(--shadow);padding:15px 20px;text-decoration:none;text-transform:uppercase;font:900 14px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.03em;cursor:pointer;transition:transform .16s,box-shadow .16s}.button:hover,.button:focus-visible,.publicform button:hover,.publicform button:focus-visible{transform:translate(3px,3px);box-shadow:3px 3px 0 var(--blue)}.textlink{font-weight:700}.small{font-size:14px}.call-card{position:relative;background:var(--yellow);border:3px solid var(--blue);box-shadow:12px 12px 0 var(--blue);padding:24px;transform:rotate(2deg)}.call-top{font:900 12px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif;text-transform:uppercase;letter-spacing:.08em}.live-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--red);margin-right:7px}.caller{font:900 clamp(28px,4vw,48px)/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.04em;margin:30px 0}.call-card dl{margin:0;border-top:2px solid var(--blue)}.call-card dl div{display:flex;justify-content:space-between;gap:20px;border-bottom:2px solid var(--blue);padding:10px 0}.call-card dt{font-weight:700}.call-card dd{margin:0;text-align:right}.call-stamp{display:inline-block;margin:28px 0 0;border:3px solid var(--red);color:var(--red);font:900 16px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:8px 10px;transform:rotate(-5deg)}.ticker{overflow:hidden;border-block:3px solid var(--blue);background:var(--blue);color:var(--yellow);margin-inline:calc(50% - 50vw);white-space:nowrap}.ticker div{display:inline-block;min-width:200%;padding:14px 0;font:900 15px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.08em;animation:marquee 26s linear infinite}@keyframes marquee{to{transform:translateX(-50%)}}.publicsection{padding:clamp(70px,10vw,130px) 0;border-bottom:2px solid var(--blue)}.publicsection>h2,.rules h2,.steps h2{font:900 clamp(40px,6vw,76px)/.95 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.055em;max-width:940px;margin:0 0 46px}.feature-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.feature-grid article{min-height:310px;background:var(--white);border:3px solid var(--blue);padding:24px;box-shadow:8px 8px 0 var(--blue)}.feature-grid article.yellow{background:var(--yellow);transform:rotate(-1deg)}.feature-grid article.red{background:var(--red);color:white;transform:rotate(1.2deg)}.number{display:block;font:900 15px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;margin-bottom:80px}.feature-grid h3{font:900 clamp(30px,4vw,48px)/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.045em;margin:0 0 14px}.feature-grid p{margin:0}.rules{display:grid;grid-template-columns:1fr 1fr;gap:clamp(40px,10vw,130px);align-items:center}.rules h2{margin:0}.rules div:last-child{font-size:clamp(20px,2.2vw,27px)}.steps ol{list-style:none;padding:0;margin:0;border-top:2px solid var(--blue)}.steps li{display:grid;grid-template-columns:1fr 1.3fr;gap:40px;padding:24px 0;border-bottom:2px solid var(--blue)}.steps strong{font:900 clamp(22px,3vw,34px)/1.1 ui-sans-serif,system-ui,-apple-system,sans-serif}.pricing{display:grid;grid-template-columns:1fr 1fr;gap:clamp(40px,10vw,130px);align-items:center;background:var(--yellow);margin-inline:calc(50% - 50vw);padding-left:max(28px,calc((100vw - 1184px)/2));padding-right:max(28px,calc((100vw - 1184px)/2))}.pricing h2{font:900 clamp(70px,10vw,132px)/.8 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:-.075em;margin:0}.pricing h2 span{font-size:.18em;letter-spacing:0}.publicfooter{display:flex;justify-content:space-between;gap:24px;padding:32px 0 48px;font:700 14px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif}.publicfooter div{display:flex;gap:20px}.formpage{max-width:980px}.formintro,.received{padding:clamp(60px,9vw,120px) 0 45px}.formintro h1,.received h1{font-size:clamp(48px,8vw,96px)}.formintro>p:last-child,.received>p{font-size:21px;max-width:740px}.publicform{background:var(--yellow);border:3px solid var(--blue);box-shadow:12px 12px 0 var(--blue);padding:clamp(22px,5vw,48px);margin:0 0 80px}.grid{display:grid;gap:18px}.grid.two{grid-template-columns:repeat(2,1fr)}.publicform label{display:block;font:800 14px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;margin-bottom:20px}.publicform input,.publicform textarea,.publicform select{display:block;width:100%;margin-top:8px;padding:13px 14px;border:2px solid var(--blue);border-radius:0;background:var(--white);color:var(--blue);font:16px/1.4 Georgia,"Times New Roman",serif}.publicform textarea{min-height:110px}.publicform .check{display:flex;gap:10px;align-items:flex-start;font-weight:600}.publicform .check input{width:auto;margin:4px 0 0}.publicform button{background:var(--red);color:white}.trap{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.formerror{background:#fff;border:3px solid var(--red);color:#a41d12;padding:16px;margin:0 0 22px;font-weight:700}.received{max-width:900px;min-height:80vh}.received .button{margin-right:14px}.received .small{max-width:620px}.received .actions{align-items:flex-start;flex-direction:column}@media(max-width:800px){.publicnav{align-items:flex-start}.publicnav nav a:not(.navbutton){display:none}.publichero,.rules,.pricing{grid-template-columns:1fr}.publichero{padding-top:55px}.call-card{transform:none}.feature-grid{grid-template-columns:1fr}.feature-grid article.yellow,.feature-grid article.red{transform:none}.steps li{grid-template-columns:1fr;gap:10px}.grid.two{grid-template-columns:1fr}.publicfooter{flex-direction:column}.pricing{padding-top:70px;padding-bottom:70px}}@media(max-width:480px){.publicnav,.publicmain{padding-left:18px;padding-right:18px}.brand{font-size:38px}.navbutton{padding:9px 10px;font-size:12px}.publichero h1{font-size:50px}.publicfooter div{flex-wrap:wrap}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.ticker div{animation:none}.button,.publicform button{transition:none}}</style></head><body>${body}</body></html>`;
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Front Office</title><style>:root{color-scheme:light;--ink:#14221b;--muted:#627067;--line:#dfe7e1;--paper:#f6f8f5;--accent:#176b45;--danger:#a42b2b}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}header,main,.narrow{max-width:1120px;margin:auto;padding:28px}header{display:flex;align-items:end;justify-content:space-between;gap:20px}footer{display:flex;gap:18px;padding:12px 4px 40px}nav{display:flex;gap:16px;flex-wrap:wrap}a{color:var(--accent)}h1{font-size:clamp(28px,5vw,48px);line-height:1.05;margin:0}h2{font-size:clamp(18px,2.3vw,28px);line-height:1.2;margin:0 0 10px}.eyebrow{color:var(--muted);margin:0 0 4px;text-transform:uppercase;letter-spacing:.08em}.hero{padding:clamp(24px,6vw,64px)}.lede{font-size:clamp(18px,3vw,25px);max-width:820px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}.button{display:inline-block;background:var(--accent);color:white;text-decoration:none;font-weight:750;padding:12px 18px;border-radius:10px}.button.secondary{background:var(--ink)}.small{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px}.grid.two{grid-template-columns:repeat(2,1fr)}article,form,section{background:white;border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}.status{border-width:2px}.goodbox{border-color:#74b58f;background:#f1fbf5}.badbox{border-color:#d99b9b;background:#fff6f6}.narrow{max-width:560px;padding-top:12vh}label{display:block;font-weight:650;margin-bottom:16px}input,textarea,select{display:block;width:100%;margin-top:7px;padding:11px;border:1px solid #aebbb2;border-radius:8px;font:inherit}input:disabled{opacity:.58}textarea{min-height:92px}button{background:var(--ink);color:white;border:0;border-radius:9px;padding:12px 18px;font-weight:700}.dangerbutton{background:var(--danger)}.check{display:flex;gap:8px;align-items:flex-start}.check input{width:auto;margin:5px 0 0}.notification-options{background:#f8fbf9;border:1px solid var(--line);padding:18px;margin:4px 0 22px}.notification-option{display:grid;grid-template-columns:24px 1fr;gap:10px;padding:12px 0;border-bottom:1px solid var(--line)}.notification-option input{width:20px;height:20px;margin:2px 0}.notification-option span{display:grid;gap:2px}.notification-option em{float:right;color:var(--accent);font-style:normal}.notification-option small{color:var(--muted);font-weight:400}.table{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line);vertical-align:top}.pill{display:inline-block;background:#e7eee9;border-radius:99px;padding:2px 8px}.danger,.error,.formerror{color:var(--danger)}.formerror{max-width:1120px;margin:0 auto 18px;padding:14px 20px;background:#fff6f6;border:1px solid #d99b9b;border-radius:10px}.good{color:var(--accent)}.trap{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#102019;color:#e9f4ed;border-radius:10px;padding:16px}dt{font-weight:700}dd{margin:0 0 10px}@media(max-width:720px){header{align-items:start;flex-direction:column}.grid,.grid.two{grid-template-columns:1fr}header,main{padding:14px}.notification-options{padding:14px}}</style></head><body>${body}</body></html>`;
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
