/**
 * Counts the lifecycle simulator runs a test file under packages/integration/src/simulator makes,
 * and names a file that makes more than its budget. Vitest runs one file's tests one after another
 * on one worker, so a file's wall time is the sum of its runs, and the full suite's wall time is at
 * least its slowest file's: a file that collects runs is the suite's critical path however many
 * workers the run has. A seeded run is a whole lifecycle under a seed's own profile, which is the
 * soak tier's job; the fast tier keeps a few representatives, so seeded runs have a budget of their own.
 * Run by check-boundaries.ts inside `just check`.
 *
 * What is counted, read from the shared program (module-program.ts): every call whose callee the
 * checker types as a run starter (RUN_STARTERS, read from the modules beside the test file that
 * export them) or as a function of the file whose body calls one, counted as the runs its body
 * makes, inside a test's callback (a callee the checker types as vitest's `it` or `test`, their
 * modifiers and `.each`), times the length of every `for...of`
 * and `.each` list around the test. A list is counted when it is an array literal, a name the
 * checker resolves, through any import, alias or re-export, to a `const` the program holds whose
 * initializer is a list it counts, that name's `.entries()`, `.keys()` or `.values()`, or the
 * global `Array.from({ length: <number> })`.
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

import path from "node:path";
import ts from "typescript";
import type { ModuleProgram } from "./module-program.js";

/** The run starters: each module beside a simulator test file that exports one, the export's name, and whether its run is seeded. */
const RUN_STARTERS: readonly { readonly module: string; readonly name: string; readonly seeded: boolean }[] = [
  { module: "simulator-harness.ts", name: "seeded", seeded: true },
  { module: "simulator-harness.ts", name: "replayed", seeded: true },
  { module: "simulator-harness.ts", name: "directed", seeded: false },
  { module: "simulator-harness.ts", name: "liveness", seeded: false },
  { module: "run.ts", name: "runSeed", seeded: false },
];

/** The vitest exports that declare a test. */
const TEST_EXPORTS = ["it", "test"];

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

const ITERATING_METHODS = new Set(["forEach", "map", "flatMap", "filter", "reduce", "some", "every", "find"]);

export interface RunBudgetFinding {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

class RunBudgetReadError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`simulator-run-budget: ${file}: ${reason}`);
    this.name = "RunBudgetReadError";
  }
}

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

/** The symbol a name's declaration has, through every import, alias and re-export of it. */
function declared(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  return checker.getAliasedSymbol(symbol);
}

/** Whether a test call's callee reads a test declarer first: `it`, `it.skip`, `it.each(list)`, `t.test.concurrent.each(list)` read off a namespace `t`. */
function readsTest(checker: ts.TypeChecker, tests: ReadonlySet<ts.Type>, expression: ts.Expression): boolean {
  const callee = unwrap(expression);
  if (tests.has(checker.getTypeAtLocation(callee))) return true;
  if (ts.isPropertyAccessExpression(callee) || ts.isCallExpression(callee)) return readsTest(checker, tests, callee.expression);
  return false;
}

/** The list of an `it.each(list)(...)` call, or null when the test call is not an `.each`. */
function eachList(call: ts.CallExpression): ts.Expression | null {
  const callee = unwrap(call.expression);
  if (!ts.isCallExpression(callee)) return null;
  const inner = unwrap(callee.expression);
  if (ts.isPropertyAccessExpression(inner) && inner.name.text === "each") return callee.arguments[0] ?? null;
  return null;
}

/**
 * What a scan reads a call by: the type of each run starter, its name and whether its run is
 * seeded, and the types of vitest's test declarers. A function's declaration has a type of its own,
 * and every name, alias, destructuring, namespace member or re-export of it has that type.
 */
interface Callees {
  readonly starters: ReadonlyMap<ts.Type, { readonly name: string; readonly seeded: boolean }>;
  readonly tests: ReadonlySet<ts.Type>;
}

