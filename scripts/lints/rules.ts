/**
 * The rules file's package sections, parsed fail closed: an unknown key, an empty list or a rule
 * naming no declared package or module is a parse error, never a gate that passes. Rule shapes:
 *   allow            = [...]        which packages this package may import
 *   restrict.<pkg>   = [glob, ...]  which files inside this package may import <pkg>
 *   entries.<pkg>    = [sub, ...]   the only entry points of <pkg> this package may import, each a
 *                                   subpath its package.json exports ("." names the package root);
 *                                   a relative import into <pkg> names none, so it is refused too
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
 *   module-names.<name> = ["<pkg>[/<subpath>]:<symbol>", ...] symbols of another package's entry that
 *                                   only the files of module <name> may import; each symbol is held by
 *                                   one module, and <pkg> must be in the allow list
 *   subpath-importers.<subpath> = [...] the only packages that may import `@ashara/<this>/<subpath>`
 *   test-only-subpaths = [...]      subpaths of this package that only a *.test.ts file may import,
 *                                   from any package or scripts/ by its `@ashara/` name, or from
 *                                   inside the package by a relative path to its entry file
 *   classes.<pkg>    = [...]        the only classes <pkg> exports (each name it exports, by any export
 *                                   form, whose symbol the checker finds is a class) that this package's files, tests
 *                                   included, may import by value; an `import type` names none, and
 *                                   a namespace, default or dynamic import of <pkg>, or a relative path
 *                                   into it, is refused, since the classes it reaches cannot be read
 *
 * The [stack-literals], [tables] and [homes] sections are no package's: the lints that read them parse them.
 */

import { STACK_LITERALS_SECTION } from "../stack-literals.js";
import { TABLES_SECTION } from "../table-ownership.js";
import { HOMES_SECTION } from "./language-homes.js";
import { MODULE_RULE_RE, checkModuleRules, parseModuleRule } from "./module-rules.js";
import type { RuleLine } from "./module-rules.js";
import { BoundaryRulesParseError } from "./rules-parse-error.js";


export interface PackageRule {
  readonly allow: readonly string[];
  /** importedPkg -> file globs (relative to the package root) permitted to import it. */
  readonly restrict: ReadonlyMap<string, readonly string[]>;
  /** importedPkg -> the only entry points of it ("." or an exported subpath) this package may import. */
  readonly entries: ReadonlyMap<string, readonly string[]>;
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
  /** module -> the symbols of another package's entries that only its files may import; empty when the section holds none. */
  readonly moduleNames: ReadonlyMap<string, readonly HeldName[]>;
  /** subpath of this package -> the only packages that may import it; empty when the section states none. */
  readonly subpathImporters: ReadonlyMap<string, readonly string[]>;
  /** Subpaths of this package that only a test file may import; empty when the section states none. */
  readonly testOnlySubpaths: readonly string[];
  /** importedPkg -> the only classes of it this package may import; absent: the package's classes are not held. */
  readonly classImports: ReadonlyMap<string, readonly string[]>;
}

export type BoundaryRules = ReadonlyMap<string, PackageRule>;

/** A symbol of another package's entry that only one module may import. */
export interface HeldName {
  /** The package the entry belongs to. */
  readonly pkg: string;
  /** The entry as imported, without `@ashara/`: the package, or `<pkg>/<subpath>`. */
  readonly entry: string;
  readonly name: string;
}

const HELD_NAME_RE = /^(([a-z][a-z0-9-]*)(?:\/[a-z0-9][a-z0-9/-]*)?):([A-Za-z_$][\w$]*)$/;

function parseList(inner: string): string[] {
  const trimmed = inner.trim();
  if (trimmed === "") return [];
  return trimmed.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
}

/** A section's rules as its lines are read into them. */
interface SectionRule {
  allow: string[];
  restrict: Map<string, string[]>;
  entries: Map<string, string[]>;
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
  moduleNames: Map<string, HeldName[]>;
  subpathImporters: Map<string, string[]>;
  testOnlySubpaths: string[];
  classImports: Map<string, string[]>;
}

