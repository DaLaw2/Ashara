/**
 * Every import of a test-only subpath from production source: by its `@ashara/` name from any
 * package or from scripts/, or by a relative path to its entry file from inside its package. Only a
 * test file, the test harness (packages/integration, whose every file is test support) or the entry
 * file of another test-only subpath may import one. A test-only subpath its package.json does not
 * export is itself a violation (a rule that holds nothing).
 */

import fs from "node:fs";
import path from "node:path";
import { parseJson } from "@ashara/shared";
import type { LintContext, Violation } from "./lint.js";
import { collectTsFiles, isRelativeSpecifier, staticEdges } from "./source-files.js";
import { PackageExportsSchema } from "./subpath-entries.js";

const TEST_HARNESS = "integration";

export function run(context: LintContext): Violation[] {
  const { root, packagesDir, packageDirs, rules, rulesRelative } = context;
  const violations: Violation[] = [];
  const specifiers = new Map<string, string>();
  const entries = new Map<string, string>();
  for (const [pkg, rule] of rules) {
    if (rule.testOnlySubpaths.length === 0) continue;
    const manifestPath = path.join(packagesDir, pkg, "package.json");
    const exportsMap = parseJson(PackageExportsSchema, fs.readFileSync(manifestPath, "utf-8"), manifestPath).exports;
    for (const subpath of rule.testOnlySubpaths) {
      const target = exportsMap[`./${subpath}`];
      if (target === undefined) {
        const manifest = path.relative(root, manifestPath).split(path.sep).join("/");
        violations.push({ file: rulesRelative, line: 0, fromPkg: pkg, specifier: `test-only-subpaths.${subpath}`, reason: `${manifest} exports no "./${subpath}"; a rule that holds nothing passes everything` });
        continue;
      }
      const specifier = `@ashara/${pkg}/${subpath}`;
      specifiers.set(specifier, subpath);
      entries.set(path.join(packagesDir, pkg, target), specifier);
    }
  }
  if (specifiers.size === 0) return violations;
  const reason = (specifier: string): string => `only a test file (*.test.ts), the test harness or another test-only entry may import "${specifier}" (test-only-subpaths)`;
  const sources = [
    ...packageDirs.filter((pkg) => pkg !== TEST_HARNESS).flatMap((pkg) => ["src", "test"].map((dir) => ({ pkg, dir: path.join(packagesDir, pkg, dir) }))),
    { pkg: "scripts", dir: path.join(root, "scripts") },
  ];
  for (const { pkg, dir } of sources) {
    if (!fs.existsSync(dir)) continue;
    for (const filePath of collectTsFiles(dir).filter((file) => !file.endsWith(".test.ts") && !entries.has(file))) {
      const content = fs.readFileSync(filePath, "utf-8");
      const file = path.relative(root, filePath).split(path.sep).join("/");
      const edges = staticEdges(filePath, content);
      for (const { line, specifier } of edges) {
        if (specifiers.has(specifier)) violations.push({ file, line, fromPkg: pkg, specifier, reason: reason(specifier) });
      }
      for (const { line, specifier } of edges.filter((each) => isRelativeSpecifier(each.specifier))) {
        const base = path.resolve(path.dirname(filePath), specifier);
        const entry = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")].map((candidate) => entries.get(candidate)).find((found) => found !== undefined);
        if (entry !== undefined) violations.push({ file, line, fromPkg: pkg, specifier, reason: reason(entry) });
      }
    }
  }
  return violations;
}
