import { z } from "zod";
import type { PROJECT_BLOCK_KINDS } from "@ashara/db/schema/delivery";
import { BlockedReasonCorrupt, parseStoredBlockedReason } from "@ashara/delivery";
import type { StoredBlockedReason } from "@ashara/delivery";
import { SPEND_CAP_ERROR_CLASS } from "@ashara/finance";
import {
  afterTitle,
  cites,
  citedOf,
  figuresOf,
  kindsSaid,
  namedLines,
  namesTitle,
  paragraphsCiting,
  paragraphsOf,
  sameAmounts,
  says,
  timesSaid,
  usdAmounts,
} from "./client-message-facts.js";
import type { Signature } from "./client-message-facts.js";
import { sweptSource, tableProblems, terminalSweepProblem, unsweptSource } from "./client-report-core.js";
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
 * fails the type check here until it is placed). `stated`: the report's cause carries the episode's
 * recorded kind and facts (causeProblems). `repair`: the report names the given-up tasks with their
 * recorded causes.
 * `retired`: check_dispute and suite_review are kinds Delivery's ProjectBlockCategory keeps but no
 * code path writes, and a run database starts empty, so one in a run is a writer that should not
 * exist, not a report to judge.
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
 * Why a given-up task was given up, as the oracle reads each stored reason's source: its category,
 * never the stored text, which is Ashara's internal wording.
 */
type GivenUpCategory =
  | "attempts-failed"
  | "own-step-failed"
  | "merge-unrecorded"
  | "machines-unavailable"
  | "environment-undefined"
  | "environment-change"
  | "checks-stale"
  | "check-disputed"
  | "review-unsettled"
  | "task-budget-spent"
  | "too-large"
  | "crash-loop"
  | "unowned"
  | "dependency-unfinishable"
  | "acceptance-unread"
  | "acceptance-failed"
  | "correction"
  | "superseded"
  | "prerequisite-unresolved"
  | "waiting"
  | "by-hand";

/**
 * The key terms that tell each category apart in a given-up task's line, written here and never read
 * from the composer: a line is read as stating every category whose terms it says, and is right only
 * when that is its recorded one alone.
 */
const CATEGORY_TERMS = {
  "attempts-failed": { all: ["did not succeed"] },
  "own-step-failed": { all: ["own work", "failed"] },
  "merge-unrecorded": { all: ["could not record"] },
  "machines-unavailable": { all: ["machines"] },
  "environment-undefined": { all: ["not defined"] },
  "environment-change": { all: ["needed a change"] },
  "checks-stale": { all: ["no longer held"] },
  "check-disputed": { all: ["cannot be passed"] },
  "review-unsettled": { all: ["review"] },
  "task-budget-spent": { all: ["model request"] },
  "too-large": { all: ["hold in view"] },
  "crash-loop": { all: ["process stopped"] },
  unowned: { all: ["assigned"] },
  "dependency-unfinishable": { all: ["never be finished"] },
  "acceptance-unread": { all: ["final check", "could not read"] },
  "acceptance-failed": { all: ["final check", "did not pass"] },
  correction: { all: ["correction"] },
  superseded: { all: ["replaced"] },
  "prerequisite-unresolved": { all: ["could not end"] },
  waiting: { all: ["waiting on"] },
  "by-hand": { all: ["by hand"] },
} as const satisfies Record<GivenUpCategory, Signature>;
const CATEGORIES: readonly GivenUpCategory[] = [
  "attempts-failed",
  "own-step-failed",
  "merge-unrecorded",
  "machines-unavailable",
  "environment-undefined",
  "environment-change",
  "checks-stale",
  "check-disputed",
  "review-unsettled",
  "task-budget-spent",
  "too-large",
  "crash-loop",
  "unowned",
  "dependency-unfinishable",
  "acceptance-unread",
  "acceptance-failed",
  "correction",
  "superseded",
  "prerequisite-unresolved",
  "waiting",
  "by-hand",
];

