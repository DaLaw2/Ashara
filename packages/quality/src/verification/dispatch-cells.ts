import { join } from "node:path";
import type { EnvironmentCheckScope, EnvironmentImages } from "@ashara/execution-infra";
import { checkoutsRoot } from "@ashara/execution-infra";
import type { VerificationCells, VerifiedDispatch } from "../dispatch-result.js";
import type { CheckCells } from "../task-checks.js";
import type { CellTeardown } from "./cell-teardown.js";

/** The ashara.role label of the post-merge check's cell. */
export const POST_MERGE_VERIFIER_ROLE = "verifier";
/** The ashara.role label of the cell a check task's checks are red-run in on main. */
export const RED_RUN_ROLE = "ci";

/** What a throwaway checkout of a dispatch is made for; each names its own directory. */
export type CheckoutPurpose =
  | "red-run"
  | "verify"
  | "verify-probe"
  | "post-merge-checks"
  | "delivered-on-main"
  | "delivered-sweep"
  | `run-checks-${number}`
  | `define-check-${number}`
  | `probe-foundation-${number}`
  | "environment-check"
  | "substrate-gate"
  | "foundation-build";

export interface DispatchCellsDeps {
  readonly config: { readonly workdirBase: string };
  readonly cells: VerificationCells;
  readonly attemptPolicy: { readonly perCommandTimeoutSeconds: number };
  readonly images: EnvironmentImages;
  readonly teardown: Pick<CellTeardown, "teardownCell">;
}

/** The cells and throwaway checkouts a dispatch's verification runs in: each from the dispatch's environment, each mounting one tree. */
export class DispatchCells {
  private readonly deps: DispatchCellsDeps;

  constructor(deps: DispatchCellsDeps) {
    this.deps = deps;
  }

  /** Cells for checks: from the dispatch's environment image, each mounting one throwaway checkout. */
  checkCells(d: VerifiedDispatch): CheckCells {
    const scope = this.environmentScope(d);
    return {
      targetProjectPath: d.targetProjectPath,
      createCell: scope.createCell,
      teardownCell: scope.teardownCell,
      timeoutSeconds: this.deps.attemptPolicy.perCommandTimeoutSeconds,
    };
  }

  /** A throwaway checkout of the dispatch, under the workdir base the substrate mounts from. */
  checkoutDir(d: VerifiedDispatch, purpose: CheckoutPurpose): string {
    return join(checkoutsRoot(this.deps.config.workdirBase), `${purpose}-${d.task.id}-${d.sessionId}`);
  }

  /** What an environment check of this dispatch reaches: its worktree, its project's images, and cells mounting a tree. */
  environmentScope(d: VerifiedDispatch): EnvironmentCheckScope {
    const { cells } = this.deps;
    const { task } = d;
    return {
      projectId: task.projectId,
      taskId: task.id,
      workDir: d.workDir,
      repo: d.repo,
      targetProjectPath: d.targetProjectPath,
      checkoutDir: (purpose) => this.checkoutDir(d, purpose),
      images: this.deps.images,
      // Shared label (`:z`): the task cell may still mount the same tree. Its `.git` is a throwaway
      // repository of the cell's own: the checkout's names host paths, and Z0's git reads that
      // repository after the cell ran.
      createCell: ({ image, role, hostPath }) =>
        cells.substrate.createCell({
          image,
          project: task.projectId,
          task: task.id,
          role,
          instance: cells.instance,
          mount: { hostPath, shared: true },
        }),
      teardownCell: (cell) => this.deps.teardown.teardownCell({ taskId: task.id, attempt: task.attempt }, cell),
    };
  }
}
