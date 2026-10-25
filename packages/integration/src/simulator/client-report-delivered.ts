import { BlockedReasonCorrupt, parseStoredBlockedReason } from "@ashara/delivery";
import type { StoredBlockedReason } from "@ashara/delivery";
import {
  afterTitle,
  cites,
  citedOf,
  figuresOf,
  kindsSaid,
  namedLines,
  namesTitle,
  outsideFences,
  paragraphsOf,
  paragraphsSaying,
  quotedOf,
} from "./client-message-facts.js";
import type { Signature } from "./client-message-facts.js";
import { sweptSource, tableProblems } from "./client-report-core.js";
import type { ReportAdd, ReportRow, ReportedItem, ReportsById } from "./client-report-core.js";
import type { ReportRecords } from "./client-reports.js";

/**
 * How a goal task closed, from its merge record: merged, already delivered (on the commit of the task
 * whose merge is recorded on it, if any), closed on a commit with no kind recorded, or closed with no
 * commit.
 */
type Close = "merged" | "already-delivered" | "kind-unrecorded" | "no-commit";

/** The key terms that tell each close apart in a goal's line, written here and never read from the composer. */
const CLOSE_TERMS = {
  merged: { all: ["merged"], none: ["already delivered", "not on record", "nothing of its own"] },
  "already-delivered": { all: ["already delivered"], none: ["not on record"] },
  "kind-unrecorded": { all: ["not on record"], none: ["no commit"] },
  "no-commit": { all: ["no commit"] },
} as const satisfies Record<Close, Signature>;
const CLOSES: readonly Close[] = ["merged", "already-delivered", "kind-unrecorded", "no-commit"];

function closeOf(goal: ReportedItem): Close {
  if (goal.mergeCommit === null) return "no-commit";
  if (goal.mergeKind === "merged") return "merged";
  if (goal.mergeKind === "already_delivered") return "already-delivered";
  return "kind-unrecorded";
}

/**
 * Where a goal's line departs from its merge record, by the facts it carries: its close alone, the
 * commit it closed on and no other task's, and, already delivered, the title of the task whose merge
 * made that commit, or none when no merge is recorded on it.
 */
function closeProblems(line: string, goal: ReportedItem, items: readonly ReportedItem[]): string[] {
  const facts = afterTitle(line, goal.title);
  const close = closeOf(goal);
  const commit = goal.mergeCommit;
  const closes = kindsSaid(facts, CLOSES, CLOSE_TERMS);
  const others = items.flatMap((item) =>
    item.mergeCommit === null || item.mergeCommit === commit ? [] : [item.mergeCommit],
  );
  const problems = [
    ...(closes.length === 1 && closes[0] === close ? [] : [`it states the close as [${closes.join(", ")}]`]),
    ...(commit === null || cites(facts, commit) ? [] : [`it does not cite commit ${commit}`]),
    ...citedOf(facts, others).map((other) => `it cites commit ${other}, another task's`),
  ];
  if (close === "already-delivered") {
    const by = items.find((item) => item.mergeKind === "merged" && item.mergeCommit === commit)?.title ?? null;
    const named = quotedOf(facts);
    if (named.join("\n") !== (by === null ? "" : by) || named.length !== (by === null ? 0 : 1))
      problems.push(`it names [${named.join(", ")}] as making its commit; the records name ${by ?? "no task"}`);
  }
  return problems;
}

/**
 * How an Abandoned goal task left the plan, from its stored reason: set aside, when a revision of
 * the plan replaced it while it was open (source `superseded`: the team did not give up on it, the
 * plan stopped asking for it), or given up, for every other recorded reason. A reason that
 * does not parse, or none, is its own verdict: neither reading is on record.
 */
type Disposal =
  | { readonly kind: "given-up" }
  | { readonly kind: "set-aside" }
  | { readonly kind: "corrupt"; readonly detail: string };

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

/** The accepted sweep the delivered report or its notice is posted on. */
type AcceptedSweep = ReportRecords["sweeps"][number];

