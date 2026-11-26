import { pathToFileURL } from "node:url";
import { BLIND_CLOSURE_FLAG, PROVIDER_HISTORY_FLAG } from "../src/application/call-service.js";
import { loadEnvironment } from "../src/config/environment.js";
import type { CallRecord } from "../src/domain/models.js";

/**
 * Post-deploy gate: one AI-to-AI call from a temporary lab caller (an assistant named fo-lab-selftest-*) to ANY
 * Call Otto line, demo or shop. It passes only when
 *   1. every voice tool Otto called during the call succeeded,
 *   2. our server finalized the call from the end-of-call callback, with a transcript, within 90 seconds of
 *      hang-up (not from provider history, not closed blind), and
 *   3. that line's shop counted exactly one more call.
 * The lab assistant and its TeXML app are deleted at the end.
 *
 *   node --import tsx scripts/selftest-call.ts --line <E.164 line> --from <E.164 lab caller id>
 *   (or SELFTEST_LINE / SELFTEST_FROM; production image: node dist/scripts/selftest-call.js ...)
 *
 * Needs TELNYX_API_KEY, TELNYX_ASSISTANT_ID (the caller copies its model, voice and transcription),
 * SELFTEST_OUTBOUND_VOICE_PROFILE_ID, and DATABASE_URL for the store. Places a real, billed call: run it on
 * purpose, after a deploy. Prints tool names, statuses and booleans only: never a number, name or caller words.
 */

const E164 = /^\+[1-9]\d{7,14}$/;
export const FINALIZE_DEADLINE_MS = 90_000;

export function parseSelftestArgs(argv: string[], env: Record<string, string | undefined>): { line: string; from: string } {
  const read = (flag: string): string | undefined => {
    const index = argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
    if (index < 0) return undefined;
    const arg = argv[index]!;
    return arg.includes("=") ? arg.slice(flag.length + 1) : argv[index + 1];
  };
  for (const arg of argv) if (arg.startsWith("--") && !/^--(line|from)(=|$)/.test(arg)) throw new Error(`Unknown argument ${arg}. Use --line and --from.`);
  const line = read("--line") ?? env.SELFTEST_LINE;
  const from = read("--from") ?? env.SELFTEST_FROM;
  if (!line || !E164.test(line)) throw new Error("Pass the line to test with --line (E.164) or SELFTEST_LINE");
  if (!from || !E164.test(from)) throw new Error("Pass the lab caller id with --from (E.164) or SELFTEST_FROM");
  if (line === from) throw new Error("The lab caller must not be the line under test");
  return { line, from };
}

export interface HistoryLike { role: string; text?: string | null; tool_call_id?: string | null; tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }> | null }
export interface ToolResult { name: string; status: string; ok: boolean }

const FAILED_STATUSES = new Set(["unavailable", "error", "failed", "invalid", "rejected"]);

/** Every tool Otto called and what our server answered, in order; ok only when the server said it worked. */
export function toolResults(messages: HistoryLike[]): ToolResult[] {
  const names = new Map<string, string>();
  const results: ToolResult[] = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function?.name ?? "unknown");
    if (message.role !== "tool") continue;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(message.text ?? "{}") as Record<string, unknown>; } catch { body = { status: "unreadable" }; }
    const status = typeof body.status === "string" ? body.status : body.ok === false ? "not_ok" : "ok";
    const ok = body.ok !== false && !FAILED_STATUSES.has(status) && status !== "unreadable" && !("error" in body);
    results.push({ name: names.get(message.tool_call_id ?? "") ?? "unknown", status, ok });
  }
  return results;
}

/** The stored call as the gate judges it: finalized by the real callback, with a transcript. */
export function finalizedByCallback(call: Pick<CallRecord, "outcome" | "endedAt" | "transcript" | "qualityFlags"> | null): boolean {
  return Boolean(call && call.outcome !== "in_progress" && call.endedAt && call.transcript?.trim()
    && !call.qualityFlags.includes(PROVIDER_HISTORY_FLAG) && !call.qualityFlags.includes(BLIND_CLOSURE_FLAG));
}

