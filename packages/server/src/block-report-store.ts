import type { createDb } from "@ashara/db";
import { listDueResumptionReports, postResumptionReport, readRiskRecords } from "@ashara/engagement";
import type { BlockReportStore } from "@ashara/engagement";

type Db = ReturnType<typeof createDb>;

/** Engagement's resumption-report store over Delivery's published halt episodes, Engagement's told record and client_messages. */
export function createBlockReportStore(db: Db): BlockReportStore {
  return {
    dueReports: () => listDueResumptionReports(db),
    postResumedReport: (episodeId, body) => postResumptionReport(db, episodeId, body),
    riskRecords: (projectId) => readRiskRecords(db, projectId),
  };
}
