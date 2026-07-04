import type { ContractDelta, ProjectContract, ProjectId } from "@ashara/shared";
import type { ContractRepository } from "@ashara/planning-domain";
import { PlanningService, ContractVersionConflict } from "@ashara/planning-domain";

const MAX_CONTRACT_RETRY_ATTEMPTS = 3;

/**
 * Retries `amendContract` when a concurrent writer already took the target
 * version (ContractVersionConflict is the documented RETRYABLE signal on the
 * port, planning-domain/src/service.ts) — each retry re-reads the (now newer)
 * latest version internally. Bounded: after MAX_CONTRACT_RETRY_ATTEMPTS the
 * conflict propagates (Discipline A — fail closed, never loop forever). Shared
 * by story-decomposer.ts and coverage-reconciliation.ts, the two ProjectContract
 * amend sites.
 */
export async function amendContractWithRetry(
    contractRepo: ContractRepository,
    projectId: ProjectId,
    delta: ContractDelta,
): Promise<ProjectContract> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_CONTRACT_RETRY_ATTEMPTS; attempt++) {
        try {
            return await PlanningService.amendContract(contractRepo, projectId, delta);
        } catch (e) {
            lastError = e;
            if (!(e instanceof ContractVersionConflict)) throw e;
        }
    }
    throw lastError;
}
