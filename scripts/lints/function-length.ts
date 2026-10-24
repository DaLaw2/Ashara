/**
 * Every function-like declaration with a body, in a package's production source and in scripts/, spans
 * at most FUNCTION_LINE_BOUND lines, from the line it starts on to the line it ends on, nested functions
 * included. Past the bound a body holds several responsibilities, each a function of its own: the
 * composition root by context, the routes by resource, a cycle by step, a dispatch by phase. The bound
 * is 120 lines: with the longest bodies split that way no function of the tree is past it, so the
 * allowlist holds no entry a split could remove, and a body that grows past it is split or allowed
 * on record. packages/integration is scanned like every package: its lifecycle simulator and its
 * suite fixtures are shared test infrastructure every integration test builds on, and they grow as
 * the product does. A function that keeps a longer body is named in LONG_FUNCTIONS_ALLOWED with its
 * reason; an entry with no reason fails, and so does one that names no function past the bound, so
 * the list cannot outlive the functions it excuses.
 */

import ts from "typescript";
import type { LintContext, Violation } from "./lint.js";
import { functionName, productionFiles } from "./production-source.js";

const FUNCTION_LENGTH = "function-length";
const FUNCTION_LINE_BOUND = 120;
const INTEGRATION = "packages/integration/";

interface LongFunctionAllowed {
  /** Root-relative, `/`-separated. */
  readonly file: string;
  /** The function's name as functionName reports it. */
  readonly name: string;
  readonly reason: string;
}

const LONG_FUNCTIONS_ALLOWED: readonly LongFunctionAllowed[] = [];

/** One function-like declaration with a body, and the lines it spans. */
interface FunctionSpan {
  readonly name: string;
  readonly line: number;
  readonly lines: number;
}

function functionSpans(file: string, source: string): FunctionSpan[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: FunctionSpan[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
      found.push({ name: functionName(node, sf), line: start + 1, lines: end - start + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function packageOf(file: string): string {
  const [top, pkg] = file.split("/");
  return top === "packages" && pkg !== undefined ? pkg : "scripts";
}

/**
 * @testseam lints.test.ts feeds it an allowlist of its own
 * The functions of `context` past the bound that `allowed` does not name, and every entry of `allowed`
 * with no reason or naming no function past the bound.
 */
export function longFunctions(context: LintContext, allowed: readonly LongFunctionAllowed[]): Violation[] {
  const violations: Violation[] = [];
  const used = new Set<LongFunctionAllowed>();
  const files = productionFiles(context);
  for (const [file, source] of files) {
    for (const span of functionSpans(file, source)) {
      if (span.lines <= FUNCTION_LINE_BOUND) continue;
      const entry = allowed.find((site) => site.file === file && site.name === span.name);
      if (entry !== undefined) {
        used.add(entry);
        continue;
      }
      violations.push({
        file,
        line: span.line,
        fromPkg: packageOf(file),
        specifier: FUNCTION_LENGTH,
        reason: `${span.name} spans ${span.lines} lines, past ${FUNCTION_LINE_BOUND}; split it by responsibility, or allow it with a reason`,
      });
    }
  }
  if (!files.some(([file]) => file.startsWith("packages/"))) {
    violations.push({ file: "packages", line: 0, fromPkg: "*", specifier: FUNCTION_LENGTH, reason: "no production source to scan; a scan of nothing would pass" });
  }
  if (!files.some(([file]) => file.startsWith(INTEGRATION))) {
    violations.push({ file: "packages/integration", line: 0, fromPkg: "integration", specifier: FUNCTION_LENGTH, reason: "no integration source to scan; its simulator and fixtures are held to the bound too" });
  }
  if (!files.some(([file]) => file.startsWith("scripts/"))) {
    violations.push({ file: "scripts", line: 0, fromPkg: "scripts", specifier: FUNCTION_LENGTH, reason: "no script to scan; a scan of nothing would pass" });
  }
  for (const entry of allowed) {
    if (entry.reason.trim() === "") {
      violations.push({ file: entry.file, line: 0, fromPkg: packageOf(entry.file), specifier: FUNCTION_LENGTH, reason: `the allowed function ${entry.name} states no reason; state why it keeps a long body` });
    }
    if (!used.has(entry)) {
      violations.push({ file: entry.file, line: 0, fromPkg: packageOf(entry.file), specifier: FUNCTION_LENGTH, reason: `the allowed function ${entry.name} is not past ${FUNCTION_LINE_BOUND} lines, or no longer exists; remove its entry` });
    }
  }
  return violations;
}

export function run(context: LintContext): Violation[] {
  return longFunctions(context, LONG_FUNCTIONS_ALLOWED);
}
