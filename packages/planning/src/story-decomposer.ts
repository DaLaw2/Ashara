import type { ContractDelta, ContractInput, ProjectId, WorkItemId, ProjectKnowledge } from "@ashara/shared";
import { parseProjectId } from "@ashara/shared";
import type { WorkItem, WorkItemRepository, ContractRepository } from "@ashara/planning-domain";
import {
  PlanningService,
  createPendingWorkItem,
  extractSubstitutedBy,
  ContractAlreadyExists,
  ContractConflict,
} from "@ashara/planning-domain";
import type { DecompositionInput, ExistingWorkItemSummary } from "./decomposition-types.js";
import { UnresolvableDependencyError } from "./decomposition-types.js";
import type { DecompositionEngine } from "./decomposition.js";
import {
  deriveContractFragment,
  toContractDelta,
  deriveEndpointFeatureKey,
} from "./contract-derivation.js";
import { amendContractWithRetry } from "./contract-retry.js";
import { deriveSpecEndpoints, type SpecDerivationLLM, type SpecVisionInput } from "./spec-derivation.js";

export interface StoryDecomposerDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly decompositionEngine: DecompositionEngine;
  readonly repoPath: string;
  readonly detectTechStack?: (dir: string) => Promise<string[]>;
  readonly readManifestContext?: (dir: string) => Promise<string | undefined>;
  /**
   * Shares ONE database transaction between the work-item creation loop and the
   * derived ProjectContract write (ADR-028 + ADR-029, mig-phase-9): a
   * ContractConflict (a divergent redeclaration — the decomposition batch
   * contradicts what's already declared) rolls back the tasks created in the
   * same call, and any DB failure on either half undoes both. Optional so
   * existing callers/tests that don't supply it keep working unchanged — the
   * contract write is SHADOW mode (no consumer yet), so skipping it here is
   * safe, never a silent failure of anything actually required.
   */
  readonly withPlanningTransaction?: <T>(
    fn: (repos: { workItemRepo: WorkItemRepository; contractRepo: ContractRepository }) => Promise<T>,
  ) => Promise<T>;
  /**
   * The INDEPENDENT spec-derivation pass (ADR-032 §2, mig9-t1). When wired, the
   * project's vision text is derived into required endpoints ONCE per project and
   * folded into the contract before decomposition's own per-story fragments,
   * closing the Run-9 register-gap (an endpoint no task ever planned). Optional and
   * gateway-parameterised: absent (stub mode / no gateway) it is skipped exactly
   * like the shadow contract write — derivation is only REQUIRED where a real
   * gateway is configured, and its only fail-closed exit is ladder exhaustion,
   * which BLOCKS the planning step rather than seeding an empty declaration set.
   */
  readonly specDerivationLlm?: SpecDerivationLLM | null;
}

interface PlanningTxRepos {
  readonly workItemRepo: WorkItemRepository;
  readonly contractRepo: ContractRepository | null;
}

async function runPlanningTransaction<T>(
  deps: StoryDecomposerDeps,
  fn: (repos: PlanningTxRepos) => Promise<T>,
): Promise<T> {
  if (deps.withPlanningTransaction) {
    return deps.withPlanningTransaction(({ workItemRepo, contractRepo }) => fn({ workItemRepo, contractRepo }));
  }
  return deps.workItemRepo.withTransaction((workItemRepo) => fn({ workItemRepo, contractRepo: null }));
}

/**
 * Derives the contract fragment this story's tasks (plus the story's own intent
 * text) imply, then seeds it (writeContract) if the project has no contract yet,
 * or merges it in (amendContract) otherwise — the SEED-ONCE-THEN-AMEND protocol
 * (ADR-028). Runs inside the same transaction as task creation; a ContractConflict
 * (genuine divergent redeclaration) propagates to the caller so the whole story's
 * batch rolls back rather than partially applying (mig-phase-9 criterion: a
 * contradictory batch fails loudly). A no-op fragment (nothing recognized) skips
 * the write entirely so uninteresting stories never seed a contentless contract
 * version. If the pre-check raced a concurrent seed (writeContract sees
 * ContractAlreadyExists), falls back to amending instead of failing the batch.
 */
