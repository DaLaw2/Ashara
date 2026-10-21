import { and, asc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { dependencies, taskChecks, workItems } from "@ashara/db";
import type { Database } from "@ashara/db";
import { attemptGrade, CapabilityLevelSchema } from "@ashara/finance";
import type { CapabilityLevel } from "@ashara/finance";
import { isProductScaffoldOrigin, parseWorkItemJsonb, productScaffoldTask } from "../acl/delivery-acl.js";
import type { VisionSource } from "../acl/engagement-acl.js";
import { inLatestCheckRevision, latestCheckRevision, StoredDecidesSchema } from "../stored-checks.js";
import { recordReauthoredRevisionOutcomes } from "./reviewer-outcome.js";

// Quality's task checks: the checks that decide an implementation
// task, written by the check author in its check task. Append-only by revision.

const TaskCheckFilesSchema = z.array(z.object({ path: z.string().min(1), content: z.string() }).strict());

type TaskCheckFile = z.infer<typeof TaskCheckFilesSchema>[number];

/** A count of suite_review_findings rows as Postgres returns it cast to int. */
const ReopenCountSchema = z.number().int().nonnegative();

/** A task's latest stored revision of checks as latestCheckRevision reads it: null when none is stored. */
const StoredRevisionSchema = z.number().int().positive().nullable();

/** The models a task's attempts ran on (dev_sessions.attempt_model), each with its catalog grade (Finance's attemptGrade), as the query aggregates them. */
const AttemptModelsSchema = z.array(z.strictObject({ model: z.string().min(1), grade: CapabilityLevelSchema.nullable() }));

type AttemptModels = z.infer<typeof AttemptModelsSchema>;

interface TaskCheckDefinition {
  readonly name: string;
  readonly command: string;
}

/** A check as its author defined it: with the items it decides, never none. */
interface DefinedTaskCheck extends TaskCheckDefinition {
  readonly decides: readonly [string, ...string[]];
}

/** A stored check: the items it decides, or null when its row records none (written before decides was recorded). */
interface StoredTaskCheck extends TaskCheckDefinition {
  readonly decides: DefinedTaskCheck["decides"] | null;
}

/** One revision of an implementation task's checks, as the check task harvested it. */
interface NewTaskChecks {
  readonly projectId: string;
  readonly taskId: string;
  readonly checkTaskId: string;
  readonly environmentVersion: string;
  /** The commit the checks were red-run on: their plan revision's foundation. */
  readonly baselineCommit: string;
  readonly checks: readonly DefinedTaskCheck[];
  readonly files: readonly TaskCheckFile[];
}

interface TaskChecksRecord {
  readonly taskId: string;
  readonly checkTaskId: string;
  readonly revision: number;
  readonly environmentVersion: string;
  /** null for a revision written before baselines were recorded, whose red run's commit nothing recorded. */
  readonly baselineCommit: string | null;
  readonly checks: readonly StoredTaskCheck[];
  readonly files: readonly TaskCheckFile[];
}

/**
 * A check task's foundation: the merged task its checks are red-run against,
 * or why there is none to red-run against.
 */
type CheckFoundation =
  | { readonly kind: "found"; readonly taskId: string; readonly commit: string }
  | { readonly kind: "none"; readonly reason: string };

/** A project's product scaffolds, read beside a check task's foundations. */
const scaffolds = alias(workItems, "s");

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
  /** How many reviews have reopened it: its suite_review_findings rows. */
  readonly reviewReopens: number;
  /** The grade its task was dispatched at (task_spec.capability); null when the row records none. */
  readonly grade: CapabilityLevel | null;
  /** Every model an attempt on it ran on, oldest first, each with its catalog grade; null for a model the catalog does not hold under the attempt's provider. */
  readonly attemptModels: AttemptModels;
}

interface CompletedChecks {
  readonly checked: TaskChecksRecord[];
  /** Completed implementation tasks with no stored check: nothing of theirs can be re-run. */
  readonly unchecked: string[];
}

/**
 * The checks of a stored revision that the next one drops or changes, and those it keeps as they
 * were. A check is its command run over the revision's files, so changed files change every check.
 */
