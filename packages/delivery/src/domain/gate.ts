import { containEach } from "@ashara/shared";
import type { Logger, ProjectId, StepContainment } from "@ashara/shared";
import type { WorkItemStatus } from "../work-item-language/work-item-status.js";
import { InvalidStatusTransition } from "../work-item-language/transitions.js";
import { WorkItemRowCorrupt } from "../work-item-language/work-item-row.js";
import { projectBlockCause } from "../project-halt.js";
import type { EventPublisher } from "../lifecycle/ports.js";
import type { CorrectionHoldOf, WorkItem } from "./work-item.js";
import { giveUpWorkItem, holdForCorrection, takeEvents } from "./work-item.js";
import type { ActiveProjects, WorkItemRepository } from "./repository.js";
import {
  DependencyGraph,
  type DependencyContext,
  type DependencyItemView,
  type DependencyResolutionResult,
} from "./dependency.js";

/** The tasks the gate admits this cycle, and how many tasks each one's completion unlocks in its own project. */
export interface GatedWork {
  readonly available: WorkItem[];
  readonly unlockWeights: Map<string, number>;
}

/** One project's admitted tasks with their unlock weights, from the one read of its items and edges. */
interface AdmittedProject {
  readonly kind: "admitted";
  readonly items: WorkItem[];
  readonly weights: Map<string, number>;
}

export class GateKeeper {
  /**
   * Pending tasks whose dependencies are met, of active projects only, with their unlock weights.
   * Each active project is gated on its own: its items and its dependency edges are read once per
   * project, so a blocked project's tasks are never admitted, an active project with a row that does
   * not parse is blocked and skipped, one project's dependency cycle gives that project's tasks on it
   * up, and any other failure of one project's gating is contained to it (containEach: recorded,
   * retried after a backoff, its tasks not dispatched meanwhile), never failing the gate for every
   * project. A dependency on an item outside the project waits.
   *
   * A Pending task whose dependencies can never be met (an Abandoned item, directly or
   * transitively, or a cycle; an Abandoned check task only for the task it checks) is given up here
   * with a dependency_unsatisfiable reason, and its work_item.given_up event published: left Pending
   * it would stall with no record, and no person releases it. Its
   * abandonment opens a plan repair. A task given up elsewhere rarely leads
   * here: its project awaits a plan repair, listActiveIds omits it until the repair is written, and
   * the repair supersedes the task's dependents (Replanner).
   */
  static async filterAvailable(
    repo: WorkItemRepository,
    projects: ActiveProjects,
    events: EventPublisher,
    containment: StepContainment,
    logger: Logger,
  ): Promise<GatedWork> {
    const gated = await containEach(
      containment,
      "gate",
      await projects.listActiveIds(),
      (projectId) => ({ id: projectId, projectId }),
      (projectId) => gateProject(repo, projects, events, logger, projectId),
    );
    const available: WorkItem[] = [];
    const unlockWeights = new Map<string, number>();
    for (const project of gated) {
      if (project.kind !== "admitted") continue;
      available.push(...project.items);
      for (const [id, weight] of project.weights) unlockWeights.set(id, weight);
    }
    return { available, unlockWeights };
  }
}

/** One project's gating: blocked on a row that does not parse, else its admitted tasks. */
async function gateProject(
  repo: WorkItemRepository,
  projects: ActiveProjects,
  events: EventPublisher,
  logger: Logger,
  projectId: ProjectId,
): Promise<AdmittedProject | { readonly kind: "blocked" }> {
  let items: WorkItem[];
  try {
    items = await repo.listByProject(projectId);
  } catch (err) {
    if (!(err instanceof WorkItemRowCorrupt)) throw err;
    const cause = projectBlockCause(err);
    const result = await projects.block(projectId, cause);
    logger.error(
      "delivery.row-corrupt",
      `${cause.errorClass} (item ${err.itemId}, ${err.column}); none of its tasks dispatched; project ${projectId} ${result}: ${cause.reason}`,
      { projectId, itemId: err.itemId, column: err.column, result },
      err,
    );
    return { kind: "blocked" };
  }
  return admitProject(repo, events, logger, projectId, items);
}

async function admitProject(
  repo: WorkItemRepository,
  events: EventPublisher,
  logger: Logger,
  projectId: ProjectId,
  items: WorkItem[],
): Promise<AdmittedProject> {
  const graph = await DependencyGraph.load(repo, projectId);
  for (const cycle of graph.cycles) {
    logger.info("delivery.dependency-cycle", `${cycle.message}; the tasks on it and waiting on it are given up`, { projectId });
  }
  const resolution = graph.resolveDependencies(buildDependencyContext(items));

  // A task a client's correction holds is parked however it came back to Pending (a requeue, a retry,
  // a parked exit): its spec still holds the words the correction changed.
  const held = new Map((await repo.listCorrectionHeld(projectId)).map((each) => [each.taskId, each.hold] as const));
  const pending: WorkItem[] = [];
  for (const item of items.filter((each) => each.status === "Pending" && each.level === "Task")) {
    const hold = held.get(item.id);
    if (hold === undefined) pending.push(item);
    else await parkHeld(repo, events, logger, item, hold);
  }
  const statusById = new Map(items.map((item) => [item.id, item.status] as const));
  for (const item of pending) {
    const result = resolution.get(item.id);
    if (result?.resolution === "blocked") await giveUpUnsatisfiable(repo, events, logger, item, result.blockedBy, statusById);
  }
  return { kind: "admitted", items: pending.filter((item) => isMet(resolution, item.id)), weights: graph.computeUnlockWeights() };
}

