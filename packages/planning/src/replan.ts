import { z } from "zod";
import { PreCallRefusal, withStructuredLadder } from "@ashara/llm-gateway";
import type { ContextualLlm, LadderAttemptEvent } from "@ashara/llm-gateway";
import { RosterUnreadable, WorkKindOwnerUnresolved } from "@ashara/organization";
import { describeErrorChain, projectBlockCause } from "@ashara/shared";
import type { DomainEvent, ProjectBlockCause, ProjectId, WorkItemStatus } from "@ashara/shared";
import type { BulkPlanEdge } from "./bulk-plan.js";
import { DecompositionEngine } from "./decomposition.js";
import type { DecompositionInput, DecompositionResult, EnvironmentPlanning } from "./decomposition-types.js";
import type { WorkItem } from "./domain/index.js";
import { supersedeWorkItem, takeEvents } from "./domain/index.js";
import type { FirstPlanWrite } from "./first-plan.js";
import { northStarOf, planOwners, toWrite } from "./first-plan.js";
import { createGatewayDecompositionLLM } from "./gateway-adapters.js";

// Delivery's revision of a plan already under way (story s-liaison-intake-m1, task
// t-replan-on-change, migration 042). A client answer that changed an assumption the plan
// was built on flags the project (migration 038) and stops its dispatch. Once no task of
// the project is in progress, the current vision is decomposed again with the completed
// work as context: completed work stays Completed, open work (not started, Blocked or
// Failed, and the Epic that held it) is superseded, and the new tasks build on the environment
// already set up unless the change is an environment change. Revision, supersession and the
// cleared flag commit together; the Liaison reports the revision from what is recorded.

/** Failed attempts to revise the plan for one request after which Delivery stops and blocks the project. */
const MAX_REPLAN_ATTEMPTS = 3;

/** Revisions Delivery writes before the operator reviews the project; the next request blocks it. */
const MAX_REVISIONS_PER_REVIEW = 3;

/** One of the project's work items as the store reads it, with what was merged for it. */
interface PlannedItem {
  readonly item: WorkItem;
  /** The merge commit on the target's main (migration 041); null when none is recorded. */
  readonly mergeCommit: string | null;
  /** A Sprint 0 task's statement of the environment it set up (migration 033); null when none is recorded. */
  readonly environmentStatement: string | null;
}

/** A flagged project with no task in progress and no unread answer, as the store reads it. */
interface ProjectAwaitingReplan {
  readonly projectId: ProjectId;
  readonly projectName: string;
  /** The client answer whose flag this revision clears (projects.replan_requested_by). */
  readonly requestedBy: string;
  readonly visionVersion: number;
  readonly visionText: string;
  readonly summary: string;
  readonly scopeBoundaries: unknown;
  /** vision_documents.inferences as stored; the request's Stated assumption is found here. */
  readonly inferences: unknown;
  readonly rosterRows: unknown;
  readonly replanAttempts: number;
  readonly replanLastError: string | null;
  /** Revisions written since the operator last reviewed a bound-reached block (all of them when never). */
  readonly revisionsSinceReview: number;
  /** The number the next revision takes; the first plan is revision 1. */
  readonly nextRevision: number;
  readonly items: readonly PlannedItem[];
}

/**
 * What a revision did, recorded with it (plan_revisions.summary) for the Liaison's report.
 * Titles are the client's goal tasks; check and environment tasks are counted apart.
 */
interface PlanRevisionSummary {
  /** The client's words, as the answer that asked for the change carries them. */
  readonly answer: string;
  /** What work now proceeds on, as the vision states it. */
  readonly decision: string;
  readonly newTasks: readonly string[];
  readonly newCheckTasks: number;
  /** Whether the revision sets up the project environment again (an environment change). */
  readonly newEnvironmentTask: boolean;
  readonly supersededTasks: readonly string[];
  /** Superseded check and environment tasks. */
  readonly supersededOther: number;
  readonly keptCompleted: number;
}

/** A superseded item with the status it was read in: the write refuses it if the row moved since. */
interface SupersededItem {
  readonly item: WorkItem;
  readonly previousStatus: WorkItemStatus;
}

