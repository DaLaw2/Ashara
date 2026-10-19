import type { createDb } from "@ashara/db";
import { listDueBlockReports, postProjectBlockReport, readRiskRecords } from "@ashara/engagement";
import type { BlockReportStore } from "@ashara/engagement";
import { blockingReview } from "@ashara/quality";

type Db = ReturnType<typeof createDb>;

/** Engagement's block-report store over project_blocks, work_items, client_messages and guarantee_verdicts. */
export function createBlockReportStore(db: Db): BlockReportStore {
  return {
    dueReports: () => listDueBlockReports(db, blockingReview),
    postProjectReport: (episodeId, on, body, verdicts) => postProjectBlockReport(db, episodeId, on, body, verdicts),
    riskRecords: (projectId) => readRiskRecords(db, projectId),
  };
}
