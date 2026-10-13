import { CellExecFailed, CellStartFailed, SubstrateUnavailable } from "@ashara/execution-infra";

/**
 * execution-infra's MountPathRejected, recognised by its own name and typed fields because the
 * package index does not export the class.
 */
interface MountRefusal extends Error {
  readonly name: "MountPathRejected";
  readonly hostPath: string;
  readonly mountRoot: string;
  readonly reason: string;
}

/**
 * A failure of the substrate a stage ran on, never of the work under it: the operator's to fix,
 * so the item is Blocked with `environment_unavailable` and never reaches the failure classifier.
 * CellTeardownFailed is not one: no stage ends on it (execution-service's teardownCell logs it and
 * leaves the cell to teardownAll and reconcileOrphans).
 */
export type EnvironmentError = SubstrateUnavailable | CellStartFailed | CellExecFailed | MountRefusal;

function isMountRefusal(e: Error): e is MountRefusal {
  return (
    e.name === "MountPathRejected" &&
    "hostPath" in e && typeof e.hostPath === "string" &&
    "mountRoot" in e && typeof e.mountRoot === "string" &&
    "reason" in e && typeof e.reason === "string"
  );
}

/** The environment error `e` is, or null: decided by class (MountPathRejected by its name and fields), never by a message. */
export function environmentErrorOf(e: unknown): EnvironmentError | null {
  if (e instanceof SubstrateUnavailable || e instanceof CellStartFailed || e instanceof CellExecFailed) return e;
  if (e instanceof Error && isMountRefusal(e)) return e;
  return null;
}

/** What was unavailable, named for the operator; `cell` names the cell the stage ran on. */
export function unavailableOf(e: EnvironmentError, cell: string): string {
  if (e instanceof SubstrateUnavailable) return `container substrate (${e.binary})`;
  if (e instanceof CellStartFailed || e instanceof CellExecFailed) return cell;
  return `${cell} mount (${e.hostPath})`;
}
