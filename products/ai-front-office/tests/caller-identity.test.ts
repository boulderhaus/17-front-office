import { afterEach, describe, expect, it } from "vitest";
import { apiCall } from "../src/http/owner-api-model.js";
import { callerLabel } from "../web/src/lib/format.js";
import { acConversation, callbackMessages, CALLER, liveShop, type HistoryMessage, type LiveShop } from "./support/live-shop.js";

// Walk 3 (2026-11-26): both walk calls showed "Unknown caller" although the number that called was on the record.
describe("who called", () => {
  let shop: LiveShop;
  afterEach(async () => { await shop?.close(); });
  const CALL = "v3:identity-call";

  /** A caller who never gives a name: Otto has only the number the call came from. */
  const noName = (startedAt: string, callbackNumber: unknown = null): HistoryMessage[] => acConversation(CALL, startedAt).map((message) => (message.tool_calls
    ? { ...message, tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: JSON.stringify({ ...JSON.parse(call.function.arguments) as Record<string, unknown>, caller_name: null, callback_number: callbackNumber }) } })) }
    : message));

  it("shows the number that called when the caller gave no name, on every screen's label", async () => {
    shop = await liveShop();
    await shop.init(CALL);
    const history = noName(shop.clock.iso());
    shop.clock.advance(31);
    expect((await shop.callEnded(CALL, callbackMessages(history), 31)).status).toBe(200);
    const call = (await shop.dashboard()).calls[0]!;
    expect(call).toMatchObject({ phone: CALLER, fields: { callerName: null } });
    expect(callerLabel(call)).toBe("(555) 555-0110");
    // The record keeps the number that called, apart from any callback number.
    expect((await shop.store.getCallByProviderId(CALL))!.fromNumber).toBe(CALLER);
    // The server-rendered owner app says the same.
    const page = await (await fetch(`${shop.baseUrl}/app`, { headers: { cookie: shop.cookie } })).text();
    expect(page).toContain("(555) 555-0110");
    expect(page).not.toContain("Unknown caller");
  });

  it("says Unknown caller only when the number was withheld", async () => {
    shop = await liveShop();
    await shop.init(CALL, null);
    const history = noName(shop.clock.iso());
    shop.clock.advance(31);
    await shop.callEnded(CALL, callbackMessages(history), 31);
    const call = (await shop.dashboard()).calls[0]!;
    expect(call.phone).toBeNull();
    expect(callerLabel(call)).toBe("Unknown caller");
    expect(await (await fetch(`${shop.baseUrl}/app`, { headers: { cookie: shop.cookie } })).text()).toContain("Unknown caller");
  });

  it.each([
    ["a callback number in the caller's own format", "941-555-0142", "+19415550142"],
    ["a callback number with a country code and brackets", "1 (941) 555-0142", "+19415550142"],
    ["words instead of a number", "the number I'm calling from", CALLER],
    ["a number that is not a real US number", "555-01", CALLER],
  ])("keeps a number the owner can call when the end-of-call payload carries %s", async (_what, callbackNumber, expected) => {
    shop = await liveShop();
    await shop.init(CALL);
    const history = noName(shop.clock.iso(), callbackNumber);
    shop.clock.advance(31);
    await shop.callEnded(CALL, callbackMessages(history), 31);
    expect((await shop.dashboard()).calls[0]!.phone).toBe(expected);
    const stored = (await shop.store.getCallByProviderId(CALL))!;
    expect(stored.fromNumber).toBe(CALLER);
    expect(stored.fields.callbackNumber).toBe(expected === CALLER ? null : expected);
    expect(stored.qualityFlags).not.toContain("callback_number_invalid");
  });

  it("normalises a callback number saved mid-call the same way", async () => {
    shop = await liveShop();
    await shop.init(CALL);
    await shop.tool("save-intake", CALL, { from_number: CALLER, problem_description: "AC stopped cooling", callback_number: "(941) 555-0142" });
    expect((await shop.store.getCallByProviderId(CALL))!.fields.callbackNumber).toBe("+19415550142");
    await shop.tool("save-intake", CALL, { from_number: CALLER, problem_description: "AC stopped cooling, upstairs unit", callback_number: "call my wife instead" });
    expect((await shop.store.getCallByProviderId(CALL))!.fields.callbackNumber).toBe("+19415550142");
  });

  it("never lets an old record's malformed callback number hide the number that called", async () => {
    shop = await liveShop();
    await shop.init(CALL);
    const stored = (await shop.store.getCallByProviderId(CALL))!;
    expect(apiCall({ ...stored, fields: { ...stored.fields, callbackNumber: "same number" } }).phone).toBe(CALLER);
    expect(apiCall({ ...stored, fromNumber: "unknown", fields: { ...stored.fields, callbackNumber: "same number" } }).phone).toBeNull();
  });

  it("prefers the name, ignores a blank one, and formats US numbers the way an owner dials them", () => {
    const call = (callerName: string | null, phone: string | null) => ({ phone, fields: { callerName } });
    expect(callerLabel(call("Dana Miller", CALLER))).toBe("Dana Miller");
    expect(callerLabel(call("  ", CALLER))).toBe("(555) 555-0110");
    expect(callerLabel(call(null, "+442079460000"))).toBe("+442079460000");
    expect(callerLabel(call(null, null))).toBe("Unknown caller");
    expect(callerLabel(undefined)).toBe("Unknown caller");
  });
});
