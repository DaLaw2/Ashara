/**
 * Every class of a held package a file imports that its `classes.<pkg>` does not list, tests
 * included: a context receives another's verification jobs as ports from the composition root and
 * never constructs them. A namespace, default or dynamic import, any other edge that may load the
 * held package by no brace list (a require, a vitest loader, an import whose target no literal spells
 * whole), and a relative path into the held package, name no symbol, so each is a violation; a type-only
 * statement is erased at runtime and imports no class, and a program run loads in a process of its own,
 * where no class it reaches is constructed by the file. A listed name that is no class of it, or that
 * no file imports, is a violation too, so the list only shrinks.
 *
 * Both sides are read from the gate's one program (lint.ts contextProgram): a held package's classes
 * are the names its non-test src/ modules export, by any form (a declaration, an `export { A as B }`
 * list, a re-export), whose symbol the checker finds, through every alias, to be a class; each file's
 * edges are its edges in that program (import-targets.ts).
 */

import path from "node:path";
import ts from "typescript";
import { moduleEdges } from "../import-targets.js";
import type { ModuleProgram } from "../module-program.js";
import { contextProgram, type LintContext, type Violation } from "./lint.js";
import { bindsInModule, isRelativeSpecifier, mayLoadAsharaPackage, shownTarget } from "./source-files.js";

const isTestFile = (filePath: string): boolean => filePath.endsWith(".test.ts");

/** Every name a non-test module of `held`'s src/ exports whose symbol, through its aliases, is a class. */
function exportedClasses(context: LintContext, built: ModuleProgram, held: string): Set<string> {
  const classes = new Set<string>();
  const scan = context.packages.find((pkg) => pkg.name === held);
  if (scan === undefined) return classes;
  const checker = built.checker;
  for (const filePath of scan.contents.keys()) {
    if (!scan.relativeTo(filePath).startsWith("src/") || isTestFile(filePath)) continue;
    const source = built.sourceFile(filePath);
    const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const target = (exported.flags & ts.SymbolFlags.Alias) === 0 ? exported : checker.getAliasedSymbol(exported);
      if ((target.flags & ts.SymbolFlags.Class) !== 0) classes.add(exported.name);
    }
  }
  return classes;
}

export function run(context: LintContext): Violation[] {
  const { root, packagesDir, rulesRelative } = context;
  const built = contextProgram(context);
  const violations: Violation[] = [];
  for (const { name: pkg, rule, contents } of context.packages) {
    for (const [held, listed] of rule.classImports) {
      const classes = exportedClasses(context, built, held);
      const used = new Set<string>();
      for (const name of listed) {
        if (!classes.has(name)) violations.push({ file: rulesRelative, line: 0, fromPkg: pkg, specifier: `classes.${held}`, reason: `"${name}" is no class "${held}" exports; remove it` });
      }
      const heldRoot = path.join(packagesDir, held);
      for (const filePath of contents.keys()) {
        const file = path.relative(root, filePath).split(path.sep).join("/");
        const at = (line: number, specifier: string, reason: string): Violation => ({ file, line, fromPkg: pkg, specifier, reason: `classes.${held}: ${reason}` });
        for (const edge of moduleEdges(built, filePath, file)) {
          if (edge.target.kind === "static" && isRelativeSpecifier(edge.target.specifier)) {
            const target = path.relative(heldRoot, path.resolve(path.dirname(filePath), edge.target.specifier));
            if (!target.startsWith("..") && !path.isAbsolute(target)) violations.push(at(edge.line, edge.target.specifier, `a relative path into "${held}" names no symbol; import it by its @ashara/ name`));
            continue;
          }
          if (edge.typeOnly || !bindsInModule(edge) || !mayLoadAsharaPackage(edge.target, held)) continue;
          const specifier = shownTarget(edge.target);
          const statement = edge.form === "import" || edge.form === "export";
          if (statement && edge.target.kind === "static" && edge.clause.kind === "none") continue;
          if (!statement || edge.target.kind !== "static") {
            violations.push(at(edge.line, specifier, "not an `import {...} from` statement, so the classes it reaches cannot be checked"));
            continue;
          }
          if (edge.clause.kind !== "names") {
            violations.push(at(edge.line, specifier, "a namespace or default import names no symbol, so a class could be reached through it; import the names in braces"));
            continue;
          }
          for (const { name } of edge.clause.names.filter((entry) => !entry.typeOnly)) {
            if (!classes.has(name)) continue;
            if (listed.includes(name)) {
              used.add(name);
              continue;
            }
            violations.push(at(edge.line, specifier, `"${name}" is a class of "${held}" it does not list; receive it as a port the composition root builds`));
          }
        }
      }
      for (const name of listed) {
        if (classes.has(name) && !used.has(name)) violations.push({ file: rulesRelative, line: 0, fromPkg: pkg, specifier: `classes.${held}`, reason: `"${name}" is listed but no file imports it; remove it` });
      }
    }
  }
  return violations;
}
