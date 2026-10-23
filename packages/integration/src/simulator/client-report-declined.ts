import { tableProblems, unsweptSource } from "./client-report-core.js";
import type { ReportAdd } from "./client-report-core.js";
import type { ReportRecords } from "./client-reports.js";

/**
 * I4 on the decline of a contract Ashara can verify no guarantee of: at most one per project, and
 * it carries the table of the version in force on no sweep, each guarantee the contract marks not
 * verifiable by Ashara listed as not verified.
 */
export function checkDeclinedReports(records: ReportRecords, add: ReportAdd): void {
  const declined = records.reports.filter((each) => each.reportsOn === "declined");
  if (declined.length > 1) add("declined-reports", `the project was sent ${declined.length} decline messages`);
  for (const report of declined) {
    for (const problem of tableProblems(records, report, unsweptSource(report))) {
      add("guarantee-table:declined", `the decline message: ${problem}`);
    }
  }
}
