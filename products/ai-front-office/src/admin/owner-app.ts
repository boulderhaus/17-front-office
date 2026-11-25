import { forwardingInstructions } from "../adapters/telnyx-provisioning.js";
import { ringChoicesWith } from "../domain/forwarding.js";
import { ownerTaskReason } from "../domain/task-reason.js";
import { USAGE_EXCLUSION_NOTE, extraCalls, usageAlertOptions } from "../domain/usage.js";
import { fairUseCalls, money, perCall } from "../domain/plans.js";
import { hasPlanAccess, isCompStatus } from "../domain/billing.js";
import type { BookingRecord, BusinessConfig, CallbackTask, CallRecord, OutboxNotification, OwnerAccount, SubscriptionRecord, UsageSummary } from "../domain/models.js";
import { escapeHtml as e } from "./render.js";
import { isPasswordless } from "../security/owner-auth.js";
import type { CallPath, CallPathStep } from "../domain/call-path.js";

export type OwnerView = "today" | "pipeline" | "calendar" | "settings" | "call";

/**
 * The owner's app: phone first (one column, thumb-reach bottom tabs, 48px targets),
 * then a sidebar and a call panel on wider screens. Same brand as the website.
 */
export function ownerShell(input: {
  title: string;
  view: OwnerView;
  businessName: string;
  status: { tone: "on" | "pending" | "paused" | "warning"; label: string };
  body: string;
  base: string;
  needsAttention: number;
  preview?: boolean;
}): string {
  const link = (view: "today" | "pipeline" | "calendar"): string => view === "today" ? input.base : `${input.base}?view=${view}`;
  const settingsHref = input.preview ? "/signup" : "/app/settings";
  const tab = (view: OwnerView, href: string, icon: string, label: string, badge = 0): string =>
    `<a class="${input.view === view ? "active" : ""}" href="${href}"${input.view === view ? ' aria-current="page"' : ""}>${ownerIcon(icon)}<span>${label}</span>${badge ? `<b>${badge}</b>` : ""}</a>`;
  const tabs = [
    tab("today", link("today"), "today", "Calls", input.needsAttention),
    tab("pipeline", link("pipeline"), "jobs", "Jobs"),
    tab("calendar", link("calendar"), "calendar", "Calendar"),
    tab("settings", settingsHref, "settings", input.preview ? "Start" : "Settings"),
  ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#faf8f1"><title>${e(input.title)} · Call Otto</title><style>${OWNER_CSS}</style></head><body class="fo-body"><div class="fo">
<aside class="fo-side" aria-label="Main navigation"><a class="fo-brand" href="${link("today")}"><span>CO</span><strong>Call <em>Otto</em></strong></a><nav>${tabs}</nav><div class="fo-side-foot">${input.preview ? '<a href="/">Back to site</a><a class="fo-btn" href="/signup">Get started</a>' : '<a href="/app/team">Team &amp; calendars</a><a href="/logout">Sign out</a>'}</div></aside>
<div class="fo-main"><header class="fo-top"><div class="fo-top-name"><span class="fo-mark">CO</span><span><small>${e(input.businessName)}</small><strong>${e(input.title)}</strong></span></div><a class="fo-status ${input.status.tone}" href="${settingsHref}"><i></i>${e(input.status.label)}</a></header>
<main class="fo-content">${input.body}</main></div>
<nav class="fo-tabs" aria-label="Dashboard">${tabs}</nav></div></body></html>`;
}

export function coverageStatus(account: Pick<OwnerAccount, "status">, config: Pick<BusinessConfig, "paused" | "pausedForBilling" | "ownerNotificationRefs">): { tone: "on" | "pending" | "paused" | "warning"; label: string } {
  if (account.status !== "active") return { tone: "pending", label: "Activation pending" };
  if (config.pausedForBilling) return { tone: "warning", label: "Paused · billing" };
  if (config.paused) return { tone: "paused", label: "Paused" };
  if (config.ownerNotificationRefs.length === 0) return { tone: "warning", label: "On · alerts off" };
  return { tone: "on", label: "Answering calls" };
}

export function renderOwnerApp(input: {
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
  view?: "today" | "pipeline" | "calendar";
  preview?: boolean;
  lineNumber?: string | null;
  lineError?: string | null;
}): string {
  const preview = input.preview === true;
  const view = input.view ?? "today";
  const tz = input.config.timezone;
  const nowMs = Date.parse(input.now);
  const base = preview ? "/demo" : "/app";
  const owner = input.account.role !== "member";
  const paid = hasPlanAccess(input.subscription?.status);
  const callsById = new Map(input.calls.map((call) => [call.id, call]));
  const actionable = input.tasks
    .filter((task) => task.status === "open" || (task.status === "snoozed" && Date.parse(task.dueAt) <= nowMs))
    .sort((left, right) => left.priority === right.priority ? left.dueAt.localeCompare(right.dueAt) : left.priority === "high" ? -1 : 1);
  const snoozed = input.tasks.filter((task) => task.status === "snoozed" && Date.parse(task.dueAt) > nowMs);
  const completed = input.tasks.filter((task) => task.status === "completed");
  const urgentCount = actionable.filter((task) => task.priority === "high").length;
  const link = (target: "today" | "pipeline" | "calendar", callId?: string): string => {
    const params = new URLSearchParams();
    if (target !== "today") params.set("view", target);
    if (callId) params.set("call", callId);
    const query = params.toString();
    return `${base}${query ? `?${query}` : ""}`;
  };
  const phoneFor = (call: CallRecord | undefined): string | null => {
    const phone = call ? call.fields.callbackNumber ?? call.fromNumber : null;
    return phone && /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
  };
  const csrfField = `<input type="hidden" name="csrf" value="${e(input.csrf)}">`;
  const upcoming = input.calls
    .filter((call) => call.fields.requestedStart && Date.parse(call.fields.requestedStart) >= nowMs && Date.parse(call.fields.requestedStart) < nowMs + 7 * 86_400_000)
    .sort((left, right) => left.fields.requestedStart!.localeCompare(right.fields.requestedStart!));
  const booked = upcoming.filter((call) => call.outcome === "booked");
  const used = input.usage.billableCalls;
  // With Unlimited, nothing is extra until fair use (3× the plan's calls).
  const included = input.config.unlimitedCalls ? fairUseCalls(input.config.includedCalls) : input.config.includedCalls;
  const remaining = Math.max(0, included - used);
  const extra = extraCalls(used, included);

  // ---- banners -------------------------------------------------------------
  const banners: string[] = [];
  if (preview) banners.push(`<div class="fo-note"><strong>Read-only demo</strong><span>Synthetic calls only. Real owners can call back, check off, and snooze.</span></div>`);
  if (!preview && input.config.ownerNotificationRefs.length === 0) {
    banners.push(`<div class="fo-note danger" role="alert"><strong>Urgent alerts are off.</strong><span>Emergencies will only appear here, and your line can’t be turned on until you add a mobile number for alerts.</span><a class="fo-btn small" href="/app/setup">Turn on alerts</a></div>`);
  }
  if (!preview && input.recentlyCompletedCallId) {
    banners.push(`<div class="fo-note ok" role="status"><strong>Marked handled.</strong><form method="post" action="/app/calls/${encodeURIComponent(input.recentlyCompletedCallId)}/task/reopen">${csrfField}<button class="fo-link">Undo</button></form></div>`);
  }
  const rulesSaved = input.config.serviceAreaTerms.length > 0 && input.config.greeting.trim().length > 0;
  const steps = [
    { done: rulesSaved, label: "Set your call rules", href: "/app/setup", cta: "Set rules" },
    { done: input.googleConnected, label: "Connect Google Calendar", href: "/app/integrations/google/start", cta: "Connect" },
    { done: paid, label: "Start your plan", href: "", cta: `Start ${money(input.config.flatMonthlyPriceCents)}/mo plan` },
    { done: input.account.status === "active", label: "Get your Call Otto number", href: "#go-live", cta: "Turn on my line" },
  ];
  const doneSteps = steps.filter((step) => step.done).length;
  const nextStep = steps.find((step) => !step.done);
  const setup = owner && doneSteps < steps.length ? `<section class="fo-card fo-setup"><div class="fo-setup-head"><div><h2>Finish setup</h2><p>${doneSteps} of ${steps.length} done. Calls stay off until setup is checked.</p></div><span class="fo-ring" style="--p:${Math.round((doneSteps / steps.length) * 100)}">${doneSteps}/${steps.length}</span></div><ol class="fo-steps">${steps.map((step) => `<li class="${step.done ? "done" : ""}"><i>${step.done ? "✓" : ""}</i>${e(step.label)}</li>`).join("")}</ol>${input.lineError ? `<p class="fo-warn" role="alert">${e(input.lineError)}</p>` : ""}${preview || !nextStep ? "" : nextStep.href === "#go-live"
      ? `<form method="post" action="/app/line/go-live">${csrfField}<button class="fo-btn wide">${e(nextStep.cta)}</button></form><p class="fo-fine">We pick a local number in your area code. You keep your business number and forward calls to it.</p>`
      : nextStep.href
      ? `<a class="fo-btn wide" href="${nextStep.href}">${e(nextStep.cta)}</a>`
      : input.checkoutConfigured ? `<form method="post" action="/app/billing/checkout">${csrfField}<button class="fo-btn wide">${e(nextStep.cta)}</button></form>` : ""}</section>` : "";
  const forwarding = owner && !preview && input.account.status === "active" && input.lineNumber ? forwardingCard(input.lineNumber, input.config.operationMode, input.calls.length === 0) : "";

  // ---- pieces ----------------------------------------------------------------
  const urgency = (task: CallbackTask | undefined, call: CallRecord | undefined): { cls: string; label: string } => {
    if (call?.emergency?.severity === "life_safety") return { cls: "danger", label: "Emergency" };
    if (task?.priority === "high" || call?.emergency?.emergency) return { cls: "danger", label: "Urgent" };
    if (call?.outcome === "booked") return { cls: "good", label: "Booked" };
    if (call?.fields.requestedStart) return { cls: "warn", label: "Confirm time" };
    return { cls: "", label: "Call back" };
  };
  const shortAddress = (call: CallRecord | undefined): string => (call?.fields.address ?? "").split(",").slice(0, 2).join(",").trim();
  const due = (task: CallbackTask): string => Date.parse(task.dueAt) <= nowMs ? "Due now" : `Due ${compactDate(task.dueAt, tz)}`;
  const taskCard = (task: CallbackTask): string => {
    const call = callsById.get(task.callId);
    const phone = phoneFor(call);
    const badge = urgency(task, call);
    const meta = [due(task), shortAddress(call)].filter(Boolean).join(" · ");
    const actions = preview
      ? `${phone ? `<a class="fo-btn" href="tel:${e(phone)}">${ownerIcon("phone")}Call back</a>` : ""}<a class="fo-ghost" href="${link(view, task.callId)}#detail">Details</a>`
      : `${phone ? `<a class="fo-btn" href="tel:${e(phone)}">${ownerIcon("phone")}Call back</a>` : `<a class="fo-btn" href="${link(view, task.callId)}#detail">Open</a>`}<form method="post" action="/app/calls/${encodeURIComponent(task.callId)}/task/complete">${csrfField}<button class="fo-ghost" aria-label="Mark ${e(call?.fields.callerName ?? "call")} handled">${ownerIcon("check")}Done</button></form><details class="fo-later"><summary class="fo-ghost">Later</summary><form method="post" action="/app/calls/${encodeURIComponent(task.callId)}/task/snooze">${csrfField}<button name="minutes" value="60">In 1 hour</button><button name="minutes" value="240">In 4 hours</button><button name="minutes" value="1440">Tomorrow</button></form></details>`;
    return `<article class="fo-job ${badge.cls}"><a class="fo-job-main" href="${link(view, task.callId)}#detail"><span class="fo-job-top"><strong>${e(call?.fields.callerName ?? "Unknown caller")}</strong><span class="fo-pill ${badge.cls}">${badge.label}</span></span><span class="fo-job-problem">${e(call?.fields.problemDescription || ownerTaskReason(task.reason))}</span><span class="fo-job-meta">${e(ownerTaskReason(task.reason))}${meta ? ` · ${e(meta)}` : ""}</span></a><div class="fo-job-actions">${actions}</div></article>`;
  };
  const selected = callsById.get(input.selectedCallId ?? "") ?? null;
  const detailCall = selected ?? callsById.get(actionable[0]?.callId ?? "") ?? input.calls[0] ?? null;
  const detail = (call: CallRecord | null, standalone: boolean): string => {
    if (!call) return `<section class="fo-card fo-detail-empty"><h2>No calls yet</h2><p>When Call Otto answers, the caller, problem and next step show up here.</p></section>`;
    const phone = phoneFor(call);
    const address = call.fields.address?.trim() || null;
    const task = input.tasks.find((item) => item.callId === call.id);
    const badge = urgency(task, call);
    const facts: Array<[string, string]> = [
      ["Phone", phone ? formatPhone(phone) : "Not confirmed"],
      ["Address", address ?? "Not confirmed"],
      ["Called", compactDate(call.startedAt, tz)],
      ...(call.fields.requestedStart ? [[call.outcome === "booked" ? "Booked for" : "Asked for", compactDate(call.fields.requestedStart, tz)] as [string, string]] : []),
      ...(call.fields.equipmentDetails ? [["Equipment", call.fields.equipmentDetails] as [string, string]] : []),
      ...(call.fields.accessNotes ? [["Access", call.fields.accessNotes] as [string, string]] : []),
    ];
    return `<section id="detail" class="fo-card fo-detail ${standalone ? "standalone" : ""}">${standalone ? `<a class="fo-back" href="${link(view)}">${ownerIcon("back")}Back</a>` : ""}<div class="fo-detail-head"><div><h2>${e(call.fields.callerName ?? "Unknown caller")}</h2><p>${e(call.fields.problemDescription || "No problem summary captured")}</p></div><span class="fo-pill ${badge.cls}">${badge.label}</span></div>${call.emergency?.immediateInstruction ? `<p class="fo-safety">${ownerIcon("alert")}${e(call.emergency.immediateInstruction)}</p>` : ""}<div class="fo-detail-actions">${phone ? `<a class="fo-btn" href="tel:${e(phone)}">${ownerIcon("phone")}Call back</a><a class="fo-ghost" href="sms:${e(phone)}">Text</a>` : ""}${address ? `<a class="fo-ghost" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(address)}" target="_blank" rel="noreferrer">${ownerIcon("map")}Map</a>` : ""}</div><dl class="fo-facts">${facts.map(([key, value]) => `<div><dt>${e(key)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl><details class="fo-transcript"><summary>Read the call</summary><p>${e(call.transcript ?? "Transcript unavailable")}</p></details>${preview ? "" : `<a class="fo-link" href="/app/calls/${encodeURIComponent(call.id)}">Full record, recording &amp; delete</a>`}</section>`;
  };
  const callRow = (call: CallRecord): string => {
    const badge = urgency(input.tasks.find((task) => task.callId === call.id), call);
    return `<a class="fo-row ${detailCall?.id === call.id ? "selected" : ""}" href="${link(view, call.id)}#detail"><span><strong>${e(call.fields.callerName ?? "Unknown caller")}</strong><small>${e(call.fields.problemDescription || "No summary")}</small></span><span class="fo-row-end"><time>${e(compactDate(call.startedAt, tz))}</time><span class="fo-dot ${badge.cls}" aria-label="${badge.label}"></span></span></a>`;
  };
  const appointmentRow = (call: CallRecord): string => `<a class="fo-row" href="${link("calendar", call.id)}#detail"><span><strong>${e(timeOnly(call.fields.requestedStart!, tz))} · ${e(dayLabel(call.fields.requestedStart!, tz, nowMs))}</strong><small>${e(call.fields.callerName ?? "Unknown caller")} · ${e(call.fields.problemDescription || "Service visit")}</small></span><span class="fo-pill ${call.outcome === "booked" ? "good" : "warn"}">${call.outcome === "booked" ? "Booked" : "Confirm"}</span></a>`;
  const usage = `<section class="fo-card fo-usage"><div class="fo-usage-head"><h2>Calls left</h2><strong>${remaining}</strong></div><div class="fo-meter" role="img" aria-label="${used} of ${included} included calls answered"><span style="width:${Math.min(100, Math.round((used / Math.max(1, included)) * 100))}%"></span></div><p>${used} of ${included} calls answered this period</p>${extra ? `<p><strong>Extra calls this month: ${extra} × ${perCall(input.config.overageCentsPerCall)}</strong>, billed after the month ends.</p>` : ""}<p>${USAGE_EXCLUSION_NOTE}</p>${!preview && owner && paid && !isCompStatus(input.subscription?.status) ? `<form method="post" action="/app/billing/portal">${csrfField}<button class="fo-link">Manage billing or cancel</button></form>` : ""}</section>`;
  const stats = `<div class="fo-stats" aria-label="Shop overview"><div class="fo-stat ${urgentCount ? "hot" : ""}"><span>To call back</span><strong>${actionable.length}</strong>${urgentCount ? `<em class="fo-badge danger">${urgentCount} urgent</em>` : ""}<small>${actionable.length ? "Callers waiting on you" : "You’re all caught up"}</small></div><div class="fo-stat"><span>Booked</span><strong>${booked.length}</strong><small>Next 7 days</small></div><div class="fo-stat"><span>Calls left</span><strong>${remaining}</strong><small>${used} of ${included} answered</small></div></div>`;

  // ---- views -----------------------------------------------------------------
  const queue = actionable.length
    ? actionable.map(taskCard).join("")
    : `<div class="fo-empty"><img src="/assets/front-office-mascot-flat.png" alt="" width="96" height="101"><strong>You’re all caught up.</strong><span>New emergencies, callbacks and times to confirm show up here automatically.</span></div>`;
  const recent = input.calls.slice(0, 8).map(callRow).join("") || `<p class="fo-muted">No calls yet. Your first answered call shows up here.</p>`;
  const coming = upcoming.slice(0, 4).map(appointmentRow).join("") || `<p class="fo-muted">Nothing scheduled in the next 7 days.</p>`;
  const todayMain = `${setup}${forwarding}${stats}<section id="inbox" class="fo-section"><header><h2>Needs your attention</h2><span class="fo-count">${actionable.length}</span></header>${queue}</section><section class="fo-section"><header><h2>Coming up</h2><a href="${link("calendar")}">Calendar</a></header><div class="fo-card fo-list">${coming}</div></section><section id="recent-calls" class="fo-section"><header><h2>Recent calls</h2><a href="${link("pipeline")}">All jobs</a></header><div class="fo-card fo-list">${recent}</div></section><section class="fo-section"><header><h2>Recent activity</h2></header><div class="fo-card fo-list">${activity(input.calls, completed, callsById, tz)}</div></section>${usage}`;

  const column = (title: string, items: string, empty: string, count: number): string => `<section class="fo-col"><header><h2>${e(title)}</h2><span class="fo-count">${count}</span></header>${items || `<p class="fo-muted">${e(empty)}</p>`}</section>`;
  const jobCard = (call: CallRecord | undefined, label: string, cls: string, meta: string): string => call ? `<a class="fo-mini ${cls}" href="${link("pipeline", call.id)}#detail"><span><strong>${e(call.fields.callerName ?? "Unknown caller")}</strong><span class="fo-pill ${cls}">${e(label)}</span></span><small>${e(call.fields.problemDescription || "No summary")}</small><time>${e(meta)}</time></a>` : "";
  const handled = completed.filter((task) => callsById.get(task.callId)?.outcome !== "booked").slice(0, 10);
  const pipelineMain = `<section class="fo-section"><header><h2>Every job at a glance</h2></header><div class="fo-board">${column("Needs reply", actionable.map((task) => jobCard(callsById.get(task.callId), task.priority === "high" ? "Urgent" : "Call back", task.priority === "high" ? "danger" : "", ownerTaskReason(task.reason))).join(""), "Nothing needs a reply.", actionable.length)}${column("Waiting", snoozed.map((task) => jobCard(callsById.get(task.callId), "Later", "", `Back ${compactDate(task.dueAt, tz)}`)).join(""), "Nothing snoozed.", snoozed.length)}${column("Booked", booked.map((call) => jobCard(call, "Booked", "good", compactDate(call.fields.requestedStart!, tz))).join(""), "No upcoming bookings.", booked.length)}${column("Handled", handled.map((task) => jobCard(callsById.get(task.callId), "Handled", "", compactDate(task.completedAt ?? task.updatedAt, tz))).join(""), "Nothing handled yet.", handled.length)}</div></section>`;

  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(nowMs + index * 86_400_000);
    const key = dateKey(day, tz);
    const items = upcoming.filter((call) => dateKey(new Date(call.fields.requestedStart!), tz) === key);
    return `<section class="fo-day ${index === 0 ? "today" : ""}"><header><strong>${e(index === 0 ? "Today" : new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(day))}</strong><span>${e(new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(day))}</span></header>${items.map((call) => `<a class="fo-event ${call.outcome === "booked" ? "good" : "warn"}" href="${link("calendar", call.id)}#detail"><strong>${e(timeOnly(call.fields.requestedStart!, tz))}</strong><span>${e(call.fields.callerName ?? "Unknown caller")}</span><small>${call.outcome === "booked" ? "Booked" : "Awaiting your confirmation"}</small></a>`).join("") || `<span class="fo-muted">Open</span>`}</section>`;
  }).join("");
  const calendarMain = `<section class="fo-section"><header><h2>Next seven days</h2></header><div class="fo-week">${days}</div></section>`;

  const main = view === "today" ? todayMain : view === "pipeline" ? pipelineMain : calendarMain;
  // On a phone a chosen call opens on its own screen; on wide screens it sits beside the list.
  // Boards use the full width; the call panel appears beside them only once a call is chosen.
  const body = selected
    ? `${banners.join("")}<div class="fo-split has-selection"><div class="fo-primary">${main}</div><aside class="fo-aside">${detail(selected, true)}</aside></div>`
    : view === "today"
      ? `${banners.join("")}<div class="fo-split"><div class="fo-primary">${main}</div><aside class="fo-aside">${detail(detailCall, false)}</aside></div>`
      : `${banners.join("")}${main}`;
  return ownerShell({
    title: view === "today" ? "Calls" : view === "pipeline" ? "Jobs" : "Calendar",
    view,
    businessName: input.config.businessName,
    status: preview ? { tone: "on", label: "Answering calls" } : coverageStatus(input.account, input.config),
    body,
    base,
    needsAttention: actionable.length,
    preview,
  });
}

