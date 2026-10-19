import type { ProjectId } from "@ashara/shared";

export interface KnowledgeSink {
  storeFinding(
    projectId: ProjectId,
    taskId: string,
    epicId: string | null,
    title: string,
    content: string,
    tags: string[],
  ): Promise<void>;
}

/**
 * Task-scoping input for `KnowledgeSource` queries. `projectId` is the
 * task's project: a read never returns another project's rows.
 * `epicId` is the task's true Epic ancestor (`null` when the
 * walk found none), narrowing within the project. `queryText` is embedder-free
 * lexical signal derived from the task's own spec (title + goal + endState +
 * scope + deliverables), letting the port rank rows by relevance to THIS task
 * instead of returning an identical top-N to every task in the epic.
 */
export interface KnowledgeScope {
  readonly projectId: ProjectId;
  readonly epicId: string | null;
  readonly queryText: string;
}

export interface KnowledgeSource {
  recentFindings(scope: KnowledgeScope, limit: number): Promise<
    ReadonlyArray<{ title: string; contentSnippet: string; source: string }>
  >;
  failedApproaches(scope: KnowledgeScope, limit: number): Promise<
    ReadonlyArray<{
      title: string;
      failureReason: string;
      learned: string;
    }>
  >;
}

/** The parts of a task's spec a knowledge query reads. */
interface QueriedSpec {
  readonly goal: string;
  readonly endState: string;
  readonly scope: string;
  readonly deliverables: readonly string[];
}

/**
 * Lexical signal for `KnowledgeScope.queryText` — every field a
 * task's own spec carries, joined into one string for `ts_rank`/
 * `plainto_tsquery` to match against.
 */
export function buildKnowledgeQueryText(title: string, spec: QueriedSpec): string {
  return [title, spec.goal, spec.endState, spec.scope, ...spec.deliverables]
    .filter((part) => part.length > 0)
    .join(" ");
}

/** The task a failure lesson is about. */
interface FailedTask {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly title: string;
  /**
   * The task's true Epic ancestor, walked up by Delivery, which owns the work-item hierarchy:
   * `null` when the walk found none. Required: the parent is not the Epic and never stands in for it.
   */
  readonly epicId: string | null;
}

/** How the dispatch ended: its status, its ordinal and the reason it carries. */
interface FailedDispatch {
  readonly status: string;
  readonly attempt: number;
  readonly detail: string;
}

/**
 * Captures a deterministic lesson for a non-completed terminal outcome:
 * `result.detail` already carries the blocking/failure reason (an agent-reported
 * failure/block, a gate/smoke failure, or a verification failure), so no LLM
 * distillation is needed to make it a usable lesson.
 * Stored as a `finding` tagged `task-failure`, so it can be filtered separately. Fail-soft: a write failure is logged and must
 * never affect the result already being returned to the caller.
 */
export async function storeFailureKnowledge(
  knowledgeSink: KnowledgeSink,
  task: FailedTask,
  result: FailedDispatch,
): Promise<void> {
  const title = `${task.title} — ${result.status}`.slice(0, 100);
  const content = `Task '${task.title}' ${result.status} on attempt ${result.attempt}: ${result.detail}`;
  try {
    await knowledgeSink.storeFinding(task.projectId, task.id, task.epicId, title, content, [
      "task-failure",
      `outcome:${result.status}`,
    ]);
  } catch (e) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: a failure finding is context for later briefs; the dispatch's result is already decided and returned, and no verdict, counter or charge reads it
    console.warn(`[${task.id}] failed to store failure knowledge:`, e);
  }
}
