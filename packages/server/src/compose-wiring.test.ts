import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The composition root builds each of Quality's verification jobs itself; the sweeps of main are
// the core loop's, so neither is ever read off the dispatcher.
const compose = readFileSync(join(import.meta.dirname, "compose.ts"), "utf-8");

describe("compose.ts builds Quality's verification jobs", () => {
  test("the acceptance and terminal sweepers are built here and handed to the core loop", () => {
    expect(compose).toMatch(/const acceptanceSweeper = new AcceptanceSweeper\(/);
    expect(compose).toMatch(/const terminalSweeper = new TerminalSweeper\(/);
    expect(compose).toMatch(/^\s*acceptanceSweeper,$/m);
    expect(compose).toMatch(/^\s*terminalSweeper,$/m);
  });

  test("no sweeper or job is reached through the dispatch service", () => {
    expect(compose).not.toMatch(/dispatchService\.\w/);
    expect(compose).not.toMatch(/(acceptanceSweeper|terminalSweeper):\s*dispatchService/);
  });

  test.each([
    "SuiteReviewRun",
    "CellTeardown",
    "DispatchCells",
    "BaselineRevalidation",
    "DeliveredOnMain",
    "FoundationGate",
    "CheckPorts",
    "CheckHarvest",
    "OwnershipGate",
    "SubstrateGate",
    "PostMergeChecks",
  ])("%s is constructed in the composition root", (job) => {
    expect(compose).toContain(`new ${job}(`);
  });
});
