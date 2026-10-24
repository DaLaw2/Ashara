import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { PROJECT_BLOCK_KINDS } from "@ashara/db/schema/delivery";
import { describeErrorChain } from "@ashara/shared";
import { BLOCKED_REASON_SOURCES, BlockedReasonCorrupt, parseStoredBlockedReason } from "@ashara/delivery";
import type { StoredBlockedReason } from "@ashara/delivery";
import {
  checkReports,
  readReportRecords,
  unconfirmedAtPassedSweeps,
  uncheckedAtPassedSweeps,
} from "./client-reports.js";
import type { ObservedReview, ReportRecords } from "./client-reports.js";
import { uncoveredAcceptance } from "./client-report-core.js";
import type { Database } from "./database.js";
import type { FakeCell } from "./fake-podman.js";
import type { FaultKind, FaultRecord } from "./faults.js";
import { lazyIntakes, readIntakeRecords } from "./intake-readings.js";
import type { IntakeRecords, ObservedIntake } from "./intake-readings.js";
import { MISREAD_REJECTION_MARKER } from "./product.js";
import { projectState } from "./project-state.js";
import { checkTextFacts, declinedWork, readTextFactRecords } from "./text-facts.js";
import type { TextFactRecords } from "./text-facts.js";

const run = promisify(execFile);

/**
 * The invariants I1-I10, as judged on today's schema, the termination invariants W1-W4
 * (termination.ts), and L1, log correlation (log-correlation.ts).
 */
const INVARIANTS = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I10", "W1", "W2", "W3", "W4", "L1"] as const;
type InvariantId = (typeof INVARIANTS)[number];

export interface Violation {
  readonly invariant: InvariantId;
  readonly step: number;
  /** One line, the rows involved named: what a reader acts on. */
  readonly statement: string;
  /**
   * The invariant and the violation's subject, named by what a seed reproduces (a task's title, a
   * state, a block kind), never by a database id or a commit hash: equal for the same defect seen
   * again at a later step, so each is reported once, and stable across runs of one seed, so
   * expected-failures.ts can name it.
   */
  readonly key: string;
}

const itemRow = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  level: z.string(),
  workKind: z.string().nullable(),
  origin: z.string().nullable(),
  checksFor: z.string().nullable(),
  blockedReason: z.unknown(),
  mergeCommit: z.string().nullable(),
  /** How the recorded commit closed the item: merged or already_delivered. */
  mergeKind: z.string().nullable(),
  ownerRoleId: z.string().nullable(),
  dispatchCount: z.number(),
  infrastructureFaults: z.number(),
  /** The vision keys its task_spec's sources cite; none when it records no sources. */
  cites: z.array(z.string()),
});
type ItemRow = z.infer<typeof itemRow>;

const projectRow = z.object({
  status: z.string(),
  blockedCategory: z.string().nullable(),
  blockedReason: z.string().nullable(),
  planStopped: z.boolean(),
  workspacePath: z.string().nullable(),
  /**
   * The contained steps of the project waiting out a fault's backoff (its unparked step_faults rows), by name: a
   * report it owes may wait with them.
   */
  retryingSteps: z.array(z.string().min(1)),
  /** The project's latest passed acceptance sweep, and the delivered report recorded on it; null when none passed. */
  passedSweepId: z.string().nullable(),
  passedSweepReportId: z.string().nullable(),
});
type ProjectRow = z.infer<typeof projectRow>;

/**
 * A halt episode, how it ended, and the reports that told the client of it and of its resumption. A
 * planning stop is told by the planning-stopped report (one client message, reports_on
 * 'planning-stopped', posted after the stop), which its episode row does not link: that message is its report.
 */
const episodeRow = z.object({
  id: z.string(),
  kind: z.string(),
  reportId: z.string().nullable(),
  ended: z.boolean(),
  /** unblocked, probe_passed or client_stop once ended; null while open. */
  endKind: z.string().nullable(),
  resumedReportId: z.string().nullable(),
});
/**
 * A client stop: whether it is the one that stopped the project (stop_found_halted is written only
 * then), and whether the stop report was posted in reply to it.
 */
const stopRow = z.object({ id: z.string(), stoppedProject: z.boolean(), reported: z.boolean() });
const checkRow = z.object({
  taskId: z.string(),
  checkTaskId: z.string(),
  revision: z.number(),
  name: z.string(),
  files: z.array(z.object({ path: z.string() })),
});
/** One status change of a work item, recorded by work_items' trigger in the statement that made it. */
const transitionRow = z.object({ workItemId: z.string(), from: z.string(), to: z.string() });
const findingRow = z.object({ checkTaskId: z.string(), problem: z.string() });
/**
 * A client correction recorded as holding work: the vision version it wrote, the keys it affects, the
 * tasks citing one of them that were started after it was recorded and before its revision, and the
 * guarantees resting on an affected assumption (each it underpins, and each citing it as its source),
 * in the version it was applied to or the one it wrote, that it does not affect.
 */
const correctionRow = z.object({
  visionVersion: z.number(),
  affected: z.array(z.string()),
  startedWhileHeld: z.array(z.string()),
  unreached: z.array(z.string()),
});

interface MainCommit {
  readonly commit: string;
  readonly subject: string;
}

export interface Snapshot {
  readonly projectId: string;
  readonly project: ProjectRow;
  readonly items: readonly ItemRow[];
  readonly episodes: ReadonlyArray<z.infer<typeof episodeRow>>;
  /** Every stop the client sent, oldest first. */
  readonly stops: ReadonlyArray<z.infer<typeof stopRow>>;
  readonly checks: ReadonlyArray<z.infer<typeof checkRow>>;
  /** Every problem a suite review's recorded findings route to a check task, as recorded. */
  readonly reviewFindings: ReadonlyArray<z.infer<typeof findingRow>>;
  /** Every client correction recorded as holding work, released or not (I2's correction clause). */
  readonly corrections: ReadonlyArray<z.infer<typeof correctionRow>>;
  readonly spendUsd: number;
  readonly unrecordedCalls: number;
  /** Every status change of the project's work items, oldest first (work_item_transitions). */
  readonly transitions: ReadonlyArray<z.infer<typeof transitionRow>>;
  readonly main: readonly MainCommit[];
  /** What the client was sent and the records each report is rendered from (I4). */
  readonly reports: ReportRecords;
  /** What every brief, question and report states, with the records it is composed from (I9). */
  readonly textFacts: TextFactRecords;
  /** The tender's reading as recorded, and the questions posted (I3's intake clause). */
  readonly intake: IntakeRecords;
}

/** A snapshot query returned no row where it always returns one: the invariants cannot be judged. */
class SnapshotRowMissing extends Error {
  constructor(
    readonly projectId: string,
    readonly table: string,
    readonly expected: string,
  ) {
    super(`snapshot of project ${projectId}: ${table} returned no row; expected ${expected}`);
    this.name = "SnapshotRowMissing";
  }
}

/**
 * The project's row: its state, its open block, whether its plan stopped, and its latest passed sweep
 * with the report that told it.
 */
