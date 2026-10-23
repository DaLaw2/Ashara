import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ClientRepository, createDb, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { EnvironmentBuildRepository } from "@ashara/execution-infra";
import {
  EnvironmentBuildFailed,
  EnvironmentBuildUnrecorded,
  PodmanSubstrate,
  buildEnvironmentImage,
  loadBaseCell,
} from "@ashara/execution-infra";
import { readEnvironmentDefinition } from "@ashara/quality";
import type { ProjectId } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";
import { testCellInstance } from "../test-cells.js";

// Real git, real podman, real Postgres: the build path from a committed build context to a row and a
// cell. No network is needed (the base image is local, the Containerfile has no RUN), and no skip.

const run = promisify(execFile);
const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NONCE = randomUUID().slice(0, 8);

type Db = ReturnType<typeof createDb>;
let db: Db;
let builds: EnvironmentBuildRepository;
let projectId: ProjectId;
let clientId = "";
let root = "";
let repo = "";
let substrate: PodmanSubstrate;

const rowSchema = z.object({ status: z.string(), network: z.string(), image_id: z.string().nullable(), error: z.string().nullable() });

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  return stdout.trim();
}

async function commitFiles(files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

async function rows(): Promise<z.infer<typeof rowSchema>[]> {
  const result = await db.execute(
    sql`SELECT status, network, image_id, error FROM environment_builds WHERE project_id = ${projectId} ORDER BY created_at`,
  );
  return z.array(rowSchema).parse(result.rows);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  builds = new EnvironmentBuildRepository(db);
  clientId = (await new ClientRepository(db).create(`env-build-test-${NONCE}-client`)).id;
  projectId = (await new ProjectRepository(db).create(`env-build-test-${NONCE}-project`, clientId)).id;
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-env-build-test-")));
  repo = join(root, "repo");
  await mkdir(repo);
  await git("init", "-q", "-b", "main");
  substrate = new PodmanSubstrate({ logger: recordingLogger(), podmanPath: "podman", mountRoot: root });
});

afterAll(async () => {
  await substrate.teardownAll();
  const { stdout } = await run("podman", ["images", "-q", "--filter", `label=ashara.project=${projectId}`]);
  const images = [...new Set(stdout.split("\n").filter((id) => id !== ""))];
  if (images.length > 0) await run("podman", ["rmi", "-f", ...images]);
  await db.execute(sql`DELETE FROM environment_builds WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
});

describe("environment image build", () => {
  it("builds from the recipe and the existing inputs only, records it, reuses it, and a cell runs from it", async () => {
    const base = await loadBaseCell();
    await commitFiles(
      {
        "environment/environment.toml": [
          'containerfile = "environment/Containerfile"',
          'recipe = ["environment/recipe.txt"]',
          'inputs = ["manifest.txt", "not-written-yet.txt"]',
          'probe = "true"',
          'build = "true"',
          'test = "true"',
          "",
        ].join("\n"),
        "environment/Containerfile": `FROM ${base.image}\nCOPY . /opt/ctx/\n`,
        "environment/recipe.txt": "recipe content\n",
        "environment/notes.txt": "under environment/ but no recipe file\n",
        "manifest.txt": "dependencies: none\n",
        "src/secret.txt": "not in the build context\n",
      },
      "environment",
    );
    // Present in the work tree but never committed: must not reach the build either.
    await writeFile(join(repo, "environment", "untracked.txt"), "untracked\n");

    const gitDir = join(repo, ".git");
    const definition = await readEnvironmentDefinition(gitDir, "main");
    const built = await buildEnvironmentImage(
      { projectId, repoGitDir: gitDir, commit: "main", definition },
      { substrate, recorder: builds, timeoutMs: 120_000 },
    );
    expect(built).toMatchObject({ reused: false, network: "private", imageId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(await rows()).toEqual([{ status: "succeeded", network: "private", image_id: built.imageId, error: null }]);

    const again = await buildEnvironmentImage(
      { projectId, repoGitDir: gitDir, commit: "main", definition },
      { substrate, recorder: builds, timeoutMs: 120_000 },
    );
    // A reuse runs no build, so it carries no log; everything else is the first build's.
    expect(built.reused ? null : built.log.every((piece) => piece.kind === "kept")).toBe(true);
    const { reused: _reused, ...identity } = again;
    expect(again.reused).toBe(true);
    expect(built).toMatchObject(identity);
    expect(await rows()).toHaveLength(1);

    const workspace = await mkdtemp(join(root, "ws-"));
    const cell = await substrate.createCell({
      image: built.imageRef,
      project: projectId,
      task: `task-${NONCE}`,
      role: "worker",
      instance: testCellInstance(),
      mount: { hostPath: workspace },
    });
    const recipe = await cell.exec(["cat", "/opt/ctx/environment/recipe.txt"], { signal: new AbortController().signal, timeoutSeconds: 30 });
    expect(recipe).toMatchObject({ exitCode: 0, stdout: "recipe content\n" });
    const listing = await cell.exec(["find", "/opt/ctx", "-type", "f"], { signal: new AbortController().signal, timeoutSeconds: 30 });
    expect(listing.stdout.split("\n").filter((line) => line !== "").sort()).toEqual([
      "/opt/ctx/environment/Containerfile",
      "/opt/ctx/environment/environment.toml",
      "/opt/ctx/environment/recipe.txt",
      "/opt/ctx/manifest.txt",
    ]);
    await cell.teardown();
  });

  it("records a failed build and throws EnvironmentBuildFailed", async () => {
    const base = await loadBaseCell();
    await commitFiles({ "environment/Containerfile": `FROM ${base.image}\nCOPY src/secret.txt /opt/secret.txt\n` }, "broken");
    const gitDir = join(repo, ".git");
    const definition = await readEnvironmentDefinition(gitDir, "main");
    const failure = await buildEnvironmentImage(
      { projectId, repoGitDir: gitDir, commit: "main", definition },
      { substrate, recorder: builds, timeoutMs: 120_000 },
    ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(EnvironmentBuildFailed);
    expect(failure).toMatchObject({ exitCode: expect.any(Number), message: expect.stringContaining("secret.txt") });
    const recorded = await rows();
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toMatchObject({ status: "failed", network: "private", image_id: null, error: expect.stringContaining("failed") });
  });

  it("a built image whose build cannot be recorded throws a typed error carrying the build, and is never reused", async () => {
    const base = await loadBaseCell();
    await commitFiles({ "environment/Containerfile": `FROM ${base.image}\nLABEL unrecorded=1\n` }, "unrecorded");
    const gitDir = join(repo, ".git");
    const definition = await readEnvironmentDefinition(gitDir, "main");
    const recorder = {
      findSucceeded: (id: ProjectId, version: string) => builds.findSucceeded(id, version),
      recordSucceeded: async () => {
        throw new Error("connection terminated");
      },
      recordFailed: (build: Parameters<EnvironmentBuildRepository["recordFailed"]>[0]) => builds.recordFailed(build),
    };
    const failure = await buildEnvironmentImage(
      { projectId, repoGitDir: gitDir, commit: "main", definition },
      { substrate, recorder, timeoutMs: 120_000 },
    ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(EnvironmentBuildUnrecorded);
    expect(failure).toMatchObject({
      projectId,
      version: expect.stringMatching(/^[0-9a-f]{64}$/),
      imageId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      message: expect.stringContaining("connection terminated"),
    });
    // Nothing is on record for it, so the next resolution builds it again rather than reusing it.
    expect(await rows()).toHaveLength(2);
  });
});
