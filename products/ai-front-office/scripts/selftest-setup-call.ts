import { pathToFileURL } from "node:url";
import { setupHelpClientState, TelnyxSetupCaller } from "../src/adapters/telnyx-setup-call.js";
import { loadEnvironment } from "../src/config/environment.js";
import { PLATFORM_TENANT_ID } from "../src/ports.js";
import { isSpeechToSpeechAssistant, speechToSpeechSettings } from "../src/voice/voice-mode.js";
import { labCallerVoice, statusOk, toolResults, type HistoryLike, type ToolResult } from "./selftest-call.js";

/**
 * Post-deploy gate for "Call me now": one real support call from Otto's setup helper to a lab number answered by a
 * temporary lab assistant (fo-lab-setuphelp-*) playing the owner. It passes only when
 *   1. the helper started and the lab owner talked to it (the call was answered and ran),
 *   2. every setup-help tool it called succeeded (the lab owner asks for the steps by email and for a test result),
 *   3. our server recorded the call as ended with outcome "done" (and, with --book, a booked time), and
 *   4. the call stayed under the six-minute cap.
 *
 *   node --import tsx scripts/selftest-setup-call.ts --tenant <shop id> --lab <E.164 lab number> [--book]
 *   (production image: node dist/scripts/selftest-setup-call.js ...)
 *
 * Tools are judged from Telnyx's conversation history when the helper is a standard assistant. A speech-to-speech
 * helper's tools are run by its delegation backend and never show there, so they are judged from what our server
 * recorded on the call (each helper tool's name and status).
 *
 * The shop's saved owner mobile must BE the lab number: the script refuses anything else, so it can never ring a
 * real owner. The lab number is pointed at the lab assistant for the call and put back afterwards; the lab assistant
 * and its TeXML app are deleted. --book also books a real 10-minute slot on the team calendar (cancel it after).
 * Needs TELNYX_API_KEY, TELNYX_ASSISTANT_ID (the lab owner copies its text model, voice and transcription),
 * TELNYX_CHECK_CONNECTION_ID, TELNYX_FROM_NUMBER, PUBLIC_BASE_URL and DATABASE_URL. Places a real, billed call: run it
 * on purpose, after a deploy. Prints tool names, statuses and booleans only: never a number, name or words said.
 */

const E164 = /^\+[1-9]\d{7,14}$/;
/** The helper's hard cap is six minutes; anything past this is a failure. */
export const SETUP_SELFTEST_MAX_MS = 6.5 * 60_000;
export const SETUP_HELP_TOOLS = new Set(["start_forwarding_test", "get_test_result", "email_steps", "get_open_times", "book_time"]);

export function parseSetupSelftestArgs(argv: string[], env: Record<string, string | undefined>): { tenantId: string; lab: string; book: boolean } {
  const read = (flag: string): string | undefined => {
    const index = argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
    if (index < 0) return undefined;
    const arg = argv[index]!;
    return arg.includes("=") ? arg.slice(flag.length + 1) : argv[index + 1];
  };
  for (const arg of argv) if (arg.startsWith("--") && !/^--(tenant|lab|book)(=|$)/.test(arg)) throw new Error(`Unknown argument ${arg}. Use --tenant, --lab and --book.`);
  const tenantId = read("--tenant") ?? env.SETUP_SELFTEST_TENANT;
  const lab = read("--lab") ?? env.SETUP_SELFTEST_LAB;
  if (!tenantId || !/^[\w-]{1,80}$/.test(tenantId)) throw new Error("Pass the shop to test with --tenant or SETUP_SELFTEST_TENANT");
  if (!lab || !E164.test(lab)) throw new Error("Pass the lab number with --lab (E.164) or SETUP_SELFTEST_LAB");
  return { tenantId, lab, book: argv.includes("--book") };
}

/** The lab owner may only be rung when it is the shop's saved owner mobile, and never Otto's own numbers. */
export function labTargetAllowed(input: { lab: string; ownerMobile: string | null; ottoLine: string | null; fromNumber: string | null }): boolean {
  return input.ownerMobile === input.lab && input.lab !== input.ottoLine && input.lab !== input.fromNumber;
}

/** The helper tool answers our server kept on the call's record, as the gate reads them. */
export function recordedSetupTools(record: { tools?: Array<{ name?: unknown; status?: unknown }> } | null): ToolResult[] {
  return (Array.isArray(record?.tools) ? record.tools : []).map((tool) => {
    const status = typeof tool.status === "string" ? tool.status : "unreadable";
    return { name: typeof tool.name === "string" ? tool.name : "unknown", status, ok: statusOk(status) && status !== "unreadable" };
  });
}

/**
 * `tools` is what the conversation history shows. With a speech-to-speech helper (`speechToSpeech`) it is usually
 * empty, so the tools pass on what our server recorded for the call (`record.tools`); a failed tool in either fails.
 */
