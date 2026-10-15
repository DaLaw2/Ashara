import { listDueDeliveredReports, postDeliveredReport } from "@ashara/engagement";
import { listProjectsReadyForAcceptance, recordAcceptance, recordAcceptanceDefect, recordAcceptanceSweepFault } from "@ashara/db";
import type { createDb } from "@ashara/db";
import type { DeliveredReportStore } from "@ashara/engagement";
import type { AcceptanceStore } from "@ashara/orchestrator";
import { adaptWorkItemRepo } from "./work-item-adapter.js";

type Db = ReturnType<typeof createDb>;

/** Delivery's acceptance store over projects, work_items and acceptance_sweeps (migration 049). */
export function createAcceptanceStore(db: Db): AcceptanceStore {
  return {
    readyForAcceptance: () => listProjectsReadyForAcceptance(db),
    recordAccepted: (sweep) => recordAcceptance(db, sweep),
    recordSweepFault: (projectId) => recordAcceptanceSweepFault(db, projectId),
    recordDefect: (sweep, writeDefect) => recordAcceptanceDefect(db, sweep, (workItems) => writeDefect(adaptWorkItemRepo(workItems))),
  };
}

/** Engagement's delivered-report store over acceptance_sweeps, work_items, task_checks and client_messages (migration 049). */
export function createDeliveredReportStore(db: Db): DeliveredReportStore {
  return {
    dueReports: () => listDueDeliveredReports(db),
    postReport: (sweepId, body) => postDeliveredReport(db, sweepId, body),
  };
}
