/**
 * Import boundary lint.
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
 *   stand-ins        = [glob, ...]  named-only files that stand in for a model the product calls
 *   stand-in-names.<pkg> = [...]    the narrower list those files, and every file they reach by a
 *                                   value import, may import from <pkg>; each name must also be in
 *                                   `names.<pkg>`, and a package with none gives them nothing
 *   bounds-tables    = [glob, ...]  named-only files that hold an oracle's own bounds: they import
 *                                   nothing at all, no other package's symbol and no other file,
 *                                   so no bound in them can be a production constant
 *   module.<name>    = [glob, ...]  the package-relative files of one internal module of the package
 *   module-allow.<name> = [...]     the other modules of the package <name> may import; none when absent.
 *                                   An item `<module>:<glob>` allows only those files of <module> to <name>
 *   module-entry.<name> = [glob, ...] the only files of <name> another module may import
 *
 * A package that declares `module.*` is checked inside, against its modules. Every .ts file under
 * its src/ belongs to exactly one module: a test file to its subject's (`x.test.ts` and
 * `x.<tag>.test.ts` to `x.ts`), any other file to the one module whose glob it matches. A file that
 * matches none, or two, is a violation, and so is a module glob that matches no file. Every relative
 * specifier between two of its modules is checked, `import type` included (a type is language): the
 * importer's `module-allow` must list the target, a target it lists by `<module>:<glob>` admits only
 * those files to it, and a target with `module-entry` admits only those files to any module. The module named `entry` (the barrel) may import every module, and no module may import it.
 * A `module-allow` graph with a cycle is a parse error, so a cycle between modules cannot return.
 * Blind spots: a computed dynamic import, and what is placed inside one file, are not seen.
 *
 * A named-only file is read whole, not line by line: every `@ashara/` specifier in it must be the
 * tail of an `import {...} from` or `export {...} from` statement whose every name is listed, a
 * relative import may not leave the named-only files, and a listed name no named-only file imports
 * is itself a violation, so the list never grows past what is used (a simulator oracle
 * never imports the production predicate it judges). A stand-in is held to `stand-in-names` through
 * its relative value imports too, followed file to file, so a helper cannot hand it a product rule;
 * an `import type` edge carries no runtime code and is not followed. A stand-in glob that matches no
 * file, or matches a file outside the named-only files, is a violation.
 *
 * It also fails on a default on a price or cost column of a packages/db/src/schema/ module
 * (scripts/price-defaults.ts), on an optional member of a *Deps, *Port or *Config interface that
 * no module the server's main reaches supplies (scripts/optional-deps.ts), and on a stack literal
 * (a manifest, language, extension or toolchain name) in a non-test packages/<pkg>/src module,
 * against the tokens and exemptions of the rules file's [stack-literals] section, which is no
 * package's section (scripts/stack-literals.ts states what that scan reads and its blind spots),
 * and on a packages/integration/src/simulator test file over its budget of simulator runs
 * (scripts/simulator-run-budget.ts).
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
import { findRunBudgetFindings } from "./simulator-run-budget.js";
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

class StandInScanError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`stand-in scan: ${file}: ${reason}`);
    this.name = "StandInScanError";
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
  /** Named-only file globs that stand in for a model; empty when the section states none. */
  readonly standIns: readonly string[];
  /** importedPkg -> the only symbols the stand-ins, and what they reach, may import from it. */
  readonly standInNames: ReadonlyMap<string, readonly string[]>;
  /** Named-only file globs holding an oracle's own bounds, which import nothing; empty when the section states none. */
  readonly boundsTables: readonly string[];
  /** module -> its package-relative file globs; empty when the package declares no internal modules. */
  readonly modules: ReadonlyMap<string, readonly string[]>;
  /** module -> the other modules it may import; a module absent here imports none. */
  readonly moduleAllow: ReadonlyMap<string, readonly string[]>;
  /** module -> imported module -> the only files of it the module may import; absent admits all of them. */
  readonly moduleAllowFiles: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** module -> the only files of it another module may import; a module absent here admits all its files. */
  readonly moduleEntry: ReadonlyMap<string, readonly string[]>;
}

/** The module that may import every other module and that none may import: the package's barrel. */
const ENTRY_MODULE = "entry";

