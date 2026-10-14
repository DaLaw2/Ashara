import { describe, expect, test } from "vitest";
import { checkPassed, checkVerdict } from "./check-run.js";
import type { CheckRun } from "./check-run.js";

// c-independent-verify C2: missing evidence is failure. Only exit 0, within its time, with output, passes.
describe("checkPassed", () => {
  const run = (overrides: Partial<CheckRun>): CheckRun => ({ name: "c", command: "sh c.sh", exitCode: 0, timedOut: false, output: "ok", ...overrides });

  test.each([
    { case: "exit 0 with output", overrides: {}, passed: true, verdict: "PASSED" },
    { case: "exit 0 with no output", overrides: { output: "" }, passed: false, verdict: "FAILED: printed nothing" },
    { case: "exit 0 with only whitespace", overrides: { output: " \n\t" }, passed: false, verdict: "FAILED: printed nothing" },
    { case: "a non-zero exit", overrides: { exitCode: 1 }, passed: false, verdict: "FAILED: exited 1" },
    { case: "timed out after exit 0", overrides: { timedOut: true }, passed: false, verdict: "FAILED: timed out" },
    { case: "its exit status lost", overrides: { exitCode: null }, passed: false, verdict: "FAILED: ended with its exit status unknown" },
  ])("$case: $verdict", ({ overrides, passed, verdict }) => {
    expect(checkPassed(run(overrides))).toBe(passed);
    expect(checkVerdict(run(overrides))).toBe(verdict);
  });
});