interface PlanRevisionWrite {
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly visionVersion: number;
  readonly requestedBy: string;
  readonly superseded: readonly SupersededItem[];
  /** The new items, edges between them by temp id, owners and knowledge, as a first plan writes them. */
  readonly plan: FirstPlanWrite;
  /** Edges from a new item (temp id) to work already on record (its id): the environment kept. */
  readonly existingEdges: readonly BulkPlanEdge[];
  readonly events: readonly DomainEvent[];
  readonly summary: PlanRevisionSummary;
}

/** Delivery's persistence port for plan revisions. Each method is one transaction. */
export interface ReplanStore {
  projectsAwaitingReplan(): Promise<readonly ProjectAwaitingReplan[]>;
  /**
   * Supersedes the open items, writes the new ones, records the revision and clears the flag
   * together; "moved" and nothing written when the project, its vision or an item read for it
   * changed since it was read (a task started, an answer arrived, the flag cleared).
   */
  writeRevision(write: PlanRevisionWrite): Promise<"written" | "moved">;
  /** Counts a failed attempt with its error; returns the count after it. */
  recordFailedAttempt(projectId: ProjectId, error: string): Promise<number>;
  /** Blocks the project and records why; a project already blocked keeps its first cause. */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

export type ReplanOutcome =
  | {
      readonly kind: "revised";
      readonly projectId: ProjectId;
      readonly revision: number;
      readonly tasks: number;
      readonly superseded: number;
      readonly newEnvironment: boolean;
    }
  /** Something read for the revision changed before it was written; it is tried again next cycle. */
  | { readonly kind: "moved"; readonly projectId: ProjectId }
  | { readonly kind: "failed"; readonly projectId: ProjectId; readonly attempt: number; readonly error: string }
  | { readonly kind: "project-blocked"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** What the core loop asks of Delivery's planning each cycle, after the first plans. */
export interface Replanning {
  runPending(): Promise<readonly ReplanOutcome[]>;
}

/** The project's plan was revised its bound of times since the operator last reviewed it. */
class ReplanBoundReached extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly revisions: number,
    readonly requestedBy: string,
  ) {
    super(
      `project ${projectId}: the plan was revised ${revisions} time(s) for client changes since the operator last ` +
        `reviewed it, the bound of ${MAX_REVISIONS_PER_REVIEW}; answer ${requestedBy}'s change is not planned until ` +
        `the operator reviews the project and unblocks it`,
    );
    this.name = "ReplanBoundReached";
  }
}

/** Revising the plan failed on every attempt: the change is not planned, and the old plan is not dispatched past it. */
class ReplanAttemptsExhausted extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly attempts: number,
    readonly lastError: string,
  ) {
    super(`project ${projectId}: the plan could not be revised after ${attempts} attempt(s); last error: ${lastError}`);
    this.name = "ReplanAttemptsExhausted";
  }
}

/** The flag names an answer the current vision holds no Stated assumption for: there is no change on record to plan. */
class ReplanRequestUnfounded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly requestedBy: string,
    readonly visionVersion: number,
    readonly detail: string,
  ) {
    super(
      `project ${projectId}: replanning was requested by answer ${requestedBy}, but vision v${visionVersion} ` +
        `records no change from it (${detail}); nothing is planned`,
    );
    this.name = "ReplanRequestUnfounded";
  }
}

// The answer a Stated assumption carries (migration 038), with the answer's id as its provenance.
const RequestInferencesSchema = z.array(
  z.looseObject({
    statement: z.string().min(1),
    status: z.string().min(1),
    clientAnswer: z
      .looseObject({ messageId: z.string().min(1), question: z.string().min(1), answer: z.string().min(1) })
      .optional(),
  }),
);

/** The client's change the flag stands for: their question, their words and what work now proceeds on. */
interface ChangeRequest {
  readonly question: string;
  readonly answer: string;
  readonly decision: string;
}

