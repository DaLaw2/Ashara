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
 * completed tasks no stored check covers and the goals given up. Every one of those terminal messages
 * carries the guarantee table of its own sweep: every guarantee in force once, each verdict as the
 * oracle judges it from the sweep's evidence, stored beside the message. Every expectation is read
 * from the rows; the report's text is only what is judged. The oracle states its own expected wording
 * and classification and imports none of Engagement's composers or the acceptance repository's
 * predicates (boundary-rules.toml [integration] `named-only` admits into src/simulator/ only
 * the symbols it lists, none of them a composer or predicate): an oracle that asks production what to
 * expect can never find production wrong.
 */

/** An outbound report, with the latest vision version written before it: a table no sweep is on record for is judged on that version. */
const reportRow = z.object({ id: z.string(), body: z.string(), reportsOn: z.string().nullable(), inReplyTo: z.string().nullable(), visionAtReport: z.number().nullable() });
/** The amounts a budget_cap halt's cap was judged on, as project_blocks.spend holds them. */
const spendRecord = z.strictObject({
  capUsd: z.number(),
  spentUsd: z.number(),
  inFlightUsd: z.number(),
  nextCallUsd: z.number().nullable(),
});
/** The work ledger a work_budget halt recorded, as project_blocks.work holds it. */
const workRecord = z.strictObject({
  scope: z.enum(["task", "project"]),
  budgetRequests: z.number(),
  grantedRequests: z.number(),
  reserveRequests: z.number(),
  reserveProtected: z.boolean(),
  spentRequests: z.number(),
  inFlightRequests: z.number(),
  bySite: z.array(z.strictObject({ callSite: z.string(), requests: z.number() })),
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
const repairRow = z.object({ episodeId: z.string(), workItemId: z.string(), title: z.string(), attempts: z.number(), blockedReason: z.unknown() });
const sweepRow = z.object({ id: z.string(), passed: z.boolean(), uncheckedTasks: z.array(z.string()), reportId: z.string().nullable(), reportFailures: z.number() });
const revisionRow = z.object({ reportId: z.string() });
/** A sweep a guarantee table is judged from: what it was run for, the commit it ran on (null when none), and the vision version current then. */
const tableSweepRow = z.object({
  id: z.string(),
  blockId: z.string().nullable(),
  stopId: z.string().nullable(),
  mainCommit: z.string().nullable(),
  visionAtSweep: z.number().nullable(),
});
/** One guarantee's evidence on one sweep, as Quality recorded it. */
const evidenceRow = z.object({ sweepId: z.string(), guaranteeId: z.string(), visionVersion: z.number(), checks: z.unknown(), reviewLowers: z.boolean() });
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
const visionVersionRow = z.object({ version: z.number(), contractForm: z.unknown(), guarantees: z.unknown(), inferences: z.unknown(), scopeBoundaries: z.unknown() });
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
 * An undecided_items row's reason, joined with one claim tied to it (undecided_item_claims): the earlier in UNDECIDED_REASONS of its judgement's reason and that claim's.
 */
const UNDECIDED_REASON_SQL = sql.raw(`CASE WHEN j.basis = 'second-review-failed' THEN 'review-failed'
              WHEN c.basis = 'second-opinion-found' THEN 'clean-contradicted'
              WHEN c.id IS NOT NULL THEN 'clean-unconfirmed'
              WHEN j.id IS NOT NULL THEN 'unsettled'
              ELSE 'clean-unconfirmed' END`);

/** Every claim tied to an undecided_items row u, as c, not only the first that kept it. */
const UNDECIDED_CLAIMS_SQL = sql.raw(`LEFT JOIN undecided_item_claims l ON l.check_task_id = u.check_task_id AND l.item_id = u.item_id
          LEFT JOIN suite_review_claims c ON c.id = l.claim_id`);

/**
 * A cited item a suite review left undecided (undecided_items): its id, the
 * text its check task cited it with, and why.
 */
const undecidedRow = z.object({ id: z.string(), text: z.string(), reason: z.enum(UNDECIDED_REASONS) });
const sweptUndecidedRow = undecidedRow.extend({ sweepId: z.string() });
/** One stored check, with the check task that wrote it and what it says it decides. */
const storedCheckRow = z.object({ checkTaskId: z.string(), taskSpec: z.unknown(), name: z.string(), decides: z.unknown() });
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
  const rows = async <T>(schema: z.ZodType<T>, query: ReturnType<typeof sql>): Promise<T[]> => z.array(schema).parse((await db.execute(query)).rows);
  return {
    reports: await rows(
      reportRow,
      sql`SELECT m.id, m.body, m.reports_on AS "reportsOn", m.in_reply_to AS "inReplyTo",
                 (SELECT max(d.version) FROM vision_documents d WHERE d.project_id = m.project_id AND d.created_at <= m.created_at) AS "visionAtReport"
          FROM client_messages m
          WHERE m.project_id = ${projectId} AND m.direction = 'outbound' AND m.kind = 'report' ORDER BY m.created_at, m.id`,
    ),
    episodes: await rows(
      episodeRecord,
      sql`SELECT b.id, b.kind, b.error_class AS "errorClass", b.reason, b.spend, b.work, b.report_id AS "reportId", b.resumed_report_id AS "resumedReportId",
                 b.ended_at IS NOT NULL AS ended,
                 (SELECT s.id FROM acceptance_sweeps s JOIN client_messages m ON m.id = b.report_id
                   WHERE s.block_id = b.id AND s.created_at <= m.created_at ORDER BY s.created_at, s.id LIMIT 1) AS "sweepBeforeReport"
          FROM project_blocks b WHERE b.project_id = ${projectId} ORDER BY b.blocked_at, b.id`,
    ),
    burnWarnings: await rows(
      burnWarningRow,
      sql`SELECT plan_revision AS "planRevision", zone, drawn_requests AS "drawnRequests", budget_requests AS "budgetRequests",
                 reserve_requests AS "reserveRequests", upstream_requests AS "upstreamRequests", planned_tasks AS "plannedTasks",
                 completed_tasks AS "completedTasks", report_id AS "reportId", operator_report AS "operatorReport",
                 (SELECT count(*)::int FROM llm_calls c WHERE c.project_id = w.project_id) AS "ledgerRequests"
          FROM work_burn_warnings w WHERE project_id = ${projectId} ORDER BY created_at, plan_revision, zone`,
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
    tableSweeps: await rows(
      tableSweepRow,
      sql`SELECT s.id, s.block_id AS "blockId", s.stop_id AS "stopId", s.main_commit AS "mainCommit",
                 (SELECT max(d.version) FROM vision_documents d WHERE d.project_id = s.project_id AND d.created_at <= s.created_at) AS "visionAtSweep"
          FROM acceptance_sweeps s WHERE s.project_id = ${projectId} ORDER BY s.created_at, s.id`,
    ),
    evidence: await rows(
      evidenceRow,
      sql`SELECT sweep_id AS "sweepId", guarantee_id AS "guaranteeId", vision_version AS "visionVersion", checks, review_lowers AS "reviewLowers"
          FROM guarantee_evidence WHERE project_id = ${projectId} ORDER BY sweep_id, guarantee_id`,
    ),
    verdicts: await rows(
      verdictRow,
      sql`SELECT report_id AS "reportId", sweep_id AS "sweepId", vision_version AS "visionVersion", guarantee_id AS "guaranteeId", verdict, reason, basis
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
    sql`SELECT s.id, v.version, v.inferences, v.scope_boundaries AS "scopeBoundaries", v.contract_form AS "contractForm", v.guarantees,
               (SELECT m.body FROM client_messages m WHERE m.id = s.report_id) AS "reportBody"
        FROM acceptance_sweeps s
        LEFT JOIN LATERAL (SELECT version, inferences, scope_boundaries, contract_form, guarantees FROM vision_documents d
                           WHERE d.project_id = s.project_id AND d.created_at <= s.created_at ORDER BY d.version DESC LIMIT 1) v ON true
        WHERE s.project_id = ${projectId} AND s.passed ORDER BY s.created_at, s.id`,
  );
  const checks = await rows(
    sweptCheckRow,
    sql`SELECT s.id AS "sweepId", a.id AS "checkTaskId", a.task_spec AS "taskSpec", c.name, c.decides, c.task_id AS "taskId", c.revision
        FROM acceptance_sweeps s
        CROSS JOIN LATERAL jsonb_array_elements_text(s.checked_tasks) AS t(task_id)
        JOIN task_checks c ON c.task_id::text = t.task_id
          AND c.revision = (SELECT max(l.revision) FROM task_checks l WHERE l.task_id = c.task_id AND l.created_at <= s.created_at)
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
        FROM acceptance_sweeps s JOIN guarantee_verdicts v ON v.report_id = s.report_id
        WHERE s.project_id = ${projectId} AND s.passed
        ORDER BY s.id, v.guarantee_id`,
  );
  return sweeps.map((sweep) => ({
    ...sweep,
    storedChecks: checks.filter((check) => check.sweepId === sweep.id).map(({ sweepId: _sweep, ...check }) => check),
    undecided: undecided.filter((item) => item.sweepId === sweep.id).map(({ id, text, reason }) => ({ id, text, reason })),
    reportVerdicts: verdicts.filter((verdict) => verdict.sweepId === sweep.id).map(({ guaranteeId, verdict }) => ({ guaranteeId, verdict })),
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
 * `retired`: check_dispute and suite_review are kinds no code path writes (shared
 * work-item-row.ts ProjectBlockCategory), and a run database starts
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
  work_budget: "stated",
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
  "work_budget",
];

function judgementOf(kind: string): TableVerdict[keyof TableVerdict] | "unknown" {
  // eslint-disable-next-line no-restricted-syntax -- policy default: a typed Unknown, which the halt check reports as halt-kind-unknown
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
    case "work_budget_spent":
      return "it used every model request the budget of one task allows";
    case "context_window_exceeded":
    case "no_wider_model":
      return "the work it was given was more than any model available to the team can hold in view at once";
    case "crash_loop":
      return "Ashara's own process stopped while working on it, each time it was tried";
    case "owner_unresolved":
      return "no member of the team is assigned to do it";
    case "dependency_unsatisfiable":
      return "it depends on work that can never be finished";
    case "acceptance_failed":
      return reason.mainCommit === null
        ? "the final check of the whole project could not read the project's main line"
        : "the final check of the whole project did not pass on the project's main line";
    case "correction_pending":
      return "the client's correction changed what it rests on, and a revision of the plan replaces it";
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
    case "work_budget":
      return "the budget of model requests set for this project was used up, so the next step of the work was not sent";
  }
}

function requestCount(count: number): string {
  return `${count} model request${count === 1 ? "" : "s"}`;
}

/** The figures a work_budget halt's report must state, from its episode's work ledger, or that they are not on record. */
function expectedWorkWords(work: z.infer<typeof workRecord> | null): string {
  if (work === null) return "How many model requests had been drawn against that budget, and by which steps of the work, is not on record.";
  const granted = work.grantedRequests > 0 ? `, ${requestCount(work.grantedRequests)} of it granted by the operator` : "";
  const reserve = work.reserveRequests > 0 ? ` ${requestCount(work.reserveRequests)} of the budget are set aside for checking and accepting the finished work.` : "";
  const sites = work.bySite.length === 0 ? "none is on record" : work.bySite.map((site) => `"${site.callSite}" ${site.requests}`).join(", ");
  return (
    `When it stopped the work, ${requestCount(work.spentRequests)} had been sent and ${work.inFlightRequests} more were under way, ` +
    `against a budget of ${requestCount(work.budgetRequests)}${granted}.${reserve} The requests drawn, by the step of the work that drew them: ${sites}.`
  );
}

/**
 * The sentences a burn warning's report must carry, from its recorded figures, written here: what was
 * sent of what the project's work may use, the reserve when there is one, and what of the plan is done.
 */
function expectedBurnFigures(warning: z.infer<typeof burnWarningRow>): string {
  const reserve =
    warning.reserveRequests > 0
      ? ` A further ${requestCount(warning.reserveRequests)} of its budget are set aside for checking and accepting the finished work, and only that checking may use them.`
      : "";
  const done =
    warning.plannedTasks === 0
      ? "No building task of the current plan is planned yet, so none of it is finished."
      : `${warning.completedTasks} of the ${warning.plannedTasks} building tasks of the current plan are finished.`;
  return `So far ${requestCount(warning.drawnRequests)} have been sent, of the ${requestCount(warning.upstreamRequests)} this project's work may use before it pauses.${reserve} ${done}`;
}

/**
 * Whether a warning's recorded figures put it in its zone (the policy
 * defaults restated here): yellow at 50 percent of what upstream work may draw with at most 25
 * percent of the planned tasks done, red at 80 percent with the plan not finished, none planned
 * counting as none done.
 */
function zoneHolds(warning: z.infer<typeof burnWarningRow>): boolean {
  const drawn = warning.drawnRequests * 100;
  if (warning.zone === "red") return drawn >= 80 * warning.upstreamRequests && (warning.plannedTasks === 0 || warning.completedTasks < warning.plannedTasks);
  if (warning.zone === "yellow") return drawn >= 50 * warning.upstreamRequests && warning.completedTasks * 100 <= 25 * warning.plannedTasks;
  return false;
}

/**
 * Each burn warning against its own record: its zone held on the figures it recorded, its figures
 * add up and never claim more requests than the ledger holds, its report states them, a red one told
 * the operator the same figures, and no zone was told twice in a revision nor yellow after red.
 */
function checkBurnWarnings(records: ReportRecords, byId: ReadonlyMap<string, z.infer<typeof reportRow>>, add: (key: string, statement: string) => void): void {
  const told = new Set<string>();
  for (const warning of records.burnWarnings) {
    const at = `${warning.zone} warning of plan revision ${warning.planRevision}`;
    if (told.has(`${warning.planRevision}:${warning.zone}`) || (warning.zone === "yellow" && told.has(`${warning.planRevision}:red`))) {
      add("burn-warning-repeated", `the ${at} was told after the same or a higher zone of that revision`);
    }
    told.add(`${warning.planRevision}:${warning.zone}`);
    if (!zoneHolds(warning)) add("burn-warning-zone", `the ${at} records ${warning.drawnRequests} of ${warning.upstreamRequests} requests drawn and ${warning.completedTasks} of ${warning.plannedTasks} tasks done, outside its zone`);
    if (warning.upstreamRequests !== warning.budgetRequests - warning.reserveRequests || warning.drawnRequests > warning.ledgerRequests) {
      add("burn-warning-figures", `the ${at} records ${warning.drawnRequests} drawn of a budget ${warning.budgetRequests} less reserve ${warning.reserveRequests} = ${warning.upstreamRequests}; the ledger holds ${warning.ledgerRequests}`);
    }
    const report = byId.get(warning.reportId);
    const figures = expectedBurnFigures(warning);
    if (report === undefined || !report.body.includes(figures)) {
      add("burn-warning", `the ${at}'s report does not state "${figures.slice(0, 200)}"; it reads "${report?.body.slice(0, 200) ?? "no report"}"`);
    }
    const operatorFigures = `has drawn ${warning.drawnRequests} of the ${warning.upstreamRequests} model requests its upstream work may draw`;
    if ((warning.zone === "red") !== (warning.operatorReport?.includes(operatorFigures) === true)) {
      add("burn-warning-operator", `the ${at} ${warning.zone === "red" ? "did not tell" : "told"} the operator "${operatorFigures}"`);
    }
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
  episode: { readonly id: string; readonly errorClass: string | null; readonly reason: string | null; readonly spend: unknown; readonly work: unknown },
  kind: StatedKind,
): string | null {
  if (episode.reason === null && episode.errorClass === null) return "No cause was recorded for this pause.";
  let amounts = "";
  let words = expectedKindWords(kind, episode.errorClass);
  if (kind === "budget_cap") {
    const spend = z.union([z.null(), spendRecord]).safeParse(episode.spend ?? null);
    if (!spend.success) return null;
    amounts = `${expectedSpendWords(spend.data)} `;
  }
  if (kind === "work_budget") {
    const work = z.union([z.null(), workRecord]).safeParse(episode.work ?? null);
    if (!work.success) return null;
    amounts = `${expectedWorkWords(work.data)} `;
    // A refusal that kept the verification reserve says the reserve is kept.
    if (work.data?.reserveProtected === true) {
      words =
        "the budget of model requests set for this project was used up except for the share set aside for checking and accepting the " +
        "finished work, which is kept for that, so the next step of the work, which was not that checking, was not sent";
    }
  }
  return (
    `Ashara recorded the cause as this: ${words}. ` +
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
    ...records.burnWarnings.map((warning) => warning.reportId),
  ].filter((id): id is string => id !== null);
  for (const report of records.reports) {
    if (recorded.includes(report.id) || report.reportsOn !== null || report.inReplyTo !== null) continue;
    add("unrecorded-report", `a report was sent that no record was posted on (a second report of something already reported): "${report.body.slice(0, 80)}..."`);
  }

  checkBurnWarnings(records, byId, add);

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
        add(`halt-spend-corrupt:${kind}`, `the ${kind} halt records a spend or work ledger that does not parse, so no report can be judged against it`);
      } else if (!report.body.includes(stated)) {
        add(`halt-cause:${kind}`, `the ${kind} halt report does not state the recorded cause as "${stated.slice(0, 200)}"; it reads "${report.body.slice(0, 200)}"`);
      }
    } else if (judgement === "retired") {
      add(`halt-kind-retired:${kind}`, `a ${kind} halt was written, a kind no code path writes`);
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
    // The halt's terminal sweep, when it was on record before the report; a halt told before it was
    // judges every guarantee on no sweep, as the version in force when it was told states them.
    const sweep = records.tableSweeps.find((each) => each.id === episode.sweepBeforeReport);
    for (const problem of tableProblems(records, report, sweep === undefined ? unsweptSource(report) : sweptSource(sweep))) {
      add(`guarantee-table:halt:${kind}`, `the ${kind} halt report: ${problem}`);
    }
  }

  // The report of a first planning that stopped is that halt's report: nothing was built and no
  // sweep is on record for it, so it carries every guarantee unjudged on no sweep.
  for (const report of records.reports.filter((each) => each.reportsOn === "planning-stopped")) {
    for (const problem of tableProblems(records, report, unsweptSource(report))) add("guarantee-table:planning-stopped", `the planning-stopped report: ${problem}`);
  }

  // The stop report names exactly the merges recorded.
  if (project.status === "stopped") {
    const stops = records.reports.filter((report) => report.reportsOn === "client-stop");
    if (stops.length !== 1) add("stop-reports", `the project is stopped with ${stops.length} stop report(s)`);
    const [stop] = stops;
    if (stop !== undefined) {
      const merges = items.flatMap((item) => (item.level === "Task" && item.mergeCommit !== null ? [{ title: item.title, mergeCommit: item.mergeCommit }] : []));
      // eslint-disable-next-line no-restricted-syntax -- policy default: an absent paragraph names no merge, so each merged task below is reported as stop-merges
      const lines = namedLines(paragraph(stop.body, "What is on main") ?? "");
      for (const item of merges) {
        if (!lines.some((line) => line.startsWith(`- "${item.title}"`) && line.includes(item.mergeCommit))) {
          add("stop-merges", `the stop report does not name "${item.title}" merged as ${item.mergeCommit}`);
        }
      }
      if (lines.length !== merges.length) add("stop-merges", `the stop report names ${lines.length} merge(s); the records hold ${merges.length}`);
      const sweep = records.tableSweeps.find((each) => each.stopId !== null && each.stopId === stop.inReplyTo);
      if (sweep === undefined) add("guarantee-table:stop", "the stop report was posted with no terminal sweep on record for its stop, so its table was judged on nothing");
      for (const problem of sweep === undefined ? [] : tableProblems(records, stop, sweptSource(sweep))) add("guarantee-table:stop", `the stop report: ${problem}`);
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
      // The notice is the project's terminal message in the report's place, so it carries the sweep's table.
      const tableSweep = records.tableSweeps.find((each) => each.id === sweep.id);
      if (tableSweep === undefined) add("guarantee-table:delivered", `the acceptance notice's sweep ${sweep.id} is not among the project's sweeps`);
      for (const problem of tableSweep === undefined || report === undefined ? [] : tableProblems(records, report, sweptSource(tableSweep))) {
        add("guarantee-table:delivered", `the acceptance notice: ${problem}`);
      }
    } else if (report !== undefined && sweep !== undefined) {
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
      const swept = new Set(sweep.uncheckedTasks);
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

      const tableSweep = records.tableSweeps.find((each) => each.id === sweep.id);
      if (tableSweep === undefined) add("guarantee-table:delivered", `the delivered report's sweep ${sweep.id} is not among the project's sweeps`);
      for (const problem of tableSweep === undefined ? [] : tableProblems(records, report, sweptSource(tableSweep))) add("guarantee-table:delivered", `the delivered report: ${problem}`);
    }
  }
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
/** A guarantee as stored: its key and its statement, what a plan cites it by, and what would show it broken. */
const sweptGuarantee = z.looseObject({
  id: z.string().min(1),
  statement: z.string().min(1),
  observable: z.looseObject({ observation: z.string() }).optional(),
  refutedBy: z.array(z.string()).optional(),
});

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

/** One guarantee of the version in force: its id, its statement, how a finding names it, and what a check of it can show. */
interface GuaranteeInForce {
  readonly id: string;
  readonly text: string;
  readonly named: string;
  /** Whether it names an observation that would show it broken: only such a guarantee can be decided by a check. */
  readonly checkable: boolean;
  /** Whether it is about stored data, which no check can show surviving a fault while no fault set is run. */
  readonly storedData: boolean;
}

const sweptContractForm = z.enum(["scope-lines", "guarantees"]);

/**
 * The guarantees of a version as the Vision reads them: a guarantees-form version's own; a version
 * written before guarantees were holds each scope line not out of scope, keyed by its place, and each
 * assumption not recorded as internal design, under its own key, as a guarantee.
 */
function guaranteesInForce(
  form: z.infer<typeof sweptContractForm>,
  scope: ReadonlyArray<z.infer<typeof sweptScopeLine>>,
  guarantees: ReadonlyArray<z.infer<typeof sweptGuarantee>>,
  inferences: ReadonlyArray<z.infer<typeof sweptAssumption>>,
): GuaranteeInForce[] {
  if (form === "guarantees") {
    return guarantees.map((g) => {
      const observation = g.observable?.observation;
      return {
        id: g.id,
        text: g.statement,
        named: `guarantee ${g.id} ("${g.statement.slice(0, 120)}")`,
        // eslint-disable-next-line no-restricted-syntax -- policy default: a guarantee that records nothing refuting it is not checkable, the fail-closed reading
        checkable: observation !== undefined && observation !== "unclassified" && (g.refutedBy ?? []).length > 0,
        storedData: observation === "stored-data",
      };
    });
  }
  return [
    ...scope.flatMap((line, i) => {
      const id = `S${i + 1}`;
      const { text, side } = typeof line === "string" ? { text: line, side: "of no recorded side" } : line;
      return side === "out" ? [] : [{ id, text, named: `scope line ${id} ("${text.slice(0, 120)}"), ${side === "in" ? "in scope" : side}, read as a guarantee`, checkable: false, storedData: false }];
    }),
    ...inferences.flatMap((record, i) => {
      const id = record.key ?? `A${i + 1}`;
      if (record.kind === "internal-design") return [];
      return [{ id, text: record.statement, named: `assumption ${id} ("${record.statement.slice(0, 120)}"), ${record.kind ?? "of no recorded kind"}, read as a guarantee`, checkable: false, storedData: false }];
    }),
  ];
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
        statement: `vision v${sweep.version} at ${at} cannot be read as a contract form, keyed assumptions, scope lines and guarantees: ${error === undefined ? "" : z.prettifyError(error).slice(0, 200)}`,
      },
    ];
  }
  const swept = decidedByStoredChecks(sweep.storedChecks);
  if (swept.kind !== "decided") return [{ key: "coverage-unreadable", statement: `which items the checks ${at} ran decide is not on record: ${swept.detail}` }];
  const inForce = guaranteesInForce(form.data, scope.data, guarantees.data, inferences.data);
  const findings = inForce.flatMap((g) => (swept.decided.has(identityOf(g)) ? [] : [{ key: g.id, statement: `${g.named} is decided by no stored check ${at} ran` }]));
  return [...findings, ...undecidedAtSweep(sweep, inForce, at)];
}

/**
 * A guarantee of the version in force that a suite review left undecided never reads pass in the
 * table of the sweep's delivered report, whatever a stored check records it decides: a review's doubt
 * holds a guarantee back and never lets it pass. TableVerdict per guarantee, keyed by its id.
 */
function undecidedAtSweep(sweep: ReportRecords["passedSweeps"][number], inForce: readonly GuaranteeInForce[], at: string): UncheckedFinding[] {
  if (sweep.reportBody === null) return [];
  const asked = new Set(inForce.map((g) => g.id));
  return sweep.undecided.flatMap((item) =>
    asked.has(item.id) && sweep.reportVerdicts.some((verdict) => verdict.guaranteeId === item.id && verdict.verdict === "pass")
      ? [{ key: `undecided-passed:${item.id}`, statement: `${item.id} ("${item.text.slice(0, 120)}"), left undecided by a suite review, reads pass in the delivered report of ${at}` }]
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
  conflict: z.looseObject({ first: z.looseObject({ checkTask: z.string() }), second: z.looseObject({ checkTask: z.string() }) }).optional(),
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
  if (kind === "contradiction") return onTask || conflict?.first.checkTask === checkTaskId || conflict?.second.checkTask === checkTaskId;
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
export function unconfirmedAtPassedSweeps(records: Pick<ReportRecords, "passedSweeps">, reviews: readonly ObservedReview[]): UncheckedFinding[] {
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
          return round.some((review) => (review.provider !== first || review.blindSpots) && !review.problems.some((problem) => namesItem(problem, check.checkTaskId, id)));
        });
        if (!confirmed) {
          found.set(
            id,
            `${id} ("${source.text.slice(0, 120)}") is left held back by no review at passed sweep ${n + 1} (${sweep.id}), ` +
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

/** A check's evidence on a guarantee as guarantee_evidence records it: how it ended and what kind of evidence it is. */
const checkEvidence = z.array(z.looseObject({ outcome: z.string(), class: z.string() }));

/** A verdict as the oracle judges it: unjudged with why, else no reason. */
interface TableVerdict {
  readonly verdict: "pass" | "fail" | "unjudged";
  readonly reason: string | null;
}

const unjudged = (reason: string): TableVerdict => ({ verdict: "unjudged", reason });

/**
 * One guarantee's verdict from its evidence on the sweep, restated here by the rules the table
 * promises the client: nothing is judged off a commit; an executed check that failed fails it; one
 * that names nothing refuting it, or is about stored data (no fault set is run), no check decides;
 * it passes only on an executed check that passed, and any review's doubt holds it back.
 */
function judged(guarantee: GuaranteeInForce, evidence: { readonly checks: z.infer<typeof checkEvidence>; readonly reviewLowers: boolean }, onCommit: boolean): TableVerdict {
  if (!onCommit) return unjudged("no-sweep-on-commit");
  const executed = evidence.checks.filter((check) => check.class === "witness" || check.class === "implementer-visible");
  if (executed.some((check) => check.outcome === "failed")) return { verdict: "fail", reason: null };
  if (!guarantee.checkable) return unjudged("not-checkable-as-written");
  if (guarantee.storedData) return unjudged("stored-data-unjudged");
  const reviews = evidence.checks.filter((check) => check.class === "review-only");
  if (!executed.some((check) => check.outcome === "passed")) return unjudged(reviews.length > 0 ? "review-only" : "no-executed-evidence");
  if (evidence.reviewLowers || reviews.some((check) => check.outcome === "failed")) return unjudged("lowered-by-review");
  return { verdict: "pass", reason: null };
}

/** The guarantees in force at a vision version, or why the version cannot be read as a contract. */
function inForceAt(vision: z.infer<typeof visionVersionRow>): GuaranteeInForce[] | string {
  const form = sweptContractForm.safeParse(vision.contractForm);
  const inferences = z.array(sweptAssumption).safeParse(vision.inferences);
  const scope = z.array(sweptScopeLine).safeParse(vision.scopeBoundaries);
  const guarantees = z.array(sweptGuarantee).safeParse(vision.guarantees);
  if (!form.success || !inferences.success || !scope.success || !guarantees.success) {
    const error = form.error ?? inferences.error ?? scope.error ?? guarantees.error;
    return `vision v${vision.version} cannot be read as a contract: ${error === undefined ? "" : z.prettifyError(error).slice(0, 200)}`;
  }
  return guaranteesInForce(form.data, scope.data, guarantees.data, inferences.data);
}

const TABLE_ON_COMMIT = "Each guarantee of your contract (vision v";
const TABLE_OFF_COMMIT = "No check could run on a commit of main for this report";
const PUNCH_HEAD = "The punch list";
const TABLE_UNREADABLE = "Ashara's records of this project's guarantees";

/** The ids at the head of a paragraph's `- <id>: ` lines, in order. */
function idsListed(part: string | null): string[] {
  return part === null ? [] : part.split("\n").flatMap((line) => {
    const id = /^- ([A-Za-z]+\d+): /.exec(line)?.[1];
    return id === undefined ? [] : [id];
  });
}

/** What a table is judged from: its sweep, or none on record for the message, with the vision version current then. */
interface TableSource {
  readonly sweepId: string | null;
  readonly mainCommit: string | null;
  readonly visionVersion: number | null;
}

function sweptSource(sweep: z.infer<typeof tableSweepRow>): TableSource {
  return { sweepId: sweep.id, mainCommit: sweep.mainCommit, visionVersion: sweep.visionAtSweep };
}

function unsweptSource(report: z.infer<typeof reportRow>): TableSource {
  return { sweepId: null, mainCommit: null, visionVersion: report.visionAtReport };
}

/**
 * Where a terminal message's guarantee table departs from its records: the verdicts stored beside it
 * name its sweep (none, for a message no sweep is on record for) and every guarantee in force once,
 * each as `judged` reads its evidence; the table lists every guarantee once, in the version's order,
 * with that verdict; and the punch list names every failure, then every unjudged guarantee, then
 * every pass stored as resting on an assumption the client has not confirmed. No vision then is no
 * contract, said so. A message may say its records do not hold together as a table only when the
 * oracle finds them so too, and then stores no verdict.
 */
function tableProblems(records: Pick<ReportRecords, "evidence" | "verdicts" | "visions">, report: z.infer<typeof reportRow>, source: TableSource): string[] {
  const stored = records.verdicts.filter((verdict) => verdict.reportId === report.id);
  const evidence = source.sweepId === null ? [] : records.evidence.filter((each) => each.sweepId === source.sweepId);
  const at = source.sweepId === null ? "" : ` at sweep ${source.sweepId}`;
  const saysUnreadable = paragraph(report.body, `${TABLE_UNREADABLE}${at} do not hold together`) !== null;
  const broken: string[] = [];
  const versions = [...new Set(evidence.map((each) => each.visionVersion))];
  if (versions.length > 1) broken.push(`its evidence${at} names vision versions ${versions.join(", ")}; one table cannot be judged from it`);
  const version = versions[0] ?? source.visionVersion;
  if (version === null) {
    const noContract = `No contract is on record for this project${at}, so no guarantee is judged.`;
    return [
      ...(stored.length === 0 ? [] : [`it stores ${stored.length} verdict(s) though no vision is on record${at}`]),
      ...(report.body.includes(noContract) ? [] : [`no vision is on record${at}, but it does not say "${noContract}"`]),
    ];
  }
  const vision = records.visions.find((each) => each.version === version);
  if (vision === undefined) broken.push(`its table${at} is judged against vision v${version}, which is not on record`);
  const inForce = vision === undefined ? null : inForceAt(vision);
  if (typeof inForce === "string") broken.push(inForce);
  const ids = Array.isArray(inForce) ? inForce.map((g) => g.id) : [];
  const recorded = evidence.map((each) => each.guaranteeId);
  if (Array.isArray(inForce) && evidence.length > 0 && JSON.stringify([...recorded].sort()) !== JSON.stringify([...ids].sort())) {
    broken.push(`its evidence${at} names [${recorded.join(", ")}]; vision v${version} holds [${ids.join(", ")}]`);
  }
  const unparsed = evidence.filter((each) => !checkEvidence.safeParse(each.checks).success).map((each) => each.guaranteeId);
  if (unparsed.length > 0) broken.push(`the evidence of ${unparsed.join(", ")}${at} does not read as checks`);
  if (saysUnreadable) {
    return [
      ...(broken.length > 0 ? [] : [`it says its records do not hold together as a table, though they read as one at vision v${version}`]),
      ...(stored.length === 0 ? [] : [`it stores ${stored.length} verdict(s) though it says its records do not hold together`]),
    ];
  }
  if (!Array.isArray(inForce)) return broken;
  const problems: string[] = [...broken];
  const onCommit = source.mainCommit !== null;
  const expected = inForce.map((guarantee) => {
    const seen = evidence.find((each) => each.guaranteeId === guarantee.id);
    // A sweep recorded before evidence per guarantee, or no sweep, judges every guarantee on none, as
    // its table says; a sweep that records some and misses this one is named above.
    if (seen === undefined) return { guarantee, ...judged(guarantee, { checks: [], reviewLowers: false }, onCommit) };
    const checks = checkEvidence.safeParse(seen.checks);
    return { guarantee, ...judged(guarantee, { checks: checks.success ? checks.data : [], reviewLowers: seen.reviewLowers }, onCommit) };
  });

  for (const { guarantee, verdict, reason } of expected) {
    const rows = stored.filter((row) => row.guaranteeId === guarantee.id);
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) {
      problems.push(`it stores ${rows.length} verdict(s) for ${guarantee.id}; every guarantee in force has exactly one`);
      continue;
    }
    if (row.sweepId !== source.sweepId || row.visionVersion !== version) {
      problems.push(`its verdict on ${guarantee.id} names sweep ${row.sweepId ?? "none"} at vision v${row.visionVersion}; it was judged on sweep ${source.sweepId ?? "none"} at v${version}`);
    }
    if (row.verdict !== verdict || row.reason !== reason) problems.push(`it stores ${guarantee.id} as ${row.verdict}${row.reason === null ? "" : ` (${row.reason})`}; its evidence reads ${verdict}${reason === null ? "" : ` (${reason})`}`);
  }
  const strays = stored.filter((row) => !ids.includes(row.guaranteeId));
  if (strays.length > 0) problems.push(`it stores verdicts for ${strays.map((row) => row.guaranteeId).join(", ")}, which vision v${version} does not hold`);

  const head =
    source.sweepId === null
      ? `${TABLE_OFF_COMMIT}: no sweep of main is on record for it, so each guarantee of your contract (vision v${version}) is unjudged.`
      : source.mainCommit === null
        ? `${TABLE_OFF_COMMIT}; why is in Ashara's record of that attempt, sweep ${source.sweepId}.`
        : `${TABLE_ON_COMMIT}${version}) is judged on main at commit ${source.mainCommit}, sweep ${source.sweepId}.`;
  const table = paragraph(report.body, head);
  if (table === null) return [...problems, `it carries no guarantee table opening "${head.slice(0, 120)}"`];
  const lines = table.split("\n").filter((line) => line.startsWith("- "));
  if (JSON.stringify(idsListed(table)) !== JSON.stringify(ids)) problems.push(`its table lists [${idsListed(table).join(", ")}]; vision v${version} holds [${ids.join(", ")}], each once`);
  for (const { guarantee, verdict } of expected) {
    const line = lines.find((each) => each.startsWith(`- ${guarantee.id}: `));
    const said = line === undefined ? null : /\| verdict: (pass|fail|unjudged)\b/.exec(line)?.[1];
    if (line !== undefined && said !== verdict) problems.push(`its table says ${guarantee.id} is ${said ?? "nothing"}; its evidence reads ${verdict}`);
  }
  const atRisk = new Set(stored.filter((row) => row.verdict === "pass" && row.basis === "assumed-unconfirmed").map((row) => row.guaranteeId));
  const punched = [
    ...expected.filter((each) => each.verdict === "fail"),
    ...expected.filter((each) => each.verdict === "unjudged"),
    ...expected.filter((each) => each.verdict === "pass" && atRisk.has(each.guarantee.id)),
  ].map((each) => each.guarantee.id);
  const punch = paragraph(report.body, PUNCH_HEAD);
  if (punch === null) problems.push("it carries no punch list");
  else if (JSON.stringify(idsListed(punch)) !== JSON.stringify(punched)) problems.push(`its punch list names [${idsListed(punch).join(", ")}]; the verdicts put [${punched.join(", ")}] on it, failures first`);
  return problems;
}
