/**
 * The import edges of a module, read from the one shared program (module-program.ts): its syntax
 * tree says where a module is named, its compiler says what a specifier resolves to, and its type
 * checker says which calls load a module. A comment or a string that spells an import is no edge,
 * and an import written across lines is one. An edge is:
 * - an import declaration (type-only ones included), an export-from declaration, an
 *   `import x = require(...)` and a type-position `import("...")` type;
 * - an `import(...)` call;
 * - a call or `new` whose callee the checker types as a module loader, whatever name, alias,
 *   destructuring, namespace or re-export it is reached through. The loaders are the declarations
 *   the checker finds for Node's `require` (a `createRequire(...)` result is one), its `resolve`
 *   and `module.require`, vitest's `mock`, `doMock`, `importActual` and `importMock`, `node:test`'s
 *   `mock.module`,
 *   `import.meta`'s `resolve`, `node:child_process`' `fork`, whose first parameter is the module
 *   it runs, `node:module`'s `runMain` and `register` (whose specifier names a module as this one's
 *   would only against `import.meta.url` as its parent, and is computed against any other), and the
 *   constructor of `node:worker_threads`' Worker; a `new URL("...", import.meta.url)`
 *   argument names the module by its first argument. `import.meta.glob` takes patterns, never a
 *   module's name: each pattern is an edge to every module its static prefix begins. `process.dlopen`
 *   names a native module by a path resolved against the working directory, never this module, so
 *   it is a computed edge;
 * - a call whose callee the checker types as any other function `node:child_process` exports
 *   (spawn, exec, execFile, their sync and promisified forms), reached as a loader value is: it runs
 *   a program, which may be Node loading the modules its arguments name, and which argument does is
 *   no fact of the code, so it is a computed edge of form `program`; so is `node:cluster`'s `fork`,
 *   which runs the module a settings call made anywhere before names, `node:test`'s `run`, which
 *   loads the test files its options name or it discovers, and a `fork` or Worker given an option
 *   (`execArgv`, `execPath`, `env`) that may name a module Node loads first or the program it runs.
 *
 * A loader value is one whose type is a loader or reaches one (through a property, an index
 * signature's value, a call's result or parameter, a type argument, what a promise of it awaits to) at any depth through types the
 * repository writes (its declaration files among them) or a type is written of, and within two
 * steps through the members of the lib's and node_modules' types (holdsLoader): `require`, `vi`, `import.meta`, `process` (through `mainModule`), a
 * module namespace that exports one. Such a value enters a module only through a name the checker
 * resolves to a declaration outside the repository's sources, through `import.meta`, through an
 * `import(...)` call's namespace, or through a type annotation (an `import("...")` type among
 * them); every use of it is followed from there by the checker's types and symbols across bindings,
 * imports and re-exports (followLoaders), so a call no loader value reaches is never typed.
 * Vitest's loaders are read from the vitest module itself, and a global is a loader only as a
 * declaration file declares it: a module of the program that declares such a global ambiently
 * (`declare global`) or merges a type into it, and a module that declares the name ambiently over
 * it (`declare const require`), fail the read where they declare it, since the calls through that
 * name may still load a module; so does a script that binds a loader value to a global another
 * declaration already holds, whose uses the checker binds to that declaration.
 *
 * A loader's argument that is a string literal names its module whole; a template literal names it
 * up to its first substitution; anything else is a computed edge, which a consumer holds as one
 * that may load anything. Reading a module fails with ImportReadError, never with silence, where a
 * load cannot be classified: a call through a loader value whose callee the checker types `any`
 * (`import.meta.glob` with no type that declares it), a callee read through a name its module does
 * not export where that module exports a loader value (a default import of vitest), a member the
 * checker finds no declaration for read off a loader value (a `default` off a dynamic import of
 * vitest), a require the checker types `any` of a module that exports a loader value, or of a module
 * the program does not hold whose result is used with no declared type, a member of a loader value
 * read by a computed key, a loader called as a template tag
 * or through Function's own members (`call`, `apply`, `bind`), a call or `new` of `eval`, of
 * `Function` or of anything `node:vm` exports, whichever way it is reached (an indirect
 * `(0, eval)(...)` among them), and a Worker whose options may set `eval`, each of which runs a
 * string as code that may load any module, and a loader value passed as an argument (save a
 * program runner passed to a call the checker types as returning one, as `promisify(execFile)`
 * does, which is followed through that result), put in an array or an object, returned, thrown or yielded, assigned to a property, cast
 * or given a declared type that holds no loader, or used anywhere else this reader does not follow.
 */

import path from "node:path";
import ts from "typescript";
import { checkoutProgram, programHolding, type ModuleProgram } from "./module-program.js";

/**
 * What an edge's specifier says about the module it loads: a literal names it whole, a template
 * literal names it up to its first substitution, and anything else names nothing.
 */
export type ImportTarget =
  | { readonly kind: "static"; readonly specifier: string }
  | { readonly kind: "template"; readonly prefix: string }
  | { readonly kind: "computed" };

/** The construct an edge is written as; `program` runs a program in a process of its own, which hands this module no binding. */
type EdgeForm = "import" | "export" | "import-equals" | "import-type" | "dynamic" | "require" | "loader" | "program";

/** One name of a brace clause: the name the target module exports, the name it is bound to here. */
interface ClauseName {
  readonly name: string;
  readonly alias: string;
  /** An inline `type` modifier on the entry. */
  readonly typeOnly: boolean;
  /** The 1-based line the entry is written on. */
  readonly line: number;
}

/**
 * The bindings an edge makes: `none` for a side-effect import and for a call, `names` for a brace
 * list, `whole` for a default, namespace or `export *` clause and an import-equals binding, each of
 * which names no symbol.
 */
type ImportClause = { readonly kind: "none" } | { readonly kind: "names"; readonly names: readonly ClauseName[] } | { readonly kind: "whole" };

export interface ImportEdge {
  readonly target: ImportTarget;
  readonly form: EdgeForm;
  /** The whole statement is erased at runtime: `import type`, `export type` or a type-position `import("...")`. */
  readonly typeOnly: boolean;
  readonly clause: ImportClause;
  /** The names the edge binds in the file: an import's default, namespace and brace names, an import-equals name; none for any other form. */
  readonly locals: readonly string[];
  /** The file the compiler resolves a literal specifier to; null for any other target, and for a specifier it resolves to none. */
  readonly resolved: string | null;
  /** The 1-based line the specifier starts on, the call's when it has no argument, or a program edge's callee's. */
  readonly line: number;
  /** The specifier's offsets in the text, quotes included, the call's when it has no argument, or a program edge's callee's, since its arguments name a program, not a module. */
  readonly start: number;
  readonly end: number;
}

/** An `export { ... }` list, with or without a `from` specifier. */
export interface ExportList {
  readonly line: number;
  /** null for a list of the file's own bindings. */
  readonly specifier: string | null;
  readonly typeOnly: boolean;
  readonly names: readonly ClauseName[];
}

class ImportReadError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly reason: string,
  ) {
    super(`import-targets: ${file}:${line}: ${reason}`);
    this.name = "ImportReadError";
  }
}

/** A load a module makes that cannot be classified, where it is written. */
interface ReadFailure {
  readonly start: number;
  readonly line: number;
  readonly reason: string;
}

