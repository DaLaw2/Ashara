import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

// Every step the contractor loop runs over its subjects contains each subject's failure to it
// (containEach): one project's unknown exception must never stop the cycle for every project. The
// steps are read from the cycle itself, CoreLoop in core-loop.ts: every call it makes into a dependency
// or an imported function is classified below, so a step added to the cycle without a decision on its
// containment fails here, whatever it is named, and a step classified as contained must contain.

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const CORE_LOOP = "packages/delivery/src/core-loop.ts";

type CycleCall =
  /**
   * A per-project step: the declaration at `file` must run its subjects through containEach, or, with
   * `ownLedger`, through the call `marker` names, which contains each subject in a ledger of its own (`why`).
   */
  | { readonly kind: "step"; readonly file: string; readonly declaration: string; readonly ownLedger?: { readonly marker: string; readonly why: string } }
  /** Not a per-project step, with the reason: one project's failure cannot reach the cycle through it. */
  | { readonly kind: "not-per-project"; readonly reason: string };

const runPending = (file: string, ownLedger?: { readonly marker: string; readonly why: string }): CycleCall => ({ kind: "step", file, declaration: "async runPending(", ...(ownLedger === undefined ? {} : { ownLedger }) });

/** Every call CoreLoop makes into a dependency or an imported function. */
const CYCLE_CALLS: Readonly<Record<string, CycleCall>> = {
  "deps.clientStops.runPending": runPending("packages/engagement/src/client-stop.ts"),
  "deps.clientChanges.runPending": runPending("packages/engagement/src/client-change.ts"),
  "deps.stackChoices.runPending": runPending("packages/engagement/src/stack-choice.ts"),
  "deps.liaisonIntake.runPending": runPending("packages/engagement/src/intake.ts"),
  "deps.liaisonAnswers.runPending": runPending("packages/engagement/src/answers.ts"),
  "deps.rosterDerivation.runPending": runPending("packages/organization/src/derivation.ts"),
  "deps.firstPlanning.runPending": runPending("packages/delivery/src/first-plan.ts"),
  "deps.replanning.runPending": runPending("packages/delivery/src/replan.ts"),
  "deps.planReports.runPending": runPending("packages/engagement/src/plan-report.ts"),
  "deps.blockReports.runPending": runPending("packages/engagement/src/block-report.ts"),
  "deps.deliveredReports.runPending": runPending(
    "packages/engagement/src/delivered-report.ts",
    {
      marker: "this.contained(",
      why: "every report runs through contained(), which records any failure of it on its acceptance sweep with a backoff, bounded by the notice sent in its place",
    },
  ),
  resumeInfrastructureHalts: { kind: "step", file: "packages/delivery/src/infrastructure-halts.ts", declaration: "export async function resumeInfrastructureHalts(" },
  releaseClearedBlocks: { kind: "step", file: "packages/delivery/src/parked-exits.ts", declaration: "export async function releaseClearedBlocks(" },
  runAcceptanceSweeps: { kind: "step", file: "packages/delivery/src/acceptance.ts", declaration: "export async function runAcceptanceSweeps(" },
  "PlanningService.gate": { kind: "step", file: "packages/delivery/src/domain/gate.ts", declaration: "static async filterAvailable(" },
  "PlanningService.select": { kind: "not-per-project", reason: "a pure choice over the tasks already gated; reads nothing" },
  "deps.taskLanes": { kind: "not-per-project", reason: "each task runs in its own lane and settles on its own (Promise.allSettled); a rejection goes to handleProcessingError" },
  processTask: { kind: "not-per-project", reason: "runs inside a task's lane, whose rejection is settled per task" },
  handleProcessingError: { kind: "not-per-project", reason: "one task's recovery; it catches its own recovery failure and returns the task interrupted" },
  "deps.spendCap.deploymentStop": { kind: "not-per-project", reason: "the deployment's cap, one read for every project" },
  "deps.spendCap.refusalOf": { kind: "not-per-project", reason: "a pure reading of an error" },
  "deps.projectRepo.blockAllActive": { kind: "not-per-project", reason: "the deployment's halt at its cap, one write for every project" },
  "deps.projectRepo.block": { kind: "not-per-project", reason: "the halt of one project, which is how a step's own failure is contained" },
  "deps.cycleLog.emit": { kind: "not-per-project", reason: "the cycle's own log line" },
  parseProjectId: { kind: "not-per-project", reason: "a pure parse" },
  projectCapCause: { kind: "not-per-project", reason: "a pure constructor" },
  deploymentCapCause: { kind: "not-per-project", reason: "a pure constructor" },
};

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/** The text from `start` to the first line closing it at the indentation `start`'s line opened at. */
function bodyFrom(text: string, start: number): string {
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
  const close = text.indexOf(`\n${indent}}`, start);
  if (close === -1) throw new Error(`no closing brace at indentation ${JSON.stringify(indent)} after offset ${start}`);
  return text.slice(start, close);
}

