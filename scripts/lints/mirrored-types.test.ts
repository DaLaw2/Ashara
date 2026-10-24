import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadLintContext, type LintContext, type PackageScan } from "./lint.js";
import { run as mirroredTypes } from "./mirrored-types.js";
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
  /** The violations of `packages`, leaving out the allowed pairs this tree does not hold. */
  const found = (packages: Readonly<Record<string, Readonly<Record<string, string>>>>): string[] =>
    mirroredTypes(packagesTree(packages))
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

  test("a copy under another name with the same members, its named types each read as one, is a violation", () => {
    const owner = [
      "interface SweepCheckOutcome { readonly taskId: string; readonly outcome: string }",
      "export interface SweepOutcome {",
      "  readonly checkedTasks: readonly string[];",
      "  readonly uncheckedTasks: readonly string[];",
      '  readonly checks: { readonly kind: "unrecorded" } | { readonly kind: "recorded"; readonly checks: readonly SweepCheckOutcome[] };',
      "}",
    ].join("\n");
    const copy = [
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

  test("two names with the same members in one file is a violation", () => {
    const pair = [
      "interface CheckFoundation { readonly taskId: string; readonly commit: string; readonly at: Date }",
      "export interface FoundationCommit { readonly taskId: string; readonly commit: string; readonly at: Date }",
    ].join("\n");
    expect(found({ quality: { "dispatch-result.ts": pair } })).toEqual(["packages/quality/src/dispatch-result.ts:1"]);
  });

  test("an alias of what an imported function returns is a violation; one of a local function is not", () => {
    const alias = 'import type { createDb } from "@ashara/db";\nimport * as config from "./config.js";\ntype Db = ReturnType<typeof createDb>;\ntype ServerConfig = ReturnType<typeof config.loadServerConfig>;\n';
    const local = "function rows() { return [1]; }\ntype Rows = ReturnType<typeof rows>;\n";
    const violations = mirroredTypes(packagesTree({ server: { "store.ts": alias, "local.ts": local } })).filter((v) => v.line > 0);
    expect(violations.map((v) => `${v.file}:${v.line}`)).toEqual(["packages/server/src/store.ts:3", "packages/server/src/store.ts:4"]);
    expect(violations.map((v) => v.reason)).toEqual([
      expect.stringContaining('a type written over what createDb, imported from "@ashara/db", returns'),
      expect.stringContaining('a type written over what config.loadServerConfig, imported from "./config.js", returns'),
    ]);
  });

  test("a return type of an imported function awaited, indexed, wrapped or written inline is a violation", () => {
    const forms = [
      'import { createDb } from "@ashara/db";',
      'import { lastReport, openMessages, mergeOf, findOne } from "./reads.js";',
      "type Last = Awaited<ReturnType<typeof lastReport>>;",
      "type Open = Awaited<ReturnType<typeof openMessages>>[number];",
      'type Failed = Extract<Awaited<ReturnType<typeof mergeOf>>, { readonly status: "error" }>;',
      "export function handle(db: ReturnType<typeof createDb>): ReturnType<typeof createDb> { return db; }",
      "export interface Holder { readonly db: ReturnType<typeof createDb>; readonly found: NonNullable<ReturnType<typeof findOne>>[\"row\"] }",
      "export function read(): void { let found: ReturnType<typeof findOne> | null = null; void found; }",
    ].join("\n");
    expect(found({ server: { "forms.ts": forms } })).toEqual([
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

  test("a return type of an imported function in scripts/ is a violation, and a scan of no script fails closed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mirrored-types-"));
    try {
      fs.mkdirSync(path.join(root, "scripts", "lints"), { recursive: true });
      fs.writeFileSync(path.join(root, "scripts", "lints", "reader.ts"), 'import { readImports } from "./source-files.js";\nexport function check(ref: ReturnType<typeof readImports>[number]): void { void ref; }\n');
      fs.writeFileSync(path.join(root, "scripts", "lints", "reader.test.ts"), 'import { readImports } from "./source-files.js";\nexport type Ref = ReturnType<typeof readImports>;\n');
      const context = { ...packagesTree({ quality: { "a.ts": "export type One = string;\n" } }), root };
      expect(mirroredTypes(context).filter((v) => v.line > 0).map((v) => `${v.file}:${v.line}`)).toEqual(["scripts/lints/reader.ts:2"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    const reasons = mirroredTypes(packagesTree({ quality: { "a.ts": "export type One = string;\n" } })).map((v) => v.reason);
    expect(reasons).toContainEqual(expect.stringContaining("no script to scan"));
  });

  test("two members in common, a union alias, a test and an import of the one declaration are clean", () => {
    const two = "export interface A { readonly times: number; readonly problems: readonly string[] }\n";
    const twoCopy = "interface B { readonly times: number; readonly problems: readonly string[] }\n";
    const union = 'type C = "a" | "b";\n';
    expect(
      found({
        quality: { "a.ts": two + union, "a.test.ts": "interface A { readonly times: number }\n" },
        engagement: { "b.ts": twoCopy, "c.ts": 'import type { A } from "@ashara/quality";\nexport type { A };\n' },
      }),
    ).toEqual([]);
  });

  test("an allowed pair that no longer matches its declarations is a stale entry", () => {
    const violations = mirroredTypes(packagesTree({ quality: { "a.ts": "export type One = string;\n" } }));
    expect(violations.map((v) => v.reason)).toContainEqual(expect.stringContaining("the allowed entry ProjectRow no longer matches"));
  });

  test("a tree with no production type declaration fails closed", () => {
    expect(mirroredTypes(packagesTree({ quality: { "a.ts": "export const one = 1;\n" } })).map((v) => v.reason)).toContainEqual(expect.stringContaining("no production type declaration"));
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

  test("restoring a copy of a type the repository now declares once fails the repository", () => {
    const restored = [
      "interface BlockingReviewRow { readonly times: number; readonly problems: readonly string[] }",
      'type SweptTerminal = { readonly kind: "stop"; readonly stopId: string } | { readonly kind: "halt"; readonly blockId: string };',
      "interface SweepCheckRead { readonly taskId: string; readonly name: string; readonly command: string; readonly outcome: string }",
      "interface SweepOutcomeRead {",
      "  readonly checkedTasks: readonly string[];",
      "  readonly uncheckedTasks: readonly string[];",
      '  readonly checks: { readonly kind: "unrecorded" } | { readonly kind: "recorded"; readonly checks: readonly SweepCheckRead[] };',
      "}",
    ].join("\n");
    const reasons = mirroredTypes(withRestored({ engagement: { "restored-copies.ts": restored } })).map((v) => v.reason);
    expect(reasons).toContainEqual(expect.stringMatching(/^one name declared more than once: BlockingReviewRow at packages\/engagement\/src\/restored-copies\.ts:1, BlockingReviewRow at packages\/quality\/src\/task-checks\.ts/));
    expect(reasons).toContainEqual(expect.stringMatching(/^one name declared more than once: SweptTerminal at packages\/engagement\/src\/restored-copies\.ts:2, SweptTerminal at packages\/quality\/src\/guarantee-verdict\.ts/));
    expect(reasons).toContainEqual(expect.stringMatching(/^one member set declared under more than one name: SweepOutcomeRead at packages\/engagement\/src\/restored-copies\.ts:4, SweepOutcome at packages\/quality\/src\/guarantee-verdict\.ts/));
  });

  test("restoring a server adapter's alias of the database handle fails the repository", () => {
    const restored = 'import type { createDb } from "@ashara/db";\ntype Db = ReturnType<typeof createDb>;\nexport const handle = (db: Db): Db => db;\n';
    const violations = mirroredTypes(withRestored({ server: { "restored-store.ts": restored } }));
    expect(violations.map((v) => `${v.file}:${v.line} ${v.reason}`)).toEqual([expect.stringMatching(/^packages\/server\/src\/restored-store\.ts:2 a type written over what createDb, imported from "@ashara\/db", returns/)]);
  });

  test("restoring a joined type written over an imported function's return fails the repository", () => {
    const restored = [
      'import type { lastReportGuaranteeVerdictsOf } from "@ashara/engagement";',
      'import { sweepOrphanedWorktrees } from "@ashara/execution-infra";',
      "export type RestoredLastReport = Awaited<ReturnType<typeof lastReportGuaranteeVerdictsOf>>;",
      "export const sweep = (base: string): ReturnType<typeof sweepOrphanedWorktrees> => sweepOrphanedWorktrees(base, async () => []);",
    ].join("\n");
    const violations = mirroredTypes(withRestored({ evaluation: { "restored-report.ts": restored } }));
    expect(violations.map((v) => `${v.file}:${v.line} ${v.reason}`)).toEqual([
      expect.stringMatching(/^packages\/evaluation\/src\/restored-report\.ts:3 a type written over what lastReportGuaranteeVerdictsOf, imported from "@ashara\/engagement", returns/),
      expect.stringMatching(/^packages\/evaluation\/src\/restored-report\.ts:4 a type written over what sweepOrphanedWorktrees, imported from "@ashara\/execution-infra", returns/),
    ]);
  });

  test("the repository declares each type of its production source once, or names the pair with why", () => {
    expect(mirroredTypes(loadLintContext(REPO))).toEqual([]);
  });
});
