import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { PROJECT_BLOCK_KINDS } from "@ashara/db";
import { describeErrorChain } from "@ashara/shared";
import { BLOCKED_REASON_SOURCES, BlockedReasonCorrupt, parseStoredBlockedReason } from "@ashara/delivery";
import type { StoredBlockedReason } from "@ashara/delivery";
import { checkReports, readReportRecords, uncheckedAtPassedSweeps } from "./client-reports.js";
import type { ReportRecords } from "./client-reports.js";
import type { Database } from "./database.js";
import type { FakeCell } from "./fake-podman.js";
import { MISREAD_REJECTION_MARKER } from "./product.js";
import { projectState } from "./project-state.js";
import { checkTextFacts, readTextFactRecords } from "./text-facts.js";
import type { TextFactRecords } from "./text-facts.js";

const run = promisify(execFile);

/** The invariants of design §2.9, as judged on today's schema. */
const INVARIANTS = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9"] as const;
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
  /** How the recorded commit closed the item (migration 049): merged or already_delivered. */
  mergeKind: z.string().nullable(),
  ownerRoleId: z.string().nullable(),
  dispatchCount: z.number(),
  infrastructureFaults: z.number(),
});
type ItemRow = z.infer<typeof itemRow>;

const projectRow = z.object({
  status: z.string(),
  blockedCategory: z.string().nullable(),
  blockedReason: z.string().nullable(),
  planStopped: z.boolean(),
  workspacePath: z.string().nullable(),
  /** A passed acceptance sweep's delivered report is posted (migration 049). */
  deliveredReported: z.boolean(),
});
type ProjectRow = z.infer<typeof projectRow>;

/**
 * A halt episode and the report that told the client of it. A planning stop is told by the
 * planning-stopped report (one client message, reports_on 'planning-stopped', posted after the stop),
 * which its episode row does not link: that message is its report.
 */
const episodeRow = z.object({ id: z.string(), kind: z.string(), reportId: z.string().nullable(), ended: z.boolean() });
const checkRow = z.object({
  taskId: z.string(),
  checkTaskId: z.string(),
  revision: z.number(),
  name: z.string(),
  files: z.array(z.object({ path: z.string() })),
});
const eventRow = z.object({ seq: z.number(), eventType: z.string(), workItemId: z.string().nullable() });
const findingRow = z.object({ checkTaskId: z.string(), problem: z.string() });

interface MainCommit {
  readonly commit: string;
  readonly subject: string;
}

