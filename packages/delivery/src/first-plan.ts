import { containEach, describeErrorChain } from "@ashara/shared";
import type { Logger, ProjectId, StepContainment, StepFaulted, UnreadSubject } from "@ashara/shared";
import type { LadderAttemptEvent } from "./acl/finance-acl.js";
import type { WorkItemLevel } from "./work-item-language/work-item-status.js";
import type { WorkKind } from "./acl/organization-acl.js";
import { projectBlockCause } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";
import { VisionChangeRefused, VisionUnreadable, planningVisionOf } from "./acl/engagement-acl.js";
import { modelCallFailureOf } from "./acl/finance-acl.js";
import type { ContextualLlm } from "./acl/finance-acl.js";
import { RosterUnreadable, WorkKindOwnerUnresolved, ownerOf, parseStoredRoster } from "./acl/organization-acl.js";
import type { PlanningVision, StoredVision } from "./acl/engagement-acl.js";
import type { PlannedAssumption } from "./acl/engagement-vision-acl.js";
import type { BulkPlanEdge, BulkPlanItem } from "./bulk-plan.js";
import { DecompositionEngine } from "./decomposition.js";
import type {
  DecompositionInput,
  DecompositionResult,
  DroppedDependency,
  TaskSpec,
  WorkItemSpec,
} from "./decomposition-types.js";
import { VisionItemsMissing } from "./decomposition-types.js";
import { createGatewayDecompositionLLM } from "./gateway-adapters.js";

// Delivery's first plan of a project: the
// project's current vision, which Engagement owns and Delivery only reads, is
// decomposed into an Epic -> Task plan written in one transaction. Delivery never
// writes to the client; the Liaison reports the outcome from what is recorded here.

/** Failed planning attempts after which Delivery stops and blocks the project. */
const MAX_PLAN_ATTEMPTS = 3;

/** A project with a current vision and no work items, as the store reads it. */
interface ProjectAwaitingPlan {
  readonly projectId: ProjectId;
  readonly projectName: string;
  /** The project's current vision as stored; read through Engagement's published reader. */
  readonly vision: StoredVision;
  readonly planAttempts: number;
  readonly planLastError: string | null;
  /** The rows of the project's latest roster revision as stored; parsed by Organization. */
  readonly rosterRows: unknown;
}

/** Who owns a planned task: its kind of work and the roster role holding the capability that kind needs. */
interface TaskOwnership {
  readonly tempId: string;
  readonly workKind: WorkKind;
  readonly ownerRoleId: string;
}

export interface FirstPlanWrite {
  readonly projectId: ProjectId;
  readonly items: readonly BulkPlanItem[];
  readonly edges: readonly BulkPlanEdge[];
  /** One entry per Task item; an Epic has no owner. */
  readonly owners: readonly TaskOwnership[];
  /** Ordering hints the decomposition dropped, recorded with the plan so its report states them. */
  readonly droppedDependencies: readonly DroppedDependency[];
  /**
   * The behaviour the plan adds beyond what the contract states, recorded on the contract in the
   * plan's own transaction under the keys its tasks cite (recordPlannedBehaviour); empty when none.
   */
  readonly assumptions: readonly PlannedAssumption[];
}

type FirstPlanCommit =
  | { readonly kind: "written"; readonly created: number }
  | { readonly kind: "already-planned" };

/** Delivery's persistence port for the first plan. Each method is one transaction. */
export interface FirstPlanStore {
  /** Every project awaiting its first plan, each read on its own: one whose rows do not read is its UnreadSubject. */
  projectsAwaitingPlan(): Promise<ReadonlyArray<ProjectAwaitingPlan | UnreadSubject>>;
  /**
   * Writes the whole plan and stamps the project planned, or nothing when the
   * project gained work items or a planning outcome since it was read.
   */
  writeFirstPlan(write: FirstPlanWrite): Promise<FirstPlanCommit>;
  /** Counts a failed attempt with its error; returns the count after it. */
  recordFailedAttempt(projectId: ProjectId, error: string): Promise<number>;
  /** Blocks the project and stamps planning stopped. */
  stopPlanning(projectId: ProjectId): Promise<void>;
  /**
   * Blocks the project and records why, for a project whose own
   * record is inconsistent; a project already blocked keeps its first cause.
   */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

export type FirstPlanOutcome =
  | { readonly kind: "planned"; readonly projectId: ProjectId; readonly epics: number; readonly tasks: number }
  | { readonly kind: "already-planned"; readonly projectId: ProjectId }
  | { readonly kind: "failed"; readonly projectId: ProjectId; readonly attempt: number; readonly error: string }
  | { readonly kind: "stopped"; readonly projectId: ProjectId; readonly attempts: number }
  | { readonly kind: "project-blocked"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause }
  | StepFaulted;

/** What the core loop asks of Delivery's planning each cycle. */
export interface FirstPlanning {
  runPending(): Promise<readonly FirstPlanOutcome[]>;
}

/**
 * A project reached its attempt cap with no error on record. A database
 * CHECK constraint makes this unrepresentable; meeting it means the store lied.
 */
class PlanFailureUnrecorded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly attempts: number,
  ) {
    super(`project ${projectId} has ${attempts} failed planning attempts but no recorded error`);
    this.name = "PlanFailureUnrecorded";
  }
}

