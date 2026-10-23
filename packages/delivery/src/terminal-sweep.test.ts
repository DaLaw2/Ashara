import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import { INFRASTRUCTURE_FAULT_BUDGET } from "./execution/halt-causes.js";
import { runTerminalSweeps } from "./terminal-sweep.js";
import type { TerminalSweepStore } from "./terminal-sweep.js";

const projectId = parseProjectId("00000000-0000-4000-8000-0000000000b1", "test");
const MAIN = "e".repeat(40);

type TerminalDeps = Parameters<typeof runTerminalSweeps>[0];
type Sweep = Awaited<ReturnType<TerminalDeps["terminalSweeper"]["sweepForTerminal"]>>;
type Recorded = Parameters<TerminalSweepStore["recordTerminalSweep"]>[0];

/** A fault of the sweep's own machinery after it read main, not the substrate's. */
function sweepFault(): Extract<Sweep, { readonly kind: "faulted" }>["error"] {
  return Object.assign(new Error(`the acceptance sweep of project ${projectId} could not run: run checks failed: spawn EMFILE`), {
    name: "AcceptanceSweepFault",
    projectId,
    step: "run checks",
  });
}

/** The store's fault when the guarantees in force do not read, so no sweep's evidence can be built. */
class GuaranteesUnread extends Error {
  constructor() {
    super("vision v1 of the project does not read");
    this.name = "GuaranteesUnread";
  }
}

/** The shutdown's interruption, which the containment lets escape. */
class Interrupted extends Error {
  constructor() {
    super("the shutdown interrupted the sweep");
    this.name = "Interrupted";
  }
}

/**
 * One halt owed its sweep, its faults counted in memory as the store counts them durably; with
 * `evidenceReads` false, recording a sweep with its evidence throws as a store whose guarantees do
 * not read does, and only a sweep recorded without evidence is recorded.
 */
function halt(evidenceReads = true) {
  const recorded: Recorded[] = [];
  const withoutEvidence: Recorded[] = [];
  let faults = 0;
  const run = (sweep: Sweep | (() => Promise<Sweep>)) =>
    runTerminalSweeps({
      terminalSweeps: {
        dueTerminalSweeps: async () =>
          recorded.length + withoutEvidence.length > 0 ? [] : [{ projectId, workspacePath: "/work/p1", terminal: { kind: "halt", blockId: "b1" } }],
        recordTerminalSweep: async (record) => {
          if (!evidenceReads) throw new GuaranteesUnread();
          recorded.push(record);
          return "recorded";
        },
        recordWithoutEvidence: async (record) => {
          withoutEvidence.push(record);
          return "recorded";
        },
        recordSweepFault: async () => (faults += 1),
      },
      terminalSweeper: { sweepForTerminal: async () => (typeof sweep === "function" ? sweep() : sweep) },
      containment: memoryStepContainment((error) => error instanceof Interrupted),
      logger: recordingLogger(),
    });
  return { run, recorded, withoutEvidence, faults: () => faults };
}

/** Runs the halt's sweep step with `sweep` until it records something, at most `cycles` times; the record. */
async function recordOf(sweep: Sweep, cycles = INFRASTRUCTURE_FAULT_BUDGET + 1): Promise<Recorded> {
  const { run, recorded } = halt();
  for (let cycle = 0; cycle < cycles && recorded.length === 0; cycle += 1) await run(sweep);
  const [record] = recorded;
  if (record === undefined || recorded.length !== 1) throw new Error(`expected one terminal sweep recorded, got ${recorded.length}`);
  return record;
}

// A sweep with no commit on record is what the guarantee table reads as no sweep on a commit
// (no-sweep-on-commit); one with a commit and no check run reads as no executed evidence there.
describe("the terminal sweep", () => {
  test("a sweep that could not run is retried within the budget, recording nothing, so its report waits", async () => {
    const { run, recorded } = halt();
    for (let cycle = 0; cycle < INFRASTRUCTURE_FAULT_BUDGET; cycle += 1) expect(await run({ kind: "faulted", mainCommit: MAIN, error: sweepFault() })).toBe(0);
    expect(recorded).toEqual([]);
  });

  test("a sweep that faulted after reading main, past the budget, is recorded with no commit, naming the commit it read and the fault", async () => {
    const record = await recordOf({ kind: "faulted", mainCommit: MAIN, error: sweepFault() });
    expect(record.mainCommit).toBeNull();
    expect(record.checkOutcomes).toEqual([]);
    expect(record.details).toContain(`could not run in ${INFRASTRUCTURE_FAULT_BUDGET + 1} attempts`);
    expect(record.details).toContain(`on main at commit ${MAIN}`);
    expect(record.details).toContain("spawn EMFILE");
  });

  test("a sweep whose recording keeps throwing is counted as a fault, and past the budget is recorded without evidence, naming the fault", async () => {
    const { run, recorded, withoutEvidence, faults } = halt(false);
    const ran: Sweep = { kind: "ran", passed: true, mainCommit: MAIN, environmentVersion: "v1", checkedTasks: [], uncheckedTasks: [], publicInterface: { kind: "not-placeholder" }, placeholder: { kind: "not-searched" }, checkOutcomes: [], failedChecks: [], details: "ran" };
    for (let cycle = 1; cycle <= INFRASTRUCTURE_FAULT_BUDGET; cycle += 1) {
      expect(await run(ran)).toBe(0);
      expect(faults()).toBe(cycle);
      expect(withoutEvidence).toEqual([]);
    }
    expect(await run(ran)).toBe(1);
    expect(recorded).toEqual([]);
    const [record, ...more] = withoutEvidence;
    expect(more).toEqual([]);
    expect(record?.mainCommit).toBeNull();
    expect(record?.details).toContain(`could not run in ${INFRASTRUCTURE_FAULT_BUDGET + 1} attempts`);
    expect(record?.details).toContain("vision v1 of the project does not read");
  });

  test("a sweep the shutdown interrupts escapes uncounted", async () => {
    const { run, faults } = halt();
    await expect(run(async () => Promise.reject(new Interrupted()))).rejects.toThrow(Interrupted);
    expect(faults()).toBe(0);
  });

  test("a sweep that faulted before reading main is recorded past the budget with no commit, and says so without naming one", async () => {
    const record = await recordOf({ kind: "faulted", mainCommit: null, error: sweepFault() });
    expect(record.mainCommit).toBeNull();
    expect(record.details).toMatch(/^No terminal sweep ran: /);
    expect(record.details).not.toContain("on main at commit");
  });
});
