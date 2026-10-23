import { tableProblems, unsweptSource } from "./client-report-core.js";
import type { ReportAdd } from "./client-report-core.js";
import type { ReportRecords } from "./client-reports.js";

/**
 * I4 on the decline of a contract Ashara can verify no guarantee of: at most one per vision version,
 * read as the latest version written before the message, and it carries the table of that version on
 * no sweep, each guarantee the contract marks not verifiable by Ashara listed as not verified.
 */
export function checkDeclinedReports(records: ReportRecords, add: ReportAdd): void {
  const declined = records.reports.filter((each) => each.reportsOn === "declined");
  const versions = declined.map((report) => report.visionAtReport);
  for (const version of new Set(versions)) {
    const count = versions.filter((each) => each === version).length;
    const named = `v${version ?? "none"}`;
    if (count > 1) add(`declined-reports:${named}`, `the project was sent ${count} declines of vision ${named}`);
  }
  for (const report of declined) {
    for (const problem of tableProblems(records, report, unsweptSource(report))) {
      add("guarantee-table:declined", `the decline message: ${problem}`);
    }
  }
}
