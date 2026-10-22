/**
 * The projects row holds the tender's identity, its workspace and Engagement's lifecycle, nothing a
 * context keeps per project: each context's per-project state is a table of its own, which [tables]
 * in boundary-rules.toml gives its one owner and [db] subpath-importers keep inside that owner.
 * - The `projects` table packages/db/src/schema/project.ts declares has exactly the columns below.
 * - No scanned package file outside packages/db/src/schema names a planning, halt-cause or
 *   acceptance-fault field on `projects`, whether as a drizzle property or a raw SQL column.
 *
 * Blind spots: a raw SQL read of such a column under a table alias (`p.plan_attempts`), and a file
 * under scripts/, are not read; the migration that dropped the columns fails either at runtime.
 */

import fs from "node:fs";
import path from "node:path";
import type { LintContext, Violation } from "./lint.js";

const PROJECT_RECORD_COLUMNS = ["id", "name", "lifecycle", "clientId", "createdAt", "workspacePath"] as const;

const FOREIGN_FIELD = /\bprojects\.(plan\w*|replan\w*|blocked\w*|first_?[pP]lanned\w*|acceptance_?[fF]aults)\b/g;

const SCHEMA_DIR = path.join("packages", "db", "src", "schema");

function violation(file: string, line: number, specifier: string, reason: string): Violation {
  return { file, line, fromPkg: file.split(path.sep)[1] ?? file, specifier, reason };
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** The property names of the object literal `pgTable("projects", {...})` declares, or null when there is none. */
function declaredColumns(schema: string): { readonly names: readonly string[]; readonly line: number } | null {
  const start = schema.indexOf('pgTable("projects", {');
  if (start < 0) return null;
  const body = schema.slice(start, schema.indexOf("\n});", start));
  const names = [...body.matchAll(/^ {2}(\w+):/gm)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  return { names, line: lineOf(schema, start) };
}

export function run(context: LintContext): Violation[] {
  const { root } = context;
  const violations: Violation[] = [];
  const schemaFile = path.join(SCHEMA_DIR, "project.ts");
  const schemaPath = path.join(root, schemaFile);
  const declared = fs.existsSync(schemaPath) ? declaredColumns(fs.readFileSync(schemaPath, "utf-8")) : null;
  if (declared === null) {
    violations.push(violation(schemaFile, 0, "projects", "no pgTable(\"projects\", {...}) declaration to check; a check of nothing would pass"));
  } else {
    const expected = [...PROJECT_RECORD_COLUMNS].sort();
    const actual = [...declared.names].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      violations.push(
        violation(schemaFile, declared.line, "projects", `projects declares [${actual.join(", ")}]; the project record holds only [${expected.join(", ")}]`),
      );
    }
  }
  for (const pkg of context.packages) {
    for (const [filePath, text] of pkg.contents) {
      const file = path.relative(root, filePath);
      if (file.startsWith(SCHEMA_DIR + path.sep)) continue;
      for (const match of text.matchAll(FOREIGN_FIELD)) {
        violations.push(
          violation(file, lineOf(text, match.index), match[0], "the projects row holds no per-context state: read it from its owner's table through the owner's published read"),
        );
      }
    }
  }
  return violations;
}
