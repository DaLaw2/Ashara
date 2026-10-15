import type { ProjectId, WorkItemId } from "@ashara/shared";
import type { WorkItemStatus } from "../work-item-language/work-item-status.js";
import type { WorkItemRepository } from "./repository.js";
import { CycleDetected } from "./errors.js";

/**
 * How a work item's dependencies resolve (migration Phase 6, ADR-029):
 *  - `met`     — every dependency is Completed or has a Completed equivalent.
 *  - `waiting` — at least one dependency is still in flight (Pending/InProgress/Failed);
 *                a Failed dependency counts as waiting because recovery may replan it.
 *  - `blocked` — at least one dependency is permanently unsatisfiable (an Abandoned
 *                item, directly or transitively, or a cycle), so the
 *                item can never become dispatchable and must be routed as
 *                blocked-with-reason rather than waiting forever.
 * A check task orders every implementation of its plan revision but gates only the task it checks
 * (ADR-074 addendum 2 d68 c): to any other dependent it is satisfied once terminal, Abandoned too.
 */
type DependencyResolution = "met" | "waiting" | "blocked";

/** The status/identity view of a single item, as seen by dependency resolution. */
export interface DependencyItemView {
  readonly status: WorkItemStatus;
  readonly title: string;
  readonly parentId?: string;
  /**
   * A check task's `task_spec.checksFor`: the one task it gates. null for every other item, and for
   * a check task that names none, which then gates every dependent as any other item does.
   */
  readonly checksFor: string | null;
}

/** Read model the graph consults to resolve dependency satisfaction. */
export interface DependencyContext {
  get(id: string): DependencyItemView | undefined;
  /**
   * Returns the id of a Completed item equivalent to (`parentId`, `title`) other than
   * `excludeId`, or undefined. Equivalence = exact same-parent + same-title (normalized).
   */
  findCompletedEquivalent(parentId: string | undefined, title: string, excludeId: string): string | undefined;
}

export interface DependencyResolutionResult {
  readonly resolution: DependencyResolution;
  /**
   * Root-cause ids that make this item unsatisfiable (direct or transitive): Abandoned
   * dependencies, and for a cycle the item on it where resolution closed it. Empty unless `resolution === "blocked"`. It carries the "blocked"
   * resolution up the dependency chain: a dependent inherits its unsatisfiable
   * dependency's root causes, so the resolution stays "blocked" transitively.
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
  private readonly cycleEdges: CycleDetected[] = [];

  /**
   * One project's dependency graph: the edges whose dependent item is the project's (the
   * dependencies table has no project_id). An edge that closes a cycle is kept and reported in
   * `cycles`, never thrown: the cycle is that project's alone, and resolution parks its members
   * instead of every project's gate failing on it.
   */
  static async load(repo: WorkItemRepository, projectId: ProjectId): Promise<DependencyGraph> {
    const pairs = await repo.listDependenciesByProject(projectId);
    const graph = new DependencyGraph();
    for (const { fromId, toId } of pairs) {
      try {
        graph.addEdge(fromId, toId);
      } catch (err) {
        if (!(err instanceof CycleDetected)) throw err;
        graph.link(fromId, toId);
        graph.cycleEdges.push(err);
      }
    }
    return graph;
  }

  /** The edges load() kept although each closed a cycle; empty for an acyclic graph. */
  get cycles(): readonly CycleDetected[] {
    return this.cycleEdges;
  }

  /** Adds the edge, or throws CycleDetected naming it and leaves the graph as it was. */
  addEdge(fromId: WorkItemId, toId: WorkItemId): void {
    const added = this.link(fromId, toId);
    if (this.hasCycle()) {
      this.unlink(fromId, toId, added);
      throw new CycleDetected(fromId, toId);
    }
  }

  private link(fromId: string, toId: string): { readonly from: boolean; readonly to: boolean } {
    const added = { from: !this.nodes.has(fromId), to: !this.nodes.has(toId) };
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
    return added;
  }

  private unlink(fromId: string, toId: string, added: { readonly from: boolean; readonly to: boolean }): void {
    const outgoing = this.edges.get(fromId);
    outgoing?.delete(toId);
    if (outgoing?.size === 0) this.edges.delete(fromId);
    const incoming = this.reverseEdges.get(toId);
    incoming?.delete(fromId);
    if (incoming?.size === 0) this.reverseEdges.delete(toId);
    if (added.from) this.nodes.delete(fromId);
    if (added.to) this.nodes.delete(toId);
  }

  /**
   * Resolves every node's dependency state in one memoized pass. The returned map
   * contains entries only for items that appear in at least one dependency edge —
   * items with no edges are absent, so callers (e.g. `isMet`) must handle absence
   * themselves. A graph load() kept a cycle in resolves each item on it, and each
   * item waiting on it, as blocked by the cycle.
   */
  resolveDependencies(ctx: DependencyContext): Map<string, DependencyResolutionResult> {
    const memo = new Map<string, DependencyResolutionResult>();
    for (const node of this.nodes) {
      this.resolveNode(node, ctx, memo);
    }
    return memo;
  }

  /**
   * Recurses into a node's dependencies (via classifyDependency). `resolving` holds every node
   * entered in this pass: a node met again before it is memoized is on a cycle, and resolves as
   * blocked by itself, which every node of the cycle (and each waiting on it) inherits. Once
   * memoized, a node is never computed again, so the recursion terminates on a cyclic graph too.
   * A Completed dependency (or one with a Completed equivalent) is satisfied before any
   * recursion, so a cycle through finished work blocks nothing.
   */
  private resolveNode(
    itemId: string,
    ctx: DependencyContext,
    memo: Map<string, DependencyResolutionResult>,
    resolving?: Set<string>,
  ): DependencyResolutionResult {
    const cached = memo.get(itemId);
    if (cached) return cached;

    const active = resolving ?? new Set<string>();
    if (active.has(itemId)) {
      const blocked: DependencyResolutionResult = { resolution: "blocked", blockedBy: [itemId] };
      memo.set(itemId, blocked);
      return blocked;
    }
    active.add(itemId);

    const deps = this.edges.get(itemId);
    if (!deps || deps.size === 0) {
      const met: DependencyResolutionResult = { resolution: "met", blockedBy: [] };
      memo.set(itemId, met);
      return met;
    }

    let hasPending = false;
    const blockedBy = new Set<string>();
    for (const dep of deps) {
      const state = this.classifyDependency(itemId, dep, ctx, memo, active);
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
    dependent: string,
    dep: string,
    ctx: DependencyContext,
    memo: Map<string, DependencyResolutionResult>,
    resolving?: Set<string>,
  ): DepState {
    const view = ctx.get(dep);
    if (!view) return { kind: "pending" };

    if (view.status === "Completed") return { kind: "satisfied" };

    if (ctx.findCompletedEquivalent(view.parentId, view.title, dep) !== undefined) {
      return { kind: "satisfied" };
    }

    if (view.status === "Abandoned") {
      if (view.checksFor !== null && view.checksFor !== dependent) return { kind: "satisfied" };
      return { kind: "unsatisfiable", blockedBy: [dep] };
    }

    // Pending / InProgress / Failed / Blocked may still progress — unless the
    // dependency is itself transitively blocked by an Abandoned item.
    const downstream = this.resolveNode(dep, ctx, memo, resolving);
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
