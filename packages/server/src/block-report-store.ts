import type { createDb } from "@ashara/db";
import { listDueBlockReports, postProjectBlockReport, readRiskRecords } from "@ashara/engagement";
import type { BlockReportStore } from "@ashara/engagement";
import { blockingReview } from "@ashara/quality";

type Db = ReturnType<typeof createDb>;

/** Engagement's block-report store over project_blocks, work_items and client_messages. */
export function createBlockReportStore(db: Db): BlockReportStore {
  return {
    dueReports: () => listDueBlockReports(db, blockingReview),
    postProjectReport: (episodeId, on, body) => postProjectBlockReport(db, episodeId, on, body),
    riskRecords: (projectId) => readRiskRecords(db, projectId),
  };
}