export function setupVerdict(input: { tools: ToolResult[]; record: { answeredAt?: string; endedAt?: string; outcome?: string; bookedAt?: string; tools?: Array<{ name?: unknown; status?: unknown }> } | null; book: boolean; elapsedMs: number; speechToSpeech?: boolean }): { pass: boolean; answered: boolean; tools_ok: boolean; outcome_done: boolean; booked: boolean; under_cap: boolean } {
  const helpTools = input.tools.filter((tool) => SETUP_HELP_TOOLS.has(tool.name));
  const recorded = recordedSetupTools(input.record).filter((tool) => SETUP_HELP_TOOLS.has(tool.name));
  const toolsOk = input.speechToSpeech
    ? recorded.length > 0 && recorded.every((tool) => tool.ok) && helpTools.every((tool) => tool.ok)
    : helpTools.length > 0 && helpTools.every((tool) => tool.ok);
  const answered = Boolean(input.record?.answeredAt);
  const done = Boolean(input.record?.endedAt) && input.record?.outcome === "done";
  const booked = !input.book || Boolean(input.record?.bookedAt);
  const underCap = input.elapsedMs <= SETUP_SELFTEST_MAX_MS;
  return { pass: answered && toolsOk && done && booked && underCap, answered, tools_ok: toolsOk, outcome_done: done, booked, under_cap: underCap };
}

export function labOwnerScript(book: boolean): string {
  return `You are Sam, the owner of a small plumbing shop. You asked Call Otto's setup helper to call you. You are a real person; never say you are an AI. Keep every answer to one short sentence.
When asked if now is a good time, say yes. If asked, you have an Android phone. Say you'd like the steps by email, and wait until the helper says they're sent.
Then ask whether your last forwarding test worked, and wait for the answer.
${book ? "Then say you'd like to talk to a person on their team. Pick the first time offered, and say yes when they repeat it back. Wait until they say it's booked." : "Then say you'll do the rest yourself."}
Then say "Okay, thanks, bye." and stop talking.`;
}

