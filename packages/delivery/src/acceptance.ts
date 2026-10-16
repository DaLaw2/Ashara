import type { EventStoreRepository } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import { projectBlockCause } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";
import type { TaskVerification } from "./acl/quality-acl.js";
import type { WorkItemRepository } from "./domain/index.js";
import { giveUpAcceptanceDefect, openAcceptanceDefect, PlanningService, takeEvents } from "./domain/index.js";
import type { PlaceholderInterface } from "./domain/index.js";
import { INFRASTRUCTURE_FAULT_BUDGET } from "./execution.js";

// Delivering -> Accepted (story s-independent-verify-m1 W7, design P11): each cycle, every project
// whose plan has no open task and at least one goal task done gets one acceptance sweep on main
// HEAD, run by Z0 with no model. A sweep that passes makes the project Accepted, and nothing is
// dispatched for it again; the Liaison's delivered report follows. A sweep that fails is a defect,
// never Accepted: it opens a defect item given up at once, so the plan is repaired around it like
// any task given up. A sweep that could not run is counted on the project, durably
// (projects.acceptance_faults), against the dispatch path's INFRASTRUCTURE_FAULT_BUDGET: within it,
// a substrate failure halts the project on infrastructure (resumed by itself once the substrate
// probe passes, then swept again), and any other fault opens a defect given up at once with the
// recorded cause, so the plan is repaired around it. The fault past the budget halts the project as
// undeliverable (category fault, which only the operator ends), with the recorded cause: a sweep
// that keeps failing to run never loops. A store read that fails throws out of the cycle.

/** A project ready for its sweep, as the acceptance store lists it. */
interface ReadyProject {
  readonly projectId: ProjectId;
  readonly workspacePath: string | null;
  readonly goalTaskIds: readonly string[];
  /** Its Completed product scaffolds and their recorded merges: the public interface file main must have moved on from. */
  readonly scaffoldMerges: ReadonlyArray<{ readonly taskId: string; readonly mergeCommit: string | null }>;
}

/** What one sweep recorded, whatever its verdict. */
interface SweepRecord {
  readonly projectId: ProjectId;
  /** null only for a sweep that faulted before main could be read. */
  readonly mainCommit: string | null;
  readonly environmentVersion: string | null;
  readonly checkedTasks: readonly string[];
  /** Completed implementation tasks with no stored check, which the sweep could not re-run. */
  readonly uncheckedTasks: readonly string[];
  readonly details: string;
}

/** The acceptance store (migration 049); the composition root supplies it. */
export interface AcceptanceStore {
  readyForAcceptance(): Promise<readonly ReadyProject[]>;
  /** Records a passed sweep and moves the project to accepted, together; "moved" when it is no longer ready. */
  recordAccepted(sweep: SweepRecord & { readonly mainCommit: string }): Promise<"accepted" | "moved">;
  /** Counts one sweep that could not run on the project (projects.acceptance_faults); returns the count with it. */
  recordSweepFault(projectId: ProjectId): Promise<number>;
  /** Records a failed sweep with the defect `writeDefect` writes in the same transaction; "moved" when no longer ready. */
  recordDefect(sweep: SweepRecord, writeDefect: (workItems: WorkItemRepository) => Promise<string>): Promise<"recorded" | "moved">;
}

interface AcceptanceDeps {
  readonly acceptance: AcceptanceStore;
  readonly acceptanceSweeper: Pick<TaskVerification, "sweepForAcceptance">;
  readonly projectRepo: { block(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked"> };
  readonly eventStore: Pick<EventStoreRepository, "publish">;
}

/** A ready project has no workspace: its completed tasks merged nowhere this process can sweep. */
class AcceptanceWorkspaceMissing extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`project ${projectId} is ready for its acceptance sweep but records no target workspace to sweep`);
    this.name = "AcceptanceWorkspaceMissing";
  }
}

/** The project's cause on record when its acceptance sweep failed to run past the fault budget. */
class AcceptanceFaultBudgetSpent extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly faults: number,
    readonly lastFault: Error,
  ) {
    super(
      `the acceptance sweep of project ${projectId} could not run ${faults} time(s), past the budget of ` +
        `${INFRASTRUCTURE_FAULT_BUDGET}; the project halts as undeliverable until the operator repairs it. ` +
        `The last fault: ${describeErrorChain(lastFault)}`,
      { cause: lastFault },
    );
    this.name = "AcceptanceFaultBudgetSpent";
  }
}

type Sweep = Awaited<ReturnType<AcceptanceDeps["acceptanceSweeper"]["sweepForAcceptance"]>>;