/** The declarations, found by the checker, that make a call or a `new` load a module. */
interface Loaders {
  /** Call signatures of Node's require and of its resolve. */
  readonly require: ReadonlySet<ts.Declaration>;
  /** Call or construct signatures of every other loader that names its module. */
  readonly loader: ReadonlySet<ts.Declaration>;
  /** Call signatures of a loader that resolves its first argument against its second, a parent URL: `node:module`'s `register`. */
  readonly parented: ReadonlySet<ts.Declaration>;
  /** Call signatures of a loader that takes patterns of modules: `import.meta.glob`. */
  readonly pattern: ReadonlySet<ts.Declaration>;
  /** Call or construct signatures that run a string as code: `eval`, `Function`, every function and class `node:vm` exports. */
  readonly evaluate: ReadonlySet<ts.Declaration>;
  /** Call signatures that run a program, which may be Node itself: every function `node:child_process` exports but fork, and their promisified forms. */
  readonly program: ReadonlySet<ts.Declaration>;
  /** Construct signatures of `node:worker_threads`' Worker, which runs its first argument as code when its options set `eval`. */
  readonly worker: ReadonlySet<ts.Declaration>;
  /** Call signatures of a loader whose second argument names a native module by a path the process resolves against its working directory, never against this module: `process.dlopen`. */
  readonly native: ReadonlySet<ts.Declaration>;
  /**
   * The options, by the call or construct signature of a loader that starts Node, that may name a
   * module Node loads before the one its first argument names, or the program it runs instead:
   * `fork`'s `execArgv`, `execPath` and `env` (whose NODE_OPTIONS Node reads), a Worker's `execArgv`.
   */
  readonly startOptions: ReadonlyMap<ts.Declaration, readonly string[]>;
  /** Declarations of a global a loader is read from, made by a module of the program rather than a declaration file. */
  readonly shadows: readonly ts.Declaration[];
  /** Construct signatures of the global URL. */
  readonly url: ReadonlySet<ts.Declaration>;
  /** `import.meta`'s `url`: the parent URL against which a `parented` loader resolves its specifier as this module would. */
  readonly metaUrl: ts.Symbol | undefined;
  /** Function, CallableFunction and NewableFunction: a member declared on one calls the loader it is read off. */
  readonly functionMembers: ReadonlySet<ts.Symbol>;
}

function signatureDeclarations(checker: ts.TypeChecker, type: ts.Type, kind: ts.SignatureKind): ts.Declaration[] {
  return checker.getSignaturesOfType(type, kind).flatMap((signature) => (signature.declaration === undefined ? [] : [signature.declaration]));
}

function memberType(checker: ts.TypeChecker, type: ts.Type, name: string): ts.Type | undefined {
  const member = checker.getPropertyOfType(type, name);
  return member === undefined ? undefined : checker.getTypeOfSymbol(member);
}

/** Whether every declaration of `symbol` is in a declaration file: a global a script of the program declares under the same name is none of the loaders. */
function isDeclaredAmbiently(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations;
  return declarations !== undefined && declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

/**
 * Whether a declaration of a global states what the name is with no value of it for the flows to
 * follow: an ambient one (`declare`, `declare global`) or a type merged into the global's.
 */
function isUnfollowed(declaration: ts.Declaration): boolean {
  return isDeclaredWithDeclare(declaration) || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration);
}

/** Whether `node`, or a declaration it is written in, has the `declare` modifier. */
function isDeclaredWithDeclare(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) {
    if (ts.canHaveModifiers(at) && ts.getModifiers(at)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true) return true;
  }
  return false;
}

function findLoaders(built: ModuleProgram): Loaders {
  const checker = built.checker;
  const requires = new Set<ts.Declaration>();
  const loaders = new Set<ts.Declaration>();
  const patterns = new Set<ts.Declaration>();
  const parented = new Set<ts.Declaration>();
  const evaluators = new Set<ts.Declaration>();
  const programs = new Set<ts.Declaration>();
  const workers = new Set<ts.Declaration>();
  const natives = new Set<ts.Declaration>();
  const startOptions = new Map<ts.Declaration, readonly string[]>();
  const urls = new Set<ts.Declaration>();
  const shadows: ts.Declaration[] = [];
  const global = (name: string, meaning: ts.SymbolFlags): ts.Symbol | undefined => {
    const symbol = checker.resolveName(name, undefined, meaning, false);
    if (symbol === undefined) return undefined;
    if (isDeclaredAmbiently(symbol)) return symbol;
    // eslint-disable-next-line no-restricted-syntax -- policy default: a symbol with no declaration is declared by no module
    shadows.push(...(symbol.declarations ?? []).filter((declaration) => !declaration.getSourceFile().isDeclarationFile && isUnfollowed(declaration)));
    return undefined;
  };
  const addCalls = (into: Set<ts.Declaration>, type: ts.Type | undefined): void => {
    if (type !== undefined) for (const declaration of signatureDeclarations(checker, type, ts.SignatureKind.Call)) into.add(declaration);
  };
  const addConstructs = (into: Set<ts.Declaration>, type: ts.Type | undefined): void => {
    if (type !== undefined) for (const declaration of signatureDeclarations(checker, type, ts.SignatureKind.Construct)) into.add(declaration);
  };
  const ambientExports = (module: string): ts.Symbol[] => {
    const declared = checker.getAmbientModules().find((symbol) => symbol.name === JSON.stringify(module));
    return declared === undefined ? [] : checker.getExportsOfModule(declared);
  };
  const ambientExport = (module: string, name: string): ts.Symbol | undefined => ambientExports(module).find((symbol) => symbol.name === name);
  const requireSymbol = global("require", ts.SymbolFlags.Value);
  if (requireSymbol !== undefined) {
    const requireType = checker.getTypeOfSymbol(requireSymbol);
    addCalls(requires, requireType);
    addCalls(requires, memberType(checker, requireType, "resolve"));
  }
  const moduleSymbol = global("module", ts.SymbolFlags.Value);
  if (moduleSymbol !== undefined) addCalls(requires, memberType(checker, checker.getTypeOfSymbol(moduleSymbol), "require"));
  const hooks = ambientExport("module", "register");
  if (hooks !== undefined) addCalls(parented, checker.getTypeOfSymbol(hooks));
  const runMain = ambientExport("module", "runMain");
  if (runMain !== undefined) addCalls(loaders, checker.getTypeOfSymbol(runMain));
  const vitestModule = built.moduleSymbol(path.join(built.root, "index.ts"), "vitest");
  const exportedVi = vitestModule === undefined ? undefined : checker.getExportsOfModule(vitestModule).find((symbol) => symbol.name === "vi");
  for (const vitest of [global("vi", ts.SymbolFlags.Value), exportedVi]) {
    if (vitest === undefined) continue;
    const utils = checker.getTypeOfSymbol(vitest.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(vitest) : vitest);
    for (const method of ["mock", "doMock", "importActual", "importMock"]) addCalls(loaders, memberType(checker, utils, method));
  }
  const importMeta = global("ImportMeta", ts.SymbolFlags.Type);
  const metaUrl = importMeta === undefined ? undefined : checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(importMeta), "url");
  if (importMeta !== undefined) {
    const meta = checker.getDeclaredTypeOfSymbol(importMeta);
    addCalls(loaders, memberType(checker, meta, "resolve"));
    addCalls(patterns, memberType(checker, meta, "glob"));
  }
  const worker = ambientExport("worker_threads", "Worker");
  if (worker !== undefined) {
    addConstructs(loaders, checker.getTypeOfSymbol(worker));
    addConstructs(workers, checker.getTypeOfSymbol(worker));
    for (const declaration of signatureDeclarations(checker, checker.getTypeOfSymbol(worker), ts.SignatureKind.Construct)) startOptions.set(declaration, ["execArgv"]);
  }
  const fork = ambientExport("child_process", "fork");
  if (fork !== undefined) {
    addCalls(loaders, checker.getTypeOfSymbol(fork));
    for (const declaration of signatureDeclarations(checker, checker.getTypeOfSymbol(fork), ts.SignatureKind.Call)) startOptions.set(declaration, ["execArgv", "execPath", "env"]);
  }
  const testMock = ambientExport("node:test", "mock");
  if (testMock !== undefined) addCalls(loaders, memberType(checker, checker.getTypeOfSymbol(testMock), "module"));
  const testRun = ambientExport("node:test", "run");
  if (testRun !== undefined) addCalls(programs, checker.getTypeOfSymbol(testRun));
  const processSymbol = global("process", ts.SymbolFlags.Value);
  if (processSymbol !== undefined) addCalls(natives, memberType(checker, checker.getTypeOfSymbol(processSymbol), "dlopen"));
  const cluster = ambientExport("cluster", "default");
  if (cluster !== undefined) addCalls(programs, memberType(checker, checker.getTypeOfSymbol(cluster), "fork"));
  for (const exported of ambientExports("child_process")) {
    if ((exported.flags & ts.SymbolFlags.Value) === 0 || exported === fork) continue;
    const runner = checker.getTypeOfSymbol(exported);
    if (checker.getSignaturesOfType(runner, ts.SignatureKind.Call).length === 0) continue;
    addCalls(programs, runner);
    for (const member of checker.getPropertiesOfType(runner)) addCalls(programs, checker.getTypeOfSymbol(member));
  }
  for (const exported of ambientExports("vm")) {
    if ((exported.flags & ts.SymbolFlags.Value) === 0) continue;
    addCalls(evaluators, checker.getTypeOfSymbol(exported));
    addConstructs(evaluators, checker.getTypeOfSymbol(exported));
  }
  const url = global("URL", ts.SymbolFlags.Value);
  if (url !== undefined) addConstructs(urls, checker.getTypeOfSymbol(url));
  const evaluate = global("eval", ts.SymbolFlags.Value);
  if (evaluate !== undefined) addCalls(evaluators, checker.getTypeOfSymbol(evaluate));
  const functionConstructor = global("Function", ts.SymbolFlags.Value);
  if (functionConstructor !== undefined) {
    addCalls(evaluators, checker.getTypeOfSymbol(functionConstructor));
    addConstructs(evaluators, checker.getTypeOfSymbol(functionConstructor));
  }
  const functionMembers = new Set<ts.Symbol>();
  for (const name of ["Function", "CallableFunction", "NewableFunction"]) {
    const symbol = global(name, ts.SymbolFlags.Type);
    if (symbol !== undefined) functionMembers.add(symbol);
  }
  return { require: requires, loader: loaders, parented, pattern: patterns, evaluate: evaluators, program: programs, worker: workers, native: natives, startOptions, url: urls, metaUrl, functionMembers, shadows };
}

