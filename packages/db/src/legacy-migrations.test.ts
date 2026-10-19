import { describe, expect, test } from "vitest";
import { LEGACY_MIGRATIONS, LegacyMigrationUnlisted, legacyMigrationFile } from "./legacy-migrations.js";

describe("legacyMigrationFile", () => {
  test("names the listed file of the schema change, number included", () => {
    const file = legacyMigrationFile("dev_session_attempt_evidence");
    expect(file).toMatch(/^\d{3}_dev_session_attempt_evidence\.sql$/);
    expect(LEGACY_MIGRATIONS.map((m) => m.filename)).toContain(file);
  });

  test("refuses a name no listed file carries, and a part of one", () => {
    expect(() => legacyMigrationFile("no_such_change")).toThrow(LegacyMigrationUnlisted);
    expect(() => legacyMigrationFile("attempt_evidence")).toThrow(LegacyMigrationUnlisted);
  });
});