export function verdict(input: { tools: ToolResult[]; finalized: boolean; finalizeMs: number | null; usageBefore: number; usageAfter: number }): { pass: boolean; tools_ok: boolean; finalized_in_time: boolean; usage_moved_by_one: boolean } {
  const toolsOk = input.tools.length > 0 && input.tools.every((tool) => tool.ok);
  const inTime = input.finalized && input.finalizeMs !== null && input.finalizeMs <= FINALIZE_DEADLINE_MS;
  const usage = input.usageAfter === input.usageBefore + 1;
  return { pass: toolsOk && inTime && usage, tools_ok: toolsOk, finalized_in_time: inTime, usage_moved_by_one: usage };
}

const CALLER_SCRIPT = `You are Dana, a homeowner phoning a heating and air company. You are a real person; never say you are an AI. Keep this call short.
Your furnace stopped working last night and there is no heat in the house. Say that first, in one sentence, after the receptionist greets you.
Answer each question with one short sentence. If asked: your name is Dana Miller; the number you are calling from is the best callback number; the address is 100 Main Street, Springfield, Illinois 62701; any time tomorrow morning works.
Accept whatever the receptionist offers. Never ask for a person. When the receptionist says someone will follow up or starts wrapping up, say "Okay, thanks, bye." and stop talking.`;

