import { describe, test, expect } from "vitest";
import type { WorkItemId, WorkItemStatus } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { WorkItem } from "./work-item.js";
import type { ActiveProjects, WorkItemRepository } from "./repository.js";
import { GateKeeper } from "./gate.js";

const PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000002");

function repoOf(items: WorkItem[], edges: Array<{ fromId: WorkItemId; toId: WorkItemId }>) {
  const store = new Map(items.map((i) => [i.id as string, i]));
  const saves: Array<{ id: string; prev: WorkItemStatus; status: WorkItemStatus }> = [];
  const repo: WorkItemRepository = {
    findById: async (id) => store.get(id) ?? null,
    findChildren: async () => [],
    save: async (item, prev) => {
      saves.push({ id: item.id, prev, status: item.status });
      store.set(item.id, { ...item });
    },
    create: async (item) => item,
    listByProject: async () => [...store.values()].map((i) => ({ ...i, events: [] })),
    findByProjectAndStatus: async () => [],
    projectIdsWithStatus: async () => [],
    listIdsByStatus: async () => [],
    incrementDispatchCount: async () => 1,
    refundDispatchCount: async () => 0,
    addDependency: async () => {},
    getDependencies: async () => [],
    listAllDependencies: async () => edges,
    withTransaction: async (fn) => fn(repo),
  };
  return { repo, store, saves };
}

const projects: ActiveProjects = {
  listActiveIds: async () => [PROJECT_ID],
  block: async () => "blocked",
};

function task(status: WorkItemStatus, title: string): WorkItem {
  return {
    id: createWorkItemId(),
    level: "Task",
    status,
    title,
    runScope: "test-run",
    projectId: PROJECT_ID,
    dispatchCount: 0,
    workKind: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    events: [],
  };
}

describe("GateKeeper.filterAvailable", () => {
  test("a Pending task waiting on an Abandoned check task is parked at Blocked naming it, not left Pending", async () => {
    const check = { ...task("Abandoned", "write checks"), workKind: "check" as const };
    const impl = task("Pending", "implement");
    const { repo, store, saves } = repoOf([check, impl], [{ fromId: impl.id, toId: check.id }]);

    expect(await GateKeeper.filterAvailable(repo, projects)).toEqual([]);

    expect(saves).toEqual([{ id: impl.id, prev: "Pending", status: "Blocked" }]);
    const parked = store.get(impl.id);
    expect(parked?.blockedReason).toMatchObject({ source: "dependency_unsatisfiable", blockedBy: [check.id] });
    expect(parked?.blockedReason?.source === "dependency_unsatisfiable" ? parked.blockedReason.reason : "").toContain(
      `${check.id} (Abandoned)`,
    );
  });

  test("a Pending task waiting on a check task still in flight waits, unsaved", async () => {
    const check = { ...task("Pending", "write checks"), workKind: "check" as const };
    const impl = task("Pending", "implement");
    const { repo, saves } = repoOf([check, impl], [{ fromId: impl.id, toId: check.id }]);

    const eligible = await GateKeeper.filterAvailable(repo, projects);

    expect(eligible.map((i) => i.id)).toEqual([check.id]);
    expect(saves).toEqual([]);
  });
});
