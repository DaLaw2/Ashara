import type { WorkItemId, WorkItemLevel } from "@ashara/shared";
import type { WorkItemRepository } from "./domain/index.js";
import { PlanningService, createPendingWorkItem } from "./domain/index.js";
import type { BrainstormEngine } from "./brainstorm.js";
import type { BrainstormTrigger, BrainstormOutput } from "./brainstorm-types.js";
import { dedupeProposals, type ProposalEmbedder } from "./proposal-dedup.js";

export interface BrainstormTriggerInfo {
  readonly reason: string;
  readonly level: string;
  readonly context: string;
  readonly relatedItemIds: string[];
}

export interface BrainstormLogSink {
  countTasksSinceLast(): Promise<number>;
  insert(
    triggerId: string,
    reason: string,
    level: string,
    itemsCreated: number,
    itemsProposed: number,
  ): Promise<void>;
}

export interface ContextBriefSource {
  getExistingItems(): Promise<
    ReadonlyArray<{ id: string; title: string; level: string; status: string; description: string }>
  >;
  getRecentCompletions(limit: number): Promise<ReadonlyArray<{ title: string; summary: string }>>;
}

export interface BrainstormOrchestrationDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly brainstormEngine: BrainstormEngine;
  readonly brainstormLogSink: BrainstormLogSink;
  readonly contextBriefSource: ContextBriefSource;
  readonly embedder: ProposalEmbedder | null;
  readonly brainstormCooldownThreshold: number;
  readonly maxPendingWorkItems: number;
  readonly maxBrainstormItems: number;
  readonly runScope: string;
}

interface CycleResultLike {
  readonly results: ReadonlyArray<{ readonly taskId: string; readonly status: string }>;
}

type BrainstormGateResult =
  | { readonly allowed: true; readonly tasksSinceLast: number }
  | {
      readonly allowed: false;
      readonly reason: "cooldown_active" | "pending_cap_exceeded";
      readonly tasksSinceLast: number;
    };

async function checkBrainstormGate(
  deps: BrainstormOrchestrationDeps,
): Promise<BrainstormGateResult> {
  const tasksSinceLast = await deps.brainstormLogSink.countTasksSinceLast();
  if (tasksSinceLast < deps.brainstormCooldownThreshold) {
    console.log(
      `Brainstorm skipped: cooldown_active ` +
      `(tasksSinceLastBrainstorm=${tasksSinceLast}, cooldownThreshold=${deps.brainstormCooldownThreshold})`,
    );
    return { allowed: false, reason: "cooldown_active", tasksSinceLast };
  }

  const pending = await PlanningService.findByStatus(deps.workItemRepo, "Pending");
  if (pending.length > deps.maxPendingWorkItems) {
    console.log(
      `Brainstorm skipped: pending_cap_exceeded ` +
      `(pendingWorkItems=${pending.length}, maxPendingWorkItems=${deps.maxPendingWorkItems})`,
    );
    return { allowed: false, reason: "pending_cap_exceeded", tasksSinceLast };
  }

  return { allowed: true, tasksSinceLast };
}

export async function checkBrainstormTriggers(
  deps: BrainstormOrchestrationDeps,
  cycleResult: CycleResultLike,
): Promise<BrainstormTriggerInfo | null> {
  const gate = await checkBrainstormGate(deps);
  if (!gate.allowed) return null;
  const tasksSince = gate.tasksSinceLast;

  const completedIds = cycleResult.results
    .filter((r) => r.status === "completed")
    .map((r) => r.taskId);

  const blockedIds = cycleResult.results
    .filter((r) => r.status === "blocked")
    .map((r) => r.taskId);

  for (const taskId of completedIds) {
    const item = await PlanningService.findWorkItem(deps.workItemRepo, taskId as WorkItemId);
    if (!item) continue;

    if (item.level === "Epic") {
      return {
        reason: "epic_completed",
        level: "deep",
        context: `Epic '${item.title}' completed — major milestone review`,
        relatedItemIds: [taskId],
      };
    }
    if (item.level === "Story") {
      return {
        reason: "story_completed",
        level: "high",
        context: `Story '${item.title}' completed — assess outcomes`,
        relatedItemIds: [taskId],
      };
    }
  }

  if (blockedIds.length > 0) {
    const pending = await PlanningService.findByStatus(deps.workItemRepo, "Pending");
    if (pending.length === 0) {
      return {
        reason: "no_ready_tasks",
        level: "high",
        context: "No ready tasks and blocked items exist — unblock needed",
        relatedItemIds: blockedIds,
      };
    }
    return {
      reason: "task_blocked",
      level: "standard",
      context: `Task ${blockedIds[0]} is blocked`,
      relatedItemIds: [blockedIds[0]!],
    };
  }

  if (completedIds.length > 0) {
    return {
      reason: "tasks_completed",
      level: "standard",
      context: `${tasksSince} tasks completed since last brainstorm — routine check`,
      relatedItemIds: [],
    };
  }

  return null;
}

export async function executeGatedBrainstorm(
  deps: BrainstormOrchestrationDeps,
  trigger: BrainstormTriggerInfo,
): Promise<boolean> {
  const gate = await checkBrainstormGate(deps);
  if (!gate.allowed) {
    console.log(`Brainstorm '${trigger.reason}' suppressed by gate: ${gate.reason}`);
    return false;
  }
  await executeBrainstorm(deps, trigger);
  return true;
}