async function writeOrAmendContract(
  contractRepo: ContractRepository,
  story: WorkItem,
  createdTasks: readonly WorkItem[],
  knowledge: ProjectKnowledge,
): Promise<void> {
  const fragment = deriveContractFragment(
    [{ title: story.title, description: story.description ?? "" }],
    createdTasks.map((t) => ({ id: t.id, title: t.title, description: t.description ?? "" })),
  );
  if (fragment.endpoints.length === 0 && fragment.modules.length === 0) return;

  const projectId = parseProjectId(story.parentId ?? story.id);
  const delta = toContractDelta(fragment);
  const existing = await contractRepo.getLatest(projectId);
  if (!existing) {
    const body: ContractInput = {
      knowledge,
      endpoints: fragment.endpoints,
      modules: fragment.modules,
      mounts: [],
    };
    try {
      await PlanningService.writeContract(contractRepo, projectId, body);
      return;
    } catch (e) {
      if (!(e instanceof ContractAlreadyExists)) throw e;
    }
  }
  await amendContractWithRetry(contractRepo, projectId, delta);
}

/**
 * Runs the INDEPENDENT vision-derived endpoint pass ONCE per project (ADR-032
 * §2, mig9-t1) and folds the result into the ProjectContract via the SAME
 * seed-once-then-amend protocol decomposition uses. The vision text is the
 * project root's OWN intent (title/description/north-star), NOT the task list —
 * so this pass can name an endpoint the plan omitted (the Run-9 register-gap).
 *
 * Idempotency: the guard is the honest `spec-derivation` provenance already in
 * the contract — once any spec-derived endpoint is recorded, the pass is skipped
 * and no LLM call is made. A vision whose derivation collides with every
 * explicit endpoint (or an endpoint-less vision) leaves no such marker and MAY
 * re-derive on a later cycle; that is harmless (the amend dedups by ref) and
 * self-limiting (the pass only attempts while leaf stories still need
 * decomposition — it never fires once the plan is fully expanded).
 *
 * Fail-closed: `deriveSpecEndpoints` raises a typed `SpecDerivationError` on
 * ladder exhaustion. This runs BEFORE the per-story loop's own try/catch, so
 * that error propagates out of `decomposeLeafStories` and BLOCKS the planning
 * step (Discipline A) — it is never downgraded to an empty endpoint set. The
 * LLM call itself is made OUTSIDE any DB transaction; only the short seed/amend
 * write holds one.
 */
async function deriveProjectContractFromVision(
  deps: StoryDecomposerDeps,
  story: WorkItem,
  knowledge: ProjectKnowledge,
  specLlm: SpecDerivationLLM,
): Promise<void> {
  const rootId = story.parentId ?? story.id;
  const projectId = parseProjectId(rootId);

  const pre = await runPlanningTransaction(deps, async ({ contractRepo, workItemRepo }) => {
    if (!contractRepo) return { proceed: false as const };
    const existing = await contractRepo.getLatest(projectId);
    if (existing && existing.endpoints.some((e) => e.source === "spec-derivation")) {
      return { proceed: false as const }; // already derived — idempotent guard
    }
    const root = await PlanningService.findWorkItem(workItemRepo, rootId);
    const vision: SpecVisionInput = root
      ? { title: root.title, description: root.description ?? "", northStar: root.northStar ?? undefined }
      : { title: story.title, description: story.description ?? "", northStar: story.northStar ?? undefined };
    if (`${vision.title} ${vision.description}`.trim().length === 0) {
      return { proceed: false as const };
    }
    // Feature identities decomposition already planned. A spec-derived endpoint
    // whose FEATURE key matches one of these is the SAME feature under a different
    // path namespace (Run-11 schism: /api/auth/login re-declaring /api/login), so it
    // is dropped before it can enter the contract as a duplicate.
    const existingFeatureKeys = existing
      ? new Set(existing.endpoints.map((e) => deriveEndpointFeatureKey(e.method, e.path)))
      : new Set<string>();
    return { proceed: true as const, hasContract: existing !== null, vision, existingFeatureKeys };
  });
  if (!pre.proceed) return;

  const derived = await deriveSpecEndpoints(specLlm, pre.vision);
  // Collapse the dual-namespace schism by feature identity (criterion 1): keep only
  // spec-derived endpoints that do NOT restate a feature decomposition already
  // planned. Decomposition's namespace is canonical (it owns the tasks).
  const endpoints = derived.filter(
    (e) => !pre.existingFeatureKeys.has(deriveEndpointFeatureKey(e.method, e.path)),
  );
  if (endpoints.length === 0) return; // endpoint-less vision or fully-covered by the plan

  await runPlanningTransaction(deps, async ({ contractRepo }) => {
    if (!contractRepo) return;
    if (!pre.hasContract) {
      const body: ContractInput = {
        knowledge,
        endpoints,
        modules: [],
        mounts: [],
      };
      try {
        await PlanningService.writeContract(contractRepo, projectId, body);
        return;
      } catch (e) {
        if (!(e instanceof ContractAlreadyExists)) throw e;
      }
    }
    await amendContractWithRetry(contractRepo, projectId, { endpoints });
  });
}


