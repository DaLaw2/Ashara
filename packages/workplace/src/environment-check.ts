/** The end of a log, and whether anything before it was cut. */
export interface LogTail {
  readonly text: string;
  readonly truncated: boolean;
}

/** The environment's `test` command, run in a fresh cell from the built image. */
export interface EnvironmentTestRun {
  readonly command: string;
  /** null when the host had to kill the podman client; timedOut is then true. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: LogTail;
  readonly stderr: LogTail;
}

/**
 * What a check of the environment definition found. A definition, build or test that fails is a
 * report, never a throw: it is the environment role's work, which the model can fix. A substrate
 * that cannot run the check throws instead.
 */
export type EnvironmentCheckReport =
  /** The definition is absent, unreadable or invalid, or its owned files cannot be versioned. */
  | { readonly kind: "definition_refused"; readonly detail: string }
  | { readonly kind: "build_failed"; readonly version: string; readonly detail: string; readonly log: LogTail }
  | {
      readonly kind: "tested";
      readonly version: string;
      readonly imageRef: string;
      readonly build: { readonly kind: "reused" } | { readonly kind: "built"; readonly log: LogTail };
      readonly test: EnvironmentTestRun;
    };

/**
 * Z0's side of build_environment, supplied by the execution service for an environment task only:
 * it reads the definition from the worktree, builds the image from the worktree's committed tree and
 * runs `test` in a fresh cell. The tool itself runs nothing on the host.
 */
export interface EnvironmentCheckPort {
  check(testTimeoutSeconds: number): Promise<EnvironmentCheckReport>;
}

/** `test` passed: it exited 0 within its time and printed something (an empty pass proves nothing). */
export function environmentTestPassed(test: EnvironmentTestRun): boolean {
  return test.exitCode === 0 && !test.timedOut && `${test.stdout.text}${test.stderr.text}`.trim() !== "";
}

/** The substrate's verdict on a definition: it builds, and its `test` passes. */
export function environmentCheckPassed(report: EnvironmentCheckReport): boolean {
  return report.kind === "tested" && environmentTestPassed(report.test);
}

function logSection(title: string, log: LogTail): string {
  const body = log.text === "" ? "(empty)" : log.text;
  return log.truncated ? `${title} (truncated: only its end is shown):\n${body}` : `${title}:\n${body}`;
}

/** The report as the model and the gate's failure record read it. */
export function formatEnvironmentCheck(report: EnvironmentCheckReport): string {
  switch (report.kind) {
    case "definition_refused":
      return `Environment definition refused: ${report.detail}`;
    case "build_failed":
      return [`Environment version ${report.version}: the image did not build: ${report.detail}`, logSection("Build log", report.log)].join("\n");
    case "tested":
      return [
        `Environment version ${report.version}, image ${report.imageRef}.`,
        report.build.kind === "reused" ? "Build: this version was already built; its image was reused." : logSection("Build log", report.build.log),
        formatEnvironmentTest(report.test),
      ].join("\n");
  }
}

/** One run of the environment's `test`, with its verdict. */
export function formatEnvironmentTest(test: EnvironmentTestRun): string {
  const verdict = environmentTestPassed(test)
    ? "PASSED"
    : test.timedOut
      ? "FAILED: the test command timed out"
      : test.exitCode !== 0
        ? `FAILED: the test command exited ${test.exitCode}`
        : "FAILED: the test command printed nothing";
  return [
    `Test command: ${test.command}`,
    `Test exit code: ${test.exitCode ?? "none (killed)"}${test.timedOut ? " (timed out)" : ""}`,
    logSection("Test stdout", test.stdout),
    logSection("Test stderr", test.stderr),
    `Verdict: ${verdict}`,
  ].join("\n");
}
