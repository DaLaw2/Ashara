import { describe, expect, test } from "vitest";
import { exportLists, importEdges, importTargets } from "./import-targets.js";

const FILE = "packages/a/src/probe.test.ts";
const specifiers = (text: string): string[] => importTargets(FILE, text).map((target) => (target.kind === "static" ? target.specifier : target.kind === "template" ? `${target.prefix}*` : "<computed>"));

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
  ])("%s is an edge to its specifier", (_name, text) => {
    expect(specifiers(text)).toContain("./x");
  });

  test("a createRequire binding's computed argument is a computed edge", () => {
    const text = 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const m = (name: string): unknown => load(name);\n';
    expect(importTargets(FILE, text)).toContainEqual({ kind: "computed" });
  });

  test.each([
    ["passed on as a value", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const loaders = [load];\n', 3],
    ["bound by let, where it may be reassigned", 'import { createRequire } from "node:module";\nlet load = createRequire(import.meta.url);\nexport const x: unknown = load("./x");\n', 2],
    ["handed straight to another call", 'import { createRequire } from "node:module";\nregister(createRequire(import.meta.url));\n', 2],
    ["destructured from", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst { resolve } = load;\nexport { resolve };\n', 3],
  ])("a createRequire result %s fails the read with its line", (_name, text, line) => {
    expect(() => importEdges(FILE, text)).toThrow(`${FILE}:${String(line)}:`);
  });

  test("a createRequire destructured under another name is followed to its binding's calls", () => {
    const text = 'const { createRequire: mk } = await import("node:module");\nconst load = mk(import.meta.url);\nexport const x: unknown = load("./x");\n';
    expect(specifiers(text)).toEqual(["node:module", "./x"]);
  });

  test.each([
    ["createRequire aliased by a const", 'import { createRequire } from "node:module";\nconst cr = createRequire;\nconst load = cr(import.meta.url);\nexport const x: unknown = load("./x");\n', 2],
    ["createRequire read off its module", 'import mod from "node:module";\nconst cr = mod.createRequire;\nconst load = cr(import.meta.url);\nexport const x: unknown = load("./x");\n', 2],
    ["createRequire put in an array", 'import { createRequire } from "node:module";\nexport const xs = [createRequire].map((f) => f(import.meta.url)("./x"));\n', 2],
    ["require aliased by a const", 'const r = require;\nexport const x: unknown = r("./x");\n', 1],
    ["require put in an array", 'export const xs = [require].map((r) => r("./x"));\n', 1],
    ["require.resolve read without a call", 'const where = require.resolve;\nexport const x = where("./x");\n', 1],
    ["a createRequire binding aliased by a const", 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst again = load;\nexport const x: unknown = again("./x");\n', 3],
  ])("%s fails the read with its line", (_name, text, line) => {
    expect(() => importEdges(FILE, text)).toThrow(`${FILE}:${String(line)}:`);
  });

  test("require read for a property other than resolve, or by typeof, loads nothing and reads cleanly", () => {
    expect(specifiers('export const main = require.main === module;\nexport const kind = typeof require;\nexport const cache = require.cache;\n')).toEqual([]);
  });

  test("a call that loads nothing is no edge", () => {
    expect(specifiers('vi.fn("./x");\nexpect.mock("./y");\nconst load = (s: string) => s;\nload("./z");\n')).toEqual([]);
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

  test("an export list names each binding by the name it has here and the name it is exported as", () => {
    const lists = exportLists(FILE, 'const a = 1;\nexport {\n  a as b,\n};\nexport type { C } from "./c.js";\n');
    expect(lists).toEqual([
      { line: 2, specifier: null, typeOnly: false, names: [{ name: "a", alias: "b", typeOnly: false, line: 3 }] },
      { line: 5, specifier: "./c.js", typeOnly: true, names: [{ name: "C", alias: "C", typeOnly: false, line: 5 }] },
    ]);
  });
});
