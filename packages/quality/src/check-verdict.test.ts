import { describe, expect, test } from "vitest";
import type { CheckRun } from "@ashara/workplace";
import { checkPassed, checkRunVerdict, checkVerdict } from "./check-verdict.js";

// Missing evidence is failure. Only exit 0, within its time, with output, passes.
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

// run_checks shows the implementer each check's verdict; the run passes only when every check ran and passed.
describe("checkRunVerdict", () => {
  test("reports each check's verdict and fails a run with a failing check", () => {
    const verdict = checkRunVerdict({
      kind: "ran",
      runs: [
        { name: "greets", command: "cat greet.txt", exitCode: 0, timedOut: false, output: "hello" },
        { name: "lists", command: "ls missing", exitCode: 2, timedOut: false, output: "No such file" },
      ],
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.report).toContain("1 of 2 check(s) pass");
    expect(verdict.report).toContain('Check "greets": PASSED');
    expect(verdict.report).toContain('Check "lists": FAILED: exited 2');
  });

  test("passes only a run in which at least one check ran and every one passed", () => {
    expect(checkRunVerdict({ kind: "ran", runs: [{ name: "a", command: "true", exitCode: 0, timedOut: false, output: "ok" }] }).passed).toBe(true);
    expect(checkRunVerdict({ kind: "ran", runs: [] }).passed).toBe(false);
    expect(checkRunVerdict({ kind: "files_refused", detail: "no" }).passed).toBe(false);
  });
});