function changeOf(project: ProjectAwaitingReplan): ChangeRequest {
  const unfounded = (detail: string) =>
    new ReplanRequestUnfounded(project.projectId, project.requestedBy, project.visionVersion, detail);
  const parsed = RequestInferencesSchema.safeParse(project.inferences);
  if (!parsed.success) throw unfounded(`its assumptions do not parse: ${z.prettifyError(parsed.error)}`);
  const stated = parsed.data.find((a) => a.status === "Stated" && a.clientAnswer?.messageId === project.requestedBy);
  if (stated?.clientAnswer === undefined) throw unfounded("no Stated assumption carries that answer");
  return { question: stated.clientAnswer.question, answer: stated.clientAnswer.answer, decision: stated.statement };
}

const EnvironmentJudgmentSchema = z.strictObject({ environmentChange: z.boolean(), reason: z.string().min(1) });

function environmentPrompt(change: ChangeRequest, statement: string | null): string {
  return [
    `You are the planner of a software contractor. After work on a project began, the client changed what is built.`,
    `Say whether this change needs the project environment changed: how the project is built and tested, the`,
    `technology it is built with, or the tools its build and tests run on. A change to what the product does that`,
    `the environment as it is can build and test is not an environment change.`,
    ``,
    `The project environment, as the team stated it when it set it up:`,
    JSON.stringify(statement ?? "(no statement recorded)"),
    ``,
    `The question the client answered:`,
    JSON.stringify(change.question),
    ``,
    `The client's answer:`,
    JSON.stringify(change.answer),
    ``,
    `What work now proceeds on:`,
    JSON.stringify(change.decision),
    ``,
    `Return exactly {"environmentChange": true or false, "reason": "..."} with one sentence of reason.`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
  ].join("\n");
}