type BoundaryRules = ReadonlyMap<string, PackageRule>;

function parseList(inner: string): string[] {
  const trimmed = inner.trim();
  if (trimmed === "") return [];
  return trimmed.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
}

function parseRules(toml: string, rulesPath: string): BoundaryRules {
  const rules = new Map<
    string,
    {
      allow: string[];
      restrict: Map<string, string[]>;
      importers: string[] | null;
      namedOnly: string[];
      names: Map<string, string[]>;
      standIns: string[];
      standInNames: Map<string, string[]>;
      boundsTables: string[];
      modules: Map<string, string[]>;
      moduleAllow: Map<string, string[]>;
      moduleAllowFiles: Map<string, Map<string, string[]>>;
      moduleEntry: Map<string, string[]>;
    }
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
        rules.set(currentSection, { allow: [], restrict: new Map(), importers: null, namedOnly: [], names: new Map(), standIns: [], standInNames: new Map(), boundsTables: [], modules: new Map(), moduleAllow: new Map(), moduleAllowFiles: new Map(), moduleEntry: new Map() });
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

    const standInsMatch = /^stand-ins\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (standInsMatch) {
      rule.standIns = parseList(standInsMatch[1]);
      if (rule.standIns.length === 0) {
        throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "stand-ins list is empty");
      }
      continue;
    }

    const standInNamesMatch = /^stand-in-names\.([a-z][a-z0-9-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (standInNamesMatch) {
      const names = parseList(standInNamesMatch[2]);
      if (names.length === 0) {
        throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "stand-in-names list is empty (omit it to give the stand-ins nothing)");
      }
      rule.standInNames.set(standInNamesMatch[1], names);
      continue;
    }

    const boundsTablesMatch = /^bounds-tables\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (boundsTablesMatch) {
      rule.boundsTables = parseList(boundsTablesMatch[1]);
      if (rule.boundsTables.length === 0) {
        throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "bounds-tables list is empty");
      }
      continue;
    }

    const moduleMatch = /^(module|module-allow|module-entry)\.([a-z][a-z0-9-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (moduleMatch) {
      const [, key, name, inner] = moduleMatch;
      const list = parseList(inner);
      const target = key === "module" ? rule.modules : key === "module-allow" ? rule.moduleAllow : rule.moduleEntry;
      if (list.length === 0) {
        throw new BoundaryRulesParseError(rulesPath, lineNumber, line, `${key} list is empty${key === "module-allow" ? " (omit it: a module with none imports no other module)" : ""}`);
      }
      if (target.has(name)) throw new BoundaryRulesParseError(rulesPath, lineNumber, line, `${key}.${name} is stated twice`);
      if (key !== "module-allow") {
        target.set(name, list);
        continue;
      }
      const whole = new Set<string>();
      const narrowed = new Map<string, string[]>();
      for (const item of list) {
        const colon = item.indexOf(":");
        if (colon === -1) {
          if (whole.has(item) || narrowed.has(item)) throw new BoundaryRulesParseError(rulesPath, lineNumber, line, `lists "${item}" twice, or both whole and by its files`);
          whole.add(item);
          continue;
        }
        const [imported, glob] = [item.slice(0, colon), item.slice(colon + 1)];
        if (whole.has(imported) || glob === "") throw new BoundaryRulesParseError(rulesPath, lineNumber, line, `"${item}" names no file, or "${imported}" is also listed whole`);
        const globs = narrowed.get(imported);
        if (globs === undefined) narrowed.set(imported, [glob]);
        else globs.push(glob);
      }
      target.set(name, [...new Set(list.map((item) => item.split(":")[0]))]);
      rule.moduleAllowFiles.set(name, narrowed);
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
    if (rule.standIns.length > 0 && rule.namedOnly.length === 0) {
      throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] stand-ins`, "names stand-in files, but the section has no named-only files");
    }
    if (rule.boundsTables.length > 0 && rule.namedOnly.length === 0) {
      throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] bounds-tables`, "names bounds-table files, but the section has no named-only files");
    }
    for (const [named, standInNames] of rule.standInNames) {
      if (rule.standIns.length === 0) {
        throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] stand-in-names.${named}`, "lists a package's symbols, but the section has no stand-ins");
      }
      // eslint-disable-next-line no-restricted-syntax -- policy default: a package with no names list narrows to nothing, so each stand-in name throws below
      const wider = rule.names.get(named) ?? [];
      for (const name of standInNames) {
        if (!wider.includes(name)) {
          throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] stand-in-names.${named}`, `lists "${name}", which names.${named} does not: the stand-in list only narrows`);
        }
      }
    }
    // eslint-disable-next-line no-restricted-syntax -- policy default: a section without importers restricts no importer (boundary-rules.toml header)
    for (const importer of rule.importers ?? []) {
      if (!rules.has(importer)) {
        throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] importers`, `names "${importer}", which has no section`);
      }
    }
    checkModuleRules(rulesPath, pkg, rule.modules, rule.moduleAllow, rule.moduleEntry);
    result.set(pkg, {
      allow: rule.allow,
      restrict: rule.restrict,
      importers: rule.importers,
      namedOnly: rule.namedOnly,
      names: rule.names,
      standIns: rule.standIns,
      standInNames: rule.standInNames,
      boundsTables: rule.boundsTables,
      modules: rule.modules,
      moduleAllow: rule.moduleAllow,
      moduleAllowFiles: rule.moduleAllowFiles,
      moduleEntry: rule.moduleEntry,
    });
  }

  return result;
}

/** A module rule naming no declared module, naming the entry where it cannot, or a module-allow cycle. */
function checkModuleRules(
  rulesPath: string,
  pkg: string,
  modules: ReadonlyMap<string, readonly string[]>,
  moduleAllow: ReadonlyMap<string, readonly string[]>,
  moduleEntry: ReadonlyMap<string, readonly string[]>,
): void {
  const refuse = (key: string, reason: string): never => {
    throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] ${key}`, reason);
  };
  for (const [name, targets] of moduleAllow) {
    if (!modules.has(name)) refuse(`module-allow.${name}`, `"${name}" is no module of the section`);
    if (name === ENTRY_MODULE) refuse(`module-allow.${name}`, `the ${ENTRY_MODULE} module may import every module; it takes no module-allow`);
    for (const target of targets) {
      if (!modules.has(target)) refuse(`module-allow.${name}`, `lists "${target}", which is no module of the section`);
      if (target === ENTRY_MODULE) refuse(`module-allow.${name}`, `lists the ${ENTRY_MODULE} module, which no module may import`);
      if (target === name) refuse(`module-allow.${name}`, "lists the module itself");
    }
  }
  for (const name of moduleEntry.keys()) {
    if (!modules.has(name)) refuse(`module-entry.${name}`, `"${name}" is no module of the section`);
    if (name === ENTRY_MODULE) refuse(`module-entry.${name}`, `no module may import the ${ENTRY_MODULE} module, so it has no entry files`);
  }
  // Depth-first search over module-allow: a back edge is a cycle, which fails closed here so it cannot return.
  const state = new Map<string, "open" | "done">();
  const visit = (name: string, trail: readonly string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "open") refuse("module-allow", `a cycle between modules: ${[...trail.slice(trail.indexOf(name)), name].join(" -> ")}`);
    state.set(name, "open");
    // eslint-disable-next-line no-restricted-syntax -- policy default: a module with no module-allow imports no other module (header)
    for (const target of moduleAllow.get(name) ?? []) visit(target, [...trail, name]);
    state.set(name, "done");
  };
  for (const name of moduleAllow.keys()) visit(name, []);
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

