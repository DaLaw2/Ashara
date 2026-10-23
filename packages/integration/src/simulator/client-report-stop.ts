import {
  namedLines,
  paragraph,
  sweptSource,
  tableProblems,
  terminalSweepProblem,
  unsweptSource,
} from "./client-report-core.js";
import type { ReportAdd, ReportedItem } from "./client-report-core.js";
import type { ReportRecords } from "./client-reports.js";

/**
 * I4 on a stopped project's stop report: there is exactly one, it names exactly the merges recorded,
 * it is told only once the stop's terminal sweep is over (terminalSweepProblem), and it carries the
 * guarantee table of that sweep.
 */
export function checkStopReport(records: ReportRecords, items: readonly ReportedItem[], add: ReportAdd): void {
  const stops = records.reports.filter((report) => report.reportsOn === "client-stop");
  if (stops.length !== 1) add("stop-reports", `the project is stopped with ${stops.length} stop report(s)`);
  const [stop] = stops;
  if (stop === undefined) return;
  const merges = items.flatMap((item) =>
    item.level === "Task" && item.mergeCommit !== null ? [{ title: item.title, mergeCommit: item.mergeCommit }] : [],
  );
  /* eslint-disable-next-line no-restricted-syntax -- policy default: an absent paragraph names no merge, so each
     merged task below is reported as stop-merges */
  const lines = namedLines(paragraph(stop.body, "What is on main") ?? "");
  for (const item of merges) {
    if (!lines.some((line) => line.startsWith(`- "${item.title}"`) && line.includes(item.mergeCommit))) {
      add("stop-merges", `the stop report does not name "${item.title}" merged as ${item.mergeCommit}`);
    }
  }
  if (lines.length !== merges.length)
    add("stop-merges", `the stop report names ${lines.length} merge(s); the records hold ${merges.length}`);
  // The stop's terminal sweep, when it was on record before the report; a stop told before it was
  // is named, and its table judged on no sweep, as the version in force when it was told states them.
  const sweep = records.tableSweeps.find(
    (each) =>
      each.stopId !== null && each.stopId === stop.inReplyTo && records.stopSweepsBeforeReport.includes(each.id),
  );
  const unswept = terminalSweepProblem(records, { stopId: stop.inReplyTo }, sweep);
  if (unswept !== null) add(sweep === undefined ? "stop-sweep-unattempted" : "stop-sweep-unexhausted", unswept);
  for (const problem of tableProblems(records, stop, sweep === undefined ? unsweptSource(stop) : sweptSource(sweep))) {
    add("guarantee-table:stop", `the stop report: ${problem}`);
  }
}
