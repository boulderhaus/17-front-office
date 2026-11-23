import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCalendar, InMemoryStore } from "../src/adapters/in-memory.js";
import { saveAssistantConfig } from "../src/adapters/assistant-config.js";
import { DEFAULT_TELNYX_VOICE, demoEnvironment } from "../src/config/environment.js";
import { createDemoConfig } from "../src/domain/config.js";
import { createRequestHandler } from "../src/http/app.js";
import type { Clock } from "../src/ports.js";
import { buildTelnyxAssistantUpdate, buildTelnyxGreeting, buildVoiceSystemPrompt } from "../src/voice/system-prompt.js";
import { planAssistantPushes } from "../scripts/configure-telnyx.js";

// Voice lab 2026-11-23 (research/voice-lab/RESULTS.md): tuned turn-taking, short-turn prompt rules,
// and a fix for the tool loop where an unreadable result made the model call check_availability 60+ times.

describe("voice lab turn-taking settings", () => {
  const update = buildTelnyxAssistantUpdate(createDemoConfig(), "https://front-office.example") as Record<string, any>;

  it("uses the lab's winning end-of-turn thresholds and keeps the keyterms", () => {
    expect(update.transcription).toEqual({
      model: "deepgram/flux",
      language: "en",
      settings: expect.objectContaining({ smart_format: true, numerals: true, eot_threshold: 0.75, eager_eot_threshold: 0.5, eot_timeout_ms: 1_000 }),
    });
    expect(update.transcription.settings.keyterm).toContain("HVAC,heating,cooling");
  });

  it("predicts interruptions at 0.5 with the lab's start-speaking plan", () => {
    expect(update.interruption_settings).toEqual({
      enable: true,
      disable_greeting_interruption: false,
      interrupt_prediction_threshold: 0.5,
      start_speaking_plan: {
        wait_seconds: 0.1,
        transcription_endpointing_plan: { on_punctuation_seconds: 0.1, on_no_punctuation_seconds: 0.1, on_number_seconds: 0.1 },
      },
    });
  });

  it("keeps the current Ultra voice by default, never with expressive mode", () => {
    expect(DEFAULT_TELNYX_VOICE).toBe("Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02");
    expect(update.voice_settings).toMatchObject({ voice: DEFAULT_TELNYX_VOICE, voice_speed: 1 });
    expect(JSON.stringify(update)).not.toContain("expressive_mode");
  });

  it("takes the voice from TELNYX_VOICE", () => {
    expect(demoEnvironment().TELNYX_VOICE).toBe(DEFAULT_TELNYX_VOICE);
    const env = demoEnvironment({ TELNYX_VOICE: "Inworld.TTS2.Ashley" });
    expect(env.TELNYX_VOICE).toBe("Inworld.TTS2.Ashley");
    const custom = buildTelnyxAssistantUpdate(createDemoConfig(), "https://front-office.example", { voice: env.TELNYX_VOICE }) as Record<string, any>;
    expect(custom.voice_settings).toMatchObject({ voice: "Inworld.TTS2.Ashley", voice_speed: 1 });
    expect(demoEnvironment({ TELNYX_VOICE: "" }).TELNYX_VOICE).toBe(DEFAULT_TELNYX_VOICE);
  });

  it("pushes the configured voice to every assistant we update", async () => {
    const store = new InMemoryStore();
    const original = createDemoConfig();
    await store.saveConfig(original);
    const env = { ...demoEnvironment({ TELNYX_VOICE: "Inworld.TTS2.Ashley" }), DEMO_MODE: false, TELNYX_API_KEY: "synthetic-provider-key", TELNYX_ASSISTANT_ID: "synthetic-assistant", PUBLIC_BASE_URL: "https://front-office.example" };
    const payloads: Array<Record<string, any>> = [];
    await saveAssistantConfig(store, env, { ...original, businessName: "Changed" }, async (_url, init) => { payloads.push(JSON.parse(String(init?.body))); return Response.json({ id: "synthetic-assistant" }); });
    expect(payloads[0]?.voice_settings?.voice).toBe("Inworld.TTS2.Ashley");
    expect(payloads[0]?.transcription?.settings?.eot_threshold).toBe(0.75);

    const pushes = await planAssistantPushes({ store, defaultTenantId: "demo", demoAssistantId: "synthetic-assistant", publicBaseUrl: "https://front-office.example", voice: "Inworld.TTS2.Ashley" });
    expect(pushes.every((push) => (push.update.voice_settings as { voice: string }).voice === "Inworld.TTS2.Ashley")).toBe(true);
  });
});