/** The key terms of the paragraph listing the completed tasks no stored check covers. */
const UNCHECKED_TERMS = ["not checked"];
/** The key terms of the paragraph listing the goal tasks given up. */
const GIVEN_UP_TERMS = ["given up"];
/** The key terms by which a message opens as the acceptance notice sent in a delivered report's place. */
const NOTICE_TERMS = ["could not be written"];

/** The named lines of the paragraphs of `body` that say `terms`: a list of titles under the lead it is told by. */
function listedTitles(body: string, terms: readonly string[]): string[] {
  return paragraphsSaying(body, terms).flatMap((part) => namedLines(part));
}

/** Whether a list of titles names `title` alone on one of its lines. */
function listsTitle(lines: readonly string[], title: string): boolean {
  return lines.some((line) => namesTitle(line, title) && afterTitle(line, title).trim() === "");
}

/** What an acceptance notice states of the attempts to write its report: the figures of its opening. */
interface AcceptanceNotice {
  readonly figures: readonly number[];
}

/**
 * The acceptance notice a message opens as, with the figures its opening paragraph states besides the
 * sweep it cites; null when it opens as no notice.
 */
function noticeOf(body: string, sweepId: string): AcceptanceNotice | null {
  const [opening] = paragraphsOf(body);
  if (opening === undefined || paragraphsSaying(opening, NOTICE_TERMS).length === 0) return null;
  return { figures: figuresOf(opening, [sweepId]) };
}

/**
 * The acceptance notice sent in place of a report whose records could not be read: it states its
 * attempts as one figure, every attempt it names but the posting one is a failure recorded on the
 * sweep, and as the project's terminal message in the report's place it carries the sweep's table.
 */
function checkAcceptanceNotice(
  records: ReportRecords,
  sweep: AcceptedSweep,
  report: ReportRow,
  notice: AcceptanceNotice,
  add: ReportAdd,
): void {
  const [attempts] = notice.figures;
  if (attempts === undefined || notice.figures.length > 1) {
    add(
      "delivered-notice-unfounded",
      `the acceptance notice states the figures [${notice.figures.join(", ")}]; it states its attempts as one`,
    );
  } else if (sweep.reportFailures < attempts - 1) {
    add(
      "delivered-notice-unfounded",
      `the acceptance notice says the report could not be written in ${attempts} attempts; ` +
        `the sweep records ${sweep.reportFailures} failed attempt(s)`,
    );
  }
  const tableSweep = records.tableSweeps.find((each) => each.id === sweep.id);
  if (tableSweep === undefined)
    add("guarantee-table:delivered", `the acceptance notice's sweep ${sweep.id} is not among the project's sweeps`);
  for (const problem of tableSweep === undefined ? [] : tableProblems(records, report, sweptSource(tableSweep))) {
    add("guarantee-table:delivered", `the acceptance notice: ${problem}`);
  }
}

/** The delivered report names each completed goal task's recorded close, and exactly the goals the records hold. */
function checkGoalCloses(report: ReportRow, items: readonly ReportedItem[], add: ReportAdd): void {
  const goals = items.filter(
    (item) => item.level === "Task" && item.status === "Completed" && item.origin === "decomposition",
  );
  // A goal's close is a named line stating facts after its title; a bare named line lists a title alone.
  const closes = namedLines(report.body).filter((line) => /^- "[^"]*": /.test(line));
  for (const goal of goals) {
    // A revised plan can hold two goal tasks of one title (the one it replaced, still Completed):
    // each is matched to a line by its title, its commit and its kind together.
    const faults = closes
      .filter((each) => namesTitle(each, goal.title))
      .map((line) => closeProblems(line, goal, items));
    if (!faults.some((each) => each.length === 0)) {
      add(
        "delivered-close",
        `the delivered report does not state "${goal.title}" closed ${closeOf(goal)} on ` +
          `${goal.mergeCommit ?? "no commit"}: ` +
          (faults.length === 0 ? "no line names it" : faults.map((each) => each.join("; ")).join(" | ")),
      );
    }
  }
  if (closes.length !== goals.length) {
    add(
      "delivered-close",
      `the delivered report names ${closes.length} goal(s); the records hold ${goals.length} completed goal task(s)`,
    );
  }
}