export function parseRules(toml: string, rulesPath: string): BoundaryRules {
  const rules = new Map<string, SectionRule>();
  let currentSection: string | null = null;
  // The [stack-literals], [tables] and [homes] sections are not a package's rules; parseStackLiteralRules,
  // parseTableOwnershipRules and the language-homes lint read them.
  let inOtherSection = false;
  const lines = toml.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i].trim();

    if (line === "" || line.startsWith("#")) continue;

    const sectionMatch = /^\[([a-z][a-z0-9-]*)\]$/.exec(line);
    inOtherSection = sectionMatch ? sectionMatch[1] === STACK_LITERALS_SECTION || sectionMatch[1] === TABLES_SECTION || sectionMatch[1] === HOMES_SECTION : inOtherSection;
    if (inOtherSection) continue;
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!rules.has(currentSection)) {
        rules.set(currentSection, { allow: [], restrict: new Map(), entries: new Map(), importers: null, namedOnly: [], names: new Map(), standIns: [], standInNames: new Map(), boundsTables: [], modules: new Map(), moduleAllow: new Map(), moduleAllowFiles: new Map(), moduleEntry: new Map(), moduleNames: new Map(), subpathImporters: new Map(), testOnlySubpaths: [], classImports: new Map() });
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

    const at = { rulesPath, lineNumber, line };
    // Fail closed: a typo in a rule key must not silently disable the gate.
    if (!parseImportKey(rule, at) && !parseNamedKey(rule, at) && !parseModuleKey(rule, at)) {
      throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "unrecognised rule key");
    }
  }

  for (const [pkg, rule] of rules) checkSection(rulesPath, pkg, rule, rules);
  return rules;
}

/** A line of allow, importers, restrict or entries read into `rule`; false when the line is none of them. */
function parseImportKey(rule: SectionRule, at: RuleLine): boolean {
  const { rulesPath, lineNumber, line } = at;
  const allowMatch = /^allow\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (allowMatch) {
    rule.allow = parseList(allowMatch[1]);
    return true;
  }

  const importersMatch = /^importers\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (importersMatch) {
    rule.importers = parseList(importersMatch[1]);
    return true;
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
    return true;
  }

  const entriesMatch = /^entries\.([a-z][a-z0-9-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (entriesMatch) {
    const entries = parseList(entriesMatch[2]);
    if (entries.length === 0) {
      throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "entries list is empty (use `allow` to forbid the package outright)");
    }
    rule.entries.set(entriesMatch[1], entries);
    return true;
  }
  return false;
}

/** A line of the named-only files and the symbols they, the stand-ins and the bounds tables may import; false when the line is none of them. */
function parseNamedKey(rule: SectionRule, at: RuleLine): boolean {
  const { rulesPath, lineNumber, line } = at;
  const namedOnlyMatch = /^named-only\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (namedOnlyMatch) {
    rule.namedOnly = parseList(namedOnlyMatch[1]);
    if (rule.namedOnly.length === 0) {
      throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "named-only list is empty");
    }
    return true;
  }

  const namesMatch = /^names\.([a-z][a-z0-9-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (namesMatch) {
    const names = parseList(namesMatch[2]);
    if (names.length === 0) {
      throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "names list is empty (omit it to give the named-only files nothing)");
    }
    rule.names.set(namesMatch[1], names);
    return true;
  }

  const standInsMatch = /^stand-ins\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (standInsMatch) {
    rule.standIns = parseList(standInsMatch[1]);
    if (rule.standIns.length === 0) {
      throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "stand-ins list is empty");
    }
    return true;
  }

  const standInNamesMatch = /^stand-in-names\.([a-z][a-z0-9-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (standInNamesMatch) {
    const names = parseList(standInNamesMatch[2]);
    if (names.length === 0) {
      throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "stand-in-names list is empty (omit it to give the stand-ins nothing)");
    }
    rule.standInNames.set(standInNamesMatch[1], names);
    return true;
  }

  const boundsTablesMatch = /^bounds-tables\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (boundsTablesMatch) {
    rule.boundsTables = parseList(boundsTablesMatch[1]);
    if (rule.boundsTables.length === 0) {
      throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "bounds-tables list is empty");
    }
    return true;
  }
  return false;
}

