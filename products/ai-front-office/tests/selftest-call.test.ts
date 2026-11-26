import { describe, expect, it } from "vitest";
import { finalizedByCallback, parseSelftestArgs, toolResults, verdict } from "../scripts/selftest-call.js";
import { BLIND_CLOSURE_FLAG, PROVIDER_HISTORY_FLAG } from "../src/application/call-service.js";

/** The post-deploy call gate's judgement, without placing a call. Synthetic 555 numbers only. */
describe("post-deploy call self-test", () => {
  const LINE = "+15555550123";
  const FROM = "+15555550188";

  it("takes any line from an argument or the environment, and never a default", () => {
    expect(parseSelftestArgs(["--line", LINE, "--from", FROM], {})).toEqual({ line: LINE, from: FROM });
    expect(parseSelftestArgs([`--line=${LINE}`], { SELFTEST_FROM: FROM })).toEqual({ line: LINE, from: FROM });
    expect(parseSelftestArgs([], { SELFTEST_LINE: LINE, SELFTEST_FROM: FROM })).toEqual({ line: LINE, from: FROM });
    expect(() => parseSelftestArgs([], { SELFTEST_FROM: FROM })).toThrow(/--line/);
    expect(() => parseSelftestArgs(["--line", "941-555-0123", "--from", FROM], {})).toThrow(/--line/);
    expect(() => parseSelftestArgs(["--line", LINE, "--from", LINE], {})).toThrow(/must not be/);
    expect(() => parseSelftestArgs(["--line", LINE, "--from", FROM, "--prod"], {})).toThrow(/Unknown argument/);
  });

  it("reads each tool's name and our server's answer, and fails any tool that did not work", () => {
    const tools = toolResults([
      { role: "assistant", tool_calls: [{ id: "t1", function: { name: "triage_call" } }] },
      { role: "tool", tool_call_id: "t1", text: JSON.stringify({ ok: true, severity: "routine" }) },
      { role: "assistant", tool_calls: [{ id: "t2", function: { name: "save_intake" } }] },
      { role: "tool", tool_call_id: "t2", text: JSON.stringify({ status: "saved", missing: [] }) },
      { role: "assistant", tool_calls: [{ id: "t3", function: { name: "save_intake" } }] },
      { role: "tool", tool_call_id: "t3", text: JSON.stringify({ ok: false, status: "unavailable" }) },
      { role: "tool", tool_call_id: "t4", text: "not json" },
    ]);
    expect(tools).toEqual([
      { name: "triage_call", status: "ok", ok: true },
      { name: "save_intake", status: "saved", ok: true },
      { name: "save_intake", status: "unavailable", ok: false },
      { name: "unknown", status: "unreadable", ok: false },
    ]);
  });

  it("counts a call as finalized only from the real callback, with a transcript", () => {
    const done = { outcome: "pending_confirmation" as const, endedAt: "2026-11-26T15:00:31Z", transcript: "Otto: Hi", qualityFlags: [] as string[] };
    expect(finalizedByCallback(done)).toBe(true);
    expect(finalizedByCallback(null)).toBe(false);
    expect(finalizedByCallback({ ...done, outcome: "in_progress" })).toBe(false);
    expect(finalizedByCallback({ ...done, transcript: " " })).toBe(false);
    expect(finalizedByCallback({ ...done, qualityFlags: [PROVIDER_HISTORY_FLAG] })).toBe(false);
    expect(finalizedByCallback({ ...done, qualityFlags: [BLIND_CLOSURE_FLAG] })).toBe(false);
  });

  it("passes only when the tools worked, the call was finalized within 90 seconds and usage moved by exactly one", () => {
    const ok = [{ name: "save_intake", status: "saved", ok: true }];
    const base = { tools: ok, finalized: true, finalizeMs: 12_000, usageBefore: 4, usageAfter: 5 };
    expect(verdict(base)).toEqual({ pass: true, tools_ok: true, finalized_in_time: true, usage_moved_by_one: true });
    expect(verdict({ ...base, tools: [] }).pass).toBe(false);
    expect(verdict({ ...base, tools: [...ok, { name: "book_slot", status: "error", ok: false }] }).pass).toBe(false);
    expect(verdict({ ...base, finalizeMs: 91_000 }).pass).toBe(false);
    expect(verdict({ ...base, finalized: false, finalizeMs: null }).pass).toBe(false);
    expect(verdict({ ...base, usageAfter: 4 }).pass).toBe(false);
    expect(verdict({ ...base, usageAfter: 6 }).pass).toBe(false);
  });
});