function toLevel(level: WorkItemSpec["level"]): WorkItemLevel {
  switch (level) {
    case "epic":
      return "Epic";
    case "task":
      return "Task";
  }
}

/** The kinds of work a plan holds, each with the role that owns it. */
type PlanOwners = Readonly<Record<WorkKind, { readonly id: string }>>;

/**
 * The owner of each kind of work from the project's latest roster, resolved before any LLM call:
 * a plan nobody can own is not attempted. Throws RosterUnreadable or WorkKindOwnerUnresolved.
 */
export function planOwners(projectId: ProjectId, rosterRows: unknown): PlanOwners {
  const roster = parseStoredRoster(projectId, rosterRows);
  return {
    environment: ownerOf(roster, "environment"),
    implementation: ownerOf(roster, "implementation"),
    check: ownerOf(roster, "check"),
  };
}

/**
 * The kind of work a planned task is. Sprint 0 defines the project environment,
 * the environment role's work; every decomposed task is implementation, and its
 * check task is the check author's. The review of the plan's suites is the check
 * author's role too, as a hat: a roster holds exactly one
 * role with author-checks, so no other role could take it, and the review is a separate
 * dispatch that reads the stored suites and authored none of them.
 */
function workKindOf(origin: TaskSpec["origin"]): WorkKind {
  switch (origin) {
    case "sprint0":
      return "environment";
    case "decomposition":
    case "product-scaffold":
      return "implementation";
    case "check":
    case "review":
      return "check";
  }
}

/** The decomposition as one bulk plan: the epic first, its tasks after, edges by temp id. */
export function toWrite(projectId: ProjectId, result: DecompositionResult, owners: PlanOwners): FirstPlanWrite {
  const items: BulkPlanItem[] = [
    {
      tempId: result.epic.id,
      level: toLevel(result.epic.level),
      title: result.epic.title,
      description: result.epic.description,
      northStar: result.epic.northStar,
    },
    ...result.tasks.map((task) => ({
      tempId: task.id,
      level: toLevel(task.level),
      title: task.title,
      description: task.description,
      parentId: task.parentId,
      taskSpec: task.taskSpec,
    })),
  ];
  const edges = result.dependencyEdges.map((edge) => ({ from: edge.from, to: edge.to }));
  const taskOwners = result.tasks.map((task): TaskOwnership => {
    const workKind = workKindOf(task.taskSpec.origin);
    return { tempId: task.id, workKind, ownerRoleId: owners[workKind].id };
  });
  return {
    projectId,
    items,
    edges,
    owners: taskOwners,
    droppedDependencies: result.droppedDependencies,
    assumptions: result.assumptions,
  };
}

interface FirstPlannerDeps {
  readonly llm: ContextualLlm;
  readonly store: FirstPlanStore;
  /** Each project's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
  readonly logger: Logger;
  /** Aborted on shutdown: every model call this step sends is cancelled with it (StructuredRequest.abortSignal). */
  readonly shutdownSignal: AbortSignal;
}

/**
 * Delivery's first planning step. Each project awaiting a plan is decomposed
 * through recorded `decomposition` calls; the plan is written whole or not at
 * all. A failed attempt writes nothing and is counted; at the cap the project is
 * blocked and planning stops, so the loop does not spin on it.
 */
export class FirstPlanner implements FirstPlanning {
  constructor(private readonly deps: FirstPlannerDeps) {}