/**
 * Gives up a Pending task that depends on work that can never complete. A concurrent change to the
 * task (it left Pending since it was read) refuses the save; the next cycle's gate reads it again.
 * The event is published after the save commits, best-effort, like every routing site's.
 */
async function giveUpUnsatisfiable(
  repo: WorkItemRepository,
  events: EventPublisher,
  logger: Logger,
  item: WorkItem,
  blockedBy: readonly string[],
  statusById: ReadonlyMap<string, WorkItemStatus>,
): Promise<void> {
  const causes = blockedBy
    .map((id) => {
      const status = statusById.get(id);
      return status === "Abandoned" ? `${id} (Abandoned)` : `${id} (on a dependency cycle)`;
    })
    .join(", ");
  giveUpWorkItem(item, {
    source: "dependency_unsatisfiable",
    blockedBy: [...blockedBy],
    reason: `this task can never be dispatched: it waits on ${causes}; the plan is repaired around it`,
  });
  try {
    await repo.save(item, "Pending");
  } catch (err) {
    if (!(err instanceof InvalidStatusTransition)) throw err;
    logger.warn("delivery.transition-rejected", "not given up for unsatisfiable dependencies, it changed concurrently", { taskId: item.id, from: err.from, to: err.to }, err);
    return;
  }
  logger.info("delivery.task-given-up", `given up, it waits on ${causes}; its plan is repaired`, {
    taskId: item.id,
    source: "dependency_unsatisfiable",
    blockedBy: [...blockedBy],
  });
  for (const event of takeEvents(item)) {
    try {
      await events.publish(event);
    } catch (err) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the give-up is committed before its events are published; domain_events is an operator audit log (GET /events is the bearer route) that no verdict, counter, charge or client text reads
      logger.warn("delivery.event-publish-failed", `failed to publish ${event.eventType} (the give-up is committed)`, { taskId: item.id, site: "gate", eventType: event.eventType }, err);
    }
  }
}

/**
 * Parks a Pending task a client's correction holds (holdForCorrection). A concurrent change to the
 * task refuses the save, and the task is not admitted this cycle either way; the next cycle's gate
 * reads it again.
 */
async function parkHeld(repo: WorkItemRepository, events: EventPublisher, logger: Logger, item: WorkItem, hold: CorrectionHoldOf): Promise<void> {
  holdForCorrection(item, hold);
  try {
    await repo.save(item, "Pending");
  } catch (err) {
    if (!(err instanceof InvalidStatusTransition)) throw err;
    logger.warn("delivery.transition-rejected", "not held for the client's correction, it changed concurrently", { taskId: item.id, from: err.from, to: err.to }, err);
    return;
  }
  logger.info("delivery.task-held", `held for the client's correction of vision v${hold.visionVersion}: it cites ${hold.affected.join(", ")}`, {
    taskId: item.id,
    visionVersion: hold.visionVersion,
  });
  for (const event of takeEvents(item)) {
    try {
      await events.publish(event);
    } catch (err) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the hold is committed before its events are published; domain_events is an operator audit log that no verdict, counter, charge or client text reads
      logger.warn("delivery.event-publish-failed", `failed to publish ${event.eventType} (the hold is committed)`, { taskId: item.id, site: "gate", eventType: event.eventType }, err);
    }
  }
}

/** Absent from the map ⇒ no dependencies ⇒ met. */
function isMet(resolution: Map<string, DependencyResolutionResult>, id: string): boolean {
  const result = resolution.get(id);
  return result === undefined ? true : result.resolution === "met";
}

function buildDependencyContext(items: WorkItem[]): DependencyContext {
  const byId = new Map<string, DependencyItemView>();
  const completedByKey = new Map<string, string[]>();

  for (const item of items) {
    byId.set(item.id, {
      status: item.status,
      title: item.title,
      parentId: item.parentId,
      checksFor: item.workKind === "check" ? (item.taskSpec?.checksFor ?? null) : null,
    });
    if (item.status === "Completed") {
      const key = equivalenceKey(item.parentId, item.title);
      const ids = completedByKey.get(key);
      if (ids) ids.push(item.id);
      else completedByKey.set(key, [item.id]);
    }
  }

  return {
    get: (id) => byId.get(id),
    findCompletedEquivalent: (parentId, title, excludeId) => {
      const ids = completedByKey.get(equivalenceKey(parentId, title));
      if (!ids) return undefined;
      return ids.find((id) => id !== excludeId);
    },
  };
}

function equivalenceKey(parentId: string | undefined, title: string): string {
  // eslint-disable-next-line no-restricted-syntax -- policy default: a parentless item's key has an empty parent part; a key, not a verdict
  return `${parentId ?? ""}::${title.trim().toLowerCase()}`;
}
