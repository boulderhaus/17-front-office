import { shopActivationBlockers } from "../src/application/readiness.js";
import { isExplicitHumanRequest } from "../src/domain/human-request.js";
import { describe, expect, it } from "vitest";
import { createDemoConfig, evaluateServiceArea, isCoverageActive } from "../src/domain/config.js";
import { triageEmergency } from "../src/domain/triage.js";
import { buildTelnyxAssistantUpdate, buildTelnyxOutboundTestCall, buildTelnyxTools, buildVoiceSystemPrompt } from "../src/voice/system-prompt.js";
import { redactError } from "../src/application/retry.js";
import { buildActivationReport } from "../src/application/readiness.js";
import { runAllSimulations } from "../src/application/simulator.js";
import { loadEnvironment } from "../src/config/environment.js";

const syntheticEncryptionKey = Buffer.alloc(32).toString("base64");

describe("emergency triage", () => {
  it("overrides model judgment for a life-safety phrase", () => {
    const result = triageEmergency("The basement smells like gas", createDemoConfig(), 0.01, "routine");
    expect(result.severity).toBe("life_safety");
    expect(result.immediateInstruction).toContain("call 911");
  });

  it("classifies no heat with a vulnerable occupant as urgent", () => {
    const result = triageEmergency("No heat and an infant is here", createDemoConfig());
    expect(result.emergency).toBe(true);
    expect(result.evidence).toContain("vulnerable occupant");
  });
});

describe("coverage and voice policy", () => {
  it("uses after-hours by default and respects the configured timezone across DST", () => {
    const config = createDemoConfig();
    expect(config.operationMode).toBe("after_hours");
    expect(isCoverageActive(config, new Date("2026-03-09T01:30:00Z"), false)).toBe(true);
    expect(isCoverageActive(config, new Date("2026-03-09T17:00:00Z"), false)).toBe(false);
  });

  it("discloses AI and refuses unapproved price invention", () => {
    const prompt = buildVoiceSystemPrompt(createDemoConfig());
    expect(prompt).toContain("owner's AI assistant");
    expect(prompt).toContain("Quote only these approved snippets");
    expect(prompt).toContain("read the exact approved diagnostic fee");
    expect(prompt).toContain("The booking mode is confirm");
    expect(prompt).toContain("caller ID as {{caller_phone}}");
    expect(prompt).toContain("Default to one or two short sentences");
    expect(prompt).toContain("spokenSummary once");
    expect(prompt).toContain("call check_service_area before checking availability");
  });

  it("matches only owner-configured city and ZIP boundaries and fails closed without configuration", () => {
    const config = { ...createDemoConfig(), serviceAreaTerms: ["Springfield IL", "12207", "627"] };
    expect(evaluateServiceArea("100 Main St, Springfield, IL", config)).toMatchObject({ status: "covered", matchedTerm: "Springfield IL" });
    expect(evaluateServiceArea("1200 Main St, Springfield, MO 65802", config).status).toBe("outside");
    expect(evaluateServiceArea("62704 North Lake Shore Dr, Chicago, IL 60611", config).status).toBe("outside");
    expect(evaluateServiceArea("100 Main St, Albany, NY 12207", config)).toMatchObject({ status: "covered", matchedTerm: "12207" });
    expect(evaluateServiceArea("100 Main St, IL 62704", config).status).toBe("outside");
    expect(evaluateServiceArea("100 Main St, Springfield Gardens, NY 11413", config).status).toBe("outside");
    expect(evaluateServiceArea("100 Main St, Albany, NY 12208", config).status).toBe("outside");
    expect(evaluateServiceArea("100 Main St", { ...config, serviceAreaTerms: [] }).status).toBe("unconfigured");
  });

  it("uses a direction-specific greeting for outbound test calls", () => {
    const config = createDemoConfig();
    const update = buildTelnyxAssistantUpdate(config, "https://front-office.example") as {
      greeting: string;
      dynamic_variables: { call_direction: string; opening_greeting: string };
    };
    expect(update.greeting).toBe("{{opening_greeting}}");
    expect(update.dynamic_variables.call_direction).toBe("inbound");
    expect(update.dynamic_variables.opening_greeting).toContain("Thanks for calling");
    const outbound = buildTelnyxOutboundTestCall({
      from: "+15555550199", to: "+15555550100", assistantId: "assistant-synthetic",
      businessName: "Synthetic Heating", recordingDisclosure: "This call may be recorded.",
    }) as { AIAssistantDynamicVariables: { call_direction: string; opening_greeting: string } };
    expect(outbound.AIAssistantDynamicVariables.call_direction).toBe("outbound_test");
    expect(outbound.AIAssistantDynamicVariables.opening_greeting).toContain("this is a test call");
    expect(outbound.AIAssistantDynamicVariables.opening_greeting).not.toContain("Thanks for calling");
  });

  it("requires explicit human requests and refuses price guesses when no script is approved", () => {
    const prompt = buildVoiceSystemPrompt({ ...createDemoConfig(), priceSnippets: [] });
    expect(prompt).toContain("Anger, confusion, low confidence, or an unclear remark is not permission to escalate");
    expect(prompt).toContain("Comments about loudness, volume, audio quality");
    expect(prompt).toContain("Never estimate a price");
  });

  it("hard-hangs up voicemail and closing turns without a long idle tail", () => {
    const config = createDemoConfig();
    const prompt = buildVoiceSystemPrompt(config);
    expect(prompt).toContain("invoke the built-in hangup tool in the same turn");
    expect(prompt).toContain("Never say \"goodbye\" without immediately invoking");
    expect(prompt).toContain("That is the natural closing pause");
    const hangup = buildTelnyxTools(config, "https://front-office.example").find((tool) => tool.type === "hangup") as { hangup: { description: string } };
    expect(hangup.hangup.description).toContain("Immediately terminate");
    const update = buildTelnyxAssistantUpdate(config, "https://front-office.example") as { telephony_settings: { user_idle_timeout_secs: number; user_idle_reply_secs: number } };
    expect(update.telephony_settings).toMatchObject({ user_idle_timeout_secs: 30, user_idle_reply_secs: 8 });
  });

  it("tunes transcription for service terms, numbers, and ordinal addresses", () => {
    const update = buildTelnyxAssistantUpdate(createDemoConfig(), "https://front-office.example") as {
      transcription: { model: string; language: string; settings: { smart_format: boolean; numerals: boolean; keyterm: string } };
    };
    expect(update.transcription.model).toBe("deepgram/flux");
    expect(update.transcription.language).toBe("en");
    expect(update.transcription.settings).toMatchObject({ smart_format: true, numerals: true });
    expect(update.transcription.settings.keyterm).toContain("eightieth");
    expect(update.transcription.settings.keyterm).toContain("heating");
  });

  it("requires a reason and exact caller quote for the handoff tool", () => {
    const handoff = buildTelnyxTools(createDemoConfig(), "https://front-office.example")
      .find((tool) => (tool.webhook as { name?: string } | undefined)?.name === "request_human") as {
        webhook: { body_parameters: { required: string[]; properties: { reason: { enum: string[] } } } };
      };
    expect(handoff.webhook.body_parameters.required).toEqual(["reason", "caller_quote"]);
    expect(handoff.webhook.body_parameters.properties.reason.enum).toEqual(["explicit_request", "emergency"]);
  });
});

