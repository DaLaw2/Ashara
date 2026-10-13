/**
 * ADR-044 Phase 7: Import boundary lint.
 *
 * Statically checks cross-package imports in src/ and test/ (test files
 * included) against the allowed matrix in boundary-rules.toml. A
 * cross-package import is an `@ashara/<pkg>` specifier (with or without a
 * subpath) or a relative specifier that resolves into another package
 * directory; a relative specifier that resolves outside packages/ is itself a
 * violation. Only single-line `from`/`import` specifiers are recognised.
 * Two rule shapes:
 *   allow            = [...]        which packages this package may import
 *   restrict.<pkg>   = [glob, ...]  which files inside this package may import <pkg>
 *
 * Exits 0 if clean, 1 on violations, on a malformed rules file, or when the
 * rules sections and the directories under packages/ do not match one-to-one.
 *
 * Usage: npx tsx scripts/check-boundaries.ts
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// TOML parser (minimal: [section] headers, `allow = [...]`, `restrict.x = [...]`)
// ---------------------------------------------------------------------------

class BoundaryRulesParseError extends Error {
  constructor(
    readonly rulesPath: string,
    readonly lineNumber: number,
    readonly lineText: string,
    readonly reason: string,
  ) {
    super(`${rulesPath}:${lineNumber}: ${reason} — ${JSON.stringify(lineText)}`);
    this.name = "BoundaryRulesParseError";
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

interface PackageRule {
  readonly allow: readonly string[];
  /** importedPkg -> file globs (relative to the package root) permitted to import it. */
  readonly restrict: ReadonlyMap<string, readonly string[]>;
}

type BoundaryRules = ReadonlyMap<string, PackageRule>;

function parseList(inner: string): string[] {
  const trimmed = inner.trim();
  if (trimmed === "") return [];
  return trimmed.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
}

function parseRules(toml: string, rulesPath: string): BoundaryRules {
  const rules = new Map<string, { allow: string[]; restrict: Map<string, string[]> }>();
  let currentSection: string | null = null;
  const lines = toml.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i].trim();

    if (line === "" || line.startsWith("#")) continue;

    const sectionMatch = /^\[([a-z][a-z0-9-]*)\]$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!rules.has(currentSection)) {
        rules.set(currentSection, { allow: [], restrict: new Map() });
      }
      continue;
    }

    if (currentSection === null) {
      throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "key outside any [section]");
    }

    const rule = rules.get(currentSection);
    if (rule === undefined) {
      throw new BoundaryRulesParseError(rulesPath, lineNumber, line, `unknown section "${currentSection}"`);
    }

    const allowMatch = /^allow\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (allowMatch) {
      rule.allow = parseList(allowMatch[1]);
      continue;
    }

    const restrictMatch = /^restrict\.([a-z][a-z0-9-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (restrictMatch) {
      const globs = parseList(restrictMatch[2]);
      if (globs.length === 0) {
        throw new BoundaryRulesParseError(
          rulesPath,
          lineNumber,
          line,
          "restrict list is empty (use `allow` to forbid the package outright)",
        );
      }
      rule.restrict.set(restrictMatch[1], globs);
      continue;
    }

    // Fail closed: a typo in a rule key must not silently disable the gate.
    throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "unrecognised rule key");
  }

  const result = new Map<string, PackageRule>();
  for (const [pkg, rule] of rules) {
    const isWildcard = rule.allow.length === 1 && rule.allow[0] === "*";
    for (const restricted of rule.restrict.keys()) {
      if (!isWildcard && !rule.allow.includes(restricted)) {
        throw new BoundaryRulesParseError(
          rulesPath,
          0,
          `[${pkg}] restrict.${restricted}`,
          `restricts "${restricted}" which is not in its allow list`,
        );
      }
    }
    result.set(pkg, { allow: rule.allow, restrict: rule.restrict });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Glob matching (package-relative paths; `*` stays within a segment, `**` crosses)
// ---------------------------------------------------------------------------

const REGEXP_SPECIALS = new Set([..."\\^$.|?+()[]{}"]);

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
      } else {
        pattern += "[^/]*";
      }
    } else if (REGEXP_SPECIALS.has(ch)) {
      pattern += `\\${ch}`;
    } else {
      pattern += ch;
    }
  }
  return new RegExp(`^${pattern}$`);
}

function matchesAnyGlob(relativePath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(relativePath));
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        // Tests and declarations are scanned too: a test importing another BC's
        // internals couples the packages exactly as production code would.
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

interface ImportRef {
  readonly line: number;
  readonly specifier: string;
  /** Target package, or null when a relative specifier resolves outside packages/. */
  readonly pkg: string | null;
}

