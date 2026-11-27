import { describe, expect, it } from "vitest";
import { EXPECTED_TOOL_EVENTS, labCallerVoice, toolEventResults, verdict } from "../scripts/selftest-call.js";
import { recordedSetupTools, setupVerdict } from "../scripts/selftest-setup-call.js";
import { FAILED_TOOL_STATUSES, TOOL_FAILED_EVENT } from "../src/voice/tool-results.js";
import { CALLER, liveShop, signed } from "./support/live-shop.js";

// Synthetic ids only: no real model, voice, number or assistant appears in this file.
const TEXT_MODEL = "synthetic/text-model";
const TTS_VOICE = "Synthetic.Tts";
/** The template assistant the lab caller copies from, as Telnyx reports it in each mode. */
const standardAssistant = { data: { model: TEXT_MODEL, delegation_settings: null, voice_settings: { voice: TTS_VOICE, voice_speed: 1 } } };
const s2sAssistant = { data: { model: "synthetic/speech-model", delegation_settings: { enabled: true, mode: "telnyx", model: TEXT_MODEL, speak_results: true }, voice_settings: { voice: "SyntheticVoice.One" } } };

describe("the post-deploy selftests on a speech-to-speech line", () => {
  const event = (tool: string, result: "success" | "failed" | "unknown" = "success", redactedError: string | null = null) => ({ tool, result, redactedError });

  it("reads the call's tool_events rows, without the call-path markers", () => {
    expect(toolEventResults([event("call.start"), event("call.triage"), event("call.intake"), event("calendar.availability", "failed", "calendar unavailable"), event("calendar.book", "unknown"), event("coverage.check", "success", "odd"), event("call.end")])).toEqual([
      { name: "call.triage", status: "success", ok: true },
      { name: "call.intake", status: "success", ok: true },
      { name: "calendar.availability", status: "failed", ok: false },
      { name: "calendar.book", status: "unknown", ok: false },
      { name: "coverage.check", status: "success", ok: false },
    ]);
    expect(EXPECTED_TOOL_EVENTS).toEqual(["call.triage", "call.intake"]);
  });

  it("passes a speech-to-speech call on its tool_events when the history shows no tools, and only then", () => {
    const base = { tools: [], finalized: true, finalizeMs: 12_000, usageBefore: 4, usageAfter: 5 };
    const ran = toolEventResults([event("call.start"), event("call.triage"), event("call.intake"), event("coverage.check"), event("call.end")]);
    expect(verdict({ ...base, speechToSpeech: true, toolEvents: ran })).toEqual({ pass: true, tools_ok: true, finalized_in_time: true, usage_moved_by_one: true });
    // A standard line is judged from the history, as before: no tools there is a failure.
    expect(verdict({ ...base, toolEvents: ran }).tools_ok).toBe(false);
    expect(verdict({ ...base, speechToSpeech: false, toolEvents: ran }).pass).toBe(false);
    // An expected tool never ran, nothing ran, or one recorded an error.
    expect(verdict({ ...base, speechToSpeech: true, toolEvents: toolEventResults([event("call.start"), event("call.triage"), event("call.end")]) }).tools_ok).toBe(false);
    expect(verdict({ ...base, speechToSpeech: true, toolEvents: [] }).tools_ok).toBe(false);
    expect(verdict({ ...base, speechToSpeech: true }).tools_ok).toBe(false);
    expect(verdict({ ...base, speechToSpeech: true, toolEvents: [...ran, ...toolEventResults([event("calendar.availability", "failed", "calendar unavailable")])] }).tools_ok).toBe(false);
    // A failed tool the history does show still fails it.
    expect(verdict({ ...base, speechToSpeech: true, toolEvents: ran, tools: [{ name: "save_intake", status: "unavailable", ok: false }] }).tools_ok).toBe(false);
    // Every other condition still has to hold.
    expect(verdict({ ...base, speechToSpeech: true, toolEvents: ran, finalizeMs: 91_000 }).pass).toBe(false);
    expect(verdict({ ...base, speechToSpeech: true, toolEvents: ran, usageAfter: 4 }).pass).toBe(false);
  });

  it("a voice tool our server answers with a failure leaves a failed row on the call, so a speech-to-speech call with a broken tool can't pass", async () => {
    const shop = await liveShop();
    try {
      const callId = "v3:selftest-call";
      await shop.init(callId);
      const base = { tools: [], finalized: true, finalizeMs: 12_000, usageBefore: 4, usageAfter: 5, speechToSpeech: true };
      const rows = async () => shop.store.listToolEvents((await shop.store.getCallByProviderId(callId))!.id);
      const gate = async () => verdict({ ...base, toolEvents: toolEventResults(await rows()) });
      // The lab caller's service call: triage and intake both work.
      expect(await shop.tool("triage", callId, { from_number: CALLER, problem_description: "AC stopped cooling this morning", llm_score: 0.1 })).toMatchObject({ emergency: false });
      expect(await shop.tool("save-intake", callId, { from_number: CALLER, caller_name: "Dana Miller", problem_description: "AC stopped cooling this morning" })).toMatchObject({ status: expect.any(String) });
      expect((await rows()).filter((row) => row.result !== "success")).toEqual([]);
      expect(await gate()).toMatchObject({ pass: true, tools_ok: true });
      // A later tool call is rejected (arguments the schema refuses): the model hears the fixed result...
      expect(await shop.tool("save-intake", callId, { from_number: CALLER, problem_description: "AC stopped cooling this morning", human_requested: "maybe" })).toMatchObject({ ok: false, status: "unavailable" });
      // ...and the call's own record now says a tool failed: the name and a reason code, never the error text.
      const failed = (await rows()).filter((row) => row.tool === TOOL_FAILED_EVENT);
      expect(failed).toEqual([expect.objectContaining({ tenantId: shop.tenantId, result: "failed", metadata: { tool: "save_intake", reason: "http_400" }, redactedError: "http_400" })]);
      expect(toolEventResults(failed)).toEqual([{ name: "tool.failed", status: "failed", ok: false }]);
      expect(await gate()).toMatchObject({ pass: false, tools_ok: false });
      // The same for a tool stopped by its per-call budget (the answer is limit_reached).
      const budget = "v3:selftest-budget";
      await shop.init(budget);
      const triage = { from_number: CALLER, problem_description: "AC stopped cooling this morning", llm_score: 0.1 };
      await shop.tool("triage", budget, triage);
      await shop.tool("triage", budget, triage);
      expect(await shop.tool("triage", budget, triage)).toMatchObject({ ok: false, status: "limit_reached" });
      const limited = (await shop.store.listToolEvents((await shop.store.getCallByProviderId(budget))!.id)).filter((row) => row.tool === TOOL_FAILED_EVENT);
      expect(limited.map((row) => row.metadata)).toEqual([{ tool: "triage_call", reason: "limit_budget" }]);
      // The owner's call page is unchanged by the row: the path still builds, with the problem and safety steps done.
      const call = (await shop.store.getCallByProviderId(callId))!;
      const detail = await shop.callDetail(call.id) as { path: { steps: Array<{ key: string; state: string }> } };
      expect(detail.path.steps.find((step) => step.key === "problem")).toMatchObject({ state: "done" });
    } finally { await shop.close(); }
  });

  it("never writes a failed row for a request Telnyx didn't sign for that call", async () => {
    const shop = await liveShop();
    try {
      const callId = "v3:selftest-call";
      const other = "v3:other-call";
      await shop.init(callId);
      await shop.init(other);
      const failedRows = async (id: string) => (await shop.store.listToolEvents((await shop.store.getCallByProviderId(id))!.id)).filter((row) => row.tool === TOOL_FAILED_EVENT);
      const post = (headers: Record<string, string>, body: string) => fetch(`${shop.baseUrl}/tools/save-intake`, { method: "POST", headers, body });
      // Unsigned, with the call's id in the (unsigned) header.
      const bad = JSON.stringify({ provider_call_id: callId, from_number: CALLER, human_requested: "maybe" });
      expect(await (await post({ "content-type": "application/json", "x-telnyx-call-control-id": callId }, bad)).json()).toMatchObject({ ok: false });
      // Signed for one call, with another call's id in the header: nothing lands on either call.
      const signedForOther = JSON.stringify({ provider_call_id: other, from_number: CALLER, human_requested: "maybe" });
      expect(await (await post({ ...signed(signedForOther, shop.privateKey, shop.clock.now()), "x-telnyx-call-control-id": callId }, signedForOther)).json()).toMatchObject({ ok: false });
      expect(await failedRows(callId)).toEqual([]);
      expect(await failedRows(other)).toEqual([]);
    } finally { await shop.close(); }
  });

  it("the lab caller never copies a speaking model or its voice", () => {
    expect(labCallerVoice(standardAssistant.data, TTS_VOICE)).toEqual({ model: TEXT_MODEL, voice_settings: standardAssistant.data.voice_settings });
    expect(labCallerVoice({ model: TEXT_MODEL }, TTS_VOICE)).toEqual({ model: TEXT_MODEL });
    expect(labCallerVoice(s2sAssistant.data, TTS_VOICE)).toEqual({ model: TEXT_MODEL, voice_settings: { voice: TTS_VOICE } });
  });

  it("the support-call selftest passes a speech-to-speech helper on the tool answers our server recorded", () => {
    const record = { answeredAt: "a", endedAt: "b", outcome: "done", tools: [{ name: "email_steps", status: "sent" }, { name: "get_test_result", status: "idle" }] };
    expect(recordedSetupTools(record)).toEqual([{ name: "email_steps", status: "sent", ok: true }, { name: "get_test_result", status: "idle", ok: true }]);
    expect(recordedSetupTools(null)).toEqual([]);
    expect(recordedSetupTools({ tools: [{ name: "email_steps", status: "failed" }, { name: 7 }] })).toEqual([{ name: "email_steps", status: "failed", ok: false }, { name: "unknown", status: "unreadable", ok: false }]);
    expect(setupVerdict({ tools: [], record, book: false, elapsedMs: 120_000, speechToSpeech: true })).toMatchObject({ pass: true, tools_ok: true });
    // A standard helper is judged from the history, as before.
    expect(setupVerdict({ tools: [], record, book: false, elapsedMs: 120_000 }).tools_ok).toBe(false);
    expect(setupVerdict({ tools: [], record: { ...record, tools: [] }, book: false, elapsedMs: 120_000, speechToSpeech: true }).tools_ok).toBe(false);
    expect(setupVerdict({ tools: [], record: { ...record, tools: [...record.tools, { name: "book_time", status: "failed" }] }, book: false, elapsedMs: 120_000, speechToSpeech: true }).tools_ok).toBe(false);
    expect(setupVerdict({ tools: [{ name: "email_steps", status: "unavailable", ok: false }], record, book: false, elapsedMs: 120_000, speechToSpeech: true }).tools_ok).toBe(false);
    expect(setupVerdict({ tools: [], record: { ...record, outcome: "voicemail" }, book: false, elapsedMs: 120_000, speechToSpeech: true }).pass).toBe(false);
    // What our server keeps for a helper tool it refused, rate limited or that threw (src/http/app.ts noteSetupTool).
    for (const status of ["unavailable", "error"]) {
      expect(FAILED_TOOL_STATUSES.has(status)).toBe(true);
      expect(setupVerdict({ tools: [], record: { ...record, tools: [...record.tools, { name: "get_test_result", status }] }, book: false, elapsedMs: 120_000, speechToSpeech: true }).tools_ok, status).toBe(false);
    }
  });
});
