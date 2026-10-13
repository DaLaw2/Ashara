import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DomainEvent, StoredBlockedReason, WorkItemStatus } from "@ashara/shared";
import { createWorkItemId, InvalidStatusTransition, parseProjectId } from "@ashara/shared";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import type { ParkedExitChecks } from "./parked-exits.js";
import { releaseClearedBlocks } from "./parked-exits.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000a1");

function blocked(reason: StoredBlockedReason): WorkItem {
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

function run(items: WorkItem[], checks: ParkedExitChecks, saveRefused = false) {
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
    refundDispatchCount: notExercised("refundDispatchCount"),
    recordMergeCommit: notExercised("recordMergeCommit"),
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
    checks,
  });
  return { released, saves, published };
}

const ownerUnresolved = (rosterRevision: number | null): StoredBlockedReason => ({
  source: "owner_unresolved",
  ownerRoleId: "role-1",
  rosterRevision,
  reason: "not in roster",
});
const environmentUndefined: StoredBlockedReason = { source: "environment_undefined", reason: "no statement" };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("owner_unresolved leaves Blocked when a newer roster revision is stored", () => {
  test("a newer revision releases it to Pending with its unblocked event", async () => {
    const item = blocked(ownerUnresolved(1));
    const { released, saves, published } = run([item], {
      latestRosterRevision: async () => 2,
      environmentBuilt: notExercised("environmentBuilt"),
    });

    expect(await released).toBe(1);
    expect(saves).toEqual([{ id: item.id, prev: "Blocked", status: "Pending", reason: undefined }]);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.unblocked"]);
  });

  test.each([
    { case: "the same revision", recorded: 2, latest: 2 },
    { case: "no roster at all", recorded: null, latest: null },
  ])("$case: it stays Blocked", async ({ recorded, latest }) => {
    const { released, saves } = run([blocked(ownerUnresolved(recorded))], {
      latestRosterRevision: async () => latest,
      environmentBuilt: notExercised("environmentBuilt"),
    });

    expect(await released).toBe(0);
    expect(saves).toEqual([]);
  });

  test("a block recorded with no revision (before migration 040) is re-checked once a roster exists", async () => {
    const { released } = run([blocked(ownerUnresolved(null))], {
      latestRosterRevision: async () => 1,
      environmentBuilt: notExercised("environmentBuilt"),
    });

    expect(await released).toBe(1);
  });
});

describe("environment_undefined leaves Blocked when the current version is built", () => {
  test("built: released; not built: stays; the check runs once per project", async () => {
    const built = vi.fn(async () => true);
    const items = [blocked(environmentUndefined), blocked(environmentUndefined)];
    const { released } = run(items, { latestRosterRevision: notExercised("latestRosterRevision"), environmentBuilt: built });

    expect(await released).toBe(2);
    expect(built).toHaveBeenCalledTimes(1);

    const notBuilt = run([blocked(environmentUndefined)], {
      latestRosterRevision: notExercised("latestRosterRevision"),
      environmentBuilt: async () => false,
    });
    expect(await notBuilt.released).toBe(0);
  });

  test("a check that throws leaves the task Blocked (fail-closed)", async () => {
    const { released, saves } = run([blocked(environmentUndefined)], {
      latestRosterRevision: notExercised("latestRosterRevision"),
      environmentBuilt: async () => {
        throw new Error("git unreadable");
      },
    });

    expect(await released).toBe(0);
    expect(saves).toEqual([]);
  });
});

describe("every other block waits on the operator", () => {
  test.each<StoredBlockedReason>([
    { source: "environment_unavailable", unavailable: "podman", reason: "down" },
    { source: "environment_change_needed", paths: ["environment/environment.toml"], reason: "edited" },
    { source: "checks_stale", checkTaskId: "c", reason: "stale" },
    { source: "checks_rewrite_bound", checkTaskId: "c", revision: 3, bound: 2, reason: "stale again" },
    { source: "dependency_unsatisfiable", blockedBy: ["x"], reason: "abandoned" },
    { source: "api" },
  ])("$source: no check is read, nothing is released", async (reason) => {
    const { released, saves } = run([blocked(reason)], {
      latestRosterRevision: notExercised("latestRosterRevision"),
      environmentBuilt: notExercised("environmentBuilt"),
    });

    expect(await released).toBe(0);
    expect(saves).toEqual([]);
  });
});

test("a release that loses a race to a concurrent write is not counted", async () => {
  const { released, published } = run(
    [blocked(ownerUnresolved(1))],
    { latestRosterRevision: async () => 2, environmentBuilt: notExercised("environmentBuilt") },
    true,
  );

  expect(await released).toBe(0);
  expect(published).toEqual([]);
});
