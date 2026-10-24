import type { DomainEvent, ProjectId } from "@ashara/shared";
import type { PlanningVision } from "./acl/engagement-acl.js";
import type { DecompositionResult, EnvironmentPlanning } from "./decomposition-types.js";
import type { WorkItem } from "./domain/index.js";
import { supersedeWorkItem, takeEvents } from "./domain/index.js";
import type { FirstPlanWrite, PlanOwners } from "./first-plan.js";
import { toWrite } from "./first-plan.js";
import type {
  CorrectionRequest,
  PlanRevisionWork,
  PlanRevisionWrite,
  PlannedItem,
  ProjectAwaitingReplan,
  RevisionCause,
  RevisionChange,
  RevisionCorrections,
  SupersededItem,
} from "./replan-port.js";
import { affectedKeys, decisionOf } from "./revision-cause.js";
import { goalTask } from "./revision-scope.js";
import type { RevisionScope } from "./revision-scope.js";

/** A revision keeps tasks that waited on a review it supersedes, and plans no review of its own for them to wait on. */
class RevisionReviewMissing extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly taskIds: readonly string[],
  ) {
    super(`plan revision of project ${projectId}: task(s) ${taskIds.join(", ")} wait on a review it supersedes, and it plans no review of its own`);
    this.name = "RevisionReviewMissing";
  }
}

/** What a revision is written from: the project as read, why it was asked, and what was planned for it. */
interface RevisionComposition {
  readonly project: ProjectAwaitingReplan;
  readonly cause: RevisionCause;
  readonly vision: PlanningVision;
  /** The new plan and the environment it builds on; null when a correction left nothing to plan. */
  readonly planned: { readonly decomposition: DecompositionResult; readonly environment: EnvironmentPlanning } | null;
  readonly owners: PlanOwners;
  /** The project's completed tasks, kept. */
  readonly completed: readonly PlannedItem[];
  readonly scope: RevisionScope;
}

/** The changes as the summary records them: the client's words and the decision, in the order recorded. */
function revisionChanges(changes: readonly [CorrectionRequest, ...CorrectionRequest[]], vision: PlanningVision): readonly [RevisionChange, ...RevisionChange[]] {
  const [first, ...rest] = changes;
  const recorded = (change: CorrectionRequest): RevisionChange => ({ answer: change.words, decision: decisionOf(change, vision) });
  return [recorded(first), ...rest.map(recorded)];
}

/**
 * The superseded tasks as a revision's summary tells them: each goal task (isGoalTask) by title, as
 * the revision's new goal tasks are; every other task (a check, review or setup task, or one whose
 * origin was never recorded) only counted.
 *
 * @testseam revision-write.test.ts classifies superseded tasks without a model; composeRevision is its production caller
 */
export function setAsideWork(tasks: readonly WorkItem[]): { readonly supersededTasks: readonly string[]; readonly supersededOther: number } {
  return {
    supersededTasks: tasks.filter(goalTask).map((item) => item.title),
    supersededOther: tasks.filter((item) => !goalTask(item)).length,
  };
}

/**
 * The revision as written: the replaced items superseded, and the new plan, or none when a
 * correction left nothing to plan (`planned` null).
 */
export function composeRevision({ project, cause, vision, planned, owners, completed, scope }: RevisionComposition): PlanRevisionWrite {
  const { replaced } = scope;
  const plan: FirstPlanWrite =
    planned === null
      ? { projectId: project.projectId, items: [], edges: [], owners: [], droppedDependencies: [], assumptions: [] }
      : toWrite(project.projectId, planned.decomposition, owners);
  const tempIds = new Set(plan.items.map((item) => item.tempId));
  // A kept task moved off a superseded review waits on the revision's own, which reads its checks' suites too.
  const review = planned?.decomposition.tasks.find((task) => task.taskSpec.origin === "review");
  if (scope.regated.length > 0 && review === undefined) throw new RevisionReviewMissing(project.projectId, scope.regated.map((task) => task.taskId));
  const regated = review === undefined ? [] : scope.regated.map(({ taskId, review: from }) => ({ taskId, from, toTempId: review.id }));
  const reviewed = review === undefined ? [] : scope.regated.flatMap(({ checkTasks }) => checkTasks.map((to) => ({ from: review.id, to })));
  const existingEdges = [...plan.edges.filter((edge) => !tempIds.has(edge.to)), ...reviewed];
  const revision = project.nextRevision;
  const repairOf = [...project.repairsAwaited];
  const corrections: RevisionCorrections | null =
    cause.kind === "client-change"
      ? {
          versions: [cause.changes[0].visionVersion, ...cause.changes.slice(1).map((change) => change.visionVersion)],
          requestedBy: cause.changes[0].requestedBy,
          affected: affectedKeys(cause.changes),
        }
      : null;

  const events: DomainEvent[] = [];
  const superseded = replaced.map(({ item }): SupersededItem => {
    const previousStatus = item.status;
    supersedeWorkItem(
      item,
      corrections !== null
        ? {
            source: "superseded",
            planRevision: revision,
            requestedBy: corrections.requestedBy,
            reason:
              `replaced by plan revision ${revision} from vision v${project.vision.version}: the client's ` +
              `correction(s) changed ${corrections.affected.join(", ")}, which this work cites or waits on`,
          }
        : {
            source: "superseded",
            planRevision: revision,
            requestedBy: null,
            repairOf,
            reason:
              `replaced by plan revision ${revision} from vision v${project.vision.version}: the team gave up ` +
              `${repairOf.join(", ")} and planned the remaining work again around it`,
          },
    );
    events.push(...takeEvents(item));
    return { item, previousStatus };
  });

  const setAside = setAsideWork(superseded.filter(({ item }) => item.level === "Task").map(({ item }) => item));
  const newTasks = planned === null ? [] : planned.decomposition.tasks;
  const origins = newTasks.map((task) => task.taskSpec.origin);
  const work: PlanRevisionWork = {
    newTasks: newTasks.filter((task) => task.taskSpec.origin === "decomposition").map((task) => task.title),
    newCheckTasks: origins.filter((origin) => origin === "check").length,
    newReviewTasks: origins.filter((origin) => origin === "review").length,
    newEnvironmentTask: planned !== null && planned.environment.kind === "new",
    ...setAside,
    keptCompleted: completed.length,
    assumptions: plan.assumptions.map(({ key, statement }) => ({ key, statement })),
  };
  return {
    projectId: project.projectId,
    revision,
    visionVersion: project.vision.version,
    corrections,
    repaired: corrections === null ? repairOf : [],
    superseded,
    plan: { ...plan, edges: plan.edges.filter((edge) => tempIds.has(edge.to)) },
    existingEdges,
    regated,
    events,
    summary:
      cause.kind === "client-change"
        ? { ...work, changes: revisionChanges(cause.changes, vision) }
        : { ...work, repaired: cause.abandoned.map((task) => task.title) },
  };
}
