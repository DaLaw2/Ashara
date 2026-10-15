import { listDueBlockReports, postProjectBlockReport } from "@ashara/engagement";
import type { createDb } from "@ashara/db";
import type { BlockReportStore } from "@ashara/engagement";

type Db = ReturnType<typeof createDb>;

/** Engagement's block-report store over project_blocks, work_items and client_messages (migrations 040, 048). */
export function createBlockReportStore(db: Db): BlockReportStore {
  return {
    dueReports: () => listDueBlockReports(db),
    postProjectReport: (episodeId, on, body) => postProjectBlockReport(db, episodeId, on, body),
  };
}
