import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.js";
import type { Outcome, Violation } from "./invariants.js";
import { WORK_BOUNDS } from "./work-bounds.js";

/*
 * The termination invariants, each judged from outside production and against
 * the oracle's own bounds (work-bounds.ts), never production's constants or counters as the measure:
 * - W1, work bounded: the model requests of each task and each project, counted at the model port
 *   the stand-ins serve (PortCount) and cross-checked against llm_calls, stay within the bounds
 *   table; judged at the run's end whatever it ended in, a spend-cap halt included, so a runaway
 *   loop the dollars stopped is still named;
 * - W2, every round counted: each reopen of a check task by a review or a dispute that the records
 *   show has a persisted count of its own (suite_review_findings, check_disputes), the count stays
 *   within its bound, and no count ever falls between two snapshots, a restart's included;
 * - W3, a measure that decreases: every cycle in which a loop round happened makes the
 *   lexicographic tuple (plan revisions, review namings left, disputes left, requests left) strictly
 *   smaller, or shrinks the set of reopened check tasks; no component is ever below zero; and once
 *   an implementation is dispatched on a review's check set, no review records a new finding on it
 *   (the open-blocker set after the freeze never grows);
 * - W4, liveness: under the liveness profile every project ends through a typed, reported state,
 *   accepted, stopped or halted with its report on anything but the spend cap, never left open and
 *   never ended by the dollars.
 *
 * W1 and W3 are what judge a busy loop: I8 (invariants.ts progressFacts) judges stalls only.
 * Blind spots: W1's per-task port count attributes a call to the lane that made it, so a call a lane
 * makes for no task of its own is counted against the lane's task (and W1 names it as unrecorded);
 * W2 and W3 count the review and dispute loops only, not the stale-check rewrite, environment change
 * or replan loops, whose rounds W1's request bound covers; the freeze clause takes the first
 * recorded move into InProgress of a task depending on the review as the freeze, read by wall clock
 * against the findings' created_at.
 */

/** The model requests the stand-ins' port received, by the lane's task that made each, or outside every lane. */
export class PortCount {
  private readonly byTask = new Map<string, number>();
  private outside = 0;

  record(task: string | null): void {
    if (task === null) {
      this.outside += 1;
      return;
    }
    /* eslint-disable-next-line no-restricted-syntax -- policy default: a task not yet counted has made no request,
       the counter's start */
    this.byTask.set(task, (this.byTask.get(task) ?? 0) + 1);
  }

  of(task: string): number {
    /* eslint-disable-next-line no-restricted-syntax -- policy default: a task the port never served made no request
       through it */
    return this.byTask.get(task) ?? 0;
  }

  total(): number {
    return this.outside + [...this.byTask.values()].reduce((sum, n) => sum + n, 0);
  }

  tasks(): readonly string[] {
    return [...this.byTask.keys()];
  }
}

const requestRow = z.object({
  taskId: z.string().nullable(),
  title: z.string().nullable(),
  requests: z.number().int(),
});

/** One project's llm_calls rows, by the task each names (null: the project's own calls). */
interface ProjectRequests {
  readonly total: number;
  readonly tasks: ReadonlyMap<string, { readonly title: string; readonly requests: number }>;
}

/** Every llm_calls row of each project, in every state: a drawn request is its row. */
export async function readRequests(db: Database, projectIds: readonly string[]): Promise<ProjectRequests[]> {
  const projects: ProjectRequests[] = [];
  for (const projectId of projectIds) {
    const rows = z.array(requestRow).parse(
      (
        await db.execute(sql`
          SELECT c.task_id AS "taskId", w.title, count(*)::int AS requests
          FROM llm_calls c LEFT JOIN work_items w ON w.id = c.task_id
          WHERE c.project_id = ${projectId} GROUP BY c.task_id, w.title`)
      ).rows,
    );
    const tasks = new Map<string, { readonly title: string; readonly requests: number }>();
    for (const row of rows) {
      // A row naming a task that is no work item is named by its id: W1 judges it all the same.
      if (row.taskId !== null)
        tasks.set(row.taskId, { title: row.title === null ? row.taskId : row.title, requests: row.requests });
    }
    projects.push({ total: rows.reduce((sum, row) => sum + row.requests, 0), tasks });
  }
  return projects;
}

/** A violation of one project of the run, by its index: the run keys and states a second project's as its own. */
export interface ProjectViolation {
  readonly project: number;
  readonly violation: Violation;
}

/**
 * W1 over the whole run: each task's requests, at the port and on record, within the per-task
 * bound; each project's on record within the per-project bound; and no request the port answered
 * without its row (a call drawn from no ledger).
 */