function categoryOf(reason: StoredBlockedReason): GivenUpCategory {
  switch (reason.source) {
    case "failure_given_up":
    case "task_failed":
    case "replan":
      return "attempts-failed";
    case "orchestrator_error":
    case "orphan_unreconciled":
      return "own-step-failed";
    case "merge_unrecorded":
      return "merge-unrecorded";
    case "environment_unavailable":
      return "machines-unavailable";
    case "environment_undefined":
      return "environment-undefined";
    case "environment_change_needed":
      return "environment-change";
    case "checks_stale":
    case "checks_rewrite_bound":
      return "checks-stale";
    case "check_disputed":
      return "check-disputed";
    case "suite_review_unresolved":
      return "review-unsettled";
    case "work_budget_spent":
      return "task-budget-spent";
    case "context_window_exceeded":
    case "no_wider_model":
      return "too-large";
    case "crash_loop":
      return "crash-loop";
    case "owner_unresolved":
      return "unowned";
    case "dependency_unsatisfiable":
      return "dependency-unfinishable";
    case "acceptance_failed":
      return reason.mainCommit === null ? "acceptance-unread" : "acceptance-failed";
    case "correction_pending":
      return "correction";
    case "superseded":
      return "superseded";
    case "prerequisite_unresolved":
      return "prerequisite-unresolved";
    case "awaiting_work":
    case "awaiting_client":
    case "client_answered":
      return "waiting";
    case "api":
      return "by-hand";
  }
}

/** A given-up task's category, or, for a reason that does not parse or none, why no line can be judged against it. */
type ReadCategory =
  | { readonly kind: "category"; readonly category: GivenUpCategory }
  | { readonly kind: "corrupt"; readonly detail: string };

function givenUpCategory(raw: unknown): ReadCategory {
  let parsed: StoredBlockedReason | undefined;
  try {
    parsed = parseStoredBlockedReason(raw);
  } catch (err) {
    if (!(err instanceof BlockedReasonCorrupt)) throw err;
    return { kind: "corrupt", detail: err.message };
  }
  if (parsed === undefined) return { kind: "corrupt", detail: "a given-up task records no reason" };
  return { kind: "category", category: categoryOf(parsed) };
}

/** What a halt's cause is read as: a stated kind's, or that no cause was recorded. */
type CauseKind = StatedKind | "no-cause";

/**
 * The key terms that tell each stated kind's cause apart, and a cause told as not recorded, written
 * here and never read from Engagement's composer: a cause is read as stating every kind whose terms
 * it says, so a composer that states another kind's, or two, fails I4, while one that rewords the
 * sentence around the same terms does not.
 */
const KIND_TERMS = {
  budget_cap: { all: ["spending limit", "no room"] },
  configuration: { all: ["own setup"] },
  fault: { all: ["hold together"] },
  planning_stopped: { all: ["make the plan"] },
  replan_bound: { all: ["revised", "operator"] },
  infrastructure: { all: ["machines"] },
  replan_stopped: { all: ["revise", "no usable answer"] },
  replan_provider_failed: { all: ["revise", "service"] },
  model_failed: { all: ["step", "no usable answer"] },
  provider_failed: { all: ["step", "service"] },
  work_budget: { all: ["model requests", "used up"] },
  acceptance_uncovered: { all: ["cannot be accepted"] },
  client_wait: { all: ["your answer"] },
  "no-cause": { all: ["no cause"] },
} as const satisfies Record<CauseKind, Signature>;
const CAUSE_KINDS: readonly CauseKind[] = [...STATED_KINDS, "no-cause"];

/**
 * Whose spending limit a budget_cap halt names, from its recorded error class alone
 * (SPEND_CAP_ERROR_CLASS, the class the writers record); a class that is neither is told as not on
 * record. Each is told apart by its key terms; the oracle names each by its key in the table alone.
 */
const LIMITS = ["deployment", "project", "unrecorded"] as const;
const LIMIT_TERMS = {
  deployment: { all: ["every project"] },
  project: { all: ["this project"] },
  unrecorded: { all: ["which limit"] },
} as const satisfies Record<(typeof LIMITS)[number], Signature>;

function limitOf(errorClass: string | null): (typeof LIMITS)[number] {
  if (errorClass === SPEND_CAP_ERROR_CLASS.deployment) return "deployment";
  if (errorClass === SPEND_CAP_ERROR_CLASS.project) return "project";
  return "unrecorded";
}

/** How a cause says one of its facts is missing from the record: one per fact the record lacks. */
const NOT_ON_RECORD = "not on record";