/** One module's loader edges and the loads it cannot classify, as the program's flows found them. */
interface ModuleLoads {
  readonly edges: ImportEdge[];
  readonly failures: ReadFailure[];
}

/** What a guard reads once per program: its loaders, which types hold one, and each module's loads. */
interface ProgramReading {
  readonly loaders: Loaders;
  readonly program: ts.Program;
  readonly held: Map<ts.Type, Map<number, boolean>>;
  readonly loads: ReadonlyMap<string, ModuleLoads>;
  readonly edges: Map<string, readonly ImportEdge[] | ReadFailure>;
}

const readings = new WeakMap<ModuleProgram, ProgramReading>();

function readingOf(built: ModuleProgram): ProgramReading {
  let reading = readings.get(built);
  if (reading === undefined) {
    const partial = { loaders: findLoaders(built), program: built.program, held: new Map<ts.Type, Map<number, boolean>>() };
    reading = { ...partial, loads: followLoaders(built, partial), edges: new Map() };
    readings.set(built, reading);
  }
  return reading;
}

function constituents(type: ts.Type): readonly ts.Type[] {
  return type.isUnionOrIntersection() ? type.types.flatMap(constituents) : [type];
}

/** How a call of a loader names what it loads: a module by its first argument (`require`, `loader`, or `parented`, resolved against its second), patterns of modules, code run from a string, or a program run. */
type LoaderForm = "require" | "loader" | "parented" | "pattern" | "native" | "evaluate" | "program";

/** How a callee of `type` loads a module when called (`kind` Call) or constructed (`kind` Construct); null when it loads none. */
function loaderForm(checker: ts.TypeChecker, loaders: Loaders, type: ts.Type, kind: ts.SignatureKind): LoaderForm | null {
  for (const part of constituents(type)) {
    for (const declaration of signatureDeclarations(checker, part, kind)) {
      if (loaders.require.has(declaration)) return "require";
      if (loaders.loader.has(declaration)) return "loader";
      if (loaders.parented.has(declaration)) return "parented";
      if (loaders.pattern.has(declaration)) return "pattern";
      if (loaders.native.has(declaration)) return "native";
      if (loaders.evaluate.has(declaration)) return "evaluate";
      if (loaders.program.has(declaration)) return "program";
    }
  }
  return null;
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return "objectFlags" in type && typeof type.objectFlags === "number" && (type.objectFlags & ts.ObjectFlags.Reference) !== 0;
}

type Held = Pick<ProgramReading, "loaders" | "program" | "held">;

/**
 * The types a value of `part` reaches in one step: `subterms` are the types it is written of (a
 * type argument, what a promise of it awaits to), and `members` the types the checker instantiates
 * for it (a property, an index signature's value, a call's or construct's result or parameter).
 */
function reachedTypes(checker: ts.TypeChecker, part: ts.Type): { readonly subterms: readonly ts.Type[]; readonly members: () => readonly ts.Type[] } {
  const subterms = isTypeReference(part) ? [...checker.getTypeArguments(part)] : [];
  const awaited = checker.getAwaitedType(part);
  if (awaited !== undefined && awaited !== part) subterms.push(awaited);
  const members = (): ts.Type[] => {
    const signatures = [...checker.getSignaturesOfType(part, ts.SignatureKind.Call), ...checker.getSignaturesOfType(part, ts.SignatureKind.Construct)];
    const reached = signatures.flatMap((signature) => [checker.getReturnTypeOfSignature(signature), ...signature.getParameters().map((parameter) => checker.getTypeOfSymbol(parameter))]);
    for (const property of checker.getPropertiesOfType(part)) reached.push(checker.getTypeOfSymbol(property));
    for (const index of checker.getIndexInfosOfType(part)) reached.push(index.type);
    return reached;
  };
  return { subterms, members };
}

function isLoaderType(checker: ts.TypeChecker, loaders: Loaders, part: ts.Type): boolean {
  return loaderForm(checker, loaders, part, ts.SignatureKind.Call) !== null || loaderForm(checker, loaders, part, ts.SignatureKind.Construct) !== null;
}

/**
 * The steps a walk takes through the members of the lib's and node_modules' types (Node's,
 * vitest's) within which a value that reaches a loader holds one: those types never change, and every loader
 * they hold lies within this many steps of the value that holds it, while walking them without a
 * bound instantiates their generics without end.
 */
const DECLARED_STEPS = 2;

/** How many instantiations of one declaration a walk nests before it reads the next as the outermost again, so a recursive generic the repository writes stays finite. */
const NESTED_INSTANTIATIONS = 3;

/**
 * Whether `type` is declared in a file the repository writes, a declaration file among them, not the
 * lib's or node_modules': a walk out of it takes no step, since a loader may lie at any depth in it.
 * A type with no declaration (a tuple, a primitive) is none.
 */
function isWrittenHere(program: ts.Program, type: ts.Type): boolean {
  const declared = type.aliasSymbol ?? type.getSymbol();
  const declarations = declared?.declarations;
  if (declarations === undefined || declarations.length === 0) return false;
  return declarations.some((declaration) => {
    const source = declaration.getSourceFile();
    return !program.isSourceFileFromExternalLibrary(source) && !program.isSourceFileDefaultLibrary(source);
  });
}

