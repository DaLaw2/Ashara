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
}

/**
 * Items absent from the dependency graph have no edges — "no dependencies"
 * genuinely resolves to "met". Shared by the resolver function so each
 * lookup returns the same frozen instance rather than allocating.
 */
const NO_DEPENDENCIES: DependencyResolutionResult = Object.freeze({
  resolution: "met",
  blockedBy: [],
});

/**
 * Resolves every item's dependency state in one pass, reusing the SAME machinery
 * the gate uses to decide eligibility (buildDependencyContext + resolveDependencies).
 * Returns the items exactly as `listAll()` yields them alongside a TOTAL resolver
 * function — every id returns a DependencyResolutionResult, never undefined.
 * Items absent from the dependency graph (no edges) resolve to "met" inside the
 * function rather than at each call site, so consumers need no ?? fallback and
 * absence is unrepresentable in the return type (Discipline A).
 *
 * Reads the repository fresh, so callers get a post-mutation view.
 */
export async function resolvePlanDependencies(
  repo: WorkItemRepository,
): Promise<{ items: WorkItem[]; resolveItem: (id: string) => DependencyResolutionResult }> {
  const items = await repo.listAll();
  const graph = await DependencyGraph.load(repo);
  const resolution = graph.resolveDependencies(buildDependencyContext(items));
  return {
    items,
    resolveItem: (id: string): DependencyResolutionResult =>
      resolution.get(id) ?? NO_DEPENDENCIES,
  };
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
