import { containEach, describeErrorChain } from "@ashara/shared";
import type { Logger, ProjectId, StepContainment } from "@ashara/shared";
import { higherCapability, withStructuredLadder } from "./acl/finance-acl.js";
import type { CapabilityLevel, LadderAttemptEvent } from "./acl/finance-acl.js";
import { projectBlockCause, recordedFailureOf } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";
import { VisionChangeRefused, VisionUnreadable, planningVisionOf } from "./acl/engagement-acl.js";
import { modelCallFailureOf } from "./acl/finance-acl.js";
import type { ContextualLlm, ModelCallFailure } from "./acl/finance-acl.js";
import { RosterUnreadable, WorkKindOwnerUnresolved } from "./acl/organization-acl.js";
import type { PlanningVision } from "./acl/engagement-acl.js";
import { DecompositionEngine } from "./decomposition.js";
import { VisionItemsMissing } from "./decomposition-types.js";
import type { DecompositionInput, DecompositionResult, EnvironmentPlanning, VisionItem } from "./decomposition-types.js";
import { planOwners } from "./first-plan.js";
import { createGatewayDecompositionLLM } from "./gateway-adapters.js";
import type { AbandonedTask, PlanRevisionWrite, PlannedItem, ProjectAwaitingReplan, ReplanOutcome, ReplanStore, Replanning, RevisionCause, RevisionFailure } from "./replan-port.js";
import { EnvironmentJudgmentSchema, causeSection, doneSection, environmentPrompt, judgmentReask } from "./replan-prompts.js";
import { RepairSubjectUnreadable, RevisionUnasked, affectedKeys, causeOf, decisionOf } from "./revision-cause.js";
import { checkedByDone, correctionScope, isEnvironmentTask, isTask, layoutOf, stillToCheck, wholePlanScope } from "./revision-scope.js";
import { composeRevision } from "./revision-write.js";

// Delivery's revision of a plan already under way, asked for in one of two ways. A client's
// correction (a change, a confirmed proposal, or an answer that changed an assumption) holds only the
// tasks citing a guarantee or assumption key it affects (correction_holds): each is parked whenever it
// is Pending, and one in progress finishes its attempt and may merge; the rest of the project goes on dispatching; every correction
// awaiting a revision is taken in by the next one, and its report names each, since each was promised
// the client would hear what it changed. Once no task citing an affected key is in progress, only the
// affected keys and the items of the work replaced are planned again: the open tasks citing an
// affected key, and the open tasks waiting on them, are superseded; merged work citing one (Completed,
// or Blocked as merge_unrecorded) is kept, and its key, as the vision now states it, gets a new task. A task given up, for any cause
// (the failure router's attempt bound, a dispute or review bound, the environment-change bound, an
// unsatisfiable dependency), opens a plan repair, which stops the project's dispatch: no person
// releases its dependents. Once no task of the project is in progress, the current vision is
// decomposed again with the completed work and the given-up work and its evidence as context:
// merged work is kept, open work (not started, Blocked or Failed, and the Epic that held it) is
// superseded. Either way the new tasks build on the environment already set up unless an
// environment change is needed. Revision, supersession and what it took in commit together; the
// Liaison reports the revision from what is recorded.

/** Failed attempts to revise the plan for one request after which Delivery stops and blocks the project. */
const MAX_REPLAN_ATTEMPTS = 3;

/** Revisions for client corrections Delivery writes before the operator reviews the project; the next one blocks it. */
const MAX_REVISIONS_PER_REVIEW = 3;

/**
 * Plan repairs Delivery writes before the project halts as undeliverable (R = 2):
 * past it the same work is being given up again, and the next give-up halts the
 * project (a plan_repair block) with one report naming the work given up and why. Counted since the
 * owner last reviewed such a halt.
 */
const MAX_REPAIRS_PER_REVIEW = 2;

/** The project's plan was revised its bound of times since the operator last reviewed it. */
class ReplanBoundReached extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly revisions: number,
    readonly messages: readonly string[],
  ) {
    super(
      `project ${projectId}: the plan was revised ${revisions} time(s) for client corrections since the operator last ` +
        `reviewed it, the bound of ${MAX_REVISIONS_PER_REVIEW}; the correction(s) of message(s) ${messages.join(", ")} are not ` +
        `planned until the operator reviews the project and unblocks it`,
    );
    this.name = "ReplanBoundReached";
  }
}

