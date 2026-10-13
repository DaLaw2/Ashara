import type {
  WorkItemId,
  WorkItemStatus,
  DomainEvent,
  ProjectId,
  ProjectContract,
  ContractInput,
  ContractDelta,
  ContractRepository,
} from "@ashara/shared";
import { ContractBodySchema, ContractDeltaSchema, ContractVersionConflict } from "@ashara/shared";
import type { WorkItem } from "./work-item.js";
import type { ActiveProjects, WorkItemRepository } from "./repository.js";
import type { EventPublisher } from "../lifecycle/ports.js";
import { DependencyGraph } from "./dependency.js";
import { GateKeeper } from "./gate.js";
import { TaskSelector } from "./select.js";
import { LifecycleRouter } from "./router.js";
import { applyContractDelta } from "./contract-merge.js";
import { ContractAlreadyExists, ContractNotFound } from "./errors.js";

export class PlanningService {
  static async gate(repo: WorkItemRepository, projects: ActiveProjects, events: EventPublisher): Promise<WorkItem[]> {
    return GateKeeper.filterAvailable(repo, projects, events);
  }

  /**
   * How many tasks each eligible task's completion unlocks, from each of their projects' own
   * dependency graph (a cycle in one project leaves only that project's weights at zero).
   */
  static async unlockWeights(repo: WorkItemRepository, eligible: readonly WorkItem[]): Promise<Map<string, number>> {
    const weights = new Map<string, number>();
    for (const projectId of new Set(eligible.map((item) => item.projectId))) {
      const graph = await DependencyGraph.load(repo, projectId);
      for (const [id, weight] of graph.computeUnlockWeights()) weights.set(id, weight);
    }
    return weights;
  }

  static select(
    eligible: WorkItem[],
    maxBatchSize: number,
    unlockWeights?: Map<string, number>,
  ): WorkItem[] {
    return TaskSelector.selectBatch(eligible, maxBatchSize, unlockWeights);
  }

  static async route(
    repo: WorkItemRepository,
    taskId: WorkItemId,
    success: boolean,
  ): Promise<DomainEvent[]> {
    return LifecycleRouter.route(repo, taskId, success);
  }

  static async activateAncestors(
    repo: WorkItemRepository,
    parentId: WorkItemId | undefined,
  ): Promise<DomainEvent[]> {
    return LifecycleRouter.activateAncestors(repo, parentId);
  }

  static async findWorkItem(repo: WorkItemRepository, id: WorkItemId): Promise<WorkItem | null> {
    return repo.findById(id);
  }

  static async saveWorkItem(
    repo: WorkItemRepository,
    item: WorkItem,
    expectedPreviousStatus: WorkItemStatus,
  ): Promise<void> {
    return repo.save(item, expectedPreviousStatus);
  }

  static async createWorkItem(repo: WorkItemRepository, item: WorkItem): Promise<WorkItem> {
    return repo.create(item);
  }

  /**
   * Seeds the initial ProjectContract at version 1 (ADR-028). Fail-closed against a
   * double-seed: the getLatest check is the fast path for an already-seeded project,
   * and the version-1 insert is the physical guard — a concurrent seed that slips
   * past the check still collides on version 1 (never silently becomes version 2),
   * surfacing as ContractVersionConflict which is translated here to
   * ContractAlreadyExists. Either way the caller sees ContractAlreadyExists and a
   * change must go through amendContract, never a blind full re-write.
   */
  static async writeContract(
    repo: ContractRepository,
    projectId: ProjectId,
    input: ContractInput,
  ): Promise<ProjectContract> {
    const body = ContractBodySchema.parse(input);
    return repo.withTransaction(async (tx) => {
      const existing = await tx.getLatest(projectId);
      if (existing) {
        throw new ContractAlreadyExists(projectId);
      }
      try {
        return await tx.insertVersion(projectId, 1, body);
      } catch (err) {
        if (err instanceof ContractVersionConflict) {
          throw new ContractAlreadyExists(projectId);
        }
        throw err;
      }
    });
  }

  /**
   * Merges an additive delta onto the project's latest contract and writes the
   * result as version latest+1 (ADR-028). Read-latest → merge → insert is
   * transactional, so an injected failure rolls back cleanly and no version is
   * skipped.
   *
   * Retry contract: if a concurrent amend already took version latest+1, this throws
   * ContractVersionConflict (not a raw driver error). That is the RETRYABLE signal —
   * a caller should re-read the latest version and re-apply its delta onto the newer
   * base (a bounded retry-on-conflict; callers like decomposition and completion
   * amends in phase 9 will want one).
   */
  static async amendContract(
    repo: ContractRepository,
    projectId: ProjectId,
    delta: ContractDelta,
  ): Promise<ProjectContract> {
    const parsedDelta = ContractDeltaSchema.parse(delta);
    return repo.withTransaction(async (tx) => {
      const latest = await tx.getLatest(projectId);
      if (!latest) {
        throw new ContractNotFound(projectId);
      }
      const merged = applyContractDelta(latest, parsedDelta);
      return tx.insertVersion(projectId, latest.version + 1, merged);
    });
  }
}
