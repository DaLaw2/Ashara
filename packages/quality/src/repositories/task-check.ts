import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { heldSetRejections, suiteReviewFindings, taskChecks } from "@ashara/db/schema/quality";
import type { Database } from "@ashara/db";
import { CapabilityLevelSchema } from "@ashara/finance";
import { attemptsWithModel, unheldItems } from "@ashara/workplace";
import type { CheckDefinition, HoldEvidence } from "@ashara/workplace";
import {
  checkTasksOfReview,
  completedImplementationTaskIds,
  correctedTaskOf,
  foundationCandidates,
  implementationTasksCheckedBy,
  isProductScaffoldOrigin,
  lockTask,
  parseWorkItemJsonb,
  workItemSummaries,
} from "../acl/delivery-acl.js";
import type { CheckFoundation, CheckTaskUnderReview, CompletedTaskChecks, CompletedTasksChecks, NewTaskChecks, ProjectTaskChecks, SetRejection, StoredCheckFile } from "../task-checks.js";
import { inLatestCheckRevision, latestCheckRevision, StoredDecidesSchema } from "../stored-checks.js";
import { recordReauthoredRevisionOutcomes } from "./reviewer-outcome.js";

// Quality's task checks: the checks that decide an implementation
// task, written by the check author in its check task. Append-only by revision.

const TaskCheckFilesSchema = z.array(z.object({ path: z.string().min(1), content: z.string() }).strict());

type TaskCheckFile = z.infer<typeof TaskCheckFilesSchema>[number];

/** A task the plan gave up or superseded: its checks never run again. */
const ABANDONED = "Abandoned";

/** The count of a check task no suite_review_findings row names. */
const NO_REOPEN = 0;

/** A count of suite_review_findings rows as Postgres returns it cast to int. */
const ReopenCountSchema = z.number().int().nonnegative();

/** How many identical held-set rejections a project records, as Postgres returns the count cast to int: at least the one just written. */
const IdenticalCountSchema = z.number().int().positive();

/** `list` as a non-empty tuple, or null when it is empty. */
function nonEmpty(list: readonly string[]): readonly [string, ...string[]] | null {
  const [first, ...rest] = list;
  return first === undefined ? null : [first, ...rest];
}

/** A task's latest stored revision of checks as latestCheckRevision reads it: null when none is stored. */
const StoredRevisionSchema = z.number().int().positive().nullable();

/** The models a task's attempts ran on, each with its catalog grade (Workplace's attempt log, graded by Finance's attemptGrade). */
const AttemptModelSchema = z.strictObject({ model: z.string().min(1), grade: CapabilityLevelSchema.nullable() });

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

/**
 * The checks of a stored revision that the next one drops or changes, and those it keeps as they
 * were. A check is its command run over the revision's files, so changed files change every check.
 */