async function readProjectRow(db: Database, projectId: string): Promise<ProjectRow> {
const [project] = z.array(projectRow).parse(
  (
    await db.execute(sql`
      SELECT ${projectState} AS status,
             (SELECT b.kind FROM project_blocks b
               WHERE b.project_id = projects.id AND b.ended_at IS NULL) AS "blockedCategory",
             (SELECT b.reason FROM project_blocks b
               WHERE b.project_id = projects.id AND b.ended_at IS NULL) AS "blockedReason",
             EXISTS (SELECT 1 FROM project_plans pp WHERE pp.project_id = projects.id
               AND pp.plan_stopped_at IS NOT NULL) AS "planStopped", workspace_path AS "workspacePath",
             ARRAY(SELECT f.step FROM step_faults f WHERE f.project_id = projects.id
               AND f.parked_at IS NULL ORDER BY f.step) AS "retryingSteps",
             (SELECT s.id FROM acceptance_sweeps s WHERE s.project_id = projects.id AND s.passed
               ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS "passedSweepId",
             (SELECT (SELECT t.report_id FROM told_reports t WHERE t.subject_kind = 'delivered'
               AND t.subject_id = s.id) FROM acceptance_sweeps s WHERE s.project_id = projects.id AND s.passed
                 ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS "passedSweepReportId"
      FROM projects WHERE id = ${projectId}`)
  ).rows,
);
if (project === undefined) throw new SnapshotRowMissing(projectId, "projects", "the run's project row");
  return project;
}

/** The project's work items, oldest first, each with the record keys it cites. */
async function readItems(db: Database, projectId: string): Promise<ItemRow[]> {
const items = z.array(itemRow).parse(
  (
    await db.execute(sql`
      SELECT id, title, status, level, work_kind AS "workKind", task_spec->>'origin' AS origin,
             task_spec->>'checksFor' AS "checksFor", blocked_reason AS "blockedReason", merge_commit AS "mergeCommit",
               merge_kind AS "mergeKind",
             owner_role_id AS "ownerRoleId", dispatch_count AS "dispatchCount",
             infrastructure_faults AS "infrastructureFaults",
             COALESCE((SELECT json_agg(s->>'id') FROM jsonb_array_elements(CASE
               WHEN jsonb_typeof(task_spec->'sources') = 'array'
               THEN task_spec->'sources' ELSE '[]'::jsonb END) s), '[]'::json) AS cites
      FROM work_items WHERE project_id = ${projectId} ORDER BY created_at, id`)
  ).rows,
);
  return items;
}

/** The project's block episodes, oldest first, each with the reports that told its block and its resumption. */
async function readEpisodes(db: Database, projectId: string): Promise<Array<z.infer<typeof episodeRow>>> {
const episodes = z.array(episodeRow).parse(
  (
    await db.execute(sql`
      SELECT b.id, b.kind, ended_at IS NOT NULL AS ended, b.end_kind AS "endKind", (SELECT t.report_id
        FROM told_reports t WHERE t.subject_kind = 'project-resumed' AND t.subject_id = b.id) AS "resumedReportId",
             COALESCE((SELECT t.report_id FROM told_reports t WHERE t.subject_kind = 'project-blocked'
               AND t.subject_id = b.id), CASE WHEN b.kind = 'planning_stopped' THEN (
               SELECT m.id FROM client_messages m WHERE m.project_id = b.project_id
                 AND m.reports_on = 'planning-stopped'
                 AND m.created_at >= b.blocked_at ORDER BY m.created_at, m.id LIMIT 1) END) AS "reportId"
      FROM project_blocks b WHERE b.project_id = ${projectId} ORDER BY b.blocked_at, b.id`)
  ).rows,
);
  return episodes;
}

/** Every client correction recorded as holding work, with what it held and what it left unreached (correctionRow). */
async function readCorrections(db: Database, projectId: string): Promise<Array<z.infer<typeof correctionRow>>> {
const corrections = z.array(correctionRow).parse(
  (
    await db.execute(sql`
      SELECT ch.vision_version AS "visionVersion", ch.affected,
             COALESCE((SELECT json_agg(DISTINCT w.title) FROM work_items w
               JOIN work_item_transitions t ON t.work_item_id = w.id AND t.to_status = 'InProgress'
               WHERE w.project_id = ch.project_id AND w.level = 'Task'
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE
                   WHEN jsonb_typeof(w.task_spec->'sources') = 'array'
                   THEN w.task_spec->'sources' ELSE '[]'::jsonb END) s WHERE s->>'id' = ANY(ch.affected))
                 AND t.created_at > ch.created_at
                 AND t.created_at < COALESCE((SELECT r.created_at FROM plan_revisions r
                   WHERE r.id = ch.plan_revision_id), 'infinity'::timestamptz)),
               '[]'::json) AS "startedWhileHeld",
             COALESCE((SELECT json_agg(DISTINCT u.key ORDER BY u.key) FROM (
                 SELECT u.key FROM vision_documents d,
                   jsonb_array_elements(CASE WHEN jsonb_typeof(d.inferences) = 'array'
                     THEN d.inferences ELSE '[]'::jsonb END) i,
                   jsonb_array_elements_text(CASE WHEN jsonb_typeof(i->'underpins') = 'array'
                     THEN i->'underpins' ELSE '[]'::jsonb END) u(key)
                   WHERE d.project_id = ch.project_id AND d.version IN (ch.vision_version - 1, ch.vision_version)
                     AND i->>'key' = ANY(ch.affected)
                 UNION
                 SELECT g->>'id' FROM vision_documents d,
                   jsonb_array_elements(CASE WHEN jsonb_typeof(d.guarantees) = 'array'
                     THEN d.guarantees ELSE '[]'::jsonb END) g
                   WHERE d.project_id = ch.project_id AND d.version IN (ch.vision_version - 1, ch.vision_version)
                     AND g->'source'->>'kind' = 'assumption' AND g->'source'->>'id' = ANY(ch.affected)
               ) u(key) WHERE NOT u.key = ANY(ch.affected)),
               '[]'::json) AS "unreached"
      FROM correction_holds ch WHERE ch.project_id = ${projectId} ORDER BY ch.vision_version`)
  ).rows,
);
  return corrections;
}

/** The project's spend and the count of its calls with no cost recorded or estimated. */
async function readSpend(
  db: Database,
  projectId: string,
): Promise<{ readonly spend: number; readonly unrecorded: number }> {
const [spend] = z.array(z.object({ spend: z.coerce.number(), unrecorded: z.coerce.number() })).parse(
  (
    await db.execute(sql`
      SELECT coalesce(sum(coalesce(cost_usd, estimated_cost_usd)), 0) AS spend,
             count(*) FILTER (WHERE cost_usd IS NULL AND estimated_cost_usd IS NULL) AS unrecorded
      FROM llm_calls WHERE project_id = ${projectId}`)
  ).rows,
);
// I5 is judged on this row: without it the spend would read as zero and the cap could not be seen crossed.
if (spend === undefined) throw new SnapshotRowMissing(projectId, "llm_calls", "the spend aggregate row");
  return spend;
}

/** Every lifecycle row of the run's one project, and main's first-parent log. */
export async function readSnapshot(db: Database, projectId: string): Promise<Snapshot> {
  const project = await readProjectRow(db, projectId);
  const items = await readItems(db, projectId);
  const episodes = await readEpisodes(db, projectId);
  const stops = z.array(stopRow).parse(
    (
      await db.execute(sql`
        SELECT m.id, m.stop_found_halted IS NOT NULL AS "stoppedProject",
               EXISTS (SELECT 1 FROM client_messages r WHERE r.in_reply_to = m.id AND r.direction = 'outbound'
                 AND r.reports_on = 'client-stop') AS reported
        FROM client_messages m WHERE m.project_id = ${projectId} AND m.direction = 'inbound' AND m.kind = 'stop'
          ORDER BY m.created_at, m.id`)
    ).rows,
  );
  const checks = z.array(checkRow).parse(
    (
      await db.execute(sql`
        SELECT task_id AS "taskId", check_task_id AS "checkTaskId", revision, name, files
        FROM task_checks WHERE project_id = ${projectId} ORDER BY task_id, revision, name`)
    ).rows,
  );
  const reviewFindings = z.array(findingRow).parse(
    (
      await db.execute(sql`
        SELECT f.check_task_id AS "checkTaskId", p.problem->>'problem' AS problem
        FROM suite_review_findings f, jsonb_array_elements(f.problems) AS p(problem)
        WHERE f.project_id = ${projectId} ORDER BY f.created_at, f.id`)
    ).rows,
  );
  const corrections = await readCorrections(db, projectId);
  const spend = await readSpend(db, projectId);
  const transitions = z.array(transitionRow).parse(
    (
      await db.execute(sql`
        SELECT t.work_item_id AS "workItemId", t.from_status AS "from", t.to_status AS "to"
        FROM work_item_transitions t JOIN work_items w ON w.id = t.work_item_id
        WHERE w.project_id = ${projectId}
        ORDER BY t.created_at, t.id`)
    ).rows,
  );
  return {
    projectId,
    project,
    items,
    episodes,
    stops,
    checks,
    reviewFindings,
    corrections,
    spendUsd: spend.spend,
    unrecordedCalls: spend.unrecorded,
    transitions,
    main: project.workspacePath === null ? [] : await mainLog(project.workspacePath),
    reports: await readReportRecords(db, projectId),
    textFacts: await readTextFactRecords(db, projectId, project.workspacePath),
    intake: await readIntakeRecords(db, projectId),
  };
}