describe("voice lab prompt rules", () => {
  const config = createDemoConfig();
  const prompt = buildVoiceSystemPrompt(config);

  it("adds the short-turn rhythm rules after the conversation style", () => {
    expect(prompt).toContain("HOW YOU SOUND (natural phone rhythm)");
    expect(prompt.indexOf("HOW YOU SOUND")).toBeGreaterThan(prompt.indexOf("CONVERSATION STYLE"));
    expect(prompt.indexOf("HOW YOU SOUND")).toBeLessThan(prompt.indexOf("GOAL\n"));
    expect(prompt).toContain("Most turns are one short sentence plus at most one question, under about 20 words.");
    expect(prompt).toContain("Open most replies with a quick, varied acknowledgement");
    expect(prompt).toContain('never say "Great question" or "Absolutely"');
    expect(prompt).toContain("Ask for one detail at a time.");
    expect(prompt).toContain("If the caller cuts you off, drop what you were saying.");
  });

  it("forbids tool loops and invented times", () => {
    expect(prompt).toContain("Never call the same tool more than twice in a call");
    expect(prompt).toContain("Never invent times: only offer times a tool returned.");
    expect(prompt).toContain("If a tool result has ok=false, say its say line once, follow its instruction, and do not call that tool again.");
  });

  it("keeps the greeting, safety and spam rules unchanged", () => {
    expect(buildTelnyxGreeting(config)).toBe("Thanks for calling North Star Heating. How can I help?");
    expect(prompt).toContain("If the caller reports gas odor, carbon monoxide, smoke, fire, or immediate danger, tell them to leave the building and call 911 or the gas utility. Do not troubleshoot.");
    expect(prompt).toContain('If it returns status=marked, say exactly "Sorry, this line is only for service calls. Goodbye."');
  });
});

describe("tool results the model can always read", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryStore;
  const toolToken = "tool-token-abcdefghijklmnopqrstuvwxyz";
  const clock: Clock = { now: () => new Date("2026-01-15T08:00:00.000Z") };
  const headers = { authorization: `Bearer ${toolToken}`, "content-type": "application/json" };

  async function start(options: { toolDeadlineMs?: number } = {}): Promise<void> {
    store = new InMemoryStore();
    await store.saveConfig(createDemoConfig());
    const env = demoEnvironment({ ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: toolToken, PUBLIC_BASE_URL: "http://127.0.0.1:8787" });
    server = createServer(createRequestHandler({ env, store, calendar: new InMemoryCalendar(), clock, integrations: {}, logger: () => undefined, ...options }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
  const post = (path: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = headers) =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers: extraHeaders, body: JSON.stringify(body) });
  const availability = (callId: string) => post("/tools/check-availability", { provider_call_id: callId, window_start: "2026-01-15T15:00:00Z", window_end: "2026-01-15T18:00:00Z" });

  beforeEach(async () => { await start(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("stops the third call to the same tool in one call with a fixed take-a-message result", async () => {
    expect((await (await availability("loop-call")).json() as { status: string }).status).toBe("available");
    expect((await (await availability("loop-call")).json() as { status: string }).status).toBe("available");
    const third = await availability("loop-call");
    expect(third.status).toBe(200);
    const body = await third.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, status: "limit_reached" });
    expect(String(body.say)).toMatch(/owner will/i);
    expect(String(body.instruction)).toMatch(/Do not call check_availability again/);
    expect(body).not.toHaveProperty("slots");
    // Another call has its own budget.
    expect((await (await availability("other-call")).json() as { status: string }).status).toBe("available");
  });

  it("lets save_intake run as often as the intake rules need", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await post("/tools/save-intake", { provider_call_id: "intake-call", from_number: "+15555550110", problem_description: `Furnace noise ${attempt}` });
      expect((await response.json() as { status: string }).status).toBe("saved");
    }
  });

  it("answers an unexpected server failure with a plain-English result instead of an error page", async () => {
    vi.spyOn(store, "getConfig").mockRejectedValue(new Error("Synthetic database failure"));
    const response = await availability("broken-call");
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, status: "unavailable", say: "I can't see the calendar right now; the owner will confirm a time with you." });
    expect(String(body.instruction)).toMatch(/Never invent/);
  });

  it("answers before the provider's tool timeout when a lookup hangs", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ toolDeadlineMs: 50 });
    vi.spyOn(store, "getConfig").mockImplementation(() => new Promise(() => undefined));
    const response = await availability("slow-call");
    expect(response.status).toBe(200);
    // Terminal: the deadline means take a message, not "try again".
    expect(await response.json()).toMatchObject({ ok: false, status: "limit_reached" });
  });

  it("answers rejections with 200 so the provider hands the explanation to the model", async () => {
    const unauthenticated = await post("/tools/check-availability", {}, { "content-type": "application/json" });
    expect(unauthenticated.status).toBe(200);
    expect(await unauthenticated.json()).toMatchObject({ ok: false, status: "unavailable", say: expect.any(String) });

    const notExplicit = await post("/tools/request-human", { provider_call_id: "loud", from_number: "+15555550110", reason: "explicit_request", caller_quote: "why is this so loud" });
    expect(notExplicit.status).toBe(200);
    const body = await notExplicit.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false });
    expect(String(body.say).length).toBeGreaterThan(0);

    const invalid = await post("/tools/approved-answer", { provider_call_id: "bad", kind: "discount", key: "x" });
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({ ok: false, say: expect.any(String), instruction: expect.any(String) });
  });
});
