import { describe, test, expect, vi, beforeEach } from "vitest";
import type { DomainEvent, ProjectId, WorkItemId, WorkItemStatus } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { WorkItem } from "./work-item.js";
import type { ActiveProjects, WorkItemRepository } from "./repository.js";
import { GateKeeper } from "./gate.js";

const PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000002", "test");
const OTHER_PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000003", "test");

/** Reads are per project, as the database's: a project's items, and the edges its items depend by. */
function repoOf(items: WorkItem[], edges: Array<{ fromId: WorkItemId; toId: WorkItemId }>) {
  const store = new Map(items.map((i) => [i.id as string, i]));
  const saves: Array<{ id: string; prev: WorkItemStatus; status: WorkItemStatus }> = [];
  const projectOf = (id: string) => store.get(id)?.projectId;
  const repo: WorkItemRepository = {
    findById: async (id) => store.get(id) ?? null,
    findChildren: async () => [],
    save: async (item, prev) => {
      saves.push({ id: item.id, prev, status: item.status });
      store.set(item.id, { ...item });
    },
    create: async (item) => item,
    listByProject: async (projectId) =>
      [...store.values()].filter((i) => i.projectId === projectId).map((i) => ({ ...i, events: [] })),
    findByProjectAndStatus: async () => [],
    projectIdsWithStatus: async () => [],
    listIdsByStatus: async () => [],
    incrementDispatchCount: async () => 1,
    refundDispatchCount: async () => 0,
    recordMergeCommit: async () => {},
    addDependency: async () => {},
    getDependencies: async () => [],
    listDependenciesByProject: async (projectId) => edges.filter((e) => projectOf(e.fromId) === projectId),
    withTransaction: async (fn) => fn(repo),
  };
  return { repo, store, saves };
}

function activeProjects(...ids: ProjectId[]): ActiveProjects {
  return { listActiveIds: async () => ids, block: async () => "blocked" };
}

const projects = activeProjects(PROJECT_ID);

function publisher() {
  const published: DomainEvent[] = [];
  return { events: { publish: async (event: DomainEvent) => void published.push(event) }, published };
}

function task(status: WorkItemStatus, title: string, projectId: ProjectId = PROJECT_ID): WorkItem {
  return {
    id: createWorkItemId(),
    level: "Task",
    status,
    title,
    runScope: "test-run",
    projectId,
    dispatchCount: 0,
    workKind: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    events: [],
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GateKeeper.filterAvailable", () => {
  test("a Pending task waiting on an Abandoned check task is parked at Blocked naming it, and the park is published", async () => {
    const check = { ...task("Abandoned", "write checks"), workKind: "check" as const };
    const impl = task("Pending", "implement");
    const { repo, store, saves } = repoOf([check, impl], [{ fromId: impl.id, toId: check.id }]);
    const { events, published } = publisher();

    expect(await GateKeeper.filterAvailable(repo, projects, events)).toEqual([]);

    expect(saves).toEqual([{ id: impl.id, prev: "Pending", status: "Blocked" }]);
    const parked = store.get(impl.id);
    expect(parked?.blockedReason).toMatchObject({ source: "dependency_unsatisfiable", blockedBy: [check.id] });
    expect(parked?.blockedReason?.source === "dependency_unsatisfiable" ? parked.blockedReason.reason : "").toContain(
      `${check.id} (Abandoned)`,
    );
    expect(published.map((e) => [e.eventType, e.payload["work_item_id"]])).toEqual([["work_item.blocked", impl.id]]);
  });

  test("a Pending task waiting on a check task still in flight waits, unsaved", async () => {
    const check = { ...task("Pending", "write checks"), workKind: "check" as const };
    const impl = task("Pending", "implement");
    const { repo, saves } = repoOf([check, impl], [{ fromId: impl.id, toId: check.id }]);
    const { events, published } = publisher();

    const eligible = await GateKeeper.filterAvailable(repo, projects, events);

    expect(eligible.map((i) => i.id)).toEqual([check.id]);
    expect(saves).toEqual([]);
    expect(published).toEqual([]);
  });

  test("one project's dependency cycle parks its tasks on it; another project's tasks still dispatch", async () => {
    const a = task("Pending", "a");
    const b = task("Pending", "b");
    const waiting = task("Pending", "waits on the cycle");
    const free = task("Pending", "free", OTHER_PROJECT_ID);
    const ordered = task("Pending", "after free", OTHER_PROJECT_ID);
    const { repo, store } = repoOf(
      [a, b, waiting, free, ordered],
      [
        { fromId: a.id, toId: b.id },
        { fromId: b.id, toId: a.id },
        { fromId: waiting.id, toId: a.id },
        { fromId: ordered.id, toId: free.id },
      ],
    );
    const { events, published } = publisher();

    const eligible = await GateKeeper.filterAvailable(repo, activeProjects(PROJECT_ID, OTHER_PROJECT_ID), events);

    expect(eligible.map((i) => i.id)).toEqual([free.id]);
    for (const parked of [a, b, waiting]) {
      const reason = store.get(parked.id)?.blockedReason;
      expect(store.get(parked.id)?.status).toBe("Blocked");
      expect(reason?.source === "dependency_unsatisfiable" ? reason.reason : "").toContain("(on a dependency cycle)");
    }
    expect(store.get(ordered.id)?.status).toBe("Pending");
    expect(published.map((e) => e.payload["work_item_id"]).sort()).toEqual([a.id, b.id, waiting.id].sort());
  });

  test("a cycle through Completed work blocks nothing", async () => {
    const done = task("Completed", "done");
    const next = task("Pending", "next");
    const { repo, saves } = repoOf([done, next], [
      { fromId: next.id, toId: done.id },
      { fromId: done.id, toId: next.id },
    ]);

    const eligible = await GateKeeper.filterAvailable(repo, projects, publisher().events);

    expect(eligible.map((i) => i.id)).toEqual([next.id]);
    expect(saves).toEqual([]);
  });

  test("a publish failure leaves the park committed", async () => {
    const gone = task("Abandoned", "given up");
    const impl = task("Pending", "implement");
    const { repo, store } = repoOf([gone, impl], [{ fromId: impl.id, toId: gone.id }]);

    await GateKeeper.filterAvailable(repo, projects, {
      publish: async () => {
        throw new Error("event store down");
      },
    });

    expect(store.get(impl.id)?.status).toBe("Blocked");
  });
});
