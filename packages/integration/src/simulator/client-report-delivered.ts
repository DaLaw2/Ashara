import { BlockedReasonCorrupt, parseStoredBlockedReason } from "@ashara/delivery";
import type { StoredBlockedReason } from "@ashara/delivery";
import { namedLines, paragraph, sweptSource, tableProblems } from "./client-report-core.js";
import type { ReportAdd, ReportRow, ReportedItem, ReportsById } from "./client-report-core.js";
import type { ReportRecords } from "./client-reports.js";

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

/**
 * The acceptance notice sent in place of a report whose records could not be read: every attempt it
 * names but the posting one is a failure recorded on the sweep, and as the project's terminal
 * message in the report's place it carries the sweep's table.
 */
function checkAcceptanceNotice(
  records: ReportRecords,
  sweep: AcceptedSweep,
  report: ReportRow,
  attempts: number,
  add: ReportAdd,
): void {
  if (sweep.reportFailures < attempts - 1) {
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
  const closes = namedLines(paragraph(report.body, "What was delivered:"));
  for (const goal of goals) {
    // A revised plan can hold two goal tasks of one title (the one it replaced, still Completed):
    // each is matched to a line by its title, its commit and its kind together.
    const named = closes.filter((each) => each.startsWith(`- "${goal.title}": `));
    if (!named.includes(closeOnRecord(goal, items))) {
      add(
        "delivered-close",
        `the delivered report does not state "${goal.title}" closed ${goal.mergeKind ?? "with no kind recorded"} ` +
          `on ${goal.mergeCommit ?? "no commit"}; it reads ${named.join(" | ") || "no line for it"}`,
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
  const stated = namedLines(paragraph(report.body, "These tasks are done but not checked"));
  if (stated.length !== unchecked.length || unchecked.some((item) => !stated.includes(`- "${item.title}"`))) {
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
  const statedGivenUp = namedLines(paragraph(report.body, "These tasks were given up"));
  if (statedGivenUp.length !== givenUp.length || givenUp.some((item) => !statedGivenUp.includes(`- "${item.title}"`))) {
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
  const notice =
    report === undefined
      ? null
      : /^Your project is accepted: .* could not be written from Ashara's records in (\d+) attempts\./.exec(
          report.body,
        );
  if (notice !== null && sweep !== undefined && report !== undefined) {
    checkAcceptanceNotice(records, sweep, report, Number(notice[1]), add);
  } else if (report !== undefined && sweep !== undefined) {
    checkGoalCloses(report, items, add);
    checkUnchecked(sweep, report, items, checkedTaskIds, add);
    checkGivenUp(report, items, add);
    const tableSweep = records.tableSweeps.find((each) => each.id === sweep.id);
    if (tableSweep === undefined)
      add("guarantee-table:delivered", `the delivered report's sweep ${sweep.id} is not among the project's sweeps`);
    for (const problem of tableSweep === undefined ? [] : tableProblems(records, report, sweptSource(tableSweep))) {
      add("guarantee-table:delivered", `the delivered report: ${problem}`);
    }
  }
}
