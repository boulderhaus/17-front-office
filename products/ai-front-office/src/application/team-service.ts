import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { BusinessConfig, OwnerAccount } from "../domain/models.js";
import type { Clock, Store } from "../ports.js";
import { hashOwnerPassword } from "../security/owner-auth.js";

/** generation: the shop's invitation generation when it was made; reclaim() moves the shop to a new one. */
interface Invite { email: string; expiresAt: string; used: boolean; generation?: number }
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const GENERATION = { provider: "team", key: "invite_generation" } as const;

/** Inviting needs an owner who proved the account email, so whoever typed someone else's at sign-up can't add a crew. */
export class EmailNotProvedError extends Error {
  constructor() {
    super("Confirm the account email before inviting teammates");
  }
}

export class TeamService {
  constructor(private readonly store: Store, private readonly clock: Clock) {}

  async invite(owner: OwnerAccount, email: string): Promise<string> {
    if (owner.role === "member") throw new Error("Only the shop owner can invite teammates");
    if (!owner.emailVerifiedAt) throw new EmailNotProvedError();
    const members = await this.store.listTeamAccounts(owner.tenantId);
    if (members.filter((member) => member.status !== "suspended").length >= 10) throw new Error("This shop already has 10 active accounts");
    if (await this.store.getOwnerAccountByEmail(email)) throw new Error("That email already has an account");
    const token = randomBytes(32).toString("base64url");
    const invitation: Invite = { email, expiresAt: new Date(this.clock.now().getTime() + 48 * 60 * 60_000).toISOString(), used: false, generation: await this.generation(owner.tenantId) };
    await this.store.saveIntegrationSecret(owner.tenantId, "team_invite", digest(token), JSON.stringify(invitation));
    return token;
  }

  async invitation(tenantId: string, token: string): Promise<Invite | null> {
    if (!/^shop_[a-f0-9-]+$/.test(tenantId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const text = await this.store.getIntegrationSecret(tenantId, "team_invite", digest(token));
    if (!text) return null;
    const invitation = JSON.parse(text) as Invite;
    if (invitation.used || !(Date.parse(invitation.expiresAt) > this.clock.now().getTime())) return null;
    return (invitation.generation ?? 0) === await this.generation(tenantId) ? invitation : null;
  }

  /**
   * The owner just proved the account email for the first time, so the person who signed up with it may have been
   * someone else: every teammate is removed (signed out, calendar grant dropped) and every open invitation link
   * stops working. Returns how many teammates were removed.
   */
  async reclaim(tenantId: string): Promise<number> {
    return this.store.withLock(`team:${tenantId}`, async () => {
      const now = this.clock.now().toISOString();
      let removed = 0;
      for (const member of await this.store.listTeamAccounts(tenantId)) {
        if (member.role !== "member" || member.status === "suspended") continue;
        await this.store.updateOwnerAccountStatus(member.id, "suspended", now);
        await this.store.revokeOwnerSessions(member.id, now);
        await this.store.deleteIntegrationSecret(tenantId, "google", `refresh_token:${member.id}`);
        removed += 1;
      }
      await this.store.saveIntegrationSecret(tenantId, GENERATION.provider, GENERATION.key, String(await this.generation(tenantId) + 1));
      return removed;
    });
  }

  private async generation(tenantId: string): Promise<number> {
    const value = Number(await this.store.getIntegrationSecret(tenantId, GENERATION.provider, GENERATION.key));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  async accept(tenantId: string, token: string, name: string, password: string): Promise<OwnerAccount> {
    return this.store.withLock(`team:${tenantId}`, async () => {
      const invitation = await this.invitation(tenantId, token);
      if (!invitation) throw new Error("This invitation has expired or was already used");
      if ((await this.store.listTeamAccounts(tenantId)).filter((member) => member.status !== "suspended").length >= 10) throw new Error("This shop already has 10 active accounts");
      const now = this.clock.now().toISOString();
      const account: OwnerAccount = { id: randomUUID(), tenantId, email: invitation.email, displayName: name, passwordHash: await hashOwnerPassword(password), role: "member", status: "active", createdAt: now, updatedAt: now };
      // Fail closed: if account creation fails, the owner can issue a new link.
      // Never create an account and then fail to invalidate its bearer token.
      await this.store.saveIntegrationSecret(tenantId, "team_invite", digest(token), JSON.stringify({ ...invitation, used: true }));
      if (!await this.store.createTeamAccount(account)) throw new Error("That email already has an account");
      return account;
    });
  }

  async availability(account: OwnerAccount, enabled: boolean, hours: BusinessConfig["bookableHours"]): Promise<void> {
    await this.store.withLock(`config:${account.tenantId}`, async () => {
      const config = await this.store.getConfig(account.tenantId);
      const owner = await this.store.getOwnerAccountByTenant(account.tenantId);
      const current = config.schedulingCalendars?.length ? config.schedulingCalendars : owner ? [{ accountId: owner.id, enabled: true, hours: config.bookableHours }] : [];
      const calendars = current.filter((calendar) => calendar.accountId !== account.id);
      calendars.push({ accountId: account.id, enabled, hours });
      await this.store.saveConfig({ ...config, schedulingCalendars: calendars });
    });
  }
}