export interface Snapshot {
  readonly project: ProjectRow;
  readonly items: readonly ItemRow[];
  readonly episodes: ReadonlyArray<z.infer<typeof episodeRow>>;
  readonly checks: ReadonlyArray<z.infer<typeof checkRow>>;
  /** Every problem a suite review's recorded findings route to a check task, as recorded. */
  readonly reviewFindings: ReadonlyArray<z.infer<typeof findingRow>>;
  readonly spendUsd: number;
  readonly unrecordedCalls: number;
  readonly events: ReadonlyArray<z.infer<typeof eventRow>>;
  readonly main: readonly MainCommit[];
  /** What the client was sent and the records each report is rendered from (I4). */
  readonly reports: ReportRecords;
  /** What every brief, question and report states, with the records it is composed from (I9). */
  readonly textFacts: TextFactRecords;
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

/** Every lifecycle row of the run's one project, and main's first-parent log (design §4.8). */
export async function readSnapshot(db: Database, projectId: string): Promise<Snapshot> {
  const [project] = z.array(projectRow).parse(
    (
      await db.execute(sql`
        SELECT ${projectState} AS status, blocked_category AS "blockedCategory", blocked_reason AS "blockedReason",
               plan_stopped_at IS NOT NULL AS "planStopped", workspace_path AS "workspacePath",
               EXISTS (SELECT 1 FROM acceptance_sweeps s WHERE s.project_id = projects.id AND s.passed AND s.report_id IS NOT NULL) AS "deliveredReported"
        FROM projects WHERE id = ${projectId}`)
    ).rows,
  );
  if (project === undefined) throw new SnapshotRowMissing(projectId, "projects", "the run's project row");
  const items = z.array(itemRow).parse(
    (
      await db.execute(sql`
        SELECT id, title, status, level, work_kind AS "workKind", task_spec->>'origin' AS origin,
               task_spec->>'checksFor' AS "checksFor", blocked_reason AS "blockedReason", merge_commit AS "mergeCommit", merge_kind AS "mergeKind",
               owner_role_id AS "ownerRoleId", dispatch_count AS "dispatchCount",
               infrastructure_faults AS "infrastructureFaults"
        FROM work_items WHERE project_id = ${projectId} ORDER BY created_at, id`)
    ).rows,
  );
  const episodes = z.array(episodeRow).parse(
    (
      await db.execute(sql`
        SELECT b.id, b.kind, ended_at IS NOT NULL AS ended,
               COALESCE(b.report_id, CASE WHEN b.kind = 'planning_stopped' THEN (
                 SELECT m.id FROM client_messages m WHERE m.project_id = b.project_id AND m.reports_on = 'planning-stopped'
                   AND m.created_at >= b.blocked_at ORDER BY m.created_at, m.id LIMIT 1) END) AS "reportId"
        FROM project_blocks b WHERE b.project_id = ${projectId} ORDER BY b.blocked_at, b.id`)
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
  const events = z.array(eventRow).parse(
    (
      await db.execute(sql`
        SELECT row_number() OVER (ORDER BY created_at, timestamp, event_id)::int AS seq, event_type AS "eventType",
               payload->>'work_item_id' AS "workItemId"
        FROM domain_events
        WHERE payload->>'work_item_id' IN (SELECT id::text FROM work_items WHERE project_id = ${projectId})
        ORDER BY created_at, timestamp, event_id`)
    ).rows,
  );
  return {
    project,
    items,
    episodes,
    checks,
    reviewFindings,
    spendUsd: spend.spend,
    unrecordedCalls: spend.unrecorded,
    events,
    main: project.workspacePath === null ? [] : await mainLog(project.workspacePath),
    reports: await readReportRecords(db, projectId),
    textFacts: await readTextFactRecords(db, projectId, project.workspacePath),
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
type HaltCause = "spend_cap" | "infrastructure" | "undeliverable" | "unrecognized";

/** What a run ended in, in design §2.2's terms mapped onto today's project states. */
export type Outcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "halted"; readonly cause: HaltCause; readonly detail: string }
  | { readonly kind: "stopped" }
  | { readonly kind: "open" };

/**
 * Each project block kind's halt cause, over the code's own list (`satisfies`: a kind added there
 * fails the type check here until it is given one). `infrastructure` is W6's halt on the machines,
 * which the substrate probe ends; `fault` is Ashara's own record or step failing, which W7 calls
 * undeliverable (orchestrator acceptance.ts); `configuration` (a model call refused by anything but a
 * spend cap) is Ashara's setup, kept with infrastructure as before.
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
    return { kind: "halted", cause: haltCauseOf(category), detail: `${category}: ${project.blockedReason ?? "(no reason)"}` };
  }
  // Accepted is production's own state since migration 049: every goal task done is not acceptance
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
const Z0_CELL_ROLES: ReadonlyMap<string, (workKind: string | null) => boolean> = new Map<string, (workKind: string | null) => boolean>([
  ["verifier", () => true],
  ["ci", () => true],
  ["environment-check", (workKind: string | null) => workKind === "environment"],
]);

/**
 * I3's review clause: a suite review's rejection of a correct check whose missing clause its cited
 * item states (the stand-ins' misread, scripted-models.ts) is never recorded, so never routed to the
 * check's author.
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
        statement: `a suite review's rejection of "${title}", whose missing clause its cited item states, was recorded and routed: ${finding.problem}`,
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
      statement: `a cell of "${task.title}" ran as role ${role ?? "(no role label)"}, not its owner ${task.ownerRoleId}`,
    });
  }
  return found;
}

/**
 * I2-I7 and I9, judged on one project's snapshot (design §4.8). I1, I8 (checkTotality) and I5's admission
 * clause (admissions.ts, the deployment's) are judged by the run over its whole course.
 */
export function checkSnapshot(step: number, snapshot: Snapshot, context: { readonly spendCapUsd: number; readonly cells: readonly FakeCell[]; readonly final: boolean }): Violation[] {
  const violations: Violation[] = [];
  const add = (invariant: InvariantId, key: string, statement: string): void => {
    violations.push({ invariant, step, statement, key: `${invariant}:${key}` });
  };
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));

  // I2: no work item waits on a person; every halt episode has exactly one report. Every exit
  // blockedExitOf names is taken by the loop's own sweep (orchestrator parked-exits.ts, whose test
  // names each exit's writer); a reason production cannot parse has no exit at all.
  for (const item of snapshot.items) {
    if (item.status !== "Blocked") continue;
    const source = sourceOf(item.blockedReason);
    if (blockedReasonOf(item.blockedReason) === null) {
      add("I2", `${item.title}:${source ?? "none"}`, `task "${item.title}" is Blocked (${source ?? "no reason"}) with no exit the loop takes`);
    }
  }
  for (const episode of context.final ? snapshot.episodes : []) {
    if (!episode.ended && episode.reportId === null && snapshot.project.status === "blocked") {
      add("I2", `episode:${episode.kind}`, `project block episode ${episode.kind} has no report to the client`);
    }
  }

  // I3: independence.
  for (const check of snapshot.checks) {
    const task = byId.get(check.taskId);
    const author = byId.get(check.checkTaskId);
    if (task !== undefined && author !== undefined && task.ownerRoleId !== null && task.ownerRoleId === author.ownerRoleId) {
      add("I3", `same-role:${task.title}`, `the checks of "${task.title}" were written by its own owner role`);
    }
    for (const file of check.files) {
      if (file.path.startsWith("product/")) {
        add("I3", `product-file:${task?.title ?? check.taskId}:${file.path}`, `check set r${check.revision} of "${task?.title ?? check.taskId}" holds product file ${file.path}: a check that supplies what it checks`);
      }
    }
  }
  for (const found of cellRoleViolations(snapshot.items, context.cells)) add("I3", found.key, found.statement);
  for (const found of misreadRejections(snapshot.reviewFindings, snapshot.items)) add("I3", found.key, found.statement);

  // I4: an accepted project has its delivered report, once the run ends; that a halt episode
  // has its report is I2's. What each report states is judged against the records it is rendered
  // from (client-reports.ts): the halt's recorded cause, the merges recorded at a stop, the goals'
  // closes and the unchecked tasks at acceptance, and no report posted twice.
  if (context.final && snapshot.project.status === "accepted" && !snapshot.project.deliveredReported) {
    add("I4", "accepted-unreported", "the project is accepted but its delivered report was never posted");
  }
  if (context.final) {
    const checked = new Set(snapshot.checks.map((check) => check.taskId));
    for (const found of checkReports(snapshot.reports, snapshot.project, snapshot.items, checked)) add("I4", found.key, found.statement);
  }

  // I9: every fact a brief, a question or a report states is the one the store held when it was
  // composed (text-facts.ts). Judged once the run ends, like I4's report clauses.
  if (context.final) {
    for (const found of checkTextFacts(snapshot.textFacts)) add("I9", found.key, found.statement);
  }

  // I5: spend within the cap; every call has a recorded cost.
  if (snapshot.spendUsd > context.spendCapUsd + 1e-9) {
    add("I5", "over-cap", `recorded spend $${snapshot.spendUsd.toFixed(6)} exceeds the cap $${context.spendCapUsd}`);
  }
  if (snapshot.unrecordedCalls > 0) add("I5", "unpriced", `${snapshot.unrecordedCalls} llm_calls row(s) carry no cost`);

  // I6: no Done without its evidence. A passed sweep accepted the project: every item a check must
  // decide (an in-scope line, an assumption not recorded as internal design) is decided by a
  // stored check that sweep ran, as its recorded decides names it (d89 E, ADR-083). Judged on
  // every passed sweep once the run ends, whatever the project's status then.
  if (context.final) {
    for (const found of uncheckedAtPassedSweeps(snapshot.reports)) add("I6", `unchecked-item:${found.key}`, found.statement);
  }
  const checkedTasks = new Set(snapshot.checks.map((check) => check.taskId));
  for (const item of snapshot.items) {
    if (item.status !== "Completed" || item.level !== "Task") continue;
    if (item.workKind === "implementation" && item.mergeCommit === null) {
      add("I6", `no-record:${item.title}`, `"${item.title}" is Completed with no merge record`);
    }
    if (item.origin === "check" && item.checksFor !== null && !checkedTasks.has(item.checksFor)) {
      add("I6", `no-checks:${item.title}`, `check task "${item.title}" is Completed with no checks stored for the task it checks`);
    }
  }

  // I7: exactly once, main against the records.
  const recorded = new Map<string, ItemRow[]>();
  for (const item of snapshot.items) {
    if (item.mergeCommit === null) continue;
    // eslint-disable-next-line no-restricted-syntax -- policy default: a commit not yet seen has no record yet; the accumulator's start
    recorded.set(item.mergeCommit, [...(recorded.get(item.mergeCommit) ?? []), item]);
  }
  const onMain = new Set(snapshot.main.map((entry) => entry.commit));
  for (const entry of snapshot.main) {
    const named = /^merge: task (\S+)$/.exec(entry.subject)?.[1];
    if (named === undefined) continue;
    // eslint-disable-next-line no-restricted-syntax -- policy default: a merge on main with no record is held to exactly one record below and reported
    const records = (recorded.get(entry.commit) ?? []).filter((item) => item.id === named && item.status === "Completed");
    if (records.length !== 1) {
      const item = byId.get(named);
      add("I7", `unrecorded:${item?.title ?? named}`, `main commit ${entry.commit.slice(0, 12)} ("${entry.subject}") has no item Completed recording it (the item is ${item?.status ?? "absent"})`);
    }
  }
  for (const [commit, items] of recorded) {
    if (!onMain.has(commit)) add("I7", `off-main:${items.map((i) => i.title).join(",")}`, `${items.map((i) => `"${i.title}"`).join(", ")} record ${commit.slice(0, 12)}, which is not on main`);
  }
  return violations;
}

/**
 * What a project has reached, as facts read from its records (I8's progress measure). Each is
 * reached once: a fact seen again is no progress, so a loop that comes back to where it was (a
 * requeue, a halt and its resumption) adds nothing however busy it is.
 * - a work item in a status (and blocked-reason source) it never held before;
 * - a merge recorded;
 * - a check set's revision (a rewrite or a repair of the checks), and the plan's new items (above);
 * - the project in a status (and block category) it never held before;
 * - a bounded count reaching a new high: an item's charged attempts, its infrastructure faults.
 *   Each moves the item toward the bound that ends it; a count refunded and charged again does not.
 * Never a cycle, a model call, a dispatch refunded, or a halt episode alone.
 */
export function progressFacts(snapshot: Snapshot): string[] {
  const { project } = snapshot;
  // eslint-disable-next-line no-restricted-syntax -- policy default: fact text; a project with no category and one with a category are still distinct facts
  const facts = [`project:${project.status}(${project.blockedCategory ?? ""})`];
  for (const item of snapshot.items) {
    const source = sourceOf(item.blockedReason);
    // eslint-disable-next-line no-restricted-syntax -- policy default: fact text; a task with no reason source and one with a source are still distinct facts
    facts.push(`status:${item.id}:${item.status}(${source ?? ""})`);
    if (item.mergeCommit !== null) facts.push(`merge:${item.id}:${item.mergeCommit}`);
    facts.push(`attempts:${item.id}:${item.dispatchCount}`, `infrastructure:${item.id}:${item.infrastructureFaults}`);
  }
  for (const check of snapshot.checks) facts.push(`checks:${check.taskId}:${check.revision}`);
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
    // eslint-disable-next-line no-restricted-syntax -- policy default: a state not yet seen has no title yet; the accumulator's start
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
function blockedReasonOf(raw: unknown): StoredBlockedReason | null {
  try {
    return parseStoredBlockedReason(raw) ?? null;
  } catch (err) {
    if (!(err instanceof BlockedReasonCorrupt)) throw err;
    console.warn(`[simulator] an unreadable blocked reason is judged as having no exit: ${err.message}`);
    return null;
  }
}