/** The owner's full record of one call, in the app shell. */
export function renderOwnerCallRecord(input: {
  account: OwnerAccount;
  config: BusinessConfig;
  call: CallRecord;
  booking: BookingRecord | null;
  callbackTask: CallbackTask | null;
  notifications: OutboxNotification[];
  recordingUrl: string | null;
  csrf: string;
  canDelete: boolean;
  path: CallPath | null;
}): string {
  const call = input.call;
  const tz = input.config.timezone;
  const phoneRaw = call.fields.callbackNumber ?? call.fromNumber;
  const phone = /^\+[1-9]\d{7,14}$/.test(phoneRaw) ? phoneRaw : null;
  const address = call.fields.address?.trim() || null;
  const csrfField = `<input type="hidden" name="csrf" value="${e(input.csrf)}">`;
  const task = input.callbackTask;
  const taskActions = task && task.status !== "completed" && task.status !== "cancelled"
    ? `<form method="post" action="/app/calls/${encodeURIComponent(call.id)}/task/complete">${csrfField}<button class="fo-ghost">${ownerIcon("check")}Mark handled</button></form>`
    : task?.status === "completed" ? `<form method="post" action="/app/calls/${encodeURIComponent(call.id)}/task/reopen">${csrfField}<button class="fo-ghost">Reopen</button></form>` : "";
  const facts: Array<[string, string]> = [
    ["Phone", phone ? formatPhone(phone) : "Not confirmed"],
    ["Address", address ?? "Not confirmed"],
    ["Called", compactDate(call.startedAt, tz)],
    ["Length", call.durationSeconds ? `${Math.max(1, Math.round(call.durationSeconds / 60))} min` : "Unknown"],
    ["Category", call.fields.serviceCategory ?? "Not classified"],
    ["Outcome", outcomeWords(call.outcome)],
    ...(input.booking?.requestedStart ? [[input.booking.status === "confirmed" ? "Booked for" : "Asked for", compactDate(input.booking.requestedStart, tz)] as [string, string]] : []),
    ...(call.fields.equipmentDetails ? [["Equipment", call.fields.equipmentDetails] as [string, string]] : []),
    ...(call.fields.accessNotes ? [["Access", call.fields.accessNotes] as [string, string]] : []),
    ...(task ? [["Follow-up", `${e(ownerTaskReason(task.reason))} · ${task.status === "completed" ? "handled" : `due ${compactDate(task.dueAt, tz)}`}`] as [string, string]] : []),
  ];
  const alerts = input.notifications.filter((item) => item.channel === "sms").map((item) => `<li><span>${item.priority === "high" ? "Urgent text" : "Text"}</span><span>${e(notificationWords(item.state))}</span></li>`).join("");
  const body = `<section class="fo-card fo-detail standalone"><a class="fo-back" href="/app">${ownerIcon("back")}Back</a><div class="fo-detail-head"><div><h2>${e(call.fields.callerName ?? "Unknown caller")}</h2><p>${e(call.fields.problemDescription || "No problem summary captured")}</p></div><span class="fo-pill ${call.emergency?.emergency ? "danger" : call.outcome === "booked" ? "good" : ""}">${e(call.emergency?.severity === "life_safety" ? "Emergency" : call.emergency?.emergency ? "Urgent" : outcomeWords(call.outcome))}</span></div>${call.emergency?.immediateInstruction ? `<p class="fo-safety">${ownerIcon("alert")}${e(call.emergency.immediateInstruction)}</p>` : ""}<div class="fo-detail-actions">${phone ? `<a class="fo-btn" href="tel:${e(phone)}">${ownerIcon("phone")}Call back</a><a class="fo-ghost" href="sms:${e(phone)}">Text</a>` : ""}${address ? `<a class="fo-ghost" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(address)}" target="_blank" rel="noreferrer">${ownerIcon("map")}Map</a>` : ""}${taskActions}</div>${input.path ? renderCallPath(call.id, input.path) : ""}<dl class="fo-facts">${facts.map(([key, value]) => `<div><dt>${e(key)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl>${input.recordingUrl ? `<a class="fo-ghost wide" href="${e(input.recordingUrl)}" rel="noreferrer">${ownerIcon("play")}Play recording</a>` : ""}<details class="fo-transcript" open><summary>Read the call</summary><p>${e(call.transcript ?? "Transcript unavailable")}</p></details>${alerts ? `<h3>Alerts sent</h3><ul class="fo-alerts">${alerts}</ul>` : ""}</section>${input.canDelete ? `<details class="fo-card fo-danger-zone"><summary>Delete this call record</summary><form method="post" action="/app/calls/${encodeURIComponent(call.id)}/delete">${csrfField}<p>This permanently removes the call record, transcript, recording, callback, tool events, notifications, and any customer record whose latest call is this one. Appointments already on your calendar stay on your calendar.</p><label class="fo-check"><input name="confirm" type="checkbox" value="delete" required> I understand this can’t be undone.</label><button class="fo-btn danger">Delete permanently</button></form></details>` : ""}`;
  return ownerShell({
    title: "Call",
    view: "call",
    businessName: input.config.businessName,
    status: coverageStatus(input.account, input.config),
    body,
    base: "/app",
    needsAttention: 0,
  });
}

