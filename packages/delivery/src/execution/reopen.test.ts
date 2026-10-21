import { describe, expect, test } from "vitest";
import type { WorkItemId } from "@ashara/shared";
import { createWorkItemId, parseProjectId, recordingLogger } from "@ashara/shared";
import { InvalidStatusTransition } from "../work-item-language/transitions.js";
import { requeueWorkItem, startWorkItem, takeEvents } from "../domain/index.js";
import type { WorkItem, WorkItemRepository } from "../domain/index.js";
import type { ItemWrite, ReopenPlan, ReopenRoute } from "./reopen.js";
import { reopen } from "./reopen.js";

const PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000001", "test");

function inProgressItem(id: WorkItemId = createWorkItemId()): WorkItem {
  const now = new Date();
  const item: WorkItem = {
    id,
    level: "Task",
    status: "Pending",
    title: "reopened task",
    projectId: PROJECT_ID,
    overflowedWindowTokens: null,
    failureVerdict: { kind: "none" },
    dispatchCount: 1,
    workKind: "implementation",
    repairsTaskId: null,
    createdAt: now,
    updatedAt: now,
    events: [],
  };
  startWorkItem(item);
  takeEvents(item);
  return item;
}

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

/** Every step the protocol takes, in order, as the fakes see it. */
interface Recorder {
  readonly steps: string[];
  readonly repo: WorkItemRepository;
  readonly deps: { readonly workItemRepo: WorkItemRepository; readonly eventStore: { publish: () => Promise<void> }; readonly logger: ReturnType<typeof recordingLogger> };
}

/** A repo holding `item` (none when null) whose writes throw `writeThrows` when it is set. */
function recorder(item: WorkItem | null, writeThrows: unknown = null): Recorder {
  const steps: string[] = [];
  const write = (step: string, count: number | null) => async (): Promise<number> => {
    steps.push(step);
    if (writeThrows !== null) throw writeThrows;
    if (count === null) return 0;
    return count;
  };
  const repo: WorkItemRepository = {
    create: notExercised("create"),
    findById: async () => {
      steps.push("find");
      return item;
    },
    listByProject: notExercised("listByProject"),
    findByProjectAndStatus: notExercised("findByProjectAndStatus"),
    projectIdsWithStatus: notExercised("projectIdsWithStatus"),
    listIdsByStatus: notExercised("listIdsByStatus"),
    save: async () => {
      await write("save", null)();
    },
    incrementDispatchCount: notExercised("incrementDispatchCount"),
    saveRefunded: write("saveRefunded", 0),
    recordInfrastructureFault: notExercised("recordInfrastructureFault"),
    recordCrashOrphan: notExercised("recordCrashOrphan"),
    saveRefundedOverflow: write("saveRefundedOverflow", 0),
    saveOrphanExit: notExercised("saveOrphanExit"),
    recordMergeCommit: notExercised("recordMergeCommit"),
    addDependency: notExercised("addDependency"),
    getDependencies: notExercised("getDependencies"),
    findChildren: notExercised("findChildren"),
    listDependenciesByProject: notExercised("listDependenciesByProject"),
    listCorrectionHeld: notExercised("listCorrectionHeld"),
    withTransaction: async (fn) => {
      steps.push("transaction");
      return fn(repo);
    },
  };
  const eventStore = {
    publish: async (): Promise<void> => {
      if (steps.at(-1) !== "publish") steps.push("publish");
    },
  };
  return { steps, repo, deps: { workItemRepo: repo, eventStore, logger: recordingLogger() } };
}

/** A requeue whose plan is `plan`, everything it does recorded on `steps`. */
function requeueRoute(item: WorkItem, steps: string[], plan: Partial<ReopenPlan>, transition?: (item: WorkItem) => void): ReopenRoute<void> {
  return {
    taskId: item.id,
    site: "reopen.test",
    vanished: "vanished before it could be requeued",
    transition: (moved) => {
      steps.push("transition");
      (transition ?? requeueWorkItem)(moved);
    },
    transitionRejected: (e) => ({ message: `requeue rejected (${e.from} -> Pending)`, to: "Pending" }),
    plan: () => ({
      before: [],
      write: { kind: "refund" },
      rejected: null,
      log: () => steps.push("log"),
      ...plan,
    }),
  };
}

function warnings(r: Recorder): string[] {
  return r.deps.logger.records.filter((record) => record.level === "warn").map((record) => record.event);
}

