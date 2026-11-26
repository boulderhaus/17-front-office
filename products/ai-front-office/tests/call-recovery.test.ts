import { afterEach, describe, expect, it } from "vitest";
import { TelnyxCallHistoryClient, TelnyxProviderCallHistory, TelnyxRecordingClient, toTelnyxHistoryCallSummary } from "../src/adapters/telnyx.js";
import { backfillBlindClosures, CallRecovery, RECOVERY_CERTAIN_END_MS, recoveryRetryMs } from "../src/application/call-recovery.js";
import { BLIND_CLOSURE_FLAG, PROVIDER_HISTORY_FLAG } from "../src/application/call-service.js";
import { buildCallPath } from "../src/domain/call-path.js";
import { parseBackfillArgs } from "../scripts/backfill-call-history.js";
import { acConversation, BASE, callbackMessages, CALLER, fakeTelnyx, liveShop, type LiveShop } from "./support/live-shop.js";

/**
 * Walk 3 (2026-11-26): every real shop call ended as handoff_queued / not_billable with
 * call_ended_without_final_provider_payload and no transcript, summary, usage count or prompt callback task,
 * because the shop's TeXML app never posted the end-of-call callback. These reproduce that in production shape:
 * a shop provisioned through go-live, signed provider webhooks, and Telnyx's own conversation history.
 */