// A relative `import type` or `export type` statement: erased at runtime, so it hands no rule over.
// An inline `{ type X }` modifier is not matched, so such an import is followed (fail closed).
const TYPE_ONLY_RELATIVE_RE = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s*from\s*(["']\.{1,2}\/[^"']*["'])/g;
const RELATIVE_LITERAL_RE = /\b(?:from|import)\s*\(?\s*(["'](\.{1,2}\/[^"']*)["'])/g;

/** Every relative specifier in the file that is not the tail of a type-only statement. */
function valueRelativeImports(content: string): { line: number; specifier: string }[] {
  const typeOnly = new Set<number>();
  for (const match of content.matchAll(TYPE_ONLY_RELATIVE_RE)) typeOnly.add(match.index + match[0].length - match[1].length);
  const found: { line: number; specifier: string }[] = [];
  for (const match of content.matchAll(RELATIVE_LITERAL_RE)) {
    const offset = match.index + match[0].length - match[1].length;
    if (!typeOnly.has(offset)) found.push({ line: lineAt(content, offset), specifier: match[2] });
  }
  return found;
}

/** The scanned file a relative specifier names, under TypeScript's `.js`-for-`.ts` convention; null when none is. */
function resolveRelative(fromFile: string, specifier: string, scanned: ReadonlySet<string>): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")];
  return candidates.find((candidate) => scanned.has(candidate)) ?? null;
}

