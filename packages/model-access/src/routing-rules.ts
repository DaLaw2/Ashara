import type { CapabilityLevel } from "./capability-level.js";
import { CAPABILITY_RANK, capabilityAbove } from "./capability-rank.js";
import type { SecondOpinionStrength } from "./types.js";

/**
 * The least grade a model may serve a request at a tier with: `tiersAbove` tiers above the tier
 * asked, 0 being the tier itself. A lower model is never substituted.
 */
export interface CapabilityFloor {
  readonly tiersAbove: number;
}

/**
 * The tiers a judge of work is asked at, strongest first, each as tiers above the judged tier
 * (0 is the judged tier itself); a rung past the top tier is skipped. No rung asks below the work.
 */
export interface JudgeRule {
  readonly rungs: readonly [number, ...number[]];
}

/** Which models a second opinion of one strength may go to. */
export type SecondOpinionScope =
  /** An enabled provider other than the avoided one. */
  | "other-provider"
  /** Another model of the avoided provider. */
  | "avoided-provider-other-model"
  /** The avoided model itself, and only when no other enabled model serves the tier. */
  | "avoided-model-alone";

/**
 * The tier a judging request's second opinion is asked at: as its first judge is (the judge rule),
 * or one tier held as a floor, `tiersAbove` tiers above the judged tier.
 */
type SecondOpinionJudging = { readonly kind: "judge-rule" } | { readonly kind: "floor"; readonly tiersAbove: number };

/** Where a second opinion goes when the model it was routed to fails: another provider than the avoided one, or nowhere. */
type SecondOpinionFailover = "other-providers" | "none";

export interface SecondOpinionRule {
  readonly scope: SecondOpinionScope;
  readonly judging: SecondOpinionJudging;
  readonly failover: SecondOpinionFailover;
}

/** Every rule the registry routes by and a message states: each message renders it from the value routing reads. */
export interface RoutingRules {
  readonly capabilityFloor: CapabilityFloor;
  readonly judge: JudgeRule;
  readonly secondOpinion: Readonly<Record<SecondOpinionStrength, SecondOpinionRule>>;
}

/**
 * A same-family second opinion is held to the judged tier, not the judge rule: the verdict reads the
 * weaker of the two reviewers' grades, so a dearer model above the tier buys nothing over one at it.
 */
export const ROUTING_RULES: RoutingRules = {
  capabilityFloor: { tiersAbove: 0 },
  judge: { rungs: [1, 0] },
  secondOpinion: {
    "other-family": { scope: "other-provider", judging: { kind: "judge-rule" }, failover: "other-providers" },
    "same-family-other-model": { scope: "avoided-provider-other-model", judging: { kind: "floor", tiersAbove: 0 }, failover: "none" },
    "same-model": { scope: "avoided-model-alone", judging: { kind: "floor", tiersAbove: 0 }, failover: "none" },
  },
};

/** Whether a model graded `grade` may serve a request at `tier` under `floor`. */
export function meetsFloor(floor: CapabilityFloor, grade: CapabilityLevel, tier: CapabilityLevel): boolean {
  return CAPABILITY_RANK[grade] >= CAPABILITY_RANK[tier] + floor.tiersAbove;
}

/** The tiers a judge of work at `judged` is asked at under `rule`, strongest first, each once. */
export function judgeTiers(rule: JudgeRule, judged: CapabilityLevel): CapabilityLevel[] {
  const tiers: CapabilityLevel[] = [];
  for (const rung of rule.rungs) {
    const tier = capabilityAbove(judged, rung);
    if (tier !== null && !tiers.includes(tier)) tiers.push(tier);
  }
  return tiers;
}

function tiersText(count: number): string {
  return count === 1 ? "one tier" : `${count} tiers`;
}

/** `floor` as a refusal states it, of a tier named `tier`: "graded at or above it". */
export function describeFloor(floor: CapabilityFloor, tier = "it"): string {
  return floor.tiersAbove === 0 ? `graded at or above ${tier}` : `graded at least ${tiersText(floor.tiersAbove)} above ${tier}`;
}

function rungText(rung: number): string {
  return rung === 0 ? "at its tier" : `${tiersText(rung)} above the work`;
}

/** `rule` as a message states it: "graded one tier above the work, else at its tier, never lower". */
export function describeJudgeRule(rule: JudgeRule): string {
  return `graded ${rule.rungs.map(rungText).join(", else ")}, never lower`;
}

/** Why a judge graded at the judged tier was named, under `rule`: the rungs above the work that found no model. */
export function describeEqualJudge(rule: JudgeRule): string {
  const above = rule.rungs.filter((rung) => rung > 0);
  return above.length === 0
    ? "the judge rule asks no tier above the work"
    : `no model ${above.map((rung) => `${tiersText(rung)} above it`).join(" or ")} is routed there`;
}

const SCOPE_TEXT: Readonly<Record<SecondOpinionScope, string>> = {
  "other-provider": "it goes only to an enabled provider other than the avoided one",
  "avoided-provider-other-model": "it goes only to another model of the avoided provider",
  "avoided-model-alone": "it goes only to the avoided model itself, and only when no other enabled model serves the tier",
};

/** The model a judging second opinion of each scope takes, as the selection picks it at a tier. */
const SCOPE_PICK: Readonly<Record<SecondOpinionScope, string>> = {
  "other-provider": "the model routed there",
  "avoided-provider-other-model": "the cheapest such model",
  "avoided-model-alone": "that model",
};

/**
 * The second-opinion rule of `strength` as a refusal states it: the models it may go to, and the
 * tier it is held to, for a judging request or a capability one.
 */
export function describeSecondOpinion(rules: RoutingRules, strength: SecondOpinionStrength, judging: boolean): string {
  const rule = rules.secondOpinion[strength];
  if (!judging) return `${SCOPE_TEXT[rule.scope]}, ${describeFloor(rules.capabilityFloor, "the capability asked")}`;
  if (rule.judging.kind === "judge-rule") return `${SCOPE_TEXT[rule.scope]}, as a judge is: ${describeJudgeRule(rules.judge)}`;
  const floor: CapabilityFloor = { tiersAbove: rule.judging.tiersAbove + rules.capabilityFloor.tiersAbove };
  return `${SCOPE_TEXT[rule.scope]}, ${SCOPE_PICK[rule.scope]} ${describeFloor(floor, "the judged tier")}`;
}

/** Where a second opinion of `rule` that got no answer failed over, as SecondOpinionUnanswered states it. */
export function describeFailover(rule: SecondOpinionRule, avoidedProvider: string): string {
  return rule.failover === "other-providers" ? `and no failover went to ${avoidedProvider}` : "with no failover to another model";
}