/** The accepted sweep and the delivered report name exactly the completed tasks no stored check covers. */
function checkUnchecked(
  sweep: AcceptedSweep,
  report: ReportRow,
  items: readonly ReportedItem[],
  checkedTaskIds: ReadonlySet<string>,
  add: ReportAdd,
): void {
  const unchecked = items.filter(
    (item) => item.status === "Completed" && item.workKind === "implementation" && !checkedTaskIds.has(item.id),
  );
  const swept = new Set(sweep.uncheckedTasks);
  if (unchecked.length !== swept.size || unchecked.some((item) => !swept.has(item.id))) {
    add(
      "delivered-unchecked",
      `the accepted sweep records ${swept.size} task(s) as not checked; the task and check records hold ` +
        `${unchecked.length}`,
    );
  }
  const stated = listedTitles(report.body, UNCHECKED_TERMS);
  if (stated.length !== unchecked.length || unchecked.some((item) => !listsTitle(stated, item.title))) {
    add(
      "delivered-unchecked",
      `the delivered report states ${stated.length} task(s) not checked by a stored check; ` +
        `the records hold ${unchecked.length}: ${unchecked.map((item) => `"${item.title}"`).join(", ")}`,
    );
  }
}

/** The delivered report names exactly the goal tasks given up, never one a revision set aside. */
function checkGivenUp(report: ReportRow, items: readonly ReportedItem[], add: ReportAdd): void {
  const givenUp: ReportedItem[] = [];
  for (const item of items.filter(
    (each) => each.level === "Task" && each.status === "Abandoned" && each.origin === "decomposition",
  )) {
    const disposal = disposalOf(item.blockedReason);
    if (disposal.kind === "corrupt") {
      add(
        "delivered-given-up-corrupt",
        `"${item.title}" is Abandoned with a stored reason that does not parse, so whether it was given up ` +
          `is not on record: ` +
          disposal.detail.slice(0, 200),
      );
    } else if (disposal.kind === "given-up") {
      givenUp.push(item);
    }
  }
  const statedGivenUp = listedTitles(report.body, GIVEN_UP_TERMS);
  if (statedGivenUp.length !== givenUp.length || givenUp.some((item) => !listsTitle(statedGivenUp, item.title))) {
    add(
      "delivered-given-up",
      `the delivered report names ${statedGivenUp.length} goal task(s) given up; ` +
        `the records hold ${givenUp.length}: ${givenUp.map((item) => `"${item.title}"`).join(", ")}`,
    );
  }
}

/**
 * I4 on an accepted project's delivered report: each goal's recorded close, exactly the completed
 * tasks no stored check covers, the goals given up, and the guarantee table of the accepted sweep;
 * or, in its place, the acceptance notice.
 */
export function checkDeliveredReport(
  records: ReportRecords,
  byId: ReportsById,
  items: readonly ReportedItem[],
  checkedTaskIds: ReadonlySet<string>,
  add: ReportAdd,
): void {
  const passed = records.sweeps.filter((sweep) => sweep.passed);
  const sweep = passed.at(-1);
  if (sweep === undefined) add("accepted-unswept", "the project is accepted with no passed acceptance sweep on record");
  const report = sweep?.reportId === null || sweep === undefined ? undefined : byId.get(sweep.reportId);
  const notice = report === undefined || sweep === undefined ? null : noticeOf(report.body, sweep.id);
  if (notice !== null && sweep !== undefined && report !== undefined) {
    checkAcceptanceNotice(records, sweep, report, notice, add);
  } else if (report !== undefined && sweep !== undefined) {
    // Its own lines, never those of a file or a command it quotes in a fenced block.
    const own = { ...report, body: outsideFences(report.body) };
    checkGoalCloses(own, items, add);
    checkUnchecked(sweep, own, items, checkedTaskIds, add);
    checkGivenUp(own, items, add);
    const tableSweep = records.tableSweeps.find((each) => each.id === sweep.id);
    if (tableSweep === undefined)
      add("guarantee-table:delivered", `the delivered report's sweep ${sweep.id} is not among the project's sweeps`);
    for (const problem of tableSweep === undefined ? [] : tableProblems(records, report, sweptSource(tableSweep))) {
      add("guarantee-table:delivered", `the delivered report: ${problem}`);
    }
  }
}
