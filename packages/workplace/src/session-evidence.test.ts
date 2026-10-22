import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { INIT_MIGRATION, legacyMigrationFile } from "@ashara/db";
import { attemptMigrations } from "./session-evidence.js";

describe("the migrations that create the attempt columns", () => {
  test("are the listed numbered file of the attempt-evidence change and the init", () => {
    expect(attemptMigrations()).toEqual([legacyMigrationFile("dev_session_attempt_evidence"), INIT_MIGRATION]);
    expect(attemptMigrations()[0]).toMatch(/^\d{3}_dev_session_attempt_evidence\.sql$/);
  });

  test("no workplace source spells a numbered migration file; the list of them owns the numbers", () => {
    const spelled = readdirSync(import.meta.dirname)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => /\d{3}_[a-z0-9_]+\.sql/.test(readFileSync(join(import.meta.dirname, file), "utf8")));
    expect(spelled).toEqual([]);
  });
});
