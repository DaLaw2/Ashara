import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { interfaceStandingOnMain } from "./public-interface.js";

const PLACEHOLDER = "Run: kv put <key> <value>\nThe product is a placeholder: every command exits 2.\n";

describe("interfaceStandingOnMain", () => {
  test("names a main still holding the scaffold's file byte for byte or holding none, and passes one whose file changed", async () => {
    const repo = await mkdtemp(join(tmpdir(), "interface-standing-test-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main");
      await writeFile(join(repo, "PUBLIC_INTERFACE.md"), PLACEHOLDER);
      git("add", "-A");
      git("commit", "-q", "-m", "scaffold");
      const scaffold = git("rev-parse", "HEAD");
      await writeFile(join(repo, "store.txt"), "an implementation that left the interface file alone\n");
      git("add", "-A");
      git("commit", "-q", "-m", "implement");
      const stale = git("rev-parse", "HEAD");
      await writeFile(join(repo, "PUBLIC_INTERFACE.md"), "Run: kv put <key> <value>\nStores the value; exits 0.\n");
      git("commit", "-q", "-am", "describe");
      const described = git("rev-parse", "HEAD");
      git("rm", "-q", "PUBLIC_INTERFACE.md");
      git("commit", "-q", "-m", "drop");
      const dropped = git("rev-parse", "HEAD");
      const scaffolds = [{ taskId: "s1", mergeCommit: scaffold }];

      expect(await interfaceStandingOnMain(repo, stale, scaffolds)).toEqual({
        kind: "scaffold-placeholder",
        file: "PUBLIC_INTERFACE.md",
        scaffoldTaskId: "s1",
        scaffoldCommit: scaffold,
      });
      expect(await interfaceStandingOnMain(repo, described, scaffolds)).toEqual({ kind: "changed" });
      // A main with no interface file states no interface: never read as described, with or without scaffolds.
      expect(await interfaceStandingOnMain(repo, dropped, scaffolds)).toEqual({ kind: "absent", file: "PUBLIC_INTERFACE.md" });
      expect(await interfaceStandingOnMain(repo, dropped, [])).toEqual({ kind: "absent", file: "PUBLIC_INTERFACE.md" });
      // A scaffold that wrote no such file leaves nothing of its own on main.
      expect(await interfaceStandingOnMain(repo, stale, [{ taskId: "s0", mergeCommit: dropped }])).toEqual({ kind: "changed" });
      await expect(interfaceStandingOnMain(repo, "--output=/tmp/x", scaffolds)).rejects.toMatchObject({ name: "InterfaceCommitInvalid" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
