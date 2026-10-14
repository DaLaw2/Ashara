import { CellExecFailed, CellStartFailed, MountPathRejected, PodmanCommandFailed, SubstrateUnavailable } from "@ashara/execution-infra";
import { WorktreeCommitFailed } from "./workspace.js";

/**
 * A failure of the substrate a stage ran on, never of the work under it: the operator's to fix,
 * so the item is Blocked with `environment_unavailable` and never reaches the failure classifier.
 * CellTeardownFailed is not one: no stage ends on it (execution-service's teardownCell logs it and
 * leaves the cell to teardownAll and reconcileOrphans). WorktreeCommitFailed is Z0's own git
 * refusing to record the work on the host, which a re-dispatch would meet again.
 */
export type EnvironmentError =
  | SubstrateUnavailable
  | CellStartFailed
  | CellExecFailed
  | PodmanCommandFailed
  | MountPathRejected
  | WorktreeCommitFailed;

/** The environment error `e` is, or null: decided by class, never by a message. */
export function environmentErrorOf(e: unknown): EnvironmentError | null {
  if (
    e instanceof SubstrateUnavailable ||
    e instanceof CellStartFailed ||
    e instanceof CellExecFailed ||
    e instanceof PodmanCommandFailed ||
    e instanceof MountPathRejected ||
    e instanceof WorktreeCommitFailed
  ) {
    return e;
  }
  return null;
}

/** What was unavailable, named for the operator; `cell` names the cell the stage ran on. */
export function unavailableOf(e: EnvironmentError, cell: string): string {
  if (e instanceof SubstrateUnavailable) return `container substrate (${e.binary})`;
  if (e instanceof PodmanCommandFailed) return `container substrate (podman ${e.operation})`;
  if (e instanceof CellStartFailed || e instanceof CellExecFailed) return cell;
  if (e instanceof WorktreeCommitFailed) return `host git (${e.step} of the task worktree)`;
  return `${cell} mount (${e.hostPath})`;
}