/** The observer could not read main of a target repository: the snapshot would judge against nothing. */
class MainUnreadable extends Error {
  constructor(
    readonly repository: string,
    readonly command: string,
    options: { readonly cause: unknown },
  ) {
    super(`git ${command} of ${repository} failed: ${describeErrorChain(options.cause)}`, options);
    this.name = "MainUnreadable";
  }
}

const gitExit = z.object({ code: z.number() });
const absentPath = z.object({ code: z.literal("ENOENT") });

/** Whether `path` exists; any failure but its absence is the observer's own and throws. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (absentPath.safeParse(err).success) return false;
    throw err;
  }
}

/**
 * Whether main has a commit yet. The project's path is recorded before its repository is made
 * (orchestrator task-helpers.ts), and a crash may land between them: no directory, a directory
 * with no repository, or a repository with no main are each "nothing on main yet". Every other
 * git failure throws: a corrupt or unreadable repository is never read as an empty main.
 */
async function hasMain(repository: string): Promise<boolean> {
  if (!(await exists(repository)) || !(await exists(join(repository, ".git")))) return false;
  try {
    await run("git", ["-C", repository, "rev-parse", "--verify", "--quiet", "refs/heads/main"]);
    return true;
  } catch (err) {
    // rev-parse --verify --quiet exits 1, printing nothing, only for a ref that does not exist.
    const exit = gitExit.safeParse(err);
    if (exit.success && exit.data.code === 1) return false;
    throw new MainUnreadable(repository, "rev-parse --verify refs/heads/main", { cause: err });
  }
}

/** main's first-parent history, read by the host's git outside every seam (the observer is never faulted). */
async function mainLog(repository: string): Promise<MainCommit[]> {
  if (!(await hasMain(repository))) return [];
  try {
    const { stdout } = await run("git", ["-C", repository, "log", "--first-parent", "--format=%H%x00%s", "main"]);
    return stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [commit = "", subject = ""] = line.split("\0");
        return { commit, subject };
      });
  } catch (err) {
    throw new MainUnreadable(repository, "log main", { cause: err });
  }
}

/** The files main holds, read like mainLog; none when main has no commit. */
export async function mainFiles(repository: string): Promise<string[]> {
  if (!(await hasMain(repository))) return [];
  try {
    const { stdout } = await run("git", ["-C", repository, "ls-tree", "-r", "--name-only", "main"]);
    return stdout.split("\n").filter((line) => line !== "");
  } catch (err) {
    throw new MainUnreadable(repository, "ls-tree main", { cause: err });
  }
}

const sourceSchema = z.object({ source: z.enum(BLOCKED_REASON_SOURCES) });

/** The blocked reason's source, or null when the row has none or one this checkout does not know. */
export function sourceOf(raw: unknown): (typeof BLOCKED_REASON_SOURCES)[number] | null {
  const parsed = sourceSchema.safeParse(raw);
  return parsed.success ? parsed.data.source : null;
}

/** `unrecognized`: a block kind outside the code's list, whose cause the simulator cannot name. */
type HaltCause = "spend_cap" | "work_budget" | "infrastructure" | "client_wait" | "undeliverable" | "unrecognized";

/** What a run ended in, mapped onto today's project states. */
export type Outcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "halted"; readonly cause: HaltCause; readonly detail: string }
  | { readonly kind: "stopped" }
  | { readonly kind: "open" };

/**
 * Each project block kind's halt cause, over the code's own list (`satisfies`: a kind added there
 * fails the type check here until it is given one). `infrastructure` is the halt on the machines,
 * which the substrate probe ends; `fault` is Ashara's own record or step failing, which acceptance calls
 * undeliverable (orchestrator acceptance.ts); `configuration` (a model call refused by anything but a
 * spend cap) is Ashara's setup, kept with infrastructure as before. `work_budget` is the work
 * ledger's halt on a project's spent model requests, which the owner's grant
 * and the operator's unblock end. `acceptance_uncovered` is a passed sweep that leaves a guarantee
 * Ashara can verify unjudged: the project cannot be accepted, and only the operator ends it.
 * `client_wait` is a project whose only work left waits on the client's answers, which the answer ends.
 */
const HALT_CAUSES = {
  budget_cap: "spend_cap",
  configuration: "infrastructure",
  fault: "undeliverable",
  planning_stopped: "undeliverable",
  check_dispute: "undeliverable",
  replan_bound: "undeliverable",
  suite_review: "undeliverable",
  plan_repair: "undeliverable",
  infrastructure: "infrastructure",
  replan_stopped: "undeliverable",
  replan_provider_failed: "undeliverable",
  model_failed: "undeliverable",
  provider_failed: "undeliverable",
  work_budget: "work_budget",
  acceptance_uncovered: "undeliverable",
  client_wait: "client_wait",
} as const satisfies Record<(typeof PROJECT_BLOCK_KINDS)[number], HaltCause>;
const HALT_CAUSE_OF: ReadonlyMap<string, HaltCause> = new Map(Object.entries(HALT_CAUSES));

/** A block kind's (or category's) halt cause; one outside the code's list is `unrecognized`, never a guessed cause. */
export function haltCauseOf(kind: string): HaltCause {
  return HALT_CAUSE_OF.get(kind) ?? "unrecognized";
}

/**
 * The recorded reason of a project that ended halted on Ashara's own fault, or null. Block kind
 * `fault` is the one production writes for its own record or step failing (shared
 * projectBlockCause): a halt no oracle judges wrong, since failing closed is right, but one a soak
 * names rather than passes in silence.
 */
export function asharaFaultHaltOf(snapshot: Snapshot): string | null {
  const { project } = snapshot;
  if (project.status !== "blocked" || project.blockedCategory !== "fault") return null;
  return project.blockedReason ?? "(no reason)";
}

export function outcomeOf(snapshot: Snapshot): Outcome {
  const { project } = snapshot;
  if (project.status === "stopped") return { kind: "stopped" };
  if (project.status === "blocked") {
    const category = project.blockedCategory ?? (project.planStopped ? "planning_stopped" : "unknown");
    return {
      kind: "halted",
      cause: haltCauseOf(category),
      detail: `${category}: ${project.blockedReason ?? "(no reason)"}`,
    };
  }
  // Accepted is production's own state: every goal task done is not acceptance
  // until the sweep on main passes.
  if (project.status === "accepted") return { kind: "accepted" };
  return { kind: "open" };
}

