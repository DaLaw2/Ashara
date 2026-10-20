import { containEach } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted, UnreadSubject } from "@ashara/shared";
import { guaranteeSection, tableVerdicts } from "./guarantee-report.js";
import type { GuaranteeTable, TableVerdicts } from "./guarantee-report.js";

// The client's stop. The web
// client's Stop promises a halt; the Liaison, the only writer to the client,
// keeps it: each cycle, before any intake, planning or dispatch, it consumes the
// open stops and moves each project to 'stopped'. The client is told once what is
// on record as merged and how each guarantee stands on main: the stop report is
// posted after the cycle's terminal sweeps, the commands-only run of the stored
// checks on main, and carries the table of the stop's terminal sweep; a stop whose
// sweep is not on record (its recording failed) is still told, every guarantee
// unjudged with no sweep on a commit, since the client is never left without the
// stop's report for want of evidence.
//
// A stop sent mid-cycle, after this step, is honoured by the rest of that cycle
// all the same: every reader that admits a project to intake, first planning,
// a planning report or dispatch also excludes a project with an unconsumed stop
// (noOpenStop in @ashara/db), so from the stop's commit nothing new starts.
//
// In-flight work: there is no cancellation of a running attempt. None is needed
// for the loop's own dispatches, because a cycle awaits every task it dispatched
// before it returns, so when the next cycle consumes the stop no attempt of this
// process is running; an attempt that was running when the client pressed Stop
// ran to its end first, and if it was merged it is in the report. A stop pressed
// mid-cycle therefore waits for that cycle's attempts (up to the agent timeout).
//
// A stop is taken in while the project is paused, and while the loop itself is halted (the
// deployment's spend cap: the runner keeps answering stops): the project moves to
// 'stopped' and its halt ends with it, so lifting the pause later does not resume it, and the
// report says so.

/** An inbound stop not yet consumed. */
interface OpenStop {
  readonly id: string;
  readonly projectId: ProjectId;
}

type ClientStopCommit =
  /** `reportDue` is false only when a stop report already exists (an operator re-activated a stopped project). */
  | { readonly kind: "stopped"; readonly reportDue: boolean }
  | { readonly kind: "already-stopped" };

/**
 * A task with a commit on record and how that commit closed it:
 * null when the record predates merge kinds and does not say.
 */
interface MergedTask {
  readonly title: string;
  readonly commit: string;
  readonly kind: "merged" | "already_delivered" | null;
}

/** A stop that stopped its project, whose report the client has not been sent. */
interface DueStopReport {
  readonly stopId: string;
  readonly projectId: ProjectId;
  readonly merged: readonly MergedTask[];
  /** Whether Delivery had the project halted when the stop arrived. */
  readonly paused: boolean;
  readonly guarantees: GuaranteeTable;
}

/** Engagement's persistence port for client stops. */
export interface ClientStopStore {
  openStops(): Promise<readonly OpenStop[]>;
  /**
   * Consumes the stop and, unless the project is already stopped, stops it and records whether it
   * was paused when the stop arrived, in one transaction.
   */
  recordStop(stop: OpenStop): Promise<ClientStopCommit>;
  /** Every stop report due, each read on its own: one whose records do not read as a report is its UnreadSubject. */
  dueStopReports(): Promise<ReadonlyArray<DueStopReport | UnreadSubject>>;
  /** Posts the stop's report with its table's verdicts, unless the project's stop report exists. */
  postStopReport(stopId: string, body: string, verdicts: TableVerdicts): Promise<"posted" | "already-posted">;
}

type ClientStopOutcome = (ClientStopCommit | { readonly kind: "posted" | "already-posted" }) & { readonly stopId: string; readonly projectId: ProjectId };

/** What the core loop asks of the Liaison: the stops at the top of each cycle, their reports after its terminal sweeps. */
export interface LiaisonClientStops {
  runPending(): Promise<ReadonlyArray<ClientStopOutcome | StepFaulted>>;
  reportPending(): Promise<ReadonlyArray<ClientStopOutcome | StepFaulted>>;
}

function mergedLine(task: MergedTask): string {
  switch (task.kind) {
    case "merged":
      return `- "${task.title}": merged, commit ${task.commit}`;
    case "already_delivered":
      return `- "${task.title}": already delivered on commit ${task.commit}, nothing of its own merged`;
    case null:
      return `- "${task.title}": closed on commit ${task.commit}; whether it was merged or already delivered there is not on record`;
  }
}

/**
 * Plain words, only what is on record: that work stopped because the client
 * asked, that a pause already in place does not end the stop, each task
 * with a commit on record, the commit and how it closed the task, and the
 * guarantee table of the stop's terminal sweep. Never a claim that the plan is complete.
 */
function stopReport(due: DueStopReport): string {
  const merged =
    due.merged.length === 0
      ? "No merged work is on record for this project."
      : `What is on main for this project, as recorded:\n${due.merged.map(mergedLine).join("\n")}`;
  return [
    "Work on this project has stopped at your request. Ashara will not start any further work on it.",
    ...(due.paused
      ? [
          "Work on it was already paused when your request arrived. Your request is recorded: the project stays " +
            "stopped, and clearing what paused it does not restart it.",
        ]
      : []),
    merged,
    guaranteeSection(due.guarantees),
  ].join("\n\n");
}

export class ClientStops implements LiaisonClientStops {
  constructor(
    private readonly store: ClientStopStore,
    /** Each stop's own fault is contained to it (containEach). */
    private readonly containment: StepContainment,
  ) {}

  /**
   * The open stops. A second stop on a stopped project is consumed and not answered: the client
   * already holds, or is owed, the stop report, and a second one would say nothing new. A stop whose
   * recording fails is contained to it (containEach) and stays unconsumed, so its project is still
   * held from all work (noOpenStop) while the other stops are taken.
   */
  async runPending(): Promise<ReadonlyArray<ClientStopOutcome | StepFaulted>> {
    const stops = await this.store.openStops();
    return containEach(this.containment, "client-stop", stops, (stop) => ({ id: stop.id, projectId: stop.projectId }), async (stop): Promise<ClientStopOutcome> => {
      const commit = await this.store.recordStop(stop);
      if (commit.kind === "stopped" && !commit.reportDue) {
        console.warn(
          `[liaison-stop] project ${stop.projectId}: stopped by stop ${stop.id}, but a stop report already ` +
            `existed, so none is owed; the project was re-activated after an earlier stop`,
        );
      }
      return { ...commit, stopId: stop.id, projectId: stop.projectId };
    });
  }

  /**
   * The stop reports due, each posted once; run after the cycle's terminal sweeps, so each carries
   * its stop's sweep when one could be recorded. A report that cannot be read or posted is contained
   * to it (containEach).
   */
  async reportPending(): Promise<ReadonlyArray<ClientStopOutcome | StepFaulted>> {
    return containEach(
      this.containment,
      "client-stop",
      await this.store.dueStopReports(),
      (due) => ({ id: `report:${due.stopId}`, projectId: due.projectId }),
      async (due): Promise<ClientStopOutcome> => {
        const kind = await this.store.postStopReport(due.stopId, stopReport(due), tableVerdicts(due.guarantees));
        return { kind, stopId: due.stopId, projectId: due.projectId };
      },
    );
  }
}
