import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { formatEmailBody } from "../adapters/resend.js";
import type { Environment } from "../config/environment.js";
import type { OwnerAccount } from "../domain/models.js";
import type { Clock, Store } from "../ports.js";
import { EmailNotProvedError, TeamService } from "../application/team-service.js";
import { renderJoinPage } from "../admin/team.js";
import { PASSWORD_MIN_LENGTH } from "../admin/render.js";
import { createPasswordResetToken, mintOwnerSession, ownerSessionCookie, type OwnerSession } from "../security/owner-auth.js";
import { HttpError, parseForm, readBody, redirect, sendHtml, sendJson } from "./security.js";

interface Context { env: Environment; store: Store; clock: Clock }

export async function joinTeam(request: IncomingMessage, response: ServerResponse, url: URL, context: Context): Promise<void> {
  const teams = new TeamService(context.store, context.clock);
  const form = request.method === "POST" ? parseForm(await readBody(request, 8_000)) : url.searchParams;
  const tenantId = form.get("shop") ?? "";
  const token = form.get("token") ?? "";
  const invitation = await teams.invitation(tenantId, token);
  if (!invitation) throw new HttpError(410, "This invitation expired or was used. Ask the owner for a new link.");
  if (request.method === "GET") return sendHtml(response, 200, renderJoinPage(tenantId, token, invitation.email, (await context.store.getConfig(tenantId)).businessName));
  const input = z.object({ name: z.string().trim().min(2).max(120), password: z.string().min(PASSWORD_MIN_LENGTH).max(200), consent: z.literal("yes") }).safeParse(Object.fromEntries(form));
  if (!input.success) throw new HttpError(400, `Enter your name, a password of at least ${PASSWORD_MIN_LENGTH} characters, and accept the terms.`);
  const account = await teams.accept(tenantId, token, input.data.name, input.data.password).catch(() => { throw new HttpError(409, "Invitation could not be accepted. Sign in if you already have an account, or ask for a new invitation."); });
  response.setHeader("set-cookie", ownerSessionCookie(mintOwnerSession(account, context.env.SESSION_SIGNING_KEY!, context.clock.now().getTime()), context.env.NODE_ENV === "production"));
  redirect(response, "/app/team");
}

const CONFIRM_FIRST = "Confirm your email first: tap Confirm my email on the Team page.";

function inviteLink(context: Context, account: OwnerAccount, token: string): string {
  return `${context.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/join?shop=${encodeURIComponent(account.tenantId)}&token=${encodeURIComponent(token)}`;
}

/**
 * The Team screen's JSON (/api/app/team...): who is in the shop, the viewer's calendar and rotation, invites.
 * Hours live in one place: the owner's are Settings › Hours (the shop's appointment hours), so the owner's
 * rotation row carries none. A teammate has no Settings, so their own hours stay here.
 * readJson: the owner API's body reader (JSON plus the CSRF header).
 */
