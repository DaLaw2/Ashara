import type { createDb } from "@ashara/db";
import { WorkItemRowRepository, adaptWorkItemRepo } from "@ashara/delivery";
import type { AcceptanceStore, TerminalSweepStore } from "@ashara/delivery";
import { acceptProject, guaranteesInForce } from "@ashara/engagement";
import {
  listDueTerminalSweeps,
  listProjectsReadyForAcceptance,
  recordAcceptance,
  recordAcceptanceDefect,
  recordAcceptanceSweepFault,
  recordTerminalSweep,
  recordTerminalSweepFault,
  recordTerminalSweepWithoutEvidence,
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
    recordWithoutEvidence: (sweep) => recordTerminalSweepWithoutEvidence(db, sweep),
    recordSweepFault: (projectId, terminal) => recordTerminalSweepFault(db, projectId, terminal),
  };
}