/** One node of a holdsLoader walk: a type, and the steps left to take out of types the repository does not write. */
interface HeldNode {
  readonly type: ts.Type;
  readonly steps: number;
}

/**
 * Whether a value of `type` is a loader or reaches one, through properties, calls' results and
 * parameters, type arguments and awaited types: at any depth through the types a type is written
 * of and through the members of types the repository writes, and within DECLARED_STEPS steps
 * through the members of types it does not. The types reached form a graph with
 * cycles, so it is walked once by strongly connected components: a component none of whose nodes
 * reaches a loader holds none, and every node on the walk's stack when a loader is found reaches it.
 */
function holdsLoader(checker: ts.TypeChecker, reading: Held, type: ts.Type): boolean {
  const settledAt = (node: HeldNode): boolean | undefined => reading.held.get(node.type)?.get(node.steps);
  const settle = (node: HeldNode, holds: boolean): void => {
    let bySteps = reading.held.get(node.type);
    if (bySteps === undefined) {
      bySteps = new Map();
      reading.held.set(node.type, bySteps);
    }
    bySteps.set(node.steps, holds);
  };
  const root: HeldNode = { type, steps: DECLARED_STEPS };
  const known = settledAt(root);
  if (known !== undefined) return known;
  const order = new Map<ts.Type, Map<number, number>>();
  const stack: HeldNode[] = [];
  const nesting = new Map<ts.Symbol, number[]>();
  let entered = 0;
  const visit = (at: HeldNode): number | "holds" => {
    const settled = settledAt(at);
    if (settled === true) return "holds";
    if (settled === false) return Number.POSITIVE_INFINITY;
    const seen = order.get(at.type)?.get(at.steps);
    if (seen !== undefined) return seen;
    const declared = at.type.aliasSymbol ?? at.type.getSymbol();
    // eslint-disable-next-line no-restricted-syntax -- policy default: a declaration the walk has not entered nests no instantiation
    const enclosing = declared === undefined ? [] : (nesting.get(declared) ?? []);
    if (enclosing.length >= NESTED_INSTANTIATIONS) return enclosing[0];
    const own = entered++;
    let bySteps = order.get(at.type);
    if (bySteps === undefined) {
      bySteps = new Map();
      order.set(at.type, bySteps);
    }
    bySteps.set(at.steps, own);
    stack.push(at);
    if (declared !== undefined) nesting.set(declared, [...enclosing, own]);
    let low = own;
    const memberSteps = isWrittenHere(reading.program, at.type) ? at.steps : at.steps - 1;
    for (const part of constituents(at.type)) {
      if (isLoaderType(checker, reading.loaders, part)) return "holds";
      const { subterms, members } = reachedTypes(checker, part);
      const next = [...subterms.map((inner) => ({ type: inner, steps: at.steps })), ...(memberSteps < 0 ? [] : members().map((inner) => ({ type: inner, steps: memberSteps })))];
      for (const inner of next) {
        const reached = visit(inner);
        if (reached === "holds") return "holds";
        low = Math.min(low, reached);
      }
    }
    if (declared !== undefined) nesting.set(declared, enclosing);
    if (low === own) {
      for (let popped = stack.pop(); popped !== undefined; popped = popped === at ? undefined : stack.pop()) settle(popped, false);
    }
    return low;
  };
  const holds = visit(root) === "holds";
  if (holds) for (const pending of stack) settle(pending, true);
  return holds;
}

function isAnyTyped(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0;
}

/** The name an expression is read through first: `a` of `a.b(c).d`. */
function rootName(expression: ts.Expression): ts.Identifier | null {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression) || ts.isCallExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) return rootName(expression.expression);
  return null;
}

/** The module specifier of the import or export-from declaration `node` is written in; undefined when it is in neither. */
function aliasSpecifier(node: ts.Node | undefined): ts.Expression | undefined {
  for (let at = node; at !== undefined; at = at.parent) {
    if (ts.isImportDeclaration(at) || ts.isExportDeclaration(at)) return at.moduleSpecifier;
  }
  return undefined;
}

/**
 * The module an imported name `expression` is read through should export it from, when that module
 * does not (a default import of a module with none), followed through each import and re-export of
 * the name to the one whose module lacks it; null when the name resolves, or is no import.
 */
function moduleLackingName(checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol | null {
  const root = rootName(expression);
  let symbol = root === null ? undefined : checker.getSymbolAtLocation(root);
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0 || checker.getAliasedSymbol(symbol).declarations !== undefined) return null;
  for (let next = checker.getImmediateAliasedSymbol(symbol); next?.declarations !== undefined && (next.flags & ts.SymbolFlags.Alias) !== 0; next = checker.getImmediateAliasedSymbol(next)) symbol = next;
  const specifier = aliasSpecifier(symbol.declarations?.at(0));
  return specifier === undefined ? null : (checker.getSymbolAtLocation(specifier) ?? null);
}

/** Whether `symbol` is a member Function, CallableFunction or NewableFunction declares. */
function isFunctionMember(checker: ts.TypeChecker, loaders: Loaders, symbol: ts.Symbol | undefined): boolean {
  // eslint-disable-next-line no-restricted-syntax -- policy default: a member with no declaration is declared on no interface
  return (symbol?.declarations ?? []).some((declaration) => {
    const owner = declaration.parent;
    if (!ts.isInterfaceDeclaration(owner)) return false;
    const ownerSymbol = checker.getSymbolAtLocation(owner.name);
    return ownerSymbol !== undefined && loaders.functionMembers.has(ownerSymbol);
  });
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

const PASSES_THROUGH = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken]);

/** A name the checker resolves as a reference to a symbol, not a member, property or label name spelled alike. */
function isReferenceName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  if (ts.isBindingElement(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return parent.propertyName !== node;
  const named = ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent);
  if (named) return parent.name !== node;
  return !(ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent));
}

/** Whether `node`, a name or a qualified name's part, is written where a type is, not a value. */
function isTypePosition(node: ts.Node): boolean {
  let at = node;
  while (ts.isQualifiedName(at.parent) || (ts.isPropertyAccessExpression(at.parent) && ts.isExpressionWithTypeArguments(at.parent.parent))) at = at.parent;
  const parent = at.parent;
  if (ts.isExpressionWithTypeArguments(parent)) return !(ts.isHeritageClause(parent.parent) && parent.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(parent.parent.parent));
  return ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent);
}

/**
 * Every module's loader edges and unclassified loads, followed from the program's loaders. A value
 * that holds a loader is reached only from a name the checker resolves to an external declaration
 * whose type holds one (Node's require, vitest's vi, a module namespace that exports one), from
 * `import.meta`, or from a type that holds one written in an annotation; from there each use is
 * followed by the checker's types, never by a name: a call of it is an edge, a binding or an
 * import of it is followed to every reference of the bound symbol, and a use that hands it to code
 * this reader does not follow is a failure.
 */
class LoaderFlows {
  readonly loads: Map<string, ModuleLoads>;
  private readonly checker: ts.TypeChecker;
  private readonly references = new Map<ts.Symbol, ts.Node[]>();
  private readonly metas: ts.Expression[] = [];
  private readonly dynamicImports: ts.CallExpression[] = [];
  private readonly importTypes: ts.ImportTypeNode[] = [];
  private readonly roots = new Set<ts.Symbol>();
  private readonly queue: ts.Symbol[] = [];