interface SiteDraw {
  readonly callSite: string;
  readonly requests: number;
}

/** A work_budget cause's call sites, each quoted with the requests it drew, and the cause's text without them. */
function sitesSaid(text: string): { readonly sites: SiteDraw[]; readonly rest: string } {
  const sites: SiteDraw[] = [];
  const rest = text.replace(/"([^"\n]*)" (\d+)(?![\w-]|\.\d)/g, (_, callSite: string, requests: string) => {
    sites.push({ callSite, requests: Number(requests) });
    return " ";
  });
  return { sites, rest };
}

function unrecordedProblem(cause: string, lacking: number): string[] {
  const said = timesSaid(cause, NOT_ON_RECORD);
  return said === lacking ? [] : [`it says ${said} fact(s) are not on record; its record lacks ${lacking}`];
}

/** Where a budget_cap cause departs from its record: whose limit, the amounts judged on, or that they are not. */
function spendProblems(cause: string, errorClass: string | null, spend: z.infer<typeof spendRecord> | null): string[] {
  const problems: string[] = [];
  const limit = limitOf(errorClass);
  const limits = kindsSaid(cause, LIMITS, LIMIT_TERMS);
  if (limits.length !== 1 || limits[0] !== limit)
    problems.push(`it names the limit as [${limits.join(", ")}]; its error class records ${limit}`);
  const expected =
    spend === null
      ? []
      : [spend.spentUsd, spend.inFlightUsd, ...(spend.nextCallUsd === null ? [] : [spend.nextCallUsd]), spend.capUsd];
  const said = usdAmounts(cause);
  if (!sameAmounts(said, expected))
    problems.push(`it states the amounts [${said.join(", ")}] USD; its record holds [${expected.join(", ")}]`);
  return [...problems, ...unrecordedProblem(cause, (limit === "unrecorded" ? 1 : 0) + (spend === null ? 1 : 0))];
}

/** Where a work_budget cause departs from its ledger: figures, call sites, the reserve kept, or that none is. */
function workProblems(cause: string, episodeId: string, work: z.infer<typeof workRecord> | null): string[] {
  const problems: string[] = [];
  const { sites, rest } = sitesSaid(cause);
  const expected =
    work === null
      ? []
      : [
          work.spentRequests,
          work.inFlightRequests,
          work.budgetRequests,
          ...(work.grantedRequests > 0 ? [work.grantedRequests] : []),
          ...(work.reserveRequests > 0 ? [work.reserveRequests] : []),
        ];
  const figures = figuresOf(rest, [episodeId]);
  if (JSON.stringify(figures) !== JSON.stringify(expected))
    problems.push(`it states the figures [${figures.join(", ")}]; its ledger holds [${expected.join(", ")}]`);
  /* eslint-disable-next-line no-restricted-syntax -- policy default: a ledger not on record names no call site,
     and its report is held to naming none */
  const bySite: readonly SiteDraw[] = work?.bySite ?? [];
  const named = (each: readonly SiteDraw[]): string =>
    each.map((site) => `${site.callSite} ${site.requests}`).join(", ");
  if (named(sites) !== named(bySite) || sites.length !== bySite.length)
    problems.push(`it names the call sites [${named(sites)}]; its ledger holds [${named(bySite)}]`);
  // A refusal that kept the verification reserve says the reserve is kept.
  const kept = work?.reserveProtected === true;
  if (says(cause, ["kept"]) !== kept)
    problems.push(`it ${kept ? "does not say" : "says"} the verification reserve was kept; its ledger records ${kept}`);
  return [...problems, ...unrecordedProblem(cause, work === null ? 1 : 0)];
}

/**
 * Where a halt report's cause departs from its episode's row, judged by the facts it carries: the one
 * paragraph citing the episode's id (the record that holds the detail) states its recorded kind alone,
 * a budget_cap halt's limit and amounts, a work_budget halt's ledger, and no amount for any other kind;
 * a halt recorded with neither error class nor reason says no cause was, citing no record; no other
 * halt of the project is cited. Null when the episode's spend or ledger does not parse: no fact can be
 * expected of it.
 */
