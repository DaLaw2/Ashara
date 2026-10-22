/** Every import of a subpath a subpath-importers list holds, from scripts/, which no list admits: those lists admit only packages. */

import fs from "node:fs";
import path from "node:path";
import type { LintContext, Violation } from "./lint.js";
import { PACKAGE_IMPORT_RE, collectTsFiles, scanLines } from "./source-files.js";

export function run(context: LintContext): Violation[] {
  const { root, rules } = context;
  const violations: Violation[] = [];
  for (const filePath of collectTsFiles(path.join(root, "scripts"))) {
    scanLines(fs.readFileSync(filePath, "utf-8"), PACKAGE_IMPORT_RE, (line, match) => {
      const [, specifier, pkg] = match;
      const lists = rules.get(pkg)?.subpathImporters;
      if (specifier === `@ashara/${pkg}` || lists === undefined || lists.size === 0) return;
      violations.push({ file: path.relative(root, filePath), line, fromPkg: "scripts", specifier, reason: `scripts/ imports no subpath of package "${pkg}", whose subpath-importers admit only packages` });
    });
  }
  return violations;
}