  constructor(
    private readonly built: ModuleProgram,
    private readonly reading: Held,
  ) {
    const { program } = built;
    this.checker = built.checker;
    const modules = program.getSourceFiles().filter((source) => !source.isDeclarationFile && !program.isSourceFileFromExternalLibrary(source));
    this.loads = new Map(modules.map((source): [string, ModuleLoads] => [source.fileName, { edges: [], failures: [] }]));
    for (const source of modules) this.index(source);
    for (const declaration of reading.loaders.shadows) this.fail(declaration, "a module of the program declares a global a module loader is read from, so the checker no longer finds that loader and the calls through it cannot be read; declare it in a declaration file, or not at all");
  }

  /** Follows every loader value from where it enters the program, and returns each module's loads. */
  run(): Map<string, ModuleLoads> {
    for (const [symbol] of this.references) {
      // eslint-disable-next-line no-restricted-syntax -- policy default: a symbol the checker makes with no declaration (globalThis) is declared by no module of the repository
      const external = (symbol.declarations ?? []).every((declaration) => declaration.getSourceFile().isDeclarationFile);
      if (external && this.symbolHolds(symbol)) this.enqueue(symbol);
    }
    for (const meta of this.metas) this.flow(meta);
    for (const call of this.dynamicImports) this.flow(call);
    for (const node of this.importTypes) if (this.holds(this.typeAt(node))) this.typed(node);
    for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
      // eslint-disable-next-line no-restricted-syntax -- policy default: a symbol no module of the program names has no reference to follow
      for (const reference of this.references.get(next) ?? []) this.referenced(reference);
    }
    return this.loads;
  }

  private holds(type: ts.Type): boolean {
    return holdsLoader(this.checker, this.reading, type);
  }

  private typeAt(node: ts.Node): ts.Type {
    return this.checker.getTypeAtLocation(node);
  }

  private fail(node: ts.Node, reason: string): void {
    const source = node.getSourceFile();
    const start = node.getStart(source);
    this.loads.get(source.fileName)?.failures.push({ start, line: source.getLineAndCharacterOfPosition(start).line + 1, reason });
  }

  /** The symbol an import or a re-export names, or `symbol` itself. */
  private target(symbol: ts.Symbol): ts.Symbol {
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    const aliased = this.checker.getAliasedSymbol(symbol);
    return aliased.declarations === undefined ? symbol : aliased;
  }

  /** Records every reference of `source` by the symbol the checker resolves it to, every `import.meta`, and every callee read through a name its module lacks. */
  private index(source: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) this.metas.push(node);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) this.dynamicImports.push(node);
      if (ts.isImportTypeNode(node)) this.importTypes.push(node);
      if (ts.isIdentifier(node) && isReferenceName(node)) {
        const parent = node.parent;
        const symbol = ts.isShorthandPropertyAssignment(parent) && parent.name === node ? this.checker.getShorthandAssignmentValueSymbol(parent) : this.checker.getSymbolAtLocation(node);
        if (symbol !== undefined) {
          const resolved = this.target(symbol);
          const known = this.references.get(resolved);
          if (known === undefined) this.references.set(resolved, [node]);
          else known.push(node);
        }
      }
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression.kind !== ts.SyntaxKind.ImportKeyword) this.lackedCallee(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (ts.isExternalModule(source)) for (const statement of source.statements) this.ambientShadow(statement);
  }

  /**
   * A statement of a module that declares a name ambiently (`declare const require`) where the
   * checker finds a global of that name that holds a module loader: the declaration hides the loader
   * from the checker, while at runtime the name may still be that loader.
   */
  private ambientShadow(statement: ts.Statement): void {
    if (!isDeclaredWithDeclare(statement)) return;
    const names: ts.Identifier[] = [];
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.push(declaration.name);
    const augmentsGlobal = (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && !augmentsGlobal && statement.name !== undefined && ts.isIdentifier(statement.name)) names.push(statement.name);
    for (const name of names) {
      const shadowed = this.checker.resolveName(name.text, undefined, ts.SymbolFlags.Value, false);
      if (shadowed !== undefined && isDeclaredAmbiently(shadowed) && this.symbolHolds(shadowed)) {
        this.fail(name, `the module declares \`${name.text}\` ambiently over the global of that name, which holds a module loader, so the calls through it cannot be read; import what it stands for instead`);
      }
    }
  }

  /**
   * A call whose callee the checker types `any` because it is read through a name its module does
   * not export, where that module exports a loader value: the name may stand for one of them.
   */
  private lackedCallee(call: ts.CallExpression | ts.NewExpression): void {
    const lacking = moduleLackingName(this.checker, call.expression);
    if (lacking === null || !isAnyTyped(this.typeAt(call.expression)) || !this.holds(this.checker.getTypeOfSymbol(lacking))) return;
    this.fail(call, "the checker types this callee `any`, read through a name its module does not export while that module exports a module loader, so whether the call loads a module cannot be read");
  }

  /**
   * A call that runs a program: the program may be Node, whose arguments then name the modules it
   * loads, and which of them do is no fact of the code, so the call is a computed edge, one a
   * consumer holds as loading anything.
   */
  private programRun(call: ts.CallExpression | ts.NewExpression): void {
    const source = call.getSourceFile();
    const spec = call.expression;
    const start = spec.getStart(source);
    this.loads.get(source.fileName)?.edges.push({ target: { kind: "computed" }, form: "program", typeOnly: false, clause: { kind: "none" }, locals: [], resolved: null, line: source.getLineAndCharacterOfPosition(start).line + 1, start, end: spec.getEnd() });
  }

  /**
   * Whether a `new` of a Worker may run its first argument as code: its options' `eval` is typed
   * other than `false` or absent, or the checker types the options `any`.
   */
  private runsAsCode(call: ts.CallExpression | ts.NewExpression, calleeType: ts.Type): boolean {
    if (!ts.isNewExpression(call) || !signatureDeclarations(this.checker, calleeType, ts.SignatureKind.Construct).some((declaration) => this.reading.loaders.worker.has(declaration))) return false;
    const options = call.arguments?.at(1);
    if (options === undefined) return false;
    const optionsType = this.typeAt(options);
    if (isAnyTyped(optionsType)) return true;
    const off = [this.checker.getFalseType(), this.checker.getUndefinedType()];
    return constituents(this.checker.getNonNullableType(optionsType)).some((part) => {
      const evaluates = this.checker.getPropertyOfType(part, "eval");
      return evaluates !== undefined && !constituents(this.checker.getTypeOfSymbol(evaluates)).every((value) => off.includes(value));
    });
  }

  /**
   * Whether a call or `new` of a loader that starts Node (fork, a Worker) passes an option that may
   * name a module Node loads first or the program it runs instead: one of its start options typed
   * other than absent, or an argument after the first the checker types `any`.
   */
  private startsNodeWith(call: ts.CallExpression | ts.NewExpression, calleeType: ts.Type): boolean {
    const kind = ts.isNewExpression(call) ? ts.SignatureKind.Construct : ts.SignatureKind.Call;
    // eslint-disable-next-line no-restricted-syntax -- policy default: a signature with no start options starts no Node with any
    const names = new Set(signatureDeclarations(this.checker, calleeType, kind).flatMap((declaration) => this.reading.loaders.startOptions.get(declaration) ?? []));
    if (names.size === 0) return false;
    const absent = this.checker.getUndefinedType();
    // eslint-disable-next-line no-restricted-syntax -- policy default: a `new` with no argument list passes no options
    return (call.arguments ?? []).slice(1).some((argument) => {
      const argumentType = this.typeAt(argument);
      if (isAnyTyped(argumentType)) return true;
      return constituents(this.checker.getNonNullableType(argumentType)).some((part) =>
        [...names].some((name) => {
          const option = this.checker.getPropertyOfType(part, name);
          return option !== undefined && !constituents(this.checker.getTypeOfSymbol(option)).every((value) => value === absent);
        }),
      );
    });
  }

  private enqueue(symbol: ts.Symbol | undefined): void {
    if (symbol === undefined) return;
    const resolved = this.target(symbol);
    if (this.roots.has(resolved)) return;
    this.roots.add(resolved);
    this.queue.push(resolved);
  }

  private symbolHolds(symbol: ts.Symbol): boolean {
    const valueHolds = (symbol.flags & ts.SymbolFlags.Value) !== 0 && this.holds(this.checker.getTypeOfSymbol(symbol));
    return valueHolds || ((symbol.flags & ts.SymbolFlags.Type) !== 0 && this.holds(this.checker.getDeclaredTypeOfSymbol(symbol)));
  }

  /**
   * Follows each name `name` binds whose type holds a loader. A script's top-level binding is a
   * global, and where another declaration of the program already holds that global's name (a lib's
   * `open`) the checker binds the binding's uses to that one, so they cannot be followed.
   */
  private bind(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) {
      const symbol = this.checker.getSymbolAtLocation(name);
      if (symbol === undefined || !this.symbolHolds(symbol)) return;
      if (isScriptGlobal(name) && this.checker.resolveName(name.text, undefined, ts.SymbolFlags.Value, false) !== symbol) {
        this.fail(name, `the script binds a module loader (or a value that holds one) to the global \`${name.text}\`, which another declaration of the program already holds, so the checker binds its uses to that one and the calls through it cannot be read; make the file a module`);
        return;
      }
      this.enqueue(symbol);
      return;
    }
    for (const element of name.elements) if (!ts.isOmittedExpression(element)) this.bind(element.name);
  }

  /**
   * The edge a loader call makes to what its first argument names, or one per pattern of a pattern
   * loader's. A parented loader's specifier names a module as this one's would only when its parent
   * URL is this module's own `import.meta.url`; against any other parent it is a computed edge.
   */
  private addEdges(call: ts.CallExpression | ts.NewExpression, form: "require" | "loader" | "parented" | "pattern" | "native"): void {
    const first = call.arguments?.at(0);
    const source = call.getSourceFile();
    const push = (spec: ts.Node, target: ImportTarget): void => {
      const start = spec.getStart(source);
      const resolved = target.kind === "static" ? this.built.resolvedModule(source.fileName, target.specifier) : null;
      this.loads.get(source.fileName)?.edges.push({ target, form: form === "require" ? "require" : "loader", typeOnly: false, clause: { kind: "none" }, locals: [], resolved, line: source.getLineAndCharacterOfPosition(start).line + 1, start, end: spec.getEnd() });
    };
    if (form === "pattern") {
      for (const [spec, target] of patternTargets(first)) push(spec ?? call, target);
      return;
    }
    if (form === "native") {
      push(call.arguments?.at(1) ?? call, { kind: "computed" });
      return;
    }
    let found: ImportTarget = form === "parented" && !this.isOwnUrl(call.arguments?.at(1)) ? { kind: "computed" } : targetOf(first);
    if (form !== "parented" && first !== undefined && ts.isNewExpression(first)) {
      const urlType = this.typeAt(first.expression);
      if (signatureDeclarations(this.checker, urlType, ts.SignatureKind.Construct).some((declaration) => this.reading.loaders.url.has(declaration))) found = targetOf(first.arguments?.at(0));
    }
    push(first ?? call, found);
  }

  /** Whether `argument` is `import.meta.url` read in place. */
  private isOwnUrl(argument: ts.Expression | undefined): boolean {
    const metaUrl = this.reading.loaders.metaUrl;
    if (argument === undefined || metaUrl === undefined || !ts.isPropertyAccessExpression(argument) || !ts.isMetaProperty(argument.expression)) return false;
    return this.checker.getSymbolAtLocation(argument.name) === metaUrl;
  }

  /** A call or `new` of `callee`, a loader value or a member read off one. */
  private called(call: ts.CallExpression | ts.NewExpression, callee: ts.Expression): void {
    const calleeType = this.typeAt(callee);
    if (isAnyTyped(calleeType)) {
      this.fail(call, "the checker types this callee, read off a module loader, `any`, so whether the call loads a module cannot be read; give the callee a type");
      return;
    }
    const kind = ts.isNewExpression(call) ? ts.SignatureKind.Construct : ts.SignatureKind.Call;
    const form = loaderForm(this.checker, this.reading.loaders, calleeType, kind);
    if (form === "evaluate" || (form === "loader" && this.runsAsCode(call, calleeType))) {
      this.fail(call, "this call runs a string as code (eval, Function, node:vm, a Worker with `eval`), and that code may load any module, so what it loads cannot be read");
      return;
    }
    if (form === "program") this.programRun(call);
    else if (form !== null) this.addEdges(call, form);
    if (form === "loader" && this.startsNodeWith(call, calleeType)) this.programRun(call);
    if (form === "require" && isAnyTyped(this.typeAt(call))) this.untypedRequire(call);
    // eslint-disable-next-line no-restricted-syntax -- policy default: a `new` with no argument list passes no callback
    for (const argument of call.arguments ?? []) {
      if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) for (const parameter of argument.parameters) this.bind(parameter.name);
    }
    this.flow(call);
  }

  /**
   * A require whose result the checker types `any`: what it loads is read from the module it names,
   * so the read fails where that module exports a loader value, or where the result is used untyped
   * and the module is none the program holds.
   */
  private untypedRequire(call: ts.CallExpression | ts.NewExpression): void {
    const target = targetOf(call.arguments?.at(0));
    if (target.kind !== "static") return;
    const moduleSymbol = this.built.moduleSymbol(call.getSourceFile().fileName, target.specifier);
    if (moduleSymbol !== undefined) {
      if (this.holds(this.checker.getTypeOfSymbol(moduleSymbol))) this.fail(call, "a require of a module that exports a module loader returns a value the checker types `any`, so the calls made through it cannot be read; import the module instead");
      return;
    }
    const declared = ts.isVariableDeclaration(call.parent) && call.parent.initializer === call && call.parent.type !== undefined;
    if (!declared && !ts.isExpressionStatement(call.parent)) this.fail(call, "a require of a module the program does not hold returns a value the checker types `any`, so whether it hands on a module loader cannot be read; give the result a declared type");
  }

  /** A member read off a loader value. */
  private member(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): void {
    const receiver = this.typeAt(access.expression);
    const loaders = this.reading.loaders;
    const isLoader = loaderForm(this.checker, loaders, receiver, ts.SignatureKind.Call) !== null || loaderForm(this.checker, loaders, receiver, ts.SignatureKind.Construct) !== null;
    const computed = ts.isElementAccessExpression(access) && !ts.isStringLiteralLike(access.argumentExpression);
    if (computed && (isLoader || isAnyTyped(this.typeAt(access)))) {
      this.fail(access, "a member of a module loader, or of a value that holds one, is read by a computed key, so what it loads cannot be read");
      return;
    }
    let symbol: ts.Symbol | undefined;
    if (ts.isPropertyAccessExpression(access)) symbol = this.checker.getSymbolAtLocation(access.name);
    else if (ts.isStringLiteralLike(access.argumentExpression)) symbol = this.checker.getPropertyOfType(receiver, access.argumentExpression.text);
    if (isLoader && isFunctionMember(this.checker, loaders, symbol)) {
      this.fail(access, "a module loader is called through Function's own members, so the module it loads cannot be read; call it directly");
      return;
    }
    if (symbol === undefined && !isAnyTyped(receiver) && isAnyTyped(this.typeAt(access))) {
      this.fail(access, "a member the checker finds no declaration for is read off a value that holds a module loader, so the checker types it `any` and what it loads cannot be read");
      return;
    }
    const parent = access.parent;
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === access) this.called(parent, access);
    else this.flow(access);
  }

  /** Follows `node`, an expression whose value may hold a loader, to where its value goes. */
  private flow(node: ts.Expression): void {
    if (!this.holds(this.typeAt(node))) return;
    const parent = node.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAwaitExpression(parent) || ts.isSatisfiesExpression(parent)) this.flow(parent);
    else if (ts.isConditionalExpression(parent)) {
      if (parent.condition !== node) this.flow(parent);
    } else if (ts.isBinaryExpression(parent)) this.operand(parent, node);
    else if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) {
      if (this.holds(this.typeAt(parent))) this.flow(parent);
      else this.fail(node, "a module loader (or a value that holds one) is cast to a type that holds no loader, so the calls made through it cannot be read");
    } else if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      if (parent.expression === node) this.called(parent, node);
      else if (this.isWrappedRunner(parent, node)) this.flow(parent);
      else this.fail(node, "a module loader (or a value that holds one) is passed as an argument, so the modules the callee loads through it cannot be read; call it where it is");
    } else if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) {
      this.fail(node, "a module loader (or a value that holds one) is called as a template tag, so the module it loads cannot be read; call it with a literal");
    } else if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) this.member(parent);
    else this.bound(parent, node);
  }

  /**
   * Whether `node`, an argument of `call`, is a function that runs a program, and the checker types
   * what `call` returns as one too (`promisify(execFile)`): the calls that run a program are then
   * those of the result, followed from there.
   */
  private isWrappedRunner(call: ts.CallExpression | ts.NewExpression, node: ts.Expression): boolean {
    const runs = (type: ts.Type): boolean => loaderForm(this.checker, this.reading.loaders, type, ts.SignatureKind.Call) === "program";
    return ts.isCallExpression(call) && runs(this.typeAt(node)) && runs(this.typeAt(call));
  }

  /** `node`, a loader value, as an operand of `parent`: passed through a logical operator, assigned, or only read. */
  private operand(parent: ts.BinaryExpression, node: ts.Expression): void {
    const operator = parent.operatorToken.kind;
    if (PASSES_THROUGH.has(operator) && (operator !== ts.SyntaxKind.CommaToken || parent.right === node)) this.flow(parent);
    else if (isAssignment(operator) && parent.right === node) {
      if (ts.isIdentifier(parent.left) && this.holds(this.typeAt(parent.left))) this.enqueue(this.checker.getSymbolAtLocation(parent.left));
      else this.fail(node, "a module loader (or a value that holds one) is assigned where this reader cannot follow it: to a property, or to a name whose type holds no loader");
    }
  }

  /** `node`, a loader value, where `parent` binds it, exports it, hands it on, or only reads it. */
  private bound(parent: ts.Node, node: ts.Expression): void {
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.initializer === node) {
      const declared = !ts.isBindingElement(parent) && parent.type !== undefined;
      if (declared && !this.holds(this.typeAt(parent.name))) this.fail(node, "a module loader (or a value that holds one) is given a declared type that holds no loader, so the calls made through it cannot be read");
      else this.bind(parent.name);
    } else if (ts.isForOfStatement(parent) && parent.expression === node) {
      if (ts.isVariableDeclarationList(parent.initializer)) for (const declaration of parent.initializer.declarations) this.bind(declaration.name);
      else this.fail(node, "a module loader (or a value that holds one) is iterated into a target this reader cannot follow");
    } else if (ts.isExportAssignment(parent)) {
      const moduleSymbol = this.checker.getSymbolAtLocation(parent.getSourceFile());
      this.enqueue(moduleSymbol === undefined ? undefined : this.checker.getExportsOfModule(moduleSymbol).find((exported) => exported.escapedName === "default"));
    } else if (isEscape(parent, node)) {
      this.fail(node, "a module loader (or a value that holds one) is handed to code this reader does not follow: put in an array or an object, returned, thrown or yielded; call it where it is");
    } else if (!isInert(parent, node)) {
      this.fail(node, "a module loader (or a value that holds one) is used where this reader cannot follow it");
    }
  }

  /** Follows a type that holds a loader, written at `node`, to the declaration it types. */
  private typed(node: ts.Node): void {
    for (let at: ts.Node = node.parent; !ts.isSourceFile(at); at = at.parent) {
      if (ts.isParameter(at) || ts.isVariableDeclaration(at)) {
        this.bind(at.name);
        return;
      }
      if ((ts.isPropertyDeclaration(at) || ts.isPropertySignature(at)) && (ts.isClassLike(at.parent) || ts.isInterfaceDeclaration(at.parent))) {
        this.enqueue(at.parent.name === undefined ? undefined : this.checker.getSymbolAtLocation(at.parent.name));
        return;
      }
      if (ts.isInterfaceDeclaration(at) || ts.isTypeAliasDeclaration(at) || ts.isClassDeclaration(at) || ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) {
        this.enqueue(at.name === undefined ? undefined : this.checker.getSymbolAtLocation(at.name));
        return;
      }
      if (ts.isArrowFunction(at) || ts.isFunctionExpression(at) || ts.isAsExpression(at) || ts.isTypeAssertionExpression(at) || ts.isCallExpression(at) || ts.isNewExpression(at)) {
        this.flow(at);
        return;
      }
    }
  }

  /** A reference of a symbol that holds a loader: a type written in an annotation, a class it extends, or a value read. */
  private referenced(node: ts.Node): void {
    if (isTypePosition(node)) this.typed(node);
    else if (ts.isIdentifier(node) && ts.isExpressionWithTypeArguments(node.parent) && ts.isHeritageClause(node.parent.parent)) {
      const owner = node.parent.parent.parent;
      this.enqueue(ts.isClassLike(owner) && owner.name !== undefined ? this.checker.getSymbolAtLocation(owner.name) : undefined);
    } else if (ts.isExpression(node) && !isDeclarationName(node)) this.flow(node);
  }
}

