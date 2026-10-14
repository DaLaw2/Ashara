import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DomainEvent, StoredBlockedReason, WorkItemStatus } from "@ashara/shared";
import { BLOCKED_REASON_SOURCES, blockedExitOf, createWorkItemId, InvalidStatusTransition, parseProjectId } from "@ashara/shared";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { releaseClearedBlocks } from "./parked-exits.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000a1", "test");

function blocked(reason: StoredBlockedReason | undefined): WorkItem {
  return {
    id: createWorkItemId(),
    level: "Task",
    status: "Blocked",
    title: "t",
    runScope: "test",
    projectId: PROJECT,
    dispatchCount: 1,
    workKind: "implementation",
    blockedReason: reason,
    createdAt: new Date(),
    updatedAt: new Date(),
    events: [],
  };
}

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

function run(
  items: WorkItem[],
  saveRefused = false,
  recordMergeCommit: WorkItemRepository["recordMergeCommit"] = notExercised("recordMergeCommit"),
) {
  const saves: Array<{ id: string; prev: WorkItemStatus; status: WorkItemStatus; reason: unknown }> = [];
  const published: DomainEvent[] = [];
  const workItemRepo: WorkItemRepository = {
    create: notExercised("create"),
    findById: notExercised("findById"),
    listByProject: notExercised("listByProject"),
    findByProjectAndStatus: async (_projectId, status) => items.filter((i) => i.status === status).map((i) => ({ ...i, events: [] })),
    projectIdsWithStatus: notExercised("projectIdsWithStatus"),
    listIdsByStatus: notExercised("listIdsByStatus"),
    save: async (item, prev) => {
      if (saveRefused) throw new InvalidStatusTransition(item.id, "Abandoned", item.status);
      saves.push({ id: item.id, prev, status: item.status, reason: item.blockedReason });
    },
    incrementDispatchCount: notExercised("incrementDispatchCount"),
    recordInfrastructureFault: notExercised("recordInfrastructureFault"),
    refundDispatchCount: notExercised("refundDispatchCount"),
    recordMergeCommit,
    addDependency: notExercised("addDependency"),
    getDependencies: notExercised("getDependencies"),
    findChildren: notExercised("findChildren"),
    listDependenciesByProject: notExercised("listDependenciesByProject"),
    withTransaction: notExercised("withTransaction"),
  };
  const released = releaseClearedBlocks({
    workItemRepo,
    eventStore: { publish: async (event) => void published.push(event) },
    projects: { listActiveIds: async () => [PROJECT] },
  });
  return { released, saves, published };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// The verifier of W6: an owner_unresolved block waited on a newer roster revision, which no
// production path writes (db roster.ts recordFirstRoster refuses any revision but 1).
describe("a Blocked owner_unresolved or environment_undefined task is given up, never left waiting", () => {
  test.each<StoredBlockedReason>([
    { source: "owner_unresolved", ownerRoleId: "role-1", rosterRevision: 1, reason: "not in roster" },
    { source: "owner_unresolved", ownerRoleId: null, rosterRevision: null, reason: "the work item has no owner role" },
    { source: "environment_undefined", reason: "no statement" },
  ])("$source: Abandoned with its cause and its given_up event, for a plan repair", async (reason) => {
    const item = blocked(reason);
    const { released, saves, published } = run([item]);

    expect(await released).toBe(1);
    expect(saves).toEqual([{ id: item.id, prev: "Blocked", status: "Abandoned", reason }]);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.given_up"]);
  });
});

describe("merge_unrecorded leaves Blocked to Completed once its merge record is written", () => {
  const MERGE = "0123456789abcdef0123456789abcdef01234567";
  const unrecorded: StoredBlockedReason = { source: "merge_unrecorded", mergeCommit: MERGE, reason: "connection lost" };

  test("the record is written again and the item is Completed, never Pending", async () => {
    const item = blocked(unrecorded);
    const records: string[] = [];
    const { released, saves, published } = run([item], false, async (id, commit) => void records.push(`${id}:${commit}`));

    expect(await released).toBe(1);
    expect(records).toEqual([`${item.id}:${MERGE}`]);
    expect(saves).toEqual([{ id: item.id, prev: "Blocked", status: "Completed", reason: undefined }]);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.completed"]);
  });

  test("a record that still fails leaves it Blocked for the next cycle", async () => {
    const { released, saves } = run([blocked(unrecorded)], false, async () => {
      throw new Error("connection lost");
    });

    expect(await released).toBe(0);
    expect(saves).toEqual([]);
  });
});

// Story s-loop-never-stop-m1 W6 (ADR-074 addendum 2 d76): no work item waits on a person.
describe("no Blocked item is left with an exit only a person takes", () => {
  const MERGE = "0123456789abcdef0123456789abcdef01234567";
  // Keyed by every source: a source added to StoredBlockedReason fails to compile here until it is listed.
  const SAMPLE: { readonly [S in StoredBlockedReason["source"]]: Extract<StoredBlockedReason, { source: S }> } = {
    task_failed: { source: "task_failed", reason: "x" },
    orchestrator_error: { source: "orchestrator_error", reason: "x" },
    replan: { source: "replan", replanContext: { attempt: 1, detail: "x", raw: {} } },
    failure_router: { source: "failure_router", reason: "x" },
    environment_unavailable: { source: "environment_unavailable", unavailable: "podman", reason: "down" },
    environment_undefined: { source: "environment_undefined", reason: "no statement" },
    checks_stale: { source: "checks_stale", checkTaskId: "c", reason: "stale" },
    environment_change_needed: { source: "environment_change_needed", paths: ["environment/environment.toml"], reason: "edited" },
    owner_unresolved: { source: "owner_unresolved", ownerRoleId: "role-1", rosterRevision: 1, reason: "not in roster" },
    checks_rewrite_bound: { source: "checks_rewrite_bound", checkTaskId: "c", revision: 3, bound: 2, reason: "stale again" },
    check_disputed: { source: "check_disputed", checkTaskId: "c", checkName: "n", reason: "disputed" },
    suite_review_unresolved: { source: "suite_review_unresolved", checkTaskIds: ["c"], reason: "problems" },
    dependency_unsatisfiable: { source: "dependency_unsatisfiable", blockedBy: ["x"], reason: "abandoned" },
    merge_unrecorded: { source: "merge_unrecorded", mergeCommit: MERGE, reason: "connection lost" },
    superseded: { source: "superseded", planRevision: 2, requestedBy: null, reason: "replaced" },
    acceptance_failed: { source: "acceptance_failed", mainCommit: MERGE, reason: "check failed on main" },
    api: { source: "api" },
  };
  // Each exit names the production code that takes it; a new exit kind fails to compile here until
  // its writer is named. None is a person, and none waits on a write no production path makes.
  const WRITER: { readonly [K in ReturnType<typeof blockedExitOf>["kind"]]: string } = {
    "merge-recorded": "parked-exits.ts completeRecordedMerge: WorkItemRepository.recordMergeCommit, then completeRecordedMerge to Completed",
    requeue: "parked-exits.ts release: unblockWorkItem to Pending",
    "give-up": "parked-exits.ts giveUp: giveUpWorkItem to Abandoned; migration 048's plan_repair_on_abandon opens the repair the Replanner answers",
  };
  const LEAVES_TO: { readonly [K in ReturnType<typeof blockedExitOf>["kind"]]: WorkItemStatus } = {
    "merge-recorded": "Completed",
    requeue: "Pending",
    "give-up": "Abandoned",
  };

  test("every blocked-reason source leaves Blocked in the next sweep, through the production writer of its exit", async () => {
    for (const source of BLOCKED_REASON_SOURCES) {
      const exit = blockedExitOf(SAMPLE[source]).kind;
      const recorded: string[] = [];
      const { released, saves } = run([blocked(SAMPLE[source])], false, async (id) => void recorded.push(id));

      expect(WRITER[exit], source).toMatch(/^parked-exits\.ts /);
      expect(await released, `${source} (${WRITER[exit]})`).toBe(1);
      expect(saves.map((save) => save.status), source).toEqual([LEAVES_TO[exit]]);
      expect(recorded, source).toHaveLength(exit === "merge-recorded" ? 1 : 0);
    }
  });

  test("a Blocked item with no reason at all is given up too", async () => {
    const { released, saves } = run([blocked(undefined)]);
    expect(await released).toBe(1);
    expect(saves).toEqual([expect.objectContaining({ status: "Abandoned", reason: expect.objectContaining({ source: "orchestrator_error" }) })]);
  });

  test("only a merge-record wait stays Blocked past its sweep; every other source requeues or is given up", () => {
    const waiting = BLOCKED_REASON_SOURCES.filter((source) => {
      const exit = blockedExitOf(SAMPLE[source]);
      return exit.kind !== "requeue" && exit.kind !== "give-up";
    });
    expect([...waiting]).toEqual(["merge_unrecorded"]);
  });

  test("an infrastructure block (written before migration 048) goes back to Pending at once, unblocked by its automatic exit", async () => {
    const { released, saves, published } = run([blocked(SAMPLE.environment_unavailable)]);
    expect(await released).toBe(1);
    expect(saves).toEqual([expect.objectContaining({ status: "Pending", reason: undefined })]);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.unblocked"]);
  });

  test.each<StoredBlockedReason>([
    SAMPLE.environment_change_needed,
    SAMPLE.checks_stale,
    SAMPLE.checks_rewrite_bound,
    SAMPLE.check_disputed,
    SAMPLE.suite_review_unresolved,
    SAMPLE.dependency_unsatisfiable,
    SAMPLE.api,
  ])("$source: the task is given up with its cause, for a plan repair", async (reason) => {
    const { released, saves, published } = run([blocked(reason)]);

    expect(await released).toBe(1);
    expect(saves).toEqual([expect.objectContaining({ prev: "Blocked", status: "Abandoned", reason })]);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.given_up"]);
  });
});

test("a give-up that loses a race to a concurrent write is not counted", async () => {
  const { released, published } = run([blocked({ source: "owner_unresolved", ownerRoleId: "role-1", rosterRevision: 1, reason: "not in roster" })], true);

  expect(await released).toBe(0);
  expect(published).toEqual([]);
});
