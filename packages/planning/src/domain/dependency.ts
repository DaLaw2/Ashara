import type { WorkItemId, WorkItemStatus } from "@ashara/shared";

import type { WorkItemRepository } from "./repository.js";
import { CycleDetected } from "./errors.js";

/**
 * How a work item's dependencies resolve (migration Phase 6, ADR-029):
 *  - `met`     — every dependency is Completed or satisfied by a completed substitute.
 *  - `waiting` — at least one dependency is still in flight (Pending/InProgress/Failed);
 *                a Failed dependency counts as waiting because recovery may replan it.
 *  - `blocked` — at least one dependency is permanently unsatisfiable (an Abandoned
 *                item with no completed substitute, directly or transitively), so the
 *                item can never become dispatchable and must be routed as
 *                blocked-with-reason rather than waiting forever.
 */
export type DependencyResolution = "met" | "waiting" | "blocked";

/** The status/identity view of a single item, as seen by dependency resolution. */
export interface DependencyItemView {
  readonly status: WorkItemStatus;
  readonly title: string;
  readonly parentId?: string;
  /** An explicit substitute recorded on an Abandoned item (blockedReason.substitutedBy). */
  readonly substitutedBy?: string;
}

/** Read model the graph consults to resolve dependency satisfaction and substitution. */
export interface DependencyContext {
  get(id: string): DependencyItemView | undefined;
  /**
   * Returns the id of a Completed item equivalent to (`parentId`, `title`) other than
   * `excludeId`, or undefined. Equivalence fallback = exact same-parent + same-title
   * (normalized); the contract-registry upgrade is Phase 9 (ADR-028).
   */
  findCompletedEquivalent(parentId: string | undefined, title: string, excludeId: string): string | undefined;
}

export interface DependencyResolutionResult {
  readonly resolution: DependencyResolution;
  /**
   * Root-cause Abandoned dependency ids that make this item unsatisfiable (direct or
   * transitive). Empty unless `resolution === "blocked"`. This is the derivable signal
   * mig-phase-7 consumes to detect "transitively blocked by an Abandoned dependency".
   */
  readonly blockedBy: readonly string[];
}

type DepState =
  | { readonly kind: "satisfied" }
  | { readonly kind: "pending" }
  | { readonly kind: "unsatisfiable"; readonly blockedBy: readonly string[] };

export class DependencyGraph {
  private edges: Map<string, Set<string>> = new Map();
  private reverseEdges: Map<string, Set<string>> = new Map();
  private nodes: Set<string> = new Set();

  static async load(repo: WorkItemRepository): Promise<DependencyGraph> {
    const pairs = await repo.listAllDependencies();
    const graph = new DependencyGraph();
    for (const { fromId, toId } of pairs) {
      graph.addEdge(fromId, toId);
    }
    return graph;
  }

  addEdge(fromId: WorkItemId, toId: WorkItemId): void {
    this.nodes.add(fromId);
    this.nodes.add(toId);

    let outgoing = this.edges.get(fromId);
    if (!outgoing) {
      outgoing = new Set();
      this.edges.set(fromId, outgoing);
    }
    outgoing.add(toId);

    let incoming = this.reverseEdges.get(toId);
    if (!incoming) {
      incoming = new Set();
      this.reverseEdges.set(toId, incoming);
    }
    incoming.add(fromId);

    if (this.hasCycle()) {
      outgoing.delete(toId);
      if (outgoing.size === 0) this.edges.delete(fromId);
      incoming.delete(fromId);
      if (incoming.size === 0) this.reverseEdges.delete(toId);
      throw new CycleDetected();
    }
  }

  /**
   * Resolves every node's dependency state in one memoized pass. Callers look up an
   * item's `DependencyResolutionResult`; items with no dependencies are absent from
   * the map (implicitly `met`). Traversal is safe because addEdge rejects cycles.
   */
  resolveDependencies(ctx: DependencyContext): Map<string, DependencyResolutionResult> {
    const memo = new Map<string, DependencyResolutionResult>();
    for (const node of this.nodes) {
      this.resolveNode(node, ctx, memo);
    }
    return memo;
  }

  /**
   * Recurses into a node's dependencies (via classifyDependency) with no visited-set
   * of its own: termination relies on the graph being acyclic, which addEdge enforces
   * by rejecting any edge that would create a cycle (CycleDetected). The memo also
   * caps each node to one computation.
   */
  private resolveNode(
    itemId: string,
    ctx: DependencyContext,
    memo: Map<string, DependencyResolutionResult>,
  ): DependencyResolutionResult {
    const cached = memo.get(itemId);
    if (cached) return cached;

    const deps = this.edges.get(itemId);
    if (!deps || deps.size === 0) {
      const met: DependencyResolutionResult = { resolution: "met", blockedBy: [] };
      memo.set(itemId, met);
      return met;
    }

    let hasPending = false;
    const blockedBy = new Set<string>();
    for (const dep of deps) {
      const state = this.classifyDependency(dep, ctx, memo);
      if (state.kind === "unsatisfiable") {
        for (const cause of state.blockedBy) blockedBy.add(cause);
      } else if (state.kind === "pending") {
        hasPending = true;
      }
    }

    const resolution: DependencyResolution =
      blockedBy.size > 0 ? "blocked" : hasPending ? "waiting" : "met";
    const result: DependencyResolutionResult = { resolution, blockedBy: [...blockedBy] };
    memo.set(itemId, result);
    return result;
  }