  /**
   * A project whose own record is inconsistent is blocked, and the other
   * projects are still planned. Any other failure that escapes an attempt, a store
   * failure included, is that project's, contained to it (containEach).
   */
  async runPending(): Promise<readonly FirstPlanOutcome[]> {
    const projects = await this.deps.store.projectsAwaitingPlan();
    return containEach(this.deps.containment, "first-plan", projects, (project) => ({ id: project.projectId, projectId: project.projectId }), async (project) => {
      try {
        return await this.plan(project);
      } catch (err) {
        // A roster that cannot be read or cannot assign an owner, and a vision that cannot be read
        // or holds no item to plan against, are the project's own record; planning again would not
        // change it.
        const projectRecord =
          err instanceof PlanFailureUnrecorded ||
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

  private async block(projectId: ProjectId, cause: ProjectBlockCause): Promise<FirstPlanOutcome> {
    const result = await this.deps.store.blockProject(projectId, cause);
    this.deps.logger.info("delivery.project-blocked", `${cause.errorClass}; project ${projectId} ${result}: ${cause.reason}`, {
      projectId,
      step: "first-plan",
      category: cause.category,
      errorClass: cause.errorClass,
      result,
    });
    return { kind: "project-blocked", projectId, cause };
  }

  private async plan(project: ProjectAwaitingPlan): Promise<FirstPlanOutcome> {
    const { projectId } = project;

    // A previous cycle reached the cap but did not stop planning.
    if (project.planAttempts >= MAX_PLAN_ATTEMPTS) {
      if (project.planLastError === null) throw new PlanFailureUnrecorded(projectId, project.planAttempts);
      await this.deps.store.stopPlanning(projectId);
      return { kind: "stopped", projectId, attempts: project.planAttempts };
    }

    const owners = planOwners(projectId, project.rosterRows);
    // Read before the counted attempt: VisionUnreadable throws through to runPending, which blocks.
    const vision = planningVisionOf(project.vision);

    let write: FirstPlanWrite;
    let commit: FirstPlanCommit;
    try {
      write = toWrite(projectId, await this.decompose(project, vision), owners);
      commit = await this.deps.store.writeFirstPlan(write);
    } catch (err) {
      // Only the model's or its provider's failure is a failed plan attempt (modelCallFailureOf, as
      // every counted step reads it). Ashara's own (a spend cap's refusal, a store write that failed,
      // a request built wrong, a fault nothing names) never counts toward the stop: a refusal escapes
      // to the core loop's step, which halts the project it names (Finance refuses, Delivery halts);
      // any other is contained to this project (containEach), or blocks it when it is the
      // project's record (runPending).
      if (modelCallFailureOf(err) === "ashara") throw err;
      return this.fail(project, err);
    }
    if (commit.kind === "already-planned") return { kind: "already-planned", projectId };
    for (const dropped of write.droppedDependencies) {
      this.deps.logger.info(
        "delivery.ordering-hint-dropped",
        `ordering hint dropped: "${dropped.dependentTaskTitle}" named "${dropped.unresolvedRef}", which is no task of the plan; no edge was written for it`,
        { projectId, dependentTaskTitle: dropped.dependentTaskTitle, unresolvedRef: dropped.unresolvedRef },
      );
    }
    const epics = write.items.filter((item) => item.level === "Epic").length;
    return { kind: "planned", projectId, epics, tasks: commit.created - epics };
  }

  private async decompose(project: ProjectAwaitingPlan, vision: PlanningVision): Promise<DecompositionResult> {
    const llm = createGatewayDecompositionLLM(
      this.deps.llm.forCall({ projectId: project.projectId, taskId: null, callSite: "decomposition" }),
      this.deps.shutdownSignal,
      this.deps.onAttempt,
    );
    const input: DecompositionInput = {
      epicTitle: project.projectName,
      epicNorthStar: vision.northStar,
      epicDescription: vision.visionText,
      environment: { kind: "new" },
      layout: { kind: "new" },
      visionItems: vision.items,
      interface: vision.interface,
      checkedItems: [],
      assumptionKeys: vision.assumptionKeys,
    };
    return new DecompositionEngine(llm).decompose(input);
  }

  private async fail(project: ProjectAwaitingPlan, err: unknown): Promise<FirstPlanOutcome> {
    const { projectId } = project;
    const error = describeErrorChain(err);
    const attempt = await this.deps.store.recordFailedAttempt(projectId, error);
    this.deps.logger.warn("delivery.plan-attempt-failed", `(vision v${project.vision.version}): attempt ${attempt}/${MAX_PLAN_ATTEMPTS} failed`, {
      projectId,
      attempt,
      visionVersion: project.vision.version,
    }, err);
    if (attempt < MAX_PLAN_ATTEMPTS) return { kind: "failed", projectId, attempt, error };

    await this.deps.store.stopPlanning(projectId);
    this.deps.logger.info("delivery.planning-stopped", `planning stopped after ${attempt} attempts; project blocked`, { projectId, attempts: attempt });
    return { kind: "stopped", projectId, attempts: attempt };
  }
}