class FileScan {
  private readonly findings: RunBudgetFinding[] = [];
  private readonly wrapperWeights = new Map<ts.Type, Runs | "computing">();
  private readonly wrappers = new Map<ts.Type, { readonly name: string; readonly bodies: ts.Node[] }>();

  constructor(
    private readonly source: ts.SourceFile,
    private readonly file: string,
    private readonly checker: ts.TypeChecker,
    private readonly callees: Callees,
  ) {
    this.collectWrappers(source);
  }

  private isTestCall(node: ts.Node): node is ts.CallExpression {
    if (!ts.isCallExpression(node)) return false;
    return readsTest(this.checker, this.callees.tests, node.expression) && node.arguments.some((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
  }

  private line(node: ts.Node): number {
    return this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1;
  }

  private find(node: ts.Node, reason: string): void {
    this.findings.push({ file: this.file, line: this.line(node), reason });
  }

  private collectWrappers(root: ts.Node): void {
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) this.addWrapper(node.name, node.body);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const init = unwrap(node.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) this.addWrapper(node.name, init.body);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  }

  private addWrapper(name: ts.Identifier, body: ts.Node): void {
    const type = this.checker.getTypeAtLocation(name);
    if (this.callees.starters.has(type)) return;
    const known = this.wrappers.get(type);
    if (known === undefined) this.wrappers.set(type, { name: name.text, bodies: [body] });
    else known.bodies.push(body);
  }

  /** The name a finding gives a callee of `type`: the run starter's or the wrapper's; null for any other. */
  private calleeName(type: ts.Type): string | null {
    return this.callees.starters.get(type)?.name ?? this.wrappers.get(type)?.name ?? null;
  }

  /** The runs one call of a callee of `type` makes: a run starter's one, a wrapper's its body's, or none. */
  private weight(type: ts.Type): Runs {
    const starter = this.callees.starters.get(type);
    if (starter !== undefined) return { all: 1, seeded: starter.seeded ? 1 : 0 };
    const wrapper = this.wrappers.get(type);
    if (wrapper === undefined) return { all: 0, seeded: 0 };
    const known = this.wrapperWeights.get(type);
    if (known === "computing") {
      for (const body of wrapper.bodies) this.find(body, `${wrapper.name} calls itself, so the check cannot count its runs`);
      return { all: 0, seeded: 0 };
    }
    if (known !== undefined) return known;
    this.wrapperWeights.set(type, "computing");
    const total = wrapper.bodies.map((body) => this.runsIn(body, body)).reduce(add, { all: 0, seeded: 0 });
    this.wrapperWeights.set(type, total);
    return total;
  }

  /** The runs the calls under `node` make, naming each one under a loop below `scope`: the test's callback, or the wrapper's body. */
  private runsIn(node: ts.Node, scope: ts.Node): Runs {
    let total: Runs = { all: 0, seeded: 0 };
    const visit = (child: ts.Node): void => {
      // A function the file names is counted where it is called, never where it is written.
      if (isNamedFunction(child)) return;
      if (ts.isCallExpression(child)) {
        const callee = this.checker.getTypeAtLocation(unwrap(child.expression));
        const runs = this.weight(callee);
        if (runs.all > 0) {
          total = add(total, runs);
          const loop = this.loopBetween(child, scope);
          if (loop !== null) this.find(child, `${this.calleeName(callee) ?? "a run"} runs inside a loop in one test (${loop}); give each run its own test`);
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
  private lengthOf(list: ts.Expression, depth = 0): number | null {
    if (depth > 8) return null;
    const node = unwrap(list);
    if (ts.isArrayLiteralExpression(node)) {
      let length = 0;
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = this.lengthOf(element.expression, depth + 1);
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
        return this.lengthOf(callee.expression, depth + 1);
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "from" && this.isGlobalArray(callee.expression)) {
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
    if (ts.isIdentifier(node)) return this.lengthOfName(node, depth + 1);
    return null;
  }

  /** Whether the checker resolves `expression` to the global Array. */
  private isGlobalArray(expression: ts.Expression): boolean {
    const symbol = this.checker.getSymbolAtLocation(expression);
    return symbol !== undefined && symbol === this.checker.resolveName("Array", undefined, ts.SymbolFlags.Value, false);
  }

  /**
   * The length of the list `name` stands for: the checker resolves it, through any import, alias or
   * re-export, to its declaration, which must be a `const` the program holds with a list it counts;
   * null for anything else (a `let`, a parameter, a module the program does not hold).
   */
  private lengthOfName(name: ts.Identifier, depth: number): number | null {
    const symbol = this.checker.getSymbolAtLocation(name);
    if (symbol === undefined) return null;
    const declared = (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : this.checker.getAliasedSymbol(symbol);
    const declaration = declared.valueDeclaration;
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return null;
    if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return null;
    return this.lengthOf(declaration.initializer, depth);
  }

  /** How many times the test `call` runs: the product of the lists around it and its own `.each` list. */
  private multiplicity(call: ts.CallExpression): number | null {
    let times = 1;
    const own = eachList(call);
    if (own !== null) {
      const length = this.lengthOf(own);
      if (length === null) return null;
      times *= length;
    }
    for (let node: ts.Node = call.parent; !ts.isSourceFile(node); node = node.parent) {
      if (ts.isForOfStatement(node)) {
        const length = this.lengthOf(node.expression);
        if (length === null) return null;
        times *= length;
      } else if (ts.isForInStatement(node) || ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        return null;
      } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isCallExpression(node.parent)) {
        const callee = unwrap(node.parent.expression);
        const list = ts.isPropertyAccessExpression(callee) && ITERATING_METHODS.has(callee.name.text) ? callee.expression : eachList(node.parent);
        if (list !== null) {
          const length = this.lengthOf(list);
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
      if (this.isTestCall(node)) {
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
        const starter = this.callees.starters.get(this.checker.getTypeAtLocation(unwrap(node.expression)));
        if (starter !== undefined) this.find(node, `${starter.name} runs outside any test`);
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

/**
 * The run starters and vitest's test declarers `file` may call, read from the modules that export
 * them; a scan that held none would count no run, so a missing one fails the read.
 */
function calleesOf(built: ModuleProgram, file: string, shown: string): Callees {
  const { checker } = built;
  const starters = new Map<ts.Type, { readonly name: string; readonly seeded: boolean }>();
  for (const starter of RUN_STARTERS) {
    const module = built.sourceFile(path.join(path.dirname(file), starter.module));
    const moduleSymbol = module === undefined ? undefined : checker.getSymbolAtLocation(module);
    const exported = declared(checker, moduleSymbol === undefined ? undefined : checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === starter.name));
    if (exported === undefined) throw new RunBudgetReadError(shown, `the program holds no ${starter.module} beside the file that exports the run starter ${starter.name}, so its runs cannot be counted`);
    starters.set(checker.getTypeOfSymbol(exported), { name: starter.name, seeded: starter.seeded });
  }
  const vitest = built.moduleSymbol(file, "vitest");
  const tests = new Set<ts.Type>();
  for (const name of TEST_EXPORTS) {
    const exported = declared(checker, vitest === undefined ? undefined : checker.getExportsOfModule(vitest).find((symbol) => symbol.name === name));
    if (exported === undefined) throw new RunBudgetReadError(shown, `the checker finds no vitest export ${name} from the file, so its tests cannot be read`);
    tests.add(checker.getTypeOfSymbol(exported));
  }
  return { starters, tests };
}

/** The findings of the simulator test file `file`, one of the texts `built` holds; `shown` is how a finding names it. */
export function findRunBudgetFindings(built: ModuleProgram, file: string, shown: string = file): RunBudgetFinding[] {
  const absolute = path.resolve(file);
  const source = built.sourceFile(absolute);
  if (source === undefined) throw new RunBudgetReadError(shown, "the file is none of the program's texts");
  return new FileScan(source, shown, built.checker, calleesOf(built, absolute, shown)).scan();
}
