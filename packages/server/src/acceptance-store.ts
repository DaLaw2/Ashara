import type { createDb } from "@ashara/db";
import { WorkItemRowRepository, adaptWorkItemRepo } from "@ashara/delivery";
import type { AcceptanceStore } from "@ashara/delivery";
import { DeliveredReports, acceptProject, listDueDeliveredReports, postDeliveredReport, recordDeliveredReportFailure } from "@ashara/engagement";
import type { DeliveredReportStore } from "@ashara/engagement";
import { PUBLIC_INTERFACE_FILE, gitPublicInterface, listProjectsReadyForAcceptance, recordAcceptance, recordAcceptanceDefect, recordAcceptanceSweepFault } from "@ashara/quality";

type Db = ReturnType<typeof createDb>;

/** Delivery's acceptance store over projects, work_items and acceptance_sweeps. */
export function createAcceptanceStore(db: Db): AcceptanceStore {
  return {
    readyForAcceptance: () => listProjectsReadyForAcceptance(db),
    // The move to 'accepted' is Engagement's lifecycle guard, in the sweep's transaction.
    recordAccepted: (sweep) => recordAcceptance(db, sweep, acceptProject),
    recordSweepFault: (projectId) => recordAcceptanceSweepFault(db, projectId),
    recordDefect: (sweep, writeDefect) => recordAcceptanceDefect(db, sweep, (tx) => writeDefect(adaptWorkItemRepo(new WorkItemRowRepository(tx)))),
  };
}

/** Engagement's delivered-report store over acceptance_sweeps, work_items, task_checks and client_messages. */
export function createDeliveredReportStore(db: Db): DeliveredReportStore {
  return {
    dueReports: () => listDueDeliveredReports(db),
    postReport: (sweepId, body) => postDeliveredReport(db, sweepId, body),
    recordReportFailure: (sweepId, failure) => recordDeliveredReportFailure(db, sweepId, failure),
  };
}

/**
 * The Liaison's delivered reports over `store`, each quoting how to run the product from main: the
 * public interface file is Quality's convention, read through its git reader at the accepted commit.
 */
export function createDeliveredReports(store: DeliveredReportStore): DeliveredReports {
  return new DeliveredReports(store, { file: PUBLIC_INTERFACE_FILE, at: (targetProjectPath, commit) => gitPublicInterface.at(targetProjectPath, commit) });
}