/** Whether `name` is bound by a top-level variable statement of a script, which makes it a global. */
function isScriptGlobal(name: ts.Identifier): boolean {
  let at: ts.Node = name.parent;
  while (ts.isBindingElement(at) || ts.isObjectBindingPattern(at) || ts.isArrayBindingPattern(at) || ts.isVariableDeclaration(at) || ts.isVariableDeclarationList(at)) at = at.parent;
  return ts.isVariableStatement(at) && ts.isSourceFile(at.parent) && !ts.isExternalModule(at.parent);
}

function followLoaders(built: ModuleProgram, reading: Held): Map<string, ModuleLoads> {
  return new LoaderFlows(built, reading).run();
}

/** The name a declaration introduces, written where its declaration is, never a read of it. */
function isDeclarationName(node: ts.Node): boolean {
  const parent = node.parent;
  return "name" in parent && parent.name === node && !ts.isPropertyAccessExpression(parent) && !ts.isShorthandPropertyAssignment(parent);
}

/** A use that hands a value on to code this reader does not follow. */
function isEscape(parent: ts.Node, node: ts.Node): boolean {
  if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent) || ts.isReturnStatement(parent) || ts.isThrowStatement(parent) || ts.isYieldExpression(parent)) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === node) return true;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  return ts.isArrowFunction(parent) && parent.body === node;
}

