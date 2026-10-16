import { and, asc, eq, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { dependencies, taskChecks, workItems } from "@ashara/db";
import type { Database } from "@ashara/db";
import { parseWorkItemJsonb } from "../acl/delivery-acl.js";
import type { VisionSource } from "../acl/engagement-acl.js";

// Quality's task checks (migration 036): the checks that decide an implementation
// task, written by the check author in its check task. Append-only by revision.

const TaskCheckFilesSchema = z.array(z.object({ path: z.string().min(1), content: z.string() }).strict());

/** task_checks.decides (migration 064): the ids of the vision items a check decides; null on a row written before it. */
const TaskCheckDecidesSchema = z.tuple([z.string().min(1)], z.string().min(1)).nullable();

type TaskCheckFile = z.infer<typeof TaskCheckFilesSchema>[number];

interface TaskCheckDefinition {
  readonly name: string;
  readonly command: string;
}

/** A check as its author defined it: with the items it decides, never none. */
interface DefinedTaskCheck extends TaskCheckDefinition {
  readonly decides: readonly [string, ...string[]];
}

/** A stored check: the items it decides, or null when its row records none (written before migration 064). */
interface StoredTaskCheck extends TaskCheckDefinition {
  readonly decides: DefinedTaskCheck["decides"] | null;
}

/** One revision of an implementation task's checks, as the check task harvested it. */
interface NewTaskChecks {
  readonly projectId: string;
  readonly taskId: string;
  readonly checkTaskId: string;
  readonly environmentVersion: string;
  /** The commit the checks were red-run on: their plan revision's foundation (migration 045). */
  readonly baselineCommit: string;
  readonly checks: readonly DefinedTaskCheck[];
  readonly files: readonly TaskCheckFile[];
}

interface TaskChecksRecord {
  readonly taskId: string;
  readonly checkTaskId: string;
  readonly revision: number;
  readonly environmentVersion: string;
  /** null for a revision written before migration 045, whose red run's commit nothing recorded. */
  readonly baselineCommit: string | null;
  readonly checks: readonly StoredTaskCheck[];
  readonly files: readonly TaskCheckFile[];
}

/**
 * A check task's foundation: the merged task its checks are red-run against (ADR-074 addendum 2
 * d74 A), or why there is none to red-run against.
 */
type CheckFoundation =
  | { readonly kind: "found"; readonly taskId: string; readonly commit: string }
  | { readonly kind: "none"; readonly reason: string };

const FoundationRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  mergeCommit: z.string().nullable(),
  origin: z.string().nullable(),
  workKind: z.string().nullable(),
  completedAt: z.coerce.date(),
  scaffoldCompletedAt: z.coerce.date().nullable(),
});

/** A revision with no check: an empty revision would read as "nothing to check". */
class TaskChecksEmpty extends Error {
  constructor(readonly taskId: string) {
    super(`cannot record checks for task ${taskId}: a revision needs at least one check`);
    this.name = "TaskChecksEmpty";
  }
}

/** The rows of one revision disagree, or a row's files do not parse. */
class TaskChecksCorrupt extends Error {
  constructor(
    readonly taskId: string,
    readonly revision: number,
    readonly detail: string,
  ) {
    super(`task_checks of task ${taskId} revision ${revision} cannot be read: ${detail}`);
    this.name = "TaskChecksCorrupt";
  }
}

/** The implementation task the checks are for is not on record. */
class CheckedTaskMissing extends Error {
  constructor(readonly taskId: string) {
    super(`cannot record checks: no work item ${taskId}`);
    this.name = "CheckedTaskMissing";
  }
}

/** A check task a review reads, as stored; nulls are what the row does not record. */
interface CheckTaskUnderReview {
  readonly id: string;
  readonly status: string;
  readonly checksFor: string | null;
  readonly visionItems: readonly string[] | null;
  readonly sources: readonly VisionSource[] | null;
  readonly checkedTitle: string | null;
}

interface CompletedChecks {
  readonly checked: TaskChecksRecord[];
  /** Completed implementation tasks with no stored check: nothing of theirs can be re-run. */
  readonly unchecked: string[];
}

