import { sql } from "drizzle-orm";
import { z } from "zod";
import { parseStoredTaskSpec } from "@ashara/delivery";
import type { VisionSource } from "@ashara/engagement";
import { checkBurnWarnings } from "./client-report-burn.js";
import {
  guaranteesInForce,
  sweptAssumption,
  sweptContractForm,
  sweptGuarantee,
  sweptScopeLine,
} from "./client-report-core.js";
import type { GuaranteeInForce, ReportAdd, ReportViolation, ReportedItem } from "./client-report-core.js";
import { checkDeliveredReport } from "./client-report-delivered.js";
import { checkHaltReports } from "./client-report-halt.js";
import { checkReportedOnce } from "./client-report-once.js";
import { checkPlanningStoppedReports } from "./client-report-planning-stopped.js";
import { checkStopReport } from "./client-report-stop.js";
import type { Database } from "./database.js";

/**
 * I4, what the client is told, judged against the records it is told from: a halt
 * report states its episode's recorded kind and names the episode's record, a stop report names
 * exactly the merges recorded, and a delivered report names each goal's recorded close, exactly the
 * completed tasks no stored check covers and the goals given up. Every one of those terminal messages
 * carries the guarantee table of its own sweep: every guarantee in force once, each verdict as the
 * oracle judges it from the sweep's evidence, stored beside the message. Every expectation is read
 * from the rows; the report's text is only what is judged. The oracle states its own expected wording
 * and classification and imports none of Engagement's composers or the acceptance repository's
 * predicates (boundary-rules.toml [integration] `named-only` admits into src/simulator/ only
 * the symbols it lists, none of them a composer or predicate): an oracle that asks production what to
 * expect can never find production wrong.
 */

/**
 * An outbound report, with the latest vision version written before it: a table no sweep is on record for is judged on
 * that version.
 */
const reportRow = z.object({
  id: z.string(),
  body: z.string(),
  reportsOn: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  visionAtReport: z.number().nullable(),
});
const episodeRecord = z.object({
  id: z.string(),
  kind: z.string(),
  errorClass: z.string().nullable(),
  reason: z.string().nullable(),
  /** As stored; a value that does not parse as spendRecord is its own verdict (halt-spend-corrupt). */
  spend: z.unknown(),
  /** As stored; a value that does not parse as workRecord is its own verdict (halt-spend-corrupt). */
  work: z.unknown(),
  reportId: z.string().nullable(),
  resumedReportId: z.string().nullable(),
  ended: z.boolean(),
  /** The episode's terminal sweep, when it was recorded before the episode's report; null when none was. */
  sweepBeforeReport: z.string().nullable(),
});
/** One zone of the work ledger's early warning a project entered (work_burn_warnings), with its report's text. */
const burnWarningRow = z.object({
  planRevision: z.number(),
  zone: z.string(),
  drawnRequests: z.number(),
  budgetRequests: z.number(),
  reserveRequests: z.number(),
  upstreamRequests: z.number(),
  plannedTasks: z.number(),
  completedTasks: z.number(),
  reportId: z.string(),
  operatorReport: z.string().nullable(),
  /** Every model request the project has drawn by the end of the run: the ledger never gives one back. */
  ledgerRequests: z.number(),
});
const repairRow = z.object({
  episodeId: z.string(),
  workItemId: z.string(),
  title: z.string(),
  attempts: z.number(),
  blockedReason: z.unknown(),
});
const sweepRow = z.object({
  id: z.string(),
  passed: z.boolean(),
  uncheckedTasks: z.array(z.string()),
  reportId: z.string().nullable(),
  reportFailures: z.number(),
});
const revisionRow = z.object({ reportId: z.string() });
/**
 * A sweep a guarantee table is judged from: what it was run for, the commit it ran on (null when none), and the vision
 * version current then.
 */
