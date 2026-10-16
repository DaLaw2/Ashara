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
 *   importers        = [...]        which packages may import this package; checked even
 *                                   against a wildcard `allow`, so `[]` means none may
 *   named-only       = [glob, ...]  files inside this package that may import from another
 *                                   package only the symbols its `names.<pkg>` lists
 *   names.<pkg>      = [...]        those symbols; a package with no `names.<pkg>` gives the
 *                                   named-only files nothing
 *
 * A named-only file is read whole, not line by line: every `@ashara/` specifier in it must be the
 * tail of an `import {...} from` or `export {...} from` statement whose every name is listed, a
 * relative import may not leave the named-only files, and a listed name no named-only file imports
 * is itself a violation, so the list never grows past what is used (ADR-081: a simulator oracle
 * never imports the production predicate it judges).
 *
 * It also fails on a default on a price or cost column of a packages/db/src/schema/ module
 * (scripts/price-defaults.ts), on an optional member of a *Deps, *Port or *Config interface that
 * no module the server's main reaches supplies (scripts/optional-deps.ts), and on a stack literal
 * (a manifest, language, extension or toolchain name) in a non-test packages/<pkg>/src module,
 * against the tokens and exemptions of the rules file's [stack-literals] section, which is no
 * package's section (scripts/stack-literals.ts states what that scan reads and its blind spots).
 *
 * Exits 0 if clean, 1 on violations, on a malformed rules file, or when the
 * rules sections and the directories under packages/ do not match one-to-one.
 *
 * Usage: npx tsx scripts/check-boundaries.ts
 */

import fs from "node:fs";
import path from "node:path";
import { describeErrorChain } from "@ashara/shared";
import { OPTIONAL_MEMBER_ALLOWLIST, findUnsuppliedOptionalMembers } from "./optional-deps.js";
import { findPriceColumnDefaults } from "./price-defaults.js";
import { findStackLiterals, parseStackLiteralRules, STACK_LITERALS_SECTION } from "./stack-literals.js";

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
  /** Packages that may import this one; null when the section states none. */
  readonly importers: readonly string[] | null;
  /** File globs whose cross-package imports are held to `names`; empty when the section states none. */
  readonly namedOnly: readonly string[];
  /** importedPkg -> the only symbols the named-only files may import from it. */
  readonly names: ReadonlyMap<string, readonly string[]>;
}

type BoundaryRules = ReadonlyMap<string, PackageRule>;

function parseList(inner: string): string[] {
  const trimmed = inner.trim();
  if (trimmed === "") return [];
  return trimmed.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
}