describe("a shop call whose end-of-call callback never arrives", () => {
  let shop: LiveShop;
  afterEach(async () => { await shop?.close(); });

  const CALL = "v3:walk-call-1";
  const summaries = async (callId: string) => (await shop.store.listNotifications(callId)).filter((item) => item.idempotencyKey.startsWith("call-summary:"));
  const usage = async () => (await shop.dashboard()).usage.countedCalls;

  /** The caller rang, talked for half a minute and hung up; nothing told us. */
  async function unansweredEnd(options: { intakeFailed?: boolean } = {}) {
    expect((await shop.init(CALL)).status).toBe(200);
    const startedAt = shop.clock.iso();
    const history = acConversation(CALL, startedAt, { intakeFailed: options.intakeFailed ?? true });
    shop.clock.advance(31);
    const endedAt = shop.clock.iso();
    shop.telnyx.calls.set(CALL, { is_alive: false, call_duration: 31, end_time: endedAt });
    shop.telnyx.keepConversation(CALL, history, history[history.length - 1]!.sent_at!);
    return { startedAt, endedAt, history };
  }

  it("is finished from Telnyx's conversation history minutes later, exactly as if the callback had arrived", async () => {
    shop = await liveShop();
    const { endedAt } = await unansweredEnd();
    // While nothing has arrived, the record is what the walk showed: on the call, nothing to call back, 60 left.
    expect((await shop.dashboard()).tasks).toHaveLength(0);
    expect(await usage()).toBe(0);

    // Too soon: the call may still be up, so the provider is not even asked.
    shop.clock.advance(30);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 0, waiting: 0, failed: 0 });
    expect(shop.telnyx.historyRequests()).toHaveLength(0);

    shop.clock.advance(90);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 1, waiting: 0, failed: 0 });

    const call = (await shop.store.getCallByProviderId(CALL))!;
    expect(call).toMatchObject({ outcome: "pending_confirmation", billingDisposition: "billable", durationSeconds: 31, endedAt, fromNumber: CALLER });
    expect(call.qualityFlags).toContain(PROVIDER_HISTORY_FLAG);
    expect(call.qualityFlags).not.toContain(BLIND_CLOSURE_FLAG);
    // The transcript, in the order it was spoken.
    expect(call.transcript!.split("\n")).toEqual([
      "Otto: Thanks for calling Gulf Air. How can I help?",
      "Caller: Hi, my AC stopped cooling this morning.",
      "Otto: Sorry to hear that. Can I get your name and the address?",
      "Caller: It's Dana Miller, 100 Main Street in Sarasota.",
      "Otto: Thanks, Dana. The owner will call you back shortly.",
      "Caller: Okay, thanks, bye.",
    ]);
    // What the failed mid-call save lost is on the record now (tool arguments; nulls ignored).
    expect(call.fields).toMatchObject({ callerName: "Dana Miller", address: "100 Main Street, Sarasota FL", problemDescription: "AC stopped cooling this morning", serviceCategory: "HVAC repair", callbackNumber: null });
    // The owner hears about it once, has someone to call back, and the call counts.
    expect(await summaries(call.id)).toHaveLength(1);
    expect(await shop.store.getCallbackTaskForCall(call.id)).toMatchObject({ status: "open" });
    const dashboard = await shop.dashboard();
    expect(dashboard.usage.countedCalls).toBe(1);
    expect(dashboard.tasks.filter((task) => task.status === "open")).toHaveLength(1);
    expect(dashboard.calls[0]).toMatchObject({ phone: CALLER, fields: { callerName: "Dana Miller" }, outcome: "pending_confirmation" });
    expect(dashboard.calls[0]!.transcript).toContain("Caller: Hi, my AC stopped cooling this morning.");
    expect(shop.logs.find((entry) => entry.event === "call_finalized_from_provider_history")).toMatchObject({ tenantId: shop.tenantId, transcript: true });

    // The exact lookup Telnyx documents: filter on metadata->call_control_id, then the conversation's messages.
    const lookup = shop.telnyx.requests.find((request) => request.path === "/v2/ai/conversations")!;
    expect(lookup.search.get("metadata->call_control_id")).toBe(`eq.${CALL}`);
    expect(shop.telnyx.requests.some((request) => request.path === "/v2/ai/conversations/conv-v3walkcall1/messages")).toBe(true);

    // 35 minutes later there is nothing left to close blind.
    shop.clock.advance(40 * 60);
    expect(await shop.service.recoverStaleCalls(shop.tenantId)).toBe(0);
    expect((await shop.store.getCallByProviderId(CALL))!.transcript).toContain("Dana Miller");
  });

  it("stays one call when the real callback turns up late: no second alert, no double count, nothing lost", async () => {
    shop = await liveShop();
    const { history } = await unansweredEnd();
    shop.clock.advance(120);
    await shop.recovery.runOnce();
    const call = (await shop.store.getCallByProviderId(CALL))!;
    const alertsBefore = (await shop.store.listNotifications(call.id)).map((item) => item.idempotencyKey).sort();
    const taskBefore = (await shop.store.getCallbackTaskForCall(call.id))!;

    // The late callback, signed and form-encoded as Telnyx posts it, then a duplicate delivery of it.
    shop.clock.advance(60);
    expect((await shop.callEnded(CALL, callbackMessages(history), 31)).status).toBe(200);
    expect((await shop.callEnded(CALL, callbackMessages(history), 31)).status).toBe(200);

    const after = (await shop.store.getCallByProviderId(CALL))!;
    expect((await shop.store.listNotifications(call.id)).map((item) => item.idempotencyKey).sort()).toEqual(alertsBefore);
    expect(await usage()).toBe(1);
    expect(after.transcript).toBe(call.transcript);
    expect(after.fields).toMatchObject({ callerName: "Dana Miller", address: "100 Main Street, Sarasota FL" });
    expect(after).toMatchObject({ outcome: "pending_confirmation", billingDisposition: "billable", durationSeconds: 31 });
    expect((await shop.store.getCallbackTaskForCall(call.id))!.id).toBe(taskBefore.id);
    expect((await shop.dashboard()).tasks).toHaveLength(1);
    // And recovery has nothing more to do.
    shop.clock.advance(600);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 0, waiting: 0, failed: 0 });
  });

  it("does nothing when the callback arrived on time", async () => {
    shop = await liveShop();
    const { history } = await unansweredEnd();
    expect((await shop.callEnded(CALL, callbackMessages(history), 31)).status).toBe(200);
    const call = (await shop.store.getCallByProviderId(CALL))!;
    expect(call.qualityFlags).not.toContain(PROVIDER_HISTORY_FLAG);
    shop.clock.advance(300);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 0, waiting: 0, failed: 0 });
    expect(shop.telnyx.historyRequests()).toHaveLength(0);
    expect(await summaries(call.id)).toHaveLength(1);
    expect(await usage()).toBe(1);
  });

  it("is finished once even when two servers look at the same moment", async () => {
    shop = await liveShop();
    await unansweredEnd();
    shop.clock.advance(120);
    const second = new CallRecovery(shop.store, shop.service, new TelnyxProviderCallHistory("KEY_synthetic", shop.telnyx.fetcher), shop.clock, { publicBaseUrl: BASE, recordings: null, log: () => undefined });
    const results = await Promise.all([shop.recovery.runOnce(), second.runOnce()]);
    expect(results.reduce((total, result) => total + result.recovered, 0)).toBe(1);
    const call = (await shop.store.getCallByProviderId(CALL))!;
    expect(await summaries(call.id)).toHaveLength(1);
    expect(await usage()).toBe(1);
  });

  it("leaves a call alone while Telnyx says it is still up, and while the conversation is still moving", async () => {
    shop = await liveShop();
    await shop.init(CALL);
    const startedAt = shop.clock.iso();
    shop.telnyx.calls.set(CALL, { is_alive: true });
    shop.clock.advance(150);
    // A long, quiet stretch of a live call (no tool write for two and a half minutes).
    shop.telnyx.keepConversation(CALL, acConversation(CALL, startedAt), shop.clock.iso(-5));
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 0, waiting: 0, failed: 0 });
    expect((await shop.store.getCallByProviderId(CALL))!.endedAt).toBeNull();
    // One look per 30 seconds per call, whoever asks.
    const looks = shop.telnyx.historyRequests().length;
    shop.clock.advance(10);
    await shop.recovery.runOnce();
    expect(shop.telnyx.historyRequests()).toHaveLength(looks);

    // Hung up, but the last words are only seconds old: its own callback may be about to land.
    shop.clock.advance(30);
    shop.telnyx.calls.set(CALL, { is_alive: false, call_duration: 185, end_time: shop.clock.iso(-5) });
    const recent = acConversation(CALL, startedAt).map((message, index, all) => (index === all.length - 1 ? { ...message, sent_at: shop.clock.iso(-10) } : message));
    shop.telnyx.keepConversation(CALL, recent, shop.clock.iso(-10));
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 0, waiting: 1, failed: 0 });
    expect((await shop.store.getCallByProviderId(CALL))!.endedAt).toBeNull();
    shop.clock.advance(45);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 1, waiting: 0, failed: 0 });
  });

  it("stops showing the call as live as soon as Telnyx says it is over, even before the record is back", async () => {
    shop = await liveShop();
    await shop.init(CALL);
    shop.clock.advance(120);
    shop.telnyx.calls.set(CALL, { is_alive: false, call_duration: 20, end_time: shop.clock.iso(-100) });
    const path = async () => {
      const call = (await shop.store.getCallByProviderId(CALL))!;
      return buildCallPath({ call, events: await shop.store.listToolEvents(call.id), booking: null, callbackTask: null, notifications: [], now: shop.clock.now() })!;
    };
    expect((await path()).live).toBe(true);
    // Telnyx has no conversation yet.
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 0, waiting: 1, failed: 0 });
    const ended = await path();
    expect(ended.live).toBe(false);
    expect(ended.steps.every((step) => step.state !== "current" && step.state !== "todo")).toBe(true);
    // Asked again later, the checkpoint is not written twice.
    shop.clock.advance(60);
    await shop.recovery.runOnce();
    const call = (await shop.store.getCallByProviderId(CALL))!;
    expect((await shop.store.listToolEvents(call.id)).filter((event) => event.tool === "call.end")).toHaveLength(1);
  });

  it.each(["error", "gone"] as const)("does not take a status %s as proof a young call is over, but a call past the hard time limit is over whatever the lookup says", async (status) => {
    shop = await liveShop();
    const { history } = await unansweredEnd();
    // "gone": Telnyx only forgets a call some minutes after it ends, so on a two-minute-old call it proves nothing.
    shop.telnyx.calls.set(CALL, status);
    shop.clock.advance(120);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 0, waiting: 0, failed: 0 });
    expect((await shop.store.getCallByProviderId(CALL))!.endedAt).toBeNull();
    shop.clock.advance(RECOVERY_CERTAIN_END_MS / 1000);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 1, waiting: 0, failed: 0 });
    // No call status to go by: the call ended at its last message and ran from the moment we answered.
    const call = (await shop.store.getCallByProviderId(CALL))!;
    expect(call.endedAt).toBe(history[history.length - 1]!.sent_at);
    expect(call.durationSeconds).toBe(30);
  });

  it("takes the call-length nudge's word that the call is gone when the status lookup fails", async () => {
    shop = await liveShop();
    await unansweredEnd();
    shop.telnyx.calls.set(CALL, "error");
    await shop.store.claimToolResult(CALL, "call-length:finish", shop.clock.iso(), shop.clock.iso(-60));
    await shop.store.completeToolResult(CALL, "call-length:finish", { result: "call_ended" }, shop.clock.iso());
    shop.clock.advance(120);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 1, waiting: 0, failed: 0 });
  });

  it("keeps a call where the caller asked for the owner mid-call (it is never 'in progress' again)", async () => {
    shop = await liveShop();
    await shop.init(CALL);
    const startedAt = shop.clock.iso();
    expect(await shop.tool("request-human", CALL, { from_number: CALLER, reason: "explicit_request", caller_quote: "Can I talk to the owner?" })).toMatchObject({ status: "handoff_queued" });
    expect((await shop.store.getCallByProviderId(CALL))!).toMatchObject({ outcome: "handoff_queued", endedAt: null });
    shop.clock.advance(31);
    shop.telnyx.calls.set(CALL, { is_alive: false, call_duration: 31, end_time: shop.clock.iso() });
    const history = acConversation(CALL, startedAt);
    shop.telnyx.keepConversation(CALL, history, history[history.length - 1]!.sent_at!);
    shop.clock.advance(120);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 1, waiting: 0, failed: 0 });
    const call = (await shop.store.getCallByProviderId(CALL))!;
    expect(call).toMatchObject({ outcome: "handoff_queued", billingDisposition: "billable" });
    expect(call.transcript).toContain("Caller: Hi, my AC stopped cooling this morning.");
    expect(call.endedAt).not.toBeNull();
    expect(await usage()).toBe(1);
  });

  it("links the recording only when Telnyx has one, and deletes it when the caller declined recording", async () => {
    shop = await liveShop();
    await unansweredEnd();
    shop.telnyx.recordings.add(CALL);
    shop.clock.advance(120);
    await shop.recovery.runOnce();
    expect((await shop.store.getCallByProviderId(CALL))!.recordingUrl).toBe(`${BASE}/app/provider/telnyx/recordings/${encodeURIComponent(CALL)}`);
    await shop.close();

    shop = await liveShop();
    await unansweredEnd();
    shop.telnyx.recordings.add(CALL);
    await shop.tool("save-intake", CALL, { from_number: CALLER, problem_description: "AC stopped cooling", recording_disclosure_declined: true });
    shop.clock.advance(120);
    await shop.recovery.runOnce();
    expect((await shop.store.getCallByProviderId(CALL))!).toMatchObject({ recordingUrl: null, consentState: "declined" });
    expect(shop.telnyx.recordings.has(CALL)).toBe(false);
  });

  it("closes the call blind after 35 minutes only when Telnyx has nothing, and looks one last time first", async () => {
    shop = await liveShop();
    await shop.init(CALL);
    const startedAt = shop.clock.iso();
    shop.telnyx.calls.set(CALL, "gone");
    shop.clock.advance(36 * 60);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 0, waiting: 1, failed: 0 });
    // Telnyx found the conversation after all, between recovery's last look and the blind closure.
    const history = acConversation(CALL, startedAt);
    shop.telnyx.keepConversation(CALL, history, history[history.length - 1]!.sent_at!);
    expect(await shop.service.recoverStaleCalls(shop.tenantId, undefined, (call) => shop.recovery.lastChance(call))).toBe(0);
    expect((await shop.store.getCallByProviderId(CALL))!).toMatchObject({ outcome: "pending_confirmation", billingDisposition: "billable" });
    await shop.close();

    shop = await liveShop();
    await shop.init(CALL);
    shop.telnyx.calls.set(CALL, "gone");
    shop.clock.advance(36 * 60);
    expect(await shop.service.recoverStaleCalls(shop.tenantId, undefined, (call) => shop.recovery.lastChance(call))).toBe(1);
    const blind = (await shop.store.getCallByProviderId(CALL))!;
    expect(blind).toMatchObject({ outcome: "handoff_queued", billingDisposition: "not_billable", transcript: null, qualityFlags: [BLIND_CLOSURE_FLAG] });
    // Even then the owner knows who to call back.
    expect((await shop.dashboard()).calls[0]!.phone).toBe(CALLER);
  });

  it("keeps trying through a Telnyx outage without stopping other calls", async () => {
    shop = await liveShop();
    await unansweredEnd();
    shop.telnyx.state.conversationsDown = true;
    shop.clock.advance(120);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 0, waiting: 0, failed: 1 });
    expect(shop.logs.find((entry) => entry.event === "call_recovery_failed")).toMatchObject({ tenantId: shop.tenantId });
    shop.telnyx.state.conversationsDown = false;
    shop.clock.advance(31);
    expect(await shop.recovery.runOnce()).toEqual({ recovered: 1, waiting: 0, failed: 0 });
  });

  it("looks often while a call is fresh and rarely once it is old", () => {
    expect(recoveryRetryMs(2 * 60_000)).toBe(30_000);
    expect(recoveryRetryMs(20 * 60_000)).toBe(120_000);
    expect(recoveryRetryMs(3 * 60 * 60_000)).toBe(30 * 60_000);
  });
});