/**
 * The ashara.role labels of the cells Z0 itself runs on a task's work (Quality's verification), each with the
 * work kinds it may run on: POST_MERGE_VERIFIER_ROLE (Quality verification.ts), the post-merge check
 * of any task's tentative merge; RED_RUN_ROLE (Quality verification.ts, environment-check.ts's
 * substrate gate), a run of stored checks, a foundation build or the substrate gate in a fresh CI
 * cell; and "environment-check" (environment-check.ts), build_environment's build and probe, a
 * port only environment work's attempt is given. None is a roster role's id, so none is another
 * role of the team, and none is the cell the agent's own tools run in.
 */
const Z0_CELL_ROLES: ReadonlyMap<string, (workKind: string | null) => boolean> = new Map<
  string,
  (workKind: string | null) => boolean
>([
  ["verifier", () => true],
  ["ci", () => true],
  ["environment-check", (workKind: string | null) => workKind === "environment"],
]);

/**
 * I3's review clause: a suite review's rejection of a correct check whose missing clause its cited
 * item states (the suite-review stand-in's misread, stand-ins/suite-review.ts) is never recorded, so
 * never routed to the check's author.
 *
 * @testseam the clause is judged alone; checkSnapshot is its production caller
 */
export function misreadRejections(
  findings: Snapshot["reviewFindings"],
  items: ReadonlyArray<Pick<ItemRow, "id" | "title">>,
): Array<{ readonly key: string; readonly statement: string }> {
  return findings
    .filter((finding) => finding.problem.includes(MISREAD_REJECTION_MARKER))
    .map((finding) => {
      const title = items.find((item) => item.id === finding.checkTaskId)?.title ?? finding.checkTaskId;
      return {
        key: `misread-rejection:${title}`,
        statement:
          `a suite review's rejection of "${title}", whose missing clause its cited item states, was recorded ` +
          `and routed: ${finding.problem}`,
      };
    });
}

/**
 * I3's cell clause, over every cell a task's id labels in the run, live or removed: the cell its
 * owner's agent works in carries the owner role's id, and Z0's own cells a Z0 role its work kind
 * admits. Any other role is a cell that ran as someone the task is not staffed with.
 *
 * @testseam the clause's table is judged alone; checkSnapshot is its production caller
 */
export function cellRoleViolations(
  items: ReadonlyArray<Pick<ItemRow, "id" | "title" | "workKind" | "ownerRoleId">>,
  cells: ReadonlyArray<Pick<FakeCell, "labels">>,
): Array<{ readonly key: string; readonly statement: string }> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const found: Array<{ readonly key: string; readonly statement: string }> = [];
  for (const cell of cells) {
    const taskId = cell.labels["ashara.task"];
    const role = cell.labels["ashara.role"];
    const task = taskId === undefined ? undefined : byId.get(taskId);
    if (task === undefined || task.ownerRoleId === null || role === task.ownerRoleId) continue;
    if (role !== undefined && Z0_CELL_ROLES.get(role)?.(task.workKind) === true) continue;
    found.push({
      key: `cell-role:${task.title}:${role ?? "none"}`,
      statement:
        `a cell of "${task.title}" ran as role ${role ?? "(no role label)"}, ` + `not its owner ${task.ownerRoleId}`,
    });
  }
  return found;
}

/** A report the client is owed for a terminal event on record and has not been sent. */
export interface OwedReport {
  readonly invariant: "I2" | "I4";
  /** The event, by its record's id: the same event owed across snapshots. */
  readonly subject: string;
  /** The violation's subject, by what a seed reproduces (Violation.key), without its invariant. */
  readonly key: string;
  readonly statement: string;
}

/** The ends of a halt episode after which work resumes and the client is told so. */
const RESUMING_ENDS = new Set(["unblocked", "probe_passed"]);

/**
 * Every terminal event the project's records hold that the client has not been told of, as the
 * contract states who is owed what, never as production's listings select it:
 * - a halt episode is told, whether it is still open or ended by an unblock or a passing probe
 *   before it was told; one the client's stop ended, or of a stopped project, is told by the stop
 *   report. A first planning stop is told by the planning-stopped report (episodeRow);
 * - a halt that ended by an unblock or a passing probe is told it resumed, once it was told it began;
 * - the stop that stopped the project is answered by the stop report while the project is stopped;
 * - an accepted project's latest passed sweep carries its delivered report.
 * An episode of a kind outside the code's list has no report production can write; it is owed one
 * all the same, so a corrupted kind is named, never passed as told.
 */
export function owedReports(snapshot: Snapshot): OwedReport[] {
  const { project } = snapshot;
  const owed: OwedReport[] = [];
  const stopped = project.status === "stopped";
  for (const episode of stopped ? [] : snapshot.episodes) {
    const resumed = episode.endKind !== null && RESUMING_ENDS.has(episode.endKind);
    if (episode.reportId === null && (!episode.ended || resumed)) {
      owed.push({
        invariant: "I2",
        subject: `halt:${episode.id}`,
        key: `episode:${episode.kind}`,
        statement:
          `project block episode ` +
          `${episode.kind}${episode.ended ? ` (ended ${episode.endKind ?? "with no end kind"})` : ""} has no ` +
          `report to the client`,
      });
    } else if (resumed && episode.reportId !== null && episode.resumedReportId === null) {
      owed.push({
        invariant: "I2",
        subject: `resumed:${episode.id}`,
        key: `episode-resumed:${episode.kind}`,
        statement:
          `project block episode ${episode.kind} ended (${episode.endKind ?? "with no end kind"}) with no ` +
          `report to the client that work resumed`,
      });
    }
  }
  for (const stop of stopped ? snapshot.stops : []) {
    if (!stop.stoppedProject || stop.reported) continue;
    owed.push({
      invariant: "I4",
      subject: `stop:${stop.id}`,
      key: "stop-unreported",
      statement: "the client's stop stopped the project but its stop report was never posted",
    });
  }
  if (project.status === "accepted" && project.passedSweepId !== null && project.passedSweepReportId === null) {
    owed.push({
      invariant: "I4",
      subject: `accepted:${project.passedSweepId}`,
      key: "accepted-unreported",
      statement: "the project is accepted but its delivered report was never posted",
    });
  }
  return owed;
}

/**
 * The cycles a terminal event may go untold, counting only cycles that ran with no injected fault,
 * no restart and no duplicated wake, and in which the project had no contained step waiting out a
 * fault's backoff. Why 2: every report is posted on the cycle that records its event or the next (a
 * cycle's report steps run after the steps that record a stop, a sweep or a planning outcome, and a
 * halt recorded during dispatch is told by the next cycle's, or the next halted cycle's, report
 * steps), so one cycle is the longest a report waits; the bound is twice that, and below the cycles
 * an ended run settles on (run.ts SETTLE_CYCLES), so an ended run's silence is named before it ends.
 * @testseam invariants.test.ts judges the silence clause at the bound and past it
 */
export const REPORT_BOUND_CYCLES = 2;

/**
 * Whether a cycle counts against the silence bound: one that carried an injected fault, a restart or
 * a duplicated wake is exempt, and names each faulted step it carried.
 */
export type SilenceCycle =
  | { readonly kind: "counted" }
  | { readonly kind: "exempt"; readonly faulted: readonly string[] };

/** A cycle was exempted from the silence bound without naming the faulted step that exempts it. */
class UnnamedSilenceExemption extends Error {
  constructor(
    readonly step: number,
    readonly project: number,
  ) {
    super(
      `cycle ${step} of project ${project} was exempted from the silence bound naming no faulted step: ` +
        `an exemption names what the cycle carried`,
    );
    this.name = "UnnamedSilenceExemption";
  }
}

