/**
 * The boundary gate of `just check`: runs every lint of scripts/lints/ over the tree, each a module
 * whose `run` returns its violations, against the rules in boundary-rules.toml (scripts/lints/rules.ts
 * states their shapes). The import lints hold each package to its section: the cross-package import
 * matrix, named-only, stand-in and bounds-table files, internal modules, the symbols only one module
 * may import, subpath entries, test-only subpaths and the classes of another context a package may
 * import. The others are no import rule, run here so each needs no gate of its own: price-column defaults, unsupplied
 * optional dependencies, stack literals, table ownership, the project record's columns, the
 * simulator's run budgets, raw copies of a
 * cross-context predicate, the verification split, a copy of a wording the simulator's stand-ins
 * recognise, the line limits of the modules split by role, a name declared outside its one home, and an
 * exported function or constructor with a long positional parameter list.
 *
 * Exits 0 if clean, 1 on violations, on a malformed rules file, or when the
 * rules sections and the directories under packages/ do not match one-to-one.
 *
 * Usage: npx tsx scripts/check-boundaries.ts
 */

import path from "node:path";
import { describeErrorChain } from "@ashara/shared";
import { run as classImports } from "./lints/class-imports.js";
import { run as fileSizes } from "./lints/file-sizes.js";
import { run as internalModules } from "./lints/internal-modules.js";
import { run as languageHomes } from "./lints/language-homes.js";
import { loadLintContext } from "./lints/lint.js";
import type { LintContext, Violation } from "./lints/lint.js";
import { run as moduleNames } from "./lints/module-names.js";
import { run as optionalDeps } from "./lints/optional-deps.js";
import { run as packageImports } from "./lints/package-imports.js";
import { run as positionalParams } from "./lints/positional-params.js";
import { run as predicateCopies } from "./lints/predicate-copies.js";
import { run as priceDefaults } from "./lints/price-defaults.js";
import { run as projectRecord } from "./lints/project-record.js";
import { run as recognisedWording } from "./lints/recognised-wording.js";
import { run as scriptSubpaths } from "./lints/script-subpaths.js";
import { run as simulatorRunBudget } from "./lints/simulator-run-budget.js";
import { run as stackLiterals } from "./lints/stack-literals.js";
import { run as subpathEntries } from "./lints/subpath-entries.js";
import { run as tableOwnership } from "./lints/table-ownership.js";
import { run as testOnlySubpaths } from "./lints/test-only-subpaths.js";
import { run as verificationSplit } from "./lints/verification-split.js";

const LINTS: ReadonlyArray<(context: LintContext) => Violation[]> = [
  packageImports,
  internalModules,
  moduleNames,
  priceDefaults,
  optionalDeps,
  stackLiterals,
  tableOwnership,
  projectRecord,
  subpathEntries,
  scriptSubpaths,
  testOnlySubpaths,
  classImports,
  simulatorRunBudget,
  predicateCopies,
  verificationSplit,
  recognisedWording,
  fileSizes,
  languageHomes,
  positionalParams,
];

function main(): void {
  const root = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
  const context = loadLintContext(root);
  const violations = LINTS.flatMap((lint) => lint(context));
  const filesChecked = context.packages.reduce((sum, pkg) => sum + pkg.contents.size, 0);
  if (violations.length > 0) {
    console.error("\nBoundary violations found:\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.fromPkg} -> "${v.specifier}"  (${v.reason})`);
    }
    console.error(`\n${filesChecked} files checked, ${violations.length} violations found\n`);
    process.exit(1);
  }
  console.log(`\nAll boundaries clean. ${filesChecked} files checked, 0 violations.\n`);
  process.exit(0);
}

// Parse, coverage and filesystem errors all fail closed with one message format.
try {
  main();
} catch (err) {
  // eslint-disable-next-line ashara/catch-continue -- best effort: the operator script exits 1 below with the error's chain
  console.error(`\nERROR: ${describeErrorChain(err)}\n`);
  process.exit(1);
}
