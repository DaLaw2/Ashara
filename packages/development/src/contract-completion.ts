/**
 * Completion → ProjectContract amend (mig9-t4).
 *
 * When a task genuinely completes, what it actually delivered becomes knowable
 * DETERMINISTICALLY — no LLM: the concrete HTTP endpoints are derivable from the
 * synced target tree (gates/endpoints.ts deriveEndpoints) and the created/changed
 * source modules are the task's diff. Recording those back onto the contract via
 * the amend protocol is what lets a later failed sibling be recognised as a
 * duplicate by the registry (FailureRouter mig9-t4) and lets downstream briefs list
 * the real reuse-only modules (mig9-t3).
 *
 * The Development BC never imports @ashara/db: the amend crosses the {@link
 * ContractAmender} port (the ContractSource precedent). The
 * composition root shapes the ContractDelta (endpoint-ref derivation is a contract
 * concern) and applies it version-race-safe; this module only gathers observable
 * facts.
 */

/** Observable, deterministically-derived facts about what a completed task delivered. */
export interface CompletionDeliverables {
    readonly endpoints: ReadonlyArray<{ readonly method: string; readonly path: string }>;
    readonly modulePaths: readonly string[];
}

/**
 * Records a completed task's actual deliverables onto its project's contract. The
 * caller invokes this fail-soft — an amend failure must never un-complete a task
 * that genuinely passed its gates.
 */
export interface ContractAmender {
    amendOnCompletion(taskId: string, deliverables: CompletionDeliverables): Promise<void>;
}

const SOURCE_MODULE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE_PATTERN = /\.(test|spec)\./;

/**
 * Selects, from a task's changed files, the ones that are reusable source modules:
 * source-language files that are not tests, type declarations, or the shared entry
 * point (the entry point is edit-only wiring, not a module downstream tasks import).
 * When entryPointPath is provided (from the contract), that exact path is excluded.
 */
export function selectModulePaths(changedFiles: readonly string[], entryPointPath: string | null): string[] {
    const entryPoints = entryPointPath !== null ? new Set([entryPointPath]) : new Set<string>();
    const selected = new Set<string>();
    for (const file of changedFiles) {
        if (!SOURCE_MODULE_PATTERN.test(file)) continue;
        if (TEST_FILE_PATTERN.test(file)) continue;
        if (file.endsWith(".d.ts")) continue;
        if (entryPoints.has(file)) continue;
        selected.add(file);
    }
    return [...selected];
}
