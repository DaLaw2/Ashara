import { sql } from "drizzle-orm";
import { z } from "zod";
import type { PROJECT_BLOCK_KINDS } from "@ashara/db";
import { recordedKind } from "@ashara/engagement";
import type { ProjectBlockKind } from "@ashara/engagement";
import { BlockedReasonCorrupt, parseStoredBlockedReason, parseStoredTaskSpec } from "@ashara/shared";
import type { StoredBlockedReason, VisionSource } from "@ashara/shared";
import type { Database } from "./database.js";

/**
 * I4, what the client is told, judged against the records it is told from (W6/W7/W11): a halt
 * report states its episode's recorded kind and names the episode's record, a stop report names
 * exactly the merges recorded, and a delivered report names each goal's recorded close, exactly the
 * completed tasks no stored check covers, the goals given up, and exactly the items of what the
 * client asked for that no acceptance line of a swept check task cites. Every expectation is read
 * from the rows; the report's text is only what is judged.
 */

const reportRow = z.object({ id: z.string(), body: z.string(), reportsOn: z.string().nullable(), inReplyTo: z.string().nullable() });
const episodeRecord = z.object({
  id: z.string(),
  kind: z.string(),
  errorClass: z.string().nullable(),
  reason: z.string().nullable(),
  reportId: z.string().nullable(),
  resumedReportId: z.string().nullable(),
  ended: z.boolean(),
});
const repairRow = z.object({ episodeId: z.string(), title: z.string(), attempts: z.number(), blockedReason: z.unknown() });
const sweepRow = z.object({ id: z.string(), passed: z.boolean(), uncheckedTasks: z.array(z.string()), reportId: z.string().nullable() });
const revisionRow = z.object({ reportId: z.string() });
const specRow = z.object({ id: z.string(), taskSpec: z.unknown() });

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
  /** The check tasks that wrote each Completed goal task's latest stored checks (the sets a sweep runs), with their task_spec. */
  readonly checkAuthors: ReadonlyArray<z.infer<typeof specRow>>;
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
      sql`SELECT id, kind, error_class AS "errorClass", reason, report_id AS "reportId", resumed_report_id AS "resumedReportId",
                 ended_at IS NOT NULL AS ended
          FROM project_blocks WHERE project_id = ${projectId} ORDER BY blocked_at, id`,
    ),
    repairs: await rows(
      repairRow,
      sql`SELECT b.id AS "episodeId", w.title, w.dispatch_count AS attempts, w.blocked_reason AS "blockedReason"
          FROM project_blocks b
          JOIN plan_repairs r ON r.project_id = b.project_id AND r.plan_revision_id IS NULL AND r.created_at <= b.blocked_at
          JOIN work_items w ON w.id = r.work_item_id
          WHERE b.project_id = ${projectId} AND b.kind = 'plan_repair' AND b.ended_at IS NULL
          ORDER BY r.created_at, r.work_item_id`,
    ),
    sweeps: await rows(
      sweepRow,
      sql`SELECT id, passed, unchecked_tasks AS "uncheckedTasks", report_id AS "reportId"
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
    checkAuthors: await rows(
      specRow,
      sql`SELECT DISTINCT a.id, a.task_spec AS "taskSpec"
          FROM work_items g
          JOIN task_checks c ON c.task_id = g.id AND c.revision = (SELECT max(l.revision) FROM task_checks l WHERE l.task_id = g.id)
          JOIN work_items a ON a.id = c.check_task_id
          WHERE g.project_id = ${projectId} AND g.level = 'Task' AND g.status = 'Completed' AND g.task_spec->>'origin' = 'decomposition'
          ORDER BY a.id`,
    ),
  };
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
}

/** How much of a recorded cause a report must quote: enough to be that cause and no other. */
const QUOTED_CHARS = 200;

/**
 * How I4 judges each block kind's report, over the code's own list (`satisfies`: a kind added there
 * fails the type check here until it is placed). `stated`: the report states the episode's recorded
 * kind (engagement block-report.ts projectBlockedReport); `recordedKind` refuses a kind engagement
 * does not state. `repair`: the report names the given-up tasks with their recorded causes.
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
  plan_repair: "repair",
  check_dispute: "retired",
  suite_review: "retired",
} as const satisfies Record<(typeof PROJECT_BLOCK_KINDS)[number], "stated" | "repair" | "retired">;
type Judged = typeof KIND_JUDGEMENT;
type StatedKind = { [K in keyof Judged]: Judged[K] extends "stated" ? K : never }[keyof Judged] & ProjectBlockKind;
const JUDGEMENT_OF: ReadonlyMap<string, Judged[keyof Judged]> = new Map(Object.entries(KIND_JUDGEMENT));
const STATED_KINDS: ReadonlyArray<StatedKind> = ["budget_cap", "configuration", "fault", "planning_stopped", "replan_bound", "infrastructure"];

function judgementOf(kind: string): Judged[keyof Judged] | "unknown" {
  return JUDGEMENT_OF.get(kind) ?? "unknown";
}

function statedKind(kind: string): StatedKind | null {
  return STATED_KINDS.find((each) => each === kind) ?? null;
}

/**
 * What a given-up task's stored reason records of why: its text, none, or a corrupt record. A
 * corrupt reason is its own verdict, never "none": reading it as none would leave the halt report
 * judged on the task's title alone.
 */
type RecordedWhy = { readonly kind: "text"; readonly text: string } | { readonly kind: "none" } | { readonly kind: "corrupt"; readonly detail: string };

function recordedWhy(raw: unknown): RecordedWhy {
  let parsed: StoredBlockedReason | undefined;
  try {
    parsed = parseStoredBlockedReason(raw);
  } catch (err) {
    if (!(err instanceof BlockedReasonCorrupt)) throw err;
    return { kind: "corrupt", detail: err.message };
  }
  if (parsed === undefined) return { kind: "none" };
  if (parsed.source === "replan") return { kind: "text", text: parsed.replanContext.detail };
  return "reason" in parsed && typeof parsed.reason === "string" ? { kind: "text", text: parsed.reason } : { kind: "none" };
}

/**
 * The cause sentences a halt report must carry, from the episode's row: its recorded kind in the
 * client's words, and the episode's own id as the record that holds the detail (W11b D3); a halt
 * recorded with neither error class nor reason says no cause was.
 */
function statedCause(episode: { readonly id: string; readonly errorClass: string | null; readonly reason: string | null }, kind: StatedKind): string {
  if (episode.reason === null && episode.errorClass === null) return "No cause was recorded for this pause.";
  return (
    `Ashara recorded the cause as this: ${recordedKind(kind)}. ` +
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
      if (!report.body.includes(stated)) {
        add(`halt-cause:${kind}`, `the ${kind} halt report does not state the recorded cause as "${stated.slice(0, 200)}"; it reads "${report.body.slice(0, 200)}"`);
      }
    } else if (judgement === "retired") {
      add(`halt-kind-retired:${kind}`, `a ${kind} halt was written, a kind no code path writes since migration 048`);
    } else if (kind === "plan_repair" && !episode.ended) {
      const blocking = records.repairs.filter((repair) => repair.episodeId === episode.id);
      for (const repair of blocking) {
        const recorded = recordedWhy(repair.blockedReason);
        if (recorded.kind === "corrupt") {
          add("halt-cause-corrupt:plan_repair", `"${repair.title}" is given up with a stored reason that does not parse, so no report can be judged against it: ${recorded.detail.slice(0, 200)}`);
          continue;
        }
        const why = recorded.kind === "text" ? recorded.text.slice(0, QUOTED_CHARS) : null;
        const line = namedLines(report.body).find((each) => each.startsWith(`- "${repair.title}"`));
        if (line === undefined || (why !== null && !report.body.includes(why))) {
          add("halt-cause:plan_repair", `the plan_repair halt report does not name "${repair.title}" with its recorded cause${why === null ? "" : ` "${why.slice(0, 120)}"`}`);
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
  // covers, the goals given up, and exactly the asked-for items no swept acceptance line cites.
  if (project.status === "accepted") {
    const passed = records.sweeps.filter((sweep) => sweep.passed);
    const sweep = passed.at(-1);
    if (sweep === undefined) add("accepted-unswept", "the project is accepted with no passed acceptance sweep on record");
    const report = sweep?.reportId === null || sweep === undefined ? undefined : byId.get(sweep.reportId);
    if (report !== undefined) {
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

      const givenUp = items.filter((item) => item.level === "Task" && item.status === "Abandoned" && item.origin === "decomposition");
      const statedGivenUp = namedLines(paragraph(report.body, "These tasks were given up"));
      if (statedGivenUp.length !== givenUp.length || givenUp.some((item) => !statedGivenUp.includes(`- "${item.title}"`))) {
        add("delivered-given-up", `the delivered report names ${statedGivenUp.length} goal task(s) given up; the records hold ${givenUp.length}: ${givenUp.map((item) => `"${item.title}"`).join(", ")}`);
      }

      for (const problem of coverageProblems(report.body, coverageOnRecord(records))) add("delivered-coverage", problem);
    }
  }
  return found;
}

/** Which items of what the client asked for the records say no swept check task's acceptance line cites. */
type CoverageOnRecord =
  | { readonly kind: "unrecorded" }
  /** A record the coverage is computed from cannot be read: production's report cannot be rendered either. */
  | { readonly kind: "unreadable"; readonly detail: string }
  | { readonly kind: "recorded"; readonly asked: readonly VisionSource[]; readonly uncovered: readonly VisionSource[]; readonly notAsked: readonly VisionSource[] };

/** An item is the same across a plan's revisions only when its type, id and text all match (as acceptance.ts compares them). */
function identityOf(source: VisionSource): string {
  return JSON.stringify([source.type, source.id, source.text]);
}

/**
 * The coverage the delivered report must state, from the records alone (W11c D3): the review task's
 * sources are every item of the vision; an item is checked when an acceptance line of a check task
 * that wrote a goal task's latest stored checks cites it; an out-of-scope line, or an assumption
 * recorded as the team's own design choice, is not part of what the client asked for and is never
 * listed. Unrecorded when the review, or one such check task, holds no traced lines.
 */
function coverageOnRecord(records: Pick<ReportRecords, "reviewSpec" | "checkAuthors">): CoverageOnRecord {
  // A corrupt task_spec throws TaskSpecCorrupt through the snapshot check: the run fails, never passes unjudged.
  const items = parseStoredTaskSpec(records.reviewSpec)?.sources;
  if (items === undefined) return { kind: "unrecorded" };
  const cited = new Set<string>();
  for (const author of records.checkAuthors) {
    const spec = parseStoredTaskSpec(author.taskSpec);
    if (spec?.acceptance === undefined || spec.sources === undefined) return { kind: "unrecorded" };
    const own = new Map(spec.sources.map((source) => [source.id, source]));
    for (const line of spec.acceptance) {
      for (const id of line.sources) {
        const source = own.get(id);
        if (source === undefined) return { kind: "unreadable", detail: `check task ${author.id}'s line "${line.line}" cites ${id}, which its sources do not hold` };
        cited.add(identityOf(source));
      }
    }
  }
  const isAsked = (source: VisionSource): boolean => (source.type === "scope" ? source.side !== "out" : source.kind !== "internal-design");
  const asked = items.filter(isAsked);
  return { kind: "recorded", asked, uncovered: asked.filter((source) => !cited.has(identityOf(source))), notAsked: items.filter((source) => !isAsked(source)) };
}