const tableSweepRow = z.object({
  id: z.string(),
  blockId: z.string().nullable(),
  stopId: z.string().nullable(),
  mainCommit: z.string().nullable(),
  visionAtSweep: z.number().nullable(),
});
/** One guarantee's evidence on one sweep, as Quality recorded it. */
const evidenceRow = z.object({
  sweepId: z.string(),
  guaranteeId: z.string(),
  visionVersion: z.number(),
  checks: z.unknown(),
  reviewLowers: z.boolean(),
});
/** One verdict stored beside the message that carries it. */
const verdictRow = z.object({
  reportId: z.string(),
  sweepId: z.string().nullable(),
  visionVersion: z.number(),
  guaranteeId: z.string(),
  verdict: z.string(),
  reason: z.string().nullable(),
  basis: z.string(),
});
/** A vision version's fields the guarantees in force are read from, unparsed. */
const visionVersionRow = z.object({
  version: z.number(),
  contractForm: z.unknown(),
  guarantees: z.unknown(),
  inferences: z.unknown(),
  scopeBoundaries: z.unknown(),
});
/** A verdict a passed sweep's delivered report stores. */
const sweptVerdictRow = z.object({ sweepId: z.string(), guaranteeId: z.string(), verdict: z.string() });
const passedSweepRow = z.object({
  id: z.string(),
  version: z.number().nullable(),
  inferences: z.unknown(),
  scopeBoundaries: z.unknown(),
  contractForm: z.unknown(),
  guarantees: z.unknown(),
  reportBody: z.string().nullable(),
});
/**
 * Why a suite review left an item undecided, as the delivered report must say it: a finding that
 * did not act, its second review not agreeing (unsettled) or failing; or a clean
 * review whose claim a second review contradicted or never confirmed.
 */
const UNDECIDED_REASONS = ["review-failed", "clean-unconfirmed", "clean-contradicted", "unsettled"] as const;

/**
 * An undecided_items row's reason, joined with one claim tied to it (undecided_item_claims): the earlier in
 * UNDECIDED_REASONS of its judgement's reason and that claim's.
 */
const UNDECIDED_REASON_SQL = sql.raw(`CASE WHEN j.basis = 'second-review-failed' THEN 'review-failed'
              WHEN c.basis = 'second-opinion-found' THEN 'clean-contradicted'
              WHEN c.id IS NOT NULL THEN 'clean-unconfirmed'
              WHEN j.id IS NOT NULL THEN 'unsettled'
              ELSE 'clean-unconfirmed' END`);

/** Every claim tied to an undecided_items row u, as c, not only the first that kept it. */
const UNDECIDED_CLAIMS_SQL =
  sql.raw(`LEFT JOIN undecided_item_claims l ON l.check_task_id = u.check_task_id AND l.item_id = u.item_id
          LEFT JOIN suite_review_claims c ON c.id = l.claim_id`);

/**
 * A cited item a suite review left undecided (undecided_items): its id, the
 * text its check task cited it with, and why.
 */
const undecidedRow = z.object({ id: z.string(), text: z.string(), reason: z.enum(UNDECIDED_REASONS) });
const sweptUndecidedRow = undecidedRow.extend({ sweepId: z.string() });
/** One stored check, with the check task that wrote it and what it says it decides. */
const storedCheckRow = z.object({
  checkTaskId: z.string(),
  taskSpec: z.unknown(),
  name: z.string(),
  decides: z.unknown(),
});
type SweptCheck = z.infer<typeof storedCheckRow>;
/** One stored check a passed sweep ran, with the task it checks and the revision of that task's checks it ran. */
const sweptCheckRow = storedCheckRow.extend({ sweepId: z.string(), taskId: z.string(), revision: z.number().int() });
type RanCheck = Omit<z.infer<typeof sweptCheckRow>, "sweepId">;