/** The project's plan was repaired its bound of times since the operator last reviewed it, and a task was given up again. */
class PlanRepairBoundReached extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly repairs: number,
    readonly abandoned: readonly AbandonedTask[],
  ) {
    super(
      `project ${projectId}: the plan was repaired ${repairs} time(s) since the operator last reviewed it, the bound of ` +
        `${MAX_REPAIRS_PER_REVIEW}, and the team gave up again: ` +
        abandoned.map((task) => `"${task.title}" (${task.id}) after ${task.attempts} attempt(s): ${firstLine(task.evidence)}`).join("; ") +
        `; the project halts as undeliverable: the remaining work is not planned again until the client changes ` +
        `the scope or the owner reviews the project and unblocks it`,
    );
    this.name = "PlanRepairBoundReached";
  }
}

/**
 * The halt an exhausted revision records, by whose failure its last attempt was: the cycle that
 * counted it classified it (modelCallFailureOf), and a later cycle reads it back from the record
 * (recordedFailureOf), so both halt the same. A last failure that names no party is Ashara's (`fault`).
 * @testseam exported for the integration fault-classifiers.test.ts; Replanner.revise is its production caller
 */
export function exhaustedRevisionCause(projectId: ProjectId, attempts: number, lastError: string, failure: ModelCallFailure): ProjectBlockCause {
  const cause = projectBlockCause(new ReplanAttemptsExhausted(projectId, attempts, lastError, failure));
  switch (failure) {
    case "model":
      return { ...cause, category: "replan_stopped" };
    case "provider":
      return { ...cause, category: "replan_provider_failed" };
    case "ashara":
      return cause;
  }
}

/**
 * Revising the plan failed on every attempt: the change is not planned, and the old plan is not
 * dispatched past it. `failure` is whose failure the last attempt was.
 */
class ReplanAttemptsExhausted extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly attempts: number,
    readonly lastError: string,
    readonly failure: ModelCallFailure,
  ) {
    super(`project ${projectId}: the plan could not be revised after ${attempts} attempt(s); last error: ${lastError}`);
    this.name = "ReplanAttemptsExhausted";
  }
}

/**
 * The project has spent its revision attempts but holds no error for them. A database CHECK
 * constraint makes this unrepresentable; meeting it means the store lied.
 */
class ReplanFailureUnrecorded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly attempts: number,
  ) {
    super(`project ${projectId} has ${attempts} failed plan revision attempts but no recorded error`);
    this.name = "ReplanFailureUnrecorded";
  }
}

/**
 * A completed task whose work a revision judges carries no capability level in its task_spec: no
 * judge can be asked at or above work whose tier is unknown, so nothing is judged.
 */
class JudgedTaskUngraded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly taskId: string,
    readonly origin: string | undefined,
  ) {
    super(
      `project ${projectId}: task ${taskId} (origin ${origin ?? "unrecorded"}) carries no capability level in its task_spec; ` +
        `the revision cannot ask a judge of its work at or above it`,
    );
    this.name = "JudgedTaskUngraded";
  }
}

function firstLine(text: string): string {
  // split returns at least one element, the whole text when it holds no newline.
  return text.split("\n")[0];
}

interface ReplannerDeps {
  readonly llm: ContextualLlm;
  readonly store: ReplanStore;
  /** Each project's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
  readonly logger: Logger;
  /** Aborted on shutdown: every model call this step sends is cancelled with it (StructuredRequest.abortSignal). */
  readonly shutdownSignal: AbortSignal;
}

/**
 * Delivery's plan revision step. Each project awaiting a revision that has no task in progress is
 * revised through recorded `decomposition` calls and written whole or not at all. A failed
 * attempt writes nothing and is counted; at the cap, and when the project's revisions or repairs
 * reach their bound, the project is blocked, so the loop neither spins on it nor revises without end.
 */
export class Replanner implements Replanning {
  constructor(private readonly deps: ReplannerDeps) {}

  /**
   * A project whose own record cannot be revised is blocked, and the other projects are still
   * revised. Any other failure that escapes an attempt, a store failure included, is that
   * project's, contained to it (containEach).
   */
  async runPending(): Promise<readonly ReplanOutcome[]> {
    const projects = await this.deps.store.projectsAwaitingReplan();
    return containEach(this.deps.containment, "replan", projects, (project) => ({ id: project.projectId, projectId: project.projectId }), async (project) => {
      try {
        return await this.revise(project);
      } catch (err) {
        const projectRecord =
          err instanceof ReplanFailureUnrecorded ||
          err instanceof RevisionUnasked ||
          err instanceof RepairSubjectUnreadable ||
          err instanceof RosterUnreadable ||
          err instanceof WorkKindOwnerUnresolved ||
          err instanceof VisionUnreadable ||
          err instanceof VisionChangeRefused ||
          err instanceof VisionItemsMissing;
        if (!projectRecord) throw err;
        return this.block(project.projectId, projectBlockCause(err));
      }
    });
  }

