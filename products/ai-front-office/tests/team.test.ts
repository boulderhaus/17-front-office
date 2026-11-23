import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { TeamCalendar } from "../src/adapters/team-calendar.js";
import { TeamService } from "../src/application/team-service.js";
import { createDemoConfig } from "../src/domain/config.js";
import type { BookingAttempt, OwnerAccount } from "../src/domain/models.js";

const now = "2026-01-15T08:00:00.000Z";
const clock = { now: () => new Date(now) };
function owner(tenantId: string): OwnerAccount { return { id: randomUUID(), tenantId, email: "owner@synthetic.example", displayName: "Synthetic Owner", passwordHash: "synthetic", role: "owner", status: "active", createdAt: now, updatedAt: now }; }

describe("team invitations and calendar rotation", () => {
  it("creates an isolated teammate from an expiring single-use invitation", async () => {
    const store = new InMemoryStore();
    const tenantId = `shop_${randomUUID()}`;
    const account = owner(tenantId);
    await store.createOwnerWorkspace({ account, config: createDemoConfig(tenantId), ownerPhone: null });
    const teams = new TeamService(store, clock);
    const token = await teams.invite(account, "member@synthetic.example");
    expect(await teams.invitation(`shop_${randomUUID()}`, token)).toBeNull();
    const member = await teams.accept(tenantId, token, "Synthetic Member", "long-test-password-123");
    expect(member).toMatchObject({ tenantId, role: "member" });
    expect((await store.getOwnerAccountByTenant(tenantId))?.id).toBe(account.id);
    await expect(teams.accept(tenantId, token, "Replay", "long-test-password-123")).rejects.toThrow();
    await expect(teams.invite(member, "third@synthetic.example")).rejects.toThrow("Only the shop owner");
    const second = await teams.invite(account, "later@synthetic.example");
    expect(await new TeamService(store, { now: () => new Date("2026-01-18T08:00:00Z") }).invitation(tenantId, second)).toBeNull();
  });

  it("assigns only free enabled calendars, and verifies on the calendar it wrote", async () => {
    const store = new InMemoryStore();
    const tenantId = `shop_${randomUUID()}`;
    const account = owner(tenantId);
    const config = createDemoConfig(tenantId);
    await store.createOwnerWorkspace({ account, config, ownerPhone: null });
    const member = { ...account, id: randomUUID(), email: "member@synthetic.example", role: "member" as const };
    await store.createTeamAccount(member);
    await store.saveConfig({ ...config, schedulingCalendars: [account, member].map((person) => ({ accountId: person.id, enabled: true, hours: config.bookableHours })) });
    const a = new InMemoryCalendar(); const b = new InMemoryCalendar();
    const calendars = new Map([[account.id, a], [member.id, b]]);
    const team = new TeamCalendar(store, new InMemoryCalendar(), (id) => calendars.get(id)!);
    const attempt: BookingAttempt = { tenantId, callId: randomUUID(), providerCallId: "synthetic", callerName: "Synthetic Caller", callbackNumber: "+15555550100", address: "100 Main St", problemDescription: "Routine", idempotencyKey: "first", slot: { start: "2026-01-15T15:00:00.000Z", end: "2026-01-15T16:30:00.000Z" } };
    const first = await team.createEvent(attempt);
    expect(first.providerEventId).toMatch(/^fo-team:/);
    // Which teammate gets a job is ranked from its idempotency key (booking-dispatch.test.ts), not rotated.
    expect(a.events.length + b.events.length).toBe(1);
    expect(await team.verifyEvent({ tenantId, providerEventId: first.providerEventId!, slot: attempt.slot })).toBe(true);
    await team.createEvent({ ...attempt, idempotencyKey: "second", callId: randomUUID() });
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    await store.updateOwnerAccountStatus(member.id, "suspended", now);
    await expect(team.createEvent({ ...attempt, idempotencyKey: "third" })).rejects.toThrow("No teammate remains");
    const other = `shop_${randomUUID()}`;
    await expect(team.verifyEvent({ tenantId: other, providerEventId: first.providerEventId!, slot: attempt.slot })).rejects.toThrow("another shop");
    await expect(team.verifyEvent({ tenantId, providerEventId: "fo-team:not-json", slot: attempt.slot })).rejects.toThrow("Invalid team calendar event reference");
  });
});
