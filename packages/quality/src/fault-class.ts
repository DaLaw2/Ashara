import { CellExecFailed, CellStartFailed, CellToolFailed, MountPathRejected, PodmanCommandFailed, SubstrateUnavailable } from "@ashara/execution-infra";
import { describeErrorChain } from "@ashara/shared";

/**
 * Whose a failure is (ADR-080 d3 c), the one classification every failure of a dispatch is routed by:
 * - `agent_work`: the implementer's or author's own product failed its verdict (a check, a gate, a
 *   conflict left in it, an attempt that ended without done). Only this is charged to the task's
 *   attempts and recorded as a lesson.
 * - `ashara`: Ashara's own Z0 machinery failed (its process, a store, git on the host, a bug in it).
 * - `substrate`: the machines the work runs on failed (podman, an image build, a cell).
 * - `provider`: the model provider failed a request of the work (a 5xx, timeout or throttling
 *   status, no answer: modelCallFailureOf "provider"), so no answer of the model was read.
 * The last three say nothing about the work: each blocks or is retried under its class, uncharged
 * and never taught to the agent. A throw is never the agent's work: the agent's work fails as a
 * verdict, so a throw is the substrate's or the provider's when its class says so and Ashara's
 * otherwise (fail-closed).
 */
export type FaultClass = "agent_work" | "ashara" | "substrate" | "provider";

/**
 * A failure of the substrate a stage ran on, never of the work under it: the operator's to fix,
 * so the item is Blocked with `environment_unavailable` and never reaches the failure classifier.
 * CellTeardownFailed is not one: no stage ends on it (TaskVerification's teardownCell logs it and
 * leaves the cell to teardownAll and reconcileOrphans).
 */
export type EnvironmentError = SubstrateUnavailable | CellStartFailed | CellExecFailed | PodmanCommandFailed | MountPathRejected | CellToolFailed;

/**
 * The environment error `e` is, or null: decided by class, never by a message. A CellToolFailed is
 * the substrate's only with no exit code (the host backstop killed the podman client: the cell
 * hung, not the command); with one, the command itself answered.
 */
export function environmentErrorOf(e: unknown): EnvironmentError | null {
  if (
    e instanceof SubstrateUnavailable ||
    e instanceof CellStartFailed ||
    e instanceof CellExecFailed ||
    e instanceof PodmanCommandFailed ||
    e instanceof MountPathRejected ||
    (e instanceof CellToolFailed && e.exitCode === null)
  ) {
    return e;
  }
  return null;
}

/** What was unavailable, named for the operator; `cell` names the cell the stage ran on. */
export function unavailableOf(e: EnvironmentError, cell: string): string {
  if (e instanceof SubstrateUnavailable) return `container substrate (${e.binary})`;
  if (e instanceof PodmanCommandFailed) return `container substrate (podman ${e.operation})`;
  if (e instanceof MountPathRejected) return `${cell} mount (${e.hostPath})`;
  return cell;
}

/**
 * Ashara's own Z0 machinery failed while it dispatched a task (a store, git on the host, a bug in
 * it), outside the verification of the work (gates/finalize.ts VerificationInfrastructureFault):
 * nothing is known of the agent's work, so the task is blocked under class `ashara`.
 */
export class DispatchFault extends Error {
  constructor(
    readonly taskId: string,
    /** What Z0 was doing when it failed, e.g. "create the task worktree". */
    readonly step: string,
    options: { readonly cause: unknown },
  ) {
    super(`Ashara's own machinery failed dispatching task ${taskId}: ${step} failed: ${describeErrorChain(options.cause)}`, { cause: options.cause });
    this.name = "DispatchFault";
  }
}

/** A throw out of a stage of a dispatch, by class: never `agent_work` (see FaultClass). */
type ThrownFault =
  | { readonly class: "substrate"; readonly error: EnvironmentError }
  | { readonly class: "ashara"; readonly error: unknown };

export function thrownFaultOf(e: unknown): ThrownFault {
  const substrate = environmentErrorOf(e);
  return substrate !== null ? { class: "substrate", error: substrate } : { class: "ashara", error: e };
}