/**
 * I2's and I4's silence clause, cycle by cycle: every terminal event (owedReports) is told within
 * REPORT_BOUND_CYCLES counted cycles of the one whose snapshot first held it. Each project of the
 * run is watched by its index in the run's order. A cycle is not counted when it carried a fault
 * (SilenceCycle) or the project had a contained step waiting out a fault's backoff; a silence named
 * past the bound names the faulted steps that exempted cycles of it.
 */
export class SilenceWatch {
  private readonly owed = new Map<string, { readonly cycles: number; readonly exempted: readonly string[] }>();

  /** The silences one project's snapshot after cycle `step` shows. */
  observe(step: number, project: number, snapshot: Snapshot, cycle: SilenceCycle): Violation[] {
    if (cycle.kind === "exempt" && (cycle.faulted.length === 0 || cycle.faulted.some((name) => name.trim() === "")))
      throw new UnnamedSilenceExemption(step, project);
    const exempting = [
      ...(cycle.kind === "exempt" ? cycle.faulted : []),
      ...snapshot.project.retryingSteps.map((name) => `the backoff of ${name}`),
    ];
    const now = owedReports(snapshot);
    const subjects = new Set(now.map((owed) => `${project}:${owed.subject}`));
    for (const subject of this.owed.keys())
      if (subject.startsWith(`${project}:`) && !subjects.has(subject)) this.owed.delete(subject);
    const violations: Violation[] = [];
    for (const owed of now) {
      const subject = `${project}:${owed.subject}`;
      const seen = this.owed.get(subject);
      const counted = exempting.length === 0;
      if (seen === undefined) {
        this.owed.set(subject, { cycles: 0, exempted: [] });
        continue;
      }
      const cycles = seen.cycles + (counted ? 1 : 0);
      const exempted = counted ? seen.exempted : [...new Set([...seen.exempted, ...exempting])];
      this.owed.set(subject, { cycles, exempted });
      if (cycles > REPORT_BOUND_CYCLES) {
        const excused = exempted.length === 0 ? "" : ` (cycles not counted, exempted by: ${exempted.join("; ")})`;
        violations.push({
          invariant: owed.invariant,
          step,
          statement:
            `${owed.statement} ${cycles} counted cycles after it was recorded (bound ${REPORT_BOUND_CYCLES})${excused}`,
          key: `${owed.invariant}:${owed.key}`,
        });
      }
    }
    return violations;
  }
}

type SnapshotContext = Parameters<typeof checkSnapshot>[2];

/** Records one violation of `invariant` on the snapshot being judged, keyed by `key`. */
type AddViolation = (invariant: InvariantId, key: string, statement: string) => void;

/** I2, judged on one project's snapshot. */
function correctionAndHaltViolations(snapshot: Snapshot, context: SnapshotContext, add: AddViolation): void {
  // I2: no work item waits on a person; every halt episode has exactly one report. Every exit
  // blockedExitOf names is taken by the loop's own sweep (orchestrator parked-exits.ts, whose test
  // names each exit's writer); a reason production cannot parse has no exit at all.
  for (const item of snapshot.items) {
    if (item.status !== "Blocked") continue;
    const source = sourceOf(item.blockedReason);
    if (blockedReasonOf(item.blockedReason) === null) {
      add(
        "I2",
        `${item.title}:${source ?? "none"}`,
        `task "${item.title}" is Blocked (${source ?? "no reason"}) with no exit the loop takes`,
      );
    }
  }
  // I2's correction clause: a client's correction holds only the tasks citing a key it affects; a
  // task held for one that cites none of them waits on a revision that has no reason to touch it.
  for (const item of snapshot.items) {
    const reason = item.status === "Blocked" ? blockedReasonOf(item.blockedReason) : null;
    if (reason?.source !== "correction_pending") continue;
    const correction = snapshot.corrections.find((each) => each.visionVersion === reason.visionVersion);
    if (correction === undefined || !item.cites.some((key) => correction.affected.includes(key))) {
      add(
        "I2",
        `held-unaffected:${item.title}`,
        `task "${item.title}" (citing ${item.cites.join(", ") || "nothing"}) is held for the correction of ` +
          `vision v${reason.visionVersion}, ` +
          (correction === undefined ? "which records no hold" : `which affects only ${correction.affected.join(", ")}`),
      );
    }
  }
  // What it affects reaches, from each assumption it amends, every guarantee resting on it: work citing
  // only such a guarantee is built on the assumption and is held with the work citing it.
  for (const correction of snapshot.corrections) {
    for (const guarantee of correction.unreached) {
      add(
        "I2",
        `unreached:${guarantee}`,
        `the correction of vision v${correction.visionVersion} affects ${correction.affected.join(", ")}, ` +
          `leaving out ${guarantee}, which rests on an assumption among them`,
      );
    }
  }
  // And it holds every task citing one, whatever the task's status was when it was recorded: none is
  // dispatched on the words it changed before its revision replaces it.
  for (const correction of snapshot.corrections) {
    for (const title of correction.startedWhileHeld) {
      add(
        "I2",
        `dispatched-held:${title}`,
        `task "${title}" cites a key the correction of vision v${correction.visionVersion} affects ` +
          `(${correction.affected.join(", ")}) ` +
          `and was dispatched while that correction awaited its revision`,
      );
    }
  }
  // Every halt episode, its resumption and a planning stop is told (owedReports): judged cycle by
  // cycle against the bound (SilenceWatch), and once a run that settled ends, on its last records.
  if (context.final) {
    for (const owed of owedReports(snapshot))
      if (owed.invariant === "I2") add("I2", owed.key, `${owed.statement}, and the run ended`);
  }
}

/** I3, judged on one project's snapshot. */
function independenceViolations(snapshot: Snapshot, context: SnapshotContext, add: AddViolation): void {
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  // I3: independence.
  for (const check of snapshot.checks) {
    const task = byId.get(check.taskId);
    const author = byId.get(check.checkTaskId);
    if (
      task !== undefined &&
      author !== undefined &&
      task.ownerRoleId !== null &&
      task.ownerRoleId === author.ownerRoleId
    ) {
      add("I3", `same-role:${task.title}`, `the checks of "${task.title}" were written by its own owner role`);
    }
    for (const file of check.files) {
      if (file.path.startsWith("product/")) {
        add(
          "I3",
          `product-file:${task?.title ?? check.taskId}:${file.path}`,
          `check set r${check.revision} of "${task?.title ?? check.taskId}" holds product file ${file.path}: ` +
            `a check that supplies what it checks`,
        );
      }
    }
  }
  for (const found of cellRoleViolations(snapshot.items, context.cells)) add("I3", found.key, found.statement);
  for (const found of misreadRejections(snapshot.reviewFindings, snapshot.items)) add("I3", found.key, found.statement);
  // A tender's reading that asked the client nothing is put to a second reading by another model, and
  // the record and the questions posted are that reading's (intake-readings.ts). Judged once the run ends.
  if (context.final) {
    for (const found of lazyIntakes(snapshot.projectId, snapshot.intake, context.intakes))
      add("I3", found.key, found.statement);
  }
}

/** I4, judged on one project's snapshot. */
function toldViolations(snapshot: Snapshot, context: SnapshotContext, add: AddViolation): void {
  // I4: a client stop and an acceptance are told (owedReports), as I2's halts are; that a halt
  // episode has its report is I2's. What each report states is judged against the records it is
  // rendered from (client-reports.ts): the halt's recorded cause, the merges recorded at a stop, the
  // goals' closes and the unchecked tasks at acceptance, every terminal message's guarantee table,
  // and no report posted twice.
  if (context.final) {
    for (const owed of owedReports(snapshot))
      if (owed.invariant === "I4") add("I4", owed.key, `${owed.statement}, and the run ended`);
  }
  if (context.final) {
    const checked = new Set(snapshot.checks.map((check) => check.taskId));
    for (const found of checkReports(snapshot.reports, snapshot.project, snapshot.items, checked))
      add("I4", found.key, found.statement);
  }
}

