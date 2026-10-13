import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { environmentVersion, parseEnvironmentDefinition, readEnvironmentDefinition } from "./environment.js";
import { EnvironmentDefinitionInvalid, EnvironmentVersionUnresolved, OwnedPathNotAFile } from "./errors.js";

const run = promisify(execFile);
const scratch: string[] = [];

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const VALID = `
owned = ["environment/", "package.json"]
containerfile = "environment/Containerfile"
build = "make"
test = "make check"
`;

function issuesOf(text: string): readonly string[] {
  try {
    parseEnvironmentDefinition(text, "env.toml");
  } catch (err) {
    if (err instanceof EnvironmentDefinitionInvalid) return err.issues;
    throw err;
  }
  throw new Error("expected EnvironmentDefinitionInvalid");
}

describe("parseEnvironmentDefinition", () => {
  it("accepts a definition and adds nothing to it", () => {
    expect(parseEnvironmentDefinition(VALID, "env.toml")).toEqual({
      owned: ["environment/", "package.json"],
      containerfile: "environment/Containerfile",
      build: "make",
      test: "make check",
    });
  });

  it("requires environment/ among the owned paths", () => {
    expect(issuesOf(VALID.replace('"environment/", ', ""))).toEqual(
      expect.arrayContaining([expect.stringContaining('owned must include "environment/"')]),
    );
  });

  it("refuses owned paths that escape the repository or are absolute", () => {
    const escaping = issuesOf(VALID.replace('"package.json"', '"../secrets"'));
    expect(escaping.join("; ")).toContain("escapes the repository");
    const absolute = issuesOf(VALID.replace('"package.json"', '"/etc/passwd"'));
    expect(absolute.join("; ")).toContain("is absolute");
  });

  it("refuses any owned directory other than environment/", () => {
    expect(issuesOf(VALID.replace('"package.json"', '"src/"')).join("; ")).toContain(
      '"src/" names a directory; the only owned directory is "environment/"',
    );
  });

  it("refuses extra keys, a containerfile outside the owned set and empty commands", () => {
    expect(issuesOf(`${VALID}\nimage = "x"\n`).join("; ")).toContain("image");
    expect(issuesOf(VALID.replace('"environment/Containerfile"', '"Containerfile"')).join("; ")).toContain(
      "containerfile must be inside an owned path",
    );
    expect(issuesOf(VALID.replace('"make check"', '"  "')).join("; ")).toContain("test: must be a non-empty command");
  });
});

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
  it("is stable across commits outside the owned set and changes with an owned file", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ashara-env-version-"));
    scratch.push(repo);
    await git(repo, "init", "-q", "-b", "main");
    const first = await commitFiles(
      repo,
      {
        "environment/environment.toml": VALID,
        "environment/Containerfile": "FROM scratch\n",
        "package.json": "{}\n",
        "src/app.txt": "v1\n",
      },
      "env",
    );
    const gitDir = join(repo, ".git");
    const definition = await readEnvironmentDefinition(gitDir, "main");
    const v1 = await environmentVersion(gitDir, "main", definition);
    expect(v1).toEqual({ version: expect.stringMatching(/^[0-9a-f]{64}$/), commit: first });

    await commitFiles(repo, { "src/app.txt": "v2\n", "README": "unrelated\n" }, "unrelated");
    expect(await environmentVersion(gitDir, "main", definition)).toEqual(v1);

    const changed = await commitFiles(repo, { "package.json": '{"dependencies":{}}\n' }, "owned change");
    const v2 = await environmentVersion(gitDir, "main", definition);
    expect(v2.commit).toBe(changed);
    expect(v2.version).not.toBe(v1.version);
    // An earlier commit still resolves to the earlier version.
    expect(await environmentVersion(gitDir, first, definition)).toEqual(v1);
  });

  it("refuses an owned file entry that is a directory in the committed tree, naming it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ashara-env-version-"));
    scratch.push(repo);
    await git(repo, "init", "-q", "-b", "main");
    await commitFiles(repo, { "environment/Containerfile": "FROM scratch\n", "package.json/index.txt": "a directory\n" }, "dir");
    const definition = parseEnvironmentDefinition(VALID, "env.toml");
    const refusal = environmentVersion(join(repo, ".git"), "main", definition);
    await expect(refusal).rejects.toBeInstanceOf(OwnedPathNotAFile);
    await expect(refusal).rejects.toMatchObject({ ownedPath: "package.json", containedPath: "package.json/index.txt" });
  });

  it("fails closed on an owned path that matches nothing and on a missing definition", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ashara-env-version-"));
    scratch.push(repo);
    await git(repo, "init", "-q", "-b", "main");
    await commitFiles(repo, { "environment/Containerfile": "FROM scratch\n" }, "no definition");
    const gitDir = join(repo, ".git");
    await expect(readEnvironmentDefinition(gitDir, "main")).rejects.toBeInstanceOf(EnvironmentDefinitionInvalid);
    const definition = parseEnvironmentDefinition(VALID, "env.toml");
    await expect(environmentVersion(gitDir, "main", definition)).rejects.toThrow(/package\.json.*match no file/);
    await expect(environmentVersion(gitDir, "--output=x", definition)).rejects.toBeInstanceOf(EnvironmentVersionUnresolved);
  });
});