/** Every call the CoreLoop class makes into its dependencies, PlanningService, or a value it imports. */
function callsOfTheCycle(): Set<string> {
  const text = read(CORE_LOOP);
  const start = text.indexOf("export class CoreLoop {");
  expect(start, `${CORE_LOOP} no longer declares the CoreLoop class`).toBeGreaterThanOrEqual(0);
  const body = bodyFrom(text, start);
  const calls = new Set<string>();
  for (const match of body.matchAll(/\bdeps\.(\w+)\.(\w+)\(/g)) calls.add(`deps.${match[1]}.${match[2]}`);
  for (const match of body.matchAll(/\bdeps\.(\w+)\(/g)) calls.add(`deps.${match[1]}`);
  for (const match of body.matchAll(/\bPlanningService\.(\w+)\(/g)) calls.add(`PlanningService.${match[1]}`);
  const imported = [...text.matchAll(/^import \{([^}]*)\} from "[^"]+";$/gm)].flatMap((match) =>
    match[1].split(",").map((name) => name.trim()).filter((name) => name.length > 0 && !name.startsWith("type ")),
  );
  for (const name of imported) if (new RegExp(`\\b${name}\\(`).test(body)) calls.add(name);
  return calls;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the cycle's per-project steps", () => {
  test("every call the cycle makes is classified, and every per-project step contains each subject with containEach", () => {
    const calls = callsOfTheCycle();
    expect([...calls].filter((call) => CYCLE_CALLS[call] === undefined), "calls of CoreLoop with no containment decision").toEqual([]);
    expect(Object.keys(CYCLE_CALLS).filter((call) => !calls.has(call)), "classified calls CoreLoop no longer makes").toEqual([]);

    const uncontained: string[] = [];
    for (const [call, classified] of Object.entries(CYCLE_CALLS)) {
      if (classified.kind !== "step") continue;
      const text = read(classified.file);
      const at = text.indexOf(classified.declaration);
      expect(at, `${classified.file} no longer declares ${classified.declaration}`).toBeGreaterThanOrEqual(0);
      if (!bodyFrom(text, at).includes(classified.ownLedger?.marker ?? "containEach(")) uncontained.push(`${call} (${classified.file})`);
    }
    expect(uncontained).toEqual([]);
  });

  test("every runPending, wherever it is declared, contains each subject", () => {
    const ownLedger = new Map(Object.values(CYCLE_CALLS).flatMap((call) => (call.kind === "step" && call.ownLedger !== undefined ? [[call.file, call.ownLedger.marker] as const] : [])));
    const uncontained: string[] = [];
    for (const pkg of readdirSync(join(ROOT, "packages")).filter((name) => name !== "integration")) {
      for (const path of sourceFiles(join(ROOT, "packages", pkg, "src"))) {
        const text = readFileSync(path, "utf8");
        const file = relative(ROOT, path);
        for (const match of text.matchAll(/async runPending\(/g)) {
          if (!bodyFrom(text, match.index).includes(ownLedger.get(file) ?? "containEach(")) uncontained.push(file);
        }
      }
    }
    expect(uncontained).toEqual([]);
  });

  test("every loop over the active projects contains each project with containEach", () => {
    const uncontained: string[] = [];
    for (const pkg of readdirSync(join(ROOT, "packages")).filter((name) => name !== "integration")) {
      for (const path of sourceFiles(join(ROOT, "packages", pkg, "src"))) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(/\.listActiveIds\(\)/g)) {
          const fn = text.lastIndexOf("async ", match.index);
          if (fn === -1 || !bodyFrom(text, fn).includes("containEach(")) uncontained.push(relative(ROOT, path));
        }
      }
    }
    expect(uncontained).toEqual([]);
  });
});