const UNCOVERED_HEAD = "These items of what you asked for are named by no acceptance criterion";

/** Where the delivered report's coverage section departs from the records. */
function coverageProblems(body: string, coverage: CoverageOnRecord): string[] {
  if (coverage.kind === "unreadable") return [`the coverage records cannot be read, yet a delivered report was posted: ${coverage.detail}`];
  const listed = (paragraph(body, UNCOVERED_HEAD) ?? "").split("\n").filter((line) => line.startsWith("- "));
  const expectSentence = (sentence: string, what: string): string[] =>
    [
      ...(body.includes(sentence) ? [] : [`the records hold ${what}, but the delivered report does not say "${sentence}"`]),
      ...(listed.length === 0 ? [] : [`the records hold ${what}, but the delivered report lists ${listed.length} item(s) as not covered`]),
    ];
  if (coverage.kind === "unrecorded") return expectSentence("is not on record for this plan", "no traced acceptance lines");
  if (coverage.asked.length === 0) return expectSentence("holds no item of what you asked for", "no item the client asked for");
  if (coverage.uncovered.length === 0) return expectSentence("Every item of what you asked for is named", "every asked-for item cited");
  const problems: string[] = [];
  for (const source of coverage.uncovered) {
    if (!listed.some((line) => line.includes(source.text))) problems.push(`the delivered report does not list "${source.text}" (${source.id}) as named by no acceptance criterion`);
  }
  for (const source of coverage.notAsked) {
    if (listed.some((line) => line.includes(source.text))) problems.push(`the delivered report lists "${source.text}" (${source.id}), which the client did not ask for, as not covered`);
  }
  if (listed.length !== coverage.uncovered.length) problems.push(`the delivered report lists ${listed.length} item(s) as not covered; the records hold ${coverage.uncovered.length}`);
  return problems;
}