async function main(): Promise<void> {
  const { line, from } = parseSelftestArgs(process.argv.slice(2), process.env);
  const env = loadEnvironment(process.env);
  const key = env.TELNYX_API_KEY;
  const template = env.TELNYX_ASSISTANT_ID;
  const profile = process.env.SELFTEST_OUTBOUND_VOICE_PROFILE_ID;
  if (!key || !template || !profile) throw new Error("TELNYX_API_KEY, TELNYX_ASSISTANT_ID and SELFTEST_OUTBOUND_VOICE_PROFILE_ID are required");
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const telnyx = async (method: string, path: string, body?: unknown): Promise<[number, Record<string, any>]> => {
    const response = await fetch(`https://api.telnyx.com/v2${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    try { return [response.status, JSON.parse(text) as Record<string, any>]; } catch { return [response.status, {}]; }
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const say = (...parts: unknown[]) => console.log(parts.map((part) => typeof part === "string" ? part.replace(/\+\d{8,15}/g, "+X") : JSON.stringify(part)).join(" "));

  const { createRuntime } = await import("../src/runtime.js");
  const runtime = await createRuntime(env);
  let lab: { id: string; texml: string | null } | null = null;
  let pass = false;
  try {
    // A shop's own line, or the demo line (the default shop).
    const tenantId = await runtime.store.getTenantIdByInboundNumber(line) ?? (line === env.TELNYX_FROM_NUMBER ? env.DEFAULT_TENANT_ID : null);
    if (!tenantId) throw new Error("No shop answers on that line");
    const windowStart = new Date(Date.now() - 86_400_000).toISOString();
    const windowEnd = new Date(Date.now() + 86_400_000).toISOString();
    const usage = async () => (await runtime.store.getUsageSummary(tenantId, windowStart, windowEnd)).billableCalls;
    const usageBefore = await usage();

    const [, base] = await telnyx("GET", `/ai/assistants/${encodeURIComponent(template)}`);
    const source = (base.data ?? base) as Record<string, any>;
    const [created, assistant] = await telnyx("POST", "/ai/assistants", {
      name: `fo-lab-selftest-${Date.now().toString(36)}`, model: source.model, enabled_features: ["telephony"], instructions: CALLER_SCRIPT, greeting: "",
      tools: [{ type: "hangup", hangup: { description: "End the call after you have said goodbye, or after the receptionist says goodbye." } }],
      ...(source.transcription ? { transcription: source.transcription } : {}),
      ...(source.voice_settings ? { voice_settings: source.voice_settings } : {}),
      telephony_settings: { time_limit_secs: 150, user_idle_timeout_secs: 20, recording_settings: { enabled: false } },
    });
    if (created >= 300) throw new Error(`Could not create the lab caller (${created})`);
    const made = (assistant.data ?? assistant) as Record<string, any>;
    lab = { id: String(made.id), texml: made.telephony_settings?.default_texml_app_id ?? null };
    if (!lab.texml) throw new Error("The lab caller has no TeXML app");
    const [, app] = await telnyx("GET", `/texml_applications/${encodeURIComponent(lab.texml)}`);
    // The lab caller's own app: no callback to us (only the line under test reports its calls), and a voice profile to dial out.
    const [patched] = await telnyx("PATCH", `/texml_applications/${encodeURIComponent(lab.texml)}`, { friendly_name: app.data?.friendly_name, voice_url: app.data?.voice_url, status_callback: "", outbound: { outbound_voice_profile_id: profile } });
    say("lab_caller_ready", patched < 300);
    await sleep(3000);

    const startedIso = new Date(Date.now() - 5000).toISOString();
    const [dialed] = await telnyx("POST", `/texml/ai_calls/${encodeURIComponent(lab.texml)}`, { From: from, To: line, AIAssistantId: lab.id });
    say("call_placed", dialed < 300);
    if (dialed >= 300) throw new Error(`Call was not placed (${dialed})`);

    // Otto's side of the call: the conversation on the line under test, not the lab caller's own.
    let conversation: Record<string, any> | null = null;
    for (let attempt = 0; attempt < 30 && !conversation; attempt += 1) {
      await sleep(2000);
      const [, list] = await telnyx("GET", "/ai/conversations?order=created_at.desc&limit=10");
      conversation = ((list.data ?? []) as Array<Record<string, any>>).find((item) => item.created_at > startedIso && item.metadata?.telnyx_agent_target === line && item.metadata?.assistant_id !== lab!.id) ?? null;
    }
    say("otto_answered", Boolean(conversation));
    if (!conversation) throw new Error("Otto never answered");
    const callId = String(conversation.metadata?.call_control_id ?? "");

    for (let attempt = 0; attempt < 80; attempt += 1) {
      await sleep(3000);
      const [status, call] = await telnyx("GET", `/calls/${encodeURIComponent(callId)}`);
      if (status === 404 || call.data?.is_alive === false) break;
    }
    const hungUpAt = Date.now();
    say("call_ended", true);

    let finalizeMs: number | null = null;
    let stored: CallRecord | null = null;
    while (Date.now() - hungUpAt <= FINALIZE_DEADLINE_MS + 15_000) {
      stored = await runtime.store.getCallByProviderId(callId);
      if (finalizedByCallback(stored)) { finalizeMs = Date.now() - hungUpAt; break; }
      await sleep(3000);
    }
    say("finalized_by_callback", finalizedByCallback(stored), "within_90s", finalizeMs !== null && finalizeMs <= FINALIZE_DEADLINE_MS, "transcript", Boolean(stored?.transcript?.trim()));

    let messages: HistoryLike[] = [];
    for (let page = 1; page < 10; page += 1) {
      const [, body] = await telnyx("GET", `/ai/conversations/${encodeURIComponent(String(conversation.id))}/messages?page[number]=${page}&page[size]=100`);
      messages = messages.concat((body.data ?? []) as HistoryLike[]);
      if (!body.meta || page >= Number(body.meta.total_pages ?? 1)) break;
    }
    messages.sort((left: any, right: any) => String(left.sent_at ?? left.created_at).localeCompare(String(right.sent_at ?? right.created_at)));
    const tools = toolResults(messages);
    for (const tool of tools) say("tool", tool.name, tool.status, tool.ok);

    const usageAfter = await usage();
    const result = verdict({ tools, finalized: finalizedByCallback(stored), finalizeMs, usageBefore, usageAfter });
    say(result);
    pass = result.pass;
  } catch (error) {
    say("error", error instanceof Error ? error.message : "unknown");
  } finally {
    if (lab) {
      const [, check] = await telnyx("GET", `/ai/assistants/${encodeURIComponent(lab.id)}`);
      // Only ever delete what this script made.
      if (String(check.name ?? check.data?.name ?? "").startsWith("fo-lab-selftest-")) {
        const [deleted] = await telnyx("DELETE", `/ai/assistants/${encodeURIComponent(lab.id)}`);
        say("lab_caller_deleted", deleted < 300);
        if (lab.texml) {
          const [appDeleted] = await telnyx("DELETE", `/texml_applications/${encodeURIComponent(lab.texml)}`);
          say("lab_app_deleted", appDeleted < 300);
        }
      }
    }
    await runtime.close();
  }
  say(pass ? "SELFTEST PASS" : "SELFTEST FAIL");
  if (!pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
