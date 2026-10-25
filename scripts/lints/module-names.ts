/**
 * The symbols of another package's entry that only one internal module of a package may import
 * (`module-names.<module>`): a table object whose every write and read belongs to one module. Every
 * other file of the package, tests included, that names a held symbol in an import or re-export of
 * its entry is a violation, and so is a namespace or default import of that entry, `export *` from
 * it, or any other edge that may load it (a dynamic import, a require, a vitest loader, an import
 * whose target no literal spells whole), each of which reaches the symbol by no name. Edges and
 * export lists are read from each file's syntax tree (import-targets.ts), and what an entry exports
 * from the gate's one program (lint.ts contextProgram): the names the checker finds in the export
 * table of the module the entry's specifier resolves to, by any export form.
 * Inside the module, re-exporting a held symbol (`export { x }`, `export { x } from`) hands it to
 * every importer, so that is a violation too. A held symbol the entry does not export, or that no
 * file of the module imports, is a violation of the rules: the list names only what holds.
 * Blind spots: a file of the module that passes a held symbol on as a value (returns it, or stores it
 * in an exported object). A relative path into the held package is refused by subpath-entries.
 */

import path from "node:path";
import { exportLists } from "../import-targets.js";
import { contextProgram, type LintContext, type PackageScan, type Violation } from "./lint.js";
import type { HeldName } from "./rules.js";
import { extractNamedImports, matchesAnyGlob, mayNameAshara } from "./source-files.js";

/** Whether the module `@ashara/<entry>` resolves to, from the scanned package at `from`, exports `name` by any export form; false when it resolves to no module of the program. */
function entryExports(context: LintContext, from: string, held: HeldName): boolean {
  const built = contextProgram(context);
  const moduleSymbol = built.moduleSymbol(path.join(from, "index.ts"), `@ashara/${held.entry}`);
  return moduleSymbol !== undefined && built.checker.getExportsOfModule(moduleSymbol).some((exported) => exported.name === held.name);
}

function heldViolations(scan: PackageScan, module: string, held: readonly HeldName[], context: LintContext): Violation[] {
  const { root, rulesRelative } = context;
  const globs = scan.rule.modules.get(module);
  if (globs === undefined) return [];
  const violations: Violation[] = [];
  const rule = `module-names.${module}`;
  const imported = new Set<string>();
  for (const each of held) {
    if (!entryExports(context, scan.root, each)) {
      violations.push({ file: rulesRelative, line: 0, fromPkg: scan.name, specifier: rule, reason: `"@ashara/${each.entry}" exports no "${each.name}"; a rule that holds nothing passes everything` });
    }
  }
  for (const [filePath, content] of scan.contents) {
    const file = path.relative(root, filePath).split(path.sep).join("/");
    const inModule = matchesAnyGlob(scan.relativeTo(filePath), globs);
    const at = (line: number, specifier: string, reason: string): Violation => ({ file, line, fromPkg: scan.name, specifier, reason: `${rule}: ${reason}` });
    const { imports, unaccounted } = extractNamedImports(filePath, content);
    for (const statement of imports) {
      const entryHeld = held.filter((each) => statement.specifier === `@ashara/${each.entry}`);
      if (entryHeld.length === 0) continue;
      if (statement.names === null) {
        if (!inModule) violations.push(at(statement.line, statement.specifier, `a namespace or default import names no symbol, so ${entryHeld.map((each) => `"${each.name}"`).join(", ")} could be reached through it; import the names in braces`));
        continue;
      }
      for (const each of entryHeld) {
        if (!statement.names.includes(each.name)) continue;
        if (inModule) imported.add(`${each.entry}:${each.name}`);
        else violations.push(at(statement.line, statement.specifier, `only module ${module} may import "${each.name}" of "@ashara/${each.entry}"; go through its entries`));
      }
    }
    for (const reference of unaccounted) {
      if (!inModule && held.some((each) => mayNameAshara(reference.target, each.entry))) {
        violations.push(at(reference.line, reference.specifier, "not an `import {...} from` statement, so the symbols it reaches cannot be checked"));
      }
    }
    if (!inModule) continue;
    for (const list of exportLists(filePath, content)) {
      for (const each of held) {
        if (list.names.some((entry) => entry.name === each.name)) violations.push(at(list.line, `@ashara/${each.entry}`, `re-exports "${each.name}", which hands it to every importer of the file`));
      }
    }
  }
  for (const each of held) {
    if (!imported.has(`${each.entry}:${each.name}`)) {
      violations.push({ file: rulesRelative, line: 0, fromPkg: scan.name, specifier: rule, reason: `no file of module ${module} imports "${each.name}" of "@ashara/${each.entry}"; remove it` });
    }
  }
  return violations;
}

export function run(context: LintContext): Violation[] {
  return context.packages.flatMap((scan) => [...scan.rule.moduleNames].flatMap(([module, held]) => heldViolations(scan, module, held, context)));
}
