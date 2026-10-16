import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { environmentVersion, readEnvironmentFile } from "./environment.js";
import type { EnvironmentBuildContext } from "./environment.js";
import { EnvironmentDefinitionInvalid, EnvironmentGitFailed, EnvironmentVersionUnresolved } from "./errors.js";
import { withGitRunner } from "./host-git.js";

const run = promisify(execFile);
const scratch: string[] = [];

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const DEFINITION_TEXT = `
containerfile = "environment/Containerfile"
recipe = ["environment/setup.sh"]
inputs = ["package.json"]
probe = "make --version"
build = "make"
test = "make check"
`;

const BUILD_CONTEXT: EnvironmentBuildContext = {
  containerfile: "environment/Containerfile",
  recipe: ["environment/setup.sh"],
  inputs: ["package.json"],
};

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  return stdout.trim();
}

async function commitFiles(repo: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

describe("environmentVersion", () => {
  it("is stable across product commits, changes with an input, and holds while an input is absent", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ashara-env-version-"));
    scratch.push(repo);
    await git(repo, "init", "-q", "-b", "main");
    const first = await commitFiles(
      repo,
      {
        "environment/environment.toml": DEFINITION_TEXT,
        "environment/Containerfile": "FROM scratch\n",
        "environment/setup.sh": "true\n",
        "src/app.txt": "v1\n",
      },
      "env",
    );
    const gitDir = join(repo, ".git");
    const v1 = await environmentVersion(gitDir, "main", BUILD_CONTEXT);
    expect(v1).toEqual({ version: expect.stringMatching(/^[0-9a-f]{64}$/), commit: first });

    await commitFiles(repo, { "src/app.txt": "v2\n", "README": "unrelated\n", "environment/notes.txt": "not recipe\n" }, "product");
    expect(await environmentVersion(gitDir, "main", BUILD_CONTEXT)).toEqual(v1);

    const added = await commitFiles(repo, { "package.json": "{}\n" }, "input appears");
    const v2 = await environmentVersion(gitDir, "main", BUILD_CONTEXT);
    expect(v2.commit).toBe(added);
    expect(v2.version).not.toBe(v1.version);

    await commitFiles(repo, { "package.json": '{"dependencies":{}}\n' }, "input changes");
    expect((await environmentVersion(gitDir, "main", BUILD_CONTEXT)).version).not.toBe(v2.version);
    // An earlier commit still resolves to the earlier version.
    expect(await environmentVersion(gitDir, first, BUILD_CONTEXT)).toEqual(v1);
  });

  it("refuses an input that is a directory in the committed tree, naming it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ashara-env-version-"));
    scratch.push(repo);
    await git(repo, "init", "-q", "-b", "main");
    await commitFiles(
      repo,
      { "environment/Containerfile": "FROM scratch\n", "environment/setup.sh": "true\n", "package.json/index.txt": "a directory\n" },
      "dir",
    );
    const refusal = environmentVersion(join(repo, ".git"), "main", BUILD_CONTEXT);
    await expect(refusal).rejects.toBeInstanceOf(EnvironmentVersionUnresolved);
    await expect(refusal).rejects.toThrow(/"package\.json" is a directory at this commit/);
  });

  it("fails closed on a missing recipe file and on a missing definition", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ashara-env-version-"));
    scratch.push(repo);
    await git(repo, "init", "-q", "-b", "main");
    await commitFiles(repo, { "environment/Containerfile": "FROM scratch\n" }, "no definition");
    const gitDir = join(repo, ".git");
    await expect(readEnvironmentFile(gitDir, "main", z.unknown())).rejects.toBeInstanceOf(EnvironmentDefinitionInvalid);
    await expect(environmentVersion(gitDir, "main", BUILD_CONTEXT)).rejects.toThrow(/recipe file\(s\).*environment\/environment\.toml.*not files/);
    await expect(environmentVersion(gitDir, "--output=x", BUILD_CONTEXT)).rejects.toBeInstanceOf(EnvironmentVersionUnresolved);
  });

  it("tells a revision that names no commit from a git that could not read the repository", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ashara-env-version-"));
    scratch.push(repo);
    await git(repo, "init", "-q", "-b", "main");
    await commitFiles(repo, { "environment/environment.toml": DEFINITION_TEXT }, "env");
    const gitDir = join(repo, ".git");
    await expect(readEnvironmentFile(gitDir, "no-such-branch", z.unknown())).rejects.toBeInstanceOf(EnvironmentVersionUnresolved);
    const locked = withGitRunner(
      {
        text: () => Promise.reject(Object.assign(new Error("git failed"), { code: 128, stderr: "fatal: Unable to create 'index.lock': File exists.\n" })),
        bytes: () => Promise.reject(Object.assign(new Error("git failed"), { code: 128, stderr: Buffer.from("fatal: Unable to create 'index.lock': File exists.\n") })),
      },
      () => readEnvironmentFile(gitDir, "main", z.unknown()),
    );
    await expect(locked).rejects.toBeInstanceOf(EnvironmentGitFailed);
    await expect(locked).rejects.toThrow(/exit 128.*index\.lock/);
  });
});