function comparedChecks(
  taskId: string,
  revision: number,
  previous: ReadonlyArray<{ readonly name: string; readonly command: string; readonly files: unknown }>,
  next: readonly CheckDefinition[],
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
    return implementationTasksCheckedBy(this.db, checkTaskId);
  }

  /**
   * What a check set of implementation task `taskId` that holds whole on its foundation is evidence
   * of (HoldEvidence), one arm for every shape of the records: still-holds only when every item it
   * cites is a key a client correction affects, taken in by a plan revision written at or before
   * it, and decided by the latest checks of another Completed implementation task; otherwise the
   * typed reason it is not. Throws CheckedTaskMissing when no such task exists.
   */
  async holdEvidenceOf(taskId: string): Promise<HoldEvidence> {
    const task = await correctedTaskOf(this.db, taskId);
    if (task === null) throw new CheckedTaskMissing(taskId);
    // eslint-disable-next-line no-restricted-syntax -- evidence default: a task recording no sources cites nothing, which the uncited arm rejects below
    const sources = parseWorkItemJsonb(task).taskSpec?.sources ?? [];
    const cited = nonEmpty([...new Set(sources.map((source) => source.id))]);
    if (cited === null) return { kind: "uncited", taskId };
    const corrected = new Set(task.corrected);
    const correctedCited = nonEmpty(cited.filter((id) => corrected.has(id)));
    const uncorrected = nonEmpty(cited.filter((id) => !corrected.has(id)));
    if (correctedCited === null) return { kind: "uncorrected", items: cited };
    if (uncorrected !== null) return { kind: "partly-corrected", corrected: correctedCited, uncorrected };
    const completed = await this.completedOf(task.projectId, taskId);
    // A check stored before decides was recorded decides nothing on record.
    const decided = new Set(completed.checked.flatMap((record) => record.checks.flatMap((check) => (check.decides === null ? [] : check.decides))));
    const undecided = nonEmpty(cited.filter((id) => !decided.has(id)));
    if (undecided === null) return { kind: "still-holds", items: cited };
    const assumptions = new Set(sources.filter((source) => source.type === "assumption").map((source) => source.id));
    return undecided.every((id) => assumptions.has(id)) ? { kind: "assumption-undecided", items: undecided } : { kind: "undelivered", items: undecided };
  }

  /**
   * Records one rejection of a check set holding whole on its foundation (held_set_rejections) and
   * returns how many identical ones the records hold for its checked task, this one included: the
   * same reason and the same items, rejected for that task or for a task written before it (a plan
   * that planned the same items earlier). A task of the same plan is written with it, before any
   * rejection, so a sibling citing the same items never counts toward its bound. For a task citing
   * no item only its own rejections count. Writing the same check attempt's rejection again counts
   * it once. Throws CheckedTaskMissing when the checked task does not exist.
   */
  async recordSetRejection(rejection: SetRejection): Promise<number> {
    const checked = await correctedTaskOf(this.db, rejection.checkedTaskId);
    if (checked === null) throw new CheckedTaskMissing(rejection.checkedTaskId);
    const items = unheldItems(rejection.evidence);
    const sameTask = eq(heldSetRejections.checkedTaskId, rejection.checkedTaskId);
    await this.db
      .insert(heldSetRejections)
      .values({
        projectId: rejection.projectId,
        checkedTaskId: rejection.checkedTaskId,
        checkTaskId: rejection.checkTaskId,
        attempt: rejection.attempt,
        reason: rejection.evidence.kind,
        items,
      })
      .onConflictDoNothing();
    const [row] = await this.db
      .select({ identical: sql<unknown>`count(*)::int` })
      .from(heldSetRejections)
      .where(
        and(
          eq(heldSetRejections.projectId, rejection.projectId),
          eq(heldSetRejections.reason, rejection.evidence.kind),
          sql`${heldSetRejections.items} = ${sql.param(items)}::text[]`,
          items.length > 0 ? or(sameTask, sql`${heldSetRejections.createdAt} < ${checked.createdAt}::timestamptz`) : sameTask,
        ),
      );
    return IdenticalCountSchema.parse(row?.identical);
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
    const rows = await foundationCandidates(this.db, checkTaskId);
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
    const rows = await checkTasksOfReview(this.db, reviewTaskId);
    const ids = rows.map((row) => row.id);
    const reopens =
      ids.length === 0
        ? []
        : await this.db
            .select({ checkTaskId: suiteReviewFindings.checkTaskId, reopens: sql<unknown>`count(*)::int` })
            .from(suiteReviewFindings)
            .where(inArray(suiteReviewFindings.checkTaskId, ids))
            .groupBy(suiteReviewFindings.checkTaskId);
    const attempts = await attemptsWithModel(this.db, ids);
    return rows.map((row) => {
      const { taskSpec } = parseWorkItemJsonb(row);
      return {
        id: row.id,
        status: row.status,
        checksFor: taskSpec?.checksFor ?? null,
        visionItems: taskSpec?.visionItems ?? null,
        sources: taskSpec?.sources ?? null,
        checkedTitle: row.checkedTitle,
        // A check task no review named has no suite_review_findings row: none reopened it.
        reviewReopens: ReopenCountSchema.parse(reopens.find((counted) => counted.checkTaskId === row.id)?.reopens ?? NO_REOPEN),
        grade: taskSpec?.capability ?? null,
        attemptModels: attempts.filter((attempt) => attempt.taskId === row.id).map((attempt) => AttemptModelSchema.parse({ model: attempt.model, grade: attempt.grade })),
      };
    });
  }

  /**
   * The latest checks of every Completed implementation task of the project except `exceptTaskId` (none when null),
   * oldest completion first, and separately the ids of those with no stored check at all (completed
   * before checks existed), so a caller states them instead of reading their absence as "nothing to
   * regress".
   */
  async completedOf(projectId: string, exceptTaskId: string | null): Promise<CompletedTasksChecks> {
    const tasks = await completedImplementationTaskIds(this.db, projectId, exceptTaskId, "completed");
    const checked: CompletedTaskChecks[] = [];
    const unchecked: string[] = [];
    for (const taskId of tasks) {
      const record = await this.latest(taskId);
      if (record === null) unchecked.push(taskId);
      else checked.push(record);
    }
    return { checked, unchecked };
  }

  /**
   * The files of the latest revision of every task's checks in the project, one entry per task and
   * path. Read for the ownership gate: a stored check file is the check author's, whatever the
   * status of the task it decides.
   */
  async checkFilesOf(projectId: string): Promise<StoredCheckFile[]> {
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
    const paths = new Map<string, StoredCheckFile>();
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
  async storedOfProject(projectId: string, exceptTaskId: string): Promise<ProjectTaskChecks[]> {
    const checkedIds = await this.db.selectDistinct({ taskId: taskChecks.taskId }).from(taskChecks).where(eq(taskChecks.projectId, projectId));
    const tasks = (await workItemSummaries(this.db, checkedIds.map((row) => row.taskId).filter((id) => id !== exceptTaskId)))
      .filter((task) => task.status !== ABANDONED)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const stored: ProjectTaskChecks[] = [];
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
      // Serializes revisions of one task: Delivery's lock on the task row is held until commit.
      if (!(await lockTask(tx, write.taskId))) throw new CheckedTaskMissing(write.taskId);
      const latestRows = await tx.execute(sql`SELECT ${latestCheckRevision(sql`${write.taskId}::uuid`)} AS revision`);
      const [latest] = z.array(z.object({ revision: z.unknown() })).parse(latestRows.rows);
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
  async latest(taskId: string): Promise<CompletedTaskChecks | null> {
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