async function main(): Promise<void> {
  const { tenantId, lab, book } = parseSetupSelftestArgs(process.argv.slice(2), process.env);
  const env = loadEnvironment(process.env);
  const key = env.TELNYX_API_KEY;
  const template = env.TELNYX_ASSISTANT_ID;
  if (!key || !template || !env.TELNYX_CHECK_CONNECTION_ID || !env.TELNYX_FROM_NUMBER) throw new Error("TELNYX_API_KEY, TELNYX_ASSISTANT_ID, TELNYX_CHECK_CONNECTION_ID and TELNYX_FROM_NUMBER are required");
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
  const store = runtime.store;
  let lab_: { id: string; texml: string | null } | null = null;
  let restore: { numberId: string; connectionId: string | null } | null = null;
  let pass = false;
  try {
    const [ownerMobile, ottoLine] = await Promise.all([
      store.getIntegrationSecret(tenantId, "notifications", "owner-primary"),
      store.getIntegrationSecret(tenantId, "telnyx", "inbound_number"),
    ]);
    if (!labTargetAllowed({ lab, ownerMobile, ottoLine, fromNumber: env.TELNYX_FROM_NUMBER })) throw new Error("The shop's saved owner mobile is not the lab number: refusing to call");

    // The lab owner: an assistant that answers the lab number for this one call.
    const [, base] = await telnyx("GET", `/ai/assistants/${encodeURIComponent(template)}`);
    const source = (base.data ?? base) as Record<string, any>;
    const [created, assistant] = await telnyx("POST", "/ai/assistants", {
      name: `fo-lab-setuphelp-${Date.now().toString(36)}`, enabled_features: ["telephony"], instructions: labOwnerScript(book), greeting: "Hello?",
      tools: [{ type: "hangup", hangup: { description: "End the call after you have said goodbye." } }],
      ...(source.transcription ? { transcription: source.transcription } : {}),
      ...labCallerVoice(source, env.TELNYX_VOICE),
      telephony_settings: { time_limit_secs: 400, user_idle_timeout_secs: 30, recording_settings: { enabled: false } },
    });
    if (created >= 300) throw new Error(`Could not create the lab owner (${created})`);
    const made = (assistant.data ?? assistant) as Record<string, any>;
    lab_ = { id: String(made.id), texml: made.telephony_settings?.default_texml_app_id ?? null };
    if (!lab_.texml) throw new Error("The lab owner has no TeXML app");
    const [, numbers] = await telnyx("GET", `/phone_numbers?filter[phone_number]=${encodeURIComponent(lab)}`);
    const number = ((numbers.data ?? []) as Array<Record<string, any>>)[0];
    if (!number?.id) throw new Error("The lab number is not on this Telnyx account");
    restore = { numberId: String(number.id), connectionId: typeof number.connection_id === "string" ? number.connection_id : null };
    const [pointed] = await telnyx("PATCH", `/phone_numbers/${encodeURIComponent(restore.numberId)}`, { connection_id: lab_.texml });
    say("lab_owner_ready", pointed < 300);
    if (pointed >= 300) throw new Error("Could not point the lab number at the lab owner");
    await sleep(3000);

    // Ring it the way "Call me now" does: the same caller, record and tool lookup, so our server runs the real call.
    const caller = new TelnyxSetupCaller({
      apiKey: key, templateAssistantId: env.TELNYX_TEMPLATE_ASSISTANT_ID ?? template, setupAssistantId: env.TELNYX_SETUP_ASSISTANT_ID ?? null,
      publicBaseUrl: env.PUBLIC_BASE_URL, voice: env.TELNYX_VOICE, speechToSpeech: speechToSpeechSettings(env),
      getSecret: (tenant, provider, name) => store.getIntegrationSecret(tenant, provider, name),
      saveSecret: (tenant, provider, name, value) => store.saveIntegrationSecret(tenant, provider, name, value),
    });
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const callControlId = await caller.dial({ connectionId: env.TELNYX_CHECK_CONNECTION_ID, from: env.TELNYX_FROM_NUMBER, to: lab, tenantId, webhookUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/telnyx` });
    say("call_placed", Boolean(callControlId), "client_state_ok", Boolean(setupHelpClientState(tenantId)));
    if (!callControlId) throw new Error("The support call was not placed");
    await store.saveIntegrationSecret(tenantId, "forwarding", "setup_call", JSON.stringify({ startedAt, callControlId, device: "android", to: lab }));
    await store.saveIntegrationSecret(PLATFORM_TENANT_ID, "setup-help", callControlId, tenantId);

    type Record_ = { answeredAt?: string; endedAt?: string; outcome?: string; bookedAt?: string; callControlId?: string; tools?: Array<{ name?: unknown; status?: unknown }> };
    const record = async (): Promise<Record_ | null> => { try { return JSON.parse(await store.getIntegrationSecret(tenantId, "forwarding", "setup_call") ?? "null") as Record_ | null; } catch { return null; } };
    let latest: Record_ | null = null;
    while (Date.now() - started < SETUP_SELFTEST_MAX_MS + 30_000) {
      await sleep(3000);
      latest = await record();
      if (latest?.callControlId !== callControlId || latest.endedAt) break;
    }
    const elapsedMs = Date.now() - started;
    say("answered", Boolean(latest?.answeredAt), "ended", Boolean(latest?.endedAt), "outcome", latest?.outcome ?? "none");

    // The helper's side of the conversation, for its tool results.
    let messages: HistoryLike[] = [];
    const [, list] = await telnyx("GET", "/ai/conversations?order=created_at.desc&limit=20");
    const conversation = ((list.data ?? []) as Array<Record<string, any>>).find((item) => item.metadata?.call_control_id === callControlId) ?? null;
    if (conversation) {
      for (let page = 1; page < 10; page += 1) {
        const [, body] = await telnyx("GET", `/ai/conversations/${encodeURIComponent(String(conversation.id))}/messages?page[number]=${page}&page[size]=100`);
        messages = messages.concat((body.data ?? []) as HistoryLike[]);
        if (!body.meta || page >= Number(body.meta.total_pages ?? 1)) break;
      }
      messages.sort((left: any, right: any) => String(left.sent_at ?? left.created_at).localeCompare(String(right.sent_at ?? right.created_at)));
    }
    const tools = toolResults(messages);
    for (const tool of tools) say("tool", tool.name, tool.status, tool.ok);
    // The helper the call ran on (the same lookup the caller uses), as Telnyx has it: speech-to-speech means its tools are judged from our record.
    const helperId = env.TELNYX_SETUP_ASSISTANT_ID ?? await store.getIntegrationSecret(PLATFORM_TENANT_ID, "telnyx", "setup_assistant_id");
    const speechToSpeech = helperId ? isSpeechToSpeechAssistant((await telnyx("GET", `/ai/assistants/${encodeURIComponent(helperId)}`))[1]) : false;
    say("helper_voice_mode", speechToSpeech ? "speech_to_speech" : "standard");
    for (const tool of recordedSetupTools(latest)) say("tool_recorded", tool.name, tool.status, tool.ok);
    const result = setupVerdict({ tools, record: latest, book, elapsedMs, speechToSpeech });
    say(result);
    pass = result.pass;
  } catch (error) {
    say("error", error instanceof Error ? error.message : "unknown");
  } finally {
    if (restore) {
      const [back] = await telnyx("PATCH", `/phone_numbers/${encodeURIComponent(restore.numberId)}`, { connection_id: restore.connectionId });
      say("lab_number_restored", back < 300);
    }
    if (lab_) {
      const [, check] = await telnyx("GET", `/ai/assistants/${encodeURIComponent(lab_.id)}`);
      // Only ever delete what this script made.
      if (String(check.name ?? check.data?.name ?? "").startsWith("fo-lab-setuphelp-")) {
        const [deleted] = await telnyx("DELETE", `/ai/assistants/${encodeURIComponent(lab_.id)}`);
        say("lab_owner_deleted", deleted < 300);
        if (lab_.texml) {
          const [appDeleted] = await telnyx("DELETE", `/texml_applications/${encodeURIComponent(lab_.texml)}`);
          say("lab_app_deleted", appDeleted < 300);
        }
      }
    }
    await runtime.close();
  }
  say(pass ? "SETUP SELFTEST PASS" : "SETUP SELFTEST FAIL");
  if (!pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
