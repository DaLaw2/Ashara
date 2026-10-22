/**
 * Statically checks cross-package imports in src/ and test/ (test files
 * included) against the allowed matrix in boundary-rules.toml. A
 * cross-package import is an `@ashara/<pkg>` specifier (with or without a
 * subpath) or a relative specifier that resolves into another package
 * directory; a relative specifier that resolves outside packages/ is itself a
 * violation. Only single-line `from`/`import` specifiers are recognised.
 *
 * A package that states `subpath-importers` is reached only by its root entry and the subpaths it
 * lists: each subpath its package.json exports needs a list and each list an exported subpath, an
 * import of a subpath by a package its list does not name is a violation, and so is a relative path
 * into the package from another one (it reaches the files around their lists) and any import of a
 * listed subpath from scripts/, whose files are read for that alone. A subpath whose entry declares
 * tables (`pgTable`) is held to the [tables] owner map: it may list only the package that owns each
 * table it declares, plus a package that composes every context (`allow = ["*"]`) or that none may
 * import (`importers = []`); and the root entry, with every file it re-exports from by a relative
 * `export ... from`, may declare no table a package owns. So a context's table object is importable
 * only by its owner, and a drizzle builder read of another context's table cannot be written. The
 * relational read `db.query.<table>` names no table object, so no import is seen here: the shared
 * Database handle is built without a schema, its `query` names no table, and the type checker
 * refuses that read.
 *
 * A named-only file is read whole, not line by line: every `@ashara/` specifier in it must be the
 * tail of an `import {...} from` or `export {...} from` statement whose every name is listed, a
 * relative import may not leave the named-only files, and a listed name no named-only file imports
 * is itself a violation, so the list never grows past what is used (a simulator oracle
 * never imports the production predicate it judges). A stand-in is held to `stand-in-names` through
 * its relative value imports too, followed file to file, so a helper cannot hand it a product rule;
 * an `import type` edge carries no runtime code and is not followed. A stand-in glob that matches no
 * file, or matches a file outside the named-only files, is a violation.
 */

import path from "node:path";
import type { LintContext, PackageScan, Violation } from "./lint.js";
import type { BoundaryRules } from "./rules.js";
import {
  PACKAGE_IMPORT_RE,
  RELATIVE_IMPORT_RE,
  extractAsharaImports,
  extractNamedImports,
  matchesAnyGlob,
  scanLines,
} from "./source-files.js";
import { checkStandIns } from "./stand-ins.js";

/**
 * Why `importer` may not import `specifier` of `pkg` under its subpath-importers; null when it may or
 * the package states none. A relative specifier into the package reaches its files around the lists.
 */
function subpathRefusalOf(rules: BoundaryRules, pkg: string, specifier: string, importer: string): string | null {
  const lists = rules.get(pkg)?.subpathImporters;
  if (lists === undefined || lists.size === 0) return null;
  const prefix = `@ashara/${pkg}`;
  if (!specifier.startsWith(prefix)) return `a relative path into package "${pkg}", whose subpaths admit only the importers its subpath-importers list; import it by its @ashara/ name`;
  if (specifier === prefix) return null;
  const subpath = specifier.slice(prefix.length + 1);
  const admitted = lists.get(subpath);
  if (admitted === undefined) return `package "${pkg}" states no subpath-importers.${subpath}, so no package may import it`;
  return admitted.includes(importer) ? null : `only [${admitted.join(", ")}] may import "${specifier}" (subpath-importers.${subpath})`;
}

/** One package's imports held to its section: the matrix, its named-only, stand-in and bounds-table files. */
function packageViolations(context: LintContext, pkg: PackageScan): Violation[] {
  const { root, packagesDir, rulesRelative, rules } = context;
  const { name: pkgName, rule, root: pkgRoot, contents, relativeTo } = pkg;
  const violations: Violation[] = [];

  // Wildcard: all imports allowed (composition root)
  const isWildcard = rule.allow.length === 1 && rule.allow[0] === "*";

  const namesUsed = new Map<string, Set<string>>();
  const standInFiles: string[] = [];
  const boundsTableFiles: string[] = [];

  for (const [filePath, content] of contents) {
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
        continue;
      }

      const subpathRefusal = subpathRefusalOf(rules, ref.pkg, ref.specifier, pkgName);
      if (subpathRefusal !== null) violations.push(violation(subpathRefusal));
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
  return violations;
}

/** Every package's imports held to its section of the rules file. */
export function run(context: LintContext): Violation[] {
  return context.packages.flatMap((pkg) => packageViolations(context, pkg));
}
