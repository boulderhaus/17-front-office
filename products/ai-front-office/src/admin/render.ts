import type { BookingRecord, BusinessConfig, CallbackTask, CallRecord, OutboxNotification, ToolEvent } from "../domain/models.js";
import { buildVoiceSystemPrompt, RETELL_ANALYSIS_FIELDS, RETELL_TOOL_SCHEMAS } from "../voice/system-prompt.js";

export function renderLogin(error = ""): string {
  return layout("Sign in", `<main class="narrow"><h1>Front Office</h1><p>Enter the admin token configured on the server.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="/admin/login"><label>Admin token<input name="token" type="password" autocomplete="current-password" required></label><button>Sign in</button></form></main>`);
}

export function renderDashboard(input: {
  config: BusinessConfig;
  calls: CallRecord[];
  csrf: string;
  integrations: Record<string, boolean>;
}): string {
  const completedCalls = input.calls.filter((call) => call.endedAt !== null && call.billingDisposition !== "spam_excluded");
  const verifiedBookings = input.calls.filter((call) => call.outcome === "booked").length;
  const urgentEscalations = input.calls.filter((call) => call.billingDisposition !== "spam_excluded" && call.emergency?.emergency).length;
  const excludedSpam = input.calls.filter((call) => call.billingDisposition === "spam_excluded").length;
  const rows = input.calls.length === 0
    ? `<tr><td colspan="5">No calls yet. Use the simulator or connect Retell.</td></tr>`
    : input.calls.map((call) => `<tr><td><a href="/admin/calls/${encodeURIComponent(call.id)}">${escapeHtml(formatDate(call.startedAt, input.config.timezone))}</a></td><td>${escapeHtml(call.fields.callerName ?? "Unknown")}</td><td>${escapeHtml(call.fields.problemDescription || "No summary")}</td><td><span class="pill ${call.emergency?.emergency ? "danger" : ""}">${escapeHtml(call.emergency?.severity ?? "pending")}</span></td><td>${escapeHtml(call.outcome)}</td></tr>`).join("");
  const integrationItems = Object.entries(input.integrations).map(([name, ready]) => `<li>${escapeHtml(name)} <strong class="${ready ? "good" : "error"}">${ready ? "ready" : "missing"}</strong></li>`).join("");
  return layout("Calls", `<header><div><p class="eyebrow">${escapeHtml(input.config.businessName)}</p><h1>AI Front Office</h1></div><nav><a href="/admin/config">Configuration</a><a href="/admin/prompt">Retell prompt</a><a href="/admin/logout">Sign out</a></nav></header><main><section class="grid"><article><h2>Calls captured</h2><p>${completedCalls.length}</p></article><article><h2>Verified bookings</h2><p>${verifiedBookings}</p></article><article><h2>Urgent escalations</h2><p>${urgentEscalations}</p></article></section><section class="grid"><article><h2>Mode</h2><p>${escapeHtml(input.config.operationMode.replace("_", " "))}</p></article><article><h2>Flat price</h2><p>$${(input.config.flatMonthlyPriceCents / 100).toFixed(0)}/month · ${excludedSpam} spam excluded</p></article><article><h2>Integrations</h2><ul>${integrationItems}</ul></article></section><section><h2>Recent calls</h2><div class="table"><table><thead><tr><th>When</th><th>Caller</th><th>Problem</th><th>Priority</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div></section></main>`);
}

