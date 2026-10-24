/**
 * Counts the lifecycle simulator runs a test file under packages/integration/src/simulator makes,
 * and names a file that makes more than its budget. Vitest runs one file's tests one after another
 * on one worker, so a file's wall time is the sum of its runs, and the full suite's wall time is at
 * least its slowest file's: a file that collects runs is the suite's critical path however many
 * workers the run has. A seeded run is a whole lifecycle under a seed's own profile, which is the
 * soak tier's job; the fast tier keeps a few representatives, so seeded runs have a budget of their own.
 * Run by check-boundaries.ts inside `just check`.
 *
 * What is counted, parsed with the TypeScript compiler: every call of a run starter (RUN_STARTERS,
 * or a function of the file whose body calls one, counted as the runs its body makes) inside a
 * test's callback (`it`, `test`, their modifiers and `.each`), times the length of every `for...of`
 * and `.each` list around the test. A list is counted when it is an array literal, a name bound
 * to one in the file or exported by a relative module it imports, that name's `.entries()`,
 * `.keys()` or `.values()`, or `Array.from({ length: <number> })`.
 *
 * Findings, each fail-closed: a file over either budget; a loop of runs inside one test (each run
 * should be its own test, so a timeout names it and vitest can report it); a list around a test
 * the check cannot count; a run started outside any test.
 *
 * Blind spots, each a defect this check passes:
 * - A run started through a function of another module that is not a run starter.
 * - A run's cost: a liveness run takes several directed runs' time, and both count as one.
 * - Runs a test file makes through a subprocess (`scripts/simulate.ts`), as the soak test files do.
 */

import ts from "typescript";
import { importEdges } from "./import-targets.js";

/** The harness's run starters (simulator-harness.ts) and run.ts's runSeed, each with whether its run is seeded. */
const RUN_STARTERS: ReadonlyMap<string, { readonly seeded: boolean }> = new Map([
  ["seeded", { seeded: true }],
  ["replayed", { seeded: true }],
  ["directed", { seeded: false }],
  ["liveness", { seeded: false }],
  ["runSeed", { seeded: false }],
]);

/**
 * At 10 to 25 s per directed run under the full suite's load, twelve runs keep a file near the
 * suite's other slow files.
 * @testseam simulator-run-budget.test.ts plants a file at and over it
 */
export const MAX_RUNS_PER_FILE = 12;
/**
 * One seeded run per fast-tier representative, or one determinism scenario's two runs and a replay.
 * @testseam simulator-run-budget.test.ts plants a file at and over it
 */
export const MAX_SEEDED_RUNS_PER_FILE = 3;

const TEST_CALLEES = new Set(["it", "test"]);
const ITERATING_METHODS = new Set(["forEach", "map", "flatMap", "filter", "reduce", "some", "every", "find"]);

