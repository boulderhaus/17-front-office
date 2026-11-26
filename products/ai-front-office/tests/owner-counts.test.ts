import { afterEach, describe, expect, it } from "vitest";
import { acConversation, callbackMessages, CALLER, liveShop, ownerAppNumbers, type LiveShop } from "./support/live-shop.js";

/**
 * Walk 3 (CALL-04, 05, 06, 07, 12): after a real shop call the owner app still said "You're all caught up",
 * "Nobody's waiting on a reply", 60 calls left, "On the call", Length "Unknown", Category "Not classified", and
 * Otto's path looked live with step 6 ticked while 3 to 5 were not. These read the owner API the app reads,
 * through the app's own derive rules, before and after a shop call ends both ways it can: the end-of-call
 * callback, and (when it never arrives) Telnyx's own conversation history.
 */
describe("the owner app's numbers after a shop call", () => {
  let shop: LiveShop;
  afterEach(async () => { await shop?.close(); });
  const CALL = "v3:counts-call-1";

  type Path = { live: boolean; ended: boolean; done: number; steps: Array<{ key: string; state: string; note: string | null }> };
  const detail = async (callId: string) => await shop.callDetail(callId) as unknown as { call: { outcome: string; durationSeconds: number | null; endedAt: string | null; fields: { serviceCategory: string | null; address: string | null } }; path: Path | null };

  /** What the call page shows: outcome, Length, Category, and Otto's path. */
  async function callPage() {
    const call = (await shop.dashboard()).calls.find((item) => item.phone === CALLER)!;
    return { id: call.id, ...await detail(call.id) };
  }

  async function midCallTools() {
    await shop.tool("triage", CALL, { from_number: CALLER, caller_name: null, problem_description: "AC stopped cooling this morning", llm_score: 0.1, llm_reason: null });
    await shop.tool("check-service-area", CALL, { address: "100 Main Street, Sarasota FL" });
  }

  it.each([
    ["the end-of-call callback", "callback"],
    ["Telnyx's conversation history, when the callback never comes", "history"],
  ] as const)("moves every counter once Otto took a message, finished through %s", async (_how, how) => {
    shop = await liveShop();
    const before = await ownerAppNumbers(await shop.dashboard());
    expect(before).toMatchObject({ toCallBack: 0, allCaughtUp: true, jobsNeedingReply: 0, answered: 0 });

    expect((await shop.init(CALL)).status).toBe(200);
    const startedAt = shop.clock.iso();
    await midCallTools();
    // While the call is up: on the call, nothing counted yet, path live.
    const during = await callPage();
    expect(during.call.outcome).toBe("in_progress");
    expect(during.path?.live).toBe(true);

    const history = acConversation(CALL, startedAt);
    shop.clock.advance(31);
    if (how === "callback") {
      expect((await shop.callEnded(CALL, callbackMessages(history), 31)).status).toBe(200);
    } else {
      shop.telnyx.calls.set(CALL, { is_alive: false, call_duration: 31, end_time: shop.clock.iso() });
      shop.telnyx.keepConversation(CALL, history, history[history.length - 1]!.sent_at!);
      shop.clock.advance(120);
      expect(await shop.recovery.runOnce()).toMatchObject({ recovered: 1 });
    }

    const after = await ownerAppNumbers(await shop.dashboard());
    expect(after.callsLeft).toBe(before.callsLeft - 1);
    expect(after.answered).toBe(before.answered + 1);
    expect(after.toCallBack).toBe(1);
    expect(after.allCaughtUp).toBe(false);
    expect(after.jobsNeedingReply).toBe(1);

    const page = await callPage();
    expect(page.call.outcome).not.toBe("in_progress");
    expect(page.call.endedAt).not.toBeNull();
    expect(page.call.durationSeconds).toBe(31);
    expect(page.call.fields.serviceCategory).toBe("HVAC repair");
    // Otto's path: ended (even while the record settles), and ticked for exactly what was captured, in order.
    expect(page.path!.ended).toBe(true);
    expect(page.path!.steps.some((step) => step.state === "current")).toBe(false);
    shop.clock.advance(30);
    const settled = await detail(page.id);
    expect(settled.path!.live).toBe(false);
    page.path = settled.path;
    const state = Object.fromEntries(page.path!.steps.map((step) => [step.key, step.state]));
    expect(state).toMatchObject({ greeting: "done", service_check: "done", problem: "done", safety: "done", caller: "done", address: "done", wrap_up: "done" });
    expect(page.path!.steps.some((step) => step.state === "current" || step.state === "todo")).toBe(false);

    // A second, duplicate end never counts the call twice.
    if (how === "callback") await shop.callEnded(CALL, callbackMessages(history), 31);
    else await shop.recovery.runOnce();
    expect(await ownerAppNumbers(await shop.dashboard())).toEqual(after);
  });

  it("moves Booked when Otto booked the visit", async () => {
    shop = await liveShop({ config: { bookingMode: "direct" } });
    const before = await ownerAppNumbers(await shop.dashboard());
    expect((await shop.init(CALL)).status).toBe(200);
    const startedAt = shop.clock.iso();
    await midCallTools();
    const windowStart = new Date(Date.parse(startedAt) + 86_400_000).toISOString();
    const windowEnd = new Date(Date.parse(startedAt) + 4 * 86_400_000).toISOString();
    const offered = await shop.tool("check-availability", CALL, { window_start: windowStart, window_end: windowEnd }) as { slots: Array<{ start: string }> };
    expect(offered.slots.length).toBeGreaterThan(0);
    const booked = await shop.tool("book", CALL, { slot_start: offered.slots[0]!.start, caller_name: "Dana Miller", callback_number: CALLER, address: "100 Main Street, Sarasota FL", service_category: "HVAC repair", problem_description: "AC stopped cooling this morning", explicit_confirmation: true, diagnostic_fee_accepted: true });
    expect(booked.status).toBe("confirmed");
    shop.clock.advance(31);
    await shop.callEnded(CALL, callbackMessages(acConversation(CALL, startedAt)), 31);

    const after = await ownerAppNumbers(await shop.dashboard());
    expect(after.booked).toBe(before.booked + 1);
    expect(after.callsLeft).toBe(before.callsLeft - 1);
    const page = await callPage();
    expect(page.call.outcome).toBe("booked");
    expect(page.path!.steps.find((step) => step.key === "booking")).toMatchObject({ state: "done" });
  });

  it("never ticks the address when the area was checked but no address was saved", async () => {
    shop = await liveShop();
    expect((await shop.init(CALL)).status).toBe(200);
    const startedAt = shop.clock.iso();
    await midCallTools();
    // The caller hung up before any address was saved: the conversation carries no save.
    const history = acConversation(CALL, startedAt).filter((message) => !message.tool_calls?.some((call) => call.function.name === "save_intake") && message.tool_call_id !== "tool-2");
    shop.clock.advance(31);
    await shop.callEnded(CALL, callbackMessages(history), 31);
    shop.clock.advance(30);
    const page = await callPage();
    expect(page.call.fields.address).toBeNull();
    const address = page.path!.steps.find((step) => step.key === "address")!;
    expect(address.state).not.toBe("done");
    expect(address.note).toBe("Area checked, no address saved");
  });
});
