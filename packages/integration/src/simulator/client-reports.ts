import { sql } from "drizzle-orm";
import { z } from "zod";
import type { PROJECT_BLOCK_KINDS } from "@ashara/db";
import { BlockedReasonCorrupt, parseStoredBlockedReason, parseStoredTaskSpec } from "@ashara/delivery";
import { SPEND_CAP_ERROR_CLASS } from "@ashara/finance";
import type { StoredBlockedReason } from "@ashara/delivery";
import type { VisionSource } from "@ashara/engagement";
import type { Database } from "./database.js";

/**
 * I4, what the client is told, judged against the records it is told from: a halt
 * report states its episode's recorded kind and names the episode's record, a stop report names
 * exactly the merges recorded, and a delivered report names each goal's recorded close, exactly the
 * completed tasks no stored check covers, the goals given up, and exactly the items of what the
 * client asked for that no stored check the sweep ran decides. Every expectation is read
 * from the rows; the report's text is only what is judged. The oracle states its own expected wording
 * and classification and imports none of Engagement's composers or the acceptance repository's
 * predicates (ADR-081; boundary-rules.toml [integration] `named-only` admits into src/simulator/ only
 * the symbols it lists, none of them a composer or predicate): an oracle that asks production what to
 * expect can never find production wrong.
 */

const reportRow = z.object({ id: z.string(), body: z.string(), reportsOn: z.string().nullable(), inReplyTo: z.string().nullable() });
/** The amounts a budget_cap halt's cap was judged on, as project_blocks.spend holds them (migration 060). */
const spendRecord = z.strictObject({
  capUsd: z.number(),
  spentUsd: z.number(),
  inFlightUsd: z.number(),
  nextCallUsd: z.number().nullable(),
});
const episodeRecord = z.object({
  id: z.string(),
  kind: z.string(),
  errorClass: z.string().nullable(),
  reason: z.string().nullable(),
  /** As stored; a value that does not parse as spendRecord is its own verdict (halt-spend-corrupt). */
  spend: z.unknown(),
  reportId: z.string().nullable(),
  resumedReportId: z.string().nullable(),
  ended: z.boolean(),
});
const repairRow = z.object({ episodeId: z.string(), workItemId: z.string(), title: z.string(), attempts: z.number(), blockedReason: z.unknown() });
const sweepRow = z.object({ id: z.string(), passed: z.boolean(), uncheckedTasks: z.array(z.string()), reportId: z.string().nullable(), reportFailures: z.number() });
const revisionRow = z.object({ reportId: z.string() });
const specRow = z.object({ id: z.string(), taskSpec: z.unknown() });
const passedSweepRow = z.object({ id: z.string(), version: z.number().nullable(), inferences: z.unknown(), scopeBoundaries: z.unknown() });
/** One stored check, with the check task that wrote it and what it says it decides (migration 063). */
const storedCheckRow = z.object({ checkTaskId: z.string(), taskSpec: z.unknown(), name: z.string(), decides: z.unknown() });
type SweptCheck = z.infer<typeof storedCheckRow>;
/** One stored check a passed sweep ran. */
const sweptCheckRow = storedCheckRow.extend({ sweepId: z.string() });

export interface ReportRecords {
  /** Every outbound report of the project, in posting order. */
  readonly reports: ReadonlyArray<z.infer<typeof reportRow>>;
  readonly episodes: ReadonlyArray<z.infer<typeof episodeRecord>>;
  /** The given-up tasks each open plan_repair episode was blocked on (block-report.ts blockingAbandonments). */
  readonly repairs: ReadonlyArray<z.infer<typeof repairRow>>;
  readonly sweeps: ReadonlyArray<z.infer<typeof sweepRow>>;
  /** The reports the plan revisions record. */
  readonly revisionReports: readonly string[];
  /** The task_spec of the project's latest Completed review task (every item of the vision), or null when none. */
  readonly reviewSpec: unknown;
  /** Every check of each Completed goal task's latest stored revision (the sets a sweep runs), with its check task's task_spec. */
  readonly goalChecks: readonly SweptCheck[];
  /**
   * Every passed acceptance sweep, in order, with the vision version current when it passed (its
   * fields unparsed; version null when none was) and every stored check it ran, with the check task
   * that wrote it: each goal task it checked, at its latest checks revision written before the sweep.
   */
  readonly passedSweeps: ReadonlyArray<z.infer<typeof passedSweepRow> & { readonly storedChecks: readonly SweptCheck[] }>;
}