describe("a call that was already closed blind", () => {
  let shop: LiveShop;
  afterEach(async () => { await shop?.close(); });
  const CALL = "v3:walk-call-2";

  /** The walk: 35 minutes of nothing, then the blind closure alerted the owner. */
  async function blindClosed(config: Parameters<typeof liveShop>[0] = {}) {
    shop = await liveShop(config);
    await shop.init(CALL);
    const startedAt = shop.clock.iso();
    const history = acConversation(CALL, startedAt, { intakeFailed: true });
    shop.clock.advance(36 * 60);
    expect(await shop.service.recoverStaleCalls(shop.tenantId)).toBe(1);
    const call = (await shop.store.getCallByProviderId(CALL))!;
    expect(call.qualityFlags).toEqual([BLIND_CLOSURE_FLAG]);
    expect((await shop.dashboard()).tasks[0]).toMatchObject({ status: "open", reason: "Call dropped: call them back" });
    return { startedAt, history, call, notifications: (await shop.store.listNotifications(call.id)).map((item) => item.idempotencyKey).sort() };
  }
  const backfill = (dryRun: boolean, days = 3) => backfillBlindClosures({ store: shop.store, service: shop.service, history: new TelnyxProviderCallHistory("KEY_synthetic", shop.telnyx.fetcher), clock: shop.clock, publicBaseUrl: BASE, recordings: new TelnyxRecordingClient("KEY_synthetic", shop.telnyx.fetcher), days, dryRun });

  it("is repaired by the backfill: the record only, nobody texted or alerted again", async () => {
    const { history, call, notifications } = await blindClosed({ config: { customerSmsEnabled: true } });
    // The blind closure texted the caller and alerted the owner once.
    expect(notifications).toEqual([`missed-call-text:${call.id}`, `recovery-summary:${call.id}:sms:owner-primary`]);
    shop.telnyx.keepConversation(CALL, history, history[history.length - 1]!.sent_at!);
    shop.clock.advance(3 * 60 * 60);

    // Dry run: says what would change, with id suffixes only, and changes nothing.
    const before = shop.telnyx.requests.length;
    const dry = await backfill(true);
    expect(dry).toEqual([{ call: call.id.slice(-6), tenant: shop.tenantId.slice(-6), status: "would_repair", changes: { transcript: true, callerName: true, address: true, problem: true, durationSeconds: 30, counted: true } }]);
    expect(JSON.stringify(dry)).not.toMatch(/Dana|Main Street|\+1555|AC stopped/);
    expect(await shop.store.getCallByProviderId(CALL)).toEqual(call);
    expect(shop.telnyx.requests.slice(before).map((request) => request.method)).toEqual(["GET", "GET"]);

    const report = await backfill(false);
    expect(report).toEqual([{ call: call.id.slice(-6), tenant: shop.tenantId.slice(-6), status: "repaired", changes: { transcript: true, callerName: true, address: true, problem: true, durationSeconds: 30, counted: true, outcome: "pending_confirmation", callbackTask: "open" } }]);
    const repaired = (await shop.store.getCallByProviderId(CALL))!;
    expect(repaired).toMatchObject({ outcome: "pending_confirmation", billingDisposition: "billable", durationSeconds: 30, endedAt: history[history.length - 1]!.sent_at });
    expect(repaired.qualityFlags).toContain(PROVIDER_HISTORY_FLAG);
    expect(repaired.qualityFlags).not.toContain(BLIND_CLOSURE_FLAG);
    expect(repaired.transcript).toContain("Caller: It's Dana Miller, 100 Main Street in Sarasota.");
    expect(repaired.fields).toMatchObject({ callerName: "Dana Miller", address: "100 Main Street, Sarasota FL", problemDescription: "AC stopped cooling this morning" });
    // Not one new notification of any kind: no caller text, no owner alert, no usage alert.
    expect((await shop.store.listNotifications(call.id)).map((item) => item.idempotencyKey).sort()).toEqual(notifications);
    expect([...shop.store.notifications.values()].filter((item) => item.callId === null && item.createdAt >= shop.clock.iso(-60))).toEqual([]);
    const dashboard = await shop.dashboard();
    expect(dashboard.usage.countedCalls).toBe(1);
    expect(dashboard.tasks).toHaveLength(1);
    // The task no longer says the call dropped.
    expect(dashboard.tasks[0]).toMatchObject({ status: "open", reason: "Check the details and call back" });

    // Running it again finds nothing left to repair.
    expect(await backfill(false)).toEqual([]);
  });

  it("keeps a callback the owner already marked done, and never books the calendar", async () => {
    const { history, call } = await blindClosed({ config: { bookingMode: "direct", requireDiagnosticFeeAcceptance: false } });
    const task = (await shop.store.getCallbackTaskForCall(call.id))!;
    await shop.store.saveCallbackTask({ ...task, status: "completed", completedAt: shop.clock.iso(), completionSource: "owner" });
    // The caller had confirmed a time on the call; the history says so.
    const slot = "2026-11-27T15:00:00.000Z";
    const withSlot = [...history, { role: "assistant", text: null, sent_at: history[history.length - 1]!.sent_at!, tool_calls: [{ id: "tool-3", type: "function" as const, function: { name: "book_slot", arguments: JSON.stringify({ provider_call_id: CALL, slot_start: slot, caller_name: "Dana Miller", callback_number: CALLER, address: "100 Main Street, Sarasota FL", service_category: "HVAC repair", problem_description: "AC stopped cooling this morning", explicit_confirmation: true, diagnostic_fee_accepted: false }) } }] }];
    shop.telnyx.keepConversation(CALL, withSlot, history[history.length - 1]!.sent_at!);
    expect((await backfill(false))[0]).toMatchObject({ status: "repaired", changes: { callbackTask: "completed" } });
    expect(shop.calendar.events).toEqual([]);
    expect(await shop.store.getBookingForCall(call.id)).toMatchObject({ status: "pending", requestedStart: slot });
    expect((await shop.store.getCallbackTaskForCall(call.id))!.status).toBe("completed");
  });

  it("is left as it is when Telnyx has no conversation, and calls outside the window are not touched", async () => {
    const { history, call } = await blindClosed();
    expect(await backfill(false)).toEqual([{ call: call.id.slice(-6), tenant: shop.tenantId.slice(-6), status: "no_history" }]);
    expect(await shop.store.getCallByProviderId(CALL)).toEqual(call);
    shop.telnyx.keepConversation(CALL, history, history[history.length - 1]!.sent_at!);
    shop.clock.advance(4 * 24 * 60 * 60);
    expect(await backfill(false, 3)).toEqual([]);
    expect(await backfill(true, 5)).toHaveLength(1);
  });

  it("is repaired quietly by a real callback that arrives after the blind closure", async () => {
    const { history, call, notifications } = await blindClosed({ config: { customerSmsEnabled: true } });
    expect((await shop.callEnded(CALL, callbackMessages(history), 31)).status).toBe(200);
    const repaired = (await shop.store.getCallByProviderId(CALL))!;
    expect(repaired).toMatchObject({ outcome: "pending_confirmation", billingDisposition: "billable", durationSeconds: 31 });
    expect(repaired.transcript).toContain("Caller: Hi, my AC stopped cooling this morning.");
    expect(repaired.qualityFlags).not.toContain(BLIND_CLOSURE_FLAG);
    expect((await shop.store.listNotifications(call.id)).map((item) => item.idempotencyKey).sort()).toEqual(notifications);
    expect((await shop.dashboard()).usage.countedCalls).toBe(1);
  });
});

