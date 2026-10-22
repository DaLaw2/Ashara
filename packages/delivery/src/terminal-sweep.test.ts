import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
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

/** Runs the terminal sweep of one halt whose sweeper returns `sweep`; the record it wrote. */
async function recordOf(sweep: Sweep): Promise<Recorded> {
  const recorded: Recorded[] = [];
  await runTerminalSweeps({
    terminalSweeps: {
      dueTerminalSweeps: async () => [{ projectId, workspacePath: "/work/p1", terminal: { kind: "halt", blockId: "b1" } }],
      recordTerminalSweep: async (record) => {
        recorded.push(record);
        return "recorded";
      },
    },
    terminalSweeper: { sweepForTerminal: async () => sweep },
    containment: memoryStepContainment(() => true),
    logger: recordingLogger(),
  });
  const [record] = recorded;
  if (record === undefined || recorded.length !== 1) throw new Error(`expected one terminal sweep recorded, got ${recorded.length}`);
  return record;
}

// A sweep with no commit on record is what the guarantee table reads as no sweep on a commit
// (no-sweep-on-commit); one with a commit and no check run reads as no executed evidence there.
describe("the terminal sweep", () => {
  test("a sweep that faulted after reading main ran no check there: it is recorded with no commit, naming the commit it read in why", async () => {
    const record = await recordOf({ kind: "faulted", mainCommit: MAIN, error: sweepFault() });
    expect(record.mainCommit).toBeNull();
    expect(record.checkOutcomes).toEqual([]);
    expect(record.details).toContain(`No terminal sweep ran on main at commit ${MAIN}`);
    expect(record.details).toContain("spawn EMFILE");
  });

  test("a sweep that faulted before reading main is recorded with no commit, and says so without naming one", async () => {
    const record = await recordOf({ kind: "faulted", mainCommit: null, error: sweepFault() });
    expect(record.mainCommit).toBeNull();
    expect(record.details).toMatch(/^No terminal sweep ran: /);
  });
});
