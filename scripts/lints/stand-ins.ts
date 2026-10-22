/** The stand-in rule of a package section, followed file to file through relative value imports. */

import path from "node:path";
import type { Violation } from "./lint.js";
import type { PackageRule } from "./rules.js";
import { extractNamedImports, matchesAnyGlob, resolveRelative, valueRelativeImports } from "./source-files.js";

class StandInScanError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`stand-in scan: ${file}: ${reason}`);
    this.name = "StandInScanError";
  }
}

export interface StandInScope {
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
export function checkStandIns(scope: StandInScope): Map<string, Set<string>> {
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