/**
 * Otto's path through the call: every checkpoint, checked off as the server records it. While the call is
 * live, /app/call-path.js swaps in a fresh copy every two seconds so the owner watches it tick.
 */
export function renderCallPath(callId: string, path: CallPath): string {
  const clock = (at: string): string => {
    const seconds = Math.max(0, Math.round((Date.parse(at) - Date.parse(path.startedAt)) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const mark: Record<CallPathStep["state"], string> = { done: ownerIcon("check"), waiting: ownerIcon("clock"), flagged: ownerIcon("alert"), current: "<i></i>", todo: "", skipped: "" };
  const words: Record<CallPathStep["state"], string> = { done: "done", waiting: "waiting on you", flagged: "needs attention", current: "happening now", todo: "not yet", skipped: "skipped" };
  const item = (step: CallPathStep<string>, index: number | null): string =>
    `<li class="${step.state}"><span class="fo-path-mark" aria-hidden="true">${mark[step.state] || (index === null ? "" : String(index + 1))}</span><span class="fo-path-text"><strong>${e(step.label)}</strong>${step.note ? `<small>${e(step.note)}</small>` : ""}</span><span class="fo-path-time">${step.at && (step.state === "done" || step.state === "waiting" || step.state === "flagged") ? `<time datetime="${e(step.at)}">${clock(step.at)}</time>` : `<span class="fo-sr">${words[step.state]}</span>`}</span></li>`;
  const live = path.live ? ` data-live-path="/app/calls/${encodeURIComponent(callId)}/path"` : "";
  return `<section class="fo-path${path.live ? " live" : ""}"${live} aria-label="Otto's path through this call"><div class="fo-path-head"><h3>Otto’s path</h3><span>${path.live ? '<i></i>Live · ' : ""}${path.done} of ${path.steps.length}</span></div><ol>${path.steps.map((step, index) => item(step, index)).join("")}</ol>${path.extras.length ? `<p class="fo-path-any">Also came up</p><ul>${path.extras.map((step) => item(step, null)).join("")}</ul>` : ""}${path.live ? '<script src="/app/call-path.js" defer></script>' : ""}</section>`;
}

/** Polls the live path while the call is on; reloads once when it ends so the full record shows. */
export const CALL_PATH_SCRIPT = `(() => {
  let failures = 0;
  let timer = 0;
  const section = () => document.querySelector("[data-live-path]");
  const stop = (words) => {
    const current = section();
    if (!current) return;
    current.removeAttribute("data-live-path");
    current.classList.remove("live");
    const badge = current.querySelector(".fo-path-head span");
    if (badge) badge.textContent = words;
  };
  const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(tick, ms); };
  const tick = async () => {
    const current = section();
    if (!current) return;
    if (document.hidden) return;
    try {
      const response = await fetch(current.getAttribute("data-live-path"), { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401 || response.status === 403 || response.status === 404) return stop("Refresh for the latest");
      if (response.status === 429) {
        const wait = Number(response.headers.get("retry-after"));
        return schedule(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 10000);
      }
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      failures = 0;
      if (!data.live) return location.reload();
      const holder = document.createElement("div");
      holder.innerHTML = data.html;
      const next = holder.querySelector("[data-live-path]");
      if (next) current.replaceWith(next);
      schedule(2000);
    } catch {
      failures += 1;
      if (failures >= 5) return stop("Refresh for the latest");
      schedule(Math.min(30000, 2000 * 2 ** failures));
    }
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(0); });
  schedule(2000);
})();
`;

/** Owner settings: grouped, plain-language, phone first. Field names match configFromForm. */
export function renderOwnerSettings(input: {
  account: OwnerAccount;
  config: BusinessConfig;
  subscription: SubscriptionRecord | null;
  csrf: string;
  integrations: { googleAvailable: boolean; googleConnected: boolean; ownerPhoneConfigured: boolean; weeklyEmailAvailable?: boolean; directBookingAvailable?: boolean };
  saved?: boolean;
  /** Signed in within the last 10 minutes: what an account without a password needs to delete. */
  recentSignIn?: boolean;
}): string {
  const c = input.config;
  const i = input.integrations;
  const csrfField = `<input type="hidden" name="csrf" value="${e(input.csrf)}">`;
  const checked = (value: boolean): string => value ? " checked" : "";
  const selected = (value: boolean): string => value ? " selected" : "";
  const zones = [["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona"], ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"]];
  if (!zones.some(([zone]) => zone === c.timezone)) zones.unshift([c.timezone, c.timezone]);
  const hourOptions = Array.from({ length: 24 }, (_, hour) => `<option value="${hour}"${selected(c.ownerDailySmsHour === hour)}>${new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, hour)))}</option>`).join("");
  const leadOptions = [[0, "No minimum"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [1440, "Next day"], [2880, "2 days"]];
  if (!leadOptions.some(([value]) => value === c.minimumLeadTimeMinutes)) leadOptions.push([c.minimumLeadTimeMinutes, `${c.minimumLeadTimeMinutes} minutes`]);
  const addOn = (name: string, enabled: boolean, available: boolean | undefined, title: string, price: string, text: string): string =>
    `<label class="fo-option"><input type="checkbox" name="${name}"${checked(enabled)}${available ? "" : " disabled"}><span><strong>${title} <em>${price}</em></strong><small>${text}</small>${available ? "" : "<small class=\"fo-warn\">Not available yet.</small>"}</span></label>`;
  const googleDataLink = `<p class="fo-muted"><a href="/privacy#google-calendar">How Call Otto uses Google Calendar data</a></p>`;
  const calendar = i.googleConnected
    ? `<p class="fo-ok">${ownerIcon("check")}Google Calendar connected</p><a class="fo-ghost" href="/app/integrations/google/start">Reconnect</a>${googleDataLink}`
    : i.googleAvailable ? `<p>Connect the calendar your jobs live on so Call Otto can offer real open times.</p><a class="fo-btn" href="/app/integrations/google/start">Connect Google Calendar</a>${googleDataLink}` : `<p class="fo-muted">Calendar connection isn’t available yet.</p>`;
  const paid = hasPlanAccess(input.subscription?.status);
  const form = `<form class="fo-form" method="post" action="/app/config">${csrfField}<input type="hidden" name="flatMonthlyPrice" value="${Math.round(c.flatMonthlyPriceCents / 100)}">
<section class="fo-card fo-group"><h2>Answering</h2>
<label>Call Otto is<select name="serviceState"><option value="active"${selected(!c.paused)}>On, answering calls</option><option value="paused"${selected(c.paused)}>Paused</option></select></label>${input.account.status === "active" ? "" : `<p class="fo-hint">Your line turns on after activation. Until then it stays paused.</p>`}
<label>Answer<select name="operationMode"><option value="overflow"${selected(c.operationMode === "overflow")}>Only calls I miss</option><option value="after_hours"${selected(c.operationMode === "after_hours")}>After hours</option><option value="always"${selected(c.operationMode === "always")}>Every call</option></select></label>
<div class="fo-grid2"><label>Ring my phone first<select name="answerAfterRings">${ringChoicesWith(c.answerAfterRings).map((choice) => `<option value="${choice.rings}"${selected(c.answerAfterRings === choice.rings)}>${e(choice.label)}</option>`).join("")}</select></label><label class="fo-check"><input type="checkbox" name="weekends"${checked(c.afterHours.weekends)}> Answer all weekend</label></div>
<div class="fo-grid2"><label>After hours start<input type="time" name="weekdayStart" value="${e(c.afterHours.weekdayStart)}"></label><label>After hours end<input type="time" name="weekdayEnd" value="${e(c.afterHours.weekdayEnd)}"></label></div>
<label>Holidays to cover (YYYY-MM-DD, comma separated)<input name="holidayDates" value="${e(c.afterHours.holidayDates.join(", "))}" placeholder="2026-12-25"></label></section>
<section class="fo-card fo-group"><h2>Your shop</h2>
<div class="fo-grid2"><label>Business name<input name="businessName" value="${e(c.businessName)}" required></label><label>Time zone<select name="timezone">${zones.map(([zone, label]) => `<option value="${e(zone!)}"${selected(zone === c.timezone)}>${e(label!)}</option>`).join("")}</select></label></div>
<label>Greeting<textarea name="greeting" rows="2" required>${e(c.greeting)}</textarea></label>
<label class="fo-check"><input type="checkbox" name="recordingNotice"${checked(c.recordingDisclosure.trim().length > 0)}> Recording notice on transfers</label><p class="fo-hint">Off: just your greeting, calls saved with audio. On: nothing extra up front, transcript only (no audio), and callers hear “Calls may be recorded.” only if they’re put through to you. Your state’s rules, your call.</p></section>
<section class="fo-card fo-group"><h2>Where and what you work on</h2>
<label>Cities and ZIP codes<textarea name="serviceAreaTerms" rows="2" placeholder="Sarasota FL, 34236">${e(c.serviceAreaTerms.join(", "))}</textarea></label><p class="fo-hint">A city with its state (“Sarasota FL”) or a 5-digit ZIP. No guessed radius.</p>
<label>Services you offer<textarea name="serviceCategories" rows="2">${e(c.serviceCategories.join(", "))}</textarea></label></section>
<section class="fo-card fo-group"><h2>Appointments</h2>
<div class="fo-grid2"><label>First appointment<input type="time" name="bookableWeekdayStart" value="${e(c.bookableHours.weekdayStart)}"></label><label>Last one ends by<input type="time" name="bookableWeekdayEnd" value="${e(c.bookableHours.weekdayEnd)}"></label></div>
<div class="fo-grid2"><label>Job length<select name="defaultServiceDurationMinutes">${[30, 45, 60, 90, 120, 180, 240].concat([c.defaultServiceDurationMinutes]).filter((value, index, all) => all.indexOf(value) === index).sort((left, right) => left - right).map((minutes) => `<option value="${minutes}"${selected(c.defaultServiceDurationMinutes === minutes)}>${minutes < 60 ? `${minutes} min` : `${minutes / 60} hr${minutes === 60 ? "" : "s"}`}</option>`).join("")}</select></label><label>Notice needed<select name="minimumLeadTimeMinutes">${leadOptions.map(([value, label]) => `<option value="${value}"${selected(c.minimumLeadTimeMinutes === value)}>${label}</option>`).join("")}</select></label></div>
<label class="fo-check"><input type="checkbox" name="bookableWeekends"${checked(c.bookableHours.weekends)}> Offer weekend appointments</label>
${i.directBookingAvailable ? `<label>Booking<select name="bookingMode"><option value="confirm"${selected(c.bookingMode === "confirm")}>Take the details; I’ll confirm</option><option value="direct"${selected(c.bookingMode === "direct")}>Book open times on my calendar</option></select></label>` : `<input type="hidden" name="bookingMode" value="confirm"><p class="fo-hint">Call Otto takes the time the caller wants. You confirm it.</p>`}
<label class="fo-check"><input type="checkbox" name="requireDiagnosticFeeAcceptance"${checked(c.requireDiagnosticFeeAcceptance)}> Caller must accept your service-call fee</label></section>
<section class="fo-card fo-group"><h2>What callers can be told</h2>
<label>Prices (one per line, “Name: exact wording”)<textarea name="priceSnippets" rows="3" placeholder="Service call: Our service call is $89.">${e(c.priceSnippets.map((item) => `${item.label}: ${item.text}`).join("\n"))}</textarea></label>
<label>Answers (one per line, “Topic: exact wording”)<textarea name="approvedKnowledge" rows="3" placeholder="Brands: We service all major brands.">${e(c.approvedKnowledge.map((item) => `${item.topic}: ${item.text}`).join("\n"))}</textarea></label><p class="fo-hint">Leave blank and Call Otto won’t quote a price; it takes a message.</p></section>
<section class="fo-card fo-group"><h2>Alerts to your phone</h2>
<label>Mobile number<input type="tel" name="ownerPhone" inputmode="tel" autocomplete="tel" placeholder="${i.ownerPhoneConfigured ? "Saved. Enter a new number to replace it" : "+1 941 555 0100"}"></label><p class="fo-hint">Emergency calls (if on) and text alerts (once texts are on) come here.</p>
${addOn("ownerDailySmsEnabled", c.ownerDailySmsEnabled, true, "Daily text recap", "Included", "Follow-ups and appointments, once each morning.")}
<label>Recap time<select name="ownerDailySmsHour">${hourOptions}</select></label>
${addOn("ownerRealtimeSmsEnabled", c.ownerRealtimeSmsEnabled, true, "Instant lead texts", "Included", "Every routine new lead the moment the call ends.")}
${addOn("ownerWeeklyEmailEnabled", c.ownerWeeklyEmailEnabled, i.weeklyEmailAvailable, "Sunday week-ahead email", "Included", "Open callbacks and the next seven days.")}
<label>Calls alert<select name="usageAlertPercent">${usageAlertOptions(c.usageAlertPercent).map((percent) => `<option value="${percent}"${selected(c.usageAlertPercent === percent)}>When I’ve used ${percent}%</option>`).join("")}</select></label><p class="fo-hint">We tell you once when you reach this share of your ${c.includedCalls} calls, and again if you use them all.</p></section>
<details class="fo-card fo-group fo-advanced"><summary>Advanced</summary>
<label>Extra emergency words (comma separated)<textarea name="emergencyKeywords" rows="2">${e(c.emergencyKeywords.join(", "))}</textarea></label>
<div class="fo-grid2"><label>Emergency sensitivity<select name="emergencyThreshold">${[[0.5, "Most cautious"], [0.6, "Cautious"], [0.7, "Balanced"], [0.8, "Strict"], [0.9, "Strictest"]].map(([value, label]) => `<option value="${value}"${selected(Math.abs(c.emergencyThreshold - (value as number)) < 0.001)}>${label}</option>`).join("")}</select></label><label>Calls per number per day<select name="maxCallsPerCallerPerDay">${[1, 2, 3, 5, 8, 10, 20].concat([c.maxCallsPerCallerPerDay]).filter((value, index, all) => all.indexOf(value) === index).sort((left, right) => left - right).map((value) => `<option value="${value}"${selected(c.maxCallsPerCallerPerDay === value)}>${value}</option>`).join("")}</select></label></div>
<label>Say these words like this (one per line, “Word: sounds like”)<textarea name="pronunciations" rows="2">${e(c.pronunciations.map((item) => `${item.term}: ${item.spokenAs}`).join("\n"))}</textarea></label>
<div class="fo-grid2"><label>Keep call records for<select name="dataRetentionDays">${[30, 60, 90, 180, 365].concat([c.dataRetentionDays]).filter((value, index, all) => all.indexOf(value) === index).sort((left, right) => left - right).map((days) => `<option value="${days}"${selected(c.dataRetentionDays === days)}>${days} days</option>`).join("")}</select></label><label>Support email for your callers<input type="email" name="supportEmail" value="${e(c.supportEmail ?? "")}"></label></div></details>
<div class="fo-savebar"><button class="fo-btn wide">Save changes</button></div></form>`;
  const body = `${input.saved ? `<div class="fo-note ok" role="status"><strong>Saved.</strong></div>` : ""}<div class="fo-settings">${form}<aside class="fo-settings-side"><section class="fo-card fo-group"><h2>Calendar</h2>${calendar}</section><section class="fo-card fo-group"><h2>Plan</h2><p>${money(c.flatMonthlyPriceCents)}/month · ${c.includedCalls} answered calls${c.unlimitedCalls ? ` · Unlimited calls on (fair use up to ${fairUseCalls(c.includedCalls)})` : ""} · ${perCall(c.overageCentsPerCall)} per extra call</p>${isCompStatus(input.subscription?.status) ? "" : paid ? `<form method="post" action="/app/billing/portal">${csrfField}<button class="fo-ghost wide">Manage billing or cancel</button></form>` : `<form method="post" action="/app/billing/checkout">${csrfField}<button class="fo-btn wide">Start your plan</button></form>`}</section><section class="fo-card fo-group"><h2>Team</h2><a class="fo-ghost wide" href="/app/team">Teammates &amp; calendars</a></section><section class="fo-card fo-group"><h2>Your data</h2><a class="fo-ghost wide" href="/app/account/export">Download everything</a><form method="post" action="/app/account/sign-out-everywhere">${csrfField}<button class="fo-ghost wide">Sign out on every device</button></form><a class="fo-link" href="/logout">Sign out</a><details class="fo-danger-zone"><summary>Delete your account</summary><form method="post" action="/app/account/delete">${csrfField}<p>Cancel your plan first. This disconnects your line and permanently deletes every call record, transcript, recording, task and setting. Appointments on your calendar stay there.</p>${isPasswordless(input.account.passwordHash) && !input.recentSignIn ? `<p>For your safety, <a class="fo-link" href="/login?next=%2Fapp%2Fsettings">sign in again</a>, then delete within 10 minutes.</p>` : `<label>Type DELETE to confirm<input name="confirm" autocomplete="off" required></label>${!isPasswordless(input.account.passwordHash) ? `<label>Your password<input name="password" type="password" autocomplete="current-password" required></label>` : ""}<button class="fo-btn danger">Delete my account</button>`}</form></details></section></aside></div>`;
  return ownerShell({ title: "Settings", view: "settings", businessName: c.businessName, status: coverageStatus(input.account, c), body, base: "/app", needsAttention: 0 });
}

function forwardingCard(lineNumber: string, mode: "overflow" | "after_hours" | "always", open: boolean): string {
  const rows = forwardingInstructions(lineNumber, mode).map((row) => `<div><dt>${e(row.carrier)}</dt><dd><code>${e(row.on)}</code> <small>off: <code>${e(row.off)}</code></small></dd></div>`).join("");
  return `<details class="fo-card fo-forward"${open ? " open" : ""}><summary><span><small>Your Call Otto number</small><strong>${e(formatPhone(lineNumber))}</strong></span><span class="fo-badge">Forward your calls</span></summary><p>Keep your business number. On your business phone, dial your carrier’s code and press call. ${mode === "always" ? "Every call" : "Calls you don’t pick up"} will ring through to Call Otto.</p><dl class="fo-facts">${rows}</dl><p class="fo-fine">To test: call your business number from another phone and let it ring. Office phone systems (RingCentral, Google Voice, Ooma) set this under call forwarding or “when unanswered”.</p></details>`;
}

function activity(calls: CallRecord[], completed: CallbackTask[], callsById: Map<string, CallRecord>, tz: string): string {
  const items = [
    ...calls.filter((call) => call.endedAt).map((call) => ({ at: call.endedAt!, text: call.outcome === "booked" ? `Booked ${call.fields.callerName ?? "a caller"}` : `Answered ${call.fields.callerName ?? "a caller"}` })),
    ...completed.map((task) => ({ at: task.completedAt ?? task.updatedAt, text: task.completionSource === "verified_booking" ? "Closed after a verified booking" : `Marked ${callsById.get(task.callId)?.fields.callerName ?? "a call"} handled` })),
  ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 5);
  return items.map((item) => `<div class="fo-row static"><span>${e(item.text)}</span><time>${e(compactDate(item.at, tz))}</time></div>`).join("") || `<p class="fo-muted">No activity yet.</p>`;
}

function outcomeWords(outcome: CallRecord["outcome"]): string {
  return ({ in_progress: "On the call", booked: "Booked", pending_confirmation: "Needs your OK", handoff_queued: "Call back", ignored_spam: "Spam", failed: "Failed" } as Record<string, string>)[outcome] ?? outcome;
}

function notificationWords(state: OutboxNotification["state"]): string {
  return ({ pending: "Queued", sending: "Sending", sent: "Sent", delivered: "Delivered", delivery_failed: "Not delivered", delivery_unconfirmed: "Sent, not confirmed", retry: "Retrying", dead: "Failed" } as Record<string, string>)[state] ?? state;
}

function formatPhone(phone: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}

function compactDate(value: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function timeOnly(value: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function dateKey(value: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

function dayLabel(value: string, tz: string, nowMs: number): string {
  const key = dateKey(new Date(value), tz);
  if (key === dateKey(new Date(nowMs), tz)) return "Today";
  if (key === dateKey(new Date(nowMs + 86_400_000), tz)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(value));
}

export function ownerIcon(name: string): string {
  const paths: Record<string, string> = {
    today: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    jobs: '<rect x="3" y="4" width="6" height="16" rx="2"/><rect x="15" y="4" width="6" height="10" rx="2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    map: '<path d="M12 21s-7-6.3-7-11a7 7 0 0 1 14 0c0 4.7-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ""}</svg>`;
}

const OWNER_CSS = `
:root{color-scheme:light;--ink:#0b2545;--blue:#064c95;--yellow:#e9f447;--red:#df3626;--green:#1f7a4d;--amber:#b25e09;--paper:#faf8f1;--card:#fff;--line:#e4e0d4;--muted:#5d6676;--tap:48px;--r:14px}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body.fo-body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--blue)}h1,h2,h3,p{margin:0}em{font-family:Georgia,serif;font-style:italic;font-weight:500}
button{font:inherit;cursor:pointer}svg{width:20px;height:20px;flex:none}
.fo{min-height:100dvh}
.fo-side{display:none}
.fo-main{min-width:0;padding-bottom:calc(76px + env(safe-area-inset-bottom))}
.fo-top{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 16px 10px;background:rgba(250,248,241,.94);backdrop-filter:saturate(1.4) blur(12px);-webkit-backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid var(--line)}
.fo-top-name{display:flex;align-items:center;gap:10px;min-width:0}
.fo-top-name>span:last-child{display:grid;min-width:0}
.fo-top-name small{color:var(--muted);font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fo-top-name strong{font-size:20px;line-height:1.1;font-weight:800;letter-spacing:-.02em}
.fo-mark,.fo-brand span{display:grid;place-items:center;width:34px;height:34px;border:1.5px solid var(--ink);border-radius:9px;background:var(--yellow);color:var(--ink);font-weight:900;font-size:13px;box-shadow:2px 2px 0 var(--ink);flex:none}
.fo-status{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap}
.fo-status i{width:9px;height:9px;border-radius:50%;background:#9aa3b2}
.fo-status.on i{background:#16a34a;box-shadow:0 0 0 4px #16a34a22}.fo-status.warning i,.fo-status.paused i{background:var(--amber)}.fo-status.pending i{background:#9aa3b2}
.fo-content{display:grid;gap:14px;padding:14px 16px 24px;max-width:1240px;margin:0 auto}
.fo-tabs{position:fixed;z-index:30;left:0;right:0;bottom:0;display:grid;grid-template-columns:repeat(4,1fr);padding:6px max(6px,env(safe-area-inset-left)) calc(6px + env(safe-area-inset-bottom)) max(6px,env(safe-area-inset-right));background:rgba(255,255,255,.97);border-top:1px solid var(--line)}
.fo-tabs a{position:relative;display:grid;justify-items:center;gap:2px;min-height:var(--tap);padding:6px 2px;border-radius:12px;color:var(--muted);font-size:12px;font-weight:700;text-decoration:none}
.fo-tabs a.active{color:var(--ink);background:#f1f4e0}.fo-tabs a.active svg{color:var(--blue)}
.fo-tabs b,.fo-side nav b{position:absolute;top:2px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--red);color:#fff;font-size:11px;line-height:18px}
.fo-card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px}
.fo-note{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:12px 14px;border:1px solid #c9d8ea;border-radius:var(--r);background:#eef4fb;font-size:14px}
.fo-note.danger{border-color:#f0b7ae;background:#fff3f1}.fo-note.ok{border-color:#b8dfc8;background:#effaf3;justify-content:space-between}
.fo-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:var(--tap);padding:0 18px;border:1.5px solid var(--ink);border-radius:10px;background:var(--yellow);color:var(--ink);font-weight:800;text-decoration:none;box-shadow:2px 2px 0 var(--ink);white-space:nowrap}
.fo-btn:active{transform:translate(2px,2px);box-shadow:none}.fo-btn.wide{width:100%}.fo-btn.small{min-height:38px;padding:0 12px;font-size:14px}.fo-btn.danger{background:var(--red);color:#fff}
.fo-ghost{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:var(--tap);padding:0 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font-weight:700;text-decoration:none;white-space:nowrap}
.fo-ghost.wide{width:100%}
.fo-link{border:0;background:none;padding:8px 0;color:var(--blue);font-weight:700;text-decoration:underline;min-height:40px}
.fo-muted{color:var(--muted);font-size:14px;padding:6px 2px}
.fo-fine{margin-top:10px;color:var(--muted);font-size:13px}
.fo-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.fo-stats div{display:grid;gap:2px;padding:12px;border:1px solid var(--line);border-radius:var(--r);background:var(--card)}
.fo-stats div.hot{border-color:#f0b7ae;background:#fff6f4}.fo-stats div.hot strong{color:#a51d0d}.fo-stats strong{font-size:26px;line-height:1;font-weight:800;letter-spacing:-.02em}.fo-stats span{color:var(--muted);font-size:12px;line-height:1.25}
.fo-section{display:grid;gap:10px}
.fo-section>header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 2px 0}
.fo-section h2,.fo-col h2{font-size:18px;font-weight:800;letter-spacing:-.01em}
.fo-section>header a{display:inline-flex;align-items:center;min-height:40px;padding:0 4px;font-size:14px;font-weight:700;text-decoration:none}
.fo-count{display:inline-grid;place-items:center;min-width:28px;height:28px;padding:0 8px;border-radius:14px;background:var(--ink);color:#fff;font-size:13px;font-weight:800}
.fo-job{display:grid;gap:12px;padding:14px;border:1px solid var(--line);border-left:5px solid #c9ced8;border-radius:var(--r);background:var(--card)}
.fo-job.danger{border-left-color:var(--red)}.fo-job.warn{border-left-color:var(--amber)}.fo-job.good{border-left-color:var(--green)}
.fo-job-main{display:grid;gap:4px;color:inherit;text-decoration:none}
.fo-job-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.fo-job-top strong{font-size:18px;font-weight:800}
.fo-job-problem{font-size:15px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.fo-job-meta{color:var(--muted);font-size:13px}
.fo-job-actions{display:flex;flex-wrap:wrap;gap:8px}.fo-job-actions form{display:contents}
.fo-job-actions .fo-btn{flex:1 1 140px}
.fo-later{position:relative}.fo-later summary{list-style:none}.fo-later summary::-webkit-details-marker{display:none}
.fo-later form{position:absolute;right:0;bottom:calc(100% + 6px);z-index:10;display:grid;min-width:170px;padding:6px;border:1px solid var(--line);border-radius:12px;background:var(--card);box-shadow:0 12px 30px #0b254522}
.fo-later form button{min-height:44px;padding:0 12px;border:0;border-radius:8px;background:none;text-align:left;font-weight:600}.fo-later form button:hover{background:var(--paper)}
.fo-pill{display:inline-flex;align-items:center;min-height:24px;padding:0 9px;border-radius:999px;background:#eef0f4;color:var(--ink);font-size:12px;font-weight:800;white-space:nowrap}
.fo-pill.danger{background:#fde6e2;color:#a51d0d}.fo-pill.warn{background:#fdf0dc;color:#8a4705}.fo-pill.good{background:#e1f4e8;color:#17603b}
.fo-dot{width:10px;height:10px;border-radius:50%;background:#c9ced8}.fo-dot.danger{background:var(--red)}.fo-dot.warn{background:var(--amber)}.fo-dot.good{background:var(--green)}
.fo-list{display:grid;padding:4px 0}
.fo-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;padding:10px 16px;color:inherit;text-decoration:none;border-top:1px solid var(--line)}
.fo-row:first-child{border-top:0}.fo-row.selected{background:#f6f8e6}
.fo-row>span:first-child{display:grid;min-width:0}.fo-row strong{font-weight:750}
.fo-row small{color:var(--muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fo-row time{color:var(--muted);font-size:12px;white-space:nowrap}.fo-row-end{display:flex;align-items:center;gap:8px}
.fo-row.static{min-height:46px;font-size:14px}
.fo-empty{display:grid;justify-items:center;gap:6px;padding:22px 16px;border:1.5px dashed #cfd6c0;border-radius:var(--r);background:#fdfdf6;text-align:center}
.fo-empty img{width:88px;height:auto}.fo-empty strong{font-size:18px}.fo-empty span{color:var(--muted);font-size:14px;max-width:320px}
.fo-setup{display:grid;gap:12px;border:1.5px solid var(--ink);box-shadow:3px 3px 0 var(--ink)}
.fo-setup-head{display:flex;justify-content:space-between;gap:12px}.fo-setup h2{font-size:20px;font-weight:800}.fo-setup p{color:var(--muted);font-size:14px}
.fo-ring{display:grid;place-items:center;width:54px;height:54px;border-radius:50%;background:conic-gradient(var(--blue) calc(var(--p)*1%),#e6e9ef 0);font-weight:800;font-size:13px;position:relative;flex:none}
.fo-ring::before{content:"";position:absolute;inset:6px;border-radius:50%;background:var(--card)}.fo-ring{isolation:isolate}.fo-ring::before{z-index:-1}
.fo-steps{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.fo-steps li{display:flex;align-items:center;gap:10px;font-weight:650}.fo-steps li.done{color:var(--muted);text-decoration:line-through}
.fo-steps i{display:grid;place-items:center;width:22px;height:22px;border:1.5px solid var(--ink);border-radius:50%;font-style:normal;font-size:12px;font-weight:900}
.fo-steps li.done i{background:var(--green);border-color:var(--green);color:#fff}
.fo-usage{display:grid;gap:8px}.fo-usage-head{display:flex;align-items:baseline;justify-content:space-between}.fo-usage h2{font-size:16px;font-weight:800}.fo-usage strong{font-size:28px;font-weight:800}
.fo-usage p{color:var(--muted);font-size:13px}
.fo-meter{height:10px;border-radius:5px;background:#e6e9ef;overflow:hidden}.fo-meter span{display:block;height:100%;background:var(--blue);border-radius:5px}
.fo-aside{display:none}
.fo-split.has-selection .fo-primary{display:none}.fo-split.has-selection .fo-aside{display:block}
.fo-detail{display:grid;gap:14px}
.fo-back{display:inline-flex;align-items:center;gap:4px;min-height:40px;font-weight:700;text-decoration:none;justify-self:start}
.fo-detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.fo-detail-head .fo-pill,.fo-job-top .fo-pill{flex:none}.fo-detail-head h2{font-size:24px;line-height:1.15;font-weight:800;letter-spacing:-.02em}.fo-detail-head p{margin-top:6px;font-size:16px}
.fo-safety{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:10px;background:#fff3f1;color:#8f1a0a;font-weight:700;font-size:14px}
.fo-detail-actions{display:flex;flex-wrap:wrap;gap:8px}.fo-detail-actions .fo-btn{flex:1 1 150px}.fo-detail-actions form{display:contents}
.fo-facts{display:grid;gap:0;margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.fo-facts div{display:grid;grid-template-columns:110px 1fr;gap:10px;padding:10px 12px;border-top:1px solid var(--line)}.fo-facts div:first-child{border-top:0}
.fo-facts dt{color:var(--muted);font-size:13px;font-weight:700}.fo-facts dd{margin:0;font-size:14px;overflow-wrap:anywhere}
.fo-transcript{border:1px solid var(--line);border-radius:12px}.fo-transcript summary{min-height:var(--tap);display:flex;align-items:center;padding:0 14px;font-weight:750;cursor:pointer}
.fo-transcript p{padding:0 14px 14px;white-space:pre-wrap;font-size:14px;color:#2b3445}
.fo-path{border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:grid;gap:8px}
.fo-path-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.fo-path-head h3{font-size:15px}.fo-path-head span{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:var(--muted)}
.fo-path-head i,.fo-path li.current .fo-path-mark i{width:8px;height:8px;border-radius:50%;background:var(--red);animation:fo-pulse 1.2s ease-in-out infinite}
.fo-path ol,.fo-path ul{margin:0;padding:0;list-style:none;display:grid;gap:2px}
.fo-path li{display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:10px;min-height:40px;padding:4px 6px;border-radius:10px}
.fo-path-mark{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;border:1.5px solid var(--line);color:var(--muted);font-size:12px;font-weight:800;background:var(--card)}
.fo-path-mark svg{width:15px;height:15px;stroke-width:3}
.fo-path li.done .fo-path-mark{background:var(--green);border-color:var(--green);color:#fff}
.fo-path li.flagged .fo-path-mark{background:var(--red);border-color:var(--red);color:#fff}
.fo-path li.waiting .fo-path-mark{background:var(--amber);border-color:var(--amber);color:#fff}
.fo-path li.current{background:#f1f4e0}.fo-path li.current .fo-path-mark{border-color:var(--ink)}
.fo-path:not(.live) li.current{background:none}.fo-path:not(.live) li.current .fo-path-mark i{animation:none;background:var(--muted)}
.fo-path li.skipped .fo-path-text,.fo-path li.todo .fo-path-text{color:var(--muted)}.fo-path li.skipped strong{font-weight:600}
.fo-path-text{display:grid;min-width:0}.fo-path-text strong{font-size:14px}.fo-path-text small{font-size:12px;color:var(--muted)}
.fo-path-time{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.fo-path-any{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding-top:4px}
.fo-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@keyframes fo-pulse{50%{opacity:.35}}@media (prefers-reduced-motion:reduce){.fo-path i{animation:none}}
.fo-alerts{margin:0;padding:0;list-style:none;display:grid;gap:4px}.fo-alerts li{display:flex;justify-content:space-between;font-size:14px;padding:6px 0;border-top:1px solid var(--line)}
.fo-danger-zone summary{font-weight:750;color:#a51d0d;cursor:pointer;min-height:40px;display:flex;align-items:center}.fo-danger-zone form{display:grid;gap:12px;margin-top:10px}.fo-danger-zone p{font-size:14px;color:var(--muted)}
.fo-check{display:flex;gap:10px;align-items:center;font-weight:650}.fo-check input{width:22px;height:22px}
.fo-board{display:grid;gap:12px}
.fo-col{display:grid;gap:8px;align-content:start;padding:12px;border:1px solid var(--line);border-radius:var(--r);background:#f4f2ea}
.fo-col>header{display:flex;align-items:center;justify-content:space-between}
.fo-mini{display:grid;gap:4px;padding:12px;border:1px solid var(--line);border-left:4px solid #c9ced8;border-radius:12px;background:var(--card);color:inherit;text-decoration:none}
.fo-mini.danger{border-left-color:var(--red)}.fo-mini.good{border-left-color:var(--green)}
.fo-mini>span{display:flex;justify-content:space-between;gap:8px}.fo-mini small{color:var(--muted);font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.fo-mini time{color:var(--muted);font-size:12px}
.fo-week{display:grid;gap:10px}
.fo-day{display:grid;gap:8px;padding:12px;border:1px solid var(--line);border-radius:var(--r);background:var(--card)}
.fo-day.today{border:1.5px solid var(--ink)}
.fo-day>header{display:flex;align-items:baseline;gap:8px}.fo-day>header strong{font-weight:800}.fo-day>header span{color:var(--muted);font-size:13px}
.fo-event{display:grid;gap:1px;padding:10px 12px;border-left:4px solid var(--green);border-radius:10px;background:#f1f8f3;color:inherit;text-decoration:none}.fo-event.warn{border-left-color:var(--amber);background:#fdf6ea}
.fo-event small{color:var(--muted);font-size:12px}
:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
@media(min-width:720px){.fo-content{padding:20px 24px 32px}.fo-board{grid-template-columns:repeat(2,minmax(0,1fr))}.fo-week{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(min-width:960px){
  .fo{display:grid;grid-template-columns:232px minmax(0,1fr)}
  .fo-side{position:sticky;top:0;display:flex;flex-direction:column;gap:18px;height:100dvh;padding:18px 14px;border-right:1px solid var(--line);background:#fff}
  .fo-brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-size:18px}.fo-brand strong{font-weight:800}
  .fo-side nav{display:grid;gap:4px}.fo-side nav a{position:relative;display:flex;align-items:center;gap:10px;min-height:44px;padding:0 12px;border-radius:10px;color:var(--ink);font-weight:700;text-decoration:none}
  .fo-side nav a.active{background:#f1f4e0;box-shadow:inset 3px 0 0 var(--blue)}.fo-side nav b{position:static;margin-left:auto}
  .fo-side-foot{display:grid;gap:8px;margin-top:auto}.fo-side-foot a{font-weight:650;text-decoration:none}
  .fo-tabs{display:none}.fo-main{padding-bottom:0}.fo-top .fo-mark{display:none}
  .fo-split{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:20px;align-items:start}
  .fo-split .fo-aside,.fo-split.has-selection .fo-primary{display:block}
  .fo-aside{position:sticky;top:84px}.fo-detail .fo-back{display:none}
  .fo-board{grid-template-columns:repeat(4,minmax(0,1fr))}.fo-week{grid-template-columns:repeat(7,minmax(0,1fr))}.fo-day{min-height:200px;align-content:start}
}
.fo-settings{display:grid;gap:14px}.fo-settings-side{display:grid;gap:14px;align-content:start}
.fo-form{display:grid;gap:14px}
.fo-group{display:grid;gap:12px}.fo-group h2{font-size:18px;font-weight:800}
.fo-form label,.fo-group label{display:grid;gap:6px;font-size:14px;font-weight:700}
.fo-form input:not([type=checkbox]),.fo-form select,.fo-form textarea,.fo-group input:not([type=checkbox]){width:100%;min-height:var(--tap);padding:10px 12px;border:1px solid #cfd2c8;border-radius:10px;background:#fff;color:var(--ink);font:16px/1.35 inherit;font-family:inherit}
.fo-form textarea{min-height:76px;resize:vertical}
.fo-form label.fo-check,.fo-group label.fo-check{display:flex;align-items:center;gap:10px;min-height:var(--tap);font-weight:650}
.fo-check input{width:22px;height:22px;accent-color:var(--blue);flex:none}
.fo-hint{margin-top:-6px;color:var(--muted);font-size:13px}
.fo-grid2{display:grid;gap:12px}
.fo-option{display:flex!important;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--line);border-radius:12px}
.fo-option input{width:22px;height:22px;margin-top:2px;accent-color:var(--blue);flex:none}.fo-option span{display:grid;gap:2px}.fo-option strong{font-size:15px}.fo-option em{margin-left:4px;color:var(--blue);font-size:14px}
.fo-option small{color:var(--muted);font-weight:500;font-size:13px}.fo-warn{color:var(--amber)!important}
.fo-advanced summary{font-size:18px;font-weight:800;cursor:pointer;min-height:32px}
.fo-ok{display:flex;align-items:center;gap:8px;color:var(--green);font-weight:750}
.fo-savebar{position:sticky;bottom:calc(72px + env(safe-area-inset-bottom));z-index:5;padding:10px 0;background:linear-gradient(transparent,var(--paper) 30%)}
@media(min-width:720px){.fo-grid2{grid-template-columns:1fr 1fr;align-items:end}}
@media(min-width:960px){.fo-settings{grid-template-columns:minmax(0,1fr) 320px;align-items:start}.fo-settings-side{position:sticky;top:84px}.fo-savebar{bottom:0}}
/* shadcn/ui (MIT) dashboard-01 look: neutral tokens, hairline borders, soft gradient cards, outline badges. */
:root{--ink:#171717;--blue:#0b2545;--paper:#fafafa;--card:#fff;--line:#e5e5e5;--muted:#737373;--r:12px;--shadow:0 1px 2px #0000000d}
body.fo-body{font-family:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:-.005em}
a{color:var(--ink)}
.fo-top{background:rgba(250,250,250,.9);border-bottom-color:var(--line)}
.fo-top-name strong{font-size:17px;font-weight:650;letter-spacing:-.01em}
.fo-mark,.fo-brand span{border:0;border-radius:8px;box-shadow:none;background:var(--yellow);color:#0b2545;width:30px;height:30px}
.fo-status{min-height:30px;padding:0 10px;border-radius:8px;font-weight:600;box-shadow:var(--shadow)}
.fo-card,.fo-stat,.fo-day,.fo-job{background:linear-gradient(to top,#0b25450a,var(--card) 60%);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
.fo-btn{border:0;border-radius:8px;background:var(--blue);color:#fff;box-shadow:var(--shadow);font-weight:600}
.fo-btn:hover{background:#13315a}.fo-btn:active{transform:none;box-shadow:none;opacity:.9}
.fo-btn.danger{background:#dc2626}
.fo-ghost{border-radius:8px;font-weight:600;box-shadow:var(--shadow)}.fo-ghost:hover{background:#f5f5f5}
.fo-link{color:var(--ink);font-weight:600}
.fo-stats{gap:10px}
.fo-stat{position:relative;display:grid;gap:4px;align-content:start;padding:14px}
.fo-stat>span{color:var(--muted);font-size:13px;font-weight:500}
.fo-stat strong{font-size:28px;line-height:1.1;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.fo-stat small{display:none;color:var(--muted);font-size:13px}
.fo-stat.hot strong{color:#b91c1c}
.fo-badge{display:inline-flex;align-items:center;justify-self:start;min-height:22px;padding:0 8px;border:1px solid var(--line);border-radius:6px;font-style:normal;font-size:12px;font-weight:600;font-family:inherit;white-space:nowrap}
.fo-badge.danger{border-color:#fecaca;color:#b91c1c;background:#fef2f2}
.fo-section h2,.fo-col h2,.fo-group h2{font-size:16px;font-weight:650;letter-spacing:-.01em}
.fo-count{min-width:24px;height:22px;border-radius:6px;background:#f5f5f5;color:var(--ink);border:1px solid var(--line);font-weight:600;font-size:12px}
.fo-job{border-left-width:1px;gap:10px}
.fo-job.danger{box-shadow:inset 3px 0 0 #dc2626,var(--shadow)}.fo-job.warn{box-shadow:inset 3px 0 0 #d97706,var(--shadow)}.fo-job.good{box-shadow:inset 3px 0 0 #16a34a,var(--shadow)}
.fo-job-top strong{font-size:16px;font-weight:650}
.fo-pill{min-height:22px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);font-weight:600}
.fo-pill.danger{border-color:#fecaca;background:#fef2f2;color:#b91c1c}.fo-pill.warn{border-color:#fde68a;background:#fffbeb;color:#92400e}.fo-pill.good{border-color:#bbf7d0;background:#f0fdf4;color:#15803d}
.fo-row strong{font-weight:600}.fo-row.selected{background:#f5f5f5}.fo-row:hover{background:#fafafa}
.fo-empty{border:1px dashed var(--line);background:var(--card)}
.fo-setup{border:1px solid var(--line);box-shadow:var(--shadow)}.fo-setup h2{font-size:17px;font-weight:650}
.fo-steps i{border-width:1px}
.fo-ring{background:conic-gradient(var(--blue) calc(var(--p)*1%),#e5e5e5 0)}
.fo-meter{height:8px;background:#f0f0f0}.fo-meter span{background:var(--blue)}
.fo-col{background:#f5f5f5;border-color:var(--line)}
.fo-mini{border-left-width:1px;box-shadow:var(--shadow)}.fo-mini.danger{box-shadow:inset 3px 0 0 #dc2626,var(--shadow)}.fo-mini.good{box-shadow:inset 3px 0 0 #16a34a,var(--shadow)}
.fo-day.today{border:1px solid var(--ink)}
.fo-event{border-left-width:3px;border-radius:8px}
.fo-tabs{background:rgba(255,255,255,.96);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.fo-tabs a{font-weight:600;border-radius:8px}.fo-tabs a.active{background:#f5f5f5;color:var(--ink)}.fo-tabs a.active svg{color:var(--ink)}
.fo-form input:not([type=checkbox]),.fo-form select,.fo-form textarea,.fo-group input:not([type=checkbox]){border-color:var(--line);border-radius:8px;box-shadow:var(--shadow)}
.fo-form input:focus,.fo-form select:focus,.fo-form textarea:focus{outline:none;border-color:#a3a3a3;box-shadow:0 0 0 3px #a3a3a340}
.fo-option{border-radius:10px}
:focus-visible{outline:2px solid #a3a3a3;outline-offset:2px}
@media(min-width:720px){.fo-stat small{display:block}.fo-stat{padding:18px}.fo-stat strong{font-size:32px}.fo-stat .fo-badge{position:absolute;top:16px;right:16px}}
@media(min-width:960px){
  .fo-side{background:var(--paper)}
  .fo-side nav a{min-height:36px;padding:0 10px;border-radius:8px;font-weight:500;font-size:14px}
  .fo-side nav a:hover{background:#f0f0f0}
  .fo-side nav a.active{background:#ececec;box-shadow:none;font-weight:600}
  .fo-content{gap:16px}
}
.fo-forward summary{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;list-style:none}.fo-forward summary::-webkit-details-marker{display:none}
.fo-forward summary>span:first-child{display:grid}.fo-forward small{color:var(--muted);font-size:13px}.fo-forward strong{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}
.fo-forward[open]{display:grid;gap:12px;border-color:var(--yellow);box-shadow:inset 4px 0 0 var(--yellow),var(--shadow)}.fo-forward p{font-size:14px}
.fo-forward code{font:600 15px ui-monospace,SFMono-Regular,Menlo,monospace;background:#fbfde0;padding:2px 6px;border-radius:6px;user-select:all}
@media(prefers-reduced-motion:no-preference){.fo-btn{transition:transform .12s,box-shadow .12s}}
`;
