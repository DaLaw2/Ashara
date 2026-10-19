import type { CapabilityLevel } from "./capability-level.js";
import type { JudgeRelation, ModelConfig, ThinkingMode, TierAsk } from "./types.js";

export const CAPABILITY_RANK: Record<CapabilityLevel, number> = {
  Light: 0,
  Medium: 1,
  Strong: 2,
  Frontier: 3,
};

const CAPABILITY_ORDER: readonly CapabilityLevel[] = ["Light", "Medium", "Strong", "Frontier"];

/** The next capability tier up, or null at the top. */
export function nextCapability(capability: CapabilityLevel): CapabilityLevel | null {
  return CAPABILITY_ORDER[CAPABILITY_RANK[capability] + 1] ?? null;
}

/** The tier a request asks at: its capability, or the judged tier of a judging request. */
export function tierOf(ask: TierAsk): CapabilityLevel {
  return ask.judges === undefined ? ask.capability : ask.judges;
}

/** How a judge graded `judgeGrade` stands to work at `judged`; called only on a judge graded at or above it. */
export function judgeRelation(judged: CapabilityLevel, judgeGrade: CapabilityLevel): JudgeRelation {
  return CAPABILITY_RANK[judgeGrade] > CAPABILITY_RANK[judged] ? "above" : "equal";
}

/** The catalog grade of `model` called in thinking mode `mode`: the grade every comparison of tiers reads. */
export function gradeAsCalled(model: ModelConfig, mode: ThinkingMode): CapabilityLevel {
  return mode === "on" ? model.capabilityLevel : model.thinkingOffCapabilityLevel;
}

/** The stronger of two tiers. */
export function higherCapability(a: CapabilityLevel, b: CapabilityLevel): CapabilityLevel {
  return CAPABILITY_RANK[b] > CAPABILITY_RANK[a] ? b : a;
}
