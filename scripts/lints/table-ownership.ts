/**
 * A write to a table another context owns, or a read of one no allowed edge admits, against the owner
 * map of the rules file's [tables] section, itself held to the schema modules (scripts/table-ownership.ts):
 * a context writes only the tables it owns, and reads another's only through its typed read or a
 * reviewed exemption.
 */

import fs from "node:fs";
import path from "node:path";
import { DB_OWNER, SHARED_OWNER, TABLES_SECTION, declaredTables, findTableUses, parseTableOwnershipRules } from "../table-ownership.js";
import type { LintContext, Violation } from "./lint.js";
import { collectTsFiles } from "./source-files.js";

/** Packages whose source the table-ownership scan does not read: generic persistence, and the test harness. */
const OWNERSHIP_UNSCANNED = new Set(["db", "integration"]);

/**
 * The [tables] owner map held to the schema modules, every write of a table another package owns,
 * every read of one, in raw SQL or through drizzle's builder, no allowed edge admits, and every
 * edge table no read uses
 * (scripts/table-ownership.ts).
 */
function tableOwnershipViolations(root: string, packagesDir: string, packageDirs: readonly string[], toml: string, rulesRelative: string): Violation[] {
  const rules = parseTableOwnershipRules(toml, rulesRelative);
  const violations: Violation[] = [];
  const atRules = (table: string, reason: string): Violation => ({
    file: rulesRelative,
    // eslint-disable-next-line no-restricted-syntax -- policy default: line 0 names the rules file as a whole, as every rules-level finding here does
    line: rules.lines.get(table) ?? 0,
    fromPkg: TABLES_SECTION,
    specifier: table,
    reason,
  });

  const schemaDir = path.join(packagesDir, "db", "src", "schema");
  const identifiers = new Map<string, string>();
  const declared = new Set<string>();
  for (const name of fs.readdirSync(schemaDir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
    const module = name.slice(0, -".ts".length);
    const schemaPath = path.join(schemaDir, name);
    for (const table of declaredTables(fs.readFileSync(schemaPath, "utf-8"), schemaPath)) {
      identifiers.set(table.identifier, table.name);
      declared.add(table.name);
      const owner = rules.owners.get(table.name);
      const file = path.relative(root, schemaPath).split(path.sep).join("/");
      if (owner === undefined) {
        violations.push({ file, line: table.line, fromPkg: TABLES_SECTION, specifier: table.name, reason: `no [${TABLES_SECTION}] entry names its owner` });
        continue;
      }
      const admitted = packageDirs.includes(module) ? [module, SHARED_OWNER] : [DB_OWNER, SHARED_OWNER];
      if (!admitted.includes(owner)) {
        violations.push(atRules(table.name, `owned by "${owner}", but declared in schema/${name}, which admits ${admitted.map((a) => `"${a}"`).join(" or ")}`));
      }
    }
  }
  if (declared.size === 0) violations.push({ file: path.relative(root, schemaDir), line: 0, fromPkg: TABLES_SECTION, specifier: "schema", reason: "no table declared; an owner map held to nothing would pass" });
  for (const table of rules.owners.keys()) {
    if (!declared.has(table)) violations.push(atRules(table, "no schema module declares this table; remove its entry"));
  }

  const edgesUsed = new Set<string>();
  let scanned = 0;
  for (const pkgName of packageDirs.filter((pkg) => !OWNERSHIP_UNSCANNED.has(pkg))) {
    for (const filePath of collectTsFiles(path.join(packagesDir, pkgName, "src")).filter((file) => !file.endsWith(".test.ts"))) {
      scanned++;
      const file = path.relative(root, filePath).split(path.sep).join("/");
      for (const use of findTableUses(fs.readFileSync(filePath, "utf-8"), filePath, identifiers)) {
        const owner = rules.owners.get(use.table);
        if (owner === undefined || owner === pkgName || owner === SHARED_OWNER) continue;
        if (use.kind === "write") {
          violations.push({
            file,
            line: use.line,
            fromPkg: pkgName,
            specifier: use.table,
            reason: `writes a table "${owner}" owns: ${use.text}; go through ${owner}'s exported write entry`,
          });
          continue;
        }
        const edge = rules.edges.find((e) => e.file === file && e.tables.includes(use.table));
        if (edge !== undefined) {
          edgesUsed.add(`${edge.id}\0${use.table}`);
          continue;
        }
        violations.push({
          file,
          line: use.line,
          fromPkg: pkgName,
          specifier: use.table,
          reason: `${use.kind === "raw-read" ? "raw SQL" : "a drizzle builder"} reads a table "${owner}" owns: ${use.text}; read it through ${owner}'s typed read, or admit it in [${TABLES_SECTION}] as an allowed edge with its reason`,
        });
      }
    }
  }
  if (scanned === 0) violations.push({ file: "packages", line: 0, fromPkg: "*", specifier: TABLES_SECTION, reason: "no source module to scan for table writes; a scan of nothing would pass" });
  for (const edge of rules.edges) {
    for (const table of edge.tables) {
      if (!edgesUsed.has(`${edge.id}\0${table}`)) {
        violations.push({ file: rulesRelative, line: 0, fromPkg: TABLES_SECTION, specifier: `edge.${edge.id}`, reason: `"${table}" is allowed in ${edge.file}, but no read there names it; remove it` });
      }
    }
  }
  return violations;
}

export function run(context: LintContext): Violation[] {
  return tableOwnershipViolations(context.root, context.packagesDir, context.packageDirs, context.toml, context.rulesRelative);
}
