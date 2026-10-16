import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

// Every step the contractor loop runs over its subjects contains each subject's failure to it
// (containEach): one project's unknown exception must never stop the cycle for every project. A
// step written without it is found here, not in a stalled deployment.

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** Steps whose subjects are contained by a ledger of their own, with the reason. */
const OWN_LEDGER: Readonly<Record<string, string>> = {
  "packages/engagement/src/delivered-report.ts":
    "each report's failure is recorded on its acceptance sweep with a backoff (recordReportFailure), and post() catches",
};

/** The core loop's per-project steps that are functions, not a runPending method. */
const STEP_FUNCTIONS: Readonly<Record<string, string>> = {
  "packages/delivery/src/acceptance.ts": "export async function runAcceptanceSweeps(",
  "packages/delivery/src/parked-exits.ts": "export async function releaseClearedBlocks(",
  "packages/delivery/src/infrastructure-halts.ts": "export async function resumeInfrastructureHalts(",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** The text from `start` to the first line closing it at the indentation `start`'s line opened at. */
function bodyFrom(text: string, start: number): string {
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
  const close = text.indexOf(`\n${indent}}`, start);
  if (close === -1) throw new Error(`no closing brace at indentation ${JSON.stringify(indent)} after offset ${start}`);
  return text.slice(start, close);
}

describe("the cycle's per-project steps", () => {
  test("every runPending and every step function contains each subject with containEach", () => {
    const packages = readdirSync(join(ROOT, "packages")).filter((name) => name !== "integration");
    const steps: Array<{ file: string; body: string }> = [];
    for (const pkg of packages) {
      for (const path of sourceFiles(join(ROOT, "packages", pkg, "src"))) {
        const text = readFileSync(path, "utf8");
        const file = relative(ROOT, path);
        for (const match of text.matchAll(/async runPending\(/g)) steps.push({ file, body: bodyFrom(text, match.index) });
        const fn = STEP_FUNCTIONS[file];
        if (fn !== undefined) {
          const at = text.indexOf(fn);
          expect(at, `${file} no longer declares ${fn}`).toBeGreaterThanOrEqual(0);
          steps.push({ file, body: bodyFrom(text, at) });
        }
      }
    }

    expect(steps.length).toBeGreaterThanOrEqual(Object.keys(STEP_FUNCTIONS).length + 10);
    const uncontained = steps.filter((step) => !step.body.includes("containEach(") && OWN_LEDGER[step.file] === undefined).map((step) => step.file);
    expect(uncontained).toEqual([]);
    for (const file of Object.keys(OWN_LEDGER)) expect(steps.map((step) => step.file), `${file} has no runPending`).toContain(file);
  });
});
