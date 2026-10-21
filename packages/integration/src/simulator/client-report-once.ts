import type { ReportAdd } from "./client-report-core.js";
import type { ReportRecords } from "./client-reports.js";

/**
 * I4, exactly once: every report the project was sent is the one report of the record it was posted
 * on, or a reply (a report on a client message, or in reply to one).
 */
export function checkReportedOnce(records: ReportRecords, add: ReportAdd): void {
  const recorded = [
    ...records.episodes.flatMap((episode) => [episode.reportId, episode.resumedReportId]),
    ...records.sweeps.map((sweep) => sweep.reportId),
    ...records.revisionReports,
    ...records.burnWarnings.map((warning) => warning.reportId),
  ].filter((id): id is string => id !== null);
  for (const report of records.reports) {
    if (recorded.includes(report.id) || report.reportsOn !== null || report.inReplyTo !== null) continue;
    add(
      "unrecorded-report",
      `a report was sent that no record was posted on (a second report of something already reported): ` +
        `"${report.body.slice(0, 80)}..."`,
    );
  }
}
