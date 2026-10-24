/**
 * An exported function or constructor of a package's production source takes at most five
 * positional parameters: past that, two adjacent arguments of one type swap without a compile
 * error, so a longer list is one named-parameter object. A site that keeps a longer list is named
 * in POSITIONAL_ALLOWED with its reason; an entry that names no such site fails, so the list
 * cannot outlive the sites it excuses.
 */

import ts from "typescript";
import type { LintContext, Violation } from "./lint.js";

const POSITIONAL_PARAMS = "positional-params";
const MAX_POSITIONAL = 5;

interface AllowedSite {
  /** Root-relative, `/`-separated. */
  readonly file: string;
  /** The function's name, or `constructor of <Class>`. */
  readonly name: string;
  readonly reason: string;
}

const ERROR_CONTEXT = "a typed error's constructor: each parameter is a field of its structured context, read back by name off the error";
const CHECKOUT_CELL = "Execution Infrastructure's checkout-cell runners, a cluster of its own outside the named-parameter work on Delivery and Quality's builders";
const CHECK_FILES = "Quality's check-file harvest and checkout runs, a cluster of their own outside the named-parameter work on the dispatch-result builders";
const SIMULATOR = "simulator internals, reshaped with the simulator's long functions";

const POSITIONAL_ALLOWED: readonly AllowedSite[] = [
  { file: "packages/evaluation/src/trust-ledger.ts", name: "constructor of MappingDigestMismatch", reason: ERROR_CONTEXT },
  { file: "packages/execution-infra/src/checkout-lock.ts", name: "constructor of CheckoutHolderOverran", reason: ERROR_CONTEXT },
  { file: "packages/execution-infra/src/errors.ts", name: "constructor of CellExecFailed", reason: ERROR_CONTEXT },
  { file: "packages/execution-infra/src/errors.ts", name: "constructor of WorkspaceSnapshotFailed", reason: ERROR_CONTEXT },
  { file: "packages/execution-infra/src/errors.ts", name: "constructor of EnvironmentBuildFailed", reason: ERROR_CONTEXT },
  { file: "packages/shared/src/json.ts", name: "constructor of JsonParseFailed", reason: ERROR_CONTEXT },
  { file: "packages/execution-infra/src/checkout-cell.ts", name: "withCheckoutCell", reason: CHECKOUT_CELL },
  { file: "packages/execution-infra/src/checkout-cell.ts", name: "runProbeOnCheckout", reason: CHECKOUT_CELL },
  { file: "packages/execution-infra/src/checkout-cell.ts", name: "buildAndProbe", reason: CHECKOUT_CELL },
  { file: "packages/quality/src/task-checks.ts", name: "harvestCheckFiles", reason: CHECK_FILES },
  { file: "packages/quality/src/task-checks.ts", name: "previewCheckFiles", reason: CHECK_FILES },
  { file: "packages/quality/src/task-checks.ts", name: "runSuitesOnCheckout", reason: CHECK_FILES },
  { file: "packages/quality/src/task-checks.ts", name: "runChecksOnCheckout", reason: CHECK_FILES },
  { file: "packages/quality/src/environment-check.ts", name: "runFoundationBuild", reason: CHECK_FILES },
  { file: "packages/integration/src/simulator/run-instance.ts", name: "tender", reason: SIMULATOR },
  { file: "packages/integration/src/simulator/run-setup.ts", name: "provision", reason: SIMULATOR },
];

/** One exported function or constructor with its positional parameter count. */
interface ParameterList {
  readonly name: string;
  readonly line: number;
  readonly params: number;
}

function hasExport(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers !== undefined && modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** The positional parameters of a signature: a leading `this` is a type annotation, not an argument. */
function positional(fn: ts.SignatureDeclarationBase): number {
  return fn.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this")).length;
}

/** Every function or constructor `source` exports, directly or through an export list of its own names. */
function exportedParameterLists(file: string, source: string): ParameterList[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const listed = new Set<string>();
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) listed.add((element.propertyName ?? element.name).text);
    }
  }
  const exported = (node: ts.Node, name: string | undefined): boolean => hasExport(node) || (name !== undefined && listed.has(name));
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const found: ParameterList[] = [];
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body !== undefined && exported(statement, statement.name?.text)) {
      found.push({ name: statement.name?.text ?? "default", line: lineOf(statement), params: positional(statement) });
    } else if (ts.isClassDeclaration(statement) && exported(statement, statement.name?.text)) {
      for (const member of statement.members) {
        if (ts.isConstructorDeclaration(member) && member.body !== undefined) {
          found.push({ name: `constructor of ${statement.name?.text ?? "default"}`, line: lineOf(member), params: positional(member) });
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (!ts.isIdentifier(declaration.name) || init === undefined || !(ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue;
        if (exported(statement, declaration.name.text)) found.push({ name: declaration.name.text, line: lineOf(declaration), params: positional(init) });
      }
    }
  }
  return found;
}

export function run(context: LintContext): Violation[] {
  const violations: Violation[] = [];
  const used = new Set<AllowedSite>();
  let scanned = 0;
  for (const pkg of context.packages) {
    for (const [filePath, source] of pkg.contents) {
      const relative = pkg.relativeTo(filePath);
      if (!relative.startsWith("src/") || relative.endsWith(".test.ts") || relative.endsWith(".d.ts")) continue;
      scanned++;
      const file = `packages/${pkg.name}/${relative}`;
      for (const list of exportedParameterLists(file, source)) {
        if (list.params <= MAX_POSITIONAL) continue;
        const allowed = POSITIONAL_ALLOWED.find((site) => site.file === file && site.name === list.name);
        if (allowed !== undefined) {
          used.add(allowed);
          continue;
        }
        violations.push({
          file,
          line: list.line,
          fromPkg: pkg.name,
          specifier: POSITIONAL_PARAMS,
          reason: `${list.name} takes ${list.params} positional parameters, past ${MAX_POSITIONAL}; take one named-parameter object`,
        });
      }
    }
  }
  if (scanned === 0) violations.push({ file: "packages", line: 0, fromPkg: "*", specifier: POSITIONAL_PARAMS, reason: "no production source to scan; a scan of nothing would pass" });
  for (const site of POSITIONAL_ALLOWED) {
    if (!used.has(site)) {
      violations.push({ file: site.file, line: 0, fromPkg: "*", specifier: POSITIONAL_PARAMS, reason: `the allowed site ${site.name} no longer takes more than ${MAX_POSITIONAL} positional parameters; remove its entry` });
    }
  }
  return violations;
}
