import fs from "node:fs";
import path from "node:path";
import type { Reporter, TestModule, Vitest } from "vitest/node";

// A vitest reporter that appends each test file to the file PROGRESS_ENV names as the file ends,
// one root-relative path per line, so a run its bound cuts off can name the files it did not finish.
// Written as each file ends, not at the run's end, which a run stopped by a signal never reaches.
// When DURATIONS_ENV names a file too, each file's wall time on this host is appended to it as one
// JSON line, the measurement a host's budget profile is derived from (test-run-profile.ts).

/** The variable naming the file the finished test files are appended to. */
export const PROGRESS_ENV = "ASHARA_TEST_RUN_PROGRESS";

/** The variable naming the file each finished test file's wall time is appended to, when a run records them. */
export const DURATIONS_ENV = "ASHARA_TEST_RUN_DURATIONS";

class TestRunProgressError extends Error {
  constructor(readonly reason: string) {
    super(`test-run-progress: ${reason}`);
    this.name = "TestRunProgressError";
  }
}

class TestRunProgress implements Reporter {
  private readonly target: string;
  private readonly durations: string | null;
  private root = process.cwd();

  constructor() {
    const target = process.env[PROGRESS_ENV];
    if (target === undefined || target === "") throw new TestRunProgressError(`${PROGRESS_ENV} names no file; this reporter runs under scripts/test-run.ts`);
    this.target = target;
    const durations = process.env[DURATIONS_ENV];
    // Recording wall times is the caller's choice: a run that names no file records none.
    this.durations = durations === undefined || durations === "" ? null : durations;
  }

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
  }

  onTestModuleEnd(testModule: TestModule): void {
    const file = path.relative(this.root, testModule.moduleId).split(path.sep).join("/");
    fs.appendFileSync(this.target, `${file}\n`);
    if (this.durations === null) return;
    const spent = testModule.diagnostic();
    const wallMs = spent.environmentSetupDuration + spent.prepareDuration + spent.collectDuration + spent.setupDuration + spent.duration;
    fs.appendFileSync(this.durations, `${JSON.stringify({ path: file, project: testModule.project.name, wallMs: Math.round(wallMs) })}\n`);
  }
}

/** @testseam scripts/test-run.ts names this file as a vitest reporter, a reference knip does not read */
export default TestRunProgress;
