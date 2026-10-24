import { z } from "zod";
import type { DbHandle } from "@ashara/db";
import { projectStatusOf, projectWorkItems } from "@ashara/delivery/reads";
import { callTotalsByTaskAndProvider, taskCallsOf } from "@ashara/finance";
import type { ProjectId } from "@ashara/shared";
import { AGENT_CALL_SITE, sessionEvidenceOf, type SessionEvidence } from "@ashara/workplace";

/** The project named for a run report does not exist. */
class RunReportProjectMissing extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`run-report: no project ${projectId} in this database`);
    this.name = "RunReportProjectMissing";
  }
}

const count = z.coerce.number().int().nonnegative();
const usd = z.coerce.number().nonnegative();

const ProjectRowSchema = z.object({ id: z.guid(), name: z.string(), status: z.string() });

/** @testseam run-evidence.test.ts checks unestimatedCalls is required */
export const CallTotalsRowSchema = z.object({
  taskId: z.guid().nullable(),
  provider: z.string(),
  calls: count,
  measuredCalls: count,
  measuredUsd: usd,
  unmeasuredEstimateUsd: usd,
  unestimatedCalls: count,
  pendingCalls: count,
  lostCalls: count,
  zeroCostCalls: count,
  cacheCountedCalls: count,
  inputTokens: count,
  cacheReadTokens: count,
});

const TaskCallRowSchema = z.object({
  taskId: z.guid(),
  callSite: z.string().min(1),
  createdAt: z.coerce.date(),
  costUsd: usd.nullable(),
  inputTokens: count.nullable(),
  contextWindowTokens: z.number().int().positive().nullable(),
});

const WorkItemRowSchema = z.object({
  id: z.guid(),
  level: z.string().min(1),
  parentId: z.guid().nullable(),
  title: z.string(),
  status: z.string(),
  workKind: z.string().nullable(),
  origin: z.string().nullable(),
  checksFor: z.string().nullable(),
  repairsTaskId: z.guid().nullable(),
});

/**
 * One llm_calls row of a task, when it was admitted and by which site. `agentTurn`: its site is
 * AGENT_CALL_SITE, the only site an attempt calls as, so it belongs to one of the task's dev
 * sessions; a call of any other site is no attempt's turn. `costUsd` is NULL when no cost was
 * measured, `inputTokens` when the provider reported none, `contextWindowTokens` (the window of the
 * model it was sent to) on a row recorded before windows were, or not recorded yet.
 */
export interface TaskCall {
  readonly callSite: string;
  readonly createdAt: Date;
  readonly agentTurn: boolean;
  readonly costUsd: number | null;
  readonly inputTokens: number | null;
  readonly contextWindowTokens: number | null;
}

/**
 * One work item of the project, whatever it spent: its level, its parent (work_items.parent_id),
 * its work kind (work_items.work_kind), the producer that wrote it and, for a check task, the task
 * its checks decide (task_spec.origin, task_spec.checksFor; NULL when the row records none), and, on
 * an environment-change task, the task it was opened for (work_items.repairs_task_id;
 * NULL when the row records none).
 */
export type WorkItemEvidence = z.infer<typeof WorkItemRowSchema>;

/**
 * One task's (or, with taskId null, the project's own) llm_calls of one provider. An unmeasured
 * row is one of three: `pendingCalls` admitted and not yet recorded, `lostCalls`
 * admitted by a process that ended before recording them (unmeasured_after_crash), and the rest
 * recorded with no cost measured. `unmeasuredEstimateUsd` sums the worst-case estimates of the
 * unmeasured rows that carry one; `unestimatedCalls` counts those that carry none, whose spend is
 * unknown and in no figure. `zeroCostCalls` counts rows priced at exactly $0, which the
 * ledger must never write; `cacheCountedCalls` are the
 * rows reporting both input and cache-read tokens, the only ones a cache-hit share is taken over.
 */
export type CallTotals = z.infer<typeof CallTotalsRowSchema>;

interface TaskEvidence {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly sessions: readonly SessionEvidence[];
  readonly calls: readonly TaskCall[];
}

export interface RunEvidence {
  readonly project: z.infer<typeof ProjectRowSchema>;
  readonly tasks: readonly TaskEvidence[];
  readonly calls: readonly CallTotals[];
  readonly workItems: readonly WorkItemEvidence[];
}

/**
 * The evidence of one project's run: every task that had a dev session or an
 * llm_calls row, with each session's attempt record and each of its calls (when, by which site),
 * the project's llm_calls totals per task and provider, and every work item of the project with
 * the columns its spend is attributed by. Each context's rows come through its own published read
 * and are validated here on the way in. The project reads 'blocked' while Delivery's halt holds of it.
 */
export async function readRunEvidence(db: DbHandle, projectId: ProjectId): Promise<RunEvidence> {
  const projectRow = await projectStatusOf(db, projectId);
  if (projectRow === null) throw new RunReportProjectMissing(projectId);
  const project = ProjectRowSchema.parse(projectRow);

  const workItems = z.array(WorkItemRowSchema).parse(await projectWorkItems(db, projectId));
  const sessions = await sessionEvidenceOf(db, workItems.map((item) => item.id));
  const calls = z.array(CallTotalsRowSchema).parse(await callTotalsByTaskAndProvider(db, projectId));
  const taskCalls = z.array(TaskCallRowSchema).parse(await taskCallsOf(db, projectId));
  // The tasks that spent anything: a dev session, or a call made for it.
  const spent = new Set([...sessions.map((session) => session.taskId), ...taskCalls.map((call) => call.taskId)]);
  const tasks = workItems.filter((item) => spent.has(item.id)).map((item) => ({ taskId: item.id, title: item.title, status: item.status }));

  return {
    project,
    tasks: tasks.map((task) => ({
      ...task,
      sessions: sessions.filter((s) => s.taskId === task.taskId).map((s) => s.session),
      calls: taskCalls
        .filter((c) => c.taskId === task.taskId)
        .map((c) => ({ callSite: c.callSite, createdAt: c.createdAt, agentTurn: c.callSite === AGENT_CALL_SITE, costUsd: c.costUsd, inputTokens: c.inputTokens, contextWindowTokens: c.contextWindowTokens })),
    })),
    calls,
    workItems,
  };
}