describe("the reopen protocol", () => {
  test("a refund exit finds, transitions, writes with saveRefunded once, publishes, then reports", async () => {
    const item = inProgressItem();
    const r = recorder(item);
    await reopen(r.deps, requeueRoute(item, r.steps, { write: { kind: "refund" } }));
    expect(r.steps).toEqual(["find", "transition", "saveRefunded", "publish", "log"]);
    expect(r.steps.filter((step) => step === "saveRefunded")).toHaveLength(1);
  });

  test("a keep exit writes with save and never refunds", async () => {
    const item = inProgressItem();
    const r = recorder(item);
    await reopen(r.deps, requeueRoute(item, r.steps, { write: { kind: "save" } }));
    expect(r.steps).toEqual(["find", "transition", "save", "publish", "log"]);
  });

  test("the report reads the dispatch count after a refund, and none when the dispatch stays counted", async () => {
    const counts: Array<number | null> = [];
    for (const write of [{ kind: "refund" }, { kind: "save" }] satisfies ItemWrite[]) {
      const item = inProgressItem();
      const r = recorder(item);
      await reopen(r.deps, requeueRoute(item, r.steps, { write, log: (count) => counts.push(count) }));
    }
    expect(counts).toEqual([0, null]);
  });

  test("an overflow exit raises the window in its refund", async () => {
    const item = inProgressItem();
    const r = recorder(item);
    await reopen(r.deps, requeueRoute(item, r.steps, { write: { kind: "refund-overflow", windowTokens: 32_000 } }));
    expect(r.steps).toEqual(["find", "transition", "saveRefundedOverflow", "publish", "log"]);
  });

  test("a write before the item's commits and publishes first; a transactional exit writes its items then refunds, in one transaction", async () => {
    const item = inProgressItem();
    const r = recorder(item);
    const other = inProgressItem();
    requeueWorkItem(other);
    await reopen(
      r.deps,
      requeueRoute(item, r.steps, {
        before: [{ write: async () => void r.steps.push("before"), published: [other], rejected: null }],
        write: { kind: "refund-with", items: [], write: async () => void r.steps.push("with") },
      }),
    );
    expect(r.steps).toEqual(["find", "transition", "before", "publish", "transaction", "with", "saveRefunded", "publish", "log"]);
  });

  test("an item gone is warned of and nothing is moved or written", async () => {
    const item = inProgressItem();
    const r = recorder(null);
    await reopen(r.deps, requeueRoute(item, r.steps, {}));
    expect(r.steps).toEqual(["find"]);
    expect(warnings(r)).toEqual(["delivery.item-vanished"]);
  });

  test("a transition refused because the item moved leaves it where it is, with nothing written", async () => {
    const item = inProgressItem();
    item.status = "Abandoned";
    const r = recorder(item);
    await reopen(r.deps, requeueRoute(item, r.steps, {}));
    expect(r.steps).toEqual(["find", "transition"]);
    expect(warnings(r)).toEqual(["delivery.transition-rejected"]);
  });

  test("a write refused because the item moved is left, taken another way, or propagated, and nothing after it runs", async () => {
    const refused = (item: WorkItem): InvalidStatusTransition => new InvalidStatusTransition(item.id, "Abandoned", "Pending");

    const leftItem = inProgressItem();
    const left = recorder(leftItem, refused(leftItem));
    await reopen(left.deps, requeueRoute(leftItem, left.steps, { rejected: () => ({ kind: "left", left: { message: "left", to: "Pending" } }) }));
    expect(left.steps).toEqual(["find", "transition", "saveRefunded"]);
    expect(warnings(left)).toEqual(["delivery.transition-rejected"]);

    const insteadItem = inProgressItem();
    const instead = recorder(insteadItem, refused(insteadItem));
    await reopen(instead.deps, requeueRoute(insteadItem, instead.steps, { rejected: () => ({ kind: "instead", then: async () => void instead.steps.push("instead") }) }));
    expect(instead.steps).toEqual(["find", "transition", "saveRefunded", "instead"]);

    const thrownItem = inProgressItem();
    const rejection = refused(thrownItem);
    const thrown = recorder(thrownItem, rejection);
    await expect(reopen(thrown.deps, requeueRoute(thrownItem, thrown.steps, { rejected: null }))).rejects.toBe(rejection);
    expect(thrown.steps).toEqual(["find", "transition", "saveRefunded"]);
  });

  test("any other throw, from the transition or the write, propagates", async () => {
    const fault = new Error("the store is down");

    const moving = inProgressItem();
    const r = recorder(moving);
    const route = requeueRoute(moving, r.steps, {}, () => {
      throw fault;
    });
    await expect(reopen(r.deps, route)).rejects.toBe(fault);
    expect(r.steps).toEqual(["find", "transition"]);

    const writing = inProgressItem();
    const w = recorder(writing, fault);
    await expect(reopen(w.deps, requeueRoute(writing, w.steps, { rejected: () => ({ kind: "left", left: { message: "left", to: "Pending" } }) }))).rejects.toBe(fault);
    expect(w.steps).toEqual(["find", "transition", "saveRefunded"]);
  });
});
