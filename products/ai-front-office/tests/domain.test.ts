import { describe, expect, it } from "vitest";
import { createDemoConfig, isCoverageActive } from "../src/domain/config.js";
import { triageEmergency } from "../src/domain/triage.js";
import { buildTelnyxAssistantUpdate, buildTelnyxTools, buildVoiceSystemPrompt } from "../src/voice/system-prompt.js";
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
    const hangup = buildTelnyxTools(config, "https://front-office.example").find((tool) => tool.type === "hangup") as { hangup: { description: string } };
    expect(hangup.hangup.description).toContain("Immediately terminate");
    const update = buildTelnyxAssistantUpdate(config, "https://front-office.example") as { telephony_settings: { user_idle_timeout_secs: number; user_idle_reply_secs: number } };
    expect(update.telephony_settings).toMatchObject({ user_idle_timeout_secs: 30, user_idle_reply_secs: 8 });
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
