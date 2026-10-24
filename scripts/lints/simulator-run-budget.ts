/** A packages/integration/src/simulator test file over its budget of simulator runs (scripts/simulator-run-budget.ts). */

import fs from "node:fs";
import path from "node:path";
import { findRunBudgetFindings } from "../simulator-run-budget.js";
import type { LintContext, Violation } from "./lint.js";

const SIMULATOR_RUN_BUDGET = "simulator-run-budget";

/** Each simulator test file over its budget of runs, and a scan of no file. */
export function run(context: LintContext): Violation[] {
  const { root } = context;
  const dir = path.join(root, "packages", "integration", "src", "simulator");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".test.ts"));
  if (files.length === 0) {
    return [{ file: path.relative(root, dir), line: 0, fromPkg: "integration", specifier: SIMULATOR_RUN_BUDGET, reason: "no simulator test file to count runs in; a scan of nothing would pass" }];
  }
  const readModule = (specifier: string, fromFile: string): string | null => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
    const target = path.resolve(path.dirname(path.resolve(dir, fromFile)), specifier.replace(/\.js$/, ".ts"));
    return fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : null;
  };
  return files.flatMap((name) =>
    findRunBudgetFindings(fs.readFileSync(path.join(dir, name), "utf-8"), path.join(dir, name), readModule).map((finding) => ({
      file: path.relative(root, path.resolve(dir, finding.file)).split(path.sep).join("/"),
      line: finding.line,
      fromPkg: "integration",
      specifier: SIMULATOR_RUN_BUDGET,
      reason: finding.reason,
    })),
  );
}
