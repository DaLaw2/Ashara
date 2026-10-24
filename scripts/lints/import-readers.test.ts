/**
 * Every lint that reads a file's import edges reads them from its syntax tree (import-targets.ts):
 * the guard below refuses a regular expression over import syntax anywhere under scripts/, and each
 * lint is shown a multi-line import, an import spelled in a comment or a string, and a type-only
 * re-export, which it must classify as the syntax tree does.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, test } from "vitest";
import { run as classImports } from "./class-imports.js";
import { run as internalModules } from "./internal-modules.js";
import { run as languageHomes } from "./language-homes.js";
import { loadLintContext, type LintContext, type PackageScan, type Violation } from "./lint.js";
import { run as moduleNames } from "./module-names.js";
import { run as packageImports } from "./package-imports.js";
import { run as recognisedWording } from "./recognised-wording.js";
import { parseRules } from "./rules.js";
import { run as scriptSubpaths } from "./script-subpaths.js";
import { run as subpathEntries } from "./subpath-entries.js";
import { run as testOnlySubpaths } from "./test-only-subpaths.js";

const SCRIPTS = path.join(import.meta.dirname, "..");

/** Every regular expression a source spells: its literals, and the pattern text a `RegExp(...)` call is given. */
function regexSources(file: string, text: string): { line: number; source: string }[] {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: { line: number; source: string }[] = [];
  const at = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const patternText = (node: ts.Expression | undefined): string | null => {
    if (node === undefined) return null;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("");
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) found.push({ line: at(node), source: node.getText(sourceFile) });
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === "RegExp") {
      const pattern = patternText(node.arguments?.[0]);
      if (pattern !== null) found.push({ line: at(node), source: pattern });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * A pattern over import syntax: an import keyword followed by a character class of both quotes (a
 * specifier), or an `import`/`export` keyword followed by a brace (a clause list).
 */
const IMPORT_SYNTAX_PATTERNS = [/(?:import|from|require|export)[\s\S]*\[[^\]]*(?:"[^\]]*'|'[^\]]*")[^\]]*\]/, /(?:import|export)\\s[\s\S]*?\\\{/];

function scriptSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : scriptSources(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("the import readers under scripts/", () => {
  test("no script reads import syntax with a regular expression", () => {
    const hits = scriptSources(SCRIPTS).flatMap((file) =>
      regexSources(file, fs.readFileSync(file, "utf-8"))
        .filter(({ source }) => IMPORT_SYNTAX_PATTERNS.some((pattern) => pattern.test(source)))
        .map(({ line, source }) => `${path.relative(SCRIPTS, file)}:${line}: ${source}`),
    );
    expect(hits).toEqual([]);
  });

  test("no script but import-targets.ts reads import edges off a syntax tree of its own", () => {
    const own = /\bts\.(?:isImportDeclaration|isExportDeclaration|isImportEqualsDeclaration|isExternalModuleReference|isImportTypeNode|isNamedImports|isNamedExports)\b|SyntaxKind\.ImportKeyword/;
    const readers = scriptSources(SCRIPTS)
      .filter((file) => path.relative(SCRIPTS, file) !== "import-targets.ts" && own.test(fs.readFileSync(file, "utf-8")))
      .map((file) => path.relative(SCRIPTS, file));
    expect(readers).toEqual([]);
  });

  test("the guard sees each shape a text reader of imports takes", () => {
    const probe = [
      String.raw`const A = /\b(?:from|import)\s*\(?\s*["'](@ashara\/[^"']*)["']/g;`,
      String.raw`const B = /\bexport\s*\{([^}]*)\}/g;`,
      String.raw`const C = new RegExp("\\brequire\\(\\s*['\"]");`,
    ].join("\n");
    const hits = regexSources("probe.ts", probe).filter(({ source }) => IMPORT_SYNTAX_PATTERNS.some((pattern) => pattern.test(source)));
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3]);
  });
});

let scratch: string | null = null;

