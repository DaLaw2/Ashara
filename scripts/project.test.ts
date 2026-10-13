import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

describe("scripts/project.ts unblock", () => {
  test("a malformed project id is refused by name before any database is reached", () => {
    const result = spawnSync("npx", ["tsx", "scripts/project.ts", "unblock", "not-a-uuid", "--reason", "cleared"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // Unreachable on purpose: the id must be refused before a connection is attempted.
      env: { ...process.env, DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid ProjectId in unblock <project-id> argument: expected a UUID, got "not-a-uuid"');
  });
});
