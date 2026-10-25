import { describe, test, expect } from "vitest";
import type { DomainEvent, ProjectId, WorkItemId } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import type { WorkItemStatus } from "../work-item-language/work-item-status.js";
import type { WorkItem } from "./work-item.js";
import type { ActiveProjects, WorkItemRepository } from "./repository.js";
import { GateKeeper } from "./gate.js";
import type { EventPublisher } from "../lifecycle/ports.js";
import { inertWorkItemRepo } from "./testing.js";

const PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000002", "test");
const OTHER_PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000003", "test");

/** Reads are per project, as the database's: a project's items, and the edges its items depend by. */
function repoOf(items: WorkItem[], edges: Array<{ fromId: WorkItemId; toId: WorkItemId }>) {
  const store = new Map(items.map((i) => [i.id as string, i]));
  const saves: Array<{ id: string; prev: WorkItemStatus; status: WorkItemStatus }> = [];
  const projectOf = (id: string) => store.get(id)?.projectId;
  const repo: WorkItemRepository = inertWorkItemRepo({
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
    saveRefunded: async () => 0,
    saveRefundedOverflow: async () => 0,
    recordCrashOrphan: async () => 1,
    recordMergeCommit: async () => {},
    addDependency: async () => {},
    getDependencies: async () => [],
    listDependenciesByProject: async (projectId) => edges.filter((e) => projectOf(e.fromId) === projectId),
    listCorrectionHeld: async () => [],
    withTransaction: async (fn) => fn(repo),
  });
  return { repo, store, saves };
}

function activeProjects(...ids: ProjectId[]): ActiveProjects {
  return { listActiveIds: async () => ids, block: async () => "blocked" };
}

const projects = activeProjects(PROJECT_ID);

/** The tasks the gate admits, each project contained by a ledger in memory that lets nothing escape. */
async function admitted(repo: WorkItemRepository, active: ActiveProjects, events: EventPublisher): Promise<WorkItem[]> {
  return (await GateKeeper.filterAvailable(repo, active, events, memoryStepContainment(() => false), recordingLogger())).available;
}

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
    projectId,
    overflowedWindowTokens: null,
    failureVerdict: { kind: "none" },
    dispatchCount: 0,
    workKind: null,
    repairsTaskId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    events: [],
  };
}