export function checkWork(step: number, port: PortCount, projects: readonly ProjectRequests[]): ProjectViolation[] {
  const found: ProjectViolation[] = [];
  const add = (project: number, key: string, statement: string): void => {
    found.push({ project, violation: { invariant: "W1", step, statement, key: `W1:${key}` } });
  };
  const perTask = WORK_BOUNDS.requestsPerTask.value;
  const perProject = WORK_BOUNDS.requestsPerProject.value;
  const recorded = new Set<string>();
  for (const [index, project] of projects.entries()) {
    if (project.total > perProject) {
      add(
        index,
        "project",
        `the project drew ${project.total} model requests, past the bound of ${perProject} ` +
          `(${WORK_BOUNDS.requestsPerProject.decided})`,
      );
    }
    for (const [taskId, task] of project.tasks) {
      recorded.add(taskId);
      const served = port.of(taskId);
      const most = Math.max(served, task.requests);
      if (most > perTask) {
        add(
          index,
          `task:${task.title}`,
          `"${task.title}" drew ${task.requests} model requests on record and ${served} at the model port, ` +
            `past the bound of ${perTask} (${WORK_BOUNDS.requestsPerTask.decided})`,
        );
      }
      if (served > task.requests) {
        add(
          index,
          `unrecorded:${task.title}`,
          `the model port answered ${served} requests of "${task.title}", but llm_calls holds ` +
            `${task.requests}: a request was sent that no ledger drew`,
        );
      }
    }
  }
  for (const taskId of port.tasks().filter((id) => !recorded.has(id))) {
    add(
      0,
      `unrecorded:${taskId}`,
      `the model port answered ${port.of(taskId)} requests of task ${taskId}, which no llm_calls row names: ` +
        `requests were sent that no ledger drew`,
    );
  }
  const rows = projects.reduce((sum, project) => sum + project.total, 0);
  if (port.total() > rows) {
    add(
      0,
      "unrecorded",
      `the model port answered ${port.total()} requests over the run, but llm_calls holds ${rows}: requests ` +
        `were sent that no ledger drew`,
    );
  }
  return found;
}

const checkTaskRow = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  namings: z.number().int(),
  disputes: z.number().int(),
  reviewReopens: z.number().int(),
  disputeReopens: z.number().int(),
});
const projectLoopRow = z.object({ revisions: z.number().int(), requests: z.number().int() });
const grownAfterFreezeRow = z.object({ title: z.string(), findings: z.number().int() });

/** What one project's records show of its review and dispute loops at one instant. */
export interface LoopRecords {
  readonly checkTasks: ReadonlyArray<z.infer<typeof checkTaskRow>>;
  readonly revisions: number;
  readonly requests: number;
  /** Each review task given a finding after the first task depending on it started: its title and those findings. */
  readonly grownAfterFreeze: ReadonlyArray<z.infer<typeof grownAfterFreezeRow>>;
}

/** The loop records of one project, read by the observer outside every seam. */
async function readLoopRecords(db: Database, projectId: string): Promise<LoopRecords> {
  const checkTasks = z.array(checkTaskRow).parse(
    (
      await db.execute(sql`
        SELECT w.id, w.title, w.status,
          (SELECT count(*) FROM suite_review_findings f WHERE f.check_task_id = w.id)::int AS namings,
          (SELECT count(*) FROM check_disputes c WHERE c.check_task_id = w.id)::int AS disputes,
          (SELECT count(*) FROM work_item_transitions t WHERE t.work_item_id = w.id AND t.from_status = 'Completed'
            AND t.to_status = 'Pending'
             AND t.blocked_reason->'replanContext'->'raw' ? 'reviewTaskId')::int AS "reviewReopens",
          (SELECT count(*) FROM work_item_transitions t WHERE t.work_item_id = w.id AND t.from_status = 'Completed'
            AND t.to_status = 'Pending'
             AND t.blocked_reason->'replanContext'->'raw' ? 'disputedCheck')::int AS "disputeReopens"
        FROM work_items w WHERE w.project_id = ${projectId} AND w.work_kind = 'check' ORDER BY w.created_at, w.id`)
    ).rows,
  );
  const [project] = z.array(projectLoopRow).parse(
    (
      await db.execute(sql`
        SELECT (SELECT count(*) FROM plan_revisions r WHERE r.project_id = ${projectId})::int AS revisions,
               (SELECT count(*) FROM llm_calls c WHERE c.project_id = ${projectId})::int AS requests`)
    ).rows,
  );
  if (project === undefined) throw new LoopRecordsMissing(projectId);
  const grownAfterFreeze = z.array(grownAfterFreezeRow).parse(
    (
      await db.execute(sql`
        SELECT r.title, count(f.id)::int AS findings
        FROM work_items r
        JOIN LATERAL (
          SELECT min(t.created_at) AS frozen_at FROM dependencies d
          JOIN work_item_transitions t ON t.work_item_id = d.from_id AND t.to_status = 'InProgress'
          WHERE d.to_id = r.id
        ) frozen ON frozen.frozen_at IS NOT NULL
        JOIN suite_review_findings f ON f.review_task_id = r.id AND f.created_at > frozen.frozen_at
        WHERE r.project_id = ${projectId} AND r.task_spec->>'origin' = 'review'
        GROUP BY r.id, r.title ORDER BY r.title`)
    ).rows,
  );
  return { checkTasks, revisions: project.revisions, requests: project.requests, grownAfterFreeze };
}

