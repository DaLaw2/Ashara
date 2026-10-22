/**
 * A package that declares `module.*` is checked inside, against its modules. Every .ts file under
 * its src/ belongs to exactly one module: a test file to its subject's (`x.test.ts` and
 * `x.<tag>.test.ts` to `x.ts`), any other file to the one module whose glob it matches. A file that
 * matches none, or two, is a violation, and so is a module glob that matches no file. Every relative
 * specifier between two of its modules is checked, `import type` included (a type is language): the
 * importer's `module-allow` must list the target, a target it lists by `<module>:<glob>` admits only
 * those files to it, and a target with `module-entry` admits only those files to any module. The module named `entry` (the barrel) may import every module, and no module may import it.
 * A `module-allow` graph with a cycle is a parse error, so a cycle between modules cannot return.
 * Blind spots: a computed dynamic import, and what is placed inside one file, are not seen.
 */

import path from "node:path";
import type { LintContext, Violation } from "./lint.js";
import { ENTRY_MODULE } from "./rules.js";
import type { PackageRule } from "./rules.js";
import { RELATIVE_LITERAL_RE, lineAt, matchesAnyGlob, resolveRelative } from "./source-files.js";

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

/** Every package that declares `module.*` held to its internal module rules. */
export function run(context: LintContext): Violation[] {
  return context.packages.flatMap(({ name, rule, root: pkgRoot, contents, relativeTo }) =>
    rule.modules.size === 0 ? [] : moduleViolations({ rule, pkgName: name, pkgRoot, root: context.root, rulesRelative: context.rulesRelative, contents, relativeTo }),
  );
}
