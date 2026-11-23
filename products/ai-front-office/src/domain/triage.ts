import type { BusinessConfig, EmergencyDecision } from "./models.js";

const LIFE_SAFETY_RULES: Array<{ pattern: RegExp; evidence: string; instruction: string }> = [
  {
    pattern: /\b(immediate danger|can'?t breathe|cannot breathe|trouble breathing|unconscious|passed out)\b/i,
    evidence: "reported immediate danger",
    instruction: "Leave the danger area and call 911. Do not attempt a repair.",
  },
  {
    // Smoke needs context: "smoke detector chirping" and "I don't smoke" are not emergencies.
    pattern: /\b(smoke (?:is |was )?(?:coming|pouring|filling|in the|from)|(?:see|seeing|saw|smell|smelling|smelled) smoke|smoky|burning (?:smell|odor)|smells? like (?:something )?burning)\b/i,
    evidence: "reported smoke",
    instruction: "Leave the danger area and call 911. Do not attempt a repair.",
  },
  {
    pattern: /\b(gas (?:leak|odor|smell)|smell(?:s|ed|ing)?\s+(?:(?:kind of|sort of|a little|like)\s+)*(?:natural )?gas|(?:odor|whiff|scent) of (?:natural )?gas|(?:natural gas|propane) (?:odor|smell|leak)|rotten eggs?|hissing gas|sulfur smell)\b/i,
    evidence: "possible gas leak",
    instruction: "Leave the building, avoid switches or flames, and call 911 or the gas utility from outside.",
  },
  {
    pattern: /\b(carbon[ -]?monoxide|co (?:alarm|detector)|fumes?\b.{0,40}\b(?:headache|dizzy|nause\w*|sick))/i,
    evidence: "possible carbon monoxide exposure",
    instruction: "Move everyone outside and call 911. Do not re-enter until responders say it is safe.",
  },
  {
    // Bare "fire" is excluded: "the furnace won't fire" is a routine repair.
    pattern: /\b(flames?|on fire|caught fire|active fire|sparks? (?:and|with) smoke|electrical smoke)\b/i,
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
  const threshold = Math.min(0.9, Math.max(0.5, config.emergencyThreshold));
  if (llmReason && boundedLlmScore >= threshold) {
    evidence.push(`model judgment: ${llmReason}`);
  }

  return {
    emergency: score >= threshold,
    severity: score >= threshold ? "urgent" : "routine",
    score,
    evidence: [...new Set(evidence)],
    immediateInstruction: null,
  };
}
