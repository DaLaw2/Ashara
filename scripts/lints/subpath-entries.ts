/**
 * Each package's subpath-importers held to its package.json exports, and each `entries.<pkg>` item to
 * an entry point <pkg>'s package.json exports. A subpath whose entry declares
 * tables (`pgTable`) is held to the [tables] owner map: it may list only the package that owns each
 * table it declares, plus a package that composes every context (`allow = ["*"]`) or that none may
 * import (`importers = []`); and the root entry, with every file it re-exports from by a relative
 * `export ... from`, may declare no table a package owns.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseJson } from "@ashara/shared";
import { DB_OWNER, SHARED_OWNER, declaredTables, parseTableOwnershipRules } from "../table-ownership.js";
import type { LintContext, Violation } from "./lint.js";
import type { BoundaryRules, PackageRule } from "./rules.js";

/** The package that composes every context, and the one none may import: each may hold every context's entry. */
function composesEveryContext(rule: PackageRule | undefined): boolean {
  return rule !== undefined && ((rule.allow.length === 1 && rule.allow[0] === "*") || (rule.importers !== null && rule.importers.length === 0));
}

const PackageExportsSchema = z.object({ exports: z.record(z.string(), z.string()) });

/** The package-relative files a relative `export ... from` statement of `file` re-exports from. */
const RELATIVE_REEXPORT_RE = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'](\.{1,2}\/[^"']*)["']/g;

/** `entry` and every file it reaches by relative re-exports, followed file to file. */
function reexportClosure(entry: string): string[] {
  const reached = new Set<string>([entry]);
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const match of fs.readFileSync(file, "utf-8").matchAll(RELATIVE_REEXPORT_RE)) {
      const base = path.resolve(path.dirname(file), match[1]);
      const target = [base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")].find((candidate) => fs.existsSync(candidate));
      if (target === undefined || reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
  }
  return [...reached];
}

/**
 * Each package's subpath-importers held to its package.json exports, each subpath that declares
 * tables held to the [tables] owner of every one, and the root entry held to re-export no table a
 * package owns (header).
 */
function subpathEntryViolations(root: string, packagesDir: string, rules: BoundaryRules, toml: string, rulesRelative: string): Violation[] {
  const owners = parseTableOwnershipRules(toml, rulesRelative).owners;
  const violations: Violation[] = [];
  for (const [pkg, rule] of rules) {
    if (rule.subpathImporters.size === 0) continue;
    const manifestPath = path.join(packagesDir, pkg, "package.json");
    const manifest = path.relative(root, manifestPath).split(path.sep).join("/");
    const exportsMap = parseJson(PackageExportsSchema, fs.readFileSync(manifestPath, "utf-8"), manifestPath).exports;
    const at = (file: string, specifier: string, reason: string): Violation => ({ file, line: 0, fromPkg: pkg, specifier, reason });
    for (const key of Object.keys(exportsMap)) {
      if (key !== "." && !rule.subpathImporters.has(key.slice(2))) violations.push(at(manifest, key, `exports a subpath [${pkg}] states no subpath-importers for, so any package could import it`));
    }
    const declaredIn = (file: string) => declaredTables(fs.readFileSync(file, "utf-8"), file).map((table) => ({ ...table, owner: owners.get(table.name) }));
    for (const [subpath, importers] of rule.subpathImporters) {
      const target = exportsMap[`./${subpath}`];
      if (target === undefined) {
        violations.push(at(rulesRelative, `subpath-importers.${subpath}`, `${manifest} exports no "./${subpath}"; a rule that holds nothing passes everything`));
        continue;
      }
      for (const table of declaredIn(path.join(packagesDir, pkg, target))) {
        for (const importer of importers) {
          if (importer === table.owner || composesEveryContext(rules.get(importer))) continue;
          const owner = table.owner === undefined ? "no [tables] entry" : `"${table.owner}"`;
          violations.push(at(rulesRelative, `subpath-importers.${subpath}`, `admits "${importer}" to ${table.name}, which ${owner} owns`));
        }
      }
    }
    const rootTarget = exportsMap["."];
    if (rootTarget === undefined) continue;
    const rootEntry = path.join(packagesDir, pkg, rootTarget);
    for (const file of reexportClosure(rootEntry)) {
      const owned = declaredIn(file).filter((table) => table.owner !== undefined && table.owner !== DB_OWNER && table.owner !== SHARED_OWNER);
      if (owned.length === 0) continue;
      const listed = owned.map((table) => `${table.name} ("${table.owner}")`).join(", ");
      violations.push(at(path.relative(root, rootEntry).split(path.sep).join("/"), path.relative(root, file).split(path.sep).join("/"), `the root entry re-exports from a file declaring tables a package owns: ${listed}; each is reached only through its subpath`));
    }
  }
  return violations;
}

/** Every `entries.<pkg>` item that names no entry point `pkg`'s package.json exports: a rule that holds nothing. */
function unexportedEntries(packagesDir: string, rules: BoundaryRules, rulesRelative: string): Violation[] {
  const found: Violation[] = [];
  for (const [pkgName, rule] of rules) {
    for (const [imported, entries] of rule.entries) {
      const exported = exportedEntries(path.join(packagesDir, imported, "package.json"));
      for (const entry of entries) {
        if (exported.includes(entry)) continue;
        found.push({ file: rulesRelative, line: 0, fromPkg: pkgName, specifier: `entries.${imported}`, reason: `"${entry}" is no entry point package "${imported}" exports` });
      }
    }
  }
  return found;
}

/** The entry points a package.json's exports name: "." and each "./<sub>" as "<sub>"; none when there is no package.json. */
function exportedEntries(manifest: string): string[] {
  if (!fs.existsSync(manifest)) return [];
  const { exports } = parseJson(PackageExportsSchema, fs.readFileSync(manifest, "utf-8"), manifest);
  return Object.keys(exports).map((key) => (key === "." ? "." : key.replace(/^\.\//, "")));
}

export function run(context: LintContext): Violation[] {
  return [
    ...subpathEntryViolations(context.root, context.packagesDir, context.rules, context.toml, context.rulesRelative),
    ...unexportedEntries(context.packagesDir, context.rules, context.rulesRelative),
  ];
}
