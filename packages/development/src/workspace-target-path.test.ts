import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, test, expect, vi, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// GIT-SAFETY (path minting): assertValidTargetProjectPath must refuse any
// target that lives inside the Ashara repo, whose PARENT chain is inside a git
// working tree, or that cannot be canonicalized (fail-closed) — and must
// accept a clean standalone location.
//
// The Ashara repo root is resolved via `git rev-parse --show-toplevel`, mocked
// here to a controlled temp dir so no real checkout is consulted. The path and
// parent-chain inspection use the real filesystem against temp dirs. `realpath`
// is wrapped with a toggle so the canonicalization-failure branch can be
// exercised deterministically without a real fault.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted((): { failRealpath: boolean; gitAccessCode: string | null } => ({
  failRealpath: false,
  gitAccessCode: null,
}));

vi.mock("node:child_process", () => {
  const execFileMock: unknown = () => {
    throw new Error("execFile callback form is not supported by this mock; promisify.custom is used instead");
  };
  (execFileMock as Record<PropertyKey, unknown>)[promisify.custom] = async (
    _file: string,
    fileArgs: string[] = [],
  ): Promise<{ stdout: string; stderr: string }> => {
    if (fileArgs[0] === "rev-parse" && fileArgs[1] === "--show-toplevel") {
      return { stdout: `${fakeRepoRoot}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { execFile: execFileMock };
});

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (path: Parameters<typeof actual.realpath>[0]): Promise<string> => {
      if (hoisted.failRealpath) {
        throw new Error("simulated realpath failure (fail-closed test)");
      }
      return actual.realpath(path);
    },
    access: async (path: Parameters<typeof actual.access>[0], mode?: number): Promise<void> => {
      if (hoisted.gitAccessCode !== null && String(path).endsWith("/.git")) {
        throw Object.assign(new Error(`simulated ${hoisted.gitAccessCode} on ${String(path)}`), { code: hoisted.gitAccessCode });
      }
      return actual.access(path, mode);
    },
  };
});

const { assertValidTargetProjectPath, InvalidTargetProjectPath } = await import(
  "./workspace.js"
);

let fakeRepoRoot = "";
const tempDirs: string[] = [];

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  hoisted.failRealpath = false;
  hoisted.gitAccessCode = null;
  fakeRepoRoot = await makeDir("ashara-target-path-fakeroot-");
});

afterAll(async () => {
  for (const d of tempDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
});

describe("assertValidTargetProjectPath", () => {
  test("poisoned DB path inside the Ashara repo is rejected", async () => {
    // Mirrors the stale July row like /home/dalaw2/Ashara/project.
    const inside = join(fakeRepoRoot, "project");
    await mkdir(inside, { recursive: true });
    await expect(assertValidTargetProjectPath(inside)).rejects.toBeInstanceOf(
      InvalidTargetProjectPath,
    );
  });

  test("path equal to the Ashara repo root is rejected", async () => {
    await expect(assertValidTargetProjectPath(fakeRepoRoot)).rejects.toBeInstanceOf(
      InvalidTargetProjectPath,
    );
  });

  test("parent directory inside a git working tree is rejected", async () => {
    const worktree = await makeDir("ashara-target-path-worktree-");
    await mkdir(join(worktree, ".git"), { recursive: true });
    // Target parent chain (worktree/sub) walks up to worktree, which has .git.
    const target = join(worktree, "sub", "proj");
    await expect(assertValidTargetProjectPath(target)).rejects.toBeInstanceOf(
      InvalidTargetProjectPath,
    );
  });

  test("clean standalone location (parent not a git tree, outside repo) is accepted", async () => {
    const cleanBase = await makeDir("ashara-target-path-clean-");
    const target = join(cleanBase, "ashara-work", "projects", "vision-123");
    await expect(assertValidTargetProjectPath(target)).resolves.toBeUndefined();
  });

  test("a .git probe that errors other than ENOENT/ENOTDIR fails closed, never reads as no .git", async () => {
    const cleanBase = await makeDir("ashara-target-path-eacces-");
    const target = join(cleanBase, "projects", "vision-1");
    hoisted.gitAccessCode = "EACCES";
    const refusal: unknown = await assertValidTargetProjectPath(target).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(InvalidTargetProjectPath);
    expect(refusal).toMatchObject({ reason: expect.stringContaining("EACCES") });
  });

  test("a path component that is a file (ENOTDIR) reads as no .git", async () => {
    const cleanBase = await makeDir("ashara-target-path-enotdir-");
    hoisted.gitAccessCode = "ENOTDIR";
    await expect(assertValidTargetProjectPath(join(cleanBase, "projects", "vision-2"))).resolves.toBeUndefined();
  });

  test("canonicalization failure fails closed with a typed error", async () => {
    const cleanBase = await makeDir("ashara-target-path-canonfail-");
    const target = join(cleanBase, "projects", "vision-999");
    hoisted.failRealpath = true;
    await expect(assertValidTargetProjectPath(target)).rejects.toBeInstanceOf(
      InvalidTargetProjectPath,
    );
  });
});
