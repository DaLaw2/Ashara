/**
 * What every lint of `just check`'s boundary gate reads and reports: the rules file, parsed once, and
 * every package's scanned source, read once. Each lint is a module whose `run` returns its violations.
 */

import fs from "node:fs";
import path from "node:path";
import { parseRules } from "./rules.js";
import type { BoundaryRules, PackageRule } from "./rules.js";
import { collectTsFiles } from "./source-files.js";

export interface Violation {
  file: string;
  line: number;
  fromPkg: string;
  specifier: string;
  reason: string;
}

/** The rules file is missing: no rule could hold, so nothing is checked. */
class BoundaryRulesMissing extends Error {
  constructor(readonly rulesPath: string) {
    super(`${rulesPath} not found`);
    this.name = "BoundaryRulesMissing";
  }
}

class BoundaryRulesCoverageError extends Error {
  constructor(
    readonly rulesPath: string,
    readonly packageName: string,
    readonly reason: string,
  ) {
    super(`${rulesPath}: package "${packageName}": ${reason}`);
    this.name = "BoundaryRulesCoverageError";
  }
}

/** One package under packages/ with its section of the rules and every .ts file of its src/ and test/. */
export interface PackageScan {
  readonly name: string;
  readonly rule: PackageRule;
  /** The package directory, absolute. */
  readonly root: string;
  /** Every scanned file of the package, by absolute path, in the order read. */
  readonly contents: ReadonlyMap<string, string>;
  /** A file's path relative to the package directory, `/`-separated. */
  readonly relativeTo: (filePath: string) => string;
}

export interface LintContext {
  readonly root: string;
  readonly packagesDir: string;
  /** The rules file, relative to the root. */
  readonly rulesRelative: string;
  /** The rules file's text, for the lints that parse a section of their own. */
  readonly toml: string;
  readonly rules: BoundaryRules;
  /** Every directory under packages/, by name. */
  readonly packageDirs: readonly string[];
  readonly packages: readonly PackageScan[];
}

/**
 * The rules file and every package's source, read once. Fails closed when the rules file is missing
 * or malformed, or when its sections and the directories under packages/ do not match one-to-one.
 */
export function loadLintContext(root: string): LintContext {
  const rulesPath = path.join(root, "boundary-rules.toml");
  if (!fs.existsSync(rulesPath)) throw new BoundaryRulesMissing(rulesPath);
  const rulesRelative = path.relative(root, rulesPath);
  const toml = fs.readFileSync(rulesPath, "utf-8");
  const rules = parseRules(toml, rulesRelative);
  const packagesDir = path.join(root, "packages");
  const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const section of rules.keys()) {
    if (!packageDirs.includes(section)) {
      throw new BoundaryRulesCoverageError(rulesRelative, section, "section has no directory under packages/");
    }
  }

  const packages = packageDirs.map((name): PackageScan => {
    const rule = rules.get(name);
    if (rule === undefined) {
      throw new BoundaryRulesCoverageError(rulesRelative, name, "directory under packages/ has no section");
    }
    const pkgRoot = path.join(packagesDir, name);
    const srcDir = path.join(pkgRoot, "src");
    if (!fs.existsSync(srcDir)) {
      throw new BoundaryRulesCoverageError(rulesRelative, name, `${path.relative(root, srcDir)} does not exist`);
    }
    // src/ is required; test/ is optional and scanned under the same rule.
    const testDir = path.join(pkgRoot, "test");
    const files = [...collectTsFiles(srcDir), ...(fs.existsSync(testDir) ? collectTsFiles(testDir) : [])];
    const contents = new Map(files.map((filePath) => [filePath, fs.readFileSync(filePath, "utf-8")]));
    const relativeTo = (filePath: string): string => path.relative(pkgRoot, filePath).split(path.sep).join("/");
    return { name, rule, root: pkgRoot, contents, relativeTo };
  });

  return { root, packagesDir, rulesRelative, toml, rules, packageDirs, packages };
}