describe("GateKeeper.filterAvailable", () => {
  test("a Pending task waiting on an Abandoned check task is given up naming it, and the give-up is published", async () => {
    const check = { ...task("Abandoned", "write checks"), workKind: "check" as const };
    const impl = task("Pending", "implement");
    const { repo, store, saves } = repoOf([check, impl], [{ fromId: impl.id, toId: check.id }]);
    const { events, published } = publisher();

    expect(await admitted(repo, projects, events)).toEqual([]);

    expect(saves).toEqual([{ id: impl.id, prev: "Pending", status: "Abandoned" }]);
    const parked = store.get(impl.id);
    expect(parked?.blockedReason).toMatchObject({ source: "dependency_unsatisfiable", blockedBy: [check.id] });
    expect(parked?.blockedReason?.source === "dependency_unsatisfiable" ? parked.blockedReason.reason : "").toContain(
      `${check.id} (Abandoned)`,
    );
    expect(published.map((e) => [e.eventType, e.payload["work_item_id"]])).toEqual([["work_item.given_up", impl.id]]);
  });

  test("an Abandoned check task gives up only the task it checks; its other dependents are released", async () => {
    const own = task("Pending", "implement the checked task");
    const other = task("Pending", "implement another task");
    const check = { ...task("Abandoned", "write checks"), workKind: "check" as const, taskSpec: { checksFor: own.id } };
    const { repo, store, saves } = repoOf(
      [check, own, other],
      [
        { fromId: own.id, toId: check.id },
        { fromId: other.id, toId: check.id },
      ],
    );
    const { events } = publisher();

    const eligible = await admitted(repo, projects, events);

    expect(eligible.map((i) => i.id)).toEqual([other.id]);
    expect(saves).toEqual([{ id: own.id, prev: "Pending", status: "Abandoned" }]);
    expect(store.get(own.id)?.blockedReason).toMatchObject({ source: "dependency_unsatisfiable", blockedBy: [check.id] });
  });

  // The plan's review runs after its last check task, before any implementation.
  test("implementations wait on the plan's review, which waits on every check task; a clean review releases them", async () => {
    const own = task("Pending", "implement the checked task");
    const other = task("Pending", "implement another task");
    const checkA = { ...task("Completed", "write checks a"), workKind: "check" as const, taskSpec: { origin: "check" as const, checksFor: own.id } };
    const checkB = { ...task("Pending", "write checks b"), workKind: "check" as const, taskSpec: { origin: "check" as const, checksFor: other.id } };
    const review = { ...task("Pending", "review the checks"), workKind: "check" as const, taskSpec: { origin: "review" as const } };
    const edges = [
      { fromId: review.id, toId: checkA.id },
      { fromId: review.id, toId: checkB.id },
      ...[own, other].flatMap((impl) => [
        { fromId: impl.id, toId: checkA.id },
        { fromId: impl.id, toId: checkB.id },
        { fromId: impl.id, toId: review.id },
      ]),
    ];
    const { repo, store } = repoOf([checkA, checkB, review, own, other], edges);
    const { events } = publisher();

    // A check task still to run: only it is dispatched.
    expect((await admitted(repo, projects, events)).map((i) => i.id)).toEqual([checkB.id]);

    // Every check task done: only the review is dispatched, not one implementation.
    store.set(checkB.id, { ...checkB, status: "Completed" });
    expect((await admitted(repo, projects, events)).map((i) => i.id)).toEqual([review.id]);

    // The review completed: the implementations are released.
    store.set(review.id, { ...review, status: "Completed" });
    expect((await admitted(repo, projects, events)).map((i) => i.id).sort()).toEqual([own.id, other.id].sort());
  });

  test("an Abandoned check task does not hold the review, which reads the other suites; its own task is given up", async () => {
    const own = task("Pending", "implement the checked task");
    const checkA = { ...task("Abandoned", "write checks a"), workKind: "check" as const, taskSpec: { origin: "check" as const, checksFor: own.id } };
    const checkB = { ...task("Completed", "write checks b"), workKind: "check" as const, taskSpec: { origin: "check" as const, checksFor: "other" } };
    const review = { ...task("Pending", "review the checks"), workKind: "check" as const, taskSpec: { origin: "review" as const } };
    const { repo } = repoOf(
      [checkA, checkB, review, own],
      [
        { fromId: review.id, toId: checkA.id },
        { fromId: review.id, toId: checkB.id },
        { fromId: own.id, toId: checkA.id },
        { fromId: own.id, toId: review.id },
      ],
    );
    const { events } = publisher();

    expect((await admitted(repo, projects, events)).map((i) => i.id)).toEqual([review.id]);
  });

  test("a Pending task waiting on a check task still in flight waits, unsaved", async () => {
    const check = { ...task("Pending", "write checks"), workKind: "check" as const };
    const impl = task("Pending", "implement");
    const { repo, saves } = repoOf([check, impl], [{ fromId: impl.id, toId: check.id }]);
    const { events, published } = publisher();

    const eligible = await admitted(repo, projects, events);

    expect(eligible.map((i) => i.id)).toEqual([check.id]);
    expect(saves).toEqual([]);
    expect(published).toEqual([]);
  });

  test("one project's dependency cycle gives its tasks on it up; another project's tasks still dispatch", async () => {
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

    const eligible = await admitted(repo, activeProjects(PROJECT_ID, OTHER_PROJECT_ID), events);

    expect(eligible.map((i) => i.id)).toEqual([free.id]);
    for (const parked of [a, b, waiting]) {
      const reason = store.get(parked.id)?.blockedReason;
      expect(store.get(parked.id)?.status).toBe("Abandoned");
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

    const eligible = await admitted(repo, projects, publisher().events);

    expect(eligible.map((i) => i.id)).toEqual([next.id]);
    expect(saves).toEqual([]);
  });

  test("a publish failure leaves the give-up committed", async () => {
    const gone = task("Abandoned", "given up");
    const impl = task("Pending", "implement");
    const { repo, store } = repoOf([gone, impl], [{ fromId: impl.id, toId: gone.id }]);

    await admitted(repo, projects, {
      publish: async () => {
        throw new Error("event store down");
      },
    });

    expect(store.get(impl.id)?.status).toBe("Abandoned");
  });

  test("one project's unknown failure is contained to it: recorded and backed off, the other project's tasks still dispatch", async () => {
    const own = task("Pending", "own");
    const other = task("Pending", "other", OTHER_PROJECT_ID);
    const { repo } = repoOf([own, other], []);
    const failing: WorkItemRepository = {
      ...repo,
      listByProject: async (projectId) => {
        if (projectId === PROJECT_ID) throw new TypeError("cannot read properties of undefined (reading 'status')");
        return repo.listByProject(projectId);
      },
    };
    const containment = memoryStepContainment(() => false);

    const gated = await GateKeeper.filterAvailable(failing, activeProjects(PROJECT_ID, OTHER_PROJECT_ID), publisher().events, containment, recordingLogger());

    expect(gated.available.map((i) => i.id)).toEqual([other.id]);
    expect(containment.recorded.get(`gate/${PROJECT_ID}`)).toMatchObject({ faults: 1, error: expect.stringContaining("TypeError") });
  });
});