function parseRules(toml: string, rulesPath: string): BoundaryRules {
  const rules = new Map<
    string,
    { allow: string[]; restrict: Map<string, string[]>; importers: string[] | null; namedOnly: string[]; names: Map<string, string[]> }
  >();
  let currentSection: string | null = null;
  // The [stack-literals] section is not a package's rules; parseStackLiteralRules reads it.
  let inStackLiterals = false;
  const lines = toml.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i].trim();

    if (line === "" || line.startsWith("#")) continue;

    const sectionMatch = /^\[([a-z][a-z0-9-]*)\]$/.exec(line);
    inStackLiterals = sectionMatch ? sectionMatch[1] === STACK_LITERALS_SECTION : inStackLiterals;
    if (inStackLiterals) continue;
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!rules.has(currentSection)) {
        rules.set(currentSection, { allow: [], restrict: new Map(), importers: null, namedOnly: [], names: new Map() });
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

    const importersMatch = /^importers\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (importersMatch) {
      rule.importers = parseList(importersMatch[1]);
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

    const namedOnlyMatch = /^named-only\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (namedOnlyMatch) {
      rule.namedOnly = parseList(namedOnlyMatch[1]);
      if (rule.namedOnly.length === 0) {
        throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "named-only list is empty");
      }
      continue;
    }

    const namesMatch = /^names\.([a-z][a-z0-9-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (namesMatch) {
      const names = parseList(namesMatch[2]);
      if (names.length === 0) {
        throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "names list is empty (omit it to give the named-only files nothing)");
      }
      rule.names.set(namesMatch[1], names);
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
    for (const named of rule.names.keys()) {
      if (rule.namedOnly.length === 0) {
        throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] names.${named}`, "names a package's symbols, but the section has no named-only files");
      }
      if (!isWildcard && !rule.allow.includes(named)) {
        throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] names.${named}`, `lists symbols of "${named}", which is not in its allow list`);
      }
    }
    for (const importer of rule.importers ?? []) {
      if (!rules.has(importer)) {
        throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] importers`, `names "${importer}", which has no section`);
      }
    }
    result.set(pkg, { allow: rule.allow, restrict: rule.restrict, importers: rule.importers, namedOnly: rule.namedOnly, names: rule.names });
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
// Named imports (named-only files)
// ---------------------------------------------------------------------------

interface NamedImport {
  readonly line: number;
  readonly specifier: string;
  readonly pkg: string;
  /** The imported symbols; null when the clause is a default or namespace import, which names none. */
  readonly names: readonly string[] | null;
}

// A statement whose clause is a brace list, a namespace or a default binding. Anything else that
// carries an `@ashara/` specifier (a side-effect or dynamic import, a clause this does not parse)
// is left unaccounted and reported, never assumed harmless.
const NAMED_STATEMENT_RE =
  /\b(?:import|export)\s+(?:type\s+)?(\{[^}]*\}|\*\s+as\s+[\w$]+|\*|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*(["'](@ashara\/([a-z][a-z0-9-]*)(?:\/[^"']*)?)["'])/g;
const ASHARA_LITERAL_RE = /["'](@ashara\/([a-z][a-z0-9-]*)(?:\/[^"']*)?)["']/g;

function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function clauseNames(clause: string): string[] | null {
  if (!clause.startsWith("{")) return null;
  return clause
    .slice(1, -1)
    .split(",")
    .map((entry) => entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
    .filter((name) => name !== "");
}

/** The file's `@ashara/` imports by statement, and the line of every `@ashara/` specifier no statement accounts for. */
function extractNamedImports(content: string): { imports: NamedImport[]; unaccounted: { line: number; specifier: string }[] } {
  const imports: NamedImport[] = [];
  const accounted = new Set<number>();
  for (const match of content.matchAll(NAMED_STATEMENT_RE)) {
    const literalOffset = match.index + match[0].length - match[2].length;
    accounted.add(literalOffset);
    imports.push({ line: lineAt(content, literalOffset), specifier: match[3], pkg: match[4], names: clauseNames(match[1]) });
  }
  const unaccounted: { line: number; specifier: string }[] = [];
  for (const match of content.matchAll(ASHARA_LITERAL_RE)) {
    if (!accounted.has(match.index)) unaccounted.push({ line: lineAt(content, match.index), specifier: match[1] });
  }
  return { imports, unaccounted };
}

// ---------------------------------------------------------------------------
// Stack literals (not an import rule; run here so `just check` keeps its four steps)
// ---------------------------------------------------------------------------

/**
 * A stack literal in a non-test module under packages/<pkg>/src that no [stack-literals] exemption
 * admits, and every exempted token no literal of its file uses, so the exemptions only shrink.
 */
function stackLiteralViolations(
  root: string,
  packagesDir: string,
  packageDirs: readonly string[],
  toml: string,
  rulesRelative: string,
): Violation[] {
  const rules = parseStackLiteralRules(toml, rulesRelative);
  const tokens = [...rules.tokens.values()].flat();
  const violations: Violation[] = [];
  const exemptionsUsed = new Set<string>();
  let scanned = 0;
  for (const pkgName of packageDirs) {
    const srcDir = path.join(packagesDir, pkgName, "src");
    for (const filePath of collectTsFiles(srcDir).filter((file) => !file.endsWith(".test.ts"))) {
      scanned++;
      const file = path.relative(root, filePath).split(path.sep).join("/");
      for (const hit of findStackLiterals(fs.readFileSync(filePath, "utf-8"), filePath, tokens)) {
        const token = hit.token.toLowerCase();
        const exemption = rules.exemptions.find((e) => e.file === file && e.tokens.some((t) => t.toLowerCase() === token));
        if (exemption !== undefined) {
          exemptionsUsed.add(`${exemption.id}\0${token}`);
          continue;
        }
        violations.push({
          file,
          line: hit.line,
          fromPkg: pkgName,
          specifier: hit.token,
          reason: `stack literal in production source: ${hit.literal}; take it from the contract, or exempt it in [${STACK_LITERALS_SECTION}] with a reason`,
        });
      }
    }
  }
  if (scanned === 0) {
    violations.push({ file: "packages", line: 0, fromPkg: "*", specifier: STACK_LITERALS_SECTION, reason: "no source module to scan for stack literals; a scan of nothing would pass" });
  }
  for (const exemption of rules.exemptions) {
    for (const token of exemption.tokens) {
      if (!exemptionsUsed.has(`${exemption.id}\0${token.toLowerCase()}`)) {
        violations.push({
          file: rulesRelative,
          line: 0,
          fromPkg: STACK_LITERALS_SECTION,
          specifier: `exempt.${exemption.id}`,
          reason: `"${token}" is exempted in ${exemption.file}, but no literal there uses it; remove it`,
        });
      }
    }
  }
  return violations;
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

    const namesUsed = new Map<string, Set<string>>();

    for (const filePath of files) {
      filesChecked++;
      const content = fs.readFileSync(filePath, "utf-8");
      const imports = extractAsharaImports(content, filePath, packagesDir, pkgName);
      const pkgRelative = path.relative(pkgRoot, filePath).split(path.sep).join("/");

      if (rule.namedOnly.length > 0 && matchesAnyGlob(pkgRelative, rule.namedOnly)) {
        const at = (line: number, specifier: string, reason: string): Violation => ({
          file: path.relative(root, filePath),
          line,
          fromPkg: pkgName,
          specifier,
          reason: `named-only file: ${reason}`,
        });
        const named = extractNamedImports(content);
        for (const loose of named.unaccounted) {
          violations.push(at(loose.line, loose.specifier, "not an `import {...} from` or `export {...} from` statement, so its names cannot be checked"));
        }
        for (const ref of named.imports) {
          if (ref.names === null) {
            violations.push(at(ref.line, ref.specifier, "a default or namespace import names no symbols; import the listed names in braces"));
            continue;
          }
          const listed = rule.names.get(ref.pkg);
          for (const name of ref.names) {
            if (listed === undefined || !listed.includes(name)) {
              violations.push(at(ref.line, ref.specifier, `"${name}" is not in names.${ref.pkg}`));
              continue;
            }
            const used = namesUsed.get(ref.pkg) ?? new Set<string>();
            used.add(name);
            namesUsed.set(ref.pkg, used);
          }
        }
        scanLines(content, RELATIVE_IMPORT_RE, (line, match) => {
          const target = path.relative(pkgRoot, path.resolve(path.dirname(filePath), match[1])).split(path.sep).join("/");
          if (target.startsWith("../") || path.isAbsolute(target)) return;
          const candidates = [target, target.replace(/\.js$/, ".ts")];
          if (!candidates.some((candidate) => matchesAnyGlob(candidate, rule.namedOnly))) {
            violations.push(at(line, match[1], `the relative import leaves the named-only files (${rule.namedOnly.join(", ")})`));
          }
        });
      }

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

        const importers = rules.get(ref.pkg)?.importers ?? null;
        if (importers !== null && !importers.includes(pkgName)) {
          violations.push(violation(`package "${ref.pkg}" admits only importers [${importers.join(", ")}]`));
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

    for (const [importedPkg, listed] of rule.names) {
      for (const name of listed) {
        if (namesUsed.get(importedPkg)?.has(name) !== true) {
          violations.push({
            file: rulesRelative,
            line: 0,
            fromPkg: pkgName,
            specifier: `names.${importedPkg}`,
            reason: `"${name}" is listed but no named-only file imports it; remove it`,
          });
        }
      }
    }
  }

  // Not an import rule, run here so `just check` keeps its four steps: a price column with a
  // default reads an insert that forgot the rate as a free model (scripts/price-defaults.ts).
  const schemaDir = path.join(packagesDir, "db", "src", "schema");
  const schemaModules = fs.readdirSync(schemaDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  if (schemaModules.length === 0) {
    violations.push({
      file: path.relative(root, schemaDir),
      line: 0,
      fromPkg: "db",
      specifier: "schema",
      reason: "no schema module to scan for price defaults; a scan of nothing would pass",
    });
  }
  for (const name of schemaModules) {
    const schemaPath = path.join(schemaDir, name);
    for (const found of findPriceColumnDefaults(fs.readFileSync(schemaPath, "utf-8"))) {
      violations.push({
        file: path.relative(root, schemaPath),
        line: found.line,
        fromPkg: "db",
        specifier: found.column,
        reason: `a price or cost column has a default; every writer must supply the rate (${found.text})`,
      });
    }
  }

  // Not an import rule either: an optional *Deps/*Port/*Config member the server's composition never
  // supplies is a dependency no production path wires (scripts/optional-deps.ts).
  for (const found of findUnsuppliedOptionalMembers({ root, entry: "packages/server/src/index.ts", allowlist: OPTIONAL_MEMBER_ALLOWLIST })) {
    violations.push({
      file: found.file,
      line: found.line,
      fromPkg: found.file.split("/")[1] ?? found.file,
      specifier: `${found.declaration}.${found.member}`,
      reason: found.reason,
    });
  }

  violations.push(...stackLiteralViolations(root, packagesDir, packageDirs, fs.readFileSync(rulesPath, "utf-8"), rulesRelative));

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
  console.error(`\nERROR: ${describeErrorChain(err)}\n`);
  process.exit(1);
}