// ---------------------------------------------------------------------------
// Stand-in models
// ---------------------------------------------------------------------------

interface StandInScope {
  readonly rule: PackageRule;
  readonly pkgName: string;
  readonly pkgRoot: string;
  readonly root: string;
  /** Every scanned file of the package, by absolute path. */
  readonly contents: ReadonlyMap<string, string>;
  /** The package's files that match both `named-only` and `stand-ins`. */
  readonly standInFiles: readonly string[];
  readonly relativeTo: (filePath: string) => string;
  readonly violations: Violation[];
}

/**
 * Holds every stand-in, and every named-only file it reaches by relative value imports, to
 * `stand-in-names`. A name outside `names` is left to the named-only check, which already reports
 * it. Returns the stand-in names imported, by package.
 */
function checkStandIns(scope: StandInScope): Map<string, Set<string>> {
  const { rule, pkgName, pkgRoot, root, contents, relativeTo, violations } = scope;
  const used = new Map<string, Set<string>>();
  const reachedFrom = new Map<string, string>();
  const queue: string[] = [];
  for (const standIn of scope.standInFiles) {
    reachedFrom.set(standIn, standIn);
    queue.push(standIn);
  }
  const scanned = new Set(contents.keys());
  for (let filePath = queue.shift(); filePath !== undefined; filePath = queue.shift()) {
    const content = contents.get(filePath);
    const standIn = reachedFrom.get(filePath);
    if (content === undefined || standIn === undefined) {
      throw new StandInScanError(path.relative(root, filePath), "a queued file was never scanned");
    }
    const where = standIn === filePath ? "stand-in model file" : `reached by a value import from stand-in ${relativeTo(standIn)}`;
    const at = (line: number, specifier: string, reason: string): Violation => ({
      file: path.relative(root, filePath),
      line,
      fromPkg: pkgName,
      specifier,
      reason: `${where}: ${reason}`,
    });
    for (const ref of extractNamedImports(content).imports) {
      // eslint-disable-next-line no-restricted-syntax -- policy default: a package with no names list is left to the named-only check, which reports it (docblock above)
      const wider = rule.names.get(ref.pkg) ?? [];
      // eslint-disable-next-line no-restricted-syntax -- policy default: a package with no stand-in names allows the stand-in none, so each listed name is reported below
      const narrow = rule.standInNames.get(ref.pkg) ?? [];
      // eslint-disable-next-line no-restricted-syntax -- policy default: a namespace or default import names no symbol and is left to the named-only check, which reports it
      for (const name of ref.names ?? []) {
        if (!wider.includes(name)) continue;
        if (!narrow.includes(name)) {
          violations.push(at(ref.line, ref.specifier, `"${name}" is not in stand-in-names.${ref.pkg}`));
          continue;
        }
        const names = used.get(ref.pkg) ?? new Set<string>();
        names.add(name);
        used.set(ref.pkg, names);
      }
    }
    for (const relative of valueRelativeImports(content)) {
      const target = path.relative(pkgRoot, path.resolve(path.dirname(filePath), relative.specifier)).split(path.sep).join("/");
      // A path out of the package or out of the named-only files is reported by the named-only check.
      if (target.startsWith("../") || path.isAbsolute(target)) continue;
      if (![target, target.replace(/\.js$/, ".ts")].some((candidate) => matchesAnyGlob(candidate, rule.namedOnly))) continue;
      const resolved = resolveRelative(filePath, relative.specifier, scanned);
      if (resolved === null) {
        violations.push(at(relative.line, relative.specifier, "the value import names no scanned .ts file, so what it hands the stand-in cannot be checked"));
        continue;
      }
      if (reachedFrom.has(resolved)) continue;
      reachedFrom.set(resolved, standIn);
      queue.push(resolved);
    }
  }
  return used;
}