/** I9, judged on one project's snapshot. */
function textFactViolations(snapshot: Snapshot, context: SnapshotContext, add: AddViolation): void {
  // I9: every fact a brief, a question or a report states is the one the store held when it was
  // composed (text-facts.ts). Judged once the run ends, like I4's report clauses.
  if (context.final) {
    for (const found of checkTextFacts(snapshot.textFacts)) add("I9", found.key, found.statement);
  }
}

/** I5, judged on one project's snapshot. */
function spendViolations(snapshot: Snapshot, context: SnapshotContext, add: AddViolation): void {
  // I5: spend within the cap; every call has a recorded cost.
  if (snapshot.spendUsd > context.spendCapUsd + 1e-9) {
    add("I5", "over-cap", `recorded spend $${snapshot.spendUsd.toFixed(6)} exceeds the cap $${context.spendCapUsd}`);
  }
  if (snapshot.unrecordedCalls > 0) add("I5", "unpriced", `${snapshot.unrecordedCalls} llm_calls row(s) carry no cost`);
}

/** I6, judged on one project's snapshot. */
function evidenceViolations(snapshot: Snapshot, context: SnapshotContext, add: AddViolation): void {
  // I6: no Done without its evidence. A passed sweep accepted the project: every guarantee of the
  // version in force (on a version written before guarantees, an in-scope line or an assumption not
  // recorded as internal design) is decided by a stored check that sweep ran, as its recorded decides
  // names it, while an assumption of a guarantees-form version is never held to a check; every such
  // guarantee a suite review left undecided on every check task whose checks decide it is named
  // unverified in the sweep's delivered report, never covered, and every asked-for item the report
  // calls decided had its suite's review found clean on it by a second opinion, as the stand-ins
  // answered it.
  // Judged on every passed sweep once the run ends, whatever the project's status then. An accepted
  // project rests on a passed sweep whose evidence judges every guarantee in force pass, as the
  // oracle's own reading of the table's rules judges it (uncoveredAcceptance): accepted with a
  // guarantee unjudged is a finding, on every snapshot.
  if (context.final) {
    for (const found of uncheckedAtPassedSweeps(snapshot.reports))
      add("I6", `unchecked-item:${found.key}`, found.statement);
    for (const found of unconfirmedAtPassedSweeps(snapshot.reports, context.reviews))
      add("I6", `unconfirmed-clean:${found.key}`, found.statement);
  }
  // A contract Ashara can verify no guarantee of could never be accepted on evidence: no work starts on it,
  // on every snapshot.
  const declined = declinedWork(snapshot.textFacts);
  if (declined !== null) add("I6", "declined-work", declined);
  if (snapshot.project.status === "accepted") {
    for (const found of uncoveredAcceptance(snapshot.reports))
      add("I6", `accepted-unjudged:${found.key}`, found.statement);
  }
  const checkedTasks = new Set(snapshot.checks.map((check) => check.taskId));
  for (const item of snapshot.items) {
    if (item.status !== "Completed" || item.level !== "Task") continue;
    if (item.workKind === "implementation" && item.mergeCommit === null) {
      add("I6", `no-record:${item.title}`, `"${item.title}" is Completed with no merge record`);
    }
    if (item.origin === "check" && item.checksFor !== null && !checkedTasks.has(item.checksFor)) {
      add(
        "I6",
        `no-checks:${item.title}`,
        `check task "${item.title}" is Completed with no checks stored for the task it checks`,
      );
    }
  }
}

/** I7, judged on one project's snapshot. */
function exactlyOnceViolations(snapshot: Snapshot, add: AddViolation): void {
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  // I7: exactly once, main against the records.
  const recorded = new Map<string, ItemRow[]>();
  for (const item of snapshot.items) {
    if (item.mergeCommit === null) continue;
    /* eslint-disable-next-line no-restricted-syntax -- policy default: a commit not yet seen has no record yet; the
       accumulator's start */
    recorded.set(item.mergeCommit, [...(recorded.get(item.mergeCommit) ?? []), item]);
  }
  const onMain = new Set(snapshot.main.map((entry) => entry.commit));
  for (const entry of snapshot.main) {
    const named = /^merge: task (\S+)$/.exec(entry.subject)?.[1];
    if (named === undefined) continue;
    /* eslint-disable-next-line no-restricted-syntax -- policy default: a merge on main with no record is held to
       exactly one record below and reported */
    const records = (recorded.get(entry.commit) ?? []).filter(
      (item) => item.id === named && item.status === "Completed",
    );
    if (records.length !== 1) {
      const item = byId.get(named);
      add(
        "I7",
        `unrecorded:${item?.title ?? named}`,
        `main commit ${entry.commit.slice(0, 12)} ("${entry.subject}") has no item Completed recording it ` +
          `(the item is ${item?.status ?? "absent"})`,
      );
    }
  }
  for (const [commit, items] of recorded) {
    if (!onMain.has(commit))
      add(
        "I7",
        `off-main:${items.map((i) => i.title).join(",")}`,
        `${items.map((i) => `"${i.title}"`).join(", ")} record ${commit.slice(0, 12)}, which is not on main`,
      );
  }
  // I7's requeue clause, on every transition into Pending: a task that reached Pending while main
  // holds a merge of its current generation (the newest merge naming it, which its record does not
  // hold) would be dispatched again to redo merged work. main is newest first.
  const newestMerge = new Map<string, MainCommit>();
  for (const entry of snapshot.main) {
    const named = /^merge: task (\S+)$/.exec(entry.subject)?.[1];
    if (named !== undefined && !newestMerge.has(named)) newestMerge.set(named, entry);
  }
  const reachedPending = new Set(snapshot.transitions.filter((t) => t.to === "Pending").map((t) => t.workItemId));
  for (const item of snapshot.items) {
    if (item.status !== "Pending" || !reachedPending.has(item.id)) continue;
    const merge = newestMerge.get(item.id);
    if (merge === undefined || merge.commit === item.mergeCommit) continue;
    add(
      "I7",
      `pending-over-merge:${item.title}`,
      `"${item.title}" reached Pending while main holds its merge ${merge.commit.slice(0, 12)}, ` +
        `which its record (${item.mergeCommit?.slice(0, 12) ?? "none"}) does not hold`,
    );
  }
}

/**
 * I2-I7 and I9, judged on one project's snapshot. I1, I8 (checkTotality) and I5's admission
 * clause (admissions.ts, the deployment's) are judged by the run over its whole course.
 */
export function checkSnapshot(
  step: number,
  snapshot: Snapshot,
  context: {
    readonly spendCapUsd: number;
    readonly cells: readonly FakeCell[];
    readonly final: boolean;
    /** Every suite review the stand-ins answered (StandIns.observedReviews). */
    readonly reviews: readonly ObservedReview[];
    /** Every tender reading the stand-ins were asked for or answered (StandIns.observedIntakes). */
    readonly intakes: readonly ObservedIntake[];
  },
): Violation[] {
  const violations: Violation[] = [];
  const add = (invariant: InvariantId, key: string, statement: string): void => {
    violations.push({ invariant, step, statement, key: `${invariant}:${key}` });
  };
  correctionAndHaltViolations(snapshot, context, add);
  independenceViolations(snapshot, context, add);
  toldViolations(snapshot, context, add);
  textFactViolations(snapshot, context, add);
  spendViolations(snapshot, context, add);
  evidenceViolations(snapshot, context, add);
  exactlyOnceViolations(snapshot, add);
  return violations;
}