describe("operational safety", () => {
  it("redacts named credentials without preserving their values", () => {
    const redacted = redactError(new Error("token=super-secret-value Authorization=also-secret Bearer third-secret"));
    expect(redacted).toBe("token=[REDACTED] Authorization=[REDACTED] Bearer [REDACTED]");
    expect(redacted).not.toContain("super-secret-value");
  });

  it("keeps activation at NO-GO until production dependencies and live proof exist", () => {
    const config = { ...createDemoConfig(), paused: false, businessName: "Synthetic Heating", greeting: "Thanks for calling Synthetic Heating. I am the owner's AI assistant.", priceSnippets: [{ label: "Diagnostic", text: "The diagnostic visit is $89." }] };
    const env = loadEnvironment({
      NODE_ENV: "production", DEMO_MODE: "false", PROVIDER_TEST_MODE: "false",
      PUBLIC_BASE_URL: "https://front-office.example", ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz",
      TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", DATABASE_URL: "postgresql://synthetic",
      SESSION_SIGNING_KEY: "session-signing-key-abcdefghijklmnopqrstuvwxyz",
      DATA_ENCRYPTION_KEY: syntheticEncryptionKey, TELNYX_API_KEY: "synthetic", TELNYX_PUBLIC_KEY: Buffer.alloc(32, 1).toString("base64"),
      TELNYX_ASSISTANT_ID: "assistant-synthetic", TELNYX_FROM_NUMBER: "+15555550199",
      TELNYX_MESSAGING_PROFILE_ID: "00000000-0000-4000-8000-000000000001", TELNYX_MESSAGING_APPROVED: "true", RECORDING_CONSENT_APPROVED: "true",
      GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic",
      OWNER_DESTINATIONS_JSON: "{\"owner-primary\":\"+15555550100\"}",
    });
    const blocked = buildActivationReport({ env, config, googleConnected: true, ownerPhoneConfigured: true });
    expect(blocked.go).toBe(false);
    expect(blocked.blocking.map((item) => item.id)).toContain("live_proof");
    const provenEnv = loadEnvironment({ ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])), LIVE_PROVIDER_PROOF_AT: "2026-11-20T05:00:00-05:00" });
    expect(buildActivationReport({ env: provenEnv, config, googleConnected: true, ownerPhoneConfigured: true }).go).toBe(true);
  });

  it("boots production storage while providers stay unconfigured and rejects unsafe provider-test mode", () => {
    const base = {
      NODE_ENV: "production", DEMO_MODE: "false", PUBLIC_BASE_URL: "https://front-office.example",
      ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz", TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz",
      SESSION_SIGNING_KEY: "session-signing-key-abcdefghijklmnopqrstuvwxyz",
      DATABASE_URL: "postgresql://synthetic", DATA_ENCRYPTION_KEY: syntheticEncryptionKey, OWNER_DESTINATIONS_JSON: "{}",
    };
    const env = loadEnvironment(base);
    const report = buildActivationReport({ env, config: createDemoConfig(), googleConnected: false, ownerPhoneConfigured: false });
    expect(report.go).toBe(false);
    expect(report.blocking.map((item) => item.id)).toEqual(expect.arrayContaining(["telnyx_voice", "telnyx_sms", "sms_compliance", "calendar", "owner_phone", "live_proof"]));
    expect(() => loadEnvironment({ ...base, PROVIDER_TEST_MODE: "true" })).toThrow("PROVIDER_TEST_MODE requires");
    expect(() => loadEnvironment({ ...base, DATA_ENCRYPTION_KEY: "wrong-format" })).toThrow("DATA_ENCRYPTION_KEY must decode to exactly 32 bytes");
  });

  it("passes every credential-free launch scenario", async () => {
    const results = await runAllSimulations();
    expect(results).toHaveLength(15);
    expect(results.filter((item) => !item.passed)).toEqual([]);
  });
});

