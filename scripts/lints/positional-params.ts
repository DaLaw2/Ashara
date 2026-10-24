/**
 * Every function-like declaration of a package's production source and of scripts/ takes at most
 * five positional parameters: a function at any depth, an arrow or function expression, a class's
 * constructor or method, an interface's or port's method signature. Past five, two adjacent
 * arguments of one type swap without a compile error, so a longer list is one named-parameter
 * object. A site that keeps a longer list is named in POSITIONAL_ALLOWED with its reason; an entry
 * that names no such site fails, so the list cannot outlive the sites it excuses.
 */

import ts from "typescript";
import type { LintContext, Violation } from "./lint.js";
import { functionName, productionFiles, type AllowedFunction } from "./production-source.js";

const POSITIONAL_PARAMS = "positional-params";
const MAX_POSITIONAL = 5;

const ERROR_CONTEXT = "a typed error's constructor: each parameter is a field of its structured context, read back by name off the error";

const POSITIONAL_ALLOWED: readonly AllowedFunction[] = [
  { file: "packages/evaluation/src/trust-ledger.ts", name: "constructor of MappingDigestMismatch", reason: ERROR_CONTEXT },
  { file: "packages/execution-infra/src/checkout-lock.ts", name: "constructor of CheckoutHolderOverran", reason: ERROR_CONTEXT },
  { file: "packages/execution-infra/src/errors.ts", name: "constructor of CellExecFailed", reason: ERROR_CONTEXT },
  { file: "packages/execution-infra/src/errors.ts", name: "constructor of WorkspaceSnapshotFailed", reason: ERROR_CONTEXT },
  { file: "packages/execution-infra/src/errors.ts", name: "constructor of EnvironmentBuildFailed", reason: ERROR_CONTEXT },
  { file: "packages/server/src/config.ts", name: "constructor of TaskLanesExceedHost", reason: ERROR_CONTEXT },
  { file: "packages/shared/src/json.ts", name: "constructor of JsonParseFailed", reason: ERROR_CONTEXT },
];

/** One function-like declaration with its positional parameter count. */
interface ParameterList {
  readonly name: string;
  readonly line: number;
  readonly params: number;
}

/** The positional parameters of a signature: a leading `this` is a type annotation, not an argument. */
function positional(fn: ts.SignatureDeclarationBase): number {
  return fn.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this")).length;
}

/** Every function-like declaration of `source`, at any depth. */
function parameterLists(file: string, source: string): ParameterList[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: ParameterList[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      found.push({ name: functionName(node, sf), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, params: positional(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

export function run(context: LintContext): Violation[] {
  const violations: Violation[] = [];
  const used = new Set<AllowedFunction>();
  const files = productionFiles(context);
  for (const [file, source] of files) {
    for (const list of parameterLists(file, source)) {
      if (list.params <= MAX_POSITIONAL) continue;
      const allowed = POSITIONAL_ALLOWED.find((site) => site.file === file && site.name === list.name);
      if (allowed !== undefined) {
        used.add(allowed);
        continue;
      }
      const [top, pkg] = file.split("/");
      violations.push({
        file,
        line: list.line,
        fromPkg: top === "packages" && pkg !== undefined ? pkg : "scripts",
        specifier: POSITIONAL_PARAMS,
        reason: `${list.name} takes ${list.params} positional parameters, past ${MAX_POSITIONAL}; take one named-parameter object`,
      });
    }
  }
  if (!files.some(([file]) => file.startsWith("packages/"))) {
    violations.push({ file: "packages", line: 0, fromPkg: "*", specifier: POSITIONAL_PARAMS, reason: "no production source to scan; a scan of nothing would pass" });
  }
  if (!files.some(([file]) => file.startsWith("scripts/"))) {
    violations.push({ file: "scripts", line: 0, fromPkg: "scripts", specifier: POSITIONAL_PARAMS, reason: "no script to scan; a scan of nothing would pass" });
  }
  for (const site of POSITIONAL_ALLOWED) {
    if (!used.has(site)) {
      violations.push({ file: site.file, line: 0, fromPkg: "*", specifier: POSITIONAL_PARAMS, reason: `the allowed site ${site.name} no longer takes more than ${MAX_POSITIONAL} positional parameters; remove its entry` });
    }
  }
  return violations;
}
