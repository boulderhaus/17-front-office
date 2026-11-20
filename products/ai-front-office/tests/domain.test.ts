import { describe, expect, it } from "vitest";
import { createDemoConfig, isCoverageActive } from "../src/domain/config.js";
import { triageEmergency } from "../src/domain/triage.js";
import { buildVoiceSystemPrompt } from "../src/voice/system-prompt.js";
import { redactError } from "../src/application/retry.js";

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
});
