/**
 * ADR-044 Phase 7: Import boundary lint.
 *
 * Statically checks all cross-package @ashara/* imports against the
 * allowed matrix in boundary-rules.toml. Two rule shapes:
 *   allow            = [...]        which packages this package may import
 *   restrict.<pkg>   = [glob, ...]  which files inside this package may import <pkg>
 *
 * Exits 0 if clean, 1 on violations or on a malformed rules file.
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
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__stubs__") continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".d.ts")
        ) {
          results.push(fullPath);
        }
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
  line: number;
  pkg: string;
}

const IMPORT_RE = /from\s+["']@ashara\/([a-z][a-z0-9-]*)["']/g;

function extractAsharaImports(content: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(lines[i])) !== null) {
      refs.push({ line: i + 1, pkg: match[1] });
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  line: number;
  fromPkg: string;
  importedPkg: string;
  reason: string;
}

function main(): void {
  const root = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
  const rulesPath = path.join(root, "boundary-rules.toml");

  if (!fs.existsSync(rulesPath)) {
    console.error(`ERROR: ${rulesPath} not found`);
    process.exit(1);
  }

  let rules: BoundaryRules;
  try {
    rules = parseRules(fs.readFileSync(rulesPath, "utf-8"), path.relative(root, rulesPath));
  } catch (err) {
    console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const packagesDir = path.join(root, "packages");

  const violations: Violation[] = [];
  let filesChecked = 0;

  const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const pkgName of packageDirs) {
    const rule = rules.get(pkgName);

    // If no rules defined for this package, skip it (unconfigured)
    if (rule === undefined) continue;

    // Wildcard: all imports allowed (composition root)
    const isWildcard = rule.allow.length === 1 && rule.allow[0] === "*";

    const pkgRoot = path.join(packagesDir, pkgName);
    const srcDir = path.join(pkgRoot, "src");
    if (!fs.existsSync(srcDir)) continue;

    const files = collectTsFiles(srcDir);

    for (const filePath of files) {
      filesChecked++;
      const content = fs.readFileSync(filePath, "utf-8");
      const imports = extractAsharaImports(content);
      const pkgRelative = path.relative(pkgRoot, filePath).split(path.sep).join("/");

      for (const ref of imports) {
        if (!isWildcard && !rule.allow.includes(ref.pkg)) {
          violations.push({
            file: path.relative(root, filePath),
            line: ref.line,
            fromPkg: pkgName,
            importedPkg: ref.pkg,
            reason: "not in allow list",
          });
          continue;
        }

        const soleImporters = rule.restrict.get(ref.pkg);
        if (soleImporters !== undefined && !matchesAnyGlob(pkgRelative, soleImporters)) {
          violations.push({
            file: path.relative(root, filePath),
            line: ref.line,
            fromPkg: pkgName,
            importedPkg: ref.pkg,
            reason: `only ${soleImporters.join(", ")} may import it`,
          });
        }
      }
    }
  }

  // Report
  if (violations.length > 0) {
    console.error("\nBoundary violations found:\n");
    for (const v of violations) {
      console.error(
        `  ${v.file}:${v.line}  ${v.fromPkg} -> @ashara/${v.importedPkg}  (${v.reason})`
      );
    }
    console.error(`\n${filesChecked} files checked, ${violations.length} violations found\n`);
    process.exit(1);
  } else {
    console.log(`\nAll boundaries clean. ${filesChecked} files checked, 0 violations.\n`);
    process.exit(0);
  }
}

main();
