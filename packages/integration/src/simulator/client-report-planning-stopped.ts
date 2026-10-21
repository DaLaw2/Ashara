import { tableProblems, unsweptSource } from "./client-report-core.js";
import type { ReportAdd } from "./client-report-core.js";
import type { ReportRecords } from "./client-reports.js";

/**
 * I4 on the report of a first planning that stopped, that halt's report: nothing was built and no
 * sweep is on record for it, so it carries every guarantee unjudged on no sweep.
 */
export function checkPlanningStoppedReports(records: ReportRecords, add: ReportAdd): void {
  for (const report of records.reports.filter((each) => each.reportsOn === "planning-stopped")) {
    for (const problem of tableProblems(records, report, unsweptSource(report))) {
      add("guarantee-table:planning-stopped", `the planning-stopped report: ${problem}`);
    }
  }
}
