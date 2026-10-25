import fs from "node:fs";
import path from "node:path";
import type { Reporter, TestModule, Vitest } from "vitest/node";

// A vitest reporter that appends each test file to the file PROGRESS_ENV names as the file ends,
// one root-relative path per line, so a run its bound cuts off can name the files it did not finish.
// Written as each file ends, not at the run's end, which a run stopped by a signal never reaches.

/** The variable naming the file the finished test files are appended to. */
export const PROGRESS_ENV = "ASHARA_TEST_RUN_PROGRESS";

class TestRunProgressError extends Error {
  constructor(readonly reason: string) {
    super(`test-run-progress: ${reason}`);
    this.name = "TestRunProgressError";
  }
}

class TestRunProgress implements Reporter {
  private readonly target: string;
  private root = process.cwd();

  constructor() {
    const target = process.env[PROGRESS_ENV];
    if (target === undefined || target === "") throw new TestRunProgressError(`${PROGRESS_ENV} names no file; this reporter runs under scripts/test-run.ts`);
    this.target = target;
  }

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
  }

  onTestModuleEnd(testModule: TestModule): void {
    fs.appendFileSync(this.target, `${path.relative(this.root, testModule.moduleId).split(path.sep).join("/")}\n`);
  }
}

/** @testseam scripts/test-run.ts names this file as a vitest reporter, a reference knip does not read */
export default TestRunProgress;