export function renderConfig(config: BusinessConfig, csrf: string, integrations: { googleAvailable: boolean; googleConnected: boolean; ownerPhoneConfigured: boolean }): string {
  const googleAction = integrations.googleConnected
    ? `<strong class="good">Connected</strong>`
    : integrations.googleAvailable
      ? `<a href="/admin/integrations/google/start">Connect Google Calendar</a>`
      : `<strong class="error">Google OAuth client not configured</strong>`;
  return layout("Configuration", `<header><div><p class="eyebrow">Owner setup</p><h1>Configuration</h1></div><nav><a href="/admin">Calls</a></nav></header><main><section><h2>Calendar</h2><p>${googleAction}</p><p>A booking counts only after a system-of-record write is read back, the recording and transcript exist, intake is complete, and customer confirmation is queued.</p></section><form method="post" action="/admin/config"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><div class="grid two"><label>Business name<input name="businessName" value="${escapeHtml(config.businessName)}" required></label><label>Timezone<input name="timezone" value="${escapeHtml(config.timezone)}" required></label></div><label>Greeting<textarea name="greeting" required>${escapeHtml(config.greeting)}</textarea></label><div class="grid two"><label>Owner alert phone<input name="ownerPhone" type="tel" placeholder="${integrations.ownerPhoneConfigured ? "Configured—enter a replacement only" : "+15555550100"}"></label><label>Booking mode<select name="bookingMode"><option value="confirm" ${config.bookingMode === "confirm" ? "selected" : ""}>confirm first</option><option value="direct" ${config.bookingMode === "direct" ? "selected" : ""}>direct booking</option></select></label></div><div class="grid two"><label>Coverage mode<select name="operationMode">${option("always", config.operationMode)}${option("after_hours", config.operationMode)}${option("overflow", config.operationMode)}</select></label><label>Flat monthly price ($49–$99)<input name="flatMonthlyPrice" type="number" min="49" max="99" step="1" value="${Math.round(config.flatMonthlyPriceCents / 100)}"></label></div><div class="grid two"><label>Default job duration (minutes)<input name="defaultServiceDurationMinutes" type="number" min="15" max="480" step="15" value="${config.defaultServiceDurationMinutes}"></label><label>Emergency score threshold<input name="emergencyThreshold" type="number" min="0.5" max="1" step="0.05" value="${config.emergencyThreshold}"></label></div><label class="check"><input name="requireDiagnosticFeeAcceptance" type="checkbox" ${config.requireDiagnosticFeeAcceptance ? "checked" : ""}> Require diagnostic-fee acceptance</label><div class="grid two"><label>Service-area terms (comma separated)<textarea name="serviceAreaTerms">${escapeHtml(config.serviceAreaTerms.join(", "))}</textarea></label><label>Service categories (comma separated)<textarea name="serviceCategories">${escapeHtml(config.serviceCategories.join(", "))}</textarea></label></div><label>Emergency keywords (comma separated)<textarea name="emergencyKeywords">${escapeHtml(config.emergencyKeywords.join(", "))}</textarea></label><div class="grid two"><label>Approved price/script snippets (one Label: Exact wording per line)<textarea name="priceSnippets">${escapeHtml(config.priceSnippets.map((item) => `${item.label}: ${item.text}`).join("\n"))}</textarea></label><label>Owner-approved knowledge (one Topic: Answer per line)<textarea name="approvedKnowledge">${escapeHtml(config.approvedKnowledge.map((item) => `${item.topic}: ${item.text}`).join("\n"))}</textarea></label></div><label>Pronunciations (one Term: Spoken as per line)<textarea name="pronunciations">${escapeHtml(config.pronunciations.map((item) => `${item.term}: ${item.spokenAs}`).join("\n"))}</textarea></label><div class="grid two"><label>Weekday coverage starts<input name="weekdayStart" type="time" value="${escapeHtml(config.afterHours.weekdayStart)}"></label><label>Weekday coverage ends<input name="weekdayEnd" type="time" value="${escapeHtml(config.afterHours.weekdayEnd)}"></label></div><label>Holiday coverage dates (comma separated YYYY-MM-DD)<textarea name="holidayDates">${escapeHtml(config.afterHours.holidayDates.join(", "))}</textarea></label><label class="check"><input name="weekends" type="checkbox" ${config.afterHours.weekends ? "checked" : ""}> Cover weekends</label><label>Recording disclosure<textarea name="recordingDisclosure">${escapeHtml(config.recordingDisclosure)}</textarea></label><button>Save configuration</button></form></main>`);
}

