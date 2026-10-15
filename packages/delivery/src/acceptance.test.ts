import { describe, expect, test, vi } from "vitest";
import type { ProjectId } from "@ashara/shared";
import { parseProjectId } from "@ashara/shared";
import type { ProjectBlockCause } from "./project-halt.js";
import { runAcceptanceSweeps } from "./acceptance.js";
import type { AcceptanceDeps, AcceptanceStore } from "./acceptance.js";
import type { WorkItem, WorkItemRepository } from "./domain/index.js";

const projectId = parseProjectId("00000000-0000-4000-8000-0000000000a1", "test");
const MAIN = "f".repeat(40);

type Sweep = Awaited<ReturnType<AcceptanceDeps["acceptanceSweeper"]["sweepForAcceptance"]>>;

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

/** A planning repository that keeps the defect's writes: its insert, then its saves. */
function defectRepo(writes: Array<{ op: string; status: string; source?: string }>): WorkItemRepository {
  return {
    create: async (item: WorkItem) => {
      writes.push({ op: "create", status: item.status });
      return item;
    },
    save: async (item: WorkItem) => {
      writes.push({ op: "save", status: item.status, source: item.blockedReason?.source });
    },
    findById: notExercised("findById"),
    listByProject: notExercised("listByProject"),
    findByProjectAndStatus: notExercised("findByProjectAndStatus"),
    projectIdsWithStatus: notExercised("projectIdsWithStatus"),
    listIdsByStatus: notExercised("listIdsByStatus"),
    incrementDispatchCount: notExercised("incrementDispatchCount"),
    recordInfrastructureFault: notExercised("recordInfrastructureFault"),
    refundDispatchCount: notExercised("refundDispatchCount"),
    recordMergeCommit: notExercised("recordMergeCommit"),
    addDependency: notExercised("addDependency"),
    getDependencies: notExercised("getDependencies"),
    findChildren: notExercised("findChildren"),
    listDependenciesByProject: notExercised("listDependenciesByProject"),
    withTransaction: notExercised("withTransaction"),
  };
}

/**
 * A store and project over one ready project: a block takes it out of readiness (as the projects
 * row's status does), and every sweep fault is counted on it.
 */
function harness(sweep: Sweep) {
  const accepted: string[] = [];
  const defects: Array<{ details: string; writes: Array<{ op: string; status: string; source?: string }> }> = [];
  const blocks: Array<{ projectId: ProjectId; cause: ProjectBlockCause }> = [];
  let faults = 0;
  let blocked = false;
  const acceptance: AcceptanceStore = {
    readyForAcceptance: async () => (blocked ? [] : [{ projectId, workspacePath: "/tmp/ashara-acceptance-test", goalTaskIds: ["g1", "g2"] }]),
    recordAccepted: async (record) => {
      accepted.push(record.mainCommit);
      return "accepted";
    },
    recordSweepFault: async () => ++faults,
    recordDefect: async (record, writeDefect) => {
      const writes: Array<{ op: string; status: string; source?: string }> = [];
      await writeDefect(defectRepo(writes));
      defects.push({ details: record.details, writes });
      return "recorded";
    },
  };
  const sweeps: Array<readonly string[]> = [];
  const deps: AcceptanceDeps = {
    acceptance,
    acceptanceSweeper: {
      sweepForAcceptance: async (_id, _path, goals) => {
        sweeps.push(goals);
        return sweep;
      },
    },
    projectRepo: {
      block: async (id, cause) => {
        blocks.push({ projectId: id, cause });
        blocked = true;
        return "blocked";
      },
    },
    eventStore: { publish: async () => {} },
  };
  /** What resumes the project: the substrate probe, for an infrastructure halt, every cycle; nothing else. */
  const resume = (): void => {
    if (blocks.at(-1)?.cause.category === "infrastructure") blocked = false;
  };
  return { deps, accepted, defects, blocks, sweeps, resume, faults: () => faults };
}

/** An EnvironmentError as the substrate throws it (structurally: execution-infra is not this package's to import). */
function substrateUnavailable(): Extract<Sweep, { readonly kind: "unrunnable" }>["error"] {
  return Object.assign(new Error(`Container substrate "podman" is unavailable: cannot connect to the socket`), {
    name: "SubstrateUnavailable",
    binary: "podman",
    detail: "cannot connect to the socket",
  });
}

/** A fault of Z0's own sweep machinery, not the substrate's. */
function sweepFault(): Extract<Sweep, { readonly kind: "faulted" }>["error"] {
  return Object.assign(new Error(`the acceptance sweep of project ${projectId} could not run: read main failed: fatal: bad object HEAD`), {
    name: "AcceptanceSweepFault",
    projectId,
    step: "read main",
  });
}

