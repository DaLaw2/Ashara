import { describe, expect, test, vi } from "vitest";
import type { ProjectId } from "@ashara/shared";
import { memoryStepContainment, parseProjectId } from "@ashara/shared";
import type { ProjectBlockCause } from "./project-halt.js";
import { runAcceptanceSweeps } from "./acceptance.js";
import type { AcceptanceStore } from "./acceptance.js";
import type { WorkItem, WorkItemRepository } from "./domain/index.js";

const projectId = parseProjectId("00000000-0000-4000-8000-0000000000a1", "test");
const MAIN = "f".repeat(40);
const SCAFFOLD_MERGE = "a".repeat(40);
const SCAFFOLDS = [{ taskId: "s1", mergeCommit: SCAFFOLD_MERGE }];
const EXECUTED = [{ taskId: "g1", name: "put then get", command: "./kv set a 1 && ./kv get a" }];

type AcceptanceDeps = Parameters<typeof runAcceptanceSweeps>[0];

type Sweep = Awaited<ReturnType<AcceptanceDeps["acceptanceSweeper"]["sweepForAcceptance"]>>;

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

/** A planning repository that keeps the defect's writes: its insert, then its saves. */
function defectRepo(writes: Array<{ op: string; status: string; source?: string }>, created: WorkItem[] = []): WorkItemRepository {
  return {
    create: async (item: WorkItem) => {
      writes.push({ op: "create", status: item.status });
      created.push(item);
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
    saveRefundedOverflow: async () => 0,
    recordCrashOrphan: async () => 1,
    saveOrphanExit: async () => {
      throw new Error("saveOrphanExit is not exercised by this test");
    },
    saveRefunded: notExercised("saveRefunded"),
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
function harness(sweep: Sweep, scaffoldMerges: ReadonlyArray<{ readonly taskId: string; readonly mergeCommit: string | null }> = SCAFFOLDS) {
  const accepted: string[] = [];
  const executed: unknown[] = [];
  const defects: Array<{ details: string; writes: Array<{ op: string; status: string; source?: string }> }> = [];
  const created: WorkItem[] = [];
  const blocks: Array<{ projectId: ProjectId; cause: ProjectBlockCause }> = [];
  let faults = 0;
  let blocked = false;
  const acceptance: AcceptanceStore = {
    readyForAcceptance: async () =>
      blocked ? [] : [{ projectId, workspacePath: "/tmp/ashara-acceptance-test", goalTaskIds: ["g1", "g2"], scaffoldMerges }],
    recordAccepted: async (record) => {
      accepted.push(record.mainCommit);
      executed.push(record.executedChecks);
      return "accepted";
    },
    recordSweepFault: async () => ++faults,
    recordDefect: async (record, writeDefect) => {
      const writes: Array<{ op: string; status: string; source?: string }> = [];
      await writeDefect(defectRepo(writes, created));
      defects.push({ details: record.details, writes });
      return "recorded";
    },
  };
  const sweeps: Array<readonly string[]> = [];
  const scaffoldsSwept: unknown[] = [];
  const deps: AcceptanceDeps = {
    acceptance,
    containment: memoryStepContainment(() => true),
    acceptanceSweeper: {
      sweepForAcceptance: async (_id, _path, goals, scaffolds) => {
        sweeps.push(goals);
        scaffoldsSwept.push(scaffolds);
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
  return { deps, accepted, executed, defects, created, blocks, sweeps, scaffoldsSwept, resume, faults: () => faults };
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
    const { deps, accepted, executed, defects, blocks, sweeps, scaffoldsSwept } = harness({
      kind: "ran",
      passed: true,
      mainCommit: MAIN,
      environmentVersion: "v1",
      checkedTasks: ["g1", "g2"],
      uncheckedTasks: [],
      publicInterface: { kind: "not-placeholder" },
      executedChecks: EXECUTED,
      details: "all passed",
    });
    expect(await runAcceptanceSweeps(deps)).toBe(1);
    expect(sweeps).toEqual([["g1", "g2"]]);
    expect(scaffoldsSwept).toEqual([SCAFFOLDS]);
    expect(accepted).toEqual([MAIN]);
    // What the delivered report presents as verified is what the sweep ran: recorded with the acceptance.
    expect(executed).toEqual([EXECUTED]);
    expect(defects).toEqual([]);
    expect(blocks).toEqual([]);
  });

  test("a sweep that fails is a defect given up for a repair, never acceptance", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const details = `1 failure(s) on main:\n- task g2's checks: check "delete" exited 1`;
    const { deps, accepted, defects, created, blocks } = harness({
      kind: "ran",
      passed: false,
      mainCommit: MAIN,
      environmentVersion: "v1",
      checkedTasks: ["g1", "g2"],
      uncheckedTasks: [],
      publicInterface: { kind: "not-placeholder" },
      executedChecks: [],
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
    expect(created[0]?.taskSpec?.goal).toBe("Every goal task's checks and the environment's test pass together on main");
  });

  test("a main whose public interface file is the scaffold's is a defect asking for that file, given up for a repair", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const details = `PUBLIC_INTERFACE.md on main is byte-identical to the one the product scaffold wrote (task s1, merged as ${SCAFFOLD_MERGE})`;
    const { deps, accepted, defects, created } = harness({
      kind: "ran",
      passed: false,
      mainCommit: MAIN,
      environmentVersion: "v1",
      checkedTasks: ["g1", "g2"],
      uncheckedTasks: [],
      publicInterface: { kind: "scaffold-placeholder", file: "PUBLIC_INTERFACE.md", scaffoldTaskId: "s1", scaffoldCommit: SCAFFOLD_MERGE },
      executedChecks: [],
      details,
    });
    expect(await runAcceptanceSweeps(deps)).toBe(0);
    expect(accepted).toEqual([]);
    expect(defects[0]?.writes.at(-1)).toEqual({ op: "save", status: "Abandoned", source: "acceptance_failed" });
    const [defect] = created;
    expect(defect?.title).toBe(`Acceptance on main ${MAIN.slice(0, 12)}: update PUBLIC_INTERFACE.md`);
    expect(defect?.taskSpec?.goal).toContain("Update PUBLIC_INTERFACE.md so it states how the delivered product is started, configured and called");
    expect(defect?.taskSpec?.deliverables).toEqual(["PUBLIC_INTERFACE.md, stating the delivered product's public interface"]);
  });

  test("a main with no public interface file is a defect asking to restore it, given up for a repair", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const details = "PUBLIC_INTERFACE.md is missing from main: no file states the delivered product's public interface.";
    const { deps, accepted, defects, created } = harness({
      kind: "ran",
      passed: false,
      mainCommit: MAIN,
      environmentVersion: "v1",
      checkedTasks: ["g1", "g2"],
      uncheckedTasks: [],
      publicInterface: { kind: "absent", file: "PUBLIC_INTERFACE.md" },
      executedChecks: [],
      details,
    });
    expect(await runAcceptanceSweeps(deps)).toBe(0);
    expect(accepted).toEqual([]);
    expect(defects[0]?.writes.at(-1)).toEqual({ op: "save", status: "Abandoned", source: "acceptance_failed" });
    const [defect] = created;
    expect(defect?.title).toBe(`Acceptance on main ${MAIN.slice(0, 12)}: restore PUBLIC_INTERFACE.md`);
    expect(defect?.taskSpec?.goal).toContain("Restore PUBLIC_INTERFACE.md so it states how the delivered product is started, configured and called");
    expect(defect?.taskSpec?.deliverables).toEqual(["PUBLIC_INTERFACE.md, stating the delivered product's public interface"]);
  });

  test("a Completed scaffold with no recorded merge halts the project once, as a fault the operator ends, and is never swept", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, sweeps, defects, blocks, resume, faults } = harness(
      { kind: "faulted", mainCommit: MAIN, error: sweepFault() },
      [...SCAFFOLDS, { taskId: "s2", mergeCommit: null }],
    );
    for (let round = 0; round < 3; round++) {
      await runAcceptanceSweeps(deps);
      resume();
    }
    expect(sweeps).toEqual([]);
    expect(defects).toEqual([]);
    expect(faults()).toBe(0);
    expect(blocks).toEqual([{ projectId, cause: expect.objectContaining({ category: "fault", errorClass: "ScaffoldMergeUnrecorded" }) }]);
    expect(blocks[0].cause.reason).toContain("s2");
    // What the operator does is said with what exists: the column the merge is recorded in and the unblock command.
    expect(blocks[0].cause.reason).toContain("UPDATE work_items SET merge_commit = '<commit>', merge_kind = 'merged' WHERE id = '<scaffold task id>'");
    expect(blocks[0].cause.reason).toContain(`npx tsx scripts/project.ts unblock ${projectId} --reason`);
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
