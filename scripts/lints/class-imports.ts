/**
 * Every class of a held package a file imports that its `classes.<pkg>` does not list, tests
 * included: a context receives another's verification jobs as ports from the composition root and
 * never constructs them. A namespace, default or dynamic import, any other edge that may load the
 * held package by no brace list (a require, a vitest loader, an import whose target no literal spells
 * whole), and a relative path into the held package, name no symbol, so each is a violation; a type-only
 * statement is erased at runtime and imports no class. A listed name that is no class of it, or that
 * no file imports, is a violation too, so the list only shrinks. The edges are read from each file's
 * syntax tree (import-targets.ts).
 */

import fs from "node:fs";
import path from "node:path";
import { exportLists, importEdges } from "../import-targets.js";
import type { LintContext, Violation } from "./lint.js";
import { collectTsFiles, isRelativeSpecifier, mayLoadAsharaPackage, shownTarget } from "./source-files.js";

const isTestFile = (filePath: string): boolean => filePath.endsWith(".test.ts");

const EXPORTED_CLASS_RE = /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;

/** Every class `pkg` exports from its non-test source, under its own name and under each name an `export { A as B }` gives it. */
function exportedClasses(packagesDir: string, pkg: string): Set<string> {
  const files = collectTsFiles(path.join(packagesDir, pkg, "src"))
    .filter((file) => !isTestFile(file))
    .map((file) => ({ file, content: fs.readFileSync(file, "utf-8") }));
  const classes = new Set(files.flatMap(({ content }) => [...content.matchAll(EXPORTED_CLASS_RE)].map((match) => match[1])));
  for (const { file, content } of files) {
    for (const list of exportLists(file, content)) {
      for (const entry of list.names) if (entry.alias !== entry.name && classes.has(entry.name)) classes.add(entry.alias);
    }
  }
  return classes;
}

export function run(context: LintContext): Violation[] {
  const { root, packagesDir, rules, rulesRelative } = context;
  const violations: Violation[] = [];
  for (const [pkg, rule] of rules) {
    for (const [held, listed] of rule.classImports) {
      const classes = exportedClasses(packagesDir, held);
      const used = new Set<string>();
      for (const name of listed) {
        if (!classes.has(name)) violations.push({ file: rulesRelative, line: 0, fromPkg: pkg, specifier: `classes.${held}`, reason: `"${name}" is no class "${held}" exports; remove it` });
      }
      const heldRoot = path.join(packagesDir, held);
      const files = ["src", "test"].map((dir) => path.join(packagesDir, pkg, dir)).filter((dir) => fs.existsSync(dir)).flatMap((dir) => collectTsFiles(dir));
      for (const filePath of files) {
        const content = fs.readFileSync(filePath, "utf-8");
        const file = path.relative(root, filePath).split(path.sep).join("/");
        const at = (line: number, specifier: string, reason: string): Violation => ({ file, line, fromPkg: pkg, specifier, reason: `classes.${held}: ${reason}` });
        for (const edge of importEdges(filePath, content)) {
          if (edge.target.kind === "static" && isRelativeSpecifier(edge.target.specifier)) {
            const target = path.relative(heldRoot, path.resolve(path.dirname(filePath), edge.target.specifier));
            if (!target.startsWith("..") && !path.isAbsolute(target)) violations.push(at(edge.line, edge.target.specifier, `a relative path into "${held}" names no symbol; import it by its @ashara/ name`));
            continue;
          }
          if (edge.typeOnly || !mayLoadAsharaPackage(edge.target, held)) continue;
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