function judgmentReask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous response was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send corrected JSON only. No markdown, no explanatory prose.`
  );
}

function isPreCallRefusal(err: unknown): boolean {
  for (let current: unknown = err; current instanceof Error; current = current.cause) {
    if (current instanceof PreCallRefusal) return true;
  }
  return false;
}

function isTask(planned: PlannedItem): boolean {
  return planned.item.level === "Task";
}

function isGoalTask(item: WorkItem): boolean {
  return item.taskSpec?.origin !== "check" && item.taskSpec?.origin !== "sprint0" && item.workKind !== "environment" && item.workKind !== "check";
}

function isEnvironmentTask(item: WorkItem): boolean {
  return item.workKind === "environment" || item.taskSpec?.origin === "sprint0";
}

/** The work already done, kept as the revision's context: titles and what merged them. */
function doneSection(completed: readonly PlannedItem[]): string {
  if (completed.length === 0) return "Already done: nothing yet.";
  const lines = completed.map(({ item, mergeCommit }) =>
    mergeCommit === null ? `- ${item.title}` : `- ${item.title} (merged as ${mergeCommit})`,
  );
  return `Already done, and kept as it is (plan only what is still to do, building on it):\n${lines.join("\n")}`;
}

interface ReplannerDeps {
  readonly llm: ContextualLlm;
  readonly store: ReplanStore;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
}

/**
 * Delivery's plan revision step. Each flagged project that has no task in progress is
 * revised through recorded `decomposition` calls and written whole or not at all. A failed
 * attempt writes nothing and is counted; at the cap, and when the project's revisions reach
 * their bound, the project is blocked, so the loop neither spins on it nor revises without end.
 */
export class Replanner implements Replanning {
  constructor(private readonly deps: ReplannerDeps) {}

  /**
   * A project whose own record cannot be revised is blocked, and the other projects are still
   * revised. Any other failure, a store failure included, throws through and fails the cycle.
   */
  async runPending(): Promise<readonly ReplanOutcome[]> {
    const outcomes: ReplanOutcome[] = [];
    for (const project of await this.deps.store.projectsAwaitingReplan()) {
      try {
        outcomes.push(await this.revise(project));
      } catch (err) {
        const projectRecord =
          err instanceof ReplanRequestUnfounded || err instanceof RosterUnreadable || err instanceof WorkKindOwnerUnresolved;
        if (!projectRecord) throw err;
        outcomes.push(await this.block(project.projectId, projectBlockCause(err)));
      }
    }
    return outcomes;
  }

  private async block(projectId: ProjectId, cause: ProjectBlockCause): Promise<ReplanOutcome> {
    const result = await this.deps.store.blockProject(projectId, cause);
    console.warn(`[replan] project ${projectId}: ${cause.errorClass}; project ${result}: ${cause.reason}`);
    return { kind: "project-blocked", projectId, cause };
  }

  private async revise(project: ProjectAwaitingReplan): Promise<ReplanOutcome> {
    const { projectId } = project;
    if (project.revisionsSinceReview >= MAX_REVISIONS_PER_REVIEW) {
      const err = new ReplanBoundReached(projectId, project.revisionsSinceReview, project.requestedBy);
      return this.block(projectId, { ...projectBlockCause(err), category: "replan_bound" });
    }
    if (project.replanAttempts >= MAX_REPLAN_ATTEMPTS) {
      // The CHECK of migration 042 records an error with every counted attempt.
      const err = new ReplanAttemptsExhausted(projectId, project.replanAttempts, project.replanLastError ?? "(none recorded)");
      return this.block(projectId, projectBlockCause(err));
    }

    const owners = planOwners(projectId, project.rosterRows);
    const change = changeOf(project);
    const tasks = project.items.filter(isTask);
    // The store lists a project only with no task in progress; one seen here started since.
    if (tasks.some(({ item }) => item.status === "InProgress")) return { kind: "moved", projectId };
    const completed = tasks.filter(({ item }) => item.status === "Completed");
    const open = tasks.filter(({ item }) => item.status === "Pending" || item.status === "Blocked" || item.status === "Failed");
    // The revision writes its own Epic; an old one not Completed is closed with the work it held.
    const openEpics = project.items.filter(({ item }) => item.level === "Epic" && item.status !== "Completed" && item.status !== "Abandoned");

    let write: PlanRevisionWrite;
    let result: "written" | "moved";
    try {
      const environment = await this.environmentOf(project, change, completed);
      const decomposition = await this.decompose(project, change, completed, environment);
      write = this.compose(project, change, decomposition, owners, environment, completed, [...open, ...openEpics]);
      result = await this.deps.store.writeRevision(write);
    } catch (err) {
      // A spend-cap refusal is not a failed attempt: the core loop's step handles it.
      if (isPreCallRefusal(err)) throw err;
      return this.fail(project, err);
    }
    if (result === "moved") return { kind: "moved", projectId };
    console.log(`[replan] project ${projectId}: revision ${write.revision} written for answer ${project.requestedBy}`);
    return {
      kind: "revised",
      projectId,
      revision: write.revision,
      tasks: write.summary.newTasks.length + write.summary.newCheckTasks + (write.summary.newEnvironmentTask ? 1 : 0),
      superseded: write.summary.supersededTasks.length + write.summary.supersededOther,
      newEnvironment: write.summary.newEnvironmentTask,
    };
  }

  /**
   * The environment the revision builds on: the latest completed environment task, unless the
   * change is an environment change; a new environment task when none is completed.
   */
  private async environmentOf(
    project: ProjectAwaitingReplan,
    change: ChangeRequest,
    completed: readonly PlannedItem[],
  ): Promise<EnvironmentPlanning> {
    const environments = completed.filter(({ item }) => isEnvironmentTask(item));
    const current = environments[environments.length - 1];
    if (current === undefined) return { kind: "new" };
    const provider = withStructuredLadder(
      this.deps.llm.forCall({ projectId: project.projectId, taskId: null, callSite: "decomposition" }),
      { site: "decomposition", attempts: 2, onAttempt: this.deps.onAttempt, reask: judgmentReask },
    );
    const response = await provider.generateStructured({
      capability: "Strong",
      prompt: environmentPrompt(change, current.environmentStatement),
      schema: EnvironmentJudgmentSchema,
      maxTokens: 512,
    });
    console.log(
      `[replan] project ${project.projectId}: environment change ${response.data.environmentChange}: ${response.data.reason}`,
    );
    return response.data.environmentChange ? { kind: "new" } : { kind: "existing", taskId: current.item.id };
  }

  private async decompose(
    project: ProjectAwaitingReplan,
    change: ChangeRequest,
    completed: readonly PlannedItem[],
    environment: EnvironmentPlanning,
  ): Promise<DecompositionResult> {
    const llm = createGatewayDecompositionLLM(
      this.deps.llm.forCall({ projectId: project.projectId, taskId: null, callSite: "decomposition" }),
      this.deps.onAttempt,
    );
    const northStar = [
      northStarOf(project),
      `The client changed what is built after work began. They were asked: ${change.question}\n` +
        `They answered: ${change.answer}\nWork now proceeds on: ${change.decision}`,
      doneSection(completed),
    ].join("\n\n");
    const input: DecompositionInput = {
      epicTitle: project.projectName,
      epicNorthStar: northStar,
      epicDescription: project.visionText,
      conventions: [],
      priorEpicResults:
        completed.length === 0
          ? []
          : [
              {
                epicId: "done",
                title: "Work already done",
                completedStories: completed.map(({ item }) => item.title),
                keyDecisions: [change.decision],
                deliveredCapabilities: [],
              },
            ],
      environment,
    };
    return new DecompositionEngine(llm).decompose(input);
  }

  private compose(
    project: ProjectAwaitingReplan,
    change: ChangeRequest,
    decomposition: DecompositionResult,
    owners: ReturnType<typeof planOwners>,
    environment: EnvironmentPlanning,
    completed: readonly PlannedItem[],
    open: readonly PlannedItem[],
  ): PlanRevisionWrite {
    const plan = toWrite(project.projectId, decomposition, owners);
    const tempIds = new Set(plan.items.map((item) => item.tempId));
    const existingEdges = plan.edges.filter((edge) => !tempIds.has(edge.to));
    const revision = project.nextRevision;

    const events: DomainEvent[] = [];
    const superseded = open.map(({ item }): SupersededItem => {
      const previousStatus = item.status;
      supersedeWorkItem(item, {
        source: "superseded",
        planRevision: revision,
        requestedBy: project.requestedBy,
        reason:
          `replaced by plan revision ${revision} from vision v${project.visionVersion}: the client's answer ` +
          `${project.requestedBy} changed what is built`,
      });
      events.push(...takeEvents(item));
      return { item, previousStatus };
    });

    const supersededTasks = superseded.filter(({ item }) => item.level === "Task");
    const origins = decomposition.tasks.map((task) => task.taskSpec.origin);
    return {
      projectId: project.projectId,
      revision,
      visionVersion: project.visionVersion,
      requestedBy: project.requestedBy,
      superseded,
      plan: { ...plan, edges: plan.edges.filter((edge) => tempIds.has(edge.to)) },
      existingEdges,
      events,
      summary: {
        answer: change.answer,
        decision: change.decision,
        newTasks: decomposition.tasks.filter((task) => task.taskSpec.origin === "decomposition").map((task) => task.title),
        newCheckTasks: origins.filter((origin) => origin === "check").length,
        newEnvironmentTask: environment.kind === "new",
        supersededTasks: supersededTasks.filter(({ item }) => isGoalTask(item)).map(({ item }) => item.title),
        supersededOther: supersededTasks.filter(({ item }) => !isGoalTask(item)).length,
        keptCompleted: completed.length,
      },
    };
  }

  private async fail(project: ProjectAwaitingReplan, err: unknown): Promise<ReplanOutcome> {
    const { projectId } = project;
    const error = describeErrorChain(err);
    const attempt = await this.deps.store.recordFailedAttempt(projectId, error);
    console.warn(
      `[replan] project ${projectId} (vision v${project.visionVersion}, answer ${project.requestedBy}): ` +
        `attempt ${attempt}/${MAX_REPLAN_ATTEMPTS} failed: ${error}`,
    );
    if (attempt < MAX_REPLAN_ATTEMPTS) return { kind: "failed", projectId, attempt, error };
    return this.block(projectId, projectBlockCause(new ReplanAttemptsExhausted(projectId, attempt, error)));
  }
}