/** A line of the internal modules, the subpaths' importers, the test-only subpaths or the held classes; false when the line is none of them. */
function parseModuleKey(rule: SectionRule, at: RuleLine): boolean {
  const { rulesPath, lineNumber, line } = at;
  const moduleMatch = MODULE_RULE_RE.exec(line);
  if (moduleMatch) {
    parseModuleRule(moduleMatch[1], moduleMatch[2], parseList(moduleMatch[3]), rule, at);
    return true;
  }

  const moduleNamesMatch = /^module-names\.([a-z][a-z0-9-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (moduleNamesMatch) {
    const items = parseList(moduleNamesMatch[2]);
    if (items.length === 0) throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "module-names list is empty");
    if (rule.moduleNames.has(moduleNamesMatch[1])) throw new BoundaryRulesParseError(rulesPath, lineNumber, line, `module-names.${moduleNamesMatch[1]} is stated twice`);
    rule.moduleNames.set(
      moduleNamesMatch[1],
      items.map((item) => {
        const held = HELD_NAME_RE.exec(item);
        if (held === null) throw new BoundaryRulesParseError(rulesPath, lineNumber, line, `"${item}" is not "<pkg>[/<subpath>]:<symbol>"`);
        return { pkg: held[2], entry: held[1], name: held[3] };
      }),
    );
    return true;
  }

  const subpathMatch = /^subpath-importers\.([a-z0-9][a-z0-9/-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (subpathMatch) {
    const importers = parseList(subpathMatch[2]);
    if (importers.length === 0) throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "subpath-importers list is empty (drop the subpath from the exports instead)");
    if (rule.subpathImporters.has(subpathMatch[1])) throw new BoundaryRulesParseError(rulesPath, lineNumber, line, `subpath-importers.${subpathMatch[1]} is stated twice`);
    rule.subpathImporters.set(subpathMatch[1], importers);
    return true;
  }

  const testOnlyMatch = /^test-only-subpaths\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (testOnlyMatch) {
    rule.testOnlySubpaths = parseList(testOnlyMatch[1]);
    if (rule.testOnlySubpaths.length === 0) throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "test-only-subpaths list is empty");
    return true;
  }

  const classesMatch = /^classes\.([a-z][a-z0-9-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
  if (classesMatch) {
    if (rule.classImports.has(classesMatch[1])) throw new BoundaryRulesParseError(rulesPath, lineNumber, line, `classes.${classesMatch[1]} is stated twice`);
    rule.classImports.set(classesMatch[1], parseList(classesMatch[2]));
    return true;
  }
  return false;
}

/** A section's rules held against each other and against the other sections, once every line is read. */
function checkSection(rulesPath: string, pkg: string, rule: SectionRule, rules: ReadonlyMap<string, SectionRule>): void {
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
  for (const entered of rule.entries.keys()) {
    if (!isWildcard && !rule.allow.includes(entered)) {
      throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] entries.${entered}`, `names entries of "${entered}", which is not in its allow list`);
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
  for (const held of rule.classImports.keys()) {
    if (!isWildcard && !rule.allow.includes(held)) {
      throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] classes.${held}`, `holds the classes of "${held}", which is not in its allow list`);
    }
  }
  for (const [subpath, importers] of rule.subpathImporters) {
    for (const importer of importers) {
      if (!rules.has(importer)) throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] subpath-importers.${subpath}`, `names "${importer}", which has no section`);
    }
  }
  checkModuleRules(rulesPath, pkg, rule.modules, rule.moduleAllow, rule.moduleEntry);
  checkHeldNames(rulesPath, pkg, rule, isWildcard);
}

/** Each held symbol names a module of the section and a package it may import, and one module holds it. */
function checkHeldNames(rulesPath: string, pkg: string, rule: SectionRule, isWildcard: boolean): void {
  const holders = new Map<string, string>();
  for (const [name, held] of rule.moduleNames) {
    if (!rule.modules.has(name)) throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] module-names.${name}`, `"${name}" is no module of the section`);
    for (const each of held) {
      if (!isWildcard && !rule.allow.includes(each.pkg)) {
        throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] module-names.${name}`, `holds a symbol of "${each.pkg}", which is not in its allow list`);
      }
      const key = `${each.entry}:${each.name}`;
      const holder = holders.get(key);
      if (holder !== undefined) throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] module-names.${name}`, `"${key}" is held by module ${holder} too; one module holds it`);
      holders.set(key, name);
    }
  }
}
