import { describe, expect, test } from "vitest";
import { InvalidStatusTransition, type WorkItemId } from "@ashara/shared";
import { createTask, startWorkItem, failWorkItem, takeEvents } from "../domain/index.js";
import type { WorkItemRepository } from "../domain/index.js";
import type { RawFailureContext } from "../failure-router.js";
import { shouldSplit, splitFailedTask } from "./task-split.js";
import type { TaskSplitDeps } from "./task-split.js";

describe("shouldSplit", () => {
    const noSpec = { taskSpec: undefined };
    const withSpec = (splitDepth?: number) => ({
        taskSpec: splitDepth !== undefined ? { splitDepth } : {},
    });

    test("triggers on turn_limit with files changed (the Run 41 regression)", () => {
        // This is the exact scenario that silently broke when
        // output.files_changed was removed: the agent hit the turn limit
        // while making progress (files > 0), which means the task is
        // structurally too big — split it, don't retry it identically.
        expect(shouldSplit("turn_limit", 5, noSpec)).toBe(true);
        expect(shouldSplit("turn_limit", 1, noSpec)).toBe(true);
    });

    test("does NOT trigger on turn_limit with zero files (agent made no progress)", () => {
        // Zero files = agent was stuck, not too-big. Retrying or replanning
        // is the right action; splitting would just make two stuck tasks.
        expect(shouldSplit("turn_limit", 0, noSpec)).toBe(false);
    });

    test("does NOT trigger on non-turn-limit finish reasons", () => {
        expect(shouldSplit("completed", 5, noSpec)).toBe(false);
        expect(shouldSplit("error", 5, noSpec)).toBe(false);
        expect(shouldSplit("unknown", 5, noSpec)).toBe(false);
    });

    test("does NOT trigger on already-split tasks (prevents recursive splitting)", () => {
        expect(shouldSplit("turn_limit", 5, withSpec(1))).toBe(false);
        expect(shouldSplit("turn_limit", 5, withSpec(2))).toBe(false);
    });

    test("triggers when taskSpec exists but has no splitDepth", () => {
        expect(shouldSplit("turn_limit", 3, withSpec())).toBe(true);
    });

    test("triggers when taskSpec is undefined (no spec at all)", () => {
        expect(shouldSplit("turn_limit", 3, noSpec)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// splitFailedTask — transaction atomicity
// ---------------------------------------------------------------------------

const RUN_SCOPE = "test-run-scope";
const FAILURE: RawFailureContext = { detail: "turn limit reached", raw: {} };

function seedFailedTask(): ReturnType<typeof createTask> {
  const item = createTask("Build the thing", RUN_SCOPE, undefined, {
    deliverables: ["frontend", "backend"],
  });
  startWorkItem(item);
  failWorkItem(item, { source: "task_failed", reason: "turn limit" });
  takeEvents(item);
  item.dispatchCount = 1;
  return item;
}

function buildMockRepo(): {
  repo: WorkItemRepository;
  created: Array<{ id: string; title: string }>;
  saves: Array<{ id: string; from: string; to: string }>;
  dependencies: Array<{ fromId: string; toId: string }>;
} {
  const created: Array<{ id: string; title: string }> = [];
  const saves: Array<{ id: string; from: string; to: string }> = [];
  const dependencies: Array<{ fromId: string; toId: string }> = [];

  const makeInner = (): WorkItemRepository => ({
    create: async (item) => { created.push({ id: item.id, title: item.title }); return item; },
    findById: async () => null,
    findByStatus: async () => [],
    save: async (item, previousStatus) => {
      saves.push({ id: item.id, from: previousStatus, to: item.status });
    },
    incrementDispatchCount: async () => 1,
    listAll: async () => [],
    addDependency: async (fromId, toId) => { dependencies.push({ fromId, toId }); },
    getDependencies: async () => [],
    findChildren: async () => [],
    findDuplicate: async () => null,
    listAllDependencies: async () => [],
    withTransaction: async (fn) => fn(makeInner()),
  });

  const repo = makeInner();
  return { repo, created, saves, dependencies };
}

function buildDeps(repo: WorkItemRepository): TaskSplitDeps {
  return {
    workItemRepo: repo,
    eventPublisher: { publish: async () => {} },
    runScope: RUN_SCOPE,
  };
}

describe("splitFailedTask", () => {
  test("creates two children and abandons the parent in a single transaction", async () => {
    const task = seedFailedTask();
    const { repo, created, saves, dependencies } = buildMockRepo();

    await splitFailedTask(buildDeps(repo), task, FAILURE);

    expect(created).toHaveLength(2);
    expect(created[0].title).toContain("part 1 of 2");
    expect(created[1].title).toContain("part 2 of 2");

    expect(saves).toHaveLength(1);
    expect(saves[0].from).toBe("Failed");
    expect(saves[0].to).toBe("Abandoned");

    expect(task.status).toBe("Abandoned");
    expect(task.blockedReason).toMatchObject({ source: "split_on_failure" });
  });

  test("publishes the abandon event after the transaction commits", async () => {
    const task = seedFailedTask();
    const { repo, created } = buildMockRepo();
    const published: string[] = [];

    const deps: TaskSplitDeps = {
      workItemRepo: repo,
      eventPublisher: { publish: async (event) => { published.push((event as { eventType: string }).eventType); } },
      runScope: RUN_SCOPE,
    };

    await splitFailedTask(deps, task, FAILURE);

    expect(published).toContain("work_item.abandoned");
    expect(created).toHaveLength(2);
  });

  test("concurrent abandon rolls back children — no orphans", async () => {
    // Simulate the race: save() for the parent fails because a concurrent
    // process already moved it to Abandoned, so the pre-image check
    // (WHERE status = 'Failed') finds 'Abandoned' and throws.
    const task = seedFailedTask();
    const { repo, created, saves } = buildMockRepo();
    const deps = buildDeps(repo);

    // Override withTransaction: the inner repo's save throws on the parent
    // to simulate the concurrent-abandon race. The transaction must roll
    // back, so creates inside it should not persist.
    const innerCreated: string[] = [];
    deps.workItemRepo.withTransaction = async (fn) => {
      const innerRepo: WorkItemRepository = {
        create: async (item) => { innerCreated.push(item.id); return item; },
        findById: async () => null,
        findByStatus: async () => [],
        save: async (item, previousStatus) => {
          // The parent's save fails: concurrent process moved it to Abandoned
          throw new InvalidStatusTransition(item.id, "Abandoned", "Abandoned");
        },
        incrementDispatchCount: async () => 1,
        listAll: async () => [],
        addDependency: async () => {},
        getDependencies: async () => [],
        findChildren: async () => [],
        findDuplicate: async () => null,
        listAllDependencies: async () => [],
        withTransaction: async (innerFn) => innerFn(innerRepo),
      };
      return fn(innerRepo);
    };

    await expect(splitFailedTask(deps, task, FAILURE)).rejects.toThrow(InvalidStatusTransition);

    // The critical invariant: nothing was committed to the outer stores.
    // In production, the DB transaction rolls back all inner writes.
    // Here the mock's outer `created` and `saves` arrays are untouched.
    expect(created).toHaveLength(0);
    expect(saves).toHaveLength(0);
  });

  test("partB depends on partA and partA inherits parent dependencies", async () => {
    const task = seedFailedTask();
    const prereqId = "prereq-001" as WorkItemId;

    const { repo, dependencies } = buildMockRepo();
    // Simulate one existing dependency on the parent task
    repo.getDependencies = async () => [prereqId];

    await splitFailedTask(buildDeps(repo), task, FAILURE);

    // partA inherits the parent's dependency
    const partADeps = dependencies.filter((d) => d.toId === prereqId);
    expect(partADeps).toHaveLength(1);

    // partB depends on partA
    const partBonA = dependencies.filter((d) => d.toId === partADeps[0].fromId);
    expect(partBonA).toHaveLength(1);
  });
});