/** Records a failed sweep with its defect, given up at once, and publishes the defect's events. */
async function recordDefect(deps: AcceptanceDeps, record: SweepRecord, placeholderInterface: PlaceholderInterface | null): Promise<void> {
  const defect = openAcceptanceDefect({ projectId: record.projectId, mainCommit: record.mainCommit, details: record.details, placeholderInterface });
  const outcome = await deps.acceptance.recordDefect(record, async (workItems) => {
    await PlanningService.createWorkItem(workItems, defect);
    giveUpAcceptanceDefect(defect, record);
    await PlanningService.saveWorkItem(workItems, defect, "Pending");
    return defect.id;
  });
  console.warn(
    `[acceptance] project ${record.projectId}: sweep on main ${record.mainCommit ?? "(unread)"} failed; ` +
      (outcome === "recorded" ? `defect ${defect.id} given up, the plan is repaired around it` : "the project moved, nothing recorded") +
      `:\n${record.details}`,
  );
  if (outcome !== "recorded") return;
  for (const event of takeEvents(defect)) {
    try {
      await deps.eventStore.publish(event);
    } catch (err) {
      console.warn(`[acceptance] defect ${defect.id}: an audit event could not be published (the defect is already recorded):`, err);
    }
  }
}

/**
 * A sweep that could not run, counted against the budget: within it a substrate failure halts the
 * project on infrastructure and any other fault is a defect given up for a repair; past it the
 * project halts as undeliverable. Every path writes the recorded cause.
 */
async function routeSweepFault(deps: AcceptanceDeps, projectId: ProjectId, sweep: Extract<Sweep, { readonly kind: "unrunnable" | "faulted" }>): Promise<void> {
  const faults = await deps.acceptance.recordSweepFault(projectId);
  if (faults > INFRASTRUCTURE_FAULT_BUDGET) {
    const err = new AcceptanceFaultBudgetSpent(projectId, faults, sweep.error);
    const blocked = await deps.projectRepo.block(projectId, projectBlockCause(err));
    console.warn(`[acceptance] project ${projectId} ${blocked} as undeliverable: ${err.message}`);
    return;
  }
  const why = `sweep fault ${faults} of ${INFRASTRUCTURE_FAULT_BUDGET}`;
  if (sweep.kind === "unrunnable") {
    const cause: ProjectBlockCause = { ...projectBlockCause(sweep.error), category: "infrastructure" };
    const blocked = await deps.projectRepo.block(projectId, cause);
    console.warn(`[acceptance] project ${projectId} ${blocked} on infrastructure (${why}): the substrate failed under its acceptance sweep: ${describeErrorChain(sweep.error)}`);
    return;
  }
  await recordDefect(deps, {
    projectId,
    mainCommit: sweep.mainCommit,
    environmentVersion: null,
    checkedTasks: [],
    uncheckedTasks: [],
    details: `The acceptance run could not be carried out (${why}): ${describeErrorChain(sweep.error)}`,
  }, null);
}

/** Runs the sweep of every ready project; returns how many became accepted. */
export async function runAcceptanceSweeps(deps: AcceptanceDeps): Promise<number> {
  let accepted = 0;
  for (const ready of await deps.acceptance.readyForAcceptance()) {
    if (ready.workspacePath === null) {
      const cause = projectBlockCause(new AcceptanceWorkspaceMissing(ready.projectId));
      const blocked = await deps.projectRepo.block(ready.projectId, cause);
      console.warn(`[acceptance] project ${ready.projectId} ${blocked}: ${cause.reason}`);
      continue;
    }
    const sweep = await deps.acceptanceSweeper.sweepForAcceptance(ready.projectId, ready.workspacePath, ready.goalTaskIds, ready.scaffoldMerges);
    if (sweep.kind !== "ran") {
      await routeSweepFault(deps, ready.projectId, sweep);
      continue;
    }
    const record = {
      projectId: ready.projectId,
      mainCommit: sweep.mainCommit,
      environmentVersion: sweep.environmentVersion,
      checkedTasks: sweep.checkedTasks,
      uncheckedTasks: sweep.uncheckedTasks,
      details: sweep.details,
    };
    if (sweep.passed) {
      const outcome = await deps.acceptance.recordAccepted(record);
      if (outcome === "accepted") accepted++;
      console.log(`[acceptance] project ${ready.projectId}: sweep on main ${sweep.mainCommit} passed; ${outcome}`);
      continue;
    }
    await recordDefect(deps, record, sweep.publicInterface.kind === "scaffold-placeholder" ? sweep.publicInterface : null);
  }
  return accepted;
}
