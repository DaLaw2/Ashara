import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, ProjectRepository } from "@ashara/db";
import { resolveTargetProjectPath } from "@ashara/orchestrator";
import { parseProjectId } from "@ashara/shared";

// Against the shared dev database: every row here is created under a unique name
// and deleted in afterAll.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NONCE = randomUUID().slice(0, 8);
const PREFIX = `task-helpers-test-${NONCE}`;

let db: ReturnType<typeof createDb>;
let projects: ProjectRepository;
let clientId: string;
let workdirBase: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  projects = new ProjectRepository(db);
  clientId = (await new ClientRepository(db).create(`${PREFIX}-client`)).id;
  workdirBase = await mkdtemp(join(tmpdir(), "ashara-task-helpers-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(async () => {
  await db.$client.query("DELETE FROM projects WHERE name LIKE $1", [`${PREFIX}-%`]);
  await db.$client.query("DELETE FROM clients WHERE name LIKE $1", [`${PREFIX}-%`]);
  await db.$client.end();
  await rm(workdirBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("resolveTargetProjectPath", () => {
  test("mints a path under workdirBase, records it on the project, and reuses it after workdirBase changes", async () => {
    const p = await projects.create(`${PREFIX}-mint`, clientId);
    const minted = join(workdirBase, "projects", p.id);
    expect(await resolveTargetProjectPath(projects, p.id, workdirBase)).toEqual({ kind: "resolved", path: minted });
    expect((await projects.get(p.id))?.workspacePath).toBe(minted);

    const elsewhere = join(workdirBase, "moved");
    expect(await resolveTargetProjectPath(projects, p.id, elsewhere)).toEqual({ kind: "resolved", path: minted });
  });

  test("a stored path inside the Ashara repository is refused, never reused", async () => {
    const p = await projects.create(`${PREFIX}-poisoned`, clientId);
    await projects.recordWorkspacePath(p.id, join(process.cwd(), "poisoned-target"));
    const resolved = await resolveTargetProjectPath(projects, p.id, workdirBase);
    expect(resolved).toMatchObject({ kind: "rejected", reason: expect.stringContaining("Ashara repository root") });
  });

  test("an unknown project is rejected and records nothing", async () => {
    const missing = parseProjectId(randomUUID(), "test");
    expect(await resolveTargetProjectPath(projects, missing, workdirBase)).toMatchObject({ kind: "rejected" });
    expect(await projects.get(missing)).toBeNull();
  });
});