/** A use that reads a value without handing it on: a statement of it alone, a test, a comparison, `typeof`, a string conversion, an export by name. */
function isInert(parent: ts.Node, node: ts.Node): boolean {
  if (ts.isExpressionStatement(parent) || ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent) || ts.isPrefixUnaryExpression(parent) || ts.isDeleteExpression(parent) || ts.isTemplateSpan(parent)) return true;
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isForStatement(parent) || ts.isSwitchStatement(parent) || ts.isCaseClause(parent) || ts.isForInStatement(parent)) return true;
  if (ts.isBinaryExpression(parent)) return !isAssignment(parent.operatorToken.kind) || parent.left === node;
  if (ts.isConditionalExpression(parent)) return parent.condition === node;
  if (ts.isComputedPropertyName(parent) || ts.isExportSpecifier(parent) || ts.isTypeQueryNode(parent)) return true;
  return isDeclarationName(node);
}

function targetOf(expression: ts.Expression | undefined): ImportTarget {
  if (expression === undefined) return { kind: "computed" };
  if (ts.isStringLiteralLike(expression)) return { kind: "static", specifier: expression.text };
  if (ts.isTemplateExpression(expression)) return { kind: "template", prefix: expression.head.text };
  return { kind: "computed" };
}

/** A character that makes the rest of a glob a pattern rather than a path: a wildcard, a class, a brace or extglob group, an escape. */
const GLOB_SYNTAX = /[*?[\]{}()!+@\\]/;