// `from "@ashara/x"`, side-effect `import "@ashara/x"`, and type-position or
// dynamic `import("@ashara/x")`, each with an optional subpath ("@ashara/x/sub").
const PACKAGE_IMPORT_RE = /\b(?:from|import)\s*\(?\s*["'](@ashara\/([a-z][a-z0-9-]*)(?:\/[^"']*)?)["']/g;

// Relative specifiers in the same positions: a path that leaves the importing
// package reaches another package's internals without naming it.
const RELATIVE_IMPORT_RE = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']*)["']/g;

function scanLines(content: string, re: RegExp, onMatch: (line: number, match: RegExpExecArray) => void): void {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(lines[i])) !== null) {
      onMatch(i + 1, match);
    }
  }
}

function extractAsharaImports(
  content: string,
  filePath: string,
  packagesDir: string,
  fromPkg: string,
): ImportRef[] {
  const refs: ImportRef[] = [];

  scanLines(content, PACKAGE_IMPORT_RE, (line, match) => {
    refs.push({ line, specifier: match[1], pkg: match[2] });
  });

  scanLines(content, RELATIVE_IMPORT_RE, (line, match) => {
    const specifier = match[1];
    const target = path.relative(packagesDir, path.resolve(path.dirname(filePath), specifier));
    const targetPkg = target.split(path.sep)[0];
    if (targetPkg === fromPkg) return;
    const escapes = target === "" || targetPkg === ".." || path.isAbsolute(target);
    refs.push({ line, specifier, pkg: escapes ? null : targetPkg });
  });

  return refs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  line: number;
  fromPkg: string;
  specifier: string;
  reason: string;
}

function main(): void {
  const root = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
  const rulesPath = path.join(root, "boundary-rules.toml");

  if (!fs.existsSync(rulesPath)) {
    console.error(`ERROR: ${rulesPath} not found`);
    process.exit(1);
  }

  const rules = parseRules(fs.readFileSync(rulesPath, "utf-8"), path.relative(root, rulesPath));

  const packagesDir = path.join(root, "packages");

  const violations: Violation[] = [];
  let filesChecked = 0;

  const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const rulesRelative = path.relative(root, rulesPath);
  for (const section of rules.keys()) {
    if (!packageDirs.includes(section)) {
      throw new BoundaryRulesCoverageError(rulesRelative, section, "section has no directory under packages/");
    }
  }

  for (const pkgName of packageDirs) {
    const rule = rules.get(pkgName);
    if (rule === undefined) {
      throw new BoundaryRulesCoverageError(rulesRelative, pkgName, "directory under packages/ has no section");
    }

    // Wildcard: all imports allowed (composition root)
    const isWildcard = rule.allow.length === 1 && rule.allow[0] === "*";

    const pkgRoot = path.join(packagesDir, pkgName);
    const srcDir = path.join(pkgRoot, "src");
    if (!fs.existsSync(srcDir)) {
      throw new BoundaryRulesCoverageError(rulesRelative, pkgName, `${path.relative(root, srcDir)} does not exist`);
    }

    // src/ is required; test/ is optional and scanned under the same rule.
    const testDir = path.join(pkgRoot, "test");
    const files = [
      ...collectTsFiles(srcDir),
      ...(fs.existsSync(testDir) ? collectTsFiles(testDir) : []),
    ];

    for (const filePath of files) {
      filesChecked++;
      const content = fs.readFileSync(filePath, "utf-8");
      const imports = extractAsharaImports(content, filePath, packagesDir, pkgName);
      const pkgRelative = path.relative(pkgRoot, filePath).split(path.sep).join("/");

      for (const ref of imports) {
        const violation = (reason: string): Violation => ({
          file: path.relative(root, filePath),
          line: ref.line,
          fromPkg: pkgName,
          specifier: ref.specifier,
          reason,
        });

        if (ref.pkg === null) {
          violations.push(violation("relative import leaves packages/"));
          continue;
        }

        if (!isWildcard && !rule.allow.includes(ref.pkg)) {
          violations.push(violation(`package "${ref.pkg}" not in allow list`));
          continue;
        }

        const soleImporters = rule.restrict.get(ref.pkg);
        if (soleImporters !== undefined && !matchesAnyGlob(pkgRelative, soleImporters)) {
          violations.push(violation(`only ${soleImporters.join(", ")} may import package "${ref.pkg}"`));
        }
      }
    }
  }

  // Report
  if (violations.length > 0) {
    console.error("\nBoundary violations found:\n");
    for (const v of violations) {
      console.error(
        `  ${v.file}:${v.line}  ${v.fromPkg} -> "${v.specifier}"  (${v.reason})`
      );
    }
    console.error(`\n${filesChecked} files checked, ${violations.length} violations found\n`);
    process.exit(1);
  } else {
    console.log(`\nAll boundaries clean. ${filesChecked} files checked, 0 violations.\n`);
    process.exit(0);
  }
}

// Parse, coverage and filesystem errors all fail closed with one message format.
try {
  main();
} catch (err) {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
