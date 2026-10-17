/**
 * The work ledger's early warning (CCPM's fever chart): how much of
 * a project's budget its work has drawn, against how much of the current plan revision's
 * implementation is done. `yellow` is told to the client; `red`, to the operator and the client,
 * before the budget runs out.
 */
export type BurnZone = "yellow" | "red";

/**
 * A project's burn as read for one plan revision. `drawnRequests` counts every request the project
 * drew, verification's included, so a verification draw only raises the burn, never hides it;
 * `upstreamRequests` is what its work may draw before it halts (ProjectWorkBudget), the line the
 * warning comes before. `plannedTasks` are the revision's implementation tasks, `completedTasks`
 * those of them done.
 */
export interface WorkBurn {
  readonly drawnRequests: number;
  readonly upstreamRequests: number;
  readonly completedTasks: number;
  readonly plannedTasks: number;
}

/**
 * The zone a burn is in, the higher first, or null in neither. Policy defaults:
 * yellow at 50 percent drawn with at most 25 percent of the planned tasks done, red at 80 percent
 * drawn with the plan not finished. A revision with no implementation task planned has none done:
 * an empty plan never reads as a finished one. Integer arithmetic, so no rounding decides a zone.
 */
export function burnZoneOf(burn: WorkBurn): BurnZone | null {
  const drawnPercent = burn.drawnRequests * 100;
  const unfinished = burn.plannedTasks === 0 || burn.completedTasks < burn.plannedTasks;
  if (drawnPercent >= 80 * burn.upstreamRequests && unfinished) return "red";
  if (drawnPercent >= 50 * burn.upstreamRequests && burn.completedTasks * 100 <= 25 * burn.plannedTasks) return "yellow";
  return null;
}