export async function executeBrainstorm(
  deps: BrainstormOrchestrationDeps,
  trigger: BrainstormTriggerInfo,
): Promise<void> {
  const brainstormTrigger: BrainstormTrigger = {
    reason: trigger.reason as BrainstormTrigger["reason"],
    level: trigger.level as BrainstormTrigger["level"],
    context: trigger.context,
    relatedItemIds: trigger.relatedItemIds,
  };

  const projectContext = await buildProjectContext(deps.contextBriefSource);

  const brainstormOutput: BrainstormOutput = await deps.brainstormEngine.execute(
    brainstormTrigger,
    projectContext,
  );

  const existingItems = await deps.contextBriefSource.getExistingItems();
  const { unique: deduplicated, dropped } = await dedupeProposals(
    brainstormOutput.recommendations,
    existingItems,
    deps.embedder,
  );
  for (const drop of dropped) {
    console.log(
      `Brainstorm dedup removed: "${drop.title}" ` +
      `(method=${drop.method}, similarity=${drop.similarity.toFixed(2)}, matched="${drop.matchedTitle}")`,
    );
  }

  const capped = deduplicated.slice(0, deps.maxBrainstormItems);
  if (deduplicated.length > deps.maxBrainstormItems) {
    console.log(`Brainstorm capped: ${deduplicated.length} → ${deps.maxBrainstormItems}`);
  }

  const existingLevelById = new Map(existingItems.map((item) => [item.id, item.level]));
  const fallbackParentId = resolveFallbackParent(trigger.relatedItemIds, existingLevelById);

  let createdCount = 0;
  for (const rec of capped) {
    let level: WorkItemLevel;
    switch (rec.action) {
      case "create_task": level = "Task"; break;
      case "create_story": level = "Story"; break;
      case "create_feature": level = "Feature"; break;
      default: continue;
    }

    const explicitParentId =
      rec.relatedTo !== undefined ? toExistingWorkItemId(rec.relatedTo, existingLevelById) : null;
    if (rec.relatedTo !== undefined && explicitParentId === null) {
      console.warn(
        `Brainstorm proposal parent unresolved: "${rec.title}" ` +
        `(relatedTo=${rec.relatedTo} not in existing items, falling back to trigger context)`,
      );
    }
    const parentId = explicitParentId ?? fallbackParentId;
    if (parentId === null) {
      console.warn(
        `Brainstorm proposal dropped: "${rec.title}" ` +
        `(reason=unresolved_parent, relatedTo=${rec.relatedTo ?? "none"}, ` +
        `triggerRelatedItemIds=[${trigger.relatedItemIds.join(", ")}])`,
      );
      continue;
    }

    const dependsOnIds: WorkItemId[] = [];
    const invalidDependsOn: string[] = [];
    for (const depId of new Set(rec.dependsOn ?? [])) {
      const resolved = toExistingWorkItemId(depId, existingLevelById);
      if (resolved === null) invalidDependsOn.push(depId);
      else dependsOnIds.push(resolved);
    }
    if (invalidDependsOn.length > 0) {
      console.warn(
        `Brainstorm proposal dropped: "${rec.title}" ` +
        `(reason=unresolved_dependencies, invalidIds=[${invalidDependsOn.join(", ")}])`,
      );
      continue;
    }

    const workItem = createPendingWorkItem(level, rec.title, deps.runScope, parentId, rec.description);
    // Per-proposal atomicity (ADR-029): the item and every declared edge commit
    // or roll back together, so a mid-loop failure never leaves a proposal
    // persisted without its dependencies (which the Gate would treat as ready).
    const created = await deps.workItemRepo.withTransaction(async (txRepo) => {
      const c = await PlanningService.createWorkItem(txRepo, workItem);
      for (const depId of dependsOnIds) {
        await txRepo.addDependency(c.id, depId);
      }
      return c;
    });
    createdCount += 1;
    console.log(
      `Brainstorm created: ${rec.title} (${level}, parent=${parentId}, dependsOn=[${dependsOnIds.join(", ")}])`,
    );
  }

  const triggerId = crypto.randomUUID();
  await deps.brainstormLogSink.insert(
    triggerId,
    trigger.reason,
    trigger.level,
    createdCount,
    brainstormOutput.recommendations.length,
  );

  console.log(
    `Brainstorm completed: ${trigger.reason}, ${createdCount} items created ` +
    `(${brainstormOutput.recommendations.length} proposed)`,
  );
}

const FALLBACK_PARENT_LEVELS: ReadonlySet<string> = new Set(["Epic", "Feature", "Story"]);

/** Narrows a raw ID to WorkItemId only when it names a fetched existing item. */
function toExistingWorkItemId(
  id: string,
  existingLevelById: ReadonlyMap<string, string>,
): WorkItemId | null {
  if (!existingLevelById.has(id)) return null;
  return id as WorkItemId;
}

/** Picks the first trigger-related item that exists and can parent new items (non-Task). */
function resolveFallbackParent(
  relatedItemIds: readonly string[],
  existingLevelById: ReadonlyMap<string, string>,
): WorkItemId | null {
  for (const id of relatedItemIds) {
    const level = existingLevelById.get(id);
    if (level !== undefined && FALLBACK_PARENT_LEVELS.has(level)) {
      return toExistingWorkItemId(id, existingLevelById);
    }
  }
  return null;
}

async function buildProjectContext(source: ContextBriefSource): Promise<string> {
  try {
    const existingItems = await source.getExistingItems();
    const recentCompletions = await source.getRecentCompletions(5);

    const sections: string[] = [];

    if (existingItems.length > 0) {
      sections.push("## Existing Work Items");
      for (const item of existingItems) {
        sections.push(`- ${item.id} [${item.level}] ${item.title} (${item.status})`);
      }
    }

    if (recentCompletions.length > 0) {
      sections.push("\n## Recent Completions");
      for (const item of recentCompletions) {
        sections.push(`- ${item.title}: ${item.summary}`);
      }
    }

    return sections.join("\n");
  } catch (e) {
    console.warn("Failed to build project context for brainstorm:", e);
    return "";
  }
}
