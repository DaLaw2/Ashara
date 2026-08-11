import { recoverFromAbandoned } from "./acl/planning-acl.js";
import type { CoreLoopDeps } from "./types.js";

export async function attemptLivenessRecovery(deps: CoreLoopDeps, runScope: string): Promise<number> {
  const maxRounds = deps.config.maxReplanRounds;
  if (deps.replanRounds >= maxRounds) return 0;
  if (!deps.replanLlm) return 0;

  const allItems = await deps.workItemRepo.listAll();
  const hasInProgress = allItems.some((i) => i.status === "InProgress");
  if (hasInProgress) return 0;

  const vision = await deps.visionRepo.getLatest();
  if (!vision?.visionText) return 0;

  try {
    const created = await recoverFromAbandoned({
      workItemRepo: deps.workItemRepo,
      failedApproachRepo: deps.failedApproachRepo,
      replanLlm: deps.replanLlm,
      visionText: vision.visionText,
      runScope,
    });

    if (created > 0) {
      deps.replanRounds += 1;
      console.log(
        `Liveness recovery round ${deps.replanRounds}/${maxRounds}: created ${created} substitute task(s)`,
      );
    }

    return created;
  } catch (e) {
    console.warn("Liveness recovery failed; propagating to cycle runner:", e);
    throw e;
  }
}