describe("backfill script arguments", () => {
  it("repairs three days by default, takes --dry-run and --days, and refuses anything else", () => {
    expect(parseBackfillArgs([])).toEqual({ days: 3, dryRun: false });
    expect(parseBackfillArgs(["--dry-run", "--days", "7"])).toEqual({ days: 7, dryRun: true });
    expect(parseBackfillArgs(["--days=1"])).toEqual({ days: 1, dryRun: false });
    expect(() => parseBackfillArgs(["--days", "0"])).toThrow("whole number");
    expect(() => parseBackfillArgs(["--days"])).toThrow("whole number");
    expect(() => parseBackfillArgs(["--apply"])).toThrow("Unknown argument");
  });
});

describe("Telnyx call history client", () => {
  const CALL = "v3:history-call";

  it("reads a paged, newest-first conversation into spoken order and keeps tool arguments", async () => {
    const telnyx = fakeTelnyx();
    const startedAt = "2026-11-26T13:49:00.000Z";
    const history = acConversation(CALL, startedAt);
    telnyx.keepConversation(CALL, history, history[history.length - 1]!.sent_at!);
    telnyx.state.pageSize = 4;
    telnyx.state.newestFirst = true;
    const found = (await new TelnyxCallHistoryClient("k", telnyx.fetcher).conversation(CALL))!;
    expect(found.endUserTarget).toBe(CALLER);
    expect(found.messages.map((message) => message.role)).toEqual(history.map((message) => message.role));
    expect(found.messages.filter((message) => message.content).map((message) => message.content)[1]).toBe("Hi, my AC stopped cooling this morning.");
    expect(telnyx.requests.filter((request) => request.path.endsWith("/messages")).map((request) => request.search.get("page[number]"))).toEqual(["1", "2", "3"]);

    const summary = toTelnyxHistoryCallSummary({ history: found, tenantId: "shop_x", providerCallId: CALL, startedAt, receivedAt: new Date("2026-11-26T15:00:00.000Z"), recordingUrl: null });
    expect(summary).toMatchObject({ providerCallId: CALL, tenantId: "shop_x", durationSeconds: 30, endedAt: "2026-11-26T13:49:30.000Z", fromNumber: CALLER, consentState: "unknown" });
    expect(summary.fields).toMatchObject({ callerName: "Dana Miller", callbackNumber: null, address: "100 Main Street, Sarasota FL" });
    // Telnyx's own call status wins when it still has it.
    expect(toTelnyxHistoryCallSummary({ history: found, tenantId: "shop_x", providerCallId: CALL, startedAt, endedAt: "2026-11-26T13:49:41.000Z", durationSeconds: 41, receivedAt: new Date(), recordingUrl: null })).toMatchObject({ durationSeconds: 41, endedAt: "2026-11-26T13:49:41.000Z" });
  });

  it("drops malformed messages, accepts object tool arguments and zone-less timestamps", async () => {
    const telnyx = fakeTelnyx();
    telnyx.keepConversation(CALL, [
      { role: "assistant", text: "How can I help?", sent_at: "2026-11-26T13:49:02.123456" },
      { role: "narrator", text: "not a role we know", sent_at: "2026-11-26T13:49:03Z" },
      { role: "user", text: "No heat.", created_at: "2026-11-26 13:49:05" },
      { role: "assistant", text: null, sent_at: "2026-11-26T13:49:06Z", tool_calls: [{ id: "t", type: "function", function: { name: "save_intake", arguments: { caller_name: "Dana Miller" } as unknown as string } }, { id: "bad", type: "function", function: {} as never }] },
    ], "2026-11-26T13:49:06Z");
    const found = (await new TelnyxCallHistoryClient("k", telnyx.fetcher).conversation(CALL))!;
    expect(found.messages.map((message) => [message.role, message.timestamp])).toEqual([
      ["assistant", "2026-11-26T13:49:02.123Z"], ["user", "2026-11-26T13:49:05.000Z"], ["assistant", "2026-11-26T13:49:06.000Z"],
    ]);
    expect(found.messages[2]!.tool_calls).toEqual([{ id: "t", type: "function", function: { name: "save_intake", arguments: "{\"caller_name\":\"Dana Miller\"}" } }]);
  });

  it("answers null for a call Telnyx has no conversation for, and never accepts another call's conversation", async () => {
    const telnyx = fakeTelnyx();
    expect(await new TelnyxCallHistoryClient("k", telnyx.fetcher).conversation(CALL)).toBeNull();
    // A filter that matched nothing we asked for (a provider bug) must not hand us someone else's call.
    const wrong = (async () => new Response(JSON.stringify({ data: [{ id: "conv-other", metadata: { call_control_id: "v3:someone-else" }, last_message_at: "2026-11-26T13:00:00Z" }] }))) as unknown as typeof fetch;
    expect(await new TelnyxCallHistoryClient("k", wrong).conversation(CALL)).toBeNull();
  });

  it("reads call status: up, over with its length, gone, or unknown on an error", async () => {
    const telnyx = fakeTelnyx();
    const client = new TelnyxCallHistoryClient("k", telnyx.fetcher);
    telnyx.calls.set(CALL, { is_alive: true });
    expect(await client.callState(CALL)).toEqual({ status: "alive", durationSeconds: null, endedAt: null });
    telnyx.calls.set(CALL, { is_alive: false, call_duration: 95, end_time: "2026-11-26T13:50:35Z" });
    expect(await client.callState(CALL)).toEqual({ status: "ended", durationSeconds: 95, endedAt: "2026-11-26T13:50:35.000Z" });
    telnyx.calls.set(CALL, "gone");
    expect(await client.callState(CALL)).toEqual({ status: "gone", durationSeconds: null, endedAt: null });
    telnyx.calls.set(CALL, "error");
    expect(await client.callState(CALL)).toEqual({ status: "unknown", durationSeconds: null, endedAt: null });
    expect(telnyx.requests[0]!.path).toBe(`/v2/calls/${CALL}`);
  });
});
