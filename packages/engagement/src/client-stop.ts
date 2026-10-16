import type { ProjectId } from "@ashara/shared";

// The client's stop (story s-client-channel-m1, ADR-075 Engagement). The web
// client's Stop promises a halt; the Liaison, the only writer to the client,
// keeps it: each cycle, before any intake, planning or dispatch, it consumes the
// open stops, moves each project to 'stopped' (migration 028) and tells the
// client once what is on record as merged.
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
  | { readonly kind: "stopped"; readonly reported: boolean; readonly merged: number }
  | { readonly kind: "already-stopped" };

/**
 * A task with a commit on record (migration 041) and how that commit closed it (migration 049):
 * null when the record predates 049 and does not say.
 */
interface MergedTask {
  readonly title: string;
  readonly commit: string;
  readonly kind: "merged" | "already_delivered" | null;
}

/** Engagement's persistence port for client stops. */
export interface ClientStopStore {
  openStops(): Promise<readonly OpenStop[]>;
  /**
   * Consumes the stop and, unless the project is already stopped, stops it and posts the report
   * composed from its tasks' merge records and whether it was paused when the stop arrived, in one
   * transaction.
   */
  recordStop(stop: OpenStop, composeReport: (merged: readonly MergedTask[], paused: boolean) => string): Promise<ClientStopCommit>;
}

type ClientStopOutcome = ClientStopCommit & { readonly stopId: string; readonly projectId: ProjectId };

/** What the core loop asks of the Liaison at the top of each cycle. */
export interface LiaisonClientStops {
  runPending(): Promise<readonly ClientStopOutcome[]>;
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
 * asked, that a pause already in place does not end the stop, and each task
 * with a commit on record, the commit and how it closed the task. Never a claim
 * that the plan is complete.
 */
function stopReport(mergedTasks: readonly MergedTask[], paused: boolean): string {
  const merged =
    mergedTasks.length === 0
      ? "No merged work is on record for this project."
      : `What is on main for this project, as recorded:\n${mergedTasks.map(mergedLine).join("\n")}`;
  return [
    "Work on this project has stopped at your request. Ashara will not start any further work on it.",
    ...(paused
      ? [
          "Work on it was already paused when your request arrived. Your request is recorded: the project stays " +
            "stopped, and clearing what paused it does not restart it.",
        ]
      : []),
    merged,
  ].join("\n\n");
}

export class ClientStops implements LiaisonClientStops {
  constructor(private readonly store: ClientStopStore) {}

  /**
   * A second stop on a stopped project is consumed and not answered: the client
   * already holds the stop report, a second one would say nothing new, and the
   * one-report-per-project index (migration 020) would refuse it anyway. A store
   * failure throws through and fails the cycle, so no work is dispatched past an
   * unread stop.
   */
  async runPending(): Promise<readonly ClientStopOutcome[]> {
    const outcomes: ClientStopOutcome[] = [];
    for (const stop of await this.store.openStops()) {
      const commit = await this.store.recordStop(stop, stopReport);
      if (commit.kind === "stopped" && !commit.reported) {
        console.warn(
          `[liaison-stop] project ${stop.projectId}: stopped by stop ${stop.id}, but a stop report already ` +
            `existed, so none was posted; the project was re-activated after an earlier stop`,
        );
      }
      outcomes.push({ ...commit, stopId: stop.id, projectId: stop.projectId });
    }
    return outcomes;
  }
}