// Story s-independent-verify-m1 W7 (design P11): Delivering -> Accepted only on a passing sweep.
describe("the acceptance sweep", () => {
  test("a sweep that passes on main makes the project accepted, nothing else", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps, accepted, defects, blocks, sweeps } = harness({
      kind: "ran",
      passed: true,
      mainCommit: MAIN,
      environmentVersion: "v1",
      checkedTasks: ["g1", "g2"],
      uncheckedTasks: [],
      details: "all passed",
    });
    expect(await runAcceptanceSweeps(deps)).toBe(1);
    expect(sweeps).toEqual([["g1", "g2"]]);
    expect(accepted).toEqual([MAIN]);
    expect(defects).toEqual([]);
    expect(blocks).toEqual([]);
  });

  test("a sweep that fails is a defect given up for a repair, never acceptance", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const details = `1 failure(s) on main:\n- task g2's checks: check "delete" exited 1`;
    const { deps, accepted, defects, blocks } = harness({
      kind: "ran",
      passed: false,
      mainCommit: MAIN,
      environmentVersion: "v1",
      checkedTasks: ["g1", "g2"],
      uncheckedTasks: [],
      details,
    });
    expect(await runAcceptanceSweeps(deps)).toBe(0);
    expect(accepted).toEqual([]);
    expect(blocks).toEqual([]);
    // Written Pending, then given up: the abandonment is the update migration 048's repair trigger reads.
    expect(defects).toEqual([
      {
        details,
        writes: [
          { op: "create", status: "Pending" },
          { op: "save", status: "Abandoned", source: "acceptance_failed" },
        ],
      },
    ]);
  });

  test("a sweep the substrate could not run halts the project on infrastructure with the observed error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, accepted, defects, blocks } = harness({ kind: "unrunnable", error: substrateUnavailable() });
    await runAcceptanceSweeps(deps);
    expect(accepted).toEqual([]);
    expect(defects).toEqual([]);
    expect(blocks).toEqual([{ projectId, cause: expect.objectContaining({ category: "infrastructure", errorClass: "SubstrateUnavailable" }) }]);
    expect(blocks[0].cause.reason).toContain("cannot connect to the socket");
  });

  test("a sweep fault that is not the substrate's is a defect given up with the recorded fault, never an infrastructure halt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, defects, blocks } = harness({ kind: "faulted", mainCommit: null, error: sweepFault() });
    await runAcceptanceSweeps(deps);
    expect(blocks).toEqual([]);
    expect(defects).toHaveLength(1);
    expect(defects[0].details).toContain("sweep fault 1 of 3");
    expect(defects[0].details).toContain("read main failed: fatal: bad object HEAD");
    expect(defects[0].writes.at(-1)).toEqual({ op: "save", status: "Abandoned", source: "acceptance_failed" });
  });

  // The verifier's liveness finding: a repeatable sweep failure must reach a terminal state, not loop
  // through halt and resumption. Each round the project is ready again (repaired, or resumed).
  test.each([
    ["a fault that is not the substrate's", { kind: "faulted", mainCommit: MAIN, error: sweepFault() }],
    ["a substrate failure", { kind: "unrunnable", error: substrateUnavailable() }],
  ] as const)("a sweep that keeps failing for %s halts the project as undeliverable past the budget, with the recorded cause", async (_label, sweep: Extract<Sweep, { readonly kind: "faulted" | "unrunnable" }>) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, blocks, sweeps, resume, faults } = harness(sweep);
    for (let round = 0; round < 10; round++) {
      await runAcceptanceSweeps(deps);
      resume();
    }
    // Terminal: the budget's three faults, then the fourth halts the project as a fault no probe resumes.
    expect(sweeps).toHaveLength(4);
    expect(faults()).toBe(4);
    const last = blocks.at(-1);
    expect(last?.cause.category).toBe("fault");
    expect(last?.cause.errorClass).toBe("AcceptanceFaultBudgetSpent");
    expect(last?.cause.reason).toContain("could not run 4 time(s), past the budget of 3");
    expect(last?.cause.reason).toContain(sweep.error.message);
    // Only a substrate failure is ever an infrastructure halt.
    const infrastructure = blocks.filter((block) => block.cause.category === "infrastructure");
    expect(infrastructure).toHaveLength(sweep.kind === "unrunnable" ? 3 : 0);
  });
});
