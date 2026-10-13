/** The end of a log, and whether anything before it was cut. */
export interface LogTail {
  readonly text: string;
  readonly truncated: boolean;
}

/** One of the environment's commands (`build` or `test`), run in a cell from the built image. */
export interface EnvironmentTestRun {
  readonly command: string;
  /** null when the host had to kill the podman client; timedOut is then true. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: LogTail;
  readonly stderr: LogTail;
}

/**
 * The definition's `build` then `test`, run in one cell from the built image on a fresh checkout of
 * the committed work, and what that checkout held afterwards that the commit does not.
 */
export type EnvironmentCommandsRun =
  /** `build` failed: neither `test` nor the cleanliness check ran. */
  | { readonly kind: "build_failed"; readonly build: EnvironmentTestRun }
  | {
      readonly kind: "ran";
      readonly build: EnvironmentTestRun;
      readonly test: EnvironmentTestRun;
      /** The checkout's untracked or modified paths after both (`git status --porcelain`); empty when clean. */
      readonly leftOver: readonly string[];
    };

/**
 * What a check of the environment definition found. A definition, scope, build or test that fails
 * is a report, never a throw: it is the environment role's work, which the model can fix. A
 * substrate that cannot run the check throws instead.
 */
export type EnvironmentCheckReport =
  /** The definition is absent, unreadable or invalid, or its owned files cannot be versioned. */
  | { readonly kind: "definition_refused"; readonly detail: string }
  /** The work adds, changes or deletes paths outside the definition's owned set. */
  | { readonly kind: "out_of_scope"; readonly owned: readonly string[]; readonly paths: readonly string[] }
  | { readonly kind: "build_failed"; readonly version: string; readonly detail: string; readonly log: LogTail }
  | {
      readonly kind: "tested";
      readonly version: string;
      readonly imageRef: string;
      readonly build: { readonly kind: "reused" } | { readonly kind: "built"; readonly log: LogTail };
      readonly commands: EnvironmentCommandsRun;
    };

/**
 * Z0's side of build_environment, supplied by the execution service for an environment task only:
 * it reads the definition from the worktree, builds the image from the worktree's committed tree and
 * runs `build` and `test` on a fresh checkout of it. The tool itself runs nothing on the host.
 */
export interface EnvironmentCheckPort {
  check(testTimeoutSeconds: number): Promise<EnvironmentCheckReport>;
}

/** `build` passed: it exited 0 within its time (a build may print nothing). */
export function environmentBuildPassed(build: EnvironmentTestRun): boolean {
  return build.exitCode === 0 && !build.timedOut;
}

/** `test` passed: it exited 0 within its time and printed something (an empty pass proves nothing). */
function environmentTestPassed(test: EnvironmentTestRun): boolean {
  return test.exitCode === 0 && !test.timedOut && `${test.stdout.text}${test.stderr.text}`.trim() !== "";
}

/** `build` and `test` passed and left the checkout clean: the gate's verdict, and the post-merge check's. */
export function environmentCommandsPassed(commands: EnvironmentCommandsRun): boolean {
  return (
    commands.kind === "ran" &&
    environmentBuildPassed(commands.build) &&
    environmentTestPassed(commands.test) &&
    commands.leftOver.length === 0
  );
}

/** The substrate's verdict on a definition: it builds, `build` and `test` pass, and they leave the checkout clean. */
export function environmentCheckPassed(report: EnvironmentCheckReport): boolean {
  return report.kind === "tested" && environmentCommandsPassed(report.commands);
}

function logSection(title: string, log: LogTail): string {
  const body = log.text === "" ? "(empty)" : log.text;
  return log.truncated ? `${title} (truncated: only its end is shown):\n${body}` : `${title}:\n${body}`;
}

function commandSection(label: "Build" | "Test", run: EnvironmentTestRun, verdict: string): string {
  return [
    `${label} command: ${run.command}`,
    `${label} exit code: ${run.exitCode ?? "none (killed)"}${run.timedOut ? " (timed out)" : ""}`,
    logSection(`${label} stdout`, run.stdout),
    logSection(`${label} stderr`, run.stderr),
    `${label} verdict: ${verdict}`,
  ].join("\n");
}

function buildVerdict(build: EnvironmentTestRun): string {
  if (environmentBuildPassed(build)) return "PASSED";
  return build.timedOut ? "FAILED: the build command timed out" : `FAILED: the build command exited ${build.exitCode}`;
}

function testVerdict(test: EnvironmentTestRun): string {
  if (environmentTestPassed(test)) return "PASSED";
  if (test.timedOut) return "FAILED: the test command timed out";
  return test.exitCode !== 0 ? `FAILED: the test command exited ${test.exitCode}` : "FAILED: the test command printed nothing";
}

function formatCommands(commands: EnvironmentCommandsRun): string[] {
  const build = commandSection("Build", commands.build, buildVerdict(commands.build));
  if (commands.kind === "build_failed") return [build, "Test command: not run, because the build command failed.", "Verdict: FAILED"];
  const checkout =
    commands.leftOver.length === 0
      ? "Checkout after build and test: clean."
      : [
          `Checkout after build and test: NOT clean. Build or test left these paths untracked or modified; every file`,
          `they write must be ignored by a committed .gitignore (an owned file):`,
          ...commands.leftOver.map((path) => `- ${path}`),
        ].join("\n");
  return [build, commandSection("Test", commands.test, testVerdict(commands.test)), checkout, `Verdict: ${environmentCommandsPassed(commands) ? "PASSED" : "FAILED"}`];
}

/** The report as the model and the gate's failure record read it. */
export function formatEnvironmentCheck(report: EnvironmentCheckReport): string {
  switch (report.kind) {
    case "definition_refused":
      return `Environment definition refused: ${report.detail}`;
    case "out_of_scope":
      return [
        `Environment work refused: it touches paths outside the owned paths [${report.owned.join(", ")}]. Environment`,
        `work adds, changes or deletes owned paths only; product code and its tests are later tasks' work.`,
        `Out-of-scope paths:`,
        ...report.paths.map((path) => `- ${path}`),
      ].join("\n");
    case "build_failed":
      return [`Environment version ${report.version}: the image did not build: ${report.detail}`, logSection("Image build log", report.log)].join("\n");
    case "tested":
      return [
        `Environment version ${report.version}, image ${report.imageRef}.`,
        report.build.kind === "reused" ? "Image: this version was already built; its image was reused." : logSection("Image build log", report.build.log),
        ...formatCommands(report.commands),
      ].join("\n");
  }
}

/** One run of the environment's `build` then `test`, with its verdict, as the post-merge record reads it. */
export function formatEnvironmentCommands(commands: EnvironmentCommandsRun): string {
  return formatCommands(commands).join("\n");
}
