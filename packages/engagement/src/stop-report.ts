import type { ProjectId } from "@ashara/shared";

// The client's stop report: the terminal message (terminal-report.ts) that tells the client, once,
// what is on record as merged when work stopped at their request, around the guarantee table of the
// stop's terminal sweep. It is told only once that sweep is on record: one that could not run is
// retried within its bound, and once its retries are exhausted the sweep is recorded naming the
// fault, so the report then tells every guarantee unjudged with no sweep on a commit.

/**
 * A task with a commit on record and how that commit closed it:
 * null when the record predates merge kinds and does not say.
 */
export interface MergedTask {
  readonly title: string;
  readonly commit: string;
  readonly kind: "merged" | "already_delivered" | null;
}

/** A stop that stopped its project, whose report the client has not been sent. */
export interface DueStopReport {
  readonly stopId: string;
  readonly projectId: ProjectId;
  readonly merged: readonly MergedTask[];
  /** Whether Delivery had the project halted when the stop arrived. */
  readonly paused: boolean;
  /** Whether the project was already accepted when the stop arrived; null on a stop recorded before that was. */
  readonly accepted: boolean | null;
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

/** What the stop found of an acceptance, as recorded on it. */
function acceptedLine(accepted: boolean | null): string[] {
  if (accepted === null) return ["Whether this project had already been accepted when your request arrived is not on record."];
  return accepted
    ? ["This project had already been accepted when your request arrived: its acceptance stands, and stopping it undoes none of the delivered work."]
    : [];
}

/**
 * Plain words, only what is on record: that work stopped because the client asked, that a pause
 * already in place does not end the stop, that an acceptance already made stands, and each task with
 * a commit on record, the commit and how it closed the task. Never a claim that the plan is complete.
 * The guarantee table of the stop's terminal sweep follows (terminal-report.ts).
 */
export function stopReport(due: DueStopReport): { readonly before: readonly string[]; readonly after: readonly string[] } {
  const merged =
    due.merged.length === 0
      ? "No merged work is on record for this project."
      : `What is on main for this project, as recorded:\n${due.merged.map(mergedLine).join("\n")}`;
  return {
    before: [
      "Work on this project has stopped at your request. Ashara will not start any further work on it.",
      ...acceptedLine(due.accepted),
      ...(due.paused
        ? [
            "Work on it was already paused when your request arrived. Your request is recorded: the project stays " +
              "stopped, and clearing what paused it does not restart it.",
          ]
        : []),
      merged,
    ],
    after: [],
  };
}
