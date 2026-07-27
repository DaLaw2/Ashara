import type { ContractDelta, ContractInput, WorkItemId, ProjectKnowledge } from "@ashara/shared";
import { parseProjectId } from "@ashara/shared";
import type { WorkItem, WorkItemRepository, ContractRepository } from "./domain/index.js";
import {
  PlanningService,
  createPendingWorkItem,
  extractSubstitutedBy,
  ContractAlreadyExists,
  ContractConflict,
} from "./domain/index.js";
import type { DecompositionInput, ExistingWorkItemSummary } from "./decomposition-types.js";
import { KnowledgeDerivationError, UnresolvableDependencyError } from "./decomposition-types.js";
import type { DecompositionEngine } from "./decomposition.js";
import {
  deriveContractFragment,
  toContractDelta,
} from "./contract-derivation.js";
import { amendContractWithRetry } from "./contract-retry.js";

export interface StoryDecomposerDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly decompositionEngine: DecompositionEngine;
  readonly repoPath: string;
  readonly readManifestContext?: (dir: string) => Promise<string | undefined>;
  /**
   * Shares ONE database transaction between the work-item creation loop and the
   * derived ProjectContract write (ADR-028 + ADR-029, mig-phase-9): a
   * ContractConflict (a divergent redeclaration — the decomposition batch
   * contradicts what's already declared) rolls back the tasks created in the
   * same call, and any DB failure on either half undoes both.
   *
   * Required (ADR-052). It was optional on the grounds that the contract write
   * was SHADOW mode with no consumer, and that stopped being true: the contract
   * is where this path now READS the project's knowledge graph from, and its
   * absence meant a `contractRepo: null` branch that decomposed against no
   * stated stack at all.
   */
  readonly withPlanningTransaction: <T>(
    fn: (repos: { workItemRepo: WorkItemRepository; contractRepo: ContractRepository }) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Derives the contract fragment this story's tasks (plus the story's own intent
 * text) imply, then seeds it (writeContract) if the project has no contract yet,
 * or merges it in (amendContract) otherwise — the SEED-ONCE-THEN-AMEND protocol
 * (ADR-028). Runs inside the same transaction as task creation; a ContractConflict
 * (genuine divergent redeclaration) propagates to the caller so the whole story's
 * batch rolls back rather than partially applying (mig-phase-9 criterion: a
 * contradictory batch fails loudly). If the pre-check raced a concurrent seed
 * (writeContract sees ContractAlreadyExists), falls back to amending instead of
 * failing the batch.
 *
 * The write is gated on WHAT THIS CALL ACTUALLY ADDS — knowledge included — never
 * on the endpoint/module fragment alone (ADR-046). The old gate returned early
 * whenever the prose regexes found no HTTP method+path and no module path, which
 * is the normal case for a CLI, a library or a kernel: those projects never got a
 * contract at all, and the knowledge graph handed in as a parameter was discarded
 * on the way past. An uninteresting story that adds nothing still writes nothing.
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
  const hasFragment = fragment.endpoints.length > 0 || fragment.modules.length > 0;

  const projectId = parseProjectId(story.parentId ?? story.id);
  const existing = await contractRepo.getLatest(projectId);
  if (!existing) {
    if (!hasFragment && knowledge.nodes.length === 0) return;
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

  // Knowledge merges by KIND (applyContractDelta): a kind the base already has is
  // never overwritten, so a delta carrying only kinds already present is a no-op
  // and must not mint a contract version.
  const establishedKinds = new Set((existing?.knowledge.nodes ?? []).map((n) => n.kind));
  const knowledgeAddsKind = knowledge.nodes.some((n) => !establishedKinds.has(n.kind));
  if (!hasFragment && !knowledgeAddsKind) return;

  await amendContractWithRetry(contractRepo, projectId, { ...toContractDelta(fragment), knowledge });
}

export async function decomposeLeafStories(deps: StoryDecomposerDeps): Promise<number> {
  const stories = await PlanningService.findStoriesNeedingDecomposition(deps.workItemRepo);
  if (stories.length === 0) return 0;

  // The knowledge graph is NOT derived here (ADR-052). Its single producer is
  // DecompositionEngine.decompose, which runs on the vision path and seeds the
  // contract through createBulkPlanWithContract. What used to sit here was a
  // SECOND producer, and it never ran once: its enclosing function returns at
  // line 1 unless a Story-level item exists, and `maxDepth: 2` forces
  // Epic -> Task. The warning it printed on a barren graph — the one naming the
  // Run-36/37 stack loss — was unreachable too.
  //
  // Reading from the contract also makes the contract the single durable source
  // of the graph, which is what ADR-038 intended. A project whose contract
  // states no stack fails closed: decomposing against an empty graph is how a
  // Go vision got `index.js`.
  const projectKnowledge = new Map<string, ProjectKnowledge>();
  for (const story of stories) {
    const projectKey = story.parentId ?? story.id;
    if (projectKnowledge.has(projectKey)) continue;

    const contract = await deps.withPlanningTransaction(({ contractRepo }) =>
      contractRepo.getLatest(parseProjectId(projectKey)),
    );
    if (!contract || contract.knowledge.nodes.length === 0) {
      throw new KnowledgeDerivationError(
        story.title,
        contract
          ? `project ${projectKey} has a contract (v${contract.version}) whose knowledge graph is empty`
          : `project ${projectKey} has no contract to read a knowledge graph from`,
      );
    }
    projectKnowledge.set(projectKey, contract.knowledge);
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
      const knowledge = projectKnowledge.get(projectKey);
      if (!knowledge) {
        throw new KnowledgeDerivationError(
          story.title,
          `no knowledge graph was resolved for project ${projectKey} (story ${story.id})`,
        );
      }
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
      // transaction; a residual endpoint-divergence ContractConflict is now caught
      // fail-soft below (Run-10 blocker #2) so it skips only the contract fragment,
      // never the story's tasks. Any OTHER error still rolls the whole batch back,
      // so a genuine failure never partially applies.
      const createdSummaries = await deps.withPlanningTransaction(async ({ workItemRepo: txRepo, contractRepo }) => {
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
