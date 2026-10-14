import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BLOCKED_REASON_SOURCES, BlockedReasonCorrupt, parseStoredBlockedReason } from "@ashara/shared";
import type { StoredBlockedReason } from "@ashara/shared";
import type { Database } from "./database.js";
import type { FakeCell } from "./fake-podman.js";

const run = promisify(execFile);

/** The invariants of design §2.9, as judged on today's schema. */
const INVARIANTS = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8"] as const;
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

const episodeRow = z.object({ id: z.string(), kind: z.string(), reportId: z.string().nullable(), ended: z.boolean() });
const checkRow = z.object({
  taskId: z.string(),
  checkTaskId: z.string(),
  revision: z.number(),
  name: z.string(),
  files: z.array(z.object({ path: z.string() })),
});
const eventRow = z.object({ seq: z.number(), eventType: z.string(), workItemId: z.string().nullable() });

interface MainCommit {
  readonly commit: string;
  readonly subject: string;
}

export interface Snapshot {
  readonly project: ProjectRow;
  readonly items: readonly ItemRow[];
  readonly episodes: ReadonlyArray<z.infer<typeof episodeRow>>;
  readonly checks: ReadonlyArray<z.infer<typeof checkRow>>;
  readonly spendUsd: number;
  readonly unrecordedCalls: number;
  readonly events: ReadonlyArray<z.infer<typeof eventRow>>;
  readonly main: readonly MainCommit[];
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
        SELECT status, blocked_category AS "blockedCategory", blocked_reason AS "blockedReason",
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
               task_spec->>'checksFor' AS "checksFor", blocked_reason AS "blockedReason", merge_commit AS "mergeCommit",
               owner_role_id AS "ownerRoleId", dispatch_count AS "dispatchCount",
               infrastructure_faults AS "infrastructureFaults"
        FROM work_items WHERE project_id = ${projectId} ORDER BY created_at, id`)
    ).rows,
  );
  const episodes = z.array(episodeRow).parse(
    (
      await db.execute(sql`
        SELECT id, kind, report_id AS "reportId", ended_at IS NOT NULL AS ended
        FROM project_blocks WHERE project_id = ${projectId} ORDER BY blocked_at, id`)
    ).rows,
  );
  const checks = z.array(checkRow).parse(
    (
      await db.execute(sql`
        SELECT task_id AS "taskId", check_task_id AS "checkTaskId", revision, name, files
        FROM task_checks WHERE project_id = ${projectId} ORDER BY task_id, revision, name`)
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
    spendUsd: spend.spend,
    unrecordedCalls: spend.unrecorded,
    events,
    main: project.workspacePath === null ? [] : await mainLog(project.workspacePath),
  };
}

/** main's first-parent history, read by the host's git outside every seam (the observer is never faulted). */
async function mainLog(repository: string): Promise<MainCommit[]> {
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
    // A repository with no commit on main yet has no history: that is the snapshot, not a failure.
    console.warn(`[simulator] git log of ${repository} read nothing: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return [];
  }
}

/** The files main holds, read like mainLog; none when main has no commit. */
export async function mainFiles(repository: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["-C", repository, "ls-tree", "-r", "--name-only", "main"]);
    return stdout.split("\n").filter((line) => line !== "");
  } catch (err) {
    console.warn(`[simulator] git ls-tree of ${repository} read nothing: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return [];
  }
}

const sourceSchema = z.object({ source: z.enum(BLOCKED_REASON_SOURCES) });

/** The blocked reason's source, or null when the row has none or one this checkout does not know. */
export function sourceOf(raw: unknown): (typeof BLOCKED_REASON_SOURCES)[number] | null {
  const parsed = sourceSchema.safeParse(raw);
  return parsed.success ? parsed.data.source : null;
}

/** What a run ended in, in design §2.2's terms mapped onto today's project states. */
export type Outcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "halted"; readonly cause: "spend_cap" | "infrastructure" | "undeliverable"; readonly detail: string }
  | { readonly kind: "stopped" }
  | { readonly kind: "open" };

const SPEND = new Set(["budget_cap"]);
const INFRASTRUCTURE = new Set(["configuration", "fault", "infrastructure"]);

export function outcomeOf(snapshot: Snapshot): Outcome {
  const { project } = snapshot;
  if (project.status === "stopped") return { kind: "stopped" };
  if (project.status === "blocked") {
    const category = project.blockedCategory ?? (project.planStopped ? "planning_stopped" : "unknown");
    const cause = SPEND.has(category) ? "spend_cap" : INFRASTRUCTURE.has(category) ? "infrastructure" : "undeliverable";
    return { kind: "halted", cause, detail: `${category}: ${project.blockedReason ?? "(no reason)"}` };
  }
  // Accepted is production's own state since migration 049: every goal task done is not acceptance
  // until the sweep on main passes.
  if (project.status === "accepted") return { kind: "accepted" };
  return { kind: "open" };
}

/**
 * I2-I7, judged on one project's snapshot (design §4.8). I1, I8 (checkTotality) and I5's admission
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
        add("I3", `product-file:${task?.title ?? check.taskId}:${file.path}`, `check set r${check.revision} of "${task?.title ?? check.taskId}" holds product file ${file.path}: a check that supplies what it checks (run 8 E1)`);
      }
    }
  }
  for (const cell of context.cells) {
    const taskId = cell.labels["ashara.task"];
    const role = cell.labels["ashara.role"];
    const task = taskId === undefined ? undefined : byId.get(taskId);
    if (task !== undefined && task.ownerRoleId !== null && role !== undefined && role !== task.ownerRoleId && task.workKind !== "check") {
      add("I3", `cell-role:${task.title}:${role}`, `a cell of "${task.title}" ran as role ${role}, not its owner ${task.ownerRoleId}`);
    }
  }

  // I4: an accepted project has its delivered report (E3), once the run ends; halt episodes'
  // reports are I2's. A report's claims against the snapshot are not judged here (L8's snapshot
  // rendering is deferred, mvp-rescope §1.3).
  if (context.final && snapshot.project.status === "accepted" && !snapshot.project.deliveredReported) {
    add("I4", "accepted-unreported", "the project is accepted but its delivered report was never posted");
  }

  // I5: spend within the cap; every call has a recorded cost.
  if (snapshot.spendUsd > context.spendCapUsd + 1e-9) {
    add("I5", "over-cap", `recorded spend $${snapshot.spendUsd.toFixed(6)} exceeds the cap $${context.spendCapUsd}`);
  }
  if (snapshot.unrecordedCalls > 0) add("I5", "unpriced", `${snapshot.unrecordedCalls} llm_calls row(s) carry no cost`);

  // I6: no Done without its evidence.
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
    recorded.set(item.mergeCommit, [...(recorded.get(item.mergeCommit) ?? []), item]);
  }
  const onMain = new Set(snapshot.main.map((entry) => entry.commit));
  for (const entry of snapshot.main) {
    const named = /^merge: task (\S+)$/.exec(entry.subject)?.[1];
    if (named === undefined) continue;
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
  const facts = [`project:${project.status}(${project.blockedCategory ?? ""})`];
  for (const item of snapshot.items) {
    const source = sourceOf(item.blockedReason);
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
