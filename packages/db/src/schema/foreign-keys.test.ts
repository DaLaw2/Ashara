import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import { MIGRATIONS_DIR } from "../migrations.js";
import { deliveredReportAttempts } from "./engagement.js";

// The schema a repository builds its statements from states every foreign key the migrations create
// on the table, so a reader of the schema never takes a reference the database enforces for a loose id.

/** One foreign key as `column -> table(column) on delete`. */
function keyOf(column: string, table: string, foreignColumn: string, onDelete: string): string {
  return `${column} -> ${table}(${foreignColumn}) on delete ${onDelete.toLowerCase()}`;
}

/** Every foreign key a migration's CREATE TABLE of `table` states. */
function migratedKeys(table: string): string[] {
  const create = new RegExp(`CREATE TABLE public\\.${table} \\(([\\s\\S]*?)\\n\\);`);
  const key = /FOREIGN KEY \((\w+)\) REFERENCES public\.(\w+)\((\w+)\)(?: ON DELETE (CASCADE|SET NULL|RESTRICT))?/g;
  const keys: string[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"))) {
    const body = create.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
    if (body === null) continue;
    for (const match of body[1].matchAll(key)) keys.push(keyOf(match[1], match[2], match[3], match[4] ?? "no action"));
  }
  return keys.sort();
}

function schemaKeys(table: PgTable): string[] {
  return getTableConfig(table)
    .foreignKeys.map((fk) => {
      const reference = fk.reference();
      const [column] = reference.columns;
      const [foreignColumn] = reference.foreignColumns;
      return keyOf(column.name, getTableConfig(reference.foreignTable).name, foreignColumn.name, fk.onDelete ?? "no action");
    })
    .sort();
}

describe("delivered_report_attempts foreign keys", () => {
  test("the schema states every foreign key the migrations create, its sweep's among them", () => {
    const migrated = migratedKeys("delivered_report_attempts");
    expect(migrated).toContain("sweep_id -> acceptance_sweeps(id) on delete cascade");
    expect(schemaKeys(deliveredReportAttempts)).toEqual(migrated);
  });
});
