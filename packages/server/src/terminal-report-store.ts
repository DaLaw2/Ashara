import type { createDb } from "@ashara/db";
import { TerminalReports, listDueTerminals, postTerminalMessage, recordDeliveredReportFailure } from "@ashara/engagement";
import type { TerminalReportStore } from "@ashara/engagement";
import type { StepContainment } from "@ashara/shared";
import { PUBLIC_INTERFACE_FILE, blockingReview, gitPublicInterface, readSweepOutcome } from "@ashara/quality";

type Db = ReturnType<typeof createDb>;

/**
 * Engagement's terminal-message store over Quality's published sweeps and verdicts, Delivery's
 * published halt episodes and planning records, Engagement's told and attempts records and
 * client_messages.
 */
export function createTerminalReportStore(db: Db): TerminalReportStore {
  return {
    dueTerminals: (kinds) => listDueTerminals(db, { sweepOutcome: readSweepOutcome, blockingReview }, kinds),
    postTerminal: (message) => postTerminalMessage(db, message),
    recordDeliveredFailure: (sweepId, failure) => recordDeliveredReportFailure(db, sweepId, failure),
  };
}

/**
 * The Liaison's terminal messages over `store`, a delivered report quoting how to run the product
 * from main: the public interface file is Quality's convention, read through its git reader at the
 * accepted commit.
 */
export function createTerminalReports(store: TerminalReportStore, containment: StepContainment): TerminalReports {
  return new TerminalReports(store, { file: PUBLIC_INTERFACE_FILE, at: (targetProjectPath, commit) => gitPublicInterface.at(targetProjectPath, commit) }, containment);
}
