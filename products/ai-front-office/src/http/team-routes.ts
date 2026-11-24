import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Environment } from "../config/environment.js";
import type { OwnerAccount } from "../domain/models.js";
import type { Clock, Store } from "../ports.js";
import { TeamService } from "../application/team-service.js";
import { renderJoinPage, renderTeamPage } from "../admin/team.js";
import { mintOwnerSession, ownerSessionCookie, verifyOwnerCsrf, type OwnerSession } from "../security/owner-auth.js";
import { HttpError, parseForm, readBody, redirect, sendHtml } from "./security.js";

interface Context { env: Environment; store: Store; clock: Clock }

export async function joinTeam(request: IncomingMessage, response: ServerResponse, url: URL, context: Context): Promise<void> {
  const teams = new TeamService(context.store, context.clock);
  const form = request.method === "POST" ? parseForm(await readBody(request, 8_000)) : url.searchParams;
  const tenantId = form.get("shop") ?? "";
  const token = form.get("token") ?? "";
  const invitation = await teams.invitation(tenantId, token);
  if (!invitation) throw new HttpError(410, "This invitation expired or was used. Ask the owner for a new link.");
  if (request.method === "GET") return sendHtml(response, 200, renderJoinPage(tenantId, token, invitation.email, (await context.store.getConfig(tenantId)).businessName));
  const input = z.object({ name: z.string().trim().min(2).max(120), password: z.string().min(12).max(200), consent: z.literal("yes") }).safeParse(Object.fromEntries(form));
  if (!input.success) throw new HttpError(400, "Enter your name, a password of at least 12 characters, and accept the terms.");
  const account = await teams.accept(tenantId, token, input.data.name, input.data.password).catch(() => { throw new HttpError(409, "Invitation could not be accepted. Sign in if you already have an account, or ask for a new invitation."); });
  response.setHeader("set-cookie", ownerSessionCookie(mintOwnerSession(account, context.env.SESSION_SIGNING_KEY!, context.clock.now().getTime()), context.env.NODE_ENV === "production"));
  redirect(response, "/app/team");
}

export async function teamRoutes(request: IncomingMessage, response: ServerResponse, url: URL, context: Context, account: OwnerAccount, session: OwnerSession): Promise<void> {
  const { store } = context;
  const teams = new TeamService(store, context.clock);
  const member = account.role === "member";
  const page = async (inviteUrl?: string) => renderTeamPage({ account, config: await store.getConfig(account.tenantId), accounts: member ? [] : await store.listTeamAccounts(account.tenantId), csrf: session.csrf, connected: Boolean(await store.getIntegrationSecret(account.tenantId, "google", member ? `refresh_token:${account.id}` : "refresh_token")), ...(inviteUrl ? { inviteUrl } : {}) });
  if (request.method === "GET" && url.pathname === "/app/team") return sendHtml(response, 200, await page());
  if (request.method !== "POST") throw new HttpError(404, "Not found");
  const form = parseForm(await readBody(request, 8_000));
  if (!verifyOwnerCsrf(session, form.get("csrf"))) throw new HttpError(403, "Invalid CSRF token");
  if (url.pathname === "/app/team/availability") {
    const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
    const input = z.object({ start: time, end: time }).safeParse(Object.fromEntries(form));
    if (!input.success || input.data.start >= input.data.end) throw new HttpError(400, "Choose a start time before the finish time");
    if (form.get("enabled") === "on" && !await store.getIntegrationSecret(account.tenantId, "google", member ? `refresh_token:${account.id}` : "refresh_token")) throw new HttpError(409, "Connect your calendar before joining the rotation");
    await teams.availability(account, form.get("enabled") === "on", { weekdayStart: input.data.start, weekdayEnd: input.data.end, weekends: form.get("weekends") === "on" });
    return redirect(response, "/app/team");
  }
  if (member) throw new HttpError(403, "Only the owner can manage teammates");
  if (url.pathname === "/app/team/invite") {
    const email = z.string().trim().toLowerCase().email().max(254).safeParse(form.get("email"));
    if (!email.success) throw new HttpError(400, "Enter your teammate’s email");
    const token = await teams.invite(account, email.data).catch(() => { throw new HttpError(409, "Email already has an account or the team is full"); });
    const inviteUrl = `${context.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/join?shop=${encodeURIComponent(account.tenantId)}&token=${encodeURIComponent(token)}`;
    return sendHtml(response, 200, await page(inviteUrl));
  }
  if (url.pathname === "/app/team/remove") {
    const target = await store.getOwnerAccountById(form.get("accountId") ?? "");
    if (!target || target.tenantId !== account.tenantId || target.role !== "member") throw new HttpError(404, "Teammate not found");
    await store.updateOwnerAccountStatus(target.id, "suspended", context.clock.now().toISOString());
    // A suspended teammate's calendar is never used again, so its Google grant would never hit
    // invalid_grant and be cleaned up: drop it now (the privacy notice promises this).
    await store.deleteIntegrationSecret(account.tenantId, "google", `refresh_token:${target.id}`);
    return redirect(response, "/app/team");
  }
  throw new HttpError(404, "Not found");
}