function causeProblems(
  episode: ReportRecords["episodes"][number],
  kind: StatedKind,
  body: string,
  otherEpisodes: readonly string[],
): string[] | null {
  const spend = z.union([z.null(), spendRecord]).safeParse(episode.spend ?? null);
  const work = z.union([z.null(), workRecord]).safeParse(episode.work ?? null);
  if ((kind === "budget_cap" && !spend.success) || (kind === "work_budget" && !work.success)) return null;
  const problems = citedOf(body, otherEpisodes).map((id) => `it cites halt ${id}, another halt's record`);
  const caused = paragraphsCiting(body, episode.id);
  if (episode.reason === null && episode.errorClass === null) {
    if (caused.length > 0) problems.push(`it cites record ${episode.id} as holding a cause, though none was recorded`);
    if (!paragraphsOf(body).some((part) => kindsSaid(part, CAUSE_KINDS, KIND_TERMS).includes("no-cause")))
      problems.push("it does not say no cause was recorded");
    return problems;
  }
  const [cause] = caused;
  if (cause === undefined || caused.length > 1) {
    problems.push(`${caused.length} of its paragraphs cite record ${episode.id}; its cause is told in one`);
    return problems;
  }
  const kinds = kindsSaid(cause, CAUSE_KINDS, KIND_TERMS);
  if (kinds.length !== 1 || kinds[0] !== kind)
    problems.push(`it states the cause as [${kinds.join(", ")}]; its episode records ${kind}`);
  if (kind === "budget_cap" && spend.success) problems.push(...spendProblems(cause, episode.errorClass, spend.data));
  else if (kind === "work_budget" && work.success) problems.push(...workProblems(cause, episode.id, work.data));
  else if (usdAmounts(cause).length > 0)
    problems.push(`it states the amounts [${usdAmounts(cause).join(", ")}] USD for a ${kind} halt, which records none`);
  return problems;
}

/**
 * A plan_repair halt's report names exactly the given-up tasks its episode is blocked on, each by its
 * title and its work item's record, with its recorded attempts and category and no other task's record.
 */
function checkRepairReport(
  records: ReportRecords,
  episode: ReportRecords["episodes"][number],
  report: ReportRow,
  add: ReportAdd,
): void {
  const blocking = records.repairs.filter((repair) => repair.episodeId === episode.id);
  const lines = namedLines(report.body);
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
    const others = records.repairs.flatMap((each) => (each.workItemId === repair.workItemId ? [] : [each.workItemId]));
    const faults = lines
      .filter((line) => namesTitle(line, repair.title) && cites(line, repair.workItemId))
      .map((line) => {
        const facts = afterTitle(line, repair.title);
        const categories = kindsSaid(facts, CATEGORIES, CATEGORY_TERMS);
        const attempts = figuresOf(facts, [repair.workItemId]);
        return [
          ...(categories.length === 1 && categories[0] === category.category
            ? []
            : [`it states the cause as [${categories.join(", ")}]`]),
          ...(attempts.length === 1 && attempts[0] === repair.attempts
            ? []
            : [`it states the figures [${attempts.join(", ")}]`]),
          ...citedOf(facts, others).map((id) => `it cites record ${id}, another task's`),
        ];
      });
    if (!faults.some((each) => each.length === 0)) {
      add(
        "halt-cause:plan_repair",
        `the plan_repair halt report does not name "${repair.title}" with record ${repair.workItemId}, ` +
          `${repair.attempts} attempt(s) and its recorded ${category.category}: ` +
          (faults.length === 0 ? "no line names both" : faults.map((each) => each.join("; ")).join(" | ")),
      );
    }
  }
  if (lines.length !== blocking.length) {
    add(
      "halt-cause:plan_repair",
      `the plan_repair halt report names ${lines.length} given-up task(s); the records name ${blocking.length}`,
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
      const others = records.episodes.flatMap((each) => (each.id === episode.id ? [] : [each.id]));
      const problems = causeProblems(episode, stating, report.body, others);
      if (problems === null) {
        add(
          `halt-spend-corrupt:${kind}`,
          `the ${kind} halt records a spend or work ledger that does not parse, so no report can be judged against it`,
        );
      } else if (problems.length > 0) {
        add(`halt-cause:${kind}`, `the ${kind} halt report's cause departs from its record: ${problems.join("; ")}`);
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