export async function decomposeLeafStories(deps: StoryDecomposerDeps): Promise<number> {
  const stories = await PlanningService.findStoriesNeedingDecomposition(deps.workItemRepo);
  if (stories.length === 0) return 0;

  // Derive knowledge graph ONCE per project (ADR-038). The graph captures the
  // project's tech stack, entry points, and checks as a DAG, replacing the flat
  // techStack/entryPoint/checks triple. Runs before spec derivation so the
  // knowledge graph seeds the contract first.
  const projectKnowledge = new Map<string, ProjectKnowledge>();
  const emptyKnowledge: ProjectKnowledge = { nodes: [], edges: [] };
  {
    const derivedProjects = new Set<string>();
    for (const story of stories) {
      const projectKey = story.parentId ?? story.id;
      if (derivedProjects.has(projectKey)) continue;
      derivedProjects.add(projectKey);

      const root = await PlanningService.findWorkItem(deps.workItemRepo, projectKey);
      const manifestContext = deps.readManifestContext
        ? await deps.readManifestContext(deps.repoPath)
        : undefined;

      const knowledge = await deps.decompositionEngine.deriveKnowledge(
        root?.title ?? story.title,
        root?.description ?? story.description ?? "",
        root?.northStar ?? story.northStar ?? "",
        manifestContext,
      );
      projectKnowledge.set(projectKey, knowledge ?? emptyKnowledge);
    }
  }

  // INDEPENDENT spec derivation (ADR-032 §2, mig9-t1) runs ONCE per project
  // BEFORE any story is decomposed, so the vision-derived endpoints seed the
  // contract first and decomposition's own fragments amend onto them (explicit
  // task declarations win by ref identity). Placed OUTSIDE the per-story
  // try/catch below so a ladder-exhaustion SpecDerivationError blocks the whole
  // planning step (fail-closed) rather than being swallowed per story.
  if (deps.specDerivationLlm) {
    const derivedProjects = new Set<string>();
    for (const story of stories) {
      const projectKey = story.parentId ?? story.id;
      if (derivedProjects.has(projectKey)) continue;
      derivedProjects.add(projectKey);
      const knowledge = projectKnowledge.get(projectKey) ?? emptyKnowledge;
      await deriveProjectContractFromVision(deps, story, knowledge, deps.specDerivationLlm);
    }
  }

  // Show each story the graph as it stands so far — sibling stories' tasks and anything
  // already created — so it does not re-emit prerequisites (scaffold, wiring, etc.) it
  // cannot otherwise see. Grows as this loop creates tasks for earlier stories in the batch.
  const allItems = await deps.workItemRepo.listAll();
  // Exhausted-abandon items (Abandoned with no substitute, or a substitute that
  // never completed) never delivered their work — they must stay re-proposable,
  // not be presented to the decomposer as "already exists" (Run-9 redteam D2).
  // Substitute-abandon items (blockedReason.substitutedBy) DO suppress: the twin
  // already covers the work, so they stay in the existing-items set as before.
  const existingItems: ExistingWorkItemSummary[] = allItems
    .filter((item) => item.status !== "Abandoned" || extractSubstitutedBy(item.blockedReason) !== undefined)
    .map((item) => ({
      id: item.id,
      title: item.title,
      level: item.level,
      status: item.status,
    }));

  let decomposed = 0;
  for (const story of stories) {
    console.log(`[${story.id}] decomposing leaf story: ${story.title}`);

    let epicTitle = "";
    let epicNorthStar = "";
    if (story.parentId) {
      const epic = await PlanningService.findWorkItem(deps.workItemRepo, story.parentId);
      if (epic) {
        epicTitle = epic.title;
        epicNorthStar = epic.northStar ?? "";
      }
    }

    try {
      const projectKey = story.parentId ?? story.id;
      const knowledge = projectKnowledge.get(projectKey) ?? emptyKnowledge;
      const manifestContext = deps.readManifestContext
        ? await deps.readManifestContext(deps.repoPath)
        : undefined;

      const input: DecompositionInput = {
        epicTitle: epicTitle || story.title,
        epicNorthStar,
        epicDescription: story.description ?? "",
        knowledge,
        conventions: [],
        manifestContext,
      };

      const result = await deps.decompositionEngine.decomposeStoryIntoTasks(
        {
          id: story.id,
          level: "story",
          title: story.title,
          description: story.description ?? "",
          successCriteria: Array.isArray(story.successCriteria)
            ? (story.successCriteria as string[])
            : [],
          dependsOn: [],
        },
        input,
        existingItems,
      );

      // Create all of a story's tasks AND their inter-task edges as one atomic
      // unit (ADR-029): a crash between the create-loop and the edge-loop must
      // not leave orphan tasks whose missing edges make the Gate treat them as
      // prematurely eligible. Newly created summaries are collected inside the
      // transaction and only merged into `existingItems` after it commits, so a
      // rollback leaves no phantom entries visible to later stories in the batch.
      // The derived ProjectContract write (mig-phase-9) shares this same
      // transaction (see runPlanningTransaction); a residual endpoint-divergence
      // ContractConflict is now caught fail-soft below (Run-10 blocker #2) so it
      // skips only the contract fragment, never the story's tasks. Any OTHER error
      // still rolls the whole batch back, so a genuine failure never partially applies.
      const createdSummaries = await runPlanningTransaction(deps, async ({ workItemRepo: txRepo, contractRepo }) => {
        // Map the decomposer's synthetic task id (WorkItemSpec.id, e.g. "task-0007")
        // to the persisted WorkItemId. `WorkItemSpec.dependsOn` already holds those
        // synthetic ids (resolved by ref/title inside DecompositionEngine, G3), so
        // edges must be looked up by spec id — NOT by title, which silently dropped
        // every inter-task edge because a synthetic id never equals a title.
        const specIdToWorkItemId = new Map<string, WorkItemId>();
        const summaries: ExistingWorkItemSummary[] = [];
        const createdTasks: WorkItem[] = [];

        for (const taskSpec of result) {
          const workItem = createPendingWorkItem(
            "Task",
            taskSpec.title,
            story.id as WorkItemId,
            taskSpec.description,
            {
              goal: taskSpec.goal || taskSpec.description || taskSpec.title,
              endState: taskSpec.endState || (taskSpec.successCriteria[0] ?? `${taskSpec.title} is complete`),
              scope: taskSpec.scope,
              checks: taskSpec.checks && taskSpec.checks.length > 0 ? taskSpec.checks : taskSpec.successCriteria,
              deliverables: taskSpec.deliverables ?? [],
            },
          );
          const created = await PlanningService.createWorkItem(txRepo, workItem);
          specIdToWorkItemId.set(taskSpec.id, created.id);
          createdTasks.push(created);
          summaries.push({
            id: created.id,
            title: created.title,
            level: created.level,
            status: created.status,
          });
        }

        for (const taskSpec of result) {
          const taskId = specIdToWorkItemId.get(taskSpec.id);
          if (!taskId) continue;
          for (const depSpecId of taskSpec.dependsOn) {
            const depId = specIdToWorkItemId.get(depSpecId);
            if (!depId) {
              // dependsOn is populated only with ids of kept siblings by the
              // decomposer, so a miss means that invariant was violated. Fail the
              // batch closed (Discipline A) rather than dropping the edge, which
              // is the very failure mode this task exists to remove.
              throw new UnresolvableDependencyError({
                dependentTaskTitle: taskSpec.title,
                unresolvedRef: depSpecId,
                availableRefs: [...specIdToWorkItemId.keys()],
                availableTitles: result.map((t) => t.title),
                parentId: story.id,
              });
            }
            await txRepo.addDependency(taskId, depId);
          }
        }

        if (contractRepo) {
          // FAIL-SOFT ON THE FRAGMENT (Run-10 blocker #2): path normalization now
          // collapses the common {id}/:id and trailing-slash "conflicts", but a
          // RESIDUAL genuine conflict (e.g. a task redeclaring an endpoint at a
          // different METHOD than the spec) must NOT roll back this story's tasks.
          // A wrongly-declared endpoint is worse than a missed one — the tasks are
          // real work; the contract fragment is skipped (logged) and spec-derivation
          // + reconciliation converge coverage later. Only the divergence conflict is
          // swallowed; any other error still fails the batch closed.
          try {
            await writeOrAmendContract(contractRepo, story, createdTasks, knowledge);
          } catch (e) {
            if (!(e instanceof ContractConflict)) throw e;
            console.warn(
              `[${story.id}] contract fragment skipped (residual endpoint conflict, fail-soft): ${e.message}`,
            );
          }
        }

        return summaries;
      });

      existingItems.push(...createdSummaries);

      console.log(`[${story.id}] decomposed into ${result.length} tasks`);
      decomposed += 1;
    } catch (e) {
      console.warn(`[${story.id}] decomposition failed:`, e);
    }
  }

  return decomposed;
}
