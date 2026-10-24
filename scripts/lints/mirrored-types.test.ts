import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadLintContext, type LintContext, type PackageScan } from "./lint.js";
import { mirroredTypes, run as mirroredTypesOfRepository } from "./mirrored-types.js";
import { parseRules } from "./rules.js";

const REPO = path.join(import.meta.dirname, "..", "..");

function emptyRule(name: string): PackageScan["rule"] {
  const rule = parseRules(`[${name}]\nallow = []\n`, "boundary-rules.toml").get(name);
  if (rule === undefined) throw new Error(`the ${name} rule did not parse`);
  return rule;
}

/** A tree of in-memory packages, each a map of its src-relative files. */
function packagesTree(packages: Readonly<Record<string, Readonly<Record<string, string>>>>): LintContext {
  const scans = Object.entries(packages).map(([name, files]): PackageScan => {
    const pkgRoot = `/repo/packages/${name}`;
    return {
      name,
      rule: emptyRule(name),
      root: pkgRoot,
      contents: new Map(Object.entries(files).map(([file, text]) => [`${pkgRoot}/src/${file}`, text])),
      relativeTo: (filePath) => filePath.slice(pkgRoot.length + 1),
    };
  });
  return { root: "/repo", packagesDir: "/repo/packages", rulesRelative: "boundary-rules.toml", toml: "", rules: new Map(), packageDirs: Object.keys(packages), packages: scans };
}