  private async block(projectId: ProjectId, cause: ProjectBlockCause): Promise<ReplanOutcome> {
    const result = await this.deps.store.blockProject(projectId, cause);
    this.deps.logger.info("delivery.project-blocked", `${cause.errorClass}; project ${projectId} ${result}: ${cause.reason}`, {
      projectId,
      step: "replan",
      category: cause.category,
      errorClass: cause.errorClass,
      result,
    });
    return { kind: "project-blocked", projectId, cause };
  }

  private async revise(project: ProjectAwaitingReplan): Promise<ReplanOutcome> {
    const { projectId } = project;
    const cause = causeOf(project);
    if (cause.kind === "client-change" && project.revisionsSinceReview >= MAX_REVISIONS_PER_REVIEW) {
      const err = new ReplanBoundReached(projectId, project.revisionsSinceReview, cause.changes.map((change) => change.requestedBy));
      return this.block(projectId, { ...projectBlockCause(err), category: "replan_bound" });
    }
    if (cause.kind === "repair" && project.repairsSinceReview >= MAX_REPAIRS_PER_REVIEW) {
      const err = new PlanRepairBoundReached(projectId, project.repairsSinceReview, cause.abandoned);
      return this.block(projectId, { ...projectBlockCause(err), category: "plan_repair" });
    }
    if (project.replanAttempts >= MAX_REPLAN_ATTEMPTS) {
      if (project.replanLastError === null) throw new ReplanFailureUnrecorded(projectId, project.replanAttempts);
      const failure = recordedFailureOf(project.replanLastFailure);
      return this.block(projectId, exhaustedRevisionCause(projectId, project.replanAttempts, project.replanLastError, failure));
    }

    const owners = planOwners(projectId, project.rosterRows);
    // Read before the counted attempt: VisionUnreadable throws through to runPending, which blocks.
    const vision = planningVisionOf(project.vision);
    const completed = project.items.filter(isTask).filter(({ item }) => item.status === "Completed");
    const checked = checkedByDone(completed, cause);
    const scope =
      cause.kind === "client-change" ? correctionScope(project, affectedKeys(cause.changes), vision, checked) : wholePlanScope(project, vision);
    // The store lists a project only with no such task in progress; one seen here started since. Nothing
    // is drawn before this return: the revision waits on a dispatch, which ends by its own bounds.
    if (scope.waitsOn !== null) return { kind: "moved", projectId };
    // A correction whose replaced work leaves nothing to check unplanned (a withdrawn guarantee, an
    // assumption no check rests on) is written with no new task and no model call.
    const nothingToPlan = cause.kind === "client-change" && stillToCheck(scope.planned, checked).length === 0;

    let write: PlanRevisionWrite;
    let result: "written" | "moved";
    try {
      let planned: { readonly decomposition: DecompositionResult; readonly environment: EnvironmentPlanning } | null = null;
      if (!nothingToPlan) {
        const environment = await this.environmentOf(project, cause, completed, vision);
        planned = { decomposition: await this.decompose(project, vision, scope.planned, cause, completed, environment), environment };
      }
      write = composeRevision({ project, cause, vision, planned, owners, completed, scope });
      result = await this.deps.store.writeRevision(write);
    } catch (err) {
      // Only the model's or its provider's failure is a failed revision attempt. Ashara's own (a
      // refusal before the call, a store write that failed, a request built wrong, a fault nothing
      // names) never counts toward the bound: a spend cap's refusal is the core loop's step's, any
      // other is contained to this project (containEach), or blocks it when it is the project's record.
      const failure = modelCallFailureOf(err);
      if (failure === "ashara") throw err;
      return this.fail(project, err, failure);
    }
    // Revised again next cycle, uncounted: the work ledger bounds it, since every
    // decomposition draws from the project's budget, which halts the project as work_budget when spent.
    if (result === "moved") return { kind: "moved", projectId };
    const why =
      cause.kind === "client-change"
        ? `the correction(s) of message(s) ${cause.changes.map((change) => change.requestedBy).join(", ")}`
        : `given-up task(s) ${cause.abandoned.map((task) => task.id).join(", ")}`;
    this.deps.logger.info("delivery.revision-written", `revision ${write.revision} written for ${why}`, { projectId, revision: write.revision, cause: cause.kind });
    return {
      kind: "revised",
      projectId,
      revision: write.revision,
      cause: cause.kind,
      tasks: write.plan.items.filter((item) => item.level === "Task").length,
      superseded: write.summary.supersededTasks.length + write.summary.supersededOther,
      newEnvironment: write.summary.newEnvironmentTask,
    };
  }

