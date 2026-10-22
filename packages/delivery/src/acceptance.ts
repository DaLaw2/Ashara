import type { EventStoreRepository } from "@ashara/db";
import type { Logger, ProjectId, StepContainment } from "@ashara/shared";
import { containEach, describeErrorChain } from "@ashara/shared";
import { acceptanceUncoveredCause, projectBlockCause } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";
import type { AcceptanceSweeper, AcceptanceUncovered } from "./acl/quality-acl.js";
import type { WorkItemRepository } from "./domain/index.js";
import { giveUpAcceptanceDefect, openAcceptanceDefect, PlanningService, takeEvents } from "./domain/index.js";
import type { InterfaceDefect } from "./domain/index.js";
import { INFRASTRUCTURE_FAULT_BUDGET } from "./execution/halt-causes.js";

// Delivering -> Accepted: each cycle, every project
// whose plan has no open task and at least one goal task done gets one acceptance sweep on main
// HEAD, run by Z0 with no model. A sweep that passes makes the project Accepted when Quality finds
// it covers the contract (every guarantee in force that the contract does not mark not verifiable by
// Ashara judged pass), and nothing is dispatched for it again; the Liaison's delivered report
// follows. A passed sweep that leaves such a guarantee unjudged never makes it Accepted: the project
// stays active and halts on its own kind (acceptance_uncovered, never Ashara's fault), which only the
// operator ends, with each such guarantee and why named in the recorded cause, so the uncovered sweep
// is neither repeated every cycle nor read as acceptance. A sweep that fails is a defect,
// never Accepted: it opens a defect item given up at once, so the plan is repaired around it like
// any task given up. A sweep that could not run is counted on the project, durably
// (Quality's acceptance_sweep_faults), against the dispatch path's INFRASTRUCTURE_FAULT_BUDGET:
// within it, a substrate failure halts the project on infrastructure (resumed by itself once the substrate
// probe passes, then swept again), and any other fault opens a defect given up at once with the
// recorded cause, so the plan is repaired around it. The fault past the budget halts the project as
// undeliverable (category fault, which only the operator ends), with the recorded cause: a sweep
// that keeps failing to run never loops. Any other failure of one project's sweep, a store write included, is
// contained to that project (containEach).

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
  /** Every stored check the sweep could run, with how it ended; none when it ran nothing. */
  readonly checkOutcomes: Extract<Sweep, { readonly kind: "ran" }>["checkOutcomes"];
  readonly details: string;
}

/** The acceptance store; the composition root supplies it. */
export interface AcceptanceStore {
  readyForAcceptance(): Promise<readonly ReadyProject[]>;
  /**
   * Records a passed sweep that covers the contract in force, with the outcome of every stored check
   * it ran and each guarantee's evidence, and moves the project to accepted, together; "moved" when
   * it is no longer ready; Quality's uncovered outcome when a guarantee in force is not judged pass,
   * with nothing written.
   */
  recordAccepted(sweep: SweepRecord & { readonly mainCommit: string }): Promise<"accepted" | "moved" | AcceptanceUncovered>;
  /** Counts one sweep that could not run on the project (acceptance_sweep_faults); returns the count with it. */
  recordSweepFault(projectId: ProjectId): Promise<number>;
  /**
   * Records a failed sweep, with the outcome of every stored check it ran and each guarantee's
   * evidence, and the defect `writeDefect` writes, in the same transaction; "moved" when no longer ready.
   */
  recordDefect(sweep: FailedSweepRecord, writeDefect: (workItems: WorkItemRepository) => Promise<string>): Promise<"recorded" | "moved">;
}

interface AcceptanceDeps {
  readonly acceptance: AcceptanceStore;
  readonly acceptanceSweeper: Pick<AcceptanceSweeper, "sweepForAcceptance">;
  readonly projectRepo: { block(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked"> };
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  /** Each project's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly logger: Logger;
}

/** A ready project has no workspace: its completed tasks merged nowhere this process can sweep. */
class AcceptanceWorkspaceMissing extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`project ${projectId} is ready for its acceptance sweep but records no target workspace to sweep`);
    this.name = "AcceptanceWorkspaceMissing";
  }
}

/** A ready project's Completed product scaffold records no merge: the public interface file it wrote is unknown, so main cannot be compared with it. */
class ScaffoldMergeUnrecorded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly scaffoldTaskIds: readonly string[],
  ) {
    super(
      `project ${projectId} is ready for its acceptance sweep, but its Completed product scaffold(s) ${scaffoldTaskIds.join(", ")} ` +
        `record no merge commit, so the public interface file they wrote is not known and main's cannot be compared with it. ` +
        `The project halts until an operator repairs the record by hand: for each scaffold task, find the commit on the ` +
        `target's main that merged it, set it with ` +
        `UPDATE work_items SET merge_commit = '<commit>', merge_kind = 'merged' WHERE id = '<scaffold task id>', ` +
        `then return the project to work with npx tsx scripts/project.ts unblock ${projectId} --reason <what was repaired>`,
    );
    this.name = "ScaffoldMergeUnrecorded";
  }
}

