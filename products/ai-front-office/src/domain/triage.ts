import type { BusinessConfig, EmergencyDecision } from "./models.js";

const LIFE_SAFETY_RULES: Array<{ pattern: RegExp; evidence: string; instruction: string }> = [
  {
    pattern: /\b(immediate danger|can'?t breathe|cannot breathe|trouble breathing|unconscious|passed out)\b/gi,
    evidence: "reported immediate danger",
    instruction: "Leave the danger area and call 911. Do not attempt a repair.",
  },
  {
    // Smoke needs context: "smoke detector chirping" and "I don't smoke" are not emergencies.
    pattern: /\b(smoke (?:is |was )?(?:coming|pouring|filling|in the|from|everywhere)|(?:full of|filled with) smoke|(?:see|seeing|saw|smell|smelling|smelled) smoke|smoky|burning (?:smell|odor)|smells? like (?:something )?burning|(?:house|home|room) is burning)\b/gi,
    evidence: "reported smoke",
    instruction: "Leave the danger area and call 911. Do not attempt a repair.",
  },
  {
    pattern: /\b(gas (?:leak|odor|smell)|gas is leaking|leaking gas|smell(?:s|ed|ing)?\s+(?:(?:kind of|sort of|a little|like)\s+)*(?:natural )?gas|(?:smell|odor|whiff|scent) of (?:natural )?gas|(?:natural gas|propane) (?:odor|smell|leak)|rotten eggs?|hissing gas|sulfur smell)\b/gi,
    evidence: "possible gas leak",
    instruction: "Leave the building, avoid switches or flames, and call 911 or the gas utility from outside.",
  },
  {
    pattern: /\b(carbon[ -]?monoxide|co (?:alarms?|detectors?)|fumes?\b.{0,40}\b(?:headache|dizzy|nause\w*|sick))/gi,
    evidence: "possible carbon monoxide exposure",
    instruction: "Move everyone outside and call 911. Do not re-enter until responders say it is safe.",
  },
  {
    // No bare "fire" or "flame": "furnace won't fire" and "flame sensor" are routine repairs.
    pattern: /\b(on fire|caught fire|active fire|there(?:'s| is) a fire|fire in the|(?:house|electrical|kitchen|attic|basement|garage) fire|open flames?|(?:see|seeing|saw) flames?|flames? (?:coming|shooting|rolling|everywhere|out of)|sparks? (?:and|with) smoke|electrical smoke)\b/gi,
    evidence: "possible fire",
    instruction: "Leave the building and call 911. Do not attempt a repair.",
  },
];

/**
 * "I don't smell gas" / "no gas leak" answers a screening question; it is not a report.
 * Only a negation in the same clause, at most two words before the phrase, cancels it,
 * so "not a joke, I smell gas" still escalates.
 */
function negated(text: string, index: number): boolean {
  const clause = text.slice(0, index).split(/[.,;:!?\n]/).at(-1) ?? "";
  return /(?:\b(?:no|not|never|without)|n't)\s+(?:[\w']+\s+){0,2}$/i.test(clause);
}

function reported(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) if (!negated(text, match.index ?? 0)) return true;
  return false;
}

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
    if (reported(description, rule.pattern)) {
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
  const boundedLlmScore = llmScore === undefined || !Number.isFinite(llmScore) ? 0 : Math.max(0, Math.min(1, llmScore));
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
