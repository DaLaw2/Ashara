import { z } from "zod";
import type { PROJECT_BLOCK_KINDS } from "@ashara/db/schema/delivery";
import { BlockedReasonCorrupt, parseStoredBlockedReason } from "@ashara/delivery";
import type { StoredBlockedReason } from "@ashara/delivery";
import { SPEND_CAP_ERROR_CLASS } from "@ashara/finance";
import {
  namedLines,
  requestCount,
  sweptSource,
  tableProblems,
  terminalSweepProblem,
  unsweptSource,
} from "./client-report-core.js";
import type { ReportAdd, ReportRow, ReportsById } from "./client-report-core.js";
import type { ReportRecords } from "./client-reports.js";

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

/**
 * How I4 judges each block kind's report, over the code's own list (`satisfies`: a kind added there
 * fails the type check here until it is placed). `stated`: the report states the episode's recorded
 * kind in the words expectedKindWords states for it. `repair`: the report names the given-up tasks with their recorded
 * causes.
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
  acceptance_uncovered: "stated",
  client_wait: "stated",
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
  "acceptance_uncovered",
  "client_wait",
];

function judgementOf(kind: string): Judged[keyof Judged] | "unknown" {
  /* eslint-disable-next-line no-restricted-syntax -- policy default: a typed Unknown, which the halt check reports
     as halt-kind-unknown */
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
type GivenUpCategory =
  { readonly kind: "category"; readonly words: string } | { readonly kind: "corrupt"; readonly detail: string };

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
      return (
        "its developer found that a check written for it cannot be passed by correct work, and that could not " +
        "be settled"
      );
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
    case "prerequisite_unresolved":
      return "it needed other work, or a decision of yours, before it could go on, and that wait could not end";
    case "awaiting_work":
    case "awaiting_client":
    case "client_answered":
      return "it was waiting on other work, or on your answer to a question, before it could go on";
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
      if (errorClass === SPEND_CAP_ERROR_CLASS.deployment)
        return `the spending limit set for all of Ashara's work, across every project it runs, ${stopped}`;
      if (errorClass === SPEND_CAP_ERROR_CLASS.project) return `the spending limit set for this project ${stopped}`;
      return `a spending limit set for this work ${stopped}; which limit it was is not on record`;
    }
    case "configuration":
      return (
        "a step of the work needed something Ashara's own setup does not provide, for a reason other than a " +
        "spending limit"
      );
    case "fault":
      return (
        "a step of Ashara's own work on this project failed, or Ashara's own record of the project did not " +
        "hold together"
      );
    case "planning_stopped":
      return "every attempt to make the plan failed";
    case "replan_bound":
      return (
        "the plan has been revised for your changes as many times as the team revises it before its operator " +
        "looks the project over"
      );
    case "infrastructure":
      return "the machines Ashara runs the work on kept failing while they ran this project's work";
    case "replan_stopped":
      return "every attempt to revise the plan failed, the last because the model planning it gave no usable answer";
    case "replan_provider_failed":
      return (
        "every attempt to revise the plan failed, the last because the service that runs the model planning it " +
        "returned an error or did not answer, so no answer was read"
      );
    case "model_failed":
      return "a step of the work kept failing because the model doing it gave no usable answer";
    case "provider_failed":
      return (
        "a step of the work kept failing because the service that runs the model doing it returned an error or " +
        "did not answer, so no answer was read"
      );
    case "work_budget":
      return "the budget of model requests set for this project was used up, so the next step of the work was not sent";
    case "acceptance_uncovered":
      return (
        "every check Ashara ran on the finished work passed, but those checks do not show every guarantee of your " +
        "contract to hold, so the project cannot be accepted; each guarantee not shown to hold, and why, is " +
        "listed below"
      );
    case "client_wait":
      return (
        "every piece of work left on this project waits on your answer to a question the team asked you, so none " +
        "of it can go on until you answer"
      );
  }
}

/**
 * The figures a work_budget halt's report must state, from its episode's work ledger, or that they are not on record.
 */
function expectedWorkWords(work: z.infer<typeof workRecord> | null): string {
  if (work === null)
    return (
      "How many model requests had been drawn against that budget, and by which steps of the work, is not on " +
      "record."
    );
  const granted =
    work.grantedRequests > 0 ? `, ${requestCount(work.grantedRequests)} of it granted by the operator` : "";
  const reserve =
    work.reserveRequests > 0
      ? ` ${requestCount(work.reserveRequests)} of the budget are set aside for checking and accepting the ` +
        `finished work.`
      : "";
  const sites =
    work.bySite.length === 0
      ? "none is on record"
      : work.bySite.map((site) => `"${site.callSite}" ${site.requests}`).join(", ");
  return (
    `When it stopped the work, ${requestCount(work.spentRequests)} had been sent and ` +
    `${work.inFlightRequests} more were under way, ` +
    (`against a budget of ${requestCount(work.budgetRequests)}${granted}.${reserve} The requests drawn, by ` +
      `the step of the work that drew them: ${sites}.`)
  );
}

function usd(amount: number): string {
  return `$${amount.toFixed(6)}`;
}

