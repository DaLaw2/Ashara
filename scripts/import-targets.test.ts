import { describe, expect, test } from "vitest";
import { exportLists, importEdges, importReader, type ImportEdge } from "./import-targets.js";

const FILE = "packages/a/src/probe.test.ts";
const shown = (edges: readonly ImportEdge[]): string[] =>
  edges.map(({ target }) => (target.kind === "static" ? target.specifier : target.kind === "template" ? `${target.prefix}*` : "<computed>"));
const specifiers = (text: string): string[] => shown(importEdges(FILE, text));

describe("the loaders the reader counts as edges", () => {
  test.each([
    ["a createRequire binding's call", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst x: unknown = load("./x");\n'],
    ["an aliased createRequire's binding", 'import { createRequire as makeRequire } from "module";\nconst load = makeRequire(import.meta.url);\nexport const x: unknown = load("./x");\n'],
    ["a createRequire binding named require", 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport const x: unknown = require("./x");\n'],
    ["a createRequire result called in place", 'import module from "node:module";\nexport const x: unknown = module.createRequire(import.meta.url)("./x");\n'],
    ["a createRequire binding's resolve", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const where = load.resolve("./x");\n'],
    ["vi.mock with importOriginal", 'vi.mock("./x", async (importOriginal) => ({ ...(await importOriginal<object>()) }));\n'],
    ["vi.mock alone", 'vi.mock("./x");\n'],
    ["vi.doMock", 'vi.doMock("./x", () => ({}));\n'],
    ["vi.importActual", 'const actual = await vi.importActual<object>("./x");\nexport { actual };\n'],
    ["vi.importMock", 'const mocked = await vi.importMock<object>("./x");\nexport { mocked };\n'],
    ["import.meta.resolve", 'export const where = import.meta.resolve("./x");\n'],
    ["require.resolve", 'export const where = require.resolve("./x");\n'],
    // The checker types each of these as the loader it names, so the call is an edge, not a value it loses.
    ["a createRequire result bound by let", 'import { createRequire } from "node:module";\nlet load = createRequire(import.meta.url);\nexport const x: unknown = load("./x");\n'],
    ["createRequire aliased by a const", 'import { createRequire } from "node:module";\nconst cr = createRequire;\nconst load = cr(import.meta.url);\nexport const x: unknown = load("./x");\n'],
    ["createRequire read off its module", 'import mod from "node:module";\nconst cr = mod.createRequire;\nconst load = cr(import.meta.url);\nexport const x: unknown = load("./x");\n'],
    ["require aliased by a const", 'const r = require;\nexport const x: unknown = r("./x");\n'],
    ["require.resolve read without a call", 'const where = require.resolve;\nexport const x = where("./x");\n'],
    ["a createRequire binding aliased by a const", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst again = load;\nexport const x: unknown = again("./x");\n'],
    ["vitest's loader destructured twice off its namespace", 'import * as t from "vitest";\nconst { vi: { doMock } } = t;\ndoMock("./x");\n'],
    ["vitest's loader read by a literal computed key", 'import { vi } from "vitest";\nconst { ["doMock"]: mockIt } = vi;\nmockIt("./x");\nvi["importActual"]("./x");\n'],
    ["import.meta held as a value", "const meta = import.meta;\nexport const where = meta.resolve(\"./x\");\n"],
    ["module.require", 'export const x: unknown = module.require("./x");\n'],
    ["require reached through process.mainModule", 'export const x: unknown = process.mainModule?.require("./x");\n'],
    ["a Worker given a URL of the module",'import { Worker } from "node:worker_threads";\nexport const worker = new Worker(new URL("./x", import.meta.url));\n'],
    ["vitest's loader destructured off a dynamic import's awaited namespace", 'const { vi: v } = await import("vitest");\nv.doMock("./x");\n'],
    ["vitest's loader read in a dynamic import's then callback", 'void import("vitest").then(({ vi }) => vi.doMock("./x"));\n'],
    ["createRequire read off a dynamic import of node:module", 'const m = await import("node:module");\nexport const x: unknown = m.createRequire(import.meta.url)("./x");\n'],
    ["vitest's loader read off a held dynamic import's promise", 'const pending = import("vitest");\nconst { vi } = await pending;\nvi.doMock("./x");\n'],
    ["vitest's loader read off a value typed by an import type", 'declare const t: typeof import("vitest");\nt.vi.doMock("./x");\n'],
    // A loader nested at any depth in a type the module writes is followed, past the steps taken through Node's or vitest's own types.
    ["vitest's loader nested three levels deep in a parameter's type", 'import { vi } from "vitest";\nexport function f(o: { a: { b: { v: typeof vi } } }): void {\n  o.a.b.v.doMock("./x");\n}\n'],
    ["require nested three levels deep in a declared type literal", 'declare const deep: { a: { b: { c: NodeRequire } } };\nexport const x: unknown = deep.a.b.c("./x");\n'],
    ["require nested three levels deep in an interface", 'interface Deep { a: { b: { c: NodeRequire } } }\ndeclare const d: Deep;\nexport const x: unknown = d.a.b.c("./x");\n'],
    ["vitest's namespace nested two levels deep in a declared type literal", 'declare const t: { x: { y: typeof import("vitest") } };\nt.x.y.vi.doMock("./x");\n'],
    ["require nested in arrays three deep", 'declare const n: NodeRequire[][][];\nexport const x: unknown = n[0][0][0]("./x");\n'],
    ["require nested in tuples three deep", 'declare const n: [[[{ r: NodeRequire }]]];\nexport const x: unknown = n[0][0][0].r("./x");\n'],
    ["require nested deep in a promise", 'declare const p: Promise<{ a: { b: { c: NodeRequire } } }>;\nexport const x: unknown = (await p).a.b.c("./x");\n'],
    ["require held by a recursive generic the module writes", 'interface Tree<T> { v: T; child: Tree<T[]> }\ndeclare const t: Tree<NodeRequire>;\nexport const x: unknown = t.child.child.child.child.v[0][0][0][0]("./x");\n'],
  ])("%s is an edge to its specifier", (_name, text) => {
    expect(specifiers(text)).toContain("./x");
  });

  test("a createRequire binding's computed argument is a computed edge", () => {
    const text = 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const m = (name: string): unknown => load(name);\n';
    expect(specifiers(text)).toContain("<computed>");
  });

  test("a createRequire result destructured from reads cleanly: what it binds loads nothing here, and a call of it elsewhere is that module's edge", () => {
    const text = 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst { resolve } = load;\nexport { resolve };\n';
    expect(specifiers(text)).toEqual(["node:module"]);
  });

  test("a createRequire destructured under another name is followed to its binding's calls", () => {
    const text = 'const { createRequire: mk } = await import("node:module");\nconst load = mk(import.meta.url);\nexport const x: unknown = load("./x");\n';
    expect(specifiers(text)).toEqual(["node:module", "./x"]);
  });

  test("a spawn, exec or execFile runs a program that may be Node loading whichever module its arguments name, which the code does not say, so each is a computed edge, a promisified one included", () => {
    const text = 'import { execFile, spawn } from "node:child_process";\nimport { promisify } from "node:util";\nspawn(process.execPath, ["./x.js"]);\nconst run = promisify(execFile);\nexport const out = run("git", ["status"]);\n';
    expect(importEdges(FILE, text).map((edge) => [edge.form, shown([edge])[0]])).toEqual([
      ["import", "node:child_process"],
      ["import", "node:util"],
      ["program", "<computed>"],
      ["program", "<computed>"],
    ]);
  });

  test("fork runs the module its first argument names, so it is an edge to it, a URL of it included", () => {
    const text = 'import { fork } from "node:child_process";\nexport const a = fork("./x");\nexport const b = fork(new URL("./y", import.meta.url));\n';
    expect(specifiers(text)).toEqual(["node:child_process", "./x", "./y"]);
  });

  const forms = (text: string): string[][] => importEdges(FILE, text).map((edge) => [edge.form, shown([edge])[0]]);

  test.each([
    ["execArgv, which may preload another module", 'fork("./x", { execArgv: ["--require", "./y.js"] })'],
    ["execPath, which runs another program", 'fork("./x", { execPath: "/usr/bin/other" })'],
    ["env, whose NODE_OPTIONS Node reads", 'fork("./x", [], { env: { NODE_OPTIONS: "--require ./y.js" } })'],
  ])("a fork given %s starts Node with modules or a program its options name, which no specifier says, so it is a computed program edge besides its edge to the module", (_name, call) => {
    expect(forms(`import { fork } from "node:child_process";\nexport const a = ${call};\n`)).toEqual([
      ["import", "node:child_process"],
      ["program", "<computed>"],
      ["loader", "./x"],
    ]);
  });

  test("a fork whose arguments set no start option is only an edge to its module", () => {
    expect(forms('import { fork } from "node:child_process";\nexport const a = fork("./x", ["--flag"], { silent: true });\n')).toEqual([
      ["import", "node:child_process"],
      ["loader", "./x"],
    ]);
  });

  test("a Worker given execArgv starts Node with modules it may preload, so it is a computed program edge besides its edge to the module", () => {
    expect(forms('import { Worker } from "node:worker_threads";\nexport const w = new Worker("./x.js", { execArgv: ["--require", "./y.js"] });\n')).toEqual([
      ["import", "node:worker_threads"],
      ["program", "<computed>"],
      ["loader", "./x.js"],
    ]);
  });

  test.each([
    ["imported", 'import { mock } from "node:test";\nexport const m = mock.module("./x", { namedExports: {} });\n'],
    ["read off a test's context", 'import { test } from "node:test";\nvoid test("t", (t) => {\n  t.mock.module("./x");\n});\n'],
  ])("node:test's mock.module %s mocks the module it names, as vi.mock does, so it is an edge to it", (_name, text) => {
    expect(forms(text)).toEqual([
      ["import", "node:test"],
      ["loader", "./x"],
    ]);
  });

  test("node:test's run loads test files its options name or it discovers from the working directory, in this process or another, so it is a computed program edge", () => {
    expect(forms('import { run } from "node:test";\nexport const s = run({ files: ["./x.test.ts"], isolation: "none" });\n')).toEqual([
      ["import", "node:test"],
      ["program", "<computed>"],
    ]);
  });

  test.each([
    ["called on process", 'process.dlopen({ exports: {} }, "./x.node");\nexport {};\n', []],
    ["held by a binding", 'const load = process.dlopen;\nload({ exports: {} }, "./x.node");\nexport {};\n', []],
    ["imported from node:process", 'import { dlopen } from "node:process";\ndlopen({ exports: {} }, "./x.node");\n', [["import", "node:process"]]],
  ])("process.dlopen %s loads a native module by a path resolved against the working directory, never this module, so it is a computed edge", (_name, text, spelled) => {
    expect(forms(text)).toEqual([...spelled, ["loader", "<computed>"]]);
  });

  test("a script that binds a loader to a global another declaration already holds fails the read, since the checker binds the name's uses to that declaration", () => {
    expect(() => importEdges(FILE, 'const open = process.dlopen;\nopen({ exports: {} }, "./x.node");\n')).toThrow(`${FILE}:1:`);
  });

  test.each([
    ["passed on as a value", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const loaders = [load];\n', 3],
    ["handed straight to another call", 'import { createRequire } from "node:module";\ndeclare function register(load: unknown): void;\nregister(createRequire(import.meta.url));\n', 3],
    ["stored on an object", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const held = { load };\n', 3],
    ["assigned to a property", 'import { createRequire } from "node:module";\nconst held: { load?: unknown } = {};\nheld.load = createRequire(import.meta.url);\n', 3],
    ["given a type that holds no loader", 'import { createRequire } from "node:module";\nexport const load: unknown = createRequire(import.meta.url);\n', 2],
    ["returned from a function", 'import { createRequire } from "node:module";\nexport function loader() {\n  return createRequire(import.meta.url);\n}\n', 3],
    ["called through Function's call", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const x: unknown = load.call(null, "./x");\n', 3],
  ])("a createRequire result %s fails the read with its line", (_name, text, line) => {
    expect(() => importEdges(FILE, text)).toThrow(`${FILE}:${String(line)}:`);
  });

  test.each([
    ["createRequire put in an array", 'import { createRequire } from "node:module";\nexport const xs = [createRequire].map((f) => f(import.meta.url)("./x"));\n', 2],
    ["require put in an array", 'export const xs = [require].map((r) => r("./x"));\n', 1],
    ["vitest's namespace handed to a call", 'import * as t from "vitest";\ndeclare function register(owner: unknown): void;\nregister(t);\n', 3],
    ["process, which reaches require through mainModule, bound as a call's this", "export const send = process.send?.bind(process);\n", 1],
    ["import.meta handed to a call","declare function register(meta: unknown): void;\nregister(import.meta);\n", 2],
    ["a loader read off globalThis by a computed key", "export function load(k: string): unknown {\n  return (globalThis as Record<string, (s: string) => unknown>)[k]?.(\"./x\");\n}\n", 2],
    ["a default import of vitest, which exports no default", 'import vitest from "vitest";\nvitest.vi.doMock("./x");\n', 2],
    ["an import.meta member the checker finds no type for", 'export const found = import.meta.glob("./x");\n', 1],
    ["a require of vitest, which the checker types any", 'const { vi } = require("vitest");\nvi.doMock("./x");\n', 1],
    ["a default read off a dynamic import of vitest, which exports none", 'const v = await import("vitest");\nv.default.vi.doMock("./x");\nexport {};\n', 2],
    ["a dynamic import of vitest handed to a call", 'declare function take(x: unknown): void;\ntake(import("vitest"));\n', 2],
    // eval and Function run a string as code, and that code may load any module.
    ["eval called", 'export const x: unknown = eval("require(\'./x\')");\n', 1],
    ["an indirect eval", 'export const x: unknown = (0, eval)("require(\'./x\')");\n', 1],
    ["eval read off globalThis", 'export const x: unknown = globalThis.eval("require(\'./x\')");\n', 1],
    ["eval aliased by a const", 'const run = eval;\nexport const x: unknown = run("require(\'./x\')");\n', 2],
    ["new Function", 'export const f = new Function("return require(\'./x\')");\n', 1],
    ["Function called without new", 'export const f = Function("return require(\'./x\')");\n', 1],
    ["Function aliased by a const", 'const Make = Function;\nexport const f = new Make("return require(\'./x\')");\n', 2],
    // A module's ambient declaration hides the global loader from the checker, while at runtime the name may still be it.
    ["a module that declares require ambiently", 'declare const require: (id: string) => unknown;\nexport const x = require("./x");\n', 1],
    ["a module that declares vi ambiently", 'declare const vi: { mock(path: string): void };\nvi.mock("./x");\nexport {};\n', 1],
    ["a module that declares require as an ambient function", "declare function require(id: string): unknown;\nexport const x = require(\"./x\");\n", 1],
    ["a module that redeclares require in declare global", 'declare global {\n  var require: (id: string) => unknown;\n}\nexport const x = require("./x");\n', 2],
  ])("%s fails the read with its line", (_name, text, line) => {
    expect(() => importEdges(FILE, text)).toThrow(`${FILE}:${String(line)}:`);
  });

  test("a default of vitest re-exported through a local module fails the read where it is called: the module that lacks the name is followed through the re-export", () => {
    const read = importReader(new Map([["packages/r/src/helper.ts", 'export { default } from "vitest";\n'], ["packages/r/src/main.ts", 'import v from "./helper.js";\nv.vi.doMock("./x");\n']]));
    expect(() => read("packages/r/src/main.ts")).toThrow("packages/r/src/main.ts:2:");
  });

  test("require read for a property other than resolve, or by typeof, loads nothing and reads cleanly", () => {
    expect(specifiers('export const main = require.main === module;\nexport const kind = typeof require;\nexport const cache = require.cache;\n')).toEqual([]);
  });

  test("a call that loads nothing is no edge", () => {
    expect(specifiers('vi.fn("./x");\nexpect.mock("./y");\nconst load = (s: string) => s;\nload("./z");\n')).toEqual([]);
  });
});

/** A loader, the setup its forms need, the value it is read as, and how a form calls it with "./x". */
interface LoaderCase {
  readonly name: string;
  readonly setup: string;
  /** The value the loader is read as; null for `import(...)`, which is syntax and names no value. */
  readonly value: string | null;
  readonly call: (callee: string) => string;
  /** The value read off its owner, for a destructuring or computed-key form: `[owner, member]`. */
  readonly member: readonly [string, string] | null;
  /** The module whose namespace holds the loader, and how the loader is read off a namespace `ns` of it, for a dynamic import form. */
  readonly module: { readonly specifier: string; readonly read: (ns: string) => string } | null;
  /** The loader's type as a declaration file can write it, for the forms that nest it deep in a declared type; null for `import(...)`. */
  readonly type: string | null;
  /** How the edge the call makes shows: "./x", or a pattern's static prefix. */
  readonly shows: string;
}

const callWithX = (callee: string): string => `${callee}("./x")`;
const constructWithX = (callee: string): string => `new ${callee}(new URL("./x", import.meta.url))`;

const NODE_MODULE = { specifier: "node:module", read: (ns: string): string => `${ns}.createRequire(import.meta.url)` };
const WORKER_THREADS = { specifier: "node:worker_threads", read: (ns: string): string => `${ns}.Worker` };
const WORKER_TYPE = 'typeof import("node:worker_threads").Worker';

const LOADERS: readonly LoaderCase[] = [
  { name: "require", setup: "", value: "require", call: callWithX, member: ["globalThis", "require"], module: null, type: "NodeJS.Require", shows: "./x" },
  { name: "require.resolve", setup: "", value: "require.resolve", call: callWithX, member: ["require", "resolve"], module: null, type: "NodeJS.RequireResolve", shows: "./x" },
  { name: "a createRequire result", setup: 'import { createRequire } from "node:module";\n', value: "createRequire(import.meta.url)", call: callWithX, member: null, module: NODE_MODULE, type: "NodeJS.Require", shows: "./x" },
  {
    name: "createRequire",
    setup: 'import * as nodeModule from "node:module";\n',
    value: "nodeModule.createRequire",
    call: (callee) => `${callee}(import.meta.url)("./x")`,
    member: ["nodeModule", "createRequire"],
    module: { specifier: "node:module", read: (ns) => `${ns}.createRequire` },
    type: 'typeof import("node:module").createRequire',
    shows: "./x",
  },
  ...["mock", "doMock", "importActual", "importMock"].map(
    (method): LoaderCase => ({
      name: `vi.${method}`,
      setup: 'import { vi } from "vitest";\n',
      value: `vi.${method}`,
      call: callWithX,
      member: ["vi", method],
      module: { specifier: "vitest", read: (ns) => `${ns}.vi.${method}` },
      type: `(typeof import("vitest"))["vi"]["${method}"]`,
      shows: "./x",
    }),
  ),
  { name: "import.meta.resolve", setup: "", value: "import.meta.resolve", call: callWithX, member: ["import.meta", "resolve"], module: null, type: 'ImportMeta["resolve"]', shows: "./x" },
  { name: "import.meta.glob", setup: "", value: "import.meta.glob", call: (callee) => `${callee}("./x/*.ts")`, member: ["import.meta", "glob"], module: null, type: 'ImportMeta["glob"]', shows: "./x/*" },
  { name: "Worker", setup: 'import { Worker } from "node:worker_threads";\n', value: "Worker", call: constructWithX, member: null, module: WORKER_THREADS, type: WORKER_TYPE, shows: "./x" },
  { name: "Worker off its namespace", setup: 'import * as threads from "node:worker_threads";\n', value: "threads.Worker", call: constructWithX, member: ["threads", "Worker"], module: WORKER_THREADS, type: WORKER_TYPE, shows: "./x" },
  {
    name: "fork",
    setup: 'import { fork } from "node:child_process";\n',
    value: "fork",
    call: callWithX,
    member: null,
    module: { specifier: "node:child_process", read: (ns) => `${ns}.fork` },
    type: 'typeof import("node:child_process").fork',
    shows: "./x",
  },
  {
    name: "module.register",
    setup: 'import { register } from "node:module";\n',
    value: "register",
    call: (callee) => `${callee}("./x", import.meta.url)`,
    member: null,
    module: { specifier: "node:module", read: (ns) => `${ns}.register` },
    type: 'typeof import("node:module").register',
    shows: "./x",
  },
  {
    name: "module.runMain",
    setup: 'import * as nodeModule from "node:module";\n',
    value: "nodeModule.runMain",
    call: callWithX,
    member: ["nodeModule", "runMain"],
    module: { specifier: "node:module", read: (ns) => `${ns}.runMain` },
    type: 'typeof import("node:module").runMain',
    shows: "./x",
  },
  { name: "import()", setup: "", value: null, call: () => 'import("./x")', member: null, module: null, type: null, shows: "./x" },
];

/** Declares `import.meta.glob` for the generated modules, as a bundler's types declare it. */
const GLOB_DECLARATION = "interface ImportMeta {\n  glob(patterns: string | readonly string[]): Record<string, () => Promise<unknown>>;\n}\n";

/** One generated module, the helper module it imports (if any) under its file name, and whether the form hands the loader to code the reader cannot follow. */
interface GeneratedForm {
  readonly label: string;
  readonly main: string;
  readonly helper: { readonly name: string; readonly text: string } | null;
  readonly escapes: boolean;
}

/** The forms of `import(...)`, which is syntax: written where it loads, never bound or passed on. */
function syntaxFormsOf(loader: LoaderCase): GeneratedForm[] {
  const load = loader.call("");
  return [
    { label: "called directly", main: `export const out = ${load};\n`, helper: null, escapes: false },
    { label: "awaited in a function", main: `export async function f(): Promise<unknown> {\n  return await ${load};\n}\n`, helper: null, escapes: false },
    { label: "in a then callback", main: `export const out = Promise.resolve().then(() => ${load});\n`, helper: null, escapes: false },
    { label: "nested in a conditional", main: `export const out = Math.random() > 0.5 ? ${load} : null;\n`, helper: null, escapes: false },
  ];
}

function formsOf(loader: LoaderCase): GeneratedForm[] {
  const { setup, value, call, member, module, type } = loader;
  if (value === null) return syntaxFormsOf(loader);
  const forms: GeneratedForm[] = [
    { label: "called directly", main: `${setup}export const out: unknown = ${call(value)};\n`, helper: null, escapes: false },
    { label: "aliased by a const", main: `${setup}const alias = ${value};\nexport const out: unknown = ${call("alias")};\n`, helper: null, escapes: false },
    { label: "aliased twice", main: `${setup}const first = ${value};\nconst second = first;\nexport const out: unknown = ${call("second")};\n`, helper: null, escapes: false },
    { label: "re-exported through a local module", main: `import { alias } from "./helper.js";\nexport const out: unknown = ${call("alias")};\n`, helper: { name: "helper.ts", text: `${setup}export const alias = ${value};\n` }, escapes: false },
    { label: "passed as an argument", main: `${setup}declare function take(value: unknown): void;\ntake(${value});\n`, helper: null, escapes: true },
    { label: "stored on an object", main: `${setup}export const held = { loader: ${value} };\n`, helper: null, escapes: true },
  ];
  if (type !== null) {
    forms.push(
      { label: "nested three member steps deep in a type literal the module declares", main: `declare const deep: { a: { b: { c: ${type} } } };\nexport const out: unknown = ${call("deep.a.b.c")};\n`, helper: null, escapes: false },
      {
        label: "nested four member steps deep in an interface of a declaration file the repository writes",
        main: `import type { Deep } from "./helper.js";\ndeclare const deep: Deep;\nexport const out: unknown = ${call("deep.a.b.c.d")};\n`,
        helper: { name: "helper.d.ts", text: `export interface Deep {\n  readonly a: { readonly b: { readonly c: { readonly d: ${type} } } };\n}\n` },
        escapes: false,
      },
      { label: "held behind a Record's index signature", main: `declare const held: Record<string, ${type}>;\nexport const out: unknown = ${call("held.a")};\n`, helper: null, escapes: false },
      { label: "held behind a Record's index signature read by a literal key", main: `declare const held: Record<string, ${type}>;\nexport const out: unknown = ${call('held["a"]')};\n`, helper: null, escapes: false },
      { label: "held behind an index signature of an interface the module writes", main: `interface Held {\n  [key: string]: ${type};\n}\ndeclare const held: Held;\nexport const out: unknown = ${call("held.a")};\n`, helper: null, escapes: false },
    );
  }
  if (module !== null) {
    const { specifier, read } = module;
    forms.push(
      { label: "read off an awaited dynamic import", main: `const ns = await import("${specifier}");\nexport const out: unknown = ${call(read("ns"))};\n`, helper: null, escapes: false },
      { label: "read in a dynamic import's then callback", main: `export const out = import("${specifier}").then((ns): unknown => ${call(read("ns"))});\n`, helper: null, escapes: false },
      { label: "read off a dynamic import's namespace re-exported through a local module", main: `import { ns } from "./helper.js";\nexport const out: unknown = ${call(read("ns"))};\n`, helper: { name: "helper.ts", text: `export const ns = await import("${specifier}");\n` }, escapes: false },
    );
  }
  if (member !== null) {
    const [owner, name] = member;
    forms.push(
      { label: "destructured off its owner", main: `${setup}const { ${name}: picked } = ${owner};\nexport const out: unknown = ${call("picked")};\n`, helper: null, escapes: false },
      { label: "read by a literal computed key", main: `${setup}export const out: unknown = ${call(`${owner}["${name}"]`)};\n`, helper: null, escapes: false },
    );
  }
  return forms;
}

describe("every aliasing form of every loader is an edge or a read error, never silence", () => {
  const cases = LOADERS.flatMap((loader) => formsOf(loader).map((form, i) => ({ loader, form, dir: `packages/gen/src/${loader.name.replace(/\W+/g, "-")}-${String(i)}` })));
  const texts = new Map<string, string>([["packages/gen/src/import-meta-glob.d.ts", GLOB_DECLARATION]]);
  for (const { form, dir } of cases) {
    texts.set(`${dir}/main.ts`, form.main);
    if (form.helper !== null) texts.set(`${dir}/${form.helper.name}`, form.helper.text);
  }
  const read = importReader(texts);

  test.each(cases.map(({ loader, form, dir }) => [`${loader.name} ${form.label}`, loader, form, dir] as const))("%s", (_label, loader, form, dir) => {
    const main = `${dir}/main.ts`;
    if (form.escapes) {
      expect(() => read(main)).toThrow(`${main}:`);
      return;
    }
    let edges: ImportEdge[] = [];
    try {
      edges = read(main);
    } catch (error) {
      expect(String(error)).toContain(`${main}:`);
      return;
    }
    expect(edges.filter((edge) => edge.form === "require" || edge.form === "loader" || edge.form === "dynamic").map((edge) => shown([edge])[0])).toContain(loader.shows);
  });
});

/** A global that runs a string as code, and how a form calls it. */
const EVALUATORS: readonly { readonly name: string; readonly call: (callee: string) => string }[] = [
  { name: "eval", call: (callee) => `${callee}("require('./x')")` },
  { name: "Function", call: (callee) => `new ${callee}("return require('./x')")` },
];

describe("every form of a call that runs a string as code fails the read: the code may load any module", () => {
  const cases = EVALUATORS.flatMap(({ name, call }) => [
    { label: `${name} called directly`, main: `export const out: unknown = ${call(name)};\n`, helper: null },
    { label: `${name} called indirectly`, main: `export const out: unknown = ${call(`(0, ${name})`)};\n`, helper: null },
    { label: `${name} read off globalThis`, main: `export const out: unknown = ${call(`globalThis.${name}`)};\n`, helper: null },
    { label: `${name} aliased by a const`, main: `const alias = ${name};\nexport const out: unknown = ${call("alias")};\n`, helper: null },
    { label: `${name} re-exported through a local module`, main: `import { alias } from "./helper.js";\nexport const out: unknown = ${call("alias")};\n`, helper: `export const alias = ${name};\n` },
    { label: `${name} destructured off globalThis`, main: `const { ${name}: picked } = globalThis;\nexport const out: unknown = ${call("picked")};\n`, helper: null },
  ]).map((form, i) => ({ ...form, dir: `packages/gen/src/evaluator-${String(i)}` }));
  const texts = new Map<string, string>();
  for (const { main, helper, dir } of cases) {
    texts.set(`${dir}/main.ts`, main);
    if (helper !== null) texts.set(`${dir}/helper.ts`, helper);
  }
  const read = importReader(texts);

  test.each(cases.map(({ label, dir }) => [label, dir] as const))("%s", (_label, dir) => {
    expect(() => read(`${dir}/main.ts`)).toThrow(`${dir}/main.ts:`);
  });
});

/** A function of `node:child_process` that runs a program, and how a form calls it. */
const PROGRAM_RUNNERS: readonly { readonly name: string; readonly call: (callee: string) => string }[] = [
  { name: "spawn", call: (callee) => `${callee}(process.execPath, ["./x.js"])` },
  { name: "spawnSync", call: (callee) => `${callee}(process.execPath, ["./x.js"])` },
  { name: "execFile", call: (callee) => `${callee}(process.execPath, ["./x.js"], () => undefined)` },
  { name: "execFileSync", call: (callee) => `${callee}(process.execPath, ["./x.js"])` },
  { name: "exec", call: (callee) => `${callee}("node ./x.js", () => undefined)` },
  { name: "execSync", call: (callee) => `${callee}("node ./x.js")` },
];

describe("every form of a call that runs a program is a computed edge: the program may be Node loading any module", () => {
  const cases = PROGRAM_RUNNERS.flatMap(({ name, call }) => [
    { label: `${name} imported by name`, main: `import { ${name} } from "node:child_process";\nexport const out: unknown = ${call(name)};\n`, helper: null },
    { label: `${name} imported under another name`, main: `import { ${name} as run } from "node:child_process";\nexport const out: unknown = ${call("run")};\n`, helper: null },
    { label: `${name} read off a namespace`, main: `import * as cp from "node:child_process";\nexport const out: unknown = ${call(`cp.${name}`)};\n`, helper: null },
    { label: `${name} read off a dynamic import`, main: `const cp = await import("node:child_process");\nexport const out: unknown = ${call(`cp.${name}`)};\n`, helper: null },
    { label: `${name} re-exported through a local module`, main: `import { run } from "./helper.js";\nexport const out: unknown = ${call("run")};\n`, helper: `export { ${name} as run } from "node:child_process";\n` },
  ]).map((form, i) => ({ ...form, dir: `packages/gen/src/program-${String(i)}` }));
  const texts = new Map<string, string>();
  for (const { main, helper, dir } of cases) {
    texts.set(`${dir}/main.ts`, main);
    if (helper !== null) texts.set(`${dir}/helper.ts`, helper);
  }
  const read = importReader(texts);

  test.each(cases.map(({ label, dir }) => [label, dir] as const))("%s", (_label, dir) => {
    expect(read(`${dir}/main.ts`).filter((edge) => edge.form === "program").map((edge) => edge.target)).toEqual([{ kind: "computed" }]);
  });
});

describe("a load whose module is not its first argument as this module resolves it", () => {
  test("module.register against a parent URL other than this module's own resolves its specifier elsewhere, so it is a computed edge", () => {
    const text = 'import { register } from "node:module";\nregister("./hooks.mjs", "file:///elsewhere/");\nregister("./hooks.mjs");\n';
    expect(importEdges(FILE, text).filter((edge) => edge.form === "loader").map((edge) => edge.target)).toEqual([{ kind: "computed" }, { kind: "computed" }]);
  });

  test("cluster.fork runs the module a setupPrimary call set anywhere before, which is no fact of the call, so it is a computed program edge", () => {
    const text = 'import cluster from "node:cluster";\ncluster.setupPrimary({ exec: "./x.js" });\nexport const w = cluster.fork();\n';
    expect(importEdges(FILE, text).map((edge) => [edge.form, edge.target.kind])).toEqual([
      ["import", "static"],
      ["program", "computed"],
    ]);
  });
});

describe("node:vm and a Worker with eval run a string as code, which may load any module, so each fails the read", () => {
  test.each([
    ["vm.runInThisContext off a default import", 'import vm from "node:vm";\nexport const r: unknown = vm.runInThisContext("require(\'./x\')");\n', 2],
    ["runInNewContext imported under another name", 'import { runInNewContext as run } from "node:vm";\nexport const r: unknown = run("require(\'./x\')", {});\n', 2],
    ["a vm Script constructed off a namespace", 'import * as vm from "node:vm";\nexport const s = new vm.Script("require(\'./x\')");\n', 2],
    ["compileFunction read off a dynamic import", 'const vm = await import("node:vm");\nexport const f = vm.compileFunction("return require(\'./x\')");\n', 2],
    ["a Worker given eval: true", 'import { Worker } from "node:worker_threads";\nexport const w = new Worker("require(\'./x\')", { eval: true });\n', 2],
    ["a Worker given options that may set eval", 'import { Worker, type WorkerOptions } from "node:worker_threads";\ndeclare const options: WorkerOptions;\nexport const w = new Worker("./x.js", options);\n', 3],
  ])("%s", (_name, text, line) => {
    expect(() => importEdges(FILE, text)).toThrow(`${FILE}:${String(line)}:`);
  });

  test("a Worker whose options set no eval, or eval: false, loads the module its first argument names", () => {
    const text = 'import { Worker } from "node:worker_threads";\nexport const a = new Worker("./x.js", { workerData: 1 });\nexport const b = new Worker("./y.js", { eval: false });\n';
    expect(specifiers(text)).toEqual(["node:worker_threads", "./x.js", "./y.js"]);
  });
});

describe("the edges the reader classifies", () => {
  test("a multi-line import is one edge on its specifier's line, and an import in a comment or a string is none", () => {
    const text = 'import {\n  a,\n  type B,\n} from "./x.js";\n// import { c } from "./y.js";\nconst s = \'import { d } from "./z.js"\';\nexport { s };\n';
    const edges = importEdges(FILE, text);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ form: "import", line: 4, typeOnly: false, target: { kind: "static", specifier: "./x.js" } });
    expect(edges[0].clause).toEqual({ kind: "names", names: [{ name: "a", alias: "a", typeOnly: false, line: 2 }, { name: "B", alias: "B", typeOnly: true, line: 3 }] });
    expect(text.slice(edges[0].start, edges[0].end)).toBe('"./x.js"');
  });

  test("a type-only re-export, a type-only import and a type-position import are erased; a value re-export is not", () => {
    const text = 'export type { T } from "./t.js";\nimport type U from "./u.js";\ntype V = import("./v.js").V;\nexport { w as x } from "./w.js";\nexport * from "./all.js";\n';
    expect(importEdges(FILE, text).map(({ form, typeOnly, clause, target }) => ({ form, typeOnly, clause: clause.kind, target }))).toEqual([
      { form: "export", typeOnly: true, clause: "names", target: { kind: "static", specifier: "./t.js" } },
      { form: "import", typeOnly: true, clause: "whole", target: { kind: "static", specifier: "./u.js" } },
      { form: "import-type", typeOnly: true, clause: "whole", target: { kind: "static", specifier: "./v.js" } },
      { form: "export", typeOnly: false, clause: "names", target: { kind: "static", specifier: "./w.js" } },
      { form: "export", typeOnly: false, clause: "whole", target: { kind: "static", specifier: "./all.js" } },
    ]);
  });

  test("a side-effect import binds nothing, and a default or namespace import binds the module whole", () => {
    const clauses = importEdges(FILE, 'import "./a.js";\nimport b from "./b.js";\nimport * as c from "./c.js";\nimport d, { e } from "./d.js";\n').map((edge) => edge.clause.kind);
    expect(clauses).toEqual(["none", "whole", "whole", "whole"]);
  });

  test("an edge names each local it binds: a default, a namespace, brace aliases and an import-equals name; a call binds none", () => {
    const text = 'import "./a.js";\nimport b, { e as f } from "./b.js";\nimport * as c from "./c.js";\nimport g = require("./g.js");\nexport { h } from "./h.js";\nvoid import("./i.js");\n';
    expect(importEdges(FILE, text).map((edge) => edge.locals)).toEqual([[], ["b", "f"], ["c"], ["g"], [], []]);
  });

  test("a literal specifier names the file the compiler resolves it to, and one it cannot resolve names none", () => {
    const read = importReader(new Map([["packages/r/src/main.ts", 'import { one } from "./one.js";\nimport { two } from "./missing.js";\nexport const both = [one, two];\n'], ["packages/r/src/one.ts", "export const one = 1;\n"]]));
    expect(read("packages/r/src/main.ts").map((edge) => edge.resolved?.endsWith("packages/r/src/one.ts") ?? null)).toEqual([true, null]);
  });

  test("an export list names each binding by the name it has here and the name it is exported as", () => {
    const lists = exportLists(FILE, 'const a = 1;\nexport {\n  a as b,\n};\nexport type { C } from "./c.js";\n');
    expect(lists).toEqual([
      { line: 2, specifier: null, typeOnly: false, names: [{ name: "a", alias: "b", typeOnly: false, line: 3 }] },
      { line: 5, specifier: "./c.js", typeOnly: true, names: [{ name: "C", alias: "C", typeOnly: false, line: 5 }] },
    ]);
  });
});
