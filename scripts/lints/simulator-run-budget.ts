/** A packages/integration/src/simulator test file over its budget of simulator runs (scripts/simulator-run-budget.ts). */

import path from "node:path";
import { findRunBudgetFindings } from "../simulator-run-budget.js";
import { contextProgram, type LintContext, type Violation } from "./lint.js";

const SIMULATOR_RUN_BUDGET = "simulator-run-budget";

/** Each simulator test file over its budget of runs, read from the gate's one program, and a scan of no file. */
export function run(context: LintContext): Violation[] {
  const { root } = context;
  const dir = path.join(root, "packages", "integration", "src", "simulator");
  const built = contextProgram(context);
  const files = built.files.filter((file) => path.dirname(file) === dir && file.endsWith(".test.ts"));
  if (files.length === 0) {
    return [{ file: path.relative(root, dir), line: 0, fromPkg: "integration", specifier: SIMULATOR_RUN_BUDGET, reason: "no simulator test file to count runs in; a scan of nothing would pass" }];
  }
  return files.flatMap((file) =>
    findRunBudgetFindings(built, file, path.relative(root, file).split(path.sep).join("/")).map((finding) => ({
      file: finding.file,
      line: finding.line,
      fromPkg: "integration",
      specifier: SIMULATOR_RUN_BUDGET,
      reason: finding.reason,
    })),
  );
}