export async function readReportRecords(db: Database, projectId: string): Promise<ReportRecords> {
  const rows = async <T>(schema: z.ZodType<T>, query: ReturnType<typeof sql>): Promise<T[]> => z.array(schema).parse((await db.execute(query)).rows);
  return {
    reports: await rows(
      reportRow,
      sql`SELECT id, body, reports_on AS "reportsOn", in_reply_to AS "inReplyTo" FROM client_messages
          WHERE project_id = ${projectId} AND direction = 'outbound' AND kind = 'report' ORDER BY created_at, id`,
    ),
    episodes: await rows(
      episodeRecord,
      sql`SELECT id, kind, error_class AS "errorClass", reason, spend, report_id AS "reportId", resumed_report_id AS "resumedReportId",
                 ended_at IS NOT NULL AS ended
          FROM project_blocks WHERE project_id = ${projectId} ORDER BY blocked_at, id`,
    ),
    repairs: await rows(
      repairRow,
      sql`SELECT b.id AS "episodeId", w.id AS "workItemId", w.title, w.dispatch_count AS attempts, w.blocked_reason AS "blockedReason"
          FROM project_blocks b
          JOIN plan_repairs r ON r.project_id = b.project_id AND r.plan_revision_id IS NULL AND r.created_at <= b.blocked_at
          JOIN work_items w ON w.id = r.work_item_id
          WHERE b.project_id = ${projectId} AND b.kind = 'plan_repair' AND b.ended_at IS NULL
          ORDER BY r.created_at, r.work_item_id`,
    ),
    sweeps: await rows(
      sweepRow,
      sql`SELECT id, passed, unchecked_tasks AS "uncheckedTasks", report_id AS "reportId", report_failures AS "reportFailures"
          FROM acceptance_sweeps WHERE project_id = ${projectId} ORDER BY created_at, id`,
    ),
    revisionReports: (
      await rows(revisionRow, sql`SELECT report_id AS "reportId" FROM plan_revisions WHERE project_id = ${projectId} AND report_id IS NOT NULL`)
    ).map((row) => row.reportId),
    reviewSpec:
      (
        await rows(
          specRow,
          sql`SELECT id, task_spec AS "taskSpec" FROM work_items
              WHERE project_id = ${projectId} AND status = 'Completed' AND task_spec->>'origin' = 'review'
              ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
      )[0]?.taskSpec ?? null,
    goalChecks: await rows(
      storedCheckRow,
      sql`SELECT a.id AS "checkTaskId", a.task_spec AS "taskSpec", c.name, c.decides
          FROM work_items g
          JOIN task_checks c ON c.task_id = g.id AND c.revision = (SELECT max(l.revision) FROM task_checks l WHERE l.task_id = g.id)
          JOIN work_items a ON a.id = c.check_task_id
          WHERE g.project_id = ${projectId} AND g.level = 'Task' AND g.status = 'Completed' AND g.task_spec->>'origin' = 'decomposition'
          ORDER BY a.id, c.name`,
    ),
    passedSweeps: await passedSweepsOf(projectId, rows),
  };
}

async function passedSweepsOf(
  projectId: string,
  rows: <T>(schema: z.ZodType<T>, query: ReturnType<typeof sql>) => Promise<T[]>,
): Promise<ReportRecords["passedSweeps"]> {
  const sweeps = await rows(
    passedSweepRow,
    sql`SELECT s.id, v.version, v.inferences, v.scope_boundaries AS "scopeBoundaries" FROM acceptance_sweeps s
        LEFT JOIN LATERAL (SELECT version, inferences, scope_boundaries FROM vision_documents d
                           WHERE d.project_id = s.project_id AND d.created_at <= s.created_at ORDER BY d.version DESC LIMIT 1) v ON true
        WHERE s.project_id = ${projectId} AND s.passed ORDER BY s.created_at, s.id`,
  );
  const checks = await rows(
    sweptCheckRow,
    sql`SELECT s.id AS "sweepId", a.id AS "checkTaskId", a.task_spec AS "taskSpec", c.name, c.decides
        FROM acceptance_sweeps s
        CROSS JOIN LATERAL jsonb_array_elements_text(s.checked_tasks) AS t(task_id)
        JOIN task_checks c ON c.task_id::text = t.task_id
          AND c.revision = (SELECT max(l.revision) FROM task_checks l WHERE l.task_id = c.task_id AND l.created_at <= s.created_at)
        JOIN work_items a ON a.id = c.check_task_id
        WHERE s.project_id = ${projectId} AND s.passed
        ORDER BY s.id, a.id, c.name`,
  );
  return sweeps.map((sweep) => ({
    ...sweep,
    storedChecks: checks.filter((check) => check.sweepId === sweep.id).map(({ checkTaskId, taskSpec, name, decides }) => ({ checkTaskId, taskSpec, name, decides })),
  }));
}

/** What I4 reads of a work item beyond its records above. */
interface ReportedItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly level: string;
  readonly workKind: string | null;
  readonly origin: string | null;
  readonly mergeCommit: string | null;
  readonly mergeKind: string | null;
  /** Its blocked_reason as stored, unparsed. */
  readonly blockedReason: unknown;
}

/**
 * How I4 judges each block kind's report, over the code's own list (`satisfies`: a kind added there
 * fails the type check here until it is placed). `stated`: the report states the episode's recorded
 * kind in the words expectedKindWords states for it. `repair`: the report names the given-up tasks with their recorded causes.
 * `retired`: check_dispute and suite_review are written only before migration 048 (shared
 * work-item-row.ts ProjectBlockCategory); no code path writes either now and a run database starts
 * empty, so one in a run is a writer that should not exist, not a report to judge.
 */
const KIND_JUDGEMENT = {
  budget_cap: "stated",
  configuration: "stated",
  fault: "stated",
  planning_stopped: "stated",
  replan_bound: "stated",
  infrastructure: "stated",
  replan_stopped: "stated",
  replan_provider_failed: "stated",
  model_failed: "stated",
  provider_failed: "stated",
  plan_repair: "repair",
  check_dispute: "retired",
  suite_review: "retired",
} as const satisfies Record<(typeof PROJECT_BLOCK_KINDS)[number], "stated" | "repair" | "retired">;
type Judged = typeof KIND_JUDGEMENT;
type StatedKind = { [K in keyof Judged]: Judged[K] extends "stated" ? K : never }[keyof Judged];
const JUDGEMENT_OF: ReadonlyMap<string, Judged[keyof Judged]> = new Map(Object.entries(KIND_JUDGEMENT));
const STATED_KINDS: ReadonlyArray<StatedKind> = [
  "budget_cap",
  "configuration",
  "fault",
  "planning_stopped",
  "replan_bound",
  "infrastructure",
  "replan_stopped",
  "replan_provider_failed",
  "model_failed",
  "provider_failed",
];

function judgementOf(kind: string): Judged[keyof Judged] | "unknown" {
  return JUDGEMENT_OF.get(kind) ?? "unknown";
}

function statedKind(kind: string): StatedKind | null {
  return STATED_KINDS.find((each) => each === kind) ?? null;
}

/**
 * Why a given-up task was given up, as the oracle words each stored reason's source for the client:
 * its category, never the stored text, which is Ashara's internal wording. A reason that does not
 * parse, or none, is its own verdict: no line can be judged against it.
 */
type GivenUpCategory = { readonly kind: "category"; readonly words: string } | { readonly kind: "corrupt"; readonly detail: string };

function categoryWords(reason: StoredBlockedReason): string {
  switch (reason.source) {
    case "failure_given_up":
    case "task_failed":
    case "replan":
      return "its attempts at the work did not succeed";
    case "orchestrator_error":
    case "orphan_unreconciled":
      return "a step of Ashara's own work on it failed";
    case "merge_unrecorded":
      return "its work is on the project's main line, but Ashara could not record that";
    case "environment_unavailable":
      return "the machines Ashara runs the work on were not available for it";
    case "environment_undefined":
      return "the project's environment, in which it is built and tested, was not defined or could not be built";
    case "environment_change_needed":
      return "it needed a change to how the project is built and tested, and no such change was made for it";
    case "checks_stale":
    case "checks_rewrite_bound":
      return "the checks that decide it no longer held on the project's environment and could not be written again";
    case "check_disputed":
      return "its developer found that a check written for it cannot be passed by correct work, and that could not be settled";
    case "suite_review_unresolved":
      return "the review of the plan's checks found problems that could not be settled";
    case "owner_unresolved":
      return "no member of the team is assigned to do it";
    case "dependency_unsatisfiable":
      return "it depends on work that can never be finished";
    case "acceptance_failed":
      return reason.mainCommit === null
        ? "the final check of the whole project could not read the project's main line"
        : "the final check of the whole project did not pass on the project's main line";
    case "superseded":
      return "a revision of the plan replaced it";
    case "api":
      return "it was moved by hand through Ashara's API";
  }
}

function givenUpCategory(raw: unknown): GivenUpCategory {
  let parsed: StoredBlockedReason | undefined;
  try {
    parsed = parseStoredBlockedReason(raw);
  } catch (err) {
    if (!(err instanceof BlockedReasonCorrupt)) throw err;
    return { kind: "corrupt", detail: err.message };
  }
  if (parsed === undefined) return { kind: "corrupt", detail: "a given-up task records no reason" };
  return { kind: "category", words: categoryWords(parsed) };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What each stated kind says paused the project, in the client's words, as the oracle expects it:
 * written here, never read from Engagement's composer, so a composer that changes a sentence or
 * states another kind's fails I4. A budget_cap halt names whose limit from its recorded error class
 * alone (SPEND_CAP_ERROR_CLASS, the class the writers record), and a class that is neither is told
 * as not on record.
 */
function expectedKindWords(kind: StatedKind, errorClass: string | null): string {
  switch (kind) {
    case "budget_cap": {
      // A cap refuses a call whose worst case would cross it, before the recorded spend reaches it.
      const stopped = "left no room for the next step of the work, so that step was not paid for";
      if (errorClass === SPEND_CAP_ERROR_CLASS.deployment) return `the spending limit set for all of Ashara's work, across every project it runs, ${stopped}`;
      if (errorClass === SPEND_CAP_ERROR_CLASS.project) return `the spending limit set for this project ${stopped}`;
      return `a spending limit set for this work ${stopped}; which limit it was is not on record`;
    }
    case "configuration":
      return "a step of the work needed something Ashara's own setup does not provide, for a reason other than a spending limit";
    case "fault":
      return "a step of Ashara's own work on this project failed, or Ashara's own record of the project did not hold together";
    case "planning_stopped":
      return "every attempt to make the plan failed";
    case "replan_bound":
      return "the plan has been revised for your changes as many times as the team revises it before its operator looks the project over";
    case "infrastructure":
      return "the machines Ashara runs the work on kept failing while they ran this project's work";
    case "replan_stopped":
      return "every attempt to revise the plan failed, the last because the model planning it gave no usable answer";
    case "replan_provider_failed":
      return "every attempt to revise the plan failed, the last because the service that runs the model planning it returned an error or did not answer, so no answer was read";
    case "model_failed":
      return "a step of the work kept failing because the model doing it gave no usable answer";
    case "provider_failed":
      return "a step of the work kept failing because the service that runs the model doing it returned an error or did not answer, so no answer was read";
  }
}

function usd(amount: number): string {
  return `$${amount.toFixed(6)}`;
}

/** The amounts a budget_cap halt's report must state, from its episode's spend, or that they are not on record. */
function expectedSpendWords(spend: z.infer<typeof spendRecord> | null): string {
  if (spend === null) return "How much had been spent and set aside against that limit when it stopped the work is not on record.";
  const next =
    spend.nextCallUsd === null
      ? "which together had reached the limit"
      : `and the next step needed up to ${usd(spend.nextCallUsd)} set aside, more than the limit had room for`;
  return `When it stopped the work, ${usd(spend.spentUsd)} had been spent and ${usd(spend.inFlightUsd)} was set aside for work under way, ${next}; the limit is ${usd(spend.capUsd)}.`;
}

/**
 * The cause sentences a halt report must carry, from the episode's row: its recorded kind in the
 * client's words, a budget_cap halt's recorded amounts, and the episode's own id as the record that
 * holds the detail; a halt recorded with neither error class nor reason says no cause was.
 * Null when the episode's spend does not parse: no sentence can be expected of it.
 */
function statedCause(
  episode: { readonly id: string; readonly errorClass: string | null; readonly reason: string | null; readonly spend: unknown },
  kind: StatedKind,
): string | null {
  if (episode.reason === null && episode.errorClass === null) return "No cause was recorded for this pause.";
  let amounts = "";
  if (kind === "budget_cap") {
    const spend = z.union([z.null(), spendRecord]).safeParse(episode.spend ?? null);
    if (!spend.success) return null;
    amounts = `${expectedSpendWords(spend.data)} `;
  }
  return (
    `Ashara recorded the cause as this: ${expectedKindWords(kind, episode.errorClass)}. ` +
    amounts +
    `Ashara keeps the technical detail in its own record of this pause, record ${episode.id}.`
  );
}

/**
 * The line a delivered report must state for one goal task, from its merge record: merged, already
 * delivered (on the commit of the task whose merge is recorded on it, if any), closed on a commit
 * with no kind recorded, or closed with no commit.
 */
function closeOnRecord(goal: ReportedItem, items: readonly ReportedItem[]): string {
  const { title, mergeCommit: commit, mergeKind } = goal;
  if (commit === null) return `- "${title}": closed with no commit on record.`;
  if (mergeKind === "merged") return `- "${title}": built and merged, commit ${commit}.`;
  if (mergeKind === "already_delivered") {
    const by = items.find((item) => item.mergeKind === "merged" && item.mergeCommit === commit)?.title ?? null;
    return (
      `- "${title}": already delivered when its turn came; nothing of its own was merged. Its checks, and every ` +
      `check of the work before it, passed on commit ${commit}` +
      (by === null ? ", which no task's merge is recorded as making." : `, the merge of "${by}".`)
    );
  }
  return `- "${title}": closed on commit ${commit}; whether it was merged or already delivered there is not on record.`;
}

/**
 * How an Abandoned goal task left the plan, from its stored reason: set aside, when a revision of
 * the plan replaced it while it was open (source `superseded`: the team did not give up on it, the
 * plan stopped asking for it), or given up, for every other recorded reason. A reason that
 * does not parse, or none, is its own verdict: neither reading is on record.
 */
type Disposal = { readonly kind: "given-up" } | { readonly kind: "set-aside" } | { readonly kind: "corrupt"; readonly detail: string };

function disposalOf(raw: unknown): Disposal {
  let parsed: StoredBlockedReason | undefined;
  try {
    parsed = parseStoredBlockedReason(raw);
  } catch (err) {
    if (!(err instanceof BlockedReasonCorrupt)) throw err;
    return { kind: "corrupt", detail: err.message };
  }
  if (parsed === undefined) return { kind: "corrupt", detail: "an Abandoned task records no reason" };
  return parsed.source === "superseded" ? { kind: "set-aside" } : { kind: "given-up" };
}

/** The paragraph of a report that opens with `head`, or null. */
function paragraph(body: string, head: string): string | null {
  return body.split("\n\n").find((part) => part.startsWith(head)) ?? null;
}

/** The lines of a paragraph that name a task (`- "<title>"...`). */
function namedLines(part: string | null): string[] {
  return part === null ? [] : part.split("\n").filter((line) => line.startsWith(`- "`));
}

interface ReportViolation {
  readonly key: string;
  readonly statement: string;
}

/**
 * I4 on one project's final records. `status` is the project's; `checkedTaskIds` the tasks with a
 * stored check set. Reported keys name the report and the record, never an id.
 */
export function checkReports(records: ReportRecords, project: { readonly status: string }, items: readonly ReportedItem[], checkedTaskIds: ReadonlySet<string>): ReportViolation[] {
  const found: ReportViolation[] = [];
  const add = (key: string, statement: string): void => {
    found.push({ key, statement });
  };
  const byId = new Map(records.reports.map((report) => [report.id, report]));

  // Exactly once: every report the project was sent is the one report of the record it was posted on.
  const recorded = [
    ...records.episodes.flatMap((episode) => [episode.reportId, episode.resumedReportId]),
    ...records.sweeps.map((sweep) => sweep.reportId),
    ...records.revisionReports,
  ].filter((id): id is string => id !== null);
  for (const report of records.reports) {
    if (recorded.includes(report.id) || report.reportsOn !== null || report.inReplyTo !== null) continue;
    add("unrecorded-report", `a report was sent that no record was posted on (a second report of something already reported): "${report.body.slice(0, 80)}..."`);
  }

  // A halt's report states the cause recorded on its episode.
  for (const episode of records.episodes) {
    if (episode.reportId === null) continue;
    const report = byId.get(episode.reportId);
    if (report === undefined) {
      add(`halt-report-missing:${episode.kind}`, `the ${episode.kind} halt records report ${episode.reportId}, which is not among the project's reports`);
      continue;
    }
    const { kind } = episode;
    const judgement = judgementOf(kind);
    const stating = statedKind(kind);
    if (judgement === "stated" && stating === null) {
      add(`halt-kind-unjudged:${kind}`, `the ${kind} halt is judged as stating its kind, but STATED_KINDS does not hold it`);
    } else if (stating !== null) {
      const stated = statedCause(episode, stating);
      if (stated === null) {
        add(`halt-spend-corrupt:${kind}`, `the ${kind} halt records a spend that does not parse, so no report can be judged against it`);
      } else if (!report.body.includes(stated)) {
        add(`halt-cause:${kind}`, `the ${kind} halt report does not state the recorded cause as "${stated.slice(0, 200)}"; it reads "${report.body.slice(0, 200)}"`);
      }
    } else if (judgement === "retired") {
      add(`halt-kind-retired:${kind}`, `a ${kind} halt was written, a kind no code path writes since migration 048`);
    } else if (kind === "plan_repair" && !episode.ended) {
      const blocking = records.repairs.filter((repair) => repair.episodeId === episode.id);
      for (const repair of blocking) {
        const category = givenUpCategory(repair.blockedReason);
        if (category.kind === "corrupt") {
          add("halt-cause-corrupt:plan_repair", `"${repair.title}" is given up with a stored reason that does not parse, so no report can be judged against it: ${category.detail.slice(0, 200)}`);
          continue;
        }
        const expected =
          `- "${repair.title}", after ${plural(repair.attempts, "attempt")} counted against it. Ashara recorded why it was given up as this: ` +
          `${category.words}. Ashara keeps the detail in its own record of that task, record ${repair.workItemId}.`;
        if (!namedLines(report.body).includes(expected)) {
          add("halt-cause:plan_repair", `the plan_repair halt report does not name "${repair.title}" as "${expected.slice(0, 200)}"`);
        }
      }
      const named = namedLines(report.body).length;
      if (named !== blocking.length) add("halt-cause:plan_repair", `the plan_repair halt report names ${named} given-up task(s); the records name ${blocking.length}`);
    } else if (judgement === "unknown") {
      add(`halt-kind-unknown:${kind}`, `a halt of kind ${kind}, outside the code's list, was reported: no oracle states what it must say`);
    }
  }

  // The stop report names exactly the merges recorded.
  if (project.status === "stopped") {
    const stops = records.reports.filter((report) => report.reportsOn === "client-stop");
    if (stops.length !== 1) add("stop-reports", `the project is stopped with ${stops.length} stop report(s)`);
    const [stop] = stops;
    if (stop !== undefined) {
      const merges = items.filter((item) => item.level === "Task" && item.mergeCommit !== null);
      const lines = namedLines(paragraph(stop.body, "What is on main") ?? "");
      for (const item of merges) {
        if (!lines.some((line) => line.startsWith(`- "${item.title}"`) && line.includes(item.mergeCommit ?? ""))) {
          add("stop-merges", `the stop report does not name "${item.title}" merged as ${item.mergeCommit ?? ""}`);
        }
      }
      if (lines.length !== merges.length) add("stop-merges", `the stop report names ${lines.length} merge(s); the records hold ${merges.length}`);
    }
  }

  // The delivered report: each goal's recorded close, exactly the completed tasks no stored check
  // covers, the goals given up, and exactly the asked-for items no stored check the sweep ran decides.
  if (project.status === "accepted") {
    const passed = records.sweeps.filter((sweep) => sweep.passed);
    const sweep = passed.at(-1);
    if (sweep === undefined) add("accepted-unswept", "the project is accepted with no passed acceptance sweep on record");
    const report = sweep?.reportId === null || sweep === undefined ? undefined : byId.get(sweep.reportId);
    const notice = report === undefined ? null : /^Your project is accepted: .* could not be written from Ashara's records in (\d+) attempts\./.exec(report.body);
    if (notice !== null && sweep !== undefined) {
      // The acceptance notice sent in place of a report whose records could not be read: every
      // attempt it names but the posting one is a failure recorded on the sweep.
      const attempts = Number(notice[1]);
      if (sweep.reportFailures < attempts - 1) {
        add("delivered-notice-unfounded", `the acceptance notice says the report could not be written in ${attempts} attempts; the sweep records ${sweep.reportFailures} failed attempt(s)`);
      }
    } else if (report !== undefined) {
      const goals = items.filter((item) => item.level === "Task" && item.status === "Completed" && item.origin === "decomposition");
      const closes = namedLines(paragraph(report.body, "What was delivered:"));
      for (const goal of goals) {
        // A revised plan can hold two goal tasks of one title (the one it replaced, still Completed):
        // each is matched to a line by its title, its commit and its kind together.
        const named = closes.filter((each) => each.startsWith(`- "${goal.title}": `));
        if (!named.includes(closeOnRecord(goal, items))) {
          add("delivered-close", `the delivered report does not state "${goal.title}" closed ${goal.mergeKind ?? "with no kind recorded"} on ${goal.mergeCommit ?? "no commit"}; it reads ${named.join(" | ") || "no line for it"}`);
        }
      }
      if (closes.length !== goals.length) add("delivered-close", `the delivered report names ${closes.length} goal(s); the records hold ${goals.length} completed goal task(s)`);

      const unchecked = items.filter((item) => item.status === "Completed" && item.workKind === "implementation" && !checkedTaskIds.has(item.id));
      const swept = new Set(sweep?.uncheckedTasks ?? []);
      if (unchecked.length !== swept.size || unchecked.some((item) => !swept.has(item.id))) {
        add("delivered-unchecked", `the accepted sweep records ${swept.size} task(s) as not checked; the task and check records hold ${unchecked.length}`);
      }
      const stated = namedLines(paragraph(report.body, "These tasks are done but not checked"));
      if (stated.length !== unchecked.length || unchecked.some((item) => !stated.includes(`- "${item.title}"`))) {
        add("delivered-unchecked", `the delivered report states ${stated.length} task(s) not checked by a stored check; the records hold ${unchecked.length}: ${unchecked.map((item) => `"${item.title}"`).join(", ")}`);
      }

      const givenUp: ReportedItem[] = [];
      for (const item of items.filter((each) => each.level === "Task" && each.status === "Abandoned" && each.origin === "decomposition")) {
        const disposal = disposalOf(item.blockedReason);
        if (disposal.kind === "corrupt") add("delivered-given-up-corrupt", `"${item.title}" is Abandoned with a stored reason that does not parse, so whether it was given up is not on record: ${disposal.detail.slice(0, 200)}`);
        else if (disposal.kind === "given-up") givenUp.push(item);
      }
      const statedGivenUp = namedLines(paragraph(report.body, "These tasks were given up"));
      if (statedGivenUp.length !== givenUp.length || givenUp.some((item) => !statedGivenUp.includes(`- "${item.title}"`))) {
        add("delivered-given-up", `the delivered report names ${statedGivenUp.length} goal task(s) given up; the records hold ${givenUp.length}: ${givenUp.map((item) => `"${item.title}"`).join(", ")}`);
      }

      for (const problem of coverageProblems(report.body, coverageOnRecord(records))) add("delivered-coverage", problem);
    }
  }
  return found;
}

/** Which items of what the client asked for the records say no stored check the sweep ran decides. */
type CoverageOnRecord =
  | { readonly kind: "unrecorded" }
  /** A record the coverage is computed from cannot be read: production's report cannot be rendered either. */
  | { readonly kind: "unreadable"; readonly detail: string }
  | { readonly kind: "recorded"; readonly asked: readonly VisionSource[]; readonly uncovered: readonly VisionSource[]; readonly notAsked: readonly VisionSource[] };

/** An item is the same across a plan's revisions only when its type, id and text all match (as acceptance.ts compares them). */
function identityOf(source: Pick<VisionSource, "type" | "id" | "text">): string {
  return JSON.stringify([source.type, source.id, source.text]);
}

/**
 * The identities the stored checks decide (ADR-083): each id a check names in `decides`, read as its
 * check task cites it. Unrecorded when a check names none (a row from before migration 063) or its
 * check task records no cited items; unreadable when a check names an id its check task does not
 * cite or its `decides` is no list of ids. Either way no stored fact says which items were checked.
 */
function decidedByStoredChecks(
  checks: readonly SweptCheck[],
): { readonly kind: "decided"; readonly decided: ReadonlySet<string> } | { readonly kind: "unrecorded" | "unreadable"; readonly detail: string } {
  const decided = new Set<string>();
  for (const check of checks) {
    const decides = z.array(z.string().min(1)).min(1).nullable().safeParse(check.decides);
    if (!decides.success) return { kind: "unreadable", detail: `check "${check.name}" of check task ${check.checkTaskId} records decides that are no list of ids` };
    if (decides.data === null) return { kind: "unrecorded", detail: `check "${check.name}" of check task ${check.checkTaskId} records no items it decides` };
    const sources = parseStoredTaskSpec(check.taskSpec)?.sources;
    if (sources === undefined) return { kind: "unrecorded", detail: `check task ${check.checkTaskId} records no items it cites` };
    for (const id of decides.data) {
      const source = sources.find((each) => each.id === id);
      if (source === undefined) return { kind: "unreadable", detail: `check "${check.name}" of check task ${check.checkTaskId} decides ${id}, which its check task does not cite` };
      decided.add(identityOf(source));
    }
  }
  return { kind: "decided", decided };
}

const sweptAssumption = z.looseObject({ key: z.string().min(1).optional(), statement: z.string().min(1), kind: z.enum(["client-visible", "internal-design"]).optional() });
/** A scope line as stored: with its side, or a bare string written before sides were recorded (no side on record). */
const sweptScopeLine = z.union([z.looseObject({ text: z.string().min(1), side: z.enum(["in", "out"]) }), z.string().min(1)]);

/** One finding of the guard, keyed by the item (or the record that could not be read). */
interface UncheckedFinding {
  readonly key: string;
  readonly statement: string;
}

/**
 * The guard of d89 E and ADR-083, judged on every passed acceptance sweep, whatever the project did
 * after it: every item of the vision current when the sweep passed that a check must decide (an
 * in-scope line or one of no recorded side, an assumption not recorded as internal design) is
 * decided, as that vision states it, by a stored check the sweep ran: one whose recorded `decides`
 * names it. A line citing it is no check of it. It is something the client asked for or could
 * observe, so accepting with no check on it delivers it unverified. One finding per item, keyed by
 * its id, at the first sweep that misses it.
 */
export function uncheckedAtPassedSweeps(records: Pick<ReportRecords, "passedSweeps">): UncheckedFinding[] {
  const found = new Map<string, string>();
  for (const [n, sweep] of records.passedSweeps.entries()) {
    for (const finding of uncheckedAtSweep(sweep, `passed sweep ${n + 1} (${sweep.id})`)) {
      if (!found.has(finding.key)) found.set(finding.key, finding.statement);
    }
  }
  return [...found].map(([key, statement]) => ({ key, statement }));
}

function uncheckedAtSweep(sweep: ReportRecords["passedSweeps"][number], at: string): UncheckedFinding[] {
  if (sweep.version === null) return [{ key: "no-vision", statement: `${at} passed with no vision version on record` }];
  const inferences = z.array(sweptAssumption).safeParse(sweep.inferences);
  const scope = z.array(sweptScopeLine).safeParse(sweep.scopeBoundaries);
  if (!inferences.success || !scope.success) {
    const error = inferences.error ?? scope.error;
    return [{ key: "vision-unreadable", statement: `vision v${sweep.version} at ${at} cannot be read as keyed assumptions and scope lines: ${error === undefined ? "" : z.prettifyError(error).slice(0, 200)}` }];
  }
  const swept = decidedByStoredChecks(sweep.storedChecks);
  if (swept.kind !== "decided") return [{ key: "coverage-unreadable", statement: `which items the checks ${at} ran decide is not on record: ${swept.detail}` }];
  const missed = (type: "scope" | "assumption", id: string, text: string): boolean => !swept.decided.has(identityOf({ type, id, text }));
  const scopeFindings = scope.data.flatMap((line, i) => {
    const id = `S${i + 1}`;
    const { text, side } = typeof line === "string" ? { text: line, side: "of no recorded side" } : line;
    if (side === "out" || !missed("scope", id, text)) return [];
    return [{ key: id, statement: `scope line ${id} ("${text.slice(0, 120)}"), ${side === "in" ? "in scope" : side}, is decided by no stored check ${at} ran` }];
  });
  const assumptionFindings = inferences.data.flatMap((record, i) => {
    const key = record.key ?? `A${i + 1}`;
    if (record.kind === "internal-design" || !missed("assumption", key, record.statement)) return [];
    return [{ key, statement: `assumption ${key} ("${record.statement.slice(0, 120)}"), ${record.kind ?? "of no recorded kind"}, is decided by no stored check ${at} ran` }];
  });
  return [...scopeFindings, ...assumptionFindings];
}

/**
 * The coverage the delivered report must state, from the records alone: the review task's
 * sources are every item of the vision; an item is checked when a check of a goal task's latest
 * stored revision records that it decides it (ADR-083); an out-of-scope line, or an assumption
 * recorded as the team's own design choice, is not part of what the client asked for and is never
 * listed. Unrecorded when the review holds no traced items or one such check records none it decides.
 */
function coverageOnRecord(records: Pick<ReportRecords, "reviewSpec" | "goalChecks">): CoverageOnRecord {
  // A corrupt task_spec throws TaskSpecCorrupt through the snapshot check: the run fails, never passes unjudged.
  const items = parseStoredTaskSpec(records.reviewSpec)?.sources;
  if (items === undefined) return { kind: "unrecorded" };
  const swept = decidedByStoredChecks(records.goalChecks);
  if (swept.kind !== "decided") return swept.kind === "unrecorded" ? { kind: "unrecorded" } : { kind: "unreadable", detail: swept.detail };
  const decided = swept.decided;
  const isAsked = (source: VisionSource): boolean => (source.type === "scope" ? source.side !== "out" : source.kind !== "internal-design");
  const asked = items.filter(isAsked);
  return { kind: "recorded", asked, uncovered: asked.filter((source) => !decided.has(identityOf(source))), notAsked: items.filter((source) => !isAsked(source)) };
}

const UNCOVERED_HEAD = "These items of what you asked for are decided by no stored check";
const UNVERIFIED_HEAD = "These assumptions were recorded as how the team builds the product";

/** Where the delivered report's coverage section departs from the records. */
function coverageProblems(body: string, coverage: CoverageOnRecord): string[] {
  if (coverage.kind === "unreadable") return [`the coverage records cannot be read, yet a delivered report was posted: ${coverage.detail}`];
  const listed = (paragraph(body, UNCOVERED_HEAD) ?? "").split("\n").filter((line) => line.startsWith("- "));
  const expectSentence = (sentence: string, what: string): string[] =>
    [
      ...(body.includes(sentence) ? [] : [`the records hold ${what}, but the delivered report does not say "${sentence}"`]),
      ...(listed.length === 0 ? [] : [`the records hold ${what}, but the delivered report lists ${listed.length} item(s) as not covered`]),
    ];
  if (coverage.kind === "unrecorded") return expectSentence("is not on record for this plan", "no record of what the checks decide");
  const problems = unverifiedProblems(body, coverage.notAsked);
  if (coverage.asked.length === 0) return [...problems, ...expectSentence("holds no item of what you asked for", "no item the client asked for")];
  if (coverage.uncovered.length === 0) return [...problems, ...expectSentence("Every item of what you asked for is decided", "every asked-for item decided")];
  for (const source of coverage.uncovered) {
    if (!listed.some((line) => line.includes(source.text))) problems.push(`the delivered report does not list "${source.text}" (${source.id}) as decided by no stored check`);
  }
  for (const source of coverage.notAsked) {
    if (listed.some((line) => line.includes(source.text))) problems.push(`the delivered report lists "${source.text}" (${source.id}), which the client did not ask for, as not covered`);
  }
  if (listed.length !== coverage.uncovered.length) problems.push(`the delivered report lists ${listed.length} item(s) as not covered; the records hold ${coverage.uncovered.length}`);
  return problems;
}

/**
 * ADR-083: the delivered report names every assumption recorded as internal design, by id and text,
 * as not verified by Ashara, and nothing else there; none at all when there is no such assumption.
 */
function unverifiedProblems(body: string, notAsked: readonly VisionSource[]): string[] {
  const expected = notAsked.flatMap((source) => (source.type === "assumption" ? [`- ${source.id}: ${source.text}`] : []));
  const section = paragraph(body, UNVERIFIED_HEAD);
  if (expected.length === 0) return section === null ? [] : ["the delivered report names assumptions as not verified by Ashara; the records hold no internal-design assumption"];
  if (section === null) return [`the delivered report does not name the ${expected.length} internal-design assumption(s) as not verified by Ashara`];
  const listed = section.split("\n").filter((line) => line.startsWith("- "));
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    return [`the delivered report names ${JSON.stringify(listed).slice(0, 200)} as not verified by Ashara; the records hold ${JSON.stringify(expected).slice(0, 200)}`];
  }
  return [];
}
