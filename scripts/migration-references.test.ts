import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..");

// migrations/ holds only the init, so a numbered migration named in source points at a file no
// checkout has. The frozen manifest lists those files by name as data the baseline check reads.
const NUMBERED_MIGRATION = "[Mm]igrations? [0-9]{3}|migrations/[0-9]{3}_";
const MANIFEST = "packages/db/src/legacy-migrations.ts";

describe("numbered migrations", () => {
  test("migrations/ holds the init alone", () => {
    expect(readdirSync(join(REPO, "migrations"))).toEqual(["000_init.sql"]);
  });

  test("no tracked source under packages/ or scripts/ names one, outside the frozen manifest", () => {
    const grep = spawnSync("git", ["grep", "-nE", NUMBERED_MIGRATION, "--", "packages", "scripts", `:!${MANIFEST}`], {
      cwd: REPO,
      encoding: "utf-8",
    });
    // git grep exits 1 when nothing matches and 2 or more when it could not search.
    expect([0, 1], grep.stderr).toContain(grep.status);
    expect(grep.stdout.split("\n").filter((line) => line !== "")).toEqual([]);
  });
});
