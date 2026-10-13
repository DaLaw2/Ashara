import { describe, expect, test } from "vitest";
import type { CheckRun } from "@ashara/workplace";
import { redRunProblem } from "./task-checks.js";

const run = (exitCode: number | null, timedOut: boolean): CheckRun => ({ name: "c", command: "make check", exitCode, timedOut, output: "x" });

// The 30fb60d5 review (b): a check that timed out on main was kept as "fails on main".
describe("the red-run rule", () => {
  test("a check fails on main only by a non-zero exit within its time limit", () => {
    expect(redRunProblem(run(1, false))).toBeNull();
    expect(redRunProblem(run(0, false))).toContain("already passes on main");
    expect(redRunProblem(run(127, false))).toContain("cannot be run");
  });

  test.each([
    [137, true],
    [null, true],
    [1, true],
  ] as const)("exit %s with a timeout is rejected: a timeout proves nothing", (exitCode, timedOut) => {
    expect(redRunProblem(run(exitCode, timedOut))).toContain("timed out on main");
  });
});