/** The aggregate query of a project's loop records returned no row, where it always returns one. */
class LoopRecordsMissing extends Error {
  constructor(readonly projectId: string) {
    super(`the loop records of project ${projectId} returned no aggregate row; W2 and W3 cannot be judged`);
    this.name = "LoopRecordsMissing";
  }
}

/**
 * W3's measure: (plan revisions, negated; review namings left; disputes left; requests left). Smaller is further along.
 * The first plan is a revision too, though plan_revisions records only the ones after it: its check
 * tasks arrive with every naming and dispute left, so a first plan reviewed in the cycle that wrote
 * it is a revision paid for, never a round that grew the measure.
 */
type Measure = readonly [number, number, number, number];

const MEASURE_PARTS = ["plan revisions (negated)", "review namings left", "disputes left", "requests left"] as const;

/**
 * The measure over the check tasks `known` names: a check task a plan wrote since the last snapshot
 * enters with its whole bounds, which no round spent, so it is measured from the next snapshot on.
 */
function measureOf(records: LoopRecords, known: ReadonlySet<string>): Measure {
  const measured = records.checkTasks.filter((task) => known.has(task.id));
  const reviewsLeft = measured.reduce(
    (sum, task) => sum + WORK_BOUNDS.reviewNamingsPerCheckTask.value - task.namings,
    0,
  );
  const disputesLeft = measured.reduce(
    (sum, task) => sum + WORK_BOUNDS.disputesPerCheckTask.value - task.disputes,
    0,
  );
  const revisions = records.revisions + (records.checkTasks.length > 0 ? 1 : 0);
  return [-revisions, reviewsLeft, disputesLeft, WORK_BOUNDS.requestsPerProject.value - records.requests];
}