export interface ReportRecords {
  /** Every outbound report of the project, in posting order. */
  readonly reports: ReadonlyArray<z.infer<typeof reportRow>>;
  readonly episodes: ReadonlyArray<z.infer<typeof episodeRecord>>;
  /** Every early-warning zone the project entered, in recording order. */
  readonly burnWarnings: ReadonlyArray<z.infer<typeof burnWarningRow>>;
  /** The given-up tasks each open plan_repair episode was blocked on (block-report.ts blockingAbandonments). */
  readonly repairs: ReadonlyArray<z.infer<typeof repairRow>>;
  readonly sweeps: ReadonlyArray<z.infer<typeof sweepRow>>;
  /** The reports the plan revisions record. */
  readonly revisionReports: readonly string[];
  /** Every sweep of the project, acceptance and terminal, a guarantee table may be judged from. */
  readonly tableSweeps: ReadonlyArray<z.infer<typeof tableSweepRow>>;
  /** Each stop's terminal sweep recorded at or before that stop's report: the sweep its table is judged from. */
  readonly stopSweepsBeforeReport: readonly string[];
  /** Every guarantee's evidence on every sweep. */
  readonly evidence: ReadonlyArray<z.infer<typeof evidenceRow>>;
  /** Every verdict stored beside a message. */
  readonly verdicts: ReadonlyArray<z.infer<typeof verdictRow>>;
  /** Every vision version. */
  readonly visions: ReadonlyArray<z.infer<typeof visionVersionRow>>;
  /**
   * Every passed acceptance sweep, in order, with the vision version current when it passed (its
   * fields unparsed; version null when none was) and every stored check it ran, with the check task
   * that wrote it: each goal task it checked, at its latest checks revision written before the sweep.
   */
  readonly passedSweeps: ReadonlyArray<
    z.infer<typeof passedSweepRow> & {
      readonly storedChecks: readonly RanCheck[];
      /** The items a suite review left undecided, before the sweep, on a check task whose checks it ran. */
      readonly undecided: ReadonlyArray<z.infer<typeof undecidedRow>>;
      /** The verdicts stored beside the sweep's delivered report; none before it is posted. */
      readonly reportVerdicts: ReadonlyArray<Omit<z.infer<typeof sweptVerdictRow>, "sweepId">>;
    }
  >;
}