export function renderCallDetail(input: {
  config: BusinessConfig;
  call: CallRecord;
  booking: BookingRecord | null;
  callbackTask: CallbackTask | null;
  events: ToolEvent[];
  notifications: OutboxNotification[];
}): string {
  const call = input.call;
  const eventRows = input.events.map((event) => `<tr><td>${escapeHtml(event.tool)}</td><td>${escapeHtml(event.result)}</td><td>${event.latencyMs} ms</td><td>${escapeHtml(event.redactedError ?? "")}</td></tr>`).join("") || `<tr><td colspan="4">No tool events.</td></tr>`;
  const notificationRows = input.notifications.map((item) => `<tr><td>${escapeHtml(item.channel)}</td><td>${escapeHtml(item.priority)}</td><td>${escapeHtml(item.state)}</td><td>${escapeHtml(item.sentAt ? formatDate(item.sentAt, input.config.timezone) : item.lastError ?? "queued")}</td></tr>`).join("") || `<tr><td colspan="4">No notifications.</td></tr>`;
  const recording = safeHttpsUrl(call.recordingUrl);
  return layout("Call", `<header><div><p class="eyebrow">${escapeHtml(formatDate(call.startedAt, input.config.timezone))}</p><h1>${escapeHtml(call.fields.callerName ?? "Unknown caller")}</h1></div><nav><a href="/admin">Calls</a></nav></header><main><section class="grid"><article><h2>Outcome</h2><p>${escapeHtml(call.outcome)}</p></article><article><h2>Priority</h2><p>${escapeHtml(call.emergency?.severity ?? "not classified")}</p></article><article><h2>Booking</h2><p>${escapeHtml(input.booking?.status ?? "none")}</p></article></section>${input.callbackTask ? `<section><h2>Owned callback</h2><p>${escapeHtml(input.callbackTask.ownerRef)} · due ${escapeHtml(formatDate(input.callbackTask.dueAt, input.config.timezone))} · ${escapeHtml(input.callbackTask.reason)}</p></section>` : ""}<section class="grid two"><article><h2>Caller</h2><dl><dt>Phone</dt><dd>${escapeHtml(call.fields.callbackNumber ?? call.fromNumber)}</dd><dt>Address</dt><dd>${escapeHtml(call.fields.address ?? "Not confirmed")}</dd><dt>Category</dt><dd>${escapeHtml(call.fields.serviceCategory ?? "Not classified")}</dd><dt>Problem</dt><dd>${escapeHtml(call.fields.problemDescription || "Not captured")}</dd></dl></article><article><h2>Evidence</h2><dl><dt>Verification gaps</dt><dd>${escapeHtml(call.qualityFlags.join(", ") || "None")}</dd><dt>Emergency evidence</dt><dd>${escapeHtml(call.emergency?.evidence.join(", ") || "None")}</dd><dt>Consent</dt><dd>${escapeHtml(call.consentState)}</dd><dt>Billing</dt><dd>${escapeHtml(call.billingDisposition)}</dd><dt>Recording</dt><dd>${recording ? `<a href="${escapeHtml(recording)}" rel="noreferrer">Open recording</a>` : "Unavailable"}</dd></dl></article></section><section><h2>Transcript</h2><pre>${escapeHtml(call.transcript ?? "Transcript unavailable")}</pre></section><section><h2>Tool events</h2><div class="table"><table><tbody>${eventRows}</tbody></table></div></section><section><h2>Owner alerts</h2><div class="table"><table><tbody>${notificationRows}</tbody></table></div></section></main>`);
}

export function renderPrompt(config: BusinessConfig): string {
  return layout("Retell setup", `<header><div><p class="eyebrow">Provider setup</p><h1>Retell prompt</h1></div><nav><a href="/admin">Calls</a></nav></header><main><p>Paste this system prompt into the Retell agent. Configure every authenticated custom tool below and a provider-native transfer function.</p><pre>${escapeHtml(buildVoiceSystemPrompt(config))}</pre><h2>Tools</h2><pre>${escapeHtml(JSON.stringify(RETELL_TOOL_SCHEMAS, null, 2))}</pre><h2>Post-call analysis fields</h2><pre>${escapeHtml(JSON.stringify(RETELL_ANALYSIS_FIELDS, null, 2))}</pre></main>`);
}

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Front Office</title><style>:root{color-scheme:light;--ink:#14221b;--muted:#627067;--line:#dfe7e1;--paper:#f6f8f5;--accent:#176b45;--danger:#a42b2b}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}header,main,.narrow{max-width:1120px;margin:auto;padding:28px}header{display:flex;align-items:end;justify-content:space-between;gap:20px}nav{display:flex;gap:16px;flex-wrap:wrap}a{color:var(--accent)}h1{font-size:clamp(28px,5vw,48px);line-height:1.05;margin:0}h2{font-size:16px;margin:0 0 10px}.eyebrow{color:var(--muted);margin:0 0 4px;text-transform:uppercase;letter-spacing:.08em}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px}.grid.two{grid-template-columns:repeat(2,1fr)}article,form,section{background:white;border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}.narrow{max-width:560px;padding-top:12vh}label{display:block;font-weight:650;margin-bottom:16px}input,textarea,select{display:block;width:100%;margin-top:7px;padding:11px;border:1px solid #aebbb2;border-radius:8px;font:inherit}textarea{min-height:92px}button{background:var(--ink);color:white;border:0;border-radius:9px;padding:12px 18px;font-weight:700}.check{display:flex;gap:8px;align-items:center}.check input{width:auto;margin:0}.table{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line);vertical-align:top}.pill{display:inline-block;background:#e7eee9;border-radius:99px;padding:2px 8px}.danger,.error{color:var(--danger)}.good{color:var(--accent)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#102019;color:#e9f4ed;border-radius:10px;padding:16px}dt{font-weight:700}dd{margin:0 0 10px}@media(max-width:720px){header{align-items:start;flex-direction:column}.grid,.grid.two{grid-template-columns:1fr}header,main{padding:18px}}</style></head><body>${body}</body></html>`;
}

function escapeHtml(value: string): string {
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

function formatDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function option(value: BusinessConfig["operationMode"], current: BusinessConfig["operationMode"]): string {
  return `<option value="${value}" ${value === current ? "selected" : ""}>${escapeHtml(value.replace("_", " "))}</option>`;
}
