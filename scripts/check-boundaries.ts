/**
 * The boundary gate of `just check`: runs every lint of scripts/lints/ over the tree, each a module
 * whose `run` returns its violations, against the rules in boundary-rules.toml (scripts/lints/rules.ts
 * states their shapes). Every lint that reads an import edge or a type reads it from one program over
 * the tree (module-program.ts), built here once for the run. The import lints hold each package to
 * its section: the cross-package import matrix, named-only, stand-in and bounds-table files,
 * internal modules, the symbols only one module may import, subpath entries, test-only subpaths and
 * the classes of another context a package may import. The others are no import rule, run here so
 * each needs no gate of its own: price-column defaults, unsupplied optional dependencies, stack
 * literals, table ownership, the project record's columns, the simulator's run budgets, raw copies
 * of a cross-context predicate, the verification split, a copy of a wording the simulator's
 * stand-ins recognise, the line limits of the modules split by role, a name declared outside its
 * one home, a function, method or method signature of production source or scripts/ with a long
 * positional parameter list, a function of production source or scripts/ past the line bound, and
 * mirrored types: one type name packages' production source declares twice, two type declarations
 * of production source or scripts/, under one name or several, the checker finds mutually assignable
 * over one property set, and a type the checker finds one with what a function of another module
 * returns, written over that function's type through any alias.
 *
 * Exits 0 if clean, 1 on violations, on a malformed rules file, or when the
 * rules sections and the directories under packages/ do not match one-to-one. boundaryReport is the
 * same check of any root in the calling process, so a caller that checks several trees in a row
 * shares the module program's kept programs between them instead of building each in a process of
 * its own.
 *
 * Usage: npx tsx scripts/check-boundaries.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeErrorChain } from "@ashara/shared";
import { run as classImports } from "./lints/class-imports.js";
import { run as fileSizes } from "./lints/file-sizes.js";
import { run as functionLength } from "./lints/function-length.js";
import { run as internalModules } from "./lints/internal-modules.js";
import { run as languageHomes } from "./lints/language-homes.js";
import { contextProgram, loadLintContext } from "./lints/lint.js";
import type { LintContext, Violation } from "./lints/lint.js";
import { run as mirroredTypes } from "./lints/mirrored-types.js";
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
  functionLength,
  mirroredTypes,
];

/** The gate's verdict on one tree: its exit status and the report it prints. */
interface BoundaryReport {
  readonly status: 0 | 1;
  readonly output: string;
}

function reportOf(root: string): BoundaryReport {
  const context = loadLintContext(root);
  contextProgram(context);
  const violations = LINTS.flatMap((lint) => lint(context));
  const filesChecked = context.packages.reduce((sum, pkg) => sum + pkg.contents.size, 0);
  if (violations.length === 0) return { status: 0, output: `\nAll boundaries clean. ${filesChecked} files checked, 0 violations.\n` };
  const lines = violations.map((v) => `  ${v.file}:${v.line}  ${v.fromPkg} -> "${v.specifier}"  (${v.reason})`);
  return { status: 1, output: ["\nBoundary violations found:\n", ...lines, `\n${filesChecked} files checked, ${violations.length} violations found\n`].join("\n") };
}

/**
 * Every lint over the tree at `root`, as the gate runs them. Parse, coverage and filesystem errors
 * all fail closed with one message format.
 * @testseam boundary-probes.test.ts checks its scratch trees in its own process
 */
export function boundaryReport(root: string): BoundaryReport {
  try {
    return reportOf(root);
  } catch (err) {
    return { status: 1, output: `\nERROR: ${describeErrorChain(err)}\n` };
  }
}

function main(): void {
  const report = boundaryReport(path.resolve(import.meta.dirname, ".."));
  if (report.status === 0) console.log(report.output);
  else console.error(report.output);
  process.exit(report.status);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
