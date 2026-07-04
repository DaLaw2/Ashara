import type { WorkItem } from "./work-item.js";
import type { WorkItemRepository } from "./repository.js";
import {
  DependencyGraph,
  type DependencyContext,
  type DependencyItemView,
  type DependencyResolutionResult,
} from "./dependency.js";
import { extractSubstitutedBy } from "./substitution.js";

export class GateKeeper {
  static async filterAvailable(repo: WorkItemRepository): Promise<WorkItem[]> {
    const items = await repo.listAll();
    const graph = await DependencyGraph.load(repo);
    const resolution = graph.resolveDependencies(buildDependencyContext(items));

    return items
      .filter((item) => item.status === "Pending" && item.level === "Task")
      .filter((item) => isMet(resolution, item.id));
  }

  static async findStoriesNeedingDecomposition(repo: WorkItemRepository): Promise<WorkItem[]> {
    const items = await repo.listAll();
    const graph = await DependencyGraph.load(repo);
    const resolution = graph.resolveDependencies(buildDependencyContext(items));

    const needsDecomp: WorkItem[] = [];
    for (const story of items) {
      if (story.status !== "Pending" || story.level !== "Story") continue;
      if (!isMet(resolution, story.id)) continue;
      const children = await repo.findChildren(story.id);
      if (children.length === 0) {
        needsDecomp.push(story);
      }
    }
    return needsDecomp;
  }
}

/**
 * Resolves every item's dependency state in one pass, reusing the SAME machinery
 * the gate uses to decide eligibility (buildDependencyContext + resolveDependencies).
 * Returns the items exactly as `listAll()` yields them alongside the resolution map
 * so a caller can attach the `resolution`/`blockedBy` view to each item without
 * re-deriving the Abandoned-root signal (mig-phase-7 termination snapshot assembly,
 * ADR-029). Reads the repository fresh, so callers get a post-mutation view.
 */
export async function resolvePlanDependencies(
  repo: WorkItemRepository,
): Promise<{ items: WorkItem[]; resolution: Map<string, DependencyResolutionResult> }> {
  const items = await repo.listAll();
  const graph = await DependencyGraph.load(repo);
  const resolution = graph.resolveDependencies(buildDependencyContext(items));
  return { items, resolution };
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
      substitutedBy: extractSubstitutedBy(item.blockedReason),
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