/** -1 when `a` is lexicographically smaller than `b`, 1 when greater, 0 when equal. */
function compareMeasures(a: Measure, b: Measure): -1 | 0 | 1 {
  for (let i = 0; i < a.length; i++) {
    const [x, y] = [a[i], b[i]];
    if (x === undefined || y === undefined || x === y) continue;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The check tasks reopened and not yet done again: the open blockers a round may shrink. */
function openSet(records: LoopRecords): readonly string[] {
  return records.checkTasks
    .filter(
      (task) =>
        task.status !== "Completed" && task.status !== "Abandoned" && task.reviewReopens + task.disputeReopens > 0,
    )
    .map((task) => task.id);
}

/** What a loop round leaves in the records: any count of it grown. */
function rounds(records: LoopRecords): number {
  return records.checkTasks.reduce(
    (sum, task) => sum + task.namings + task.disputes + task.reviewReopens + task.disputeReopens,
    0,
  );
}

/** The counts W2 holds monotone, per check task: what an earlier snapshot saw is never lost. */
const COUNTS = ["namings", "disputes", "reviewReopens", "disputeReopens"] as const;

/**
 * W2 and W3 on one project's records, against the last snapshot's. `seen` is the highest each count
 * was ever read at (W2's restart clause); `previous` the last snapshot's records, null for the first.
 * @testseam termination.test.ts judges each clause on records it writes; TerminationWatch is its production caller
 */
export function checkLoops(
  step: number,
  records: LoopRecords,
  previous: LoopRecords | null,
  seen: ReadonlyMap<string, number>,
): Violation[] {
  const found: Violation[] = [];
  const add = (invariant: "W2" | "W3", key: string, statement: string): void => {
    found.push({ invariant, step, statement, key: `${invariant}:${key}` });
  };
  const reviewBound = WORK_BOUNDS.reviewNamingsPerCheckTask;
  const disputeBound = WORK_BOUNDS.disputesPerCheckTask;
  for (const task of records.checkTasks) {
    if (task.reviewReopens > task.namings) {
      add(
        "W2",
        `review-uncounted:${task.title}`,
        `"${task.title}" was reopened by a review ${task.reviewReopens} time(s), but suite_review_findings ` +
          `counts ${task.namings} naming(s) of it: a review round left no count`,
      );
    }
    if (task.disputeReopens > task.disputes) {
      add(
        "W2",
        `dispute-uncounted:${task.title}`,
        `"${task.title}" was reopened by a dispute ${task.disputeReopens} time(s), but check_disputes counts ` +
          `${task.disputes}: a dispute round left no count`,
      );
    }
    if (task.namings > reviewBound.value) {
      add(
        "W2",
        `review-bound:${task.title}`,
        `reviews named "${task.title}" ${task.namings} times, past the bound of ${reviewBound.value} ` +
          `(${reviewBound.decided})`,
      );
      add(
        "W3",
        `unfounded:review:${task.title}`,
        `"${task.title}" has ${reviewBound.value - task.namings} review naming(s) left: the measure left its ` +
          `well-founded order`,
      );
    }
    if (task.disputes > disputeBound.value) {
      add(
        "W2",
        `dispute-bound:${task.title}`,
        `"${task.title}" drew ${task.disputes} disputes, past the bound of ${disputeBound.value} ` +
          `(${disputeBound.decided})`,
      );
      add(
        "W3",
        `unfounded:dispute:${task.title}`,
        `"${task.title}" has ${disputeBound.value - task.disputes} dispute(s) left: the measure left its ` +
          `well-founded order`,
      );
    }
    for (const count of COUNTS) {
      const highest = seen.get(`${task.id}:${count}`);
      if (highest !== undefined && task[count] < highest) {
        add(
          "W2",
          `count-fell:${task.title}:${count}`,
          `the ${count} count of "${task.title}" fell from ${highest} to ${task[count]}: a persisted count ` +
            `was lost (a restart included)`,
        );
      }
    }
  }
  if (records.requests > WORK_BOUNDS.requestsPerProject.value) {
    add(
      "W3",
      "unfounded:requests",
      `the project has ${WORK_BOUNDS.requestsPerProject.value - records.requests} model requests left: the ` +
        `measure left its well-founded order`,
    );
  }
  for (const review of records.grownAfterFreeze) {
    add(
      "W3",
      `grew-after-freeze:${review.title}`,
      `"${review.title}" recorded ${review.findings} finding(s) after a task depending on it was dispatched: ` +
        `the open blockers grew after the check set froze, and a frozen check set only shrinks`,
    );
  }
  if (previous !== null && rounds(records) > rounds(previous)) {
    const known = new Set(previous.checkTasks.map((task) => task.id));
    const before = measureOf(previous, known);
    const after = measureOf(records, known);
    const shrank = openSet(records).length < openSet(previous).length;
    if (compareMeasures(after, before) >= 0 && !shrank) {
      const parts = MEASURE_PARTS.map((part, i) => `${part} ${before[i]} -> ${after[i]}`).join(", ");
      add(
        "W3",
        "no-decrease",
        `a loop round left the measure no smaller (${parts}) and the reopened check tasks no fewer`,
      );
    }
  }
  return found;
}

/** W2 and W3 over a run's course: each cycle's records judged against the last cycle's. */
export class TerminationWatch {
  private readonly previous = new Map<string, LoopRecords>();
  private readonly seen = new Map<string, Map<string, number>>();

  async observe(step: number, db: Database, projectIds: readonly string[]): Promise<ProjectViolation[]> {
    const found: ProjectViolation[] = [];
    for (const [project, projectId] of projectIds.entries()) {
      const records = await readLoopRecords(db, projectId);
      const seen = this.seen.get(projectId) ?? new Map<string, number>();
      // A project's first snapshot has no earlier one to compare against.
      for (const violation of checkLoops(step, records, this.previous.get(projectId) ?? null, seen))
        found.push({ project, violation });
      for (const task of records.checkTasks) {
        for (const count of COUNTS) {
          const key = `${task.id}:${count}`;
          seen.set(key, Math.max(task[count], seen.get(key) ?? task[count]));
        }
      }
      this.seen.set(projectId, seen);
      this.previous.set(projectId, records);
    }
    return found;
  }
}

/**
 * W4 on one project's end under the liveness profile: accepted, stopped, or halted on anything but
 * the spend cap (its report is I2's), never open, never stalled (`stalled`: I8's no-progress end)
 * and never ended by the dollars.
 */
export function checkLiveness(step: number, end: Outcome, stalled: boolean, maxCycles: number): Violation[] {
  const at = (key: string, statement: string): Violation[] => [{ invariant: "W4", step, statement, key: `W4:${key}` }];
  if (stalled)
    return at(
      "stalled",
      "under a permanent adversary the project stalled, making no progress, instead of ending through a " +
        "typed, reported state",
    );
  if (end.kind === "open")
    return at(
      "open",
      `under a permanent adversary the project did not end within ${maxCycles} cycles: some loop never exited`,
    );
  if (end.kind === "halted" && end.cause === "spend_cap") {
    return at(
      "spend-cap",
      `under a permanent adversary the project ran to the dollar cap instead of ending through a typed, ` +
        `reported state: ${end.detail}`,
    );
  }
  return [];
}