/**
 * What a project has reached, as facts read from its records (I8's progress measure). Each is
 * reached once: a fact seen again is no progress, so a loop that comes back to where it was (a
 * requeue, a halt and its resumption) adds nothing however busy it is.
 * - a work item in a status (and blocked-reason source) it never held before;
 * - a merge recorded;
 * - the plan's new items (above);
 * - the project in a status (and block category) it never held before;
 * - a bounded count reaching a new high: an item's charged attempts, its infrastructure faults.
 *   Each moves the item toward the bound that ends it; a count refunded and charged again does not.
 * Never a cycle, a model call, a dispatch refunded, a halt episode alone, or a check set's new
 * revision: a review or dispute loop writes one every round, so counting it would credit the loop's
 * own churn. I8 judges stalls only; a busy loop that never ends is W1's (every task's and project's
 * requests within the bounds table) and W3's (a measure every round decreases), termination.ts.
 */
export function progressFacts(snapshot: Snapshot): string[] {
  const { project } = snapshot;
  /* eslint-disable-next-line no-restricted-syntax -- policy default: fact text; a project with no category and one
     with a category are still distinct facts */
  const facts = [`project:${project.status}(${project.blockedCategory ?? ""})`];
  for (const item of snapshot.items) {
    const source = sourceOf(item.blockedReason);
    /* eslint-disable-next-line no-restricted-syntax -- policy default: fact text; a task with no reason source and
       one with a source are still distinct facts */
    facts.push(`status:${item.id}:${item.status}(${source ?? ""})`);
    if (item.mergeCommit !== null) facts.push(`merge:${item.id}:${item.mergeCommit}`);
    facts.push(`attempts:${item.id}:${item.dispatchCount}`, `infrastructure:${item.id}:${item.infrastructureFaults}`);
  }
  return facts;
}

/**
 * I8, judged on the final snapshot of a run that made no progress (progressFacts) over the run's
 * bound of fault-free cycles, busy or idle: every exit the loop took from the states it held led
 * back to states already reached, so no state held at the end has an exit that progresses. Every
 * non-terminal task state of that snapshot is reported once, keyed by the state (status and
 * blocked-reason source), its items named. A run that ended any other way (ended, past its cycles
 * or its wall clock) is not judged here: its states were still progressing.
 */
export function checkTotality(step: number, stalled: Snapshot, cycles: number): Violation[] {
  const states = new Map<string, string[]>();
  for (const item of stalled.items) {
    if (item.level !== "Task" || item.status === "Completed" || item.status === "Abandoned") continue;
    const source = sourceOf(item.blockedReason);
    const state = source === null ? item.status : `${item.status}(${source})`;
    /* eslint-disable-next-line no-restricted-syntax -- policy default: a state not yet seen has no title yet; the
       accumulator's start */
    states.set(state, [...(states.get(state) ?? []), `"${item.title}"`]);
  }
  return [...states].map(([state, titles]) => ({
    invariant: "I8",
    step,
    statement: `state ${state} took no exit that progressed in ${cycles} fault-free cycles: ${titles.join(", ")}`,
    key: `I8:${state}`,
  }));
}

/** The stored reason as production parses it; an unreadable one has no exit. */
export function blockedReasonOf(raw: unknown): StoredBlockedReason | null {
  try {
    return parseStoredBlockedReason(raw) ?? null;
  } catch (err) {
    if (!(err instanceof BlockedReasonCorrupt)) throw err;
    console.warn(`[simulator] an unreadable blocked reason is judged as having no exit: ${err.message}`);
    return null;
  }
}

/** One task's attempt counters (I10). */
interface TaskCharges {
  readonly title: string;
  readonly dispatches: number;
  /** failed_approaches rows naming the task: a lesson is written only for a failure of its work. */
  readonly lessons: number;
}

/** One project's attempt counters (I10): its tenders' intake reads, its first plan, its plan revision. */
interface ProjectCharges {
  readonly intakeAttempts: number;
  readonly planAttempts: number;
  readonly replanAttempts: number;
  /** The open halt episode no reading of the client's messages may run under (UNREAD_HALT_KINDS), or null. */
  readonly unreadHalt: string | null;
}

/**
 * The halts under which nothing reads the client's messages, the oracle's own copy: a budget halt
 * refuses the reading's model call, and one on a model's or its provider's failure, the plan
 * revision's too, would charge the reading for meeting it again (Engagement's inboundDecision).
 * @testseam inbound-message-policy.test.ts holds it to inboundDecision and the readers' SQL, cell by cell
 */
export const UNREAD_HALT_KINDS = [
  "budget_cap",
  "work_budget",
  "model_failed",
  "provider_failed",
  "replan_stopped",
  "replan_provider_failed",
] as const;

/** Every attempt counter of the run's projects at one instant (I10), the projects in the run's order. */
export interface Charges {
  readonly tasks: ReadonlyMap<string, TaskCharges>;
  readonly projects: ReadonlyMap<string, ProjectCharges>;
}

const taskChargesRow = z.object({
  id: z.string(),
  title: z.string(),
  dispatches: z.number().int(),
  lessons: z.number().int(),
});
const projectChargesRow = z.object({
  intakeAttempts: z.number().int(),
  planAttempts: z.number().int(),
  replanAttempts: z.number().int(),
  unreadHalt: z.string().nullable(),
});

/** The attempt counters of `projectIds`, read by the observer outside every seam. */
export async function readCharges(db: Database, projectIds: readonly string[]): Promise<Charges> {
  const tasks = new Map<string, TaskCharges>();
  const projects = new Map<string, ProjectCharges>();
  for (const projectId of projectIds) {
    const rows = z.array(taskChargesRow).parse(
      (
        await db.execute(sql`
          SELECT w.id, w.title, w.dispatch_count AS dispatches,
                 (SELECT count(*) FROM failed_approaches f WHERE f.task_id = w.id)::int AS lessons
          FROM work_items w WHERE w.project_id = ${projectId} AND w.level = 'Task'`)
      ).rows,
    );
    for (const row of rows) tasks.set(row.id, { title: row.title, dispatches: row.dispatches, lessons: row.lessons });
    const [project] = z.array(projectChargesRow).parse(
      (
        await db.execute(sql`
          SELECT coalesce(pp.plan_attempts, 0) AS "planAttempts", coalesce(pp.replan_attempts, 0) AS "replanAttempts",
                 (SELECT coalesce(sum(m.intake_attempts), 0) FROM client_messages m
                   WHERE m.project_id = projects.id)::int AS "intakeAttempts",
                 (SELECT b.id::text FROM project_blocks b WHERE b.project_id = projects.id AND b.ended_at IS NULL
                    AND b.kind IN (${sql.join(
                      UNREAD_HALT_KINDS.map((kind) => sql`${kind}`),
                      sql`, `,
                    )})) AS "unreadHalt"
          FROM projects LEFT JOIN project_plans pp ON pp.project_id = projects.id WHERE projects.id = ${projectId}`)
      ).rows,
    );
    if (project === undefined) throw new SnapshotRowMissing(projectId, "projects", "the project's attempt counters");
    projects.set(projectId, project);
  }
  return { tasks, projects };
}

/** A provider error was recorded with no transport answer: whose failure it was cannot be told. */
class FaultBlameUnknown extends Error {
  constructor(readonly fault: FaultRecord) {
    super(
      `fault at ticket ${fault.ticket} (${fault.seam} ${fault.label}: ${fault.fault}) carries no transport ` +
        `response, so I10 cannot tell whose failure it was`,
    );
    this.name = "FaultBlameUnknown";
  }
}

