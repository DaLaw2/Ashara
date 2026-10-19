import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..");

// The numbered files before the init were squashed into it, so a numbered migration named in source
// points at a file no checkout has, or at a later file by a number that goes stale. The frozen
// manifest lists the squashed files by name as data the baseline check reads.
const NUMBERED_MIGRATION = "[Mm]igrations? [0-9]{3}|migrations/[0-9]{3}_";
const MANIFEST = "packages/db/src/legacy-migrations.ts";

describe("numbered migrations", () => {
  test("migrations/ starts from the init, and every file is a numbered SQL migration", () => {
    const files = readdirSync(join(REPO, "migrations")).sort();
    expect(files[0]).toBe("000_init.sql");
    expect(files.filter((file) => !/^[0-9]{3}_[a-z0-9_]+\.sql$/.test(file))).toEqual([]);
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