  private classifyDependency(
    dep: string,
    ctx: DependencyContext,
    memo: Map<string, DependencyResolutionResult>,
  ): DepState {
    const view = ctx.get(dep);
    // A dependency with no known item cannot be confirmed done, but it is not an
    // Abandoned block either — treat as pending (not met, not permanently blocked).
    if (!view) return { kind: "pending" };

    if (view.status === "Completed") return { kind: "satisfied" };

    // Substitution: an equivalent Completed item (same parent + title) satisfies the
    // dependency even if this item itself failed/was abandoned (Run-8 duplicate shape).
    if (ctx.findCompletedEquivalent(view.parentId, view.title, dep) !== undefined) {
      return { kind: "satisfied" };
    }

    if (view.status === "Abandoned") {
      // Honor an explicit substitute, fail-closed: only a Completed target counts.
      if (view.substitutedBy !== undefined) {
        const substitute = ctx.get(view.substitutedBy);
        if (substitute?.status === "Completed") return { kind: "satisfied" };
      }
      return { kind: "unsatisfiable", blockedBy: [dep] };
    }

    // Pending / InProgress / Failed / Blocked may still progress — unless the
    // dependency is itself transitively blocked by an Abandoned item.
    const downstream = this.resolveNode(dep, ctx, memo);
    if (downstream.resolution === "blocked") {
      return { kind: "unsatisfiable", blockedBy: downstream.blockedBy };
    }
    return { kind: "pending" };
  }

  hasCycle(): boolean {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    for (const node of this.nodes) {
      color.set(node, WHITE);
    }

    const dfs = (node: string): boolean => {
      color.set(node, GRAY);
      const neighbors = this.edges.get(node);
      if (neighbors) {
        for (const neighbor of neighbors) {
          const c = color.get(neighbor) ?? WHITE;
          if (c === GRAY) return true;
          if (c === WHITE && dfs(neighbor)) return true;
        }
      }
      color.set(node, BLACK);
      return false;
    };

    for (const node of this.nodes) {
      if (color.get(node) === WHITE && dfs(node)) return true;
    }
    return false;
  }

  computeUnlockWeights(): Map<string, number> {
    const weights = new Map<string, number>();
    for (const node of this.nodes) {
      weights.set(node, 0);
    }

    const sorted = this.topologicalSort();
    if (sorted.length === 0) return weights;

    // Forward topological order processes leaf dependents first (nodes whose
    // edges point only to already-visited dependencies). By the time we reach
    // a root dependency, all its downstream dependents already have their
    // weights computed. reverseEdges go from dependency → dependent.
    for (const node of sorted) {
      const dependents = this.reverseEdges.get(node);
      if (!dependents) continue;
      for (const dep of dependents) {
        const downstream = (weights.get(dep) ?? 0) + 1;
        if (downstream > (weights.get(node) ?? 0)) {
          weights.set(node, downstream);
        }
      }
    }

    return weights;
  }

  criticalPath(): WorkItemId[] {
    const sorted = this.topologicalSort();
    if (sorted.length === 0) return [];

    const dist = new Map<string, number>();
    const prev = new Map<string, string | null>();

    for (const node of sorted) {
      dist.set(node, 0);
      prev.set(node, null);
    }

    for (const node of sorted) {
      const currentDist = dist.get(node)!;
      const neighbors = this.edges.get(node);
      if (neighbors) {
        for (const neighbor of neighbors) {
          const newDist = currentDist + 1;
          if (newDist > (dist.get(neighbor) ?? 0)) {
            dist.set(neighbor, newDist);
            prev.set(neighbor, node);
          }
        }
      }
    }

    let endNode = sorted[0]!;
    let maxDist = 0;
    for (const [node, d] of dist) {
      if (d > maxDist) {
        maxDist = d;
        endNode = node;
      }
    }

    const path: string[] = [endNode];
    let current = endNode;
    let predecessor = prev.get(current);
    while (predecessor != null) {
      path.push(predecessor);
      current = predecessor;
      predecessor = prev.get(current) ?? null;
    }

    path.reverse();
    return path as WorkItemId[];
  }

  private topologicalSort(): string[] {
    if (this.hasCycle()) return [];

    const inDegree = new Map<string, number>();
    for (const node of this.nodes) {
      inDegree.set(node, 0);
    }
    for (const [, targets] of this.edges) {
      for (const target of targets) {
        inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [node, degree] of inDegree) {
      if (degree === 0) queue.push(node);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);
      const neighbors = this.edges.get(node);
      if (neighbors) {
        for (const neighbor of neighbors) {
          const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
          inDegree.set(neighbor, newDeg);
          if (newDeg === 0) queue.push(neighbor);
        }
      }
    }

    return sorted;
  }
}