export async function teamApi(request: IncomingMessage, response: ServerResponse, url: URL, context: Context, account: OwnerAccount, session: OwnerSession, readJson: (limit: number) => Promise<unknown>): Promise<void> {
  const { store } = context;
  const teams = new TeamService(store, context.clock);
  const member = account.role === "member";
  const calendarKey = member ? `refresh_token:${account.id}` : "refresh_token";
  const method = request.method ?? "GET";
  if (method === "GET" && url.pathname === "/api/app/team") {
    const config = await store.getConfig(account.tenantId);
    const own = config.schedulingCalendars?.find((calendar) => calendar.accountId === account.id);
    const people = member ? [] : await store.listTeamAccounts(account.tenantId);
    return sendJson(response, 200, {
      csrf: session.csrf,
      role: member ? "member" : "owner",
      emailConfirmed: Boolean(account.emailVerifiedAt),
      emailEnabled: Boolean(context.env.RESEND_API_KEY && context.env.RESEND_FROM_EMAIL),
      calendarConnected: Boolean(await store.getIntegrationSecret(account.tenantId, "google", calendarKey)),
      // The owner is in the rotation by default (the shop's own calendar) until they say otherwise.
      inRotation: own ? own.enabled : !member,
      hours: member ? (own?.hours ?? config.bookableHours) : null,
      timezone: config.timezone,
      people: people.map((person) => ({ id: person.id, name: person.displayName, role: person.role === "member" ? "member" : "owner", active: person.status !== "suspended", you: person.id === account.id })),
    });
  }
  if (method !== "POST") throw new HttpError(404, "Not found");
  if (url.pathname === "/api/app/team/rotation") {
    const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
    const input = z.object({ enabled: z.boolean(), start: time.optional(), end: time.optional(), weekends: z.boolean().optional() }).safeParse(await readJson(2_000));
    if (!input.success) throw new HttpError(400, "That didn’t save. Please try again.");
    const config = await store.getConfig(account.tenantId);
    const own = config.schedulingCalendars?.find((calendar) => calendar.accountId === account.id);
    let hours = config.bookableHours;
    if (member) {
      const current = own?.hours ?? config.bookableHours;
      hours = { ...current, weekdayStart: input.data.start ?? current.weekdayStart, weekdayEnd: input.data.end ?? current.weekdayEnd, weekends: input.data.weekends ?? current.weekends };
      if (hours.weekdayStart >= hours.weekdayEnd) throw new HttpError(400, "Pick a start time before the finish time.");
    }
    if (input.data.enabled && !await store.getIntegrationSecret(account.tenantId, "google", calendarKey)) throw new HttpError(409, "Connect your Google Calendar first.");
    if (!input.data.enabled) {
      // Otto can't book a job onto nobody's calendar: someone else must still be taking them.
      const accounts = await store.listTeamAccounts(account.tenantId);
      const others = (config.schedulingCalendars ?? []).filter((calendar) => calendar.accountId !== account.id && calendar.enabled
        && accounts.some((person) => person.id === calendar.accountId && person.status !== "suspended"));
      if (!others.length) throw new HttpError(409, "Someone has to take booked jobs. Invite a teammate first.");
    }
    await teams.availability(account, input.data.enabled, hours);
    return sendJson(response, 200, { saved: true });
  }
  if (member) throw new HttpError(403, "Only the owner can manage teammates");
  if (url.pathname === "/api/app/team/invite") {
    const body = await readJson(2_000) as { email?: unknown };
    const email = z.string().trim().toLowerCase().email().max(254).safeParse(body?.email);
    if (!email.success) throw new HttpError(400, "Enter their email, like name@yourshop.com.");
    const token = await teams.invite(account, email.data).catch((error: unknown) => {
      if (error instanceof EmailNotProvedError) throw new HttpError(403, CONFIRM_FIRST);
      throw new HttpError(409, "That email already has an account, or the team is full.");
    });
    return sendJson(response, 200, { inviteUrl: inviteLink(context, account, token) });
  }
  if (url.pathname === "/api/app/team/remove") {
    const body = await readJson(2_000) as { accountId?: unknown };
    const target = typeof body?.accountId === "string" ? await store.getOwnerAccountById(body.accountId) : null;
    if (!target || target.tenantId !== account.tenantId || target.role !== "member") throw new HttpError(404, "Teammate not found");
    await store.updateOwnerAccountStatus(target.id, "suspended", context.clock.now().toISOString());
    await store.deleteIntegrationSecret(account.tenantId, "google", `refresh_token:${target.id}`);
    return sendJson(response, 200, { removed: true });
  }
  /**
   * "Confirm my email": the owner signed up with a password, which proves nothing about the address. The email
   * carries a one-time link (/app/confirm-email); opening it signed in proves the address and changes nothing else.
   */
  if (url.pathname === "/api/app/team/confirm-email") {
    await readJson(200);
    if (account.emailVerifiedAt) return sendJson(response, 200, { sent: false, confirmed: true });
    if (!context.env.RESEND_API_KEY || !context.env.RESEND_FROM_EMAIL) throw new HttpError(503, "Email isn’t switched on yet. Please try again later.");
    const { token, tokenHash } = createPasswordResetToken();
    const now = context.clock.now();
    await store.createPasswordReset(account.id, tokenHash, new Date(now.getTime() + 30 * 60_000).toISOString());
    const link = `${context.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/confirm-email?token=${encodeURIComponent(token)}`;
    await store.enqueueNotification({
      id: randomUUID(), tenantId: account.tenantId, callId: null, channel: "email", destinationRef: `email:${account.email}`,
      body: formatEmailBody("Confirm your Call Otto email", `Tap this link within 30 minutes to confirm your email:\n\n${link}\n\nIf you didn't ask for this, ignore this email.`),
      priority: "high", state: "pending", attempts: 0, nextAttemptAt: now.toISOString(),
      idempotencyKey: `email-confirm:${tokenHash}`, providerReceipt: null, lastError: null, createdAt: now.toISOString(), sentAt: null,
    });
    return sendJson(response, 200, { sent: true });
  }
  throw new HttpError(404, "Not found");
}