export async function readReportRecords(db: Database, projectId: string): Promise<ReportRecords> {
  const rows = async <T>(schema: z.ZodType<T>, query: ReturnType<typeof sql>): Promise<T[]> =>
    z.array(schema).parse((await db.execute(query)).rows);
  return {
    reports: await rows(
      reportRow,
      sql`SELECT m.id, m.body, m.reports_on AS "reportsOn", m.in_reply_to AS "inReplyTo",
                 (SELECT max(d.version) FROM vision_documents d WHERE d.project_id = m.project_id
                   AND d.created_at <= m.created_at) AS "visionAtReport"
          FROM client_messages m
          WHERE m.project_id = ${projectId} AND m.direction = 'outbound' AND m.kind = 'report' ORDER BY m.created_at,
            m.id`,
    ),
    episodes: await rows(
      episodeRecord,
      sql`SELECT b.id, b.kind, b.error_class AS "errorClass", b.reason, b.spend, b.work, (SELECT t.report_id
             FROM told_reports t WHERE t.subject_kind = 'project-blocked' AND t.subject_id = b.id) AS "reportId",
                 (SELECT t.report_id FROM told_reports t WHERE t.subject_kind = 'project-resumed'
                   AND t.subject_id = b.id) AS "resumedReportId",
                 b.ended_at IS NOT NULL AS ended,
                 (SELECT s.id FROM acceptance_sweeps s JOIN client_messages m ON m.id = (SELECT t.report_id
                   FROM told_reports t WHERE t.subject_kind = 'project-blocked' AND t.subject_id = b.id)
                   WHERE s.block_id = b.id AND s.created_at <= m.created_at ORDER BY s.created_at, s.id
                     LIMIT 1) AS "sweepBeforeReport"
          FROM project_blocks b WHERE b.project_id = ${projectId} ORDER BY b.blocked_at, b.id`,
    ),
    burnWarnings: await rows(
      burnWarningRow,
      sql`SELECT plan_revision AS "planRevision", zone, drawn_requests AS "drawnRequests",
             budget_requests AS "budgetRequests",
                 reserve_requests AS "reserveRequests", upstream_requests AS "upstreamRequests",
                   planned_tasks AS "plannedTasks",
                 completed_tasks AS "completedTasks", report_id AS "reportId", operator_report AS "operatorReport",
                 (SELECT count(*)::int FROM llm_calls c WHERE c.project_id = w.project_id) AS "ledgerRequests"
          FROM work_burn_warnings w WHERE project_id = ${projectId} ORDER BY created_at, plan_revision, zone`,
    ),
    repairs: await rows(
      repairRow,
      sql`SELECT b.id AS "episodeId", w.id AS "workItemId", w.title, w.dispatch_count AS attempts,
             w.blocked_reason AS "blockedReason"
          FROM project_blocks b
          JOIN plan_repairs r ON r.project_id = b.project_id AND r.plan_revision_id IS NULL
            AND r.created_at <= b.blocked_at
          JOIN work_items w ON w.id = r.work_item_id
          WHERE b.project_id = ${projectId} AND b.kind = 'plan_repair' AND b.ended_at IS NULL
          ORDER BY r.created_at, r.work_item_id`,
    ),
    sweeps: await rows(
      sweepRow,
      sql`SELECT s.id, s.passed, s.unchecked_tasks AS "uncheckedTasks", (SELECT t.report_id FROM told_reports t
             WHERE t.subject_kind = 'delivered' AND t.subject_id = s.id) AS "reportId",
                 COALESCE((SELECT a.failures FROM delivered_report_attempts a WHERE a.sweep_id = s.id),
                   0) AS "reportFailures"
          FROM acceptance_sweeps s WHERE s.project_id = ${projectId} ORDER BY s.created_at, s.id`,
    ),
    revisionReports: (
      await rows(
        revisionRow,
        sql`SELECT t.report_id AS "reportId" FROM told_reports t WHERE t.project_id = ${projectId}
               AND t.subject_kind = 'plan-revision'`,
      )
    ).map((row) => row.reportId),
    tableSweeps: await rows(
      tableSweepRow,
      sql`SELECT s.id, s.block_id AS "blockId", s.stop_id AS "stopId", s.main_commit AS "mainCommit",
                 (SELECT max(d.version) FROM vision_documents d WHERE d.project_id = s.project_id
                   AND d.created_at <= s.created_at) AS "visionAtSweep"
          FROM acceptance_sweeps s WHERE s.project_id = ${projectId} ORDER BY s.created_at, s.id`,
    ),
    stopSweepsBeforeReport: (
      await rows(
        z.object({ id: z.string() }),
        sql`SELECT s.id FROM acceptance_sweeps s JOIN client_messages m ON m.in_reply_to = s.stop_id
               AND m.reports_on = 'client-stop'
            WHERE s.project_id = ${projectId} AND s.created_at <= m.created_at ORDER BY s.created_at, s.id`,
      )
    ).map((row) => row.id),
    evidence: await rows(
      evidenceRow,
      sql`SELECT sweep_id AS "sweepId", guarantee_id AS "guaranteeId", vision_version AS "visionVersion", checks,
             review_lowers AS "reviewLowers"
          FROM guarantee_evidence WHERE project_id = ${projectId} ORDER BY sweep_id, guarantee_id`,
    ),
    verdicts: await rows(
      verdictRow,
      sql`SELECT report_id AS "reportId", sweep_id AS "sweepId", vision_version AS "visionVersion",
             guarantee_id AS "guaranteeId", verdict, reason, basis
          FROM guarantee_verdicts WHERE project_id = ${projectId} ORDER BY report_id, guarantee_id`,
    ),
    visions: await rows(
      visionVersionRow,
      sql`SELECT version, contract_form AS "contractForm", guarantees, inferences, scope_boundaries AS "scopeBoundaries"
          FROM vision_documents WHERE project_id = ${projectId} ORDER BY version`,
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
    sql`SELECT s.id, v.version, v.inferences, v.scope_boundaries AS "scopeBoundaries",
           v.contract_form AS "contractForm", v.guarantees,
               (SELECT m.body FROM client_messages m WHERE m.id = (SELECT t.report_id FROM told_reports t
                 WHERE t.subject_kind = 'delivered' AND t.subject_id = s.id)) AS "reportBody"
        FROM acceptance_sweeps s
        LEFT JOIN LATERAL (SELECT version, inferences, scope_boundaries, contract_form, guarantees
          FROM vision_documents d
                           WHERE d.project_id = s.project_id AND d.created_at <= s.created_at ORDER BY d.version DESC
                             LIMIT 1) v ON true
        WHERE s.project_id = ${projectId} AND s.passed ORDER BY s.created_at, s.id`,
  );
  const checks = await rows(
    sweptCheckRow,
    sql`SELECT s.id AS "sweepId", a.id AS "checkTaskId", a.task_spec AS "taskSpec", c.name, c.decides,
           c.task_id AS "taskId", c.revision
        FROM acceptance_sweeps s
        CROSS JOIN LATERAL jsonb_array_elements_text(s.checked_tasks) AS t(task_id)
        JOIN task_checks c ON c.task_id::text = t.task_id
          AND c.revision = (SELECT max(l.revision) FROM task_checks l WHERE l.task_id = c.task_id
            AND l.created_at <= s.created_at)
        JOIN work_items a ON a.id = c.check_task_id
        WHERE s.project_id = ${projectId} AND s.passed
        ORDER BY s.id, a.id, c.name`,
  );
  const undecided = await rows(
    sweptUndecidedRow,
    sql`SELECT s.id AS "sweepId", u.item_id AS id, u.item_text AS text, ${UNDECIDED_REASON_SQL} AS reason
        FROM acceptance_sweeps s
        CROSS JOIN LATERAL jsonb_array_elements_text(s.checked_tasks) AS t(task_id)
        JOIN work_items a ON a.task_spec->>'checksFor' = t.task_id
        JOIN undecided_items u ON u.check_task_id = a.id AND u.created_at <= s.created_at
        LEFT JOIN suite_review_judgements j ON j.id = u.judgement_id
        ${UNDECIDED_CLAIMS_SQL}
        WHERE s.project_id = ${projectId} AND s.passed
        ORDER BY s.id, u.item_id`,
  );
  const verdicts = await rows(
    sweptVerdictRow,
    sql`SELECT s.id AS "sweepId", v.guarantee_id AS "guaranteeId", v.verdict
        FROM acceptance_sweeps s JOIN told_reports t ON t.subject_kind = 'delivered' AND t.subject_id = s.id
        JOIN guarantee_verdicts v ON v.report_id = t.report_id
        WHERE s.project_id = ${projectId} AND s.passed
        ORDER BY s.id, v.guarantee_id`,
  );
  return sweeps.map((sweep) => ({
    ...sweep,
    storedChecks: checks.filter((check) => check.sweepId === sweep.id).map(({ sweepId: _sweep, ...check }) => check),
    undecided: undecided
      .filter((item) => item.sweepId === sweep.id)
      .map(({ id, text, reason }) => ({ id, text, reason })),
    reportVerdicts: verdicts
      .filter((verdict) => verdict.sweepId === sweep.id)
      .map(({ guaranteeId, verdict }) => ({ guaranteeId, verdict })),
  }));
}

/**
 * I4 on one project's final records. `status` is the project's; `checkedTaskIds` the tasks with a
 * stored check set. Reported keys name the report and the record, never an id. Each report kind has
 * its own checker (client-report-<kind>.ts), run in this order, so the violations come in it too.
 */
export function checkReports(
  records: ReportRecords,
  project: { readonly status: string },
  items: readonly ReportedItem[],
  checkedTaskIds: ReadonlySet<string>,
): ReportViolation[] {
  const found: ReportViolation[] = [];
  const add: ReportAdd = (key, statement) => {
    found.push({ key, statement });
  };
  const byId = new Map(records.reports.map((report) => [report.id, report]));
  checkReportedOnce(records, add);
  checkBurnWarnings(records, byId, add);
  checkHaltReports(records, byId, add);
  checkPlanningStoppedReports(records, add);
  if (project.status === "stopped") checkStopReport(records, items, add);
  if (project.status === "accepted") checkDeliveredReport(records, byId, items, checkedTaskIds, add);
  return found;
}

/**
 * An item is the same across a plan's revisions only when its id and text both match (as the
 * delivered report compares them): a version written before guarantees reads a scope line or an
 * assumption as the guarantee of the same key and statement.
 */
function identityOf(source: Pick<VisionSource, "id" | "text">): string {
  return JSON.stringify([source.id, source.text]);
}

/**
 * The identities the stored checks decide: each id a check names in `decides`, read as its
 * check task cites it. Unrecorded when a check names none (a row from before checks recorded what they decide) or its
 * check task records no cited items; unreadable when a check names an id its check task does not
 * cite or its `decides` is no list of ids. Either way no stored fact says which items were checked.
 */
function decidedByStoredChecks(
  checks: readonly SweptCheck[],
):
  | { readonly kind: "decided"; readonly decided: ReadonlySet<string> }
  | { readonly kind: "unrecorded" | "unreadable"; readonly detail: string } {
  const decided = new Set<string>();
  for (const check of checks) {
    const decides = z.array(z.string().min(1)).min(1).nullable().safeParse(check.decides);
    if (!decides.success)
      return {
        kind: "unreadable",
        detail: `check "${check.name}" of check task ${check.checkTaskId} records decides that are no list of ids`,
      };
    if (decides.data === null)
      return {
        kind: "unrecorded",
        detail: `check "${check.name}" of check task ${check.checkTaskId} records no items it decides`,
      };
    const sources = parseStoredTaskSpec(check.taskSpec)?.sources;
    if (sources === undefined)
      return { kind: "unrecorded", detail: `check task ${check.checkTaskId} records no items it cites` };
    for (const id of decides.data) {
      const source = sources.find((each) => each.id === id);
      if (source === undefined)
        return {
          kind: "unreadable",
          detail:
            `check "${check.name}" of check task ${check.checkTaskId} decides ${id}, which its check task does ` +
            `not cite`,
        };
      decided.add(identityOf(source));
    }
  }
  return { kind: "decided", decided };
}

/** One finding of the guard, keyed by the item (or the record that could not be read). */
interface UncheckedFinding {
  readonly key: string;
  readonly statement: string;
}

/**
 * The evidence guard, judged on every passed acceptance sweep, whatever the project did
 * after it: every guarantee of the vision version in force when the sweep passed is decided, as that
 * version states it, by a stored check the sweep ran: one whose recorded `decides` names it. A line
 * citing it is no check of it. A guarantee is what a delivery is judged against, so accepting with
 * no check on it delivers it unverified. An assumption is never expected to be decided by a check: it
 * underpins guarantees, and the checks of those decide it. One finding per guarantee, keyed by its id,
 * at the first sweep that misses it.
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
  const form = sweptContractForm.safeParse(sweep.contractForm);
  const inferences = z.array(sweptAssumption).safeParse(sweep.inferences);
  const scope = z.array(sweptScopeLine).safeParse(sweep.scopeBoundaries);
  const guarantees = z.array(sweptGuarantee).safeParse(sweep.guarantees);
  if (!form.success || !inferences.success || !scope.success || !guarantees.success) {
    const error = form.error ?? inferences.error ?? scope.error ?? guarantees.error;
    return [
      {
        key: "vision-unreadable",
        statement:
          `vision v${sweep.version} at ${at} cannot be read as a contract form, keyed assumptions, scope lines ` +
          `and guarantees: ${error === undefined ? "" : z.prettifyError(error).slice(0, 200)}`,
      },
    ];
  }
  const swept = decidedByStoredChecks(sweep.storedChecks);
  if (swept.kind !== "decided")
    return [
      {
        key: "coverage-unreadable",
        statement: `which items the checks ${at} ran decide is not on record: ${swept.detail}`,
      },
    ];
  const inForce = guaranteesInForce(form.data, scope.data, guarantees.data, inferences.data);
  const findings = inForce.flatMap((g) =>
    swept.decided.has(identityOf(g))
      ? []
      : [{ key: g.id, statement: `${g.named} is decided by no stored check ${at} ran` }],
  );
  return [...findings, ...undecidedAtSweep(sweep, inForce, at)];
}

/**
 * A guarantee of the version in force that a suite review left undecided never reads pass in the
 * table of the sweep's delivered report, whatever a stored check records it decides: a review's doubt
 * holds a guarantee back and never lets it pass. TableVerdict per guarantee, keyed by its id.
 */
function undecidedAtSweep(
  sweep: ReportRecords["passedSweeps"][number],
  inForce: readonly GuaranteeInForce[],
  at: string,
): UncheckedFinding[] {
  if (sweep.reportBody === null) return [];
  const asked = new Set(inForce.map((g) => g.id));
  return sweep.undecided.flatMap((item) =>
    asked.has(item.id) &&
    sweep.reportVerdicts.some((verdict) => verdict.guaranteeId === item.id && verdict.verdict === "pass")
      ? [
          {
            key: `undecided-passed:${item.id}`,
            statement:
              `${item.id} ("${item.text.slice(0, 120)}"), left undecided by a suite review, reads pass in the ` +
              `delivered report of ${at}`,
          },
        ]
      : [],
  );
}

/**
 * One suite review a stand-in answered with a whole answer (scripted-models.ts): the review task,
 * the check revisions it read (`<task id>@<revision>`), the provider it answered as, whether its
 * prompt asked it to start from what each check cannot observe, and its problems as sent.
 */
export interface ObservedReview {
  readonly reviewTaskId: string;
  readonly checks: readonly string[];
  readonly provider: string;
  readonly blindSpots: boolean;
  readonly problems: readonly unknown[];
}

const observedProblem = z.looseObject({
  kind: z.string(),
  checkTasks: z.array(z.string()).optional(),
  item: z.string().optional(),
  judgedItems: z.array(z.string()).optional(),
  conflict: z
    .looseObject({ first: z.looseObject({ checkTask: z.string() }), second: z.looseObject({ checkTask: z.string() }) })
    .optional(),
});

/**
 * Whether a review's problem says anything about item `itemId` of check task `checkTaskId`: an
 * undecided item naming it, an outside-vision rejection on that check task judged against it, or a
 * contradiction one of whose sides is of that check task. A problem of no shape this reads names it.
 */
function namesItem(problem: unknown, checkTaskId: string, itemId: string): boolean {
  const parsed = observedProblem.safeParse(problem);
  if (!parsed.success) return true;
  const { kind, checkTasks, item, judgedItems, conflict } = parsed.data;
  const onTask = checkTasks?.includes(checkTaskId) === true;
  if (kind === "undecided-item") return onTask && item === itemId;
  if (kind === "outside-vision") return onTask && judgedItems?.includes(itemId) === true;
  if (kind === "contradiction")
    return onTask || conflict?.first.checkTask === checkTaskId || conflict?.second.checkTask === checkTaskId;
  return true;
}

/**
 * TableVerdict from the stand-ins' own answers, never production's claim record: an asked-for item a passed sweep's
 * checks decide and no undecided row names, so that its delivered report's table may read it pass, whose suite a
 * review read at the revision the sweep ran was confirmed by a second opinion. Some review round of
 * that revision holds a second opinion that says nothing about the item: an answer from a provider
 * other than the round's first answer's, or one asked to start from what each check cannot observe,
 * as a second opinion within the first's family is. A suite no review read is not judged here. One
 * finding per item, keyed by its id, at the first sweep that misses it.
 */
export function unconfirmedAtPassedSweeps(
  records: Pick<ReportRecords, "passedSweeps">,
  reviews: readonly ObservedReview[],
): UncheckedFinding[] {
  const found = new Map<string, string>();
  for (const [n, sweep] of records.passedSweeps.entries()) {
    if (sweep.reportBody === null) continue;
    const left = new Set(sweep.undecided.map((item) => JSON.stringify([item.id, item.text])));
    for (const check of sweep.storedChecks) {
      const decides = z.array(z.string()).safeParse(check.decides);
      const sources = parseStoredTaskSpec(check.taskSpec)?.sources;
      // An unreadable decides or trace is uncheckedAtPassedSweeps' finding.
      if (!decides.success || sources === undefined) continue;
      const revision = `${check.taskId}@${check.revision}`;
      const rounds = roundsOf(reviews.filter((review) => review.checks.includes(revision)));
      if (rounds.length === 0) continue;
      for (const id of decides.data) {
        const source = sources.find((each) => each.id === id);
        if (source === undefined || found.has(id) || left.has(JSON.stringify([source.id, source.text]))) continue;
        if (!askedFor(source)) continue;
        const confirmed = rounds.some((round) => {
          const first = round[0]?.provider;
          return round.some(
            (review) =>
              (review.provider !== first || review.blindSpots) &&
              !review.problems.some((problem) => namesItem(problem, check.checkTaskId, id)),
          );
        });
        if (!confirmed) {
          found.set(
            id,
            `${id} ("${source.text.slice(0, 120)}") is left held back by no review at passed sweep ${n + 1} ` +
              `(${sweep.id}), ` +
              `but no second opinion on check "${check.name}"'s suite found its checks clean on it`,
          );
        }
      }
    }
  }
  return [...found].map(([key, statement]) => ({ key, statement }));
}

/** The reviews of one review task over one set of check revisions, in the order they were answered. */
function roundsOf(reviews: readonly ObservedReview[]): ObservedReview[][] {
  const rounds = new Map<string, ObservedReview[]>();
  for (const review of reviews) {
    const key = JSON.stringify([review.reviewTaskId, review.checks]);
    const round = rounds.get(key);
    if (round === undefined) rounds.set(key, [review]);
    else round.push(review);
  }
  return [...rounds.values()];
}

/**
 * Whether an item is part of what the client asked for, which a check decides, worded apart from the
 * report it judges: a guarantee, or a scope line not out of scope. An assumption is decided through
 * what rests on it, never on its own.
 */
function askedFor(source: VisionSource): boolean {
  return source.type === "guarantee" || (source.type === "scope" && source.side !== "out");
}