/** The project's cause on record when its sweep passed but does not cover the contract in force. */
class AcceptanceSweepUncovered extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly mainCommit: string,
    readonly uncovered: AcceptanceUncovered,
  ) {
    super(
      `the acceptance sweep of project ${projectId} passed on main ${mainCommit}, but ${uncoveredDetail(uncovered)}${notVerifiableDetail(uncovered)}; ` +
        `a project is accepted only when every guarantee in force that Ashara can verify is judged pass, so it halts until the operator reviews it`,
    );
    this.name = "AcceptanceSweepUncovered";
  }
}

function uncoveredDetail({ coverage }: AcceptanceUncovered): string {
  switch (coverage.kind) {
    case "nothing-to-judge":
      return coverage.visionVersion === null
        ? "no contract is on record for it, so no guarantee is judged"
        : `vision v${coverage.visionVersion} holds no guarantee Ashara can verify, so none is judged`;
    case "unjudged":
      return (
        `vision v${coverage.visionVersion} holds guarantees not judged pass: ` +
        coverage.guarantees.map((each) => `${each.guaranteeId} (${each.verdict.kind === "unjudged" ? `unjudged, ${each.verdict.reason}` : each.verdict.kind})`).join(", ")
      );
  }
}

/** The guarantees outside coverage, which the contract marks not verifiable by Ashara; none named when there are none. */
function notVerifiableDetail({ coverage }: AcceptanceUncovered): string {
  return coverage.notVerifiable.length === 0 ? "" : ` (outside coverage, marked not verifiable by Ashara: ${coverage.notVerifiable.join(", ")})`;
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

/** A failed sweep's record: the stored checks it ran and saw fail, none when it ran none. */
type FailedSweepRecord = SweepRecord & { readonly failedChecks: Extract<Sweep, { readonly kind: "ran" }>["failedChecks"] };

/** Records a failed sweep with its defect, given up at once, and publishes the defect's events. */
async function recordDefect(deps: AcceptanceDeps, record: FailedSweepRecord, interfaceDefect: InterfaceDefect | null): Promise<void> {
  const defect = openAcceptanceDefect({ projectId: record.projectId, mainCommit: record.mainCommit, details: record.details, interfaceDefect });
  const outcome = await deps.acceptance.recordDefect(record, async (workItems) => {
    await PlanningService.createWorkItem(workItems, defect);
    giveUpAcceptanceDefect(defect, record);
    await PlanningService.saveWorkItem(workItems, defect, "Pending");
    return defect.id;
  });
  deps.logger.info(
    "delivery.acceptance-failed",
    `sweep on main ${record.mainCommit ?? "(unread)"} failed; ` +
      (outcome === "recorded" ? `defect ${defect.id} given up, the plan is repaired around it` : "the project moved, nothing recorded") +
      `:\n${record.details}`,
    { projectId: record.projectId, mainCommit: record.mainCommit, defectId: defect.id, outcome },
  );
  if (outcome !== "recorded") return;
  for (const event of takeEvents(defect)) {
    try {
      await deps.eventStore.publish(event);
    } catch (err) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the defect is recorded before its events are published; domain_events is an operator audit log (GET /events is the bearer route) that no verdict, counter, charge or client text reads: each reads state written in the transition's own transaction, work_item_transitions for starts and reopens
      deps.logger.warn("delivery.event-publish-failed", `defect ${defect.id}: an audit event could not be published (the defect is already recorded)`, {
        taskId: defect.id,
        site: "acceptance",
        eventType: event.eventType,
      }, err);
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
    deps.logger.error("delivery.project-halted", `project ${projectId} ${blocked} as undeliverable: ${err.message}`, { projectId, faults, result: blocked }, err);
    return;
  }
  const why = `sweep fault ${faults} of ${INFRASTRUCTURE_FAULT_BUDGET}`;
  if (sweep.kind === "unrunnable") {
    const cause: ProjectBlockCause = { ...projectBlockCause(sweep.error), category: "infrastructure" };
    const blocked = await deps.projectRepo.block(projectId, cause);
    deps.logger.warn(
      "delivery.project-halted",
      `project ${projectId} ${blocked} on infrastructure (${why}): the substrate failed under its acceptance sweep`,
      { projectId, faults, category: "infrastructure", result: blocked },
      sweep.error,
    );
    return;
  }
  await recordDefect(deps, {
    projectId,
    mainCommit: sweep.mainCommit,
    environmentVersion: null,
    checkedTasks: [],
    uncheckedTasks: [],
    checkOutcomes: [],
    failedChecks: [],
    details: `The acceptance run could not be carried out (${why}): ${describeErrorChain(sweep.error)}`,
  }, null);
}

/**
 * Runs the sweep of every ready project, each contained to its project (containEach); returns how
 * many became accepted.
 */
export async function runAcceptanceSweeps(deps: AcceptanceDeps): Promise<number> {
  const ready = await deps.acceptance.readyForAcceptance();
  const outcomes = await containEach(deps.containment, "acceptance", ready, (project) => ({ id: project.projectId, projectId: project.projectId }), (project) => sweepOne(deps, project));
  return outcomes.filter((outcome) => outcome === "accepted").length;
}

/** One ready project's sweep; "accepted" when it passed and the project became accepted by it. */
async function sweepOne(deps: AcceptanceDeps, ready: ReadyProject): Promise<"accepted" | "not-accepted"> {
  if (ready.workspacePath === null) {
    const halt = new AcceptanceWorkspaceMissing(ready.projectId);
    const cause = projectBlockCause(halt);
    const blocked = await deps.projectRepo.block(ready.projectId, cause);
    deps.logger.error("delivery.project-halted", `project ${ready.projectId} ${blocked}: ${cause.reason}`, {
      projectId: ready.projectId,
      errorClass: cause.errorClass,
      result: blocked,
    }, halt);
    return "not-accepted";
  }
  // A Completed scaffold with no merge on record is a gap in the record that no repair task and no
  // later sweep can fill: the sweep would fault the same way every cycle. So it halts the project
  // once, as a fault only the operator ends, with the scaffold named in the recorded cause.
  const unrecorded = ready.scaffoldMerges.filter((scaffold) => scaffold.mergeCommit === null).map((scaffold) => scaffold.taskId);
  if (unrecorded.length > 0) {
    const halt = new ScaffoldMergeUnrecorded(ready.projectId, unrecorded);
    const cause = projectBlockCause(halt);
    const blocked = await deps.projectRepo.block(ready.projectId, cause);
    deps.logger.error("delivery.project-halted", `project ${ready.projectId} ${blocked}: ${cause.reason}`, {
      projectId: ready.projectId,
      errorClass: cause.errorClass,
      result: blocked,
    }, halt);
    return "not-accepted";
  }
  const scaffolds = ready.scaffoldMerges.flatMap((scaffold) => (scaffold.mergeCommit === null ? [] : [{ taskId: scaffold.taskId, mergeCommit: scaffold.mergeCommit }]));
  const sweep = await deps.acceptanceSweeper.sweepForAcceptance(ready.projectId, ready.workspacePath, ready.goalTaskIds, scaffolds);
  if (sweep.kind !== "ran") {
    await routeSweepFault(deps, ready.projectId, sweep);
    return "not-accepted";
  }
  const record = {
    projectId: ready.projectId,
    mainCommit: sweep.mainCommit,
    environmentVersion: sweep.environmentVersion,
    checkedTasks: sweep.checkedTasks,
    uncheckedTasks: sweep.uncheckedTasks,
    checkOutcomes: sweep.checkOutcomes,
    details: sweep.details,
  };
  if (sweep.passed) {
    const outcome = await deps.acceptance.recordAccepted(record);
    if (typeof outcome !== "string") {
      const halt = new AcceptanceSweepUncovered(ready.projectId, sweep.mainCommit, outcome);
      const cause = acceptanceUncoveredCause(halt);
      const blocked = await deps.projectRepo.block(ready.projectId, cause);
      deps.logger.warn("delivery.project-halted", `project ${ready.projectId} ${blocked}: ${cause.reason}`, {
        projectId: ready.projectId,
        mainCommit: sweep.mainCommit,
        errorClass: cause.errorClass,
        result: blocked,
      }, halt);
      return "not-accepted";
    }
    deps.logger.info("delivery.acceptance-passed", `sweep on main ${sweep.mainCommit} passed; ${outcome}`, {
      projectId: ready.projectId,
      mainCommit: sweep.mainCommit,
      outcome,
    });
    return outcome === "accepted" ? "accepted" : "not-accepted";
  }
  const standing = sweep.publicInterface;
  await recordDefect(deps, { ...record, failedChecks: sweep.failedChecks }, standing.kind === "scaffold-placeholder" || standing.kind === "absent" ? standing : null);
  return "not-accepted";
}
