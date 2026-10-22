/**
 * The symbols of another package's entry that only one internal module of a package may import
 * (`module-names.<module>`): a table object whose every write and read belongs to one module. Every
 * other file of the package, tests included, that names a held symbol in an import or re-export of
 * its entry is a violation, and so is a namespace or default import of that entry, `export *` from
 * it, or any other reference to it (a dynamic import), each of which reaches the symbol by no name.
 * Inside the module, re-exporting a held symbol (`export { x }`, `export { x } from`) hands it to
 * every importer, so that is a violation too. A held symbol the entry does not export, or that no
 * file of the module imports, is a violation of the rules: the list names only what holds.
 * Blind spots: a file of the module that passes a held symbol on as a value (returns it, or stores it
 * in an exported object). A relative path into the held package is refused by subpath-entries.
 */

import fs from "node:fs";
import path from "node:path";
import { parseJson } from "@ashara/shared";
import type { LintContext, PackageScan, Violation } from "./lint.js";
import type { HeldName } from "./rules.js";
import { extractNamedImports, lineAt, matchesAnyGlob } from "./source-files.js";
import { PackageExportsSchema } from "./subpath-entries.js";

const EXPORTED_DECLARATION_RE = (name: string): RegExp => new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:const|let|var|function|async\\s+function|class|abstract\\s+class|enum)\\s+${name.replace(/\$/g, "\\$")}\\b`);
const EXPORT_LIST_RE = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;

/** The names a brace list states, each as the file knows it: `a as b` is `a`, `type a` is `a`. */
function listedNames(list: string): string[] {
  return list
    .split(",")
    .map((entry) => entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
    .filter((name) => name !== "");
}

/** The file an entry of a package resolves to by its package.json exports; null when it exports no such entry. */
function entryFile(packagesDir: string, held: HeldName): string | null {
  const manifest = path.join(packagesDir, held.pkg, "package.json");
  if (!fs.existsSync(manifest)) return null;
  const { exports } = parseJson(PackageExportsSchema, fs.readFileSync(manifest, "utf-8"), manifest);
  const subpath = held.entry === held.pkg ? "." : `./${held.entry.slice(held.pkg.length + 1)}`;
  const target = exports[subpath];
  return target === undefined ? null : path.join(packagesDir, held.pkg, target);
}

function exportsName(file: string, name: string): boolean {
  const content = fs.readFileSync(file, "utf-8");
  return EXPORTED_DECLARATION_RE(name).test(content) || [...content.matchAll(EXPORT_LIST_RE)].some((list) => listedNames(list[1]).includes(name));
}

function heldViolations(scan: PackageScan, module: string, held: readonly HeldName[], context: LintContext): Violation[] {
  const { root, packagesDir, rulesRelative } = context;
  const globs = scan.rule.modules.get(module);
  if (globs === undefined) return [];
  const violations: Violation[] = [];
  const rule = `module-names.${module}`;
  const imported = new Set<string>();
  for (const each of held) {
    const file = entryFile(packagesDir, each);
    if (file === null || !fs.existsSync(file) || !exportsName(file, each.name)) {
      violations.push({ file: rulesRelative, line: 0, fromPkg: scan.name, specifier: rule, reason: `"@ashara/${each.entry}" exports no "${each.name}"; a rule that holds nothing passes everything` });
    }
  }
  for (const [filePath, content] of scan.contents) {
    const file = path.relative(root, filePath).split(path.sep).join("/");
    const inModule = matchesAnyGlob(scan.relativeTo(filePath), globs);
    const at = (line: number, specifier: string, reason: string): Violation => ({ file, line, fromPkg: scan.name, specifier, reason: `${rule}: ${reason}` });
    const { imports, unaccounted } = extractNamedImports(content);
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
      if (!inModule && held.some((each) => reference.specifier === `@ashara/${each.entry}`)) {
        violations.push(at(reference.line, reference.specifier, "not an `import {...} from` statement, so the symbols it reaches cannot be checked"));
      }
    }
    if (!inModule) continue;
    for (const list of content.matchAll(EXPORT_LIST_RE)) {
      for (const each of held) {
        if (listedNames(list[1]).includes(each.name)) violations.push(at(lineAt(content, list.index), `@ashara/${each.entry}`, `re-exports "${each.name}", which hands it to every importer of the file`));
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
