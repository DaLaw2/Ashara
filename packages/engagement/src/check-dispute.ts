import { projectBlockCause } from "@ashara/shared";
import type { ProjectBlockCause, ProjectId } from "@ashara/shared";

// An implementer and a check author who keep disagreeing about a check (ADR-074 addendum 2 d65 c):
// past the bound of disputes nothing in the team settles it, so the project is blocked for its
// owner and the Liaison, the only writer to the client, says so once, in plain words.

/** Engagement's persistence port: the block and its report, together. */
export interface CheckDisputeStore {
  /** Blocks the project and posts `report` only when this call blocked it; one already blocked keeps its first cause. */
  blockProjectWithReport(projectId: ProjectId, cause: ProjectBlockCause, report: string): Promise<"blocked" | "already-blocked">;
}

/** A dispute past the bound, as Delivery hands it to the Liaison. */
interface DisputeBound {
  readonly projectId: ProjectId;
  readonly taskTitle: string;
  readonly checkTaskId: string;
  readonly checkName: string;
  readonly reason: string;
  /** Disputes the check task has drawn, this one included. */
  readonly disputes: number;
  readonly bound: number;
}

/** What the core loop asks of the Liaison when a check's disputes pass their bound. */
export interface LiaisonCheckDisputes {
  blockOnDisputes(bound: DisputeBound): Promise<"blocked" | "already-blocked">;
}

/** The project's cause on record: which check task, how often, and the last dispute. */
class CheckDisputeBoundReached extends Error {
  constructor(readonly bound: DisputeBound) {
    super(
      `check task ${bound.checkTaskId}'s check ${JSON.stringify(bound.checkName)} was disputed ${bound.disputes} time(s), ` +
        `past the bound of ${bound.bound}; it is not reopened again. The last dispute: ${bound.reason}`,
    );
    this.name = "CheckDisputeBoundReached";
  }
}

/** Plain words: what stopped, why, and what the client can do. */
function disputeBoundReport(bound: DisputeBound): string {
  return [
    `Work on this project is paused. While building "${bound.taskTitle}", the developer found that one of the checks ` +
      `written to confirm it ("${bound.checkName}") cannot be passed by correct work, and the team has not been able ` +
      `to settle this after ${bound.disputes} attempts.`,
    `The developer's last explanation: ${bound.reason}`,
    `Nothing more will be built until this is resolved. If you can say what this part should do, send a change describing it.`,
  ].join("\n\n");
}

export class CheckDisputeReports implements LiaisonCheckDisputes {
  constructor(private readonly store: CheckDisputeStore) {}

  async blockOnDisputes(bound: DisputeBound): Promise<"blocked" | "already-blocked"> {
    const cause = projectBlockCause(new CheckDisputeBoundReached(bound));
    const result = await this.store.blockProjectWithReport(bound.projectId, cause, disputeBoundReport(bound));
    console.warn(`[liaison-check-dispute] project ${bound.projectId} ${result}: ${cause.reason}`);
    return result;
  }
}