export interface RunBudgetFinding {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

/** Reads the source of the module `specifier` names from `fromFile`, or null when it is not a relative module that exists. */
export type ModuleReader = (specifier: string, fromFile: string) => string | null;

interface Runs {
  readonly all: number;
  readonly seeded: number;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  return ts.isIdentifier(callee) ? callee.text : null;
}

/** The root identifier of a test call's callee: `it`, `it.skip`, `it.each(list)`, `test.concurrent.each(list)`. */
function testRoot(expression: ts.Expression): string | null {
  const callee = unwrap(expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return testRoot(callee.expression);
  if (ts.isCallExpression(callee)) return testRoot(callee.expression);
  return null;
}

function isTestCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const root = testRoot(node.expression);
  return root !== null && TEST_CALLEES.has(root) && node.arguments.some((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
}

/** The list of an `it.each(list)(...)` call, or null when the test call is not an `.each`. */
function eachList(call: ts.CallExpression): ts.Expression | null {
  const callee = unwrap(call.expression);
  if (!ts.isCallExpression(callee)) return null;
  const inner = unwrap(callee.expression);
  if (ts.isPropertyAccessExpression(inner) && inner.name.text === "each") return callee.arguments[0] ?? null;
  return null;
}

class FileScan {
  private readonly findings: RunBudgetFinding[] = [];
  private readonly wrapperWeights = new Map<string, Runs | "computing">();
  private readonly wrapperBodies = new Map<string, ts.Node[]>();

  constructor(
    private readonly source: ts.SourceFile,
    private readonly file: string,
    private readonly readModule: ModuleReader,
  ) {
    this.collectWrappers(source);
  }

  private line(node: ts.Node): number {
    return this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1;
  }

  private find(node: ts.Node, reason: string): void {
    this.findings.push({ file: this.file, line: this.line(node), reason });
  }

  private collectWrappers(root: ts.Node): void {
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) this.addWrapper(node.name.text, node.body);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const init = unwrap(node.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) this.addWrapper(node.name.text, init.body);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  }

  private addWrapper(name: string, body: ts.Node): void {
    if (RUN_STARTERS.has(name)) return;
    const bodies = this.wrapperBodies.get(name);
    if (bodies === undefined) this.wrapperBodies.set(name, [body]);
    else bodies.push(body);
  }

  /** The runs one call of `name` makes: a run starter's one, a wrapper's its body's, or none. */
  private weight(name: string): Runs {
    const starter = RUN_STARTERS.get(name);
    if (starter !== undefined) return { all: 1, seeded: starter.seeded ? 1 : 0 };
    const bodies = this.wrapperBodies.get(name);
    if (bodies === undefined) return { all: 0, seeded: 0 };
    const known = this.wrapperWeights.get(name);
    if (known === "computing") {
      for (const body of bodies) this.find(body, `${name} calls itself, so the check cannot count its runs`);
      return { all: 0, seeded: 0 };
    }
    if (known !== undefined) return known;
    this.wrapperWeights.set(name, "computing");
    const total = bodies.map((body) => this.runsIn(body, body)).reduce(add, { all: 0, seeded: 0 });
    this.wrapperWeights.set(name, total);
    return total;
  }

  /** The runs the calls under `node` make, naming each one under a loop below `scope`: the test's callback, or the wrapper's body. */
  private runsIn(node: ts.Node, scope: ts.Node): Runs {
    let total: Runs = { all: 0, seeded: 0 };
    const visit = (child: ts.Node): void => {
      // A function the file names is counted where it is called, never where it is written.
      if (isNamedFunction(child)) return;
      if (ts.isCallExpression(child)) {
        const name = calleeName(child);
        const runs = name === null ? { all: 0, seeded: 0 } : this.weight(name);
        if (runs.all > 0) {
          total = add(total, runs);
          const loop = this.loopBetween(child, scope);
          if (loop !== null) this.find(child, `${name ?? "a run"} runs inside a loop in one test (${loop}); give each run its own test`);
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return total;
  }

  private loopBetween(call: ts.Node, scope: ts.Node): string | null {
    for (let node = call.parent; node !== scope && !ts.isSourceFile(node); node = node.parent) {
      if (ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        return node.getText(this.source).split("\n")[0] ?? "a loop";
      }
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isCallExpression(node.parent)) {
        const callee = unwrap(node.parent.expression);
        if (ts.isPropertyAccessExpression(callee) && ITERATING_METHODS.has(callee.name.text)) return `.${callee.name.text}`;
      }
    }
    return null;
  }

  /** How many entries `list` has, or null when the check cannot count them. */
  private lengthOf(list: ts.Expression, source: ts.SourceFile, file: string, depth = 0): number | null {
    if (depth > 8) return null;
    const node = unwrap(list);
    if (ts.isArrayLiteralExpression(node)) {
      let length = 0;
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = this.lengthOf(element.expression, source, file, depth + 1);
          if (spread === null) return null;
          length += spread;
        } else {
          length += 1;
        }
      }
      return length;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) && ["entries", "keys", "values"].includes(callee.name.text) && node.arguments.length === 0) {
        return this.lengthOf(callee.expression, source, file, depth + 1);
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "from" && ts.isIdentifier(callee.expression) && callee.expression.text === "Array") {
        const shape = node.arguments[0];
        if (shape !== undefined && ts.isObjectLiteralExpression(shape)) {
          for (const property of shape.properties) {
            if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "length" && ts.isNumericLiteral(property.initializer)) {
              return Number(property.initializer.text);
            }
          }
        }
      }
      return null;
    }
    if (ts.isIdentifier(node)) return this.lengthOfName(node.text, source, file, depth + 1);
    return null;
  }

  private lengthOfName(name: string, source: ts.SourceFile, file: string, depth: number): number | null {
    const initializers: ts.Expression[] = [];
    let importedFrom: string | null = null;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer !== undefined) initializers.push(node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const edge of importEdges(source.fileName, source.text)) {
      if (edge.form !== "import" || edge.target.kind !== "static" || edge.clause.kind !== "names") continue;
      if (edge.clause.names.some((entry) => entry.alias === name && entry.name === name)) importedFrom = edge.target.specifier;
    }
    const [only] = initializers;
    if (initializers.length === 1 && only !== undefined) return this.lengthOf(only, source, file, depth);
    if (initializers.length > 1 || importedFrom === null) return null;
    const text = this.readModule(importedFrom, file);
    if (text === null) return null;
    const imported = ts.createSourceFile(importedFrom, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return this.lengthOfName(name, imported, importedFrom, depth);
  }

  /** How many times the test `call` runs: the product of the lists around it and its own `.each` list. */
  private multiplicity(call: ts.CallExpression): number | null {
    let times = 1;
    const own = eachList(call);
    if (own !== null) {
      const length = this.lengthOf(own, this.source, this.file);
      if (length === null) return null;
      times *= length;
    }
    for (let node: ts.Node = call.parent; !ts.isSourceFile(node); node = node.parent) {
      if (ts.isForOfStatement(node)) {
        const length = this.lengthOf(node.expression, this.source, this.file);
        if (length === null) return null;
        times *= length;
      } else if (ts.isForInStatement(node) || ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        return null;
      } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isCallExpression(node.parent)) {
        const callee = unwrap(node.parent.expression);
        const list = ts.isPropertyAccessExpression(callee) && ITERATING_METHODS.has(callee.name.text) ? callee.expression : eachList(node.parent);
        if (list !== null) {
          const length = this.lengthOf(list, this.source, this.file);
          if (length === null) return null;
          times *= length;
        }
      }
    }
    return times;
  }

  scan(): RunBudgetFinding[] {
    let total: Runs = { all: 0, seeded: 0 };
    const visit = (node: ts.Node): void => {
      if (isTestCall(node)) {
        const callback = node.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
        const runs = callback === undefined ? { all: 0, seeded: 0 } : this.runsIn(callback, callback);
        if (runs.all > 0) {
          const times = this.multiplicity(node);
          if (times === null) this.find(node, "a list around this test that the check cannot count: name an array literal, or one exported by a relative module");
          else total = add(total, { all: runs.all * times, seeded: runs.seeded * times });
        }
        return;
      }
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name !== null && RUN_STARTERS.has(name)) this.find(node, `${name} runs outside any test`);
      }
      if (isNamedFunction(node)) return;
      ts.forEachChild(node, visit);
    };
    visit(this.source);
    if (total.all > MAX_RUNS_PER_FILE) {
      this.find(this.source, `${total.all} simulator runs in one file, more than ${MAX_RUNS_PER_FILE}: its tests run one after another on one worker, so split them across files`);
    }
    if (total.seeded > MAX_SEEDED_RUNS_PER_FILE) {
      this.find(this.source, `${total.seeded} seeded runs in one file, more than ${MAX_SEEDED_RUNS_PER_FILE}: the soak tier runs seeds; keep a fast representative here`);
    }
    return this.findings;
  }

}

/** A function declaration, or a function bound to a name: a wrapper whose runs count where it is called. */
function isNamedFunction(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node)) return true;
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) parent = parent.parent;
  return ts.isVariableDeclaration(parent);
}

function add(a: Runs, b: Runs): Runs {
  return { all: a.all + b.all, seeded: a.seeded + b.seeded };
}

/** The findings of one simulator test file's source. */
export function findRunBudgetFindings(source: string, file: string, readModule: ModuleReader): RunBudgetFinding[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return new FileScan(parsed, file, readModule).scan();
}
