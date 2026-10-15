import type { EnvironmentCheckReport, EnvironmentTestRun } from "@ashara/execution-infra";
import { renderElided, shownText } from "@ashara/shared";
import type { ElidedText } from "@ashara/shared";

/**
 * The product's `build` then `test` (ADR-074 addendum 2 d72), run in one cell from the built image on a
 * fresh checkout of a merge, and what that checkout held afterwards that the commit does not. Never
 * run on a tree with no product: the scaffold's gate and every merge after it run them.
 */
export type EnvironmentCommandsRun =
  /** `build` failed: neither `test` nor the cleanliness check ran. */
  | { readonly kind: "build_failed"; readonly build: EnvironmentTestRun }
  | {
      readonly kind: "ran";
      readonly build: EnvironmentTestRun;
      readonly test: EnvironmentTestRun;
      /** The checkout's untracked or modified paths after both (porcelain status); empty when clean. */
      readonly leftOver: readonly string[];
    };

/**
 * Z0's side of build_environment, supplied by the execution service for an environment task only:
 * it reads the definition from the worktree, builds the image from the worktree's committed tree and
 * runs `probe` in a cell from it. The tool itself runs nothing on the host.
 */
export interface EnvironmentCheckPort {
  check(testTimeoutSeconds: number): Promise<EnvironmentCheckReport>;
}

/** `build` passed: it exited 0 within its time (a build may print nothing). */
export function environmentBuildPassed(build: EnvironmentTestRun): boolean {
  return build.exitCode === 0 && !build.timedOut;
}

/** `test` or `probe` passed: it exited 0 within its time and printed something (an empty pass proves nothing). */
export function environmentProbePassed(run: EnvironmentTestRun): boolean {
  return run.exitCode === 0 && !run.timedOut && `${shownText(run.stdout)}${shownText(run.stderr)}`.trim() !== "";
}

/** `build` and `test` passed and left the checkout clean: the scaffold's verdict, and a rebuilt environment's. */
export function environmentCommandsPassed(commands: EnvironmentCommandsRun): boolean {
  return (
    commands.kind === "ran" &&
    environmentBuildPassed(commands.build) &&
    environmentProbePassed(commands.test) &&
    commands.leftOver.length === 0
  );
}

/** The substrate's verdict on a definition: its image builds and `probe` passes. */
export function environmentCheckPassed(report: EnvironmentCheckReport): boolean {
  return report.kind === "tested" && environmentProbePassed(report.probe);
}

function logSection(title: string, log: ElidedText): string {
  const body = renderElided(log);
  return `${title}:\n${body === "" ? "(empty)" : body}`;
}

function commandSection(label: "Build" | "Test" | "Probe", run: EnvironmentTestRun, verdict: string): string {
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
  if (build.timedOut) return "FAILED: the build command timed out";
  return build.exitCode === null ? "FAILED: the build command ended with its exit status unknown" : `FAILED: the build command exited ${build.exitCode}`;
}

function printingVerdict(label: "test" | "probe", run: EnvironmentTestRun): string {
  if (environmentProbePassed(run)) return "PASSED";
  if (run.timedOut) return `FAILED: the ${label} command timed out`;
  if (run.exitCode === null) return `FAILED: the ${label} command ended with its exit status unknown`;
  return run.exitCode !== 0 ? `FAILED: the ${label} command exited ${run.exitCode}` : `FAILED: the ${label} command printed nothing`;
}

function formatCommands(commands: EnvironmentCommandsRun): string[] {
  const build = commandSection("Build", commands.build, buildVerdict(commands.build));
  if (commands.kind === "build_failed") return [build, "Test command: not run, because the build command failed.", "Verdict: FAILED"];
  const checkout =
    commands.leftOver.length === 0
      ? "Checkout after build and test: clean."
      : [
          `Checkout after build and test: NOT clean. Build or test left these paths untracked or modified; every file`,
          `they write must be ignored by the product's committed .gitignore:`,
          ...commands.leftOver.map((path) => `- ${path}`),
        ].join("\n");
  return [
    build,
    commandSection("Test", commands.test, printingVerdict("test", commands.test)),
    checkout,
    `Verdict: ${environmentCommandsPassed(commands) ? "PASSED" : "FAILED"}`,
  ];
}

/** The probe's run with its verdict, as the gate and the post-merge record read it. */
export function formatEnvironmentProbe(probe: EnvironmentTestRun): string {
  const verdict = environmentProbePassed(probe) ? "PASSED" : "FAILED";
  return [commandSection("Probe", probe, printingVerdict("probe", probe)), `Verdict: ${verdict}`].join("\n");
}

/** The report as the model and the gate's failure record read it. */
export function formatEnvironmentCheck(report: EnvironmentCheckReport): string {
  switch (report.kind) {
    case "definition_refused":
      return `Environment definition refused: ${report.detail}`;
    case "out_of_scope":
      return [
        `Environment work refused: it touches paths outside the recipe [${report.recipe.join(", ")}]. Environment work`,
        `adds, changes or deletes recipe files only; the product's code, manifests, tests and data are the product's`,
        `tasks' work. A product file the image build reads is named in inputs, never written here.`,
        `Out-of-scope paths:`,
        ...report.paths.map((path) => `- ${path}`),
      ].join("\n");
    case "build_failed":
      return [`Environment version ${report.version}: the image did not build: ${report.detail}`, logSection("Image build log", report.log)].join("\n");
    case "tested":
      return [
        `Environment version ${report.version}, image ${report.imageRef}.`,
        report.build.kind === "reused" ? "Image: this version was already built; its image was reused." : logSection("Image build log", report.build.log),
        formatEnvironmentProbe(report.probe),
      ].join("\n");
  }
}

/** One run of the product's `build` then `test`, with its verdict, as the post-merge record reads it. */
export function formatEnvironmentCommands(commands: EnvironmentCommandsRun): string {
  return formatCommands(commands).join("\n");
}
