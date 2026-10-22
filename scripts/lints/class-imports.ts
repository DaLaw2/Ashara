/**
 * Every class of a held package a file imports that its `classes.<pkg>` does not list, tests
 * included: a context receives another's verification jobs as ports from the composition root and
 * never constructs them. A namespace, default or dynamic import, and a relative path into the held
 * package, name no symbol, so each is a violation; a listed name that is no class of it, or that no
 * file imports, is one too, so the list only shrinks.
 */

import fs from "node:fs";
import path from "node:path";
import type { LintContext, Violation } from "./lint.js";
import { ASHARA_LITERAL_RE, RELATIVE_IMPORT_RE, collectTsFiles, lineAt, scanLines } from "./source-files.js";

const isTestFile = (filePath: string): boolean => filePath.endsWith(".test.ts");

const EXPORTED_CLASS_RE = /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /\bexport\s*\{([^}]*)\}/g;

/** Every class `pkg` exports from its non-test source, under its own name and under each name an `export { A as B }` gives it. */
function exportedClasses(packagesDir: string, pkg: string): Set<string> {
  const files = collectTsFiles(path.join(packagesDir, pkg, "src")).filter((file) => !isTestFile(file)).map((file) => fs.readFileSync(file, "utf-8"));
  const classes = new Set(files.flatMap((content) => [...content.matchAll(EXPORTED_CLASS_RE)].map((match) => match[1])));
  for (const content of files) {
    for (const list of content.matchAll(EXPORT_LIST_RE)) {
      for (const entry of list[1].split(",")) {
        const [name, alias] = entry.trim().split(/\s+as\s+/).map((part) => part.trim());
        if (alias !== undefined && classes.has(name)) classes.add(alias);
      }
    }
  }
  return classes;
}

// A value import or re-export by a brace list, a namespace or a default binding; a statement that is
// `import type` or `export type` as a whole is erased at runtime and imports no class.
const CLASS_STATEMENT_RE =
  /\b(?:import|export)\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+[\w$]+|\*|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*(["'](@ashara\/([a-z][a-z0-9-]*)(?:\/[^"']*)?)["'])/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s*(["']@ashara\/[a-z][a-z0-9-]*(?:\/[^"']*)?["'])/g;

/** The value names a brace clause imports, `type` entries left out; null for a namespace or default binding, which names none. */
function valueNames(clause: string): string[] | null {
  if (!clause.startsWith("{")) return null;
  return clause
    .slice(1, -1)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !/^type\s/.test(entry))
    .map((entry) => entry.split(/\s+as\s+/)[0].trim());
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
        const accounted = new Set<number>();
        for (const match of content.matchAll(CLASS_STATEMENT_RE)) {
          const literalOffset = match.index + match[0].length - match[3].length;
          accounted.add(literalOffset);
          if (match[5] !== held || match[1] !== undefined) continue;
          const line = lineAt(content, literalOffset);
          const names = valueNames(match[2]);
          if (names === null) {
            violations.push(at(line, match[4], "a namespace or default import names no symbol, so a class could be reached through it; import the names in braces"));
            continue;
          }
          for (const name of names) {
            if (!classes.has(name)) continue;
            if (listed.includes(name)) {
              used.add(name);
              continue;
            }
            violations.push(at(line, match[4], `"${name}" is a class of "${held}" it does not list; receive it as a port the composition root builds`));
          }
        }
        for (const match of content.matchAll(SIDE_EFFECT_IMPORT_RE)) accounted.add(match.index + match[0].length - match[1].length);
        for (const match of content.matchAll(ASHARA_LITERAL_RE)) {
          if (match[2] !== held || accounted.has(match.index)) continue;
          violations.push(at(lineAt(content, match.index), match[1], "not an `import {...} from` statement, so the classes it reaches cannot be checked"));
        }
        scanLines(content, RELATIVE_IMPORT_RE, (line, match) => {
          const target = path.relative(heldRoot, path.resolve(path.dirname(filePath), match[1]));
          if (!target.startsWith("..") && !path.isAbsolute(target)) violations.push(at(line, match[1], `a relative path into "${held}" names no symbol; import it by its @ashara/ name`));
        });
      }
      for (const name of listed) {
        if (classes.has(name) && !used.has(name)) violations.push({ file: rulesRelative, line: 0, fromPkg: pkg, specifier: `classes.${held}`, reason: `"${name}" is listed but no file imports it; remove it` });
      }
    }
  }
  return violations;
}
