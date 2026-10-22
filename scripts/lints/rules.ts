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
 *   subpath-importers.<subpath> = [...] the only packages that may import `@ashara/<this>/<subpath>`
 *
 * The [stack-literals] and [tables] sections are no package's: the lints that read them parse them.
 */

import { STACK_LITERALS_SECTION } from "../stack-literals.js";
import { TABLES_SECTION } from "../table-ownership.js";

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
  /** subpath of this package -> the only packages that may import it; empty when the section states none. */
  readonly subpathImporters: ReadonlyMap<string, readonly string[]>;
}

/** The module that may import every other module and that none may import: the package's barrel. */
export const ENTRY_MODULE = "entry";

export type BoundaryRules = ReadonlyMap<string, PackageRule>;

function parseList(inner: string): string[] {
  const trimmed = inner.trim();
  if (trimmed === "") return [];
  return trimmed.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
}

export function parseRules(toml: string, rulesPath: string): BoundaryRules {
  const rules = new Map<
    string,
    {
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
      subpathImporters: Map<string, string[]>;
    }
  >();
  let currentSection: string | null = null;
  // The [stack-literals] and [tables] sections are not a package's rules; parseStackLiteralRules and
  // parseTableOwnershipRules read them.
  let inOtherSection = false;
  const lines = toml.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i].trim();

    if (line === "" || line.startsWith("#")) continue;

    const sectionMatch = /^\[([a-z][a-z0-9-]*)\]$/.exec(line);
    inOtherSection = sectionMatch ? sectionMatch[1] === STACK_LITERALS_SECTION || sectionMatch[1] === TABLES_SECTION : inOtherSection;
    if (inOtherSection) continue;
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!rules.has(currentSection)) {
        rules.set(currentSection, { allow: [], restrict: new Map(), entries: new Map(), importers: null, namedOnly: [], names: new Map(), standIns: [], standInNames: new Map(), boundsTables: [], modules: new Map(), moduleAllow: new Map(), moduleAllowFiles: new Map(), moduleEntry: new Map(), subpathImporters: new Map() });
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

    const entriesMatch = /^entries\.([a-z][a-z0-9-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (entriesMatch) {
      const entries = parseList(entriesMatch[2]);
      if (entries.length === 0) {
        throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "entries list is empty (use `allow` to forbid the package outright)");
      }
      rule.entries.set(entriesMatch[1], entries);
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

    const subpathMatch = /^subpath-importers\.([a-z0-9][a-z0-9/-]*)\s*=\s*\[([^\]]*)\]$/.exec(line);
    if (subpathMatch) {
      const importers = parseList(subpathMatch[2]);
      if (importers.length === 0) throw new BoundaryRulesParseError(rulesPath, lineNumber, line, "subpath-importers list is empty (drop the subpath from the exports instead)");
      if (rule.subpathImporters.has(subpathMatch[1])) throw new BoundaryRulesParseError(rulesPath, lineNumber, line, `subpath-importers.${subpathMatch[1]} is stated twice`);
      rule.subpathImporters.set(subpathMatch[1], importers);
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
    for (const [subpath, importers] of rule.subpathImporters) {
      for (const importer of importers) {
        if (!rules.has(importer)) throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] subpath-importers.${subpath}`, `names "${importer}", which has no section`);
      }
    }
    checkModuleRules(rulesPath, pkg, rule.modules, rule.moduleAllow, rule.moduleEntry);
    result.set(pkg, {
      allow: rule.allow,
      restrict: rule.restrict,
      entries: rule.entries,
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
      subpathImporters: rule.subpathImporters,
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