describe("mirrored-types", () => {
  const MIRRORED = "mirrored-types";
  /** The violations of `packages` under no allowlist, leaving out the scans of nothing an in-memory tree reports. */
  const found = (packages: Readonly<Record<string, Readonly<Record<string, string>>>>): string[] =>
    mirroredTypes(packagesTree(packages), [])
      .filter((v) => v.specifier === MIRRORED && v.line > 0)
      .map((v) => `${v.file}:${v.line}`);

  test("one type name declared in two packages is a violation", () => {
    const sweep = 'export type SweptTerminal = { readonly kind: "stop"; readonly stopId: string } | { readonly kind: "halt"; readonly blockId: string };\n';
    expect(found({ quality: { "published-reads.ts": sweep }, engagement: { "x.ts": `const a = 1;\n${sweep}` } })).toEqual(["packages/quality/src/published-reads.ts:1"]);
  });

  test("one type name declared twice in one package is a violation", () => {
    const review = "interface BlockingReviewRow {\n  readonly times: number;\n  readonly problems: readonly string[];\n}\n";
    expect(found({ quality: { "a.ts": review, "repositories/b.ts": review } })).toEqual(["packages/quality/src/a.ts:1"]);
  });

  test("a copy under another name, across files, whose type the checker finds the same both ways is a violation", () => {
    const owner = [
      "interface SweepCheckOutcome { readonly taskId: string; readonly outcome: string }",
      "export interface SweepOutcome {",
      "  readonly checkedTasks: readonly string[];",
      "  readonly uncheckedTasks: readonly string[];",
      '  readonly checks: { readonly kind: "unrecorded" } | { readonly kind: "recorded"; readonly checks: readonly SweepCheckOutcome[] };',
      "}",
    ].join("\n");
    const copy = [
      "type SweepCheckRead = { taskId: string; outcome: string };",
      "/** A copy. */",
      "type SweepOutcomeRead = {",
      "  /** Commented. */",
      "  checkedTasks: readonly string[];",
      "  uncheckedTasks: readonly string[];",
      '  checks: { kind: "unrecorded" } | { kind: "recorded"; checks: readonly SweepCheckRead[] };',
      "};",
    ].join("\n");
    expect(found({ quality: { "published-reads.ts": owner }, engagement: { "read.ts": copy } })).toEqual(["packages/quality/src/published-reads.ts:2"]);
  });

  test("two names of one type in one file are a violation, an interface and an alias that names it whole alike", () => {
    const pair = [
      "interface CheckFoundation { readonly taskId: string; readonly commit: string; readonly at: Date }",
      "export interface FoundationCommit { readonly taskId: string; readonly commit: string; readonly at: Date }",
    ].join("\n");
    const alias = "export interface Database { readonly url: string; readonly pool: number; readonly schema: string }\ntype Db = Database;\nexport const db = (d: Db): Db => d;\n";
    expect(found({ quality: { "dispatch-result.ts": pair }, server: { "store.ts": alias } })).toEqual(["packages/quality/src/dispatch-result.ts:1", "packages/server/src/store.ts:1"]);
  });

  test("one property set whose types differ is no copy: a field one of them narrows keeps them apart", () => {
    const owner = 'export interface Check { readonly taskId: string; readonly name: string; readonly outcome: "passed" | "failed" }\n';
    const wider = "export interface CheckRead { readonly taskId: string; readonly name: string; readonly outcome: string }\n";
    expect(found({ quality: { "a.ts": owner }, engagement: { "b.ts": wider } })).toEqual([]);
  });

  test("an alias of what a function of another module returns is a violation; one of a local function is not", () => {
    const alias = 'import type { createDb } from "@ashara/db";\nimport * as config from "./config.js";\ntype Db = ReturnType<typeof createDb>;\ntype ServerConfig = ReturnType<typeof config.loadServerConfig>;\nexport const both = (d: Db, c: ServerConfig): unknown => [d, c];\n';
    const configModule = "export function loadServerConfig() {\n  return { port: 1 };\n}\n";
    const local = "function rows() { return [1]; }\nexport type Rows = ReturnType<typeof rows>;\n";
    const violations = mirroredTypes(packagesTree({ server: { "store.ts": alias, "config.ts": configModule, "local.ts": local } }), []).filter((v) => v.line > 0);
    expect(violations.map((v) => `${v.file}:${v.line}`)).toEqual(["packages/server/src/store.ts:3", "packages/server/src/store.ts:4"]);
    expect(violations.map((v) => v.reason)).toEqual([expect.stringContaining("a type written over what createDb, declared in "), expect.stringContaining("a type written over what config.loadServerConfig, declared in packages/server/src/config.ts, returns")]);
  });

  test("a joined type names the type the function's module exports for it, assignable each way, or says it exports none", () => {
    const reads = 'export interface Report { readonly id: string; readonly at: Date }\nexport function lastReport(): Promise<Report> {\n  return Promise.resolve({ id: "r", at: new Date() });\n}\nexport function count(): number {\n  return 1;\n}\n';
    const user = 'import { count, lastReport } from "./reads.js";\nexport type Last = Awaited<ReturnType<typeof lastReport>>;\nexport type Count = ReturnType<typeof count>;\n';
    const reasons = mirroredTypes(packagesTree({ server: { "reads.ts": reads, "user.ts": user } }), []).filter((v) => v.line > 0).map((v) => `${v.line} ${v.reason}`);
    expect(reasons).toEqual([expect.stringMatching(/^2 .*lastReport, declared in packages\/server\/src\/reads\.ts, returns; import Report, which it exports for it/), expect.stringMatching(/^3 .*count, declared in packages\/server\/src\/reads\.ts, returns; export a named type for it there/)]);
  });

  test("a return type of a function of another module awaited, indexed, wrapped or written inline is a violation", () => {
    const reads = [
      "export function lastReport() { return Promise.resolve({ id: 1 }); }",
      "export function openMessages() { return Promise.resolve([{ id: 1 }]); }",
      'export function mergeOf(): Promise<{ readonly status: "error" } | { readonly status: "ok" }> { return Promise.resolve({ status: "ok" }); }',
      "export function findOne() { return { row: 1 } as { row: number } | null; }",
    ].join("\n");
    const forms = [
      'import { createDb } from "@ashara/db";',
      'import { lastReport, openMessages, mergeOf, findOne } from "./reads.js";',
      "type Last = Awaited<ReturnType<typeof lastReport>>;",
      "type Open = Awaited<ReturnType<typeof openMessages>>[number];",
      'type Failed = Extract<Awaited<ReturnType<typeof mergeOf>>, { readonly status: "error" }>;',
      "export function handle(db: ReturnType<typeof createDb>): ReturnType<typeof createDb> { return db; }",
      "export interface Holder { readonly db: ReturnType<typeof createDb>; readonly found: NonNullable<ReturnType<typeof findOne>>[\"row\"] }",
      "export function read(): void { let found: ReturnType<typeof findOne> | null = null; void found; }",
      "export type All = [Last, Open, Failed];",
    ].join("\n");
    expect(found({ server: { "forms.ts": forms, "reads.ts": reads } })).toEqual([
      "packages/server/src/forms.ts:3",
      "packages/server/src/forms.ts:4",
      "packages/server/src/forms.ts:5",
      "packages/server/src/forms.ts:6",
      "packages/server/src/forms.ts:6",
      "packages/server/src/forms.ts:7",
      "packages/server/src/forms.ts:7",
      "packages/server/src/forms.ts:8",
    ]);
  });

  test("a join is read by the checker's types, whatever alias of ReturnType, typeof or port member it is written through", () => {
    const reads = "export function lastReport() { return { id: 'r', at: new Date(), n: 1 }; }\nexport interface Reports { latest(): Promise<{ readonly id: string; readonly n: number }> }\n";
    const forms = [
      'import { lastReport } from "./reads.js";',
      'import type { Reports } from "./reads.js";',
      "type Returned<F extends (...a: never[]) => unknown> = ReturnType<F>;",
      "type Fn = typeof lastReport;",
      "export function viaGeneric(x: Returned<typeof lastReport>): void { void x; }",
      "export function viaAliasedTypeof(x: ReturnType<Fn>): void { void x; }",
      'export type Latest = Awaited<ReturnType<Reports["latest"]>>;',
      "export function argumentsOf(x: Parameters<typeof lastReport>): void { void x; }",
    ].join("\n");
    expect(found({ server: { "reads.ts": reads, "forms.ts": forms } })).toEqual(["packages/server/src/forms.ts:5", "packages/server/src/forms.ts:6", "packages/server/src/forms.ts:7"]);
  });

  test("one type copied under one name, in two scripts or in a script and a package, is a violation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mirrored-types-"));
    const finding = "export interface Finding { readonly file: string; readonly line: number; readonly reason: string }\n";
    try {
      fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(root, "scripts", "a.ts"), finding);
      fs.writeFileSync(path.join(root, "scripts", "b.ts"), finding);
      const context = { ...packagesTree({ quality: { "a.ts": "export type One = string;\n" } }), root };
      expect(mirroredTypes(context, []).filter((v) => v.line > 0).map((v) => `${v.file}:${v.line} ${v.reason.split(":")[0] ?? ""}`)).toEqual(["scripts/a.ts:1 one type declared more than once"]);
      fs.rmSync(path.join(root, "scripts", "b.ts"));
      const mixed = { ...packagesTree({ quality: { "finding.ts": finding } }), root };
      expect(mirroredTypes(mixed, []).filter((v) => v.line > 0).map((v) => v.reason)).toEqual([expect.stringMatching(/^one type declared more than once: Finding at packages\/quality\/src\/finding\.ts:1, Finding at scripts\/a\.ts:1/)]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a return type of a local function, a global or a Node built-in is clean", () => {
    const clean = [
      'import { lstat } from "node:fs/promises";',
      "function rows() { return [1]; }",
      "export function read(): void {",
      "  let timer: ReturnType<typeof setTimeout> | undefined;",
      "  let entry: Awaited<ReturnType<typeof lstat>> | undefined;",
      "  const kept: Awaited<ReturnType<typeof rows>>[number] | undefined = undefined;",
      "  void [timer, entry, kept];",
      "}",
    ].join("\n");
    expect(found({ server: { "clean.ts": clean } })).toEqual([]);
  });

  test("a return type of another module's function in scripts/ is a violation, a script test's is not, and a scan of no script fails closed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mirrored-types-"));
    try {
      fs.mkdirSync(path.join(root, "scripts", "lints"), { recursive: true });
      fs.writeFileSync(path.join(root, "scripts", "lints", "source-files.ts"), "export function readImports() {\n  return [{ line: 1 }];\n}\n");
      fs.writeFileSync(path.join(root, "scripts", "lints", "reader.ts"), 'import { readImports } from "./source-files.js";\nexport function check(ref: ReturnType<typeof readImports>[number]): void { void ref; }\n');
      fs.writeFileSync(path.join(root, "scripts", "lints", "reader.test.ts"), 'import { readImports } from "./source-files.js";\nexport type Ref = ReturnType<typeof readImports>;\n');
      const context = { ...packagesTree({ quality: { "a.ts": "export type One = string;\n" } }), root };
      expect(mirroredTypes(context, []).filter((v) => v.line > 0).map((v) => `${v.file}:${v.line}`)).toEqual(["scripts/lints/reader.ts:2"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    const reasons = mirroredTypes(packagesTree({ quality: { "a.ts": "export type One = string;\n" } }), []).map((v) => v.reason);
    expect(reasons).toContainEqual(expect.stringContaining("no script to scan"));
  });

  test("two members in common, a union alias, an array type, a test and an import of the one declaration are clean", () => {
    const two = "export interface A { readonly times: number; readonly problems: readonly string[] }\n";
    const twoCopy = "interface B { readonly times: number; readonly problems: readonly string[] }\n";
    const union = 'type C = "a" | "b";\n';
    const ids = "export type ItemIds = readonly [string, ...string[]];\n";
    expect(
      found({
        quality: { "a.ts": two + union + ids, "a.test.ts": "interface A { readonly times: number }\n" },
        engagement: { "b.ts": twoCopy + "export type CitedIds = readonly [string, ...string[]];\n", "c.ts": 'import type { A } from "@ashara/quality";\nexport type { A };\n' },
      }),
    ).toEqual([]);
  });

  test("an allowed pair with a reason passes; one with no reason fails, and so does an entry that matches nothing", () => {
    const pair = "interface Left { readonly a: string; readonly b: string; readonly c: string }\nexport interface Right { readonly a: string; readonly b: string; readonly c: string }\n";
    const tree = packagesTree({ quality: { "pair.ts": pair } });
    const entry = { names: ["Left", "Right"], files: ["packages/quality/src/pair.ts"] };
    expect(mirroredTypes(tree, [{ ...entry, reason: "two concepts that share a shape" }]).filter((v) => v.specifier === MIRRORED && !v.reason.startsWith("no script"))).toEqual([]);
    const unreasoned = mirroredTypes(tree, [{ ...entry, reason: " " }]).map((v) => v.reason);
    expect(unreasoned).toContainEqual(expect.stringContaining("the allowed entry Left, Right gives no reason"));
    expect(unreasoned).toContainEqual(expect.stringMatching(/^one type declared under more than one name: Left at packages\/quality\/src\/pair\.ts:1, Right at/));
    const stale = mirroredTypes(packagesTree({ quality: { "a.ts": "export type One = string;\n" } }), [{ ...entry, reason: "gone" }]).map((v) => v.reason);
    expect(stale).toContainEqual(expect.stringContaining("the allowed entry Left, Right no longer matches"));
  });

  test("a joined type is never excused: an allowed entry naming its alias and file leaves it a violation", () => {
    const reads = "export function count() {\n  return { n: 1, m: 2, o: 3 };\n}\n";
    const joined = 'import { count } from "./reads.js";\nexport type Counted = ReturnType<typeof count>;\n';
    const tree = packagesTree({ server: { "reads.ts": reads, "joined.ts": joined } });
    const violations = mirroredTypes(tree, [{ names: ["Counted"], files: ["packages/server/src/joined.ts"], reason: "an entry that would excuse the join" }]);
    expect(violations.filter((v) => v.line > 0).map((v) => `${v.file}:${v.line}`)).toEqual(["packages/server/src/joined.ts:2"]);
  });

  test("an allowed entry of the repository's list that no longer matches its declarations is a stale entry", () => {
    const violations = mirroredTypesOfRepository(packagesTree({ quality: { "a.ts": "export type One = string;\n" } }));
    expect(violations.map((v) => v.reason)).toContainEqual(expect.stringContaining("the allowed entry ProjectRow no longer matches"));
  });

  test("a tree with no production type declaration fails closed", () => {
    expect(mirroredTypes(packagesTree({ quality: { "a.ts": "export const one = 1;\n" } }), []).map((v) => v.reason)).toContainEqual(expect.stringContaining("no production type declaration"));
  });

  /** The repository's scan with `files` (src-relative, by package) added to it. */
  function withRestored(added: Readonly<Record<string, Readonly<Record<string, string>>>>): LintContext {
    const context = loadLintContext(REPO);
    const packages = context.packages.map((pkg) => {
      const files = added[pkg.name];
      if (files === undefined) return pkg;
      const contents = new Map(pkg.contents);
      for (const [file, text] of Object.entries(files)) contents.set(path.join(pkg.root, "src", file), text);
      return { ...pkg, contents };
    });
    return { ...context, packages };
  }

  test("restoring copies of the types and joins the repository now declares once fails the repository", () => {
    const copies = [
      "interface BlockingReviewRow { readonly times: number; readonly problems: readonly string[] }",
      'type SweptTerminal = { readonly kind: "stop"; readonly stopId: string } | { readonly kind: "halt"; readonly blockId: string };',
      'interface SweepCheckRead { readonly taskId: string; readonly name: string; readonly command: string; readonly outcome: "passed" | "failed" | "not-run" }',
      "interface SweepOutcomeRead {",
      "  readonly checkedTasks: readonly string[];",
      "  readonly uncheckedTasks: readonly string[];",
      '  readonly checks: { readonly kind: "unrecorded" } | { readonly kind: "recorded"; readonly checks: readonly SweepCheckRead[] };',
      "}",
    ].join("\n");
    const store = 'import type { createDb } from "@ashara/db";\ntype Db = ReturnType<typeof createDb>;\nexport const handle = (db: Db): Db => db;\n';
    const report = [
      'import type { lastReportGuaranteeVerdictsOf } from "@ashara/engagement";',
      'import { sweepOrphanedWorktrees } from "@ashara/execution-infra";',
      "export type RestoredLastReport = Awaited<ReturnType<typeof lastReportGuaranteeVerdictsOf>>;",
      "export const sweep = (base: string): ReturnType<typeof sweepOrphanedWorktrees> => sweepOrphanedWorktrees(base, async () => []);",
    ].join("\n");
    const violations = mirroredTypesOfRepository(withRestored({ engagement: { "restored-copies.ts": copies }, server: { "restored-store.ts": store }, evaluation: { "restored-report.ts": report } }));
    const reasons = violations.map((v) => v.reason);
    expect(reasons).toContainEqual(expect.stringMatching(/^one name declared more than once: BlockingReviewRow at packages\/engagement\/src\/restored-copies\.ts:1, BlockingReviewRow at packages\/quality\/src\/task-checks\.ts/));
    expect(reasons).toContainEqual(expect.stringMatching(/^one name declared more than once: SweptTerminal at packages\/engagement\/src\/restored-copies\.ts:2, SweptTerminal at packages\/quality\/src\/guarantee-verdict\.ts/));
    expect(reasons).toContainEqual(expect.stringMatching(/^one type declared under more than one name: SweepOutcomeRead at packages\/engagement\/src\/restored-copies\.ts:4, SweepOutcome at packages\/quality\/src\/guarantee-verdict\.ts/));
    const joins = violations.filter((v) => v.reason.startsWith("a type written over")).map((v) => `${v.file}:${v.line} ${v.reason}`);
    expect(joins).toEqual([
      expect.stringMatching(/^packages\/evaluation\/src\/restored-report\.ts:3 a type written over what lastReportGuaranteeVerdictsOf, declared in packages\/engagement\/src\//),
      expect.stringMatching(/^packages\/evaluation\/src\/restored-report\.ts:4 a type written over what sweepOrphanedWorktrees, declared in packages\/execution-infra\/src\//),
      expect.stringMatching(/^packages\/server\/src\/restored-store\.ts:2 a type written over what createDb, declared in packages\/db\/src\//),
    ]);
  });

  test("the repository declares each type of its production source once, or names the pair with why", () => {
    expect(mirroredTypesOfRepository(loadLintContext(REPO))).toEqual([]);
  });
});
