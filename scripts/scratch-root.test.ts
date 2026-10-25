import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { pinTmpdirToScratchRoot } from "./scratch-root-guard.js";
import { ScratchRootConfigError, ScratchRootUnavailableError, resolveScratchRoot } from "./scratch-root.js";
import type { ScratchRootDeps } from "./scratch-root.js";

const GIB = 1024 ** 3;
const roots: string[] = [];

async function fakeShm(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "scratch-root-test-")));
  roots.push(dir);
  return dir;
}

function deps(shm: string, env: ScratchRootDeps["env"] = {}, freeBytes = 8 * GIB): ScratchRootDeps {
  return { env, shm, statfs: () => ({ bavail: freeBytes / 4096, bsize: 4096 }) };
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new TypeError("expected the call to throw");
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("resolveScratchRoot", () => {
  test("defaults to ashara-scratch on the tmpfs, creating it", async () => {
    const shm = await fakeShm();
    expect(resolveScratchRoot(deps(shm))).toBe(path.join(shm, "ashara-scratch"));
  });

  test("ASHARA_SCRATCH_ROOT names the root instead", async () => {
    const shm = await fakeShm();
    const configured = path.join(shm, "elsewhere");
    await mkdir(configured);
    expect(resolveScratchRoot(deps(path.join(shm, "no-shm"), { ASHARA_SCRATCH_ROOT: configured }))).toBe(configured);
  });

  test("an absent tmpfs throws, never falling back to the system temp directory", async () => {
    const shm = path.join(await fakeShm(), "no-shm");
    const error = thrown(() => resolveScratchRoot(deps(shm)));
    expect(error).toBeInstanceOf(ScratchRootUnavailableError);
    expect(error).toMatchObject({ root: path.join(shm, "ashara-scratch"), reason: "absent", bytesFree: null });
  });

  test("a configured root that does not exist throws absent, and is not created", async () => {
    const shm = await fakeShm();
    const missing = path.join(shm, "missing");
    const error = thrown(() => resolveScratchRoot(deps(shm, { ASHARA_SCRATCH_ROOT: missing })));
    expect(error).toMatchObject({ name: "ScratchRootUnavailableError", root: missing, reason: "absent" });
    await expect(realpath(missing)).rejects.toThrow();
  });

  test("free space below the bound throws full with both byte counts", async () => {
    const shm = await fakeShm();
    const error = thrown(() => resolveScratchRoot(deps(shm, {}, GIB)));
    expect(error).toBeInstanceOf(ScratchRootUnavailableError);
    expect(error).toMatchObject({ root: path.join(shm, "ashara-scratch"), reason: "full", bytesFree: GIB, bytesRequired: 2 * GIB });
  });

  test("ASHARA_SCRATCH_MIN_FREE_BYTES sets the bound", async () => {
    const shm = await fakeShm();
    expect(resolveScratchRoot(deps(shm, { ASHARA_SCRATCH_MIN_FREE_BYTES: String(GIB) }, GIB))).toBe(path.join(shm, "ashara-scratch"));
    expect(thrown(() => resolveScratchRoot(deps(shm, { ASHARA_SCRATCH_MIN_FREE_BYTES: "2G" })))).toBeInstanceOf(ScratchRootConfigError);
  });

  test("a relative ASHARA_SCRATCH_ROOT is refused", async () => {
    const shm = await fakeShm();
    expect(thrown(() => resolveScratchRoot(deps(shm, { ASHARA_SCRATCH_ROOT: "scratch" })))).toBeInstanceOf(ScratchRootConfigError);
  });
});

describe("the vitest scratch-root guard", () => {
  test("points TMPDIR at the scratch root, reporting a different value it replaces", () => {
    const root = "/dev/shm/ashara-scratch";
    const unset: Record<string, string | undefined> = {};
    expect(pinTmpdirToScratchRoot(unset, root)).toBeNull();
    expect(unset["TMPDIR"]).toBe(root);
    const same: Record<string, string | undefined> = { TMPDIR: `${root}/` };
    expect(pinTmpdirToScratchRoot(same, root)).toBeNull();
    const disk: Record<string, string | undefined> = { TMPDIR: "/tmp" };
    expect(pinTmpdirToScratchRoot(disk, root)).toBe("/tmp");
    expect(disk["TMPDIR"]).toBe(root);
  });

  test("every vitest run in the justfile and CI exports TMPDIR from the resolver first", () => {
    // A justfile recipe starts at column 0; a CI step starts at its `- name:` line. A recipe runs
    // vitest itself or through the bounded runners that start it.
    const runsTests = /^\s+(?:exec )?npx (?:vitest run|tsx scripts\/(?:test-run|affected-tests)\.ts)/m;
    const chunks = [
      ...readFileSync("justfile", "utf8").split(/\n(?=\S)/),
      ...readFileSync(".github/workflows/ci.yml", "utf8").split(/\n(?=\s*- name: )/),
    ].filter((chunk) => runsTests.test(chunk));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.slice(0, chunk.search(runsTests))).toMatch(/scripts\/scratch-root\.ts\)"?(?: \|\| exit 1)?\n\s*export TMPDIR\b/);
    }
  });

  test("this run's TMPDIR is the host's scratch root", () => {
    expect(path.resolve(tmpdir())).toBe(resolveScratchRoot());
  });
});
