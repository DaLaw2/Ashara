import { describe, expect, test } from "vitest";
import type { WorkItemStatus } from "@ashara/shared";
import { RUN_SCOPE_AD_HOC, RUN_SCOPE_PRE_SCOPING } from "@ashara/shared";
import { createPendingWorkItem, startWorkItem, failWorkItem, takeEvents } from "./acl/planning-acl.js";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import type { ShutdownReconcilerDeps } from "./shutdown-reconciler.js";
import { terminalizeOnRunEnd } from "./shutdown-reconciler.js";

const THIS_RUN = "run-abc-123";
const OTHER_RUN = "run-xyz-999";

function seedItem(status: WorkItemStatus, runScope = THIS_RUN): WorkItem {
  const item = createPendingWorkItem("Task", `task-${status}`, runScope);
  switch (status) {
    case "InProgress":
      startWorkItem(item);
      break;
    case "Blocked":
      // Blocked is only reachable via the HTTP PATCH path (blockWorkItem),
      // which is not re-exported through the orchestrator ACL. Seed by
      // mutating directly — the test cares about the status, not the
      // transition audit trail.
      startWorkItem(item);
      item.status = "Blocked";
      item.blockedReason = { reason: "dependency" };
      item.updatedAt = new Date();
      break;
    case "Failed":
      startWorkItem(item);
      failWorkItem(item, { reason: "agent error" });
      break;
    case "Completed":
    case "Abandoned":
      throw new Error("Cannot seed a terminal item for this test via domain methods");
    case "Pending":
      break;
  }
  takeEvents(item);
  return item;
}

function buildDeps(items: WorkItem[]): {
  deps: ShutdownReconcilerDeps;
  saves: Array<{ id: string; from: string; to: string }>;
  publishes: Array<{ eventType: string }>;
} {
  const saves: Array<{ id: string; from: string; to: string }> = [];
  const publishes: Array<{ eventType: string }> = [];

  const repo: WorkItemRepository = {
    create: () => { throw new Error("not exercised"); },
    findById: () => { throw new Error("not exercised"); },
    findByStatus: async (status: string) => items.filter((i) => i.status === status),
    save: async (item, previousStatus) => {
      saves.push({ id: item.id, from: previousStatus, to: item.status });
    },
    incrementDispatchCount: () => { throw new Error("not exercised"); },
    listAll: () => { throw new Error("not exercised"); },
    addDependency: () => { throw new Error("not exercised"); },
    getDependencies: () => { throw new Error("not exercised"); },
    findChildren: () => { throw new Error("not exercised"); },
    findDuplicate: () => { throw new Error("not exercised"); },
    listAllDependencies: () => { throw new Error("not exercised"); },
    withTransaction: () => { throw new Error("not exercised"); },
  };

  const deps: ShutdownReconcilerDeps = {
    workItemRepo: repo,
    eventStore: {
      publish: async (event) => {
        publishes.push({ eventType: (event as { eventType: string }).eventType });
      },
    },
  };

  return { deps, saves, publishes };
}