function comparedChecks(
  taskId: string,
  revision: number,
  previous: ReadonlyArray<{ readonly name: string; readonly command: string; readonly files: unknown }>,
  next: readonly TaskCheckDefinition[],
  nextFiles: readonly TaskCheckFile[],
): { readonly changed: ReadonlySet<string>; readonly kept: ReadonlySet<string> } {
  const commands = new Map(next.map((check) => [check.name, check.command]));
  const nextFilesText = JSON.stringify(nextFiles);
  const changed = new Set<string>();
  const kept = new Set<string>();
  for (const row of previous) {
    const files = TaskCheckFilesSchema.safeParse(row.files);
    if (!files.success) throw new TaskChecksCorrupt(taskId, revision, `files: ${z.prettifyError(files.error)}`);
    if (commands.get(row.name) === row.command && JSON.stringify(files.data) === nextFilesText) kept.add(row.name);
    else changed.add(row.name);
  }
  return { changed, kept };
}

export class TaskCheckRepository {
  constructor(private readonly db: Database) {}

  /**
   * The implementation task the check task's `task_spec.checksFor` names, when one exists: the task
   * its checks decide. Not read from the dependency edges: every implementation task of a plan
   * revision depends on every check task of it.
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
   * The check task's foundation: the task it depends on whose recorded
   * merge commit its checks are red-run on. That is the product scaffold when it
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
                 AND ${productScaffoldTask(scaffolds)}) AS "scaffoldCompletedAt"
      FROM dependencies d JOIN work_items w ON w.id = d.to_id
      WHERE d.from_id = ${checkTaskId}
      ORDER BY w.updated_at DESC, w.id`);
    const rows = z.array(FoundationRowSchema).parse(result.rows);
    const scaffold = rows.find((row) => isProductScaffoldOrigin(row.origin));
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
   * The check tasks a review task depends on: its plan revision's, each
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
        reviewReopens: sql<unknown>`(SELECT count(*) FROM suite_review_findings named WHERE named.check_task_id = ${workItems.id})::int`,
        attemptModels: sql<unknown>`(SELECT coalesce(jsonb_agg(jsonb_build_object('model', s.attempt_model, 'grade', ${attemptGrade(sql`s.attempt_model`, sql`s.attempt_provider`)}) ORDER BY s.created_at, s.id), '[]'::jsonb)
          FROM dev_sessions s
          WHERE s.task_id = ${workItems.id} AND s.attempt_model IS NOT NULL)`,
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
        reviewReopens: ReopenCountSchema.parse(row.reviewReopens),
        grade: taskSpec?.capability ?? null,
        attemptModels: AttemptModelsSchema.parse(row.attemptModels),
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
          inLatestCheckRevision(taskChecks.revision, taskChecks.taskId),
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
      const [latest] = await tx.select({ revision: latestCheckRevision(workItems.id) }).from(workItems).where(eq(workItems.id, write.taskId));
      if (latest === undefined) throw new CheckedTaskMissing(write.taskId);
      // eslint-disable-next-line no-restricted-syntax -- policy default: no stored revision reads null, so this write is the task's first revision
      const revision = (StoredRevisionSchema.parse(latest.revision) ?? 0) + 1;
      await tx.insert(taskChecks).values(
        write.checks.map((check) => ({
          projectId: write.projectId,
          taskId: write.taskId,
          checkTaskId: write.checkTaskId,
          revision,
          name: check.name,
          command: check.command,
          decides: StoredDecidesSchema.unwrap().parse(check.decides),
          files,
          environmentVersion: write.environmentVersion,
          baselineCommit: write.baselineCommit,
        })),
      );
      if (revision > 1) {
        const previous = await tx
          .select({ name: taskChecks.name, command: taskChecks.command, files: taskChecks.files })
          .from(taskChecks)
          .where(and(eq(taskChecks.taskId, write.taskId), eq(taskChecks.revision, revision - 1)));
        await recordReauthoredRevisionOutcomes(tx, { projectId: write.projectId, taskId: write.taskId, checkTaskId: write.checkTaskId, revision, ...comparedChecks(write.taskId, revision - 1, previous, write.checks, files) });
      }
      return revision;
    });
  }

  /** The task's latest revision of checks, or null when none was ever recorded. */
  async latest(taskId: string): Promise<TaskChecksRecord | null> {
    const rows = await this.db
      .select()
      .from(taskChecks)
      .where(and(eq(taskChecks.taskId, taskId), inLatestCheckRevision(taskChecks.revision, taskChecks.taskId)))
      .orderBy(asc(taskChecks.createdAt), asc(taskChecks.name));
    const [first] = rows;
    if (first === undefined) return null;
    const { revision } = first;
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
        const decides = StoredDecidesSchema.safeParse(row.decides);
        if (!decides.success) throw new TaskChecksCorrupt(taskId, revision, `decides of check ${JSON.stringify(row.name)}: ${z.prettifyError(decides.error)}`);
        return { name: row.name, command: row.command, decides: decides.data };
      }),
      files: parsed.data,
    };
  }
}
