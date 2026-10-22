/**
 * Line limits on the modules split by role: a module past its limit is where unrelated roles grow
 * back together, and the boundary gate's runner past its limit is where lint logic moves back into
 * the wiring. Every glob must match a file, so a renamed module cannot leave its limit holding nothing.
 */

import fs from "node:fs";
import path from "node:path";
import type { LintContext, Violation } from "./lint.js";
import { collectTsFiles, matchesAnyGlob } from "./source-files.js";

interface FileLimit {
  /** Root-relative glob; `*` stays within a path segment. */
  readonly glob: string;
  readonly maxLines: number;
}

const FILE_LIMITS: readonly FileLimit[] = [
  { glob: "packages/integration/src/simulator/scripted-models.ts", maxLines: 200 },
  { glob: "packages/integration/src/simulator/stand-ins/*.ts", maxLines: 400 },
  { glob: "packages/delivery/src/replan*.ts", maxLines: 450 },
  { glob: "packages/delivery/src/revision-*.ts", maxLines: 300 },
  { glob: "packages/integration/src/server/replan-*.ts", maxLines: 1000 },
  { glob: "scripts/check-boundaries.ts", maxLines: 120 },
  { glob: "scripts/lints/*.ts", maxLines: 400 },
];

/** The runner's `main`: it wires the lints and reports, and holds no lint of its own. */
const RUNNER = { file: "scripts/check-boundaries.ts", fn: "main", maxLines: 60 };

/** The lines of the column-0 `function <fn>(` declaration through its column-0 closing brace; null when it has none. */
function functionLines(content: string, fn: string): { readonly line: number; readonly lines: number } | null {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^(?:export )?(?:async )?function ${fn}\\(`).test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line === "}");
  return end < 0 ? null : { line: start + 1, lines: end - start + 1 };
}

export function run(context: LintContext): Violation[] {
  const { root } = context;
  const at = (file: string, line: number, specifier: string, reason: string): Violation => ({ file, line, fromPkg: "*", specifier, reason });
  const violations: Violation[] = [];
  for (const limit of FILE_LIMITS) {
    const dir = path.join(root, limit.glob.slice(0, limit.glob.lastIndexOf("/")));
    const files = fs.existsSync(dir) ? collectTsFiles(dir).map((file) => path.relative(root, file).split(path.sep).join("/")).filter((file) => matchesAnyGlob(file, [limit.glob])) : [];
    if (files.length === 0) violations.push(at(limit.glob, 0, "file-size", "the limit's glob matches no file; a limit that holds nothing passes everything"));
    for (const file of files) {
      const lines = fs.readFileSync(path.join(root, file), "utf-8").split("\n").length;
      if (lines > limit.maxLines) violations.push(at(file, 0, "file-size", `${lines} lines, past the limit of ${limit.maxLines} for ${limit.glob}; split it by role`));
    }
  }
  const runnerPath = path.join(root, RUNNER.file);
  const found = fs.existsSync(runnerPath) ? functionLines(fs.readFileSync(runnerPath, "utf-8"), RUNNER.fn) : null;
  if (found === null) violations.push(at(RUNNER.file, 0, RUNNER.fn, `no column-0 function ${RUNNER.fn} to measure; a limit that holds nothing passes everything`));
  else if (found.lines >= RUNNER.maxLines) violations.push(at(RUNNER.file, found.line, RUNNER.fn, `${found.lines} lines, at or past the limit of ${RUNNER.maxLines}; move the logic into a lint module`));
  return violations;
}