/**
 * Whose a fault is, for I10: `ashara` a call of the substrate that failed (a database, git or podman
 * call) or a request Ashara built that the provider rejected (400, 413, 422); `provider` the
 * provider's failure (a reset, 429, 5xx), which a read is counted against by design;
 * `process` the process's death or stop (a crash, a SIGTERM, a killed transaction), whose dispatch
 * production leaves counted when no record shows it unfinished or it died before (delivery
 * startup-reconciler.ts requeueOrphan: a dispatch that keeps killing the process may be what kills
 * it); `none` a clock jump, which fails no call. A killed transaction is a process death by
 * construction (faults.ts faultingPools: its backend ends between two queries of a checked-out
 * connection, whose error no listener takes, and production's uncaughtException handler exits), so
 * the process dies before any refund it would write, and its restart cannot tell whose fault the
 * dispatch it finds unfinished met: it is judged as a crash is. Total over FaultKind: a kind added
 * to faults.ts fails the type check here until it is given a blame.
 */
function blameOf(fault: FaultRecord): "ashara" | "provider" | "process" | "none" {
  const kind: FaultKind = fault.fault;
  switch (kind) {
    case "provider-error":
      if (fault.response === null) throw new FaultBlameUnknown(fault);
      return fault.response.owner;
    case "clock-jump":
      return "none";
    case "crash-before":
    case "crash-after":
    case "sigterm":
    case "db-transaction-killed":
      return "process";
    case "db-unreachable":
    case "db-query-failed":
    case "cell-start-failed":
    case "cell-exec-failed":
    case "cell-teardown-failed":
    case "substrate-down":
    case "image-build-failed":
    case "git-failed":
      return "ashara";
  }
}

/** What one cycle did to the attempt counters, and what the tape injected and the stand-ins answered while it ran. */
export interface ChargeWindow {
  readonly step: number;
  readonly before: Charges;
  readonly after: Charges;
  /** The faults injected in the window, each with the batch lane it was injected in. */
  readonly faults: readonly FaultRecord[];
  /**
   * The tasks a stand-in model answered for in the window (an agent turn or a structured answer made in the task's
   * lane).
   */
  readonly consulted: ReadonlySet<string>;
  /** A stand-in misbehaved in the window (a tape decision at a `model.` or `agent.` site). */
  readonly misbehaved: boolean;
}

function describeFaults(faults: readonly FaultRecord[]): string {
  return faults
    .map(
      (fault) =>
        `${fault.seam} ${fault.label}: ` +
        `${fault.fault}${fault.response?.status == null ? "" : ` ${fault.response.status}`}`,
    )
    .join("; ");
}

/**
 * I10, charged only for agent work: an attempt counter grows only for work a
 * model did and failed, never for a fault beneath it. Judged per cycle, the cycle being the window:
 * - task clause: a task whose lane carried a fault of Ashara's (blameOf), none of the provider's
 *   or the process's, and for which no stand-in model answered in the window, did no work: its
 *   dispatch_count and its failed_approaches must not grow over the window (production refunds such
 *   a dispatch and writes no lesson: delivery verdict-routing.ts routeAsInfrastructureFault);
 * - project clause: in a window that carried a fault of Ashara's outside every lane, none of the
 *   provider's or the process's, and no stand-in misbehaviour, no project's intake_attempts,
 *   plan_attempts or replan_attempts grows: every model read answered as asked, so a read counted
 *   as failed was charged for the fault (a provider's rejection of Ashara's request included:
 *   model-access gateway.ts providerFailureOf).
 *
 * - halt clause: in any window, no project's intake_attempts grows while one halt under which nothing
 *   reads the client's messages (UNREAD_HALT_KINDS) stayed open from its start to its end: a reading
 *   charged there met the halt it could not get past.
 *
 * Blind spots: the stand-ins never fault the way a real provider does (a status whose body
 * misleads, a stream cut part way), so the transport's statuses are the gateway's whole input here;
 * a task's window in which its model answered is not judged (the fault may have struck after work
 * that earned the charge), so a fault late in an attempt, after its agent worked (a verification
 * cell that fails to start), goes unjudged; nor is a window with a misbehaviour, a provider's
 * failure, a crash, a SIGTERM or a killed transaction in it; and the project clause's window is the
 * whole cycle, so in a two-project run one project's misbehaviour exempts the other's counters for
 * that cycle.
 */
export function checkCharges(window: ChargeWindow): Violation[] {
  const violations: Violation[] = [];
  const add = (key: string, statement: string): void => {
    violations.push({ invariant: "I10", step: window.step, statement, key: `I10:${key}` });
  };
  const ofLane = (task: string | null): readonly FaultRecord[] => window.faults.filter((fault) => fault.task === task);
  const asharas = (faults: readonly FaultRecord[]): FaultRecord[] =>
    faults.filter((fault) => blameOf(fault) === "ashara");
  // A window that carried a fault production may charge for by design is not judged.
  const exempting = (faults: readonly FaultRecord[]): boolean =>
    faults.some((fault) => blameOf(fault) === "provider" || blameOf(fault) === "process");
  // A crash, a SIGTERM or a killed transaction stops every lane of the process, whichever lane it was injected in.
  const processStopped = window.faults.some((fault) => blameOf(fault) === "process");

  for (const [id, after] of window.after.tasks) {
    const own = ofLane(id);
    const faults = asharas(own);
    if (faults.length === 0 || processStopped || exempting(own) || window.consulted.has(id)) continue;
    // A task first read after the window began (a plan written in it) started from no attempt at all.
    const before = window.before.tasks.get(id) ?? { title: after.title, dispatches: 0, lessons: 0 };
    if (after.dispatches > before.dispatches) {
      add(
        `dispatch:${after.title}`,
        `"${after.title}" was charged an attempt (dispatch_count ${before.dispatches} -> ` +
          `${after.dispatches}) in a cycle its model did no work for, under ${describeFaults(faults)}`,
      );
    }
    if (after.lessons > before.lessons) {
      add(
        `lesson:${after.title}`,
        `"${after.title}" was written a failed-approach lesson in a cycle its model did no work for, under ` +
          `${describeFaults(faults)}`,
      );
    }
  }

  const label = (index: number): { readonly key: string; readonly words: string } => ({
    key: index === 0 ? "" : `p${index + 1}:`,
    words: index === 0 ? "" : `project ${index + 1}: `,
  });
  for (const [index, [projectId, after]] of [...window.after.projects].entries()) {
    const before = window.before.projects.get(projectId);
    if (
      before?.unreadHalt == null ||
      before.unreadHalt !== after.unreadHalt ||
      after.intakeAttempts <= before.intakeAttempts
    )
      continue;
    const project = label(index);
    add(
      `${project.key}halted-intakeAttempts`,
      `${project.words}intakeAttempts grew ${before.intakeAttempts} -> ${after.intakeAttempts} while halt ` +
        `${after.unreadHalt}, under which nothing reads the client's messages, stayed open`,
    );
  }

  const outside = asharas(ofLane(null));
  if (outside.length === 0 || window.misbehaved || exempting(window.faults)) return violations;
  const counters = ["intakeAttempts", "planAttempts", "replanAttempts"] as const;
  for (const [index, [projectId, after]] of [...window.after.projects].entries()) {
    // A project first read after the window began started from no attempt at all.
    const before = window.before.projects.get(projectId) ?? {
      intakeAttempts: 0,
      planAttempts: 0,
      replanAttempts: 0,
      unreadHalt: null,
    };
    const project = index === 0 ? "" : `p${index + 1}:`;
    for (const counter of counters) {
      if (after[counter] <= before[counter]) continue;
      add(
        `${project}${counter}`,
        `${index === 0 ? "" : `project ${index + 1}: `}${counter} grew ${before[counter]} -> ` +
          `${after[counter]} in a cycle whose every model read answered as asked, under ` +
          `${describeFaults(outside)}`,
      );
    }
  }
  return violations;
}