afterEach(() => {
  if (scratch !== null) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** A scratch tree of `files` (repo-relative path to text) whose rules file is `toml`, loaded as the gate loads one. */
function tree(toml: string, files: Readonly<Record<string, string>>): LintContext {
  return loadLintContext(written({ "boundary-rules.toml": toml, ...files }));
}

/** A scratch directory holding `files`, by repo-relative path. */
function written(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-readers-"));
  scratch = root;
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return root;
}

const at = (violations: readonly Violation[]): string[] => violations.map((v) => `${v.file}:${v.line}`).sort();

/** The three shapes each lint is shown: an edge across lines, one spelled in a comment and a string, and a type-only re-export. */
const shapes = (specifier: string, name: string): string =>
  [`import {`, `  ${name},`, `} from "${specifier}";`, `// import { ${name} } from "${specifier}";`, `export const spelled = 'import { ${name} } from "${specifier}"';`, `export type { ${name} as Erased } from "${specifier}";`, `export const used = ${name};`, ""].join("\n");

const manifest = (name: string, exports: Readonly<Record<string, string>>): string => JSON.stringify({ name: `@ashara/${name}`, exports });

describe("each lint classifies an edge as the syntax tree does", () => {
  test("package-imports: a refused edge across lines and a type-only re-export are violations; a comment or a string is none", () => {
    const context = tree("[a]\nallow = []\n\n[b]\nallow = []\n", { "packages/a/src/index.ts": "export const a = 1;\n", "packages/b/src/x.ts": shapes("@ashara/a", "a") });
    expect(at(packageImports(context))).toEqual(["packages/b/src/x.ts:3", "packages/b/src/x.ts:6"]);
  });

  test("package-imports, named-only: only the statements the tree holds are held to the names list", () => {
    const context = tree('[a]\nallow = []\n\n[b]\nallow = ["a"]\nnamed-only = ["src/**"]\nnames.a = ["a"]\n', {
      "packages/a/src/index.ts": "export const a = 1;\n",
      "packages/b/src/x.ts": shapes("@ashara/a", "a").replace("// import { a }", "// import { unlisted }").replace("'import { a }", "'import { unlisted }"),
      "packages/b/src/y.ts": 'export const load = (name: string): Promise<unknown> => import(name);\n',
    });
    expect(packageImports(context).map((v) => `${v.file}:${v.line}: ${v.specifier}`)).toEqual(["packages/b/src/y.ts:1: <computed specifier>"]);
  });

  test("test-only-subpaths: an import across lines and a type-only re-export of the subpath are violations; a comment or a string is none", () => {
    const context = tree('[a]\nallow = []\ntest-only-subpaths = ["testing"]\n\n[b]\nallow = ["a"]\n', {
      "packages/a/package.json": manifest("a", { ".": "./src/index.ts", "./testing": "./src/testing.ts" }),
      "packages/a/src/index.ts": "export const a = 1;\n",
      "packages/a/src/testing.ts": "export const builder = 1;\n",
      "packages/b/src/x.ts": shapes("@ashara/a/testing", "builder"),
    });
    expect(at(testOnlySubpaths(context))).toEqual(["packages/b/src/x.ts:3", "packages/b/src/x.ts:6"]);
  });

  test("script-subpaths: a script's import of a held subpath across lines is a violation; a comment or a string is none", () => {
    const context = tree('[a]\nallow = []\nsubpath-importers.schema = ["b"]\n\n[b]\nallow = ["a"]\n', {
      "packages/a/package.json": manifest("a", { ".": "./src/index.ts", "./schema": "./src/schema.ts" }),
      "packages/a/src/index.ts": "export const a = 1;\n",
      "packages/a/src/schema.ts": "export const schema = 1;\n",
      "packages/b/src/x.ts": "export const b = 1;\n",
      "scripts/tool.ts": shapes("@ashara/a/schema", "schema").replace("export type", "// export type"),
    });
    expect(at(scriptSubpaths(context))).toEqual(["scripts/tool.ts:3"]);
  });

  test("class-imports: a listed class across lines is used, a class named in a comment, a string or a type-only re-export is no import, and a vitest loader is unaccounted", () => {
    const context = tree('[a]\nallow = []\n\n[b]\nallow = ["a"]\nclasses.a = ["Listed"]\n', {
      "packages/a/src/index.ts": "export class Held {}\nexport class Listed {}\n",
      "packages/b/src/x.ts": shapes("@ashara/a", "Listed").replace(/\{ Listed \}/g, "{ Held }").replace("{ Listed as Erased }", "{ Held }"),
      "packages/b/src/y.ts": 'import {\n  Held,\n} from "@ashara/a";\nexport const h = Held;\n',
      "packages/b/src/z.test.ts": 'vi.mock("@ashara/a", () => ({}));\n',
    });
    expect(classImports(context).map((v) => `${v.file}:${v.line}: ${v.reason.split(";")[0]}`)).toEqual([
      'packages/b/src/y.ts:3: classes.a: "Held" is a class of "a" it does not list',
      "packages/b/src/z.test.ts:1: classes.a: not an `import {...} from` statement, so the classes it reaches cannot be checked",
    ]);
  });

  test("internal-modules: a refused edge across lines and a type-only re-export are violations; a comment or a string is none", () => {
    const context = tree('[a]\nallow = []\nmodule.one = ["src/one.ts"]\nmodule.two = ["src/two.ts"]\n', {
      "packages/a/src/one.ts": shapes("./two.js", "two"),
      "packages/a/src/two.ts": "export const two = 2;\n",
    });
    expect(at(internalModules(context))).toEqual(["packages/a/src/one.ts:3", "packages/a/src/one.ts:6"]);
  });

  test("subpath-entries: the root entry's re-export across lines is followed; one spelled in a comment or a string is not", () => {
    const context = tree('[a]\nallow = []\nsubpath-importers.schema = ["b"]\n\n[b]\nallow = ["a"]\n\n[tables]\nitems = "b"\nhidden_items = "b"\n', {
      "packages/a/package.json": manifest("a", { ".": "./src/index.ts", "./schema": "./src/schema.ts" }),
      "packages/a/src/index.ts": 'export {\n  items,\n} from "./tables.js";\n// export * from "./hidden.js";\nexport const s = \'export * from "./hidden.js"\';\n',
      "packages/a/src/schema.ts": "export const schema = 1;\n",
      "packages/a/src/tables.ts": 'export const items = pgTable("items", {});\n',
      "packages/a/src/hidden.ts": 'export const hidden = pgTable("hidden_items", {});\n',
      "packages/b/src/x.ts": "export const b = 1;\n",
    });
    expect(subpathEntries(context).map((v) => v.specifier)).toEqual(["packages/a/src/tables.ts"]);
  });

  test("module-names: a held symbol imported across lines inside its module is used; one spelled in a comment or a string outside it is no import", () => {
    const context = tree('[a]\nallow = []\n\n[b]\nallow = ["a"]\nmodule.store = ["src/store.ts"]\nmodule.other = ["src/other.ts"]\nmodule-names.store = ["a:tableObject"]\n', {
      "packages/a/package.json": manifest("a", { ".": "./src/index.ts" }),
      "packages/a/src/index.ts": "const tableObject = 1;\nexport {\n  tableObject,\n};\n",
      "packages/b/src/store.ts": 'import {\n  tableObject,\n} from "@ashara/a";\nexport const s = tableObject;\n',
      "packages/b/src/other.ts": '// import { tableObject } from "@ashara/a";\nexport const t = \'import { tableObject } from "@ashara/a"\';\nexport type { tableObject } from "@ashara/a";\n',
    });
    expect(at(moduleNames(context))).toEqual(["packages/b/src/other.ts:3"]);
  });

  test("recognised-wording: a specifier of any edge of the wording module, a side-effect import's included, is no wording", () => {
    const root = written({
      "packages/integration/src/simulator/stand-ins/recognised-wording.ts": 'import "./stand-in-setup-module.js";\nexport const HEADING = "## Merge with main in progress";\n',
      "packages/integration/src/simulator/other.ts": 'import "./stand-ins/stand-in-setup-module.js";\nexport const setup = "./stand-in-setup-module.js";\n',
    });
    const context: LintContext = { root, packagesDir: path.join(root, "packages"), rulesRelative: "boundary-rules.toml", toml: "", rules: new Map(), packageDirs: [], packages: [] };
    expect(recognisedWording(context)).toEqual([]);
  });

  test("language-homes: a homed name in an export list across lines is a re-export; one spelled in a block comment or a string is none", () => {
    const rule = parseRules("[quality]\nallow = []\n", "boundary-rules.toml").get("quality");
    const home = parseRules("[delivery]\nallow = []\n", "boundary-rules.toml").get("delivery");
    if (rule === undefined || home === undefined) throw new Error("the rules did not parse");
    const scan = (name: string, packageRule: PackageScan["rule"], files: Readonly<Record<string, string>>): PackageScan => ({
      name,
      rule: packageRule,
      root: `/repo/packages/${name}`,
      contents: new Map(Object.entries(files).map(([file, text]) => [`/repo/packages/${name}/src/${file}`, text])),
      relativeTo: (filePath) => filePath.slice(`/repo/packages/${name}/`.length),
    });
    const context: LintContext = {
      root: "/repo",
      packagesDir: "/repo/packages",
      rulesRelative: "boundary-rules.toml",
      toml: '[homes]\nWorkPlan = "delivery"\n',
      rules: new Map(),
      packageDirs: ["delivery", "quality"],
      packages: [
        scan("delivery", home, { "plan.ts": "export type WorkPlan = string;\n" }),
        scan("quality", rule, { "index.ts": 'export {\n  type Other,\n  type WorkPlan,\n} from "@ashara/delivery";\n/*\nexport { WorkPlan } from \"@ashara/delivery\";\n*/\nexport const s = \'export { WorkPlan } from "x"\';\n' }),
      ],
    };
    expect(at(languageHomes(context))).toEqual(["packages/quality/src/index.ts:3"]);
  });
});
