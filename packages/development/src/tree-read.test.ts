import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listTreeDir, readTreeFile, TreePathRefused } from "./tree-read.js";
import { readVerifyConfig, VerifyConfigParseError } from "./verify-config.js";

let base: string;
let tree: string;
let hostFile: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "tree-read-test-"));
  tree = join(base, "tree");
  await mkdir(tree);
  hostFile = join(base, "host-secret.txt");
  await writeFile(hostFile, "HOST-ONLY-CONTENT\n");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("readTreeFile", () => {
  test("a regular file reads, capped at maxBytes", async () => {
    await mkdir(join(tree, "src"));
    await writeFile(join(tree, "src", "a.txt"), "0123456789");
    expect(await readTreeFile(tree, "src/a.txt", 100)).toEqual({ kind: "file", text: "0123456789", truncated: false });
    expect(await readTreeFile(tree, "src/a.txt", 4)).toEqual({ kind: "file", text: "0123", truncated: true });
    expect(await readTreeFile(tree, "missing.txt", 100)).toEqual({ kind: "absent" });
  });

  test("a symlink to a host file is refused, naming the path and its target", async () => {
    await symlink(hostFile, join(tree, "NOTES"));
    const err = await readTreeFile(tree, "NOTES", 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TreePathRefused);
    expect(err).toMatchObject({ path: "NOTES", target: hostFile });
    expect(String(err)).not.toContain("HOST-ONLY-CONTENT");
  });

  test("a symlinked directory on the way is refused", async () => {
    await symlink(base, join(tree, "up"));
    await expect(readTreeFile(tree, "up/host-secret.txt", 1000)).rejects.toBeInstanceOf(TreePathRefused);
  });

  test("a path climbing out of the tree is refused before anything is opened", async () => {
    await expect(readTreeFile(tree, "../host-secret.txt", 1000)).rejects.toBeInstanceOf(TreePathRefused);
    await expect(readTreeFile(tree, hostFile, 1000)).rejects.toBeInstanceOf(TreePathRefused);
  });

  test("a FIFO is refused rather than blocking Z0", async () => {
    execFileSync("mkfifo", [join(tree, "pipe")]);
    await expect(readTreeFile(tree, "pipe", 1000)).rejects.toBeInstanceOf(TreePathRefused);
  });

  test("a symlinked verify.toml is a typed parse error caused by the refusal", async () => {
    await writeFile(join(base, "host-verify.toml"), '[checks]\nleak = "HOST-ONLY-CONTENT"\n');
    await symlink(join(base, "host-verify.toml"), join(tree, "verify.toml"));
    const err = await readVerifyConfig(tree).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerifyConfigParseError);
    expect(err instanceof Error ? err.cause : undefined).toBeInstanceOf(TreePathRefused);
  });
});

describe("listTreeDir", () => {
  test("reports a symlink as one, and refuses to list through one", async () => {
    await writeFile(join(tree, "README"), "hi");
    await symlink(base, join(tree, "link"));
    const entries = await listTreeDir(tree);
    expect(entries?.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "link", kind: "symlink" },
      { name: "README", kind: "file" },
    ]);
    await expect(listTreeDir(tree, "link")).rejects.toBeInstanceOf(TreePathRefused);
    expect(await listTreeDir(join(base, "nope"))).toBeNull();
  });
});