export class TaskCheckRepository {
  constructor(private readonly db: Database) {}

  /**
   * The implementation task the check task's `task_spec.checksFor` names, when one exists: the task
   * its checks decide. Not read from the dependency edges: every implementation task of a plan
   * revision depends on every check task of it (ADR-074 addendum 2 d67 a).
   */
  async checkedTasksOf(checkTaskId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          eq(workItems.workKind, "implementation"),
          sql`${workItems.id}::text = (SELECT check_task.task_spec->>'checksFor' FROM work_items check_task WHERE check_task.id = ${checkTaskId})`,
        ),
      )
      .orderBy(asc(workItems.id));
    return rows.map((row) => row.id);
  }

  /**
   * The check task's foundation (ADR-074 addendum 2 d74 A): the task it depends on whose recorded
   * merge commit (migration 041) its checks are red-run on. That is the product scaffold when it
   * depends on one; otherwise its one dependency: a revision's latest merged state of the layout,
   * or the revision's new environment task. A foundation other than a scaffold must have completed
   * after a Completed product scaffold of the project: a commit merged before the product's layout
   * holds nothing that builds, so every check would fail there for that reason alone. A
   * foundation that is ambiguous, not Completed, without a merge commit on record, or merged before
   * the scaffold is no foundation: the reason says which.
   */
  async foundationOf(checkTaskId: string): Promise<CheckFoundation> {
    const result = await this.db.execute(sql`
      SELECT w.id, w.status, w.merge_commit AS "mergeCommit", w.task_spec->>'origin' AS origin, w.work_kind AS "workKind",
             w.updated_at AS "completedAt",
             (SELECT max(s.updated_at) FROM work_items s
               WHERE s.project_id = w.project_id AND s.status = 'Completed'
                 AND s.task_spec->>'origin' = 'product-scaffold') AS "scaffoldCompletedAt"
      FROM dependencies d JOIN work_items w ON w.id = d.to_id
      WHERE d.from_id = ${checkTaskId}
      ORDER BY w.updated_at DESC, w.id`);
    const rows = z.array(FoundationRowSchema).parse(result.rows);
    const scaffold = rows.find((row) => row.origin === "product-scaffold");
    const [only] = rows;
    const foundation = scaffold ?? (rows.length === 1 ? only : undefined);
    if (foundation === undefined) {
      return {
        kind: "none",
        reason:
          rows.length === 0
            ? `check task ${checkTaskId} depends on no task to red-run its checks on`
            : `check task ${checkTaskId} depends on no product scaffold and on ${rows.length} tasks ` +
              `[${rows.map((row) => row.id).join(", ")}], so which one's merge is its foundation is not known`,
      };
    }
    const what = scaffold !== undefined ? "product scaffold" : `task (${foundation.origin ?? foundation.workKind ?? "no origin"})`;
    if (foundation.status !== "Completed" || foundation.mergeCommit === null) {
      return {
        kind: "none",
        reason:
          `check task ${checkTaskId}'s foundation, ${what} ${foundation.id}, is ${foundation.status} with ` +
          `${foundation.mergeCommit === null ? "no merge commit on record" : `merge commit ${foundation.mergeCommit}`}`,
      };
    }
    if (scaffold === undefined) {
      const scaffoldAt = foundation.scaffoldCompletedAt;
      if (scaffoldAt === null || foundation.completedAt.getTime() <= scaffoldAt.getTime()) {
        return {
          kind: "none",
          reason:
            `check task ${checkTaskId}'s foundation, ${what} ${foundation.id}, ` +
            (scaffoldAt === null
              ? "is no product scaffold, and no product scaffold of the project has completed"
              : `completed at ${foundation.completedAt.toISOString()}, not after the project's product scaffold ` +
                `(completed at ${scaffoldAt.toISOString()})`) +
            `: its merge holds no product layout to red-run the checks on`,
        };
      }
    }
    return { kind: "found", taskId: foundation.id, commit: foundation.mergeCommit };
  }

  /**
   * The check tasks a review task depends on (ADR-074 addendum 2 d71 c): its plan revision's, each
   * with its status, its task_spec as stored (parsed with the row) and the title of the task its
   * checks decide (null when task_spec.checksFor names no work item). Oldest first.
   */
  async checkTasksUnderReview(reviewTaskId: string): Promise<CheckTaskUnderReview[]> {
    const rows = await this.db
      .select({
        id: workItems.id,
        projectId: workItems.projectId,
        status: workItems.status,
        taskSpec: workItems.taskSpec,
        successCriteria: workItems.successCriteria,
        blockedReason: workItems.blockedReason,
        checkedTitle: sql<string | null>`(SELECT checked.title FROM work_items checked WHERE checked.id::text = ${workItems.taskSpec}->>'checksFor')`,
      })
      .from(dependencies)
      .innerJoin(workItems, eq(workItems.id, dependencies.toId))
      .where(and(eq(dependencies.fromId, reviewTaskId), eq(workItems.workKind, "check")))
      .orderBy(asc(workItems.createdAt), asc(workItems.id));
    return rows.map((row) => {
      const { taskSpec } = parseWorkItemJsonb(row);
      return {
        id: row.id,
        status: row.status,
        checksFor: taskSpec?.checksFor ?? null,
        visionItems: taskSpec?.visionItems ?? null,
        sources: taskSpec?.sources ?? null,
        checkedTitle: row.checkedTitle,
      };
    });
  }

  /**
   * The latest checks of every Completed implementation task of the project except `exceptTaskId` (none when null),
   * oldest completion first, and separately the ids of those with no stored check at all (completed
   * before checks existed), so a caller states them instead of reading their absence as "nothing to
   * regress".
   */
  async completedOf(projectId: string, exceptTaskId: string | null): Promise<CompletedChecks> {
    const tasks = await this.db
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          eq(workItems.projectId, projectId),
          eq(workItems.workKind, "implementation"),
          eq(workItems.status, "Completed"),
          exceptTaskId === null ? undefined : ne(workItems.id, exceptTaskId),
        ),
      )
      .orderBy(asc(workItems.updatedAt), asc(workItems.id));
    const checked: TaskChecksRecord[] = [];
    const unchecked: string[] = [];
    for (const task of tasks) {
      const record = await this.latest(task.id);
      if (record === null) unchecked.push(task.id);
      else checked.push(record);
    }
    return { checked, unchecked };
  }

  /**
   * The files of the latest revision of every task's checks in the project, one entry per task and
   * path. Read for the ownership gate: a stored check file is the check author's, whatever the
   * status of the task it decides.
   */
  async checkFilesOf(projectId: string): Promise<Array<{ readonly taskId: string; readonly path: string }>> {
    const rows = await this.db
      .selectDistinct({ taskId: taskChecks.taskId, revision: taskChecks.revision, files: taskChecks.files })
      .from(taskChecks)
      .where(
        and(
          eq(taskChecks.projectId, projectId),
          sql`${taskChecks.revision} = (SELECT max(latest.revision) FROM task_checks latest WHERE latest.task_id = ${taskChecks.taskId})`,
        ),
      )
      .orderBy(asc(taskChecks.taskId));
    const paths = new Map<string, { readonly taskId: string; readonly path: string }>();
    for (const row of rows) {
      const parsed = TaskCheckFilesSchema.safeParse(row.files);
      if (!parsed.success) throw new TaskChecksCorrupt(row.taskId, row.revision, `files: ${z.prettifyError(parsed.error)}`);
      for (const file of parsed.data) paths.set(`${row.taskId}\0${file.path}`, { taskId: row.taskId, path: file.path });
    }
    return [...paths.values()];
  }

  /**
   * The latest checks of every task of the project that has any, except `exceptTaskId` and tasks
   * Abandoned (their checks never run again), each with its task's title, oldest task first. What
   * a check author is shown so the checks it writes do not contradict them.
   */
  async storedOfProject(projectId: string, exceptTaskId: string): Promise<Array<TaskChecksRecord & { readonly title: string }>> {
    const tasks = await this.db
      .selectDistinct({ id: workItems.id, title: workItems.title, createdAt: workItems.createdAt })
      .from(taskChecks)
      .innerJoin(workItems, eq(workItems.id, taskChecks.taskId))
      .where(and(eq(taskChecks.projectId, projectId), ne(workItems.id, exceptTaskId), ne(workItems.status, "Abandoned")))
      .orderBy(asc(workItems.createdAt), asc(workItems.id));
    const stored: Array<TaskChecksRecord & { readonly title: string }> = [];
    for (const task of tasks) {
      const record = await this.latest(task.id);
      if (record === null) throw new TaskChecksCorrupt(task.id, 0, "a task_checks row names it, but no revision of it reads back");
      stored.push({ ...record, title: task.title });
    }
    return stored;
  }

  /** Appends the checks as the task's next revision; returns that revision. */
  async append(write: NewTaskChecks): Promise<number> {
    if (write.checks.length === 0) throw new TaskChecksEmpty(write.taskId);
    const files = TaskCheckFilesSchema.parse(write.files);
    return this.db.transaction(async (tx) => {
      // Serializes revisions of one task: the row lock is held until commit.
      const locked = await tx.execute(sql`SELECT id FROM work_items WHERE id = ${write.taskId} FOR UPDATE`);
      if (locked.rows.length !== 1) throw new CheckedTaskMissing(write.taskId);
      const [latest] = await tx.select({ revision: max(taskChecks.revision) }).from(taskChecks).where(eq(taskChecks.taskId, write.taskId));
      const revision = (latest?.revision ?? 0) + 1;
      await tx.insert(taskChecks).values(
        write.checks.map((check) => ({
          projectId: write.projectId,
          taskId: write.taskId,
          checkTaskId: write.checkTaskId,
          revision,
          name: check.name,
          command: check.command,
          decides: TaskCheckDecidesSchema.unwrap().parse(check.decides),
          files,
          environmentVersion: write.environmentVersion,
          baselineCommit: write.baselineCommit,
        })),
      );
      return revision;
    });
  }

  /** The task's latest revision of checks, or null when none was ever recorded. */
  async latest(taskId: string): Promise<TaskChecksRecord | null> {
    const [latest] = await this.db.select({ revision: max(taskChecks.revision) }).from(taskChecks).where(eq(taskChecks.taskId, taskId));
    const revision = latest?.revision ?? null;
    if (revision === null) return null;
    const rows = await this.db
      .select()
      .from(taskChecks)
      .where(and(eq(taskChecks.taskId, taskId), eq(taskChecks.revision, revision)))
      .orderBy(asc(taskChecks.createdAt), asc(taskChecks.name));
    const [first] = rows;
    if (first === undefined) throw new TaskChecksCorrupt(taskId, revision, "the revision has no rows");
    const parsed = TaskCheckFilesSchema.safeParse(first.files);
    if (!parsed.success) throw new TaskChecksCorrupt(taskId, revision, `files: ${z.prettifyError(parsed.error)}`);
    const filesText = JSON.stringify(parsed.data);
    for (const row of rows) {
      if (
        row.checkTaskId !== first.checkTaskId ||
        row.environmentVersion !== first.environmentVersion ||
        row.baselineCommit !== first.baselineCommit
      ) {
        throw new TaskChecksCorrupt(taskId, revision, "its rows name different check tasks, environment versions or baselines");
      }
      if (JSON.stringify(TaskCheckFilesSchema.safeParse(row.files).data ?? null) !== filesText) {
        throw new TaskChecksCorrupt(taskId, revision, `the files of check ${JSON.stringify(row.name)} differ from the revision's`);
      }
    }
    return {
      taskId,
      checkTaskId: first.checkTaskId,
      revision,
      environmentVersion: first.environmentVersion,
      baselineCommit: first.baselineCommit,
      checks: rows.map((row) => {
        const decides = TaskCheckDecidesSchema.safeParse(row.decides);
        if (!decides.success) throw new TaskChecksCorrupt(taskId, revision, `decides of check ${JSON.stringify(row.name)}: ${z.prettifyError(decides.error)}`);
        return { name: row.name, command: row.command, decides: decides.data };
      }),
      files: parsed.data,
    };
  }
}