describe("shop activation prerequisites", () => {
  it("refuses activation when the owner has not opted into urgent alerts", () => {
    expect(shopActivationBlockers({ ownerPhoneConfigured: true, urgentAlertsEnabled: false, googleConnected: true, serviceAreaConfigured: true }))
      .toEqual(["urgent text alerts (the owner has not opted in)"]);
    expect(shopActivationBlockers({ ownerPhoneConfigured: true, urgentAlertsEnabled: true, googleConnected: true, serviceAreaConfigured: true })).toEqual([]);
  });
});

describe("life-safety phrasing", () => {
  const config = { emergencyKeywords: [] as string[], emergencyThreshold: 0.7 };
  it.each([
    "I smelled gas near the water heater", "there's an odor of gas in the kitchen", "it smells kind of like gas",
    "I'm getting fumes from the furnace and a headache", "smoke is coming out of the vent", "There is smoke in the house",
    "the outlet is on fire", "I see flames", "CO detector is going off", "carbon-monoxide alarm", "I cannot breathe",
    "smells like rotten eggs", "gas smell in the hallway",
  ])("escalates: %s", (text) => {
    expect(triageEmergency(text, config).severity).toBe("life_safety");
  });
  it.each([
    "my furnace won't fire", "the pilot won't fire up", "smoke detector is chirping, low battery", "I want to schedule a fireplace inspection",
  ])("does not escalate: %s", (text) => {
    expect(triageEmergency(text, config).severity).not.toBe("life_safety");
  });
});

describe("explicit human request gate", () => {
  it.each(["I want to talk to a person", "Can I speak to the owner?", "Transfer me to someone please", "Have the owner call me back", "I need a human", "Representative please", "Could you connect me with the owner"])("accepts: %s", (quote) => {
    expect(isExplicitHumanRequest(quote)).toBe(true);
  });
  it.each(["I need a technician to look at my furnace", "I need someone to fix my AC", "Why is this so loud?", "I don't want to talk to a person", "Can someone come out tomorrow?"])("rejects: %s", (quote) => {
    expect(isExplicitHumanRequest(quote)).toBe(false);
  });
});
