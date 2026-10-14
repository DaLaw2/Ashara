import type { AgentOutputJson } from "@ashara/shared/agent-output";
import type { TaskDescriptor, ExecutionResult } from "./execution-service.js";
import type { TaskSpec } from "./types.js";

export interface KnowledgeSink {
  storeFinding(
    taskId: string,
    epicId: string | null,
    title: string,
    content: string,
    tags: string[],
  ): Promise<void>;
  storeInsight(
    taskId: string | null,
    epicId: string | null,
    title: string,
    content: string,
  ): Promise<void>;
}

/**
 * Task-scoping input for `KnowledgeSource` queries (kl-t2). `epicId` is the
 * task's true Epic ancestor (`TaskDescriptor.epicId`, `null` when the walk
 * found none) — the predicate that closes the cross-project leak Q5
 * identified (`recentFindings` previously had no scope predicate at all).
 * `queryText` is embedder-free lexical signal derived from the task's own
 * spec (title + goal + endState + scope + deliverables), letting the
 * port rank same-epic rows by relevance to THIS task instead of returning an
 * identical top-N to every task in the epic (Q3b).
 */
export interface KnowledgeScope {
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
      affectedArea: string;
    }>
  >;
}

/**
 * Lexical signal for `KnowledgeScope.queryText` (kl-t2/Q3b) — every field a
 * task's own spec carries, joined into one string for `ts_rank`/
 * `plainto_tsquery` to match against. Exported so the ablation rig's
 * `buildKnowledgeContextEquivalent` mirror (`harness/ablation-rig.ts`) derives
 * the identical query text from its own `TaskSpec` rather than drifting from
 * this definition.
 */
export function buildKnowledgeQueryText(title: string, spec: TaskSpec): string {
  return [title, spec.goal, spec.endState, spec.scope, ...spec.deliverables]
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * Persists agent output as knowledge entries. `filesChanged` is the
 * host-computed list from `getChangedFiles(workDir)` (execution-service),
 * not the agent's own observation — the cell's `.git` is a throwaway repository
 * of its own, never the task branch, so Z0 is the single source.
 */
export async function storeKnowledge(
  knowledgeSink: KnowledgeSink,
  task: TaskDescriptor,
  output: AgentOutputJson,
  filesChanged: readonly string[],
): Promise<void> {
  // task.epicId is the true walked-up Epic id the orchestrator resolves
  // (kl-t2/Q5); task.parentId is a fallback for
  // callers that never set epicId (e.g. tests constructing TaskDescriptor
  // directly), not a substitute in production.
  const epicId = task.epicId ?? task.parentId ?? null;

  for (const finding of output.findings) {
    if (finding.length > 0) {
      try {
        await knowledgeSink.storeFinding(
          task.id,
          epicId,
          finding.slice(0, 100),
          finding,
          ["agent-finding"],
        );
      } catch (e) {
        console.warn(`[${task.id}] failed to store finding:`, e);
      }
    }
  }

  const summary = output.summary;
  if (summary) {
    const fileList = filesChanged.join(", ");
    const content = `Task completed: ${summary}\n\nFiles changed: ${fileList}`;
    try {
      await knowledgeSink.storeInsight(task.id, epicId, summary.slice(0, 100), content);
    } catch (e) {
      console.warn(`[${task.id}] failed to store task insight:`, e);
    }
  }
}

/**
 * Captures a deterministic lesson for a non-completed terminal outcome (kl-t4):
 * `result.detail` already carries the blocking/failure reason (an agent-reported
 * failure/block, a gate/smoke failure, or a verification failure), so no LLM
 * distillation is needed to make it a usable lesson (deferred by story decision).
 * Stored as a
 * `finding` tagged distinctly from `storeKnowledge`'s success-path agent findings
 * so it can be filtered separately. Fail-soft: a write failure is logged and must
 * never affect the ExecutionResult already being returned to the caller.
 */
export async function storeFailureKnowledge(
  knowledgeSink: KnowledgeSink,
  task: TaskDescriptor,
  result: ExecutionResult,
): Promise<void> {
  const epicId = task.epicId ?? task.parentId ?? null;
  const title = `${task.title} — ${result.status}`.slice(0, 100);
  const content = `Task '${task.title}' ${result.status} on attempt ${result.attempt}: ${result.detail}`;
  try {
    await knowledgeSink.storeFinding(task.id, epicId, title, content, [
      "task-failure",
      `outcome:${result.status}`,
    ]);
  } catch (e) {
    console.warn(`[${task.id}] failed to store failure knowledge:`, e);
  }
}
