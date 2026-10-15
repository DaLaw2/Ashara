import type { createDb } from "@ashara/db";
import { WorkItemRowRepository, adaptWorkItemRepo } from "@ashara/delivery";
import type { AcceptanceStore } from "@ashara/delivery";
import { acceptProject, listDueDeliveredReports, postDeliveredReport } from "@ashara/engagement";
import type { DeliveredReportStore } from "@ashara/engagement";
import { listProjectsReadyForAcceptance, recordAcceptance, recordAcceptanceDefect, recordAcceptanceSweepFault } from "@ashara/quality";

type Db = ReturnType<typeof createDb>;

/** Delivery's acceptance store over projects, work_items and acceptance_sweeps (migration 049). */
export function createAcceptanceStore(db: Db): AcceptanceStore {
  return {
    readyForAcceptance: () => listProjectsReadyForAcceptance(db),
    // The move to 'accepted' is Engagement's lifecycle guard, in the sweep's transaction (O3 c).
    recordAccepted: (sweep) => recordAcceptance(db, sweep, acceptProject),
    recordSweepFault: (projectId) => recordAcceptanceSweepFault(db, projectId),
    recordDefect: (sweep, writeDefect) => recordAcceptanceDefect(db, sweep, (tx) => writeDefect(adaptWorkItemRepo(new WorkItemRowRepository(tx)))),
  };
}

/** Engagement's delivered-report store over acceptance_sweeps, work_items, task_checks and client_messages (migration 049). */
export function createDeliveredReportStore(db: Db): DeliveredReportStore {
  return {
    dueReports: () => listDueDeliveredReports(db),
    postReport: (sweepId, body) => postDeliveredReport(db, sweepId, body),
  };
}
