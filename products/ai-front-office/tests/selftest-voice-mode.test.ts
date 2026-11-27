import { describe, expect, it } from "vitest";
import { EXPECTED_TOOL_EVENTS, labCallerVoice, toolEventResults, verdict } from "../scripts/selftest-call.js";
import { recordedSetupTools, setupVerdict } from "../scripts/selftest-setup-call.js";

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
  });
});
