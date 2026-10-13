import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildContextMap } from "./context-map.js";
import { initHostRepo, runHostGit, targetRepo } from "./host-git.js";

const SECRET = "HOST-ONLY-CONTENT-7f3a";

let base: string;
let target: string;
let hostFile: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "context-map-test-"));
  target = join(base, "target");
  await mkdir(target);
  hostFile = join(base, "host-secret.txt");
  await writeFile(hostFile, `${SECRET}\n`);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("buildContextMap on a cell-written target", () => {
  test("a planted symlink never carries a host file into the brief; a regular file still reads", async () => {
    await writeFile(join(target, "README"), "regular manifest text");
    await symlink(hostFile, join(target, "NOTES"));
    await symlink(hostFile, join(target, "verify.toml"));
    await mkdir(join(target, "src"));
    await symlink(hostFile, join(target, "src", "main.c"));

    const map = await buildContextMap(target, "src/main.c");

    expect(map).toContain("regular manifest text");
    expect(map).not.toContain(SECRET);
    expect(map).not.toContain("## Entry Point");
  });

  test("an entry point outside the tree is not read", async () => {
    const map = await buildContextMap(target, "../host-secret.txt");
    expect(map).not.toContain(SECRET);
  });

  test("knows no manifest format: package.json is one more top-level file", async () => {
    await writeFile(join(target, "package.json"), JSON.stringify({ name: "app", dependencies: { left: "1" } }));
    const map = await buildContextMap(target);
    expect(map).not.toContain("## Dependencies");
    expect(map).toContain("--- package.json ---");
  });

  test("in a git repository the tree is what git lists: its ignore rules apply, links are not followed", async () => {
    await initHostRepo(target);
    await writeFile(join(target, ".gitignore"), "out/\n");
    await mkdir(join(target, "out"));
    await writeFile(join(target, "out", "artifact.bin"), "x");
    await mkdir(join(target, "lib"));
    await writeFile(join(target, "lib", "a.src"), "a");
    await symlink(base, join(target, "escape"));
    await runHostGit(targetRepo(target), ["add", "lib"]);

    const map = await buildContextMap(target);

    expect(map).toContain("lib/\nlib/a.src");
    expect(map).toContain("escape");
    expect(map).not.toContain("out/");
    expect(map).not.toContain("escape/");
    expect(map).not.toContain("host-secret.txt");
  });
});