/** The amounts a budget_cap halt's report must state, from its episode's spend, or that they are not on record. */
function expectedSpendWords(spend: z.infer<typeof spendRecord> | null): string {
  if (spend === null)
    return "How much had been spent and set aside against that limit when it stopped the work is not on record.";
  const next =
    spend.nextCallUsd === null
      ? "which together had reached the limit"
      : `and the next step needed up to ${usd(spend.nextCallUsd)} set aside, more than the limit had room for`;
  return (
    `When it stopped the work, ${usd(spend.spentUsd)} had been spent and ${usd(spend.inFlightUsd)} was set ` +
    `aside for work under way, ${next}; the limit is ${usd(spend.capUsd)}.`
  );
}

/**
 * The cause sentences a halt report must carry, from the episode's row: its recorded kind in the
 * client's words, a budget_cap halt's recorded amounts, and the episode's own id as the record that
 * holds the detail; a halt recorded with neither error class nor reason says no cause was.
 * Null when the episode's spend does not parse: no sentence can be expected of it.
 */
function statedCause(
  episode: {
    readonly id: string;
    readonly errorClass: string | null;
    readonly reason: string | null;
    readonly spend: unknown;
    readonly work: unknown;
  },
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
        "the budget of model requests set for this project was used up except for the share set aside for " +
        "checking and accepting the " +
        ("finished work, which is kept for that, so the next step of the work, which was not that checking, " +
          "was not sent");
    }
  }
  return (
    `Ashara recorded the cause as this: ${words}. ` +
    amounts +
    `Ashara keeps the technical detail in its own record of this pause, record ${episode.id}.`
  );
}

/**
 * A plan_repair halt's report names exactly the given-up tasks its episode is blocked on, each with its recorded cause.
 */
function checkRepairReport(
  records: ReportRecords,
  episode: ReportRecords["episodes"][number],
  report: ReportRow,
  add: ReportAdd,
): void {
  const blocking = records.repairs.filter((repair) => repair.episodeId === episode.id);
  for (const repair of blocking) {
    const category = givenUpCategory(repair.blockedReason);
    if (category.kind === "corrupt") {
      add(
        "halt-cause-corrupt:plan_repair",
        `"${repair.title}" is given up with a stored reason that does not parse, so no report can be judged ` +
          `against it: ` +
          category.detail.slice(0, 200),
      );
      continue;
    }
    const expected =
      `- "${repair.title}", after ${plural(repair.attempts, "attempt")} counted against it. Ashara recorded ` +
      `why it was given up as this: ` +
      `${category.words}. Ashara keeps the detail in its own record of that task, record ${repair.workItemId}.`;
    if (!namedLines(report.body).includes(expected)) {
      add(
        "halt-cause:plan_repair",
        `the plan_repair halt report does not name "${repair.title}" as "${expected.slice(0, 200)}"`,
      );
    }
  }
  const named = namedLines(report.body).length;
  if (named !== blocking.length) {
    add(
      "halt-cause:plan_repair",
      `the plan_repair halt report names ${named} given-up task(s); the records name ${blocking.length}`,
    );
  }
}

/**
 * I4 on halt reports: each states the cause recorded on its episode and carries its terminal sweep's guarantee table.
 */
export function checkHaltReports(records: ReportRecords, byId: ReportsById, add: ReportAdd): void {
  for (const episode of records.episodes) {
    if (episode.reportId === null) continue;
    const report = byId.get(episode.reportId);
    if (report === undefined) {
      add(
        `halt-report-missing:${episode.kind}`,
        `the ${episode.kind} halt records report ${episode.reportId}, which is not among the project's reports`,
      );
      continue;
    }
    const { kind } = episode;
    const judgement = judgementOf(kind);
    const stating = statedKind(kind);
    if (judgement === "stated" && stating === null) {
      add(
        `halt-kind-unjudged:${kind}`,
        `the ${kind} halt is judged as stating its kind, but STATED_KINDS does not hold it`,
      );
    } else if (stating !== null) {
      const stated = statedCause(episode, stating);
      if (stated === null) {
        add(
          `halt-spend-corrupt:${kind}`,
          `the ${kind} halt records a spend or work ledger that does not parse, so no report can be judged against it`,
        );
      } else if (!report.body.includes(stated)) {
        add(
          `halt-cause:${kind}`,
          `the ${kind} halt report does not state the recorded cause as "${stated.slice(0, 200)}"; ` +
            `it reads "${report.body.slice(0, 200)}"`,
        );
      }
    } else if (judgement === "retired") {
      add(`halt-kind-retired:${kind}`, `a ${kind} halt was written, a kind no code path writes`);
    } else if (kind === "plan_repair" && !episode.ended) {
      checkRepairReport(records, episode, report, add);
    } else if (judgement === "unknown") {
      add(
        `halt-kind-unknown:${kind}`,
        `a halt of kind ${kind}, outside the code's list, was reported: no oracle states what it must say`,
      );
    }
    // The halt's terminal sweep, when it was on record before the report; a halt told before it was
    // is named, and its table judged on no sweep, as the version in force when it was told states them.
    const sweep = records.tableSweeps.find((each) => each.id === episode.sweepBeforeReport);
    const unswept = terminalSweepProblem(records, { blockId: episode.id }, sweep);
    if (unswept !== null) {
      add(`${sweep === undefined ? "halt-sweep-unattempted" : "halt-sweep-unexhausted"}:${kind}`, unswept);
    }
    for (const problem of tableProblems(
      records,
      report,
      sweep === undefined ? unsweptSource(report) : sweptSource(sweep),
    )) {
      add(`guarantee-table:halt:${kind}`, `the ${kind} halt report: ${problem}`);
    }
  }
}
