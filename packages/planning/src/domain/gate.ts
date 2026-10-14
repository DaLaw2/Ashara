import type { ProjectId, WorkItemStatus } from "@ashara/shared";
import { InvalidStatusTransition, projectBlockCause, WorkItemRowCorrupt } from "@ashara/shared";
import type { EventPublisher } from "../lifecycle/ports.js";
import type { WorkItem } from "./work-item.js";
import { blockWorkItem, takeEvents } from "./work-item.js";
import type { ActiveProjects, WorkItemRepository } from "./repository.js";
import {
  DependencyGraph,
  type DependencyContext,
  type DependencyItemView,
  type DependencyResolutionResult,
} from "./dependency.js";

export class GateKeeper {
  /**
   * Pending tasks whose dependencies are met, of active projects only. Each
   * active project is gated on its own: its items and its dependency edges are
   * read per project, so a blocked project's tasks are never admitted, an active
   * project with a row that does not parse is blocked and skipped, and one
   * project's dependency cycle parks that project's tasks on it, never failing
   * the gate for every project. A dependency on an item outside the project waits.
   *
   * A Pending task whose dependencies can never be met (an Abandoned item, directly or
   * transitively, or a cycle; an Abandoned check task only for the task it checks) is parked at
   * Blocked with a dependency_unsatisfiable reason here, and its work_item.blocked event published:
   * nothing else ever moves it, and left Pending it would stall with no record. Its exit is the
   * operator's.
   */
  static async filterAvailable(
    repo: WorkItemRepository,
    projects: ActiveProjects,
    events: EventPublisher,
  ): Promise<WorkItem[]> {
    const available: WorkItem[] = [];
    for (const projectId of await projects.listActiveIds()) {
      let items: WorkItem[];
      try {
        items = await repo.listByProject(projectId);
      } catch (err) {
        if (!(err instanceof WorkItemRowCorrupt)) throw err;
        const cause = projectBlockCause(err);
        const result = await projects.block(projectId, cause);
        console.warn(
          `[gate] project ${projectId}: ${cause.errorClass} (item ${err.itemId}, ${err.column}); ` +
            `none of its tasks dispatched; project ${result}: ${cause.reason}`,
        );
        continue;
      }
      available.push(...(await admitProject(repo, events, projectId, items)));
    }
    return available;
  }
}

async function admitProject(
  repo: WorkItemRepository,
  events: EventPublisher,
  projectId: ProjectId,
  items: WorkItem[],
): Promise<WorkItem[]> {
  const graph = await DependencyGraph.load(repo, projectId);
  for (const cycle of graph.cycles) {
    console.warn(`[gate] project ${projectId}: ${cycle.message}; the tasks on it and waiting on it are parked`);
  }
  const resolution = graph.resolveDependencies(buildDependencyContext(items));

  const pending = items.filter((item) => item.status === "Pending" && item.level === "Task");
  const statusById = new Map(items.map((item) => [item.id, item.status] as const));
  for (const item of pending) {
    const result = resolution.get(item.id);
    if (result?.resolution === "blocked") await parkUnsatisfiable(repo, events, item, result.blockedBy, statusById);
  }
  return pending.filter((item) => isMet(resolution, item.id));
}

/**
 * Parks a Pending task that depends on work that can never complete. A concurrent change to the
 * task (it left Pending since it was read) refuses the save; the next cycle's gate reads it again.
 * The event is published after the save commits, best-effort, like every routing site's.
 */
async function parkUnsatisfiable(
  repo: WorkItemRepository,
  events: EventPublisher,
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
  blockWorkItem(item, {
    source: "dependency_unsatisfiable",
    blockedBy: [...blockedBy],
    reason:
      `this task can never be dispatched: it waits on ${causes}. Re-plan or replace that work, ` +
      "then unblock this task, or abandon it.",
  });
  try {
    await repo.save(item, "Pending");
  } catch (err) {
    if (!(err instanceof InvalidStatusTransition)) throw err;
    console.warn(`[gate] task ${item.id}: not parked for unsatisfiable dependencies, it changed concurrently:`, err);
    return;
  }
  console.warn(`[gate] task ${item.id}: parked at Blocked, it waits on ${causes}`);
  for (const event of takeEvents(item)) {
    try {
      await events.publish(event);
    } catch (err) {
      console.warn(`[gate] task ${item.id}: failed to publish ${event.eventType} (the park is committed):`, err);
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
  return `${parentId ?? ""}::${title.trim().toLowerCase()}`;
}
