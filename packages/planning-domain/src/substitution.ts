/**
 * Extracts the id of an explicit substitute recorded on an item's `blockedReason`
 * (migration Phase 6, ADR-029). Written by the orchestrator's `applyAbandon` when
 * the FailureRouter's "substitute" decision fires (failure-recovery.ts) for a
 * failed duplicate whose twin already delivers the work.
 *
 * Single source of this extraction so dependency resolution (dependency.ts, via
 * gate.ts's DependencyContext) and parent-completion cascade (router.ts) apply
 * the identical fail-closed rule for what counts as "the work exists elsewhere."
 */
export function extractSubstitutedBy(
  blockedReason: Record<string, unknown> | undefined,
): string | undefined {
  const value = blockedReason?.substitutedBy;
  return typeof value === "string" ? value : undefined;
}
