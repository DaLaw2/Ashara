import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { TreeDigestError, treeDigest } from "./tree-digest.js";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

// Verdict files already written carry digests in this format; a change to it breaks their comparison with a prereg.
const FIXTURE_DIGEST = "sha256:44c1fe67928f9197dd3adac4432de8005949a648f852b85c75b919f96b59e77d";

const roots: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tree-digest-test-"));
  roots.push(root);
  return root;
}

type Step = (root: string) => Promise<void>;

const steps: Record<string, Step> = {
  file: (root) => writeFile(path.join(root, "a.txt"), "alpha\n", { mode: 0o644 }),
  executable: async (root) => {
    await mkdir(path.join(root, "bin"), { recursive: true });
    await writeFile(path.join(root, "bin", "run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  },
  link: (root) => symlink("a.txt", path.join(root, "link")),
  empty: async (root) => {
    await mkdir(path.join(root, "empty"));
  },
};

async function fixture(order: readonly string[]): Promise<string> {
  const root = await freshRoot();
  for (const name of order) {
    const step = steps[name];
    if (step === undefined) throw new TypeError(`no fixture step ${name}`);
    await step(root);
  }
  return root;
}

const ORDER = ["file", "executable", "link", "empty"];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("treeDigest", () => {
  test("a fixed tree has the digest recorded verdicts were written with", async () => {
    expect(await treeDigest(await fixture(ORDER))).toBe(FIXTURE_DIGEST);
  });

  test("the order entries were created in does not change the digest", async () => {
    const forward = await treeDigest(await fixture(ORDER));
    const backward = await treeDigest(await fixture([...ORDER].reverse()));
    expect(backward).toBe(forward);
  });

  test("a one-byte change of content changes the digest", async () => {
    const root = await fixture(ORDER);
    const before = await treeDigest(root);
    await writeFile(path.join(root, "a.txt"), "alphb\n");
    expect(await treeDigest(root)).not.toBe(before);
  });

  test("setting or clearing an executable bit changes the digest", async () => {
    const root = await fixture(ORDER);
    const before = await treeDigest(root);
    await chmod(path.join(root, "bin", "run"), 0o644);
    expect(await treeDigest(root)).not.toBe(before);
  });

  test("a symbolic link is recorded by its target text, never followed", async () => {
    const outside = await freshRoot();
    await writeFile(path.join(outside, "target"), "one\n");
    const root = await fixture(ORDER);
    await symlink(path.join(outside, "target"), path.join(root, "out"));
    const before = await treeDigest(root);
    await writeFile(path.join(outside, "target"), "two\n");
    expect(await treeDigest(root)).toBe(before);

    await rm(path.join(root, "link"));
    await symlink("bin/run", path.join(root, "link"));
    expect(await treeDigest(root)).not.toBe(before);

    await rm(path.join(outside, "target"));
    await expect(treeDigest(root)).resolves.toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("a missing root throws TreeDigestError naming it", async () => {
    const missing = path.join(await freshRoot(), "absent");
    const error = await treeDigest(missing).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TreeDigestError);
    expect(error).toMatchObject({ root: missing, entry: "." });
  });

  test("an unreadable directory below the root throws TreeDigestError naming the entry", async () => {
    if (process.getuid?.() === 0) return;
    const root = await fixture(ORDER);
    await chmod(path.join(root, "empty"), 0o000);
    try {
      const error = await treeDigest(root).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(TreeDigestError);
      expect(error).toMatchObject({ root, entry: "empty" });
    } finally {
      await chmod(path.join(root, "empty"), 0o700);
    }
  });
});

describe("one digest function", () => {
  test("hidden-suite.ts digests the suite and product with the exported treeDigest and defines no other", async () => {
    const source = await readFile(path.join(SCRIPTS, "hidden-suite.ts"), "utf8");
    expect(source).toContain('import { treeDigest } from "./tree-digest.js";');
    expect(source).toMatch(/const suiteDigest = await treeDigest\(/);
    expect(source).toMatch(/const productDigest = await treeDigest\(/);

    const definers: string[] = [];
    for (const name of await readdir(SCRIPTS)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = await readFile(path.join(SCRIPTS, name), "utf8");
      if (/function treeDigest\b|const treeDigest\b/.test(text)) definers.push(name);
    }
    expect(definers).toEqual(["tree-digest.ts"]);
  });
});