  /**
   * The environment the revision builds on: the latest completed environment task, unless the
   * cause needs an environment change; a new environment task when none is completed. Whether it
   * still serves judges the environment task's work, so a judge of work at that work's tier is asked.
   */
  private async environmentOf(
    project: ProjectAwaitingReplan,
    cause: RevisionCause,
    completed: readonly PlannedItem[],
    vision: PlanningVision,
  ): Promise<EnvironmentPlanning> {
    const environments = completed.filter(({ item }) => isEnvironmentTask(item));
    const current = environments[environments.length - 1];
    if (current === undefined) return { kind: "new" };
    const provider = withStructuredLadder(
      this.deps.llm.forCall({ projectId: project.projectId, taskId: null, callSite: "decomposition" }),
      { site: "decomposition", attempts: 2, onAttempt: this.deps.onAttempt, reask: judgmentReask },
    );
    const response = await provider.generateStructured({
      judges: this.judgedTierOf(project.projectId, current),
      prompt: environmentPrompt(cause, current.environmentStatement, vision),
      schema: EnvironmentJudgmentSchema,
      maxTokens: 512,
      abortSignal: this.deps.shutdownSignal,
    });
    this.deps.logger.info("delivery.environment-judged", `environment change ${response.data.environmentChange}: ${response.data.reason}`, {
      projectId: project.projectId,
      environmentChange: response.data.environmentChange,
    });
    return response.data.environmentChange ? { kind: "new" } : { kind: "existing", taskId: current.item.id };
  }

  /**
   * The tier of a completed task's work: the higher of the grade it was planned at and the grade of
   * the model that did it, since either alone can understate the work. With no model on record the
   * planned grade stands alone, and the record says so.
   */
  private judgedTierOf(projectId: ProjectId, done: PlannedItem): CapabilityLevel {
    const planned = done.item.taskSpec?.capability;
    if (planned === undefined) throw new JudgedTaskUngraded(projectId, done.item.id, done.item.taskSpec?.origin);
    const attempt = done.attemptGrade;
    if (attempt.kind === "graded") return higherCapability(planned, attempt.grade);
    this.deps.logger.warn(
      "delivery.judged-tier-unrecorded",
      `task ${done.item.id} is judged at its planned grade ${planned} alone: ${attempt.why}`,
      { projectId, taskId: done.item.id, plannedGrade: planned },
    );
    return planned;
  }

  private async decompose(
    project: ProjectAwaitingReplan,
    vision: PlanningVision,
    planned: readonly VisionItem[],
    cause: RevisionCause,
    completed: readonly PlannedItem[],
    environment: EnvironmentPlanning,
  ): Promise<DecompositionResult> {
    const llm = createGatewayDecompositionLLM(
      this.deps.llm.forCall({ projectId: project.projectId, taskId: null, callSite: "decomposition" }),
      this.deps.shutdownSignal,
      this.deps.onAttempt,
    );
    const northStar = [vision.northStar, causeSection(cause, vision), doneSection(completed)].join("\n\n");
    const input: DecompositionInput = {
      epicTitle: project.projectName,
      epicNorthStar: northStar,
      epicDescription: vision.visionText,
      priorEpicResults:
        completed.length === 0
          ? []
          : [
              {
                epicId: "done",
                title: "Work already done",
                completedStories: completed.map(({ item }) => item.title),
                keyDecisions: cause.kind === "client-change" ? cause.changes.map((change) => decisionOf(change, vision)) : [],
                deliveredCapabilities: [],
              },
            ],
      environment,
      layout: layoutOf(completed),
      // The same rule as a first plan: every new task traces to the current vision, here to the items
      // the revision plans again (for a repair, all of them).
      visionItems: planned,
      interface: vision.interface,
      checkedItems: checkedByDone(completed, cause),
      assumptionKeys: vision.assumptionKeys,
    };
    return new DecompositionEngine(llm).decompose(input);
  }

  private async fail(project: ProjectAwaitingReplan, err: unknown, failure: RevisionFailure): Promise<ReplanOutcome> {
    const { projectId } = project;
    const error = describeErrorChain(err);
    const attempt = await this.deps.store.recordFailedAttempt(projectId, error, failure);
    const asked =
      project.correctionsAwaited.length > 0
        ? `the correction(s) of message(s) ${project.correctionsAwaited.map((correction) => correction.requestedBy).join(", ")}`
        : `repair of ${project.repairsAwaited.join(", ")}`;
    this.deps.logger.warn("delivery.replan-attempt-failed", `(vision v${project.vision.version}, ${asked}): attempt ${attempt}/${MAX_REPLAN_ATTEMPTS} failed`, {
      projectId,
      attempt,
      visionVersion: project.vision.version,
    }, err);
    if (attempt < MAX_REPLAN_ATTEMPTS) return { kind: "failed", projectId, attempt, error };
    return this.block(projectId, exhaustedRevisionCause(projectId, attempt, error, failure));
  }
}