/** The static prefix of a glob pattern: every module whose path begins with it may match. */
function globPrefix(pattern: string): string {
  const at = pattern.search(GLOB_SYNTAX);
  return at === -1 ? pattern : pattern.slice(0, at);
}

/**
 * What a pattern loader's argument names, each pattern with the node it is written as: a pattern or
 * a list of patterns is a template edge to every module its static prefix begins, never a static
 * one, since a pattern names no module whole; a negated pattern only narrows the others and names
 * none; anything else is computed.
 */
function patternTargets(argument: ts.Expression | undefined): [ts.Node | undefined, ImportTarget][] {
  const one = (pattern: ts.Expression): [ts.Node, ImportTarget][] => {
    const text = ts.isStringLiteralLike(pattern) ? pattern.text : ts.isTemplateExpression(pattern) ? pattern.head.text : null;
    if (text === null) return [[pattern, { kind: "computed" }]];
    if (text.startsWith("!") && ts.isStringLiteralLike(pattern)) return [];
    return [[pattern, { kind: "template", prefix: globPrefix(text) }]];
  };
  if (argument === undefined) return [[undefined, { kind: "computed" }]];
  if (!ts.isArrayLiteralExpression(argument)) return one(argument);
  return argument.elements.flatMap((element) => (ts.isSpreadElement(element) ? [[element, { kind: "computed" }] satisfies [ts.Node, ImportTarget]] : one(element)));
}

function clauseNames(elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): ClauseName[] {
  return elements.map((element) => {
    const source = element.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(element.getStart(source)).line + 1;
    return { name: (element.propertyName ?? element.name).text, alias: element.name.text, typeOnly: element.isTypeOnly, line };
  });
}

function importClauseOf(clause: ts.ImportClause | undefined): ImportClause {
  if (clause === undefined) return { kind: "none" };
  if (clause.name !== undefined || clause.namedBindings === undefined || ts.isNamespaceImport(clause.namedBindings)) return { kind: "whole" };
  return { kind: "names", names: clauseNames(clause.namedBindings.elements) };
}

function exportClauseOf(clause: ts.NamedExportBindings | undefined): ImportClause {
  if (clause === undefined || ts.isNamespaceExport(clause)) return { kind: "whole" };
  return { kind: "names", names: clauseNames(clause.elements) };
}

function importLocals(clause: ts.ImportClause | undefined): string[] {
  if (clause === undefined) return [];
  const bindings = clause.namedBindings;
  const named = bindings === undefined ? [] : ts.isNamespaceImport(bindings) ? [bindings.name.text] : bindings.elements.map((element) => element.name.text);
  return clause.name === undefined ? named : [clause.name.text, ...named];
}


/** The edges `source` spells by syntax: its import, export-from, import-equals and import-type declarations, and its `import(...)` calls. */
function spelledEdges(built: ModuleProgram, source: ts.SourceFile): ImportEdge[] {
  const found: ImportEdge[] = [];
  const add = (spec: ts.Node, target: ImportTarget, form: EdgeForm, typeOnly: boolean, binds: { clause: ImportClause; locals?: readonly string[] }): void => {
    const { clause, locals = [] } = binds;
    const start = spec.getStart(source);
    const resolved = target.kind === "static" ? built.resolvedModule(source.fileName, target.specifier) : null;
    found.push({ target, form, typeOnly, clause, locals, resolved, line: source.getLineAndCharacterOfPosition(start).line + 1, start, end: spec.getEnd() });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, targetOf(node.moduleSpecifier), "import", node.importClause?.isTypeOnly === true, { clause: importClauseOf(node.importClause), locals: importLocals(node.importClause) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(node.moduleSpecifier, targetOf(node.moduleSpecifier), "export", node.isTypeOnly, { clause: exportClauseOf(node.exportClause) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, targetOf(node.moduleReference.expression), "import-equals", node.isTypeOnly, { clause: { kind: "whole" }, locals: [node.name.text] });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      const literal = ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal) ? argument.literal : undefined;
      add(argument, literal === undefined ? { kind: "computed" } : { kind: "static", specifier: literal.text }, "import-type", true, { clause: { kind: "whole" } });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments.at(0);
      add(first ?? node, targetOf(first), "dynamic", false, { clause: { kind: "none" } });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The edges of one module of `built`, its spelled ones and its loader calls in the order written, or the first load it cannot classify. */
function readModule(built: ModuleProgram, reading: ProgramReading, source: ts.SourceFile): readonly ImportEdge[] | ReadFailure {
  const loads = reading.loads.get(source.fileName);
  if (loads === undefined) return { start: 0, line: 0, reason: "the module is none the program reads loads in" };
  const [first] = [...loads.failures].sort((a, b) => a.start - b.start);
  if (first !== undefined) return first;
  return [...spelledEdges(built, source), ...loads.edges].sort((a, b) => a.start - b.start);
}

/** Every import edge of `file`, one of the texts `built` holds; `shown` is how a read error names the file. */
export function moduleEdges(built: ModuleProgram, file: string, shown: string = file): ImportEdge[] {
  const absolute = path.resolve(file);
  const source = built.sourceFile(absolute);
  if (source === undefined) throw new ImportReadError(shown, 0, "the module is none of the program's texts");
  const reading = readingOf(built);
  let read = reading.edges.get(absolute);
  if (read === undefined) {
    read = readModule(built, reading, source);
    reading.edges.set(absolute, read);
  }
  if ("reason" in read) throw new ImportReadError(shown, read.line, read.reason);
  return [...read];
}

/**
 * One program over `texts` (each module's path, absolute or under the working directory, to its
 * text), and the read of a module's edges from it; the read throws where importEdges would.
 */
export function importReader(texts: ReadonlyMap<string, string>): (file: string) => ImportEdge[] {
  const built = checkoutProgram(texts);
  return (file) => moduleEdges(built, file);
}

/** Every import edge of the module at `file` (its name picks the script kind) whose source is `text`. */
export function importEdges(file: string, text: string): ImportEdge[] {
  return moduleEdges(programHolding(file, text), file);
}

const exportListsOf = new WeakMap<ts.SourceFile, readonly ExportList[]>();

/** Every `export { ... }` list of the module at `file`, a re-export's included. */
export function exportLists(file: string, text: string): ExportList[] {
  const source = programHolding(file, text).sourceFile(path.resolve(file));
  if (source === undefined) throw new ImportReadError(file, 0, "the module is none of the program's texts");
  const kept = exportListsOf.get(source);
  if (kept !== undefined) return [...kept];
  const lists: ExportList[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue;
    const specifier = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
    lists.push({ line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1, specifier, typeOnly: statement.isTypeOnly, names: clauseNames(statement.exportClause.elements) });
  }
  exportListsOf.set(source, lists);
  return [...lists];
}