describe("terminalizeOnRunEnd", () => {
  test("terminalizes Pending and InProgress items from this run to Abandoned", async () => {
    const pending = seedItem("Pending");
    const inProgress = seedItem("InProgress");
    const { deps, saves } = buildDeps([pending, inProgress]);

    const summary = await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(summary.terminalized).toBe(2);
    expect(summary.errored).toBe(0);
    expect(saves).toHaveLength(2);
    for (const save of saves) {
      expect(save.to).toBe("Abandoned");
    }
    expect(saves.map((s) => s.from).sort()).toEqual(["InProgress", "Pending"]);
  });

  test("does NOT terminalize Blocked items — they are owner-parked", async () => {
    const blocked = seedItem("Blocked");
    const { deps, saves } = buildDeps([blocked]);

    const summary = await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(summary.terminalized).toBe(0);
    expect(summary.skippedBlocked).toBe(1);
    expect(saves).toHaveLength(0);
    expect(blocked.status).toBe("Blocked");
  });

  test("does NOT terminalize Failed items — startup reconciler routes them", async () => {
    const failed = seedItem("Failed");
    const { deps, saves } = buildDeps([failed]);

    const summary = await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(summary.terminalized).toBe(0);
    expect(summary.skippedFailed).toBe(1);
    expect(saves).toHaveLength(0);
    expect(failed.status).toBe("Failed");
  });

  test("mixed board: sweeps this run's Pending/InProgress, skips Blocked/Failed", async () => {
    const pending = seedItem("Pending");
    const inProgress = seedItem("InProgress");
    const blocked = seedItem("Blocked");
    const failed = seedItem("Failed");
    const { deps, saves } = buildDeps([pending, inProgress, blocked, failed]);

    const summary = await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(summary.terminalized).toBe(2);
    expect(summary.skippedBlocked).toBe(1);
    expect(summary.skippedFailed).toBe(1);
    expect(saves.map((s) => s.from).sort()).toEqual(["InProgress", "Pending"]);
    expect(blocked.status).toBe("Blocked");
    expect(failed.status).toBe("Failed");
  });

  test("emits a work_item.abandoned event for each terminalized item", async () => {
    const { deps, publishes } = buildDeps([seedItem("Pending"), seedItem("InProgress")]);

    await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(publishes).toHaveLength(2);
    for (const p of publishes) {
      expect(p.eventType).toBe("work_item.abandoned");
    }
  });

  test("returns zero terminalized when no sweepable items exist", async () => {
    const { deps, saves } = buildDeps([]);

    const summary = await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(summary.terminalized).toBe(0);
    expect(summary.errored).toBe(0);
    expect(summary.skippedBlocked).toBe(0);
    expect(summary.skippedFailed).toBe(0);
    expect(summary.skippedAdHoc).toBe(0);
    expect(summary.skippedPreScoping).toBe(0);
    expect(summary.skippedOtherRun).toBe(0);
    expect(saves).toHaveLength(0);
  });

  test("a single item's save failure does not prevent the rest from being terminalized", async () => {
    const good = seedItem("Pending");
    const bad = seedItem("InProgress");
    const alsoGood = seedItem("Pending");
    let saveCount = 0;
    const { deps } = buildDeps([good, bad, alsoGood]);
    const origSave = deps.workItemRepo.save;
    deps.workItemRepo.save = async (item, prev) => {
      saveCount += 1;
      if (saveCount === 2) throw new Error("db blip");
      return origSave.call(deps.workItemRepo, item, prev);
    };

    const summary = await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(summary.terminalized).toBe(2);
    expect(summary.errored).toBe(1);
  });

  test("the abandon reason records the source and previous status", async () => {
    const item = seedItem("InProgress");
    const { deps } = buildDeps([item]);

    await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(item.blockedReason).toEqual({
      reason: "run terminated",
      source: "shutdown-reconciler",
      previousStatus: "InProgress",
    });
  });

  // --- Run-scope tests ---

  test("does NOT sweep ad-hoc items — they were created outside any run", async () => {
    const thisRunPending = seedItem("Pending", THIS_RUN);
    const adHocPending = seedItem("Pending", RUN_SCOPE_AD_HOC);
    const adHocInProgress = seedItem("InProgress", RUN_SCOPE_AD_HOC);
    const { deps, saves } = buildDeps([thisRunPending, adHocPending, adHocInProgress]);

    const summary = await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(summary.terminalized).toBe(1);
    expect(summary.skippedAdHoc).toBe(2);
    expect(saves).toHaveLength(1);
    expect(saves[0].id).toBe(thisRunPending.id);
    expect(adHocPending.status).toBe("Pending");
    expect(adHocInProgress.status).toBe("InProgress");
  });

  test("does NOT sweep pre-scoping items — their provenance is unknown", async () => {
    const thisRunPending = seedItem("Pending", THIS_RUN);
    const preScopingPending = seedItem("Pending", RUN_SCOPE_PRE_SCOPING);
    const { deps, saves } = buildDeps([thisRunPending, preScopingPending]);

    const summary = await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(summary.terminalized).toBe(1);
    expect(summary.skippedPreScoping).toBe(1);
    expect(saves).toHaveLength(1);
    expect(saves[0].id).toBe(thisRunPending.id);
    expect(preScopingPending.status).toBe("Pending");
  });

  test("does NOT sweep items belonging to a different run", async () => {
    const thisRunPending = seedItem("Pending", THIS_RUN);
    const otherRunPending = seedItem("Pending", OTHER_RUN);
    const otherRunInProgress = seedItem("InProgress", OTHER_RUN);
    const { deps, saves } = buildDeps([thisRunPending, otherRunPending, otherRunInProgress]);

    const summary = await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(summary.terminalized).toBe(1);
    expect(summary.skippedOtherRun).toBe(2);
    expect(saves).toHaveLength(1);
    expect(saves[0].id).toBe(thisRunPending.id);
    expect(otherRunPending.status).toBe("Pending");
    expect(otherRunInProgress.status).toBe("InProgress");
  });

  test("mixed scopes: sweeps only this run, counts each excluded scope separately", async () => {
    const thisRun1 = seedItem("Pending", THIS_RUN);
    const thisRun2 = seedItem("InProgress", THIS_RUN);
    const adHoc = seedItem("Pending", RUN_SCOPE_AD_HOC);
    const preScoping = seedItem("InProgress", RUN_SCOPE_PRE_SCOPING);
    const otherRun = seedItem("Pending", OTHER_RUN);
    const blocked = seedItem("Blocked", THIS_RUN);
    const failed = seedItem("Failed", THIS_RUN);
    const { deps, saves } = buildDeps([thisRun1, thisRun2, adHoc, preScoping, otherRun, blocked, failed]);

    const summary = await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(summary.terminalized).toBe(2);
    expect(summary.errored).toBe(0);
    expect(summary.skippedBlocked).toBe(1);
    expect(summary.skippedFailed).toBe(1);
    expect(summary.skippedAdHoc).toBe(1);
    expect(summary.skippedPreScoping).toBe(1);
    expect(summary.skippedOtherRun).toBe(1);
    expect(saves).toHaveLength(2);
    const savedIds = new Set(saves.map((s) => s.id));
    expect(savedIds.has(thisRun1.id)).toBe(true);
    expect(savedIds.has(thisRun2.id)).toBe(true);
  });

  test("zero items from this run + items from other scopes → terminalized 0, scope counts reported", async () => {
    const adHoc = seedItem("Pending", RUN_SCOPE_AD_HOC);
    const otherRun = seedItem("InProgress", OTHER_RUN);
    const { deps, saves } = buildDeps([adHoc, otherRun]);

    const summary = await terminalizeOnRunEnd(deps, THIS_RUN);

    expect(summary.terminalized).toBe(0);
    expect(summary.skippedAdHoc).toBe(1);
    expect(summary.skippedOtherRun).toBe(1);
    expect(saves).toHaveLength(0);
    expect(adHoc.status).toBe("Pending");
    expect(otherRun.status).toBe("InProgress");
  });
});
