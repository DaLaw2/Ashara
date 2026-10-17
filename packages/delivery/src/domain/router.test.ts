import { describe, test, expect } from "vitest";
import type { WorkItemId, DomainEvent } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { WorkItemNotFound } from "../work-item-language/transitions.js";
import type { WorkItemStatus } from "../work-item-language/work-item-status.js";
import { salvagedReason } from "./salvaged-result.js";
import type { WorkItem } from "./work-item.js";
import type { WorkItemRepository } from "./repository.js";
import { LifecycleRouter } from "./router.js";

// Minimal in-memory repo for testing cascade-completion through isSettled.
function buildInMemoryRepo(items: WorkItem[]): WorkItemRepository {
  const store = new Map(items.map((i) => [i.id as string, i]));
  return {
    findById: async (id: WorkItemId) => store.get(id) ?? null,
    findChildren: async (parentId: WorkItemId) =>
      [...store.values()].filter((i) => i.parentId === parentId),
    save: async (item: WorkItem, _prev: WorkItemStatus) => {
      store.set(item.id, { ...item });
    },
    // Methods not exercised by LifecycleRouter.route in these tests
    create: async (item: WorkItem) => item,
    listByProject: async () => [...store.values()],
    findByProjectAndStatus: async () => [],
    projectIdsWithStatus: async () => [],
    listIdsByStatus: async () => [],
    incrementDispatchCount: async () => 1,
    recordInfrastructureFault: async () => 1,
    recordOverflowedWindow: async () => undefined,
    recordCrashOrphan: async () => 1,
    saveOrphanExit: async () => {
      throw new Error("saveOrphanExit is not exercised by this test");
    },
    saveRefunded: async () => 0,
    recordMergeCommit: async () => {},
    addDependency: async () => {},
    getDependencies: async () => [],
    listDependenciesByProject: async () => [],
    withTransaction: async <T>(fn: (repo: WorkItemRepository) => Promise<T>) =>
      fn(buildInMemoryRepo([...store.values()])),
  };
}

const TEST_PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000001", "test");

function makeItem(overrides: Partial<WorkItem> & { id: WorkItemId; status: WorkItemStatus; title: string }): WorkItem {
  return {
    level: "Task",
    projectId: TEST_PROJECT_ID,
    failureVerdict: { kind: "none" },
    dispatchCount: 0,
    overflowedWindowTokens: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    events: [],
    ...overrides,
    workKind: overrides.workKind ?? null,
    repairsTaskId: overrides.repairsTaskId ?? null,
  };
}

describe("LifecycleRouter cascade-completion with salvaged results", () => {
  test("parent completes when one child is Completed and another is Abandoned with salvaged completed", async () => {
    const parentId = createWorkItemId();
    const childAId = createWorkItemId();
    const childBId = createWorkItemId();

    const parent = makeItem({ id: parentId, status: "InProgress", title: "parent" });
    const childA = makeItem({ id: childAId, status: "InProgress", title: "child-a", parentId });
    const childB = makeItem({
      id: childBId,
      status: "Abandoned",
      title: "child-b",
      parentId,
      blockedReason: salvagedReason(
        { source: "api", note: "abandoned via API" },
        "completed",
        "merged on main, after its post-merge checks passed on the merged tree",
      ),
    });

    const repo = buildInMemoryRepo([parent, childA, childB]);

    // Route child A as success — this completes child A and triggers cascade.
    const events = await LifecycleRouter.route(repo, childAId, "passed");

    // Child A must be Completed
    const savedChildA = await repo.findById(childAId);
    expect(savedChildA?.status).toBe("Completed");

    // Parent must cascade to Completed because child B's salvaged outcome
    // makes it settled.
    const savedParent = await repo.findById(parentId);
    expect(savedParent?.status).toBe("Completed");

    // Events must include both child completion and parent completion
    expect(events.some((e: DomainEvent) => e.eventType === "work_item.completed")).toBe(true);
  });

  test("parent does NOT complete when Abandoned child has no salvaged result", async () => {
    const parentId = createWorkItemId();
    const childAId = createWorkItemId();
    const childBId = createWorkItemId();

    const parent = makeItem({ id: parentId, status: "InProgress", title: "parent" });
    const childA = makeItem({ id: childAId, status: "InProgress", title: "child-a", parentId });
    const childB = makeItem({
      id: childBId,
      status: "Abandoned",
      title: "child-b",
      parentId,
      blockedReason: { source: "api", note: "abandoned via API" },
    });

    const repo = buildInMemoryRepo([parent, childA, childB]);

    await LifecycleRouter.route(repo, childAId, "passed");

    // Child A is Completed
    const savedChildA = await repo.findById(childAId);
    expect(savedChildA?.status).toBe("Completed");

    // Parent must NOT cascade: child B is Abandoned without a salvaged result,
    // so the work is genuinely missing.
    const savedParent = await repo.findById(parentId);
    expect(savedParent?.status).toBe("InProgress");
  });

  test("parent does NOT complete when Abandoned child has salvaged failed result", async () => {
    const parentId = createWorkItemId();
    const childAId = createWorkItemId();
    const childBId = createWorkItemId();

    const parent = makeItem({ id: parentId, status: "InProgress", title: "parent" });
    const childA = makeItem({ id: childAId, status: "InProgress", title: "child-a", parentId });
    const childB = makeItem({
      id: childBId,
      status: "Abandoned",
      title: "child-b",
      parentId,
      blockedReason: salvagedReason(
        { source: "api", note: "abandoned via API" },
        "failed",
        "agent hit turn limit",
      ),
    });

    const repo = buildInMemoryRepo([parent, childA, childB]);

    await LifecycleRouter.route(repo, childAId, "passed");

    // Parent must NOT cascade: child B's agent failed even though the result
    // was salvaged. Only a "completed" salvage settles.
    const savedParent = await repo.findById(parentId);
    expect(savedParent?.status).toBe("InProgress");
  });
});

describe("LifecycleRouter.activateAncestors", () => {
  test("a parent the store does not hold is WorkItemNotFound, never the end of the chain", async () => {
    const repo = buildInMemoryRepo([]);

    await expect(LifecycleRouter.activateAncestors(repo, createWorkItemId())).rejects.toThrow(WorkItemNotFound);
  });
});
