import type { createDb } from "@ashara/db";
import { WorkItemRowRepository, adaptWorkItemRepo } from "@ashara/delivery";
import type { AcceptanceStore, TerminalSweepStore } from "@ashara/delivery";
import { DeliveredReports, acceptProject, guaranteesInForce, listDueDeliveredReports, postDeliveredReport, readGuaranteeTable, recordDeliveredReportFailure } from "@ashara/engagement";
import type { DeliveredReportStore } from "@ashara/engagement";
import {
  PUBLIC_INTERFACE_FILE,
  gitPublicInterface,
  listDueTerminalSweeps,
  listProjectsReadyForAcceptance,
  readSweepOutcome,
  recordAcceptance,
  recordAcceptanceDefect,
  recordAcceptanceSweepFault,
  recordTerminalSweep,
} from "@ashara/quality";

type Db = ReturnType<typeof createDb>;

/**
 * Delivery's acceptance store over projects, work_items, acceptance_sweeps and guarantee_evidence. The
 * guarantees each sweep's evidence is recorded for are Engagement's, read by its vision reader in the
 * sweep's transaction; Quality judges each of them, and accepts a project only on a passed sweep that
 * judges pass every one the contract does not mark not verifiable by Ashara, the coverage Delivery
 * routes as an acceptance_uncovered halt when it is short.
 */
export function createAcceptanceStore(db: Db): AcceptanceStore {
  return {
    readyForAcceptance: () => listProjectsReadyForAcceptance(db),
    // The move to 'accepted' is Engagement's lifecycle guard, in the sweep's transaction.
    recordAccepted: (sweep) => recordAcceptance(db, sweep, acceptProject, guaranteesInForce),
    recordSweepFault: (projectId) => recordAcceptanceSweepFault(db, projectId),
    recordDefect: (sweep, writeDefect) => recordAcceptanceDefect(db, sweep, (tx) => writeDefect(adaptWorkItemRepo(new WorkItemRowRepository(tx))), guaranteesInForce),
  };
}

/** Delivery's terminal sweep store over projects, client_messages, project_blocks, acceptance_sweeps and guarantee_evidence. */
export function createTerminalSweepStore(db: Db): TerminalSweepStore {
  return {
    dueTerminalSweeps: () => listDueTerminalSweeps(db),
    recordTerminalSweep: (sweep) => recordTerminalSweep(db, sweep, guaranteesInForce),
  };
}

/** Engagement's delivered-report store over Quality's published sweep outcomes, work_items, Engagement's told and attempts records and client_messages. */
export function createDeliveredReportStore(db: Db): DeliveredReportStore {
  return {
    dueReports: () => listDueDeliveredReports(db, readSweepOutcome),
    guaranteeTable: (sweepId) => readGuaranteeTable(db, { kind: "sweep", sweepId }),
    postReport: (sweepId, body, verdicts) => postDeliveredReport(db, sweepId, body, verdicts),
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
