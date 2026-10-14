import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { environmentVersion, parseEnvironmentDefinition, readEnvironmentDefinition, recipePaths } from "./environment.js";
import { EnvironmentDefinitionInvalid, EnvironmentVersionUnresolved } from "./errors.js";

const run = promisify(execFile);
const scratch: string[] = [];

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const VALID = `
containerfile = "environment/Containerfile"
recipe = ["environment/setup.sh"]
inputs = ["package.json"]
probe = "make --version"
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
    const definition = parseEnvironmentDefinition(VALID, "env.toml");
    expect(definition).toEqual({
      containerfile: "environment/Containerfile",
      recipe: ["environment/setup.sh"],
      inputs: ["package.json"],
      probe: "make --version",
      build: "make",
      test: "make check",
    });
    expect(recipePaths(definition)).toEqual(["environment/environment.toml", "environment/Containerfile", "environment/setup.sh"]);
  });

  it("keeps every recipe file under environment/, so a recipe can never name a product file", () => {
    expect(issuesOf(VALID.replace('"environment/setup.sh"', '"main.go"')).join("; ")).toContain(
      '"main.go" must be a file under "environment/"',
    );
    expect(issuesOf(VALID.replace('"environment/Containerfile"', '"Containerfile"')).join("; ")).toContain(
      '"Containerfile" must be a file under "environment/"',
    );
  });

  it("refuses paths that escape the repository, are absolute or name a directory", () => {
    expect(issuesOf(VALID.replace('"package.json"', '"../secrets"')).join("; ")).toContain("escapes the repository");
    expect(issuesOf(VALID.replace('"package.json"', '"/etc/passwd"')).join("; ")).toContain("is absolute");
    expect(issuesOf(VALID.replace('"package.json"', '"src/"')).join("; ")).toContain("names a directory");
  });

  it("refuses a recipe file that is also an input, extra keys and empty commands", () => {
    expect(issuesOf(VALID.replace('"package.json"', '"environment/setup.sh"')).join("; ")).toContain("recipe files cannot also be inputs");
    expect(issuesOf(`${VALID}\nowned = ["environment/"]\n`).join("; ")).toContain("owned");
    expect(issuesOf(VALID.replace('"make --version"', '"  "')).join("; ")).toContain("probe: must be a non-empty command");
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
  it("is stable across product commits, changes with an input, and holds while an input is absent", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ashara-env-version-"));
    scratch.push(repo);
    await git(repo, "init", "-q", "-b", "main");
    const first = await commitFiles(
      repo,
      {
        "environment/environment.toml": VALID,
        "environment/Containerfile": "FROM scratch\n",
        "environment/setup.sh": "true\n",
        "src/app.txt": "v1\n",
      },
      "env",
    );
    const gitDir = join(repo, ".git");
    const definition = await readEnvironmentDefinition(gitDir, "main");
    const v1 = await environmentVersion(gitDir, "main", definition);
    expect(v1).toEqual({ version: expect.stringMatching(/^[0-9a-f]{64}$/), commit: first });

    await commitFiles(repo, { "src/app.txt": "v2\n", "README": "unrelated\n", "environment/notes.txt": "not recipe\n" }, "product");
    expect(await environmentVersion(gitDir, "main", definition)).toEqual(v1);

    const added = await commitFiles(repo, { "package.json": "{}\n" }, "input appears");
    const v2 = await environmentVersion(gitDir, "main", definition);
    expect(v2.commit).toBe(added);
    expect(v2.version).not.toBe(v1.version);

    await commitFiles(repo, { "package.json": '{"dependencies":{}}\n' }, "input changes");
    expect((await environmentVersion(gitDir, "main", definition)).version).not.toBe(v2.version);
    // An earlier commit still resolves to the earlier version.
    expect(await environmentVersion(gitDir, first, definition)).toEqual(v1);
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
    const definition = parseEnvironmentDefinition(VALID, "env.toml");
    const refusal = environmentVersion(join(repo, ".git"), "main", definition);
    await expect(refusal).rejects.toBeInstanceOf(EnvironmentVersionUnresolved);
    await expect(refusal).rejects.toThrow(/"package\.json" is a directory at this commit/);
  });

  it("fails closed on a missing recipe file and on a missing definition", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ashara-env-version-"));
    scratch.push(repo);
    await git(repo, "init", "-q", "-b", "main");
    await commitFiles(repo, { "environment/Containerfile": "FROM scratch\n" }, "no definition");
    const gitDir = join(repo, ".git");
    await expect(readEnvironmentDefinition(gitDir, "main")).rejects.toBeInstanceOf(EnvironmentDefinitionInvalid);
    const definition = parseEnvironmentDefinition(VALID, "env.toml");
    await expect(environmentVersion(gitDir, "main", definition)).rejects.toThrow(/recipe file\(s\).*environment\/environment\.toml.*not files/);
    await expect(environmentVersion(gitDir, "--output=x", definition)).rejects.toBeInstanceOf(EnvironmentVersionUnresolved);
  });
});
