import type { BusinessConfig, EmergencyDecision } from "./models.js";

const LIFE_SAFETY_RULES: Array<{ pattern: RegExp; evidence: string; instruction: string }> = [
  {
    pattern: /\b(gas leak|smell(?:s)? (?:like )?gas|rotten eggs?)\b/i,
    evidence: "possible gas leak",
    instruction: "Leave the building, avoid switches or flames, and call 911 or the gas utility from outside.",
  },
  {
    pattern: /\b(carbon monoxide|co alarm|co detector)\b/i,
    evidence: "possible carbon monoxide exposure",
    instruction: "Move everyone outside and call 911. Do not re-enter until responders say it is safe.",
  },
  {
    pattern: /\b(fire|sparks? (?:and|with) smoke|electrical smoke)\b/i,
    evidence: "possible fire",
    instruction: "Leave the building and call 911. Do not attempt a repair.",
  },
];

const URGENT_RULES: Array<{ pattern: RegExp; evidence: string }> = [
  { pattern: /\b(burst pipe|active flooding|water pouring|sewage backup)\b/i, evidence: "active water or sewage damage" },
  { pattern: /\b(no heat|heat (?:is )?out|furnace (?:is )?out)\b/i, evidence: "loss of heat" },
  { pattern: /\b(no ac|no a\/c|air conditioner (?:is )?(?:out|broken))\b/i, evidence: "loss of cooling" },
  { pattern: /\b(baby|infant|elderly|medical condition|oxygen)\b/i, evidence: "vulnerable occupant" },
];

export function triageEmergency(
  description: string,
  config: Pick<BusinessConfig, "emergencyKeywords" | "emergencyThreshold">,
  llmScore?: number,
  llmReason?: string,
): EmergencyDecision {
  const evidence: string[] = [];
  for (const rule of LIFE_SAFETY_RULES) {
    if (rule.pattern.test(description)) {
      return {
        emergency: true,
        severity: "life_safety",
        score: 1,
        evidence: [rule.evidence],
        immediateInstruction: rule.instruction,
      };
    }
  }

  let urgentMatches = 0;
  for (const rule of URGENT_RULES) {
    if (rule.pattern.test(description)) {
      urgentMatches += 1;
      evidence.push(rule.evidence);
    }
  }
  for (const keyword of config.emergencyKeywords) {
    if (keyword.trim() !== "" && description.toLowerCase().includes(keyword.toLowerCase())) {
      evidence.push(`configured keyword: ${keyword}`);
      urgentMatches += 1;
    }
  }

  const deterministicScore = urgentMatches === 0 ? 0 : Math.min(0.95, 0.55 + urgentMatches * 0.15);
  const boundedLlmScore = llmScore === undefined ? 0 : Math.max(0, Math.min(1, llmScore));
  const score = Math.max(deterministicScore, boundedLlmScore);
  if (llmReason && boundedLlmScore >= config.emergencyThreshold) {
    evidence.push(`model judgment: ${llmReason}`);
  }

  return {
    emergency: score >= config.emergencyThreshold,
    severity: score >= config.emergencyThreshold ? "urgent" : "routine",
    score,
    evidence: [...new Set(evidence)],
    immediateInstruction: null,
  };
}
