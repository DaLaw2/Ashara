import { projectBlockCause, WorkItemRowCorrupt } from "@ashara/shared";
import type { WorkItem } from "./work-item.js";
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
   * active project's items are read on their own, so a blocked project's tasks
   * are never admitted, and an active project with a row that does not parse is
   * blocked and skipped instead of failing the gate for every project. A
   * dependency on an item outside the active projects read here waits.
   */
  static async filterAvailable(repo: WorkItemRepository, projects: ActiveProjects): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    for (const projectId of await projects.listActiveIds()) {
      try {
        items.push(...(await repo.listByProject(projectId)));
      } catch (err) {
        if (!(err instanceof WorkItemRowCorrupt)) throw err;
        const cause = projectBlockCause(err);
        const result = await projects.block(projectId, cause);
        console.warn(
          `[gate] project ${projectId}: ${cause.errorClass} (item ${err.itemId}, ${err.column}); ` +
            `none of its tasks dispatched; project ${result}: ${cause.reason}`,
        );
      }
    }
    const graph = await DependencyGraph.load(repo);
    const resolution = graph.resolveDependencies(buildDependencyContext(items));

    return items
      .filter((item) => item.status === "Pending" && item.level === "Task")
      .filter((item) => isMet(resolution, item.id));
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
