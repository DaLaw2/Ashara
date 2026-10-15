import { describe, expect, test } from "vitest";
import type { CheckSuite, SuiteRun } from "./task-checks.js";
import { suitesVerdict } from "./verification.js";

// c-independent-verify C2: missing evidence is failure. A stored check that reported no run, or a
// suite with no run at all, never reads as a pass, though every check that did run passed.
describe("suitesVerdict: a check that did not run fails the merge", () => {
  const passing = (name: string) => ({ name, command: `sh ${name}.sh`, exitCode: 0, timedOut: false, output: "ok" });
  const own: CheckSuite = {
    label: "this task's checks",
    checks: [{ name: "a", command: "sh a.sh" }, { name: "b", command: "sh b.sh" }],
    files: [],
  };
  const environment: CheckSuite = { label: "the environment's test", checks: [{ name: "environment test", command: "true" }], files: [] };

  test("every stored check ran and passed: passed", () => {
    const runs: SuiteRun[] = [
      { suite: environment, report: { kind: "ran", runs: [passing("environment test")] } },
      { suite: own, report: { kind: "ran", runs: [passing("a"), passing("b")] } },
    ];
    expect(suitesVerdict([environment, own], runs, 0, "merge").passed).toBe(true);
  });

  test("one of two stored checks skipped: failed, naming the count", () => {
    const runs: SuiteRun[] = [
      { suite: environment, report: { kind: "ran", runs: [passing("environment test")] } },
      { suite: own, report: { kind: "ran", runs: [passing("a")] } },
    ];
    const verdict = suitesVerdict([environment, own], runs, 0, "merge");
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toContain("this task's checks: 1 of 2 checks ran");
  });

  test("a suite with no run reported: failed, naming the suite", () => {
    const runs: SuiteRun[] = [{ suite: environment, report: { kind: "ran", runs: [passing("environment test")] } }];
    const verdict = suitesVerdict([environment, own], runs, 0, "merge");
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toContain("1 of 2 suites reported a run");
    expect(verdict.details).toContain("this task's checks: did not run");
  });

  test("a suite that ran no check at all: failed", () => {
    const empty: CheckSuite = { label: "this task's checks", checks: [], files: [] };
    const verdict = suitesVerdict([empty], [{ suite: empty, report: { kind: "ran", runs: [] } }], 0, "merge");
    expect(verdict.passed).toBe(false);
    expect(verdict.details).toContain("0 of 0 checks ran");
  });
});
