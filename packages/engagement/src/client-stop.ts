import { containEach } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted } from "@ashara/shared";

// The client's stop. The web
// client's Stop promises a halt; the Liaison, the only writer to the client,
// keeps it: each cycle, before any intake, planning or dispatch, it consumes the
// open stops and moves each project to 'stopped'. The client is told once what is
// on record as merged and how each guarantee stands on main by the stop report, a
// terminal message (terminal-report.ts) posted after the cycle's terminal sweeps,
// the commands-only run of the stored checks on main.
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
// report says so. A stop of a project already accepted moves it to 'stopped' too, and its report
// says the acceptance stands.

/** An inbound stop not yet consumed. */
interface OpenStop {
  readonly id: string;
  readonly projectId: ProjectId;
}

type ClientStopCommit =
  /** `reportDue` is false only when a stop report already exists (an operator re-activated a stopped project). */
  | { readonly kind: "stopped"; readonly reportDue: boolean }
  | { readonly kind: "already-stopped" };

/** Engagement's persistence port for client stops. */
export interface ClientStopStore {
  openStops(): Promise<readonly OpenStop[]>;
  /**
   * Consumes the stop and, unless the project is already stopped, stops it and records whether it
   * was paused or accepted when the stop arrived, in one transaction.
   */
  recordStop(stop: OpenStop): Promise<ClientStopCommit>;
}

type ClientStopOutcome = ClientStopCommit & { readonly stopId: string; readonly projectId: ProjectId };

/** What the core loop asks of the Liaison: the stops at the top of each cycle. */
export interface LiaisonClientStops {
  runPending(): Promise<ReadonlyArray<ClientStopOutcome | StepFaulted>>;
}

export class ClientStops implements LiaisonClientStops {
  constructor(
    private readonly store: ClientStopStore,
    /** Each stop's own fault is contained to it (containEach). */
    private readonly containment: StepContainment,
  ) {}

  /**
   * The open stops. A second stop on a stopped project is consumed with no second stop report: the
   * client already holds, or is owed, the stop report, and its receipt (client-receipt.ts) says this
   * stop changes nothing. A stop whose
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
}
