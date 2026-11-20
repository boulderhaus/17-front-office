import { describe, expect, it } from "vitest";
import { createDemoConfig, isCoverageActive } from "../src/domain/config.js";
import { triageEmergency } from "../src/domain/triage.js";
import { buildVoiceSystemPrompt } from "../src/voice/system-prompt.js";
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

  it("routes angry callers and refuses price guesses when no script is approved", () => {
    const prompt = buildVoiceSystemPrompt({ ...createDemoConfig(), priceSnippets: [] });
    expect(prompt).toContain("angry/confused");
    expect(prompt).toContain("Never estimate a price");
  });
});

describe("operational safety", () => {
  it("redacts named credentials without preserving their values", () => {
    const redacted = redactError(new Error("token=super-secret-value Authorization=also-secret Bearer third-secret"));
    expect(redacted).toBe("token=[REDACTED] Authorization=[REDACTED] Bearer [REDACTED]");
    expect(redacted).not.toContain("super-secret-value");
  });

  it("keeps activation at NO-GO until production dependencies and live proof exist", () => {
    const config = { ...createDemoConfig(), paused: false, priceSnippets: [{ label: "Diagnostic", text: "The diagnostic visit is $89." }] };
    const env = loadEnvironment({
      NODE_ENV: "production", DEMO_MODE: "false", PROVIDER_TEST_MODE: "false",
      PUBLIC_BASE_URL: "https://front-office.example", ADMIN_TOKEN: "admin-token-abcdefghijklmnopqrstuvwxyz",
      TOOL_TOKEN: "tool-token-abcdefghijklmnopqrstuvwxyz", DATABASE_URL: "postgresql://synthetic",
      DATA_ENCRYPTION_KEY: syntheticEncryptionKey, RETELL_API_KEY: "synthetic", GOOGLE_CLIENT_ID: "synthetic",
      GOOGLE_CLIENT_SECRET: "synthetic", TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
      TWILIO_AUTH_SECRET: "synthetic", TWILIO_FROM_NUMBER: "+15555550199",
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
    expect(report.blocking.map((item) => item.id)).toEqual(expect.arrayContaining(["retell", "twilio", "calendar", "owner_phone", "live_proof"]));
    expect(() => loadEnvironment({ ...base, PROVIDER_TEST_MODE: "true" })).toThrow("PROVIDER_TEST_MODE requires");
    expect(() => loadEnvironment({ ...base, DATA_ENCRYPTION_KEY: "wrong-format" })).toThrow("DATA_ENCRYPTION_KEY must decode to exactly 32 bytes");
  });

  it("passes every credential-free launch scenario", async () => {
    const results = await runAllSimulations();
    expect(results).toHaveLength(15);
    expect(results.filter((item) => !item.passed)).toEqual([]);
  });
});
