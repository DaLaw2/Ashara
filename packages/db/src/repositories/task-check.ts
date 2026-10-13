import { and, asc, eq, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../connection.js";
import { dependencies, taskChecks, workItems } from "../schema.js";

// Quality's task checks (migration 036): the checks that decide an implementation
// task, written by the check author in its check task. Append-only by revision.

const TaskCheckFilesSchema = z.array(z.object({ path: z.string().min(1), content: z.string() }).strict());

type TaskCheckFile = z.infer<typeof TaskCheckFilesSchema>[number];

interface TaskCheckDefinition {
  readonly name: string;
  readonly command: string;
}

/** One revision of an implementation task's checks, as the check task harvested it. */
interface NewTaskChecks {
  readonly projectId: string;
  readonly taskId: string;
  readonly checkTaskId: string;
  readonly environmentVersion: string;
  readonly checks: readonly TaskCheckDefinition[];
  readonly files: readonly TaskCheckFile[];
}

interface TaskChecksRecord {
  readonly taskId: string;
  readonly checkTaskId: string;
  readonly revision: number;
  readonly environmentVersion: string;
  readonly checks: readonly TaskCheckDefinition[];
  readonly files: readonly TaskCheckFile[];
}

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

/** A Completed implementation task has no stored check: nothing could tell whether a later merge regressed it. */
class CompletedTaskUnchecked extends Error {
  constructor(
    readonly projectId: string,
    readonly taskId: string,
  ) {
    super(`project ${projectId}: implementation task ${taskId} is Completed but no check is stored for it, so no later merge can be checked against it`);
    this.name = "CompletedTaskUnchecked";
  }
}

export class TaskCheckRepository {
  constructor(private readonly db: Database) {}

  /** The implementation tasks that depend on the check task: the tasks its checks decide. */
  async checkedTasksOf(checkTaskId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: workItems.id })
      .from(dependencies)
      .innerJoin(workItems, eq(workItems.id, dependencies.fromId))
      .where(and(eq(dependencies.toId, checkTaskId), eq(workItems.workKind, "implementation")))
      .orderBy(asc(workItems.id));
    return [...new Set(rows.map((row) => row.id))];
  }

  /**
   * The latest checks of every Completed implementation task of the project except `exceptTaskId`,
   * oldest completion first. A Completed implementation task with none throws: the set is what a
   * later merge must not regress, and an empty one would read as "nothing to regress".
   */
  async completedOf(projectId: string, exceptTaskId: string): Promise<TaskChecksRecord[]> {
    const tasks = await this.db
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          eq(workItems.projectId, projectId),
          eq(workItems.workKind, "implementation"),
          eq(workItems.status, "Completed"),
          ne(workItems.id, exceptTaskId),
        ),
      )
      .orderBy(asc(workItems.updatedAt), asc(workItems.id));
    const records: TaskChecksRecord[] = [];
    for (const task of tasks) {
      const record = await this.latest(task.id);
      if (record === null) throw new CompletedTaskUnchecked(projectId, task.id);
      records.push(record);
    }
    return records;
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
          files,
          environmentVersion: write.environmentVersion,
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
      if (row.checkTaskId !== first.checkTaskId || row.environmentVersion !== first.environmentVersion) {
        throw new TaskChecksCorrupt(taskId, revision, "its rows name different check tasks or environment versions");
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
      checks: rows.map((row) => ({ name: row.name, command: row.command })),
      files: parsed.data,
    };
  }
}