// ---------------------------------------------------------------------------
// Internal modules
// ---------------------------------------------------------------------------

interface ModuleScope {
  readonly rule: PackageRule;
  readonly pkgName: string;
  readonly pkgRoot: string;
  readonly root: string;
  readonly rulesRelative: string;
  /** Every scanned file of the package, by absolute path. */
  readonly contents: ReadonlyMap<string, string>;
  readonly relativeTo: (filePath: string) => string;
}

/** `x.test.ts` and `x.<tag>.test.ts` name `x.ts`, package-relative; the candidates in that order. */
function testSubjects(pkgRelative: string): string[] {
  const stem = pkgRelative.slice(0, -".test.ts".length);
  const untagged = stem.replace(/\.[^./]+$/, "");
  return untagged === stem ? [`${stem}.ts`] : [`${stem}.ts`, `${untagged}.ts`];
}

/**
 * The package's internal module rules (header): every src/ file in exactly one module, every module
 * glob matching a file, and every relative edge between two modules one the rules allow.
 */
function moduleViolations(scope: ModuleScope): Violation[] {
  const { rule, pkgName, pkgRoot, root, rulesRelative, contents, relativeTo } = scope;
  const violations: Violation[] = [];
  const srcFiles = [...contents.keys()].filter((filePath) => relativeTo(filePath).startsWith("src/"));
  const globsMatched = new Set<string>();
  const globMatches = (pkgRelative: string): string[] =>
    [...rule.modules].flatMap(([name, globs]) => {
      const hits = globs.filter((glob) => matchesAnyGlob(pkgRelative, [glob]));
      for (const glob of hits) globsMatched.add(`${name}\0${glob}`);
      return hits.length > 0 ? [name] : [];
    });

  const moduleOf = new Map<string, string>();
  const report = (filePath: string, line: number, specifier: string, reason: string): void => {
    violations.push({ file: path.relative(root, filePath), line, fromPkg: pkgName, specifier, reason });
  };
  const assign = (filePath: string): void => {
    const pkgRelative = relativeTo(filePath);
    const matched = globMatches(pkgRelative);
    if (matched.length === 1) {
      moduleOf.set(filePath, matched[0]);
    } else if (matched.length === 0) {
      report(filePath, 0, "module", `belongs to no module of [${pkgName}]; add it to one module's glob`);
    } else {
      report(filePath, 0, "module", `belongs to modules ${matched.join(", ")}; a file belongs to exactly one`);
    }
  };
  const tests = srcFiles.filter((filePath) => filePath.endsWith(".test.ts"));
  for (const filePath of srcFiles) if (!filePath.endsWith(".test.ts")) assign(filePath);
  for (const filePath of tests) {
    const subject = testSubjects(relativeTo(filePath)).map((candidate) => path.join(pkgRoot, candidate)).find((candidate) => contents.has(candidate));
    if (subject === undefined) {
      assign(filePath);
      continue;
    }
    const subjectModule = moduleOf.get(subject);
    // An unassigned subject is already reported; its test then has no module to be checked against.
    if (subjectModule !== undefined) moduleOf.set(filePath, subjectModule);
  }

  for (const [name, globs] of rule.modules) {
    for (const glob of globs) {
      if (!globsMatched.has(`${name}\0${glob}`)) {
        violations.push({ file: rulesRelative, line: 0, fromPkg: pkgName, specifier: `module.${name}`, reason: `"${glob}" matches no file; a module rule that holds nothing passes everything` });
      }
    }
  }
  const membersOf = (name: string): string[] => [...moduleOf].filter(([, owner]) => owner === name).map(([filePath]) => relativeTo(filePath));
  for (const [name, globs] of rule.moduleEntry) {
    const members = membersOf(name);
    for (const glob of globs) {
      if (!members.some((member) => matchesAnyGlob(member, [glob]))) {
        violations.push({ file: rulesRelative, line: 0, fromPkg: pkgName, specifier: `module-entry.${name}`, reason: `"${glob}" matches no file of module ${name}` });
      }
    }
  }
  for (const [from, narrowed] of rule.moduleAllowFiles) {
    for (const [to, globs] of narrowed) {
      const members = membersOf(to);
      for (const glob of globs) {
        if (!members.some((member) => matchesAnyGlob(member, [glob]))) {
          violations.push({ file: rulesRelative, line: 0, fromPkg: pkgName, specifier: `module-allow.${from}`, reason: `"${to}:${glob}" matches no file of module ${to}` });
        }
      }
    }
  }

  const scanned = new Set(contents.keys());
  for (const [filePath, content] of contents) {
    const from = moduleOf.get(filePath);
    // A file in no module is reported above, and test/ is outside the module rule.
    if (from === undefined) continue;
    for (const match of content.matchAll(RELATIVE_LITERAL_RE)) {
      const specifier = match[2];
      const line = lineAt(content, match.index + match[0].length - match[1].length);
      const target = path.relative(pkgRoot, path.resolve(path.dirname(filePath), specifier)).split(path.sep).join("/");
      // A path out of the package is a cross-package import, checked against the context map.
      if (target.startsWith("../") || path.isAbsolute(target)) continue;
      const resolved = resolveRelative(filePath, specifier, scanned);
      // No scanned .ts file: the match is text in a string (a fixture's source), since an import that
      // resolves to no module fails the typecheck gate.
      if (resolved === null) continue;
      const to = moduleOf.get(resolved);
      if (to === undefined || to === from || from === ENTRY_MODULE) continue;
      if (to === ENTRY_MODULE) {
        report(filePath, line, specifier, `module ${from} may not import the ${ENTRY_MODULE} module`);
        continue;
      }
      // eslint-disable-next-line no-restricted-syntax -- policy default: a module with no module-allow imports no other module (header)
      const allowed = rule.moduleAllow.get(from) ?? [];
      if (!allowed.includes(to)) {
        report(filePath, line, specifier, `module ${from} may not import module ${to} (module-allow.${from}: [${allowed.join(", ")}])`);
        continue;
      }
      const allowedFiles = rule.moduleAllowFiles.get(from)?.get(to);
      if (allowedFiles !== undefined && !matchesAnyGlob(relativeTo(resolved), allowedFiles)) {
        report(filePath, line, specifier, `module ${from} may import only [${allowedFiles.join(", ")}] of module ${to} (module-allow.${from})`);
        continue;
      }
      const entryFiles = rule.moduleEntry.get(to);
      if (entryFiles !== undefined && !matchesAnyGlob(relativeTo(resolved), entryFiles)) {
        report(filePath, line, specifier, `module ${to} admits imports only of module-entry.${to}: [${entryFiles.join(", ")}]`);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Stack literals (not an import rule; run here so it needs no gate of its own in `just check`)
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
// Simulator run budget (not an import rule; run here so it needs no gate of its own in `just check`)
// ---------------------------------------------------------------------------

const SIMULATOR_RUN_BUDGET = "simulator-run-budget";

/** Each simulator test file over its budget of runs (scripts/simulator-run-budget.ts), and a scan of no file. */
function simulatorRunBudgetViolations(root: string): Violation[] {
  const dir = path.join(root, "packages", "integration", "src", "simulator");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".test.ts"));
  if (files.length === 0) {
    return [{ file: path.relative(root, dir), line: 0, fromPkg: "integration", specifier: SIMULATOR_RUN_BUDGET, reason: "no simulator test file to count runs in; a scan of nothing would pass" }];
  }
  const readModule = (specifier: string, fromFile: string): string | null => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
    const target = path.resolve(path.dirname(path.join(dir, fromFile)), specifier.replace(/\.js$/, ".ts"));
    return fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : null;
  };
  return files.flatMap((name) =>
    findRunBudgetFindings(fs.readFileSync(path.join(dir, name), "utf-8"), name, readModule).map((finding) => ({
      file: path.relative(root, path.join(dir, finding.file)).split(path.sep).join("/"),
      line: finding.line,
      fromPkg: "integration",
      specifier: SIMULATOR_RUN_BUDGET,
      reason: finding.reason,
    })),
  );
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
    const contents = new Map<string, string>();
    const standInFiles: string[] = [];
    const boundsTableFiles: string[] = [];
    const relativeTo =(filePath: string): string => path.relative(pkgRoot, filePath).split(path.sep).join("/");

    for (const filePath of files) {
      filesChecked++;
      const content = fs.readFileSync(filePath, "utf-8");
      contents.set(filePath, content);
      const imports = extractAsharaImports(content, filePath, packagesDir, pkgName);
      const pkgRelative = relativeTo(filePath);
      if (matchesAnyGlob(pkgRelative, rule.standIns) && !matchesAnyGlob(pkgRelative, rule.namedOnly)) {
        violations.push({
          file: path.relative(root, filePath),
          line: 0,
          fromPkg: pkgName,
          specifier: "stand-ins",
          reason: `a stand-in file must also be a named-only file (${rule.namedOnly.join(", ")})`,
        });
      }

      if (matchesAnyGlob(pkgRelative, rule.boundsTables)) {
        boundsTableFiles.push(filePath);
        const at = (line: number, specifier: string, reason: string): Violation => ({
          file: path.relative(root, filePath),
          line,
          fromPkg: pkgName,
          specifier,
          reason: `bounds-table file: ${reason}`,
        });
        if (!matchesAnyGlob(pkgRelative, rule.namedOnly)) violations.push(at(0, "bounds-tables", `a bounds-table file must also be a named-only file (${rule.namedOnly.join(", ")})`));
        // Each bound states its decision, never a production constant: nothing is imported, a type included.
        scanLines(content, PACKAGE_IMPORT_RE, (line, match) => violations.push(at(line, match[1], "it imports nothing from another package; each bound cites its decision instead")));
        scanLines(content, RELATIVE_IMPORT_RE, (line, match) => violations.push(at(line, match[1], "it imports no other file, which could hand it a production constant")));
      }

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
        if (matchesAnyGlob(pkgRelative, rule.standIns)) standInFiles.push(filePath);
        scanLines(content, RELATIVE_IMPORT_RE, (line, match) => {
          const target = path.relative(pkgRoot, path.resolve(path.dirname(filePath), match[1])).split(path.sep).join("/");
          // Another package's file reached by path would carry no names to check.
          if (target.startsWith("../") || path.isAbsolute(target)) {
            violations.push(at(line, match[1], "the relative import leaves the package; import another package by its @ashara/ name"));
            return;
          }
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

    for (const glob of rule.boundsTables) {
      if (!boundsTableFiles.some((filePath) => matchesAnyGlob(relativeTo(filePath), [glob]))) {
        violations.push({
          file: rulesRelative,
          line: 0,
          fromPkg: pkgName,
          specifier: "bounds-tables",
          reason: `"${glob}" matches no file; a bounds-table rule that holds nothing passes everything`,
        });
      }
    }
    if (rule.modules.size > 0) violations.push(...moduleViolations({ rule, pkgName, pkgRoot, root, rulesRelative, contents, relativeTo }));
    const standInNamesUsed = checkStandIns({ rule, pkgName, pkgRoot, root, contents, standInFiles, relativeTo, violations });
    for (const glob of rule.standIns) {
      if (!standInFiles.some((filePath) => matchesAnyGlob(relativeTo(filePath), [glob]))) {
        violations.push({
          file: rulesRelative,
          line: 0,
          fromPkg: pkgName,
          specifier: "stand-ins",
          reason: `"${glob}" matches no named-only file; a stand-in rule that holds nothing passes everything`,
        });
      }
    }
    for (const [importedPkg, listed] of rule.standInNames) {
      for (const name of listed) {
        if (standInNamesUsed.get(importedPkg)?.has(name) !== true) {
          violations.push({
            file: rulesRelative,
            line: 0,
            fromPkg: pkgName,
            specifier: `stand-in-names.${importedPkg}`,
            reason: `"${name}" is listed but no stand-in imports it; remove it`,
          });
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

  // Not an import rule, run here so it needs no gate of its own in `just check`: a price column with a
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
  violations.push(...simulatorRunBudgetViolations(root));

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
  // eslint-disable-next-line ashara/catch-continue -- best effort: the operator script exits 1 below with the error's chain
  console.error(`\nERROR: ${describeErrorChain(err)}\n`);
  process.exit(1);
}
