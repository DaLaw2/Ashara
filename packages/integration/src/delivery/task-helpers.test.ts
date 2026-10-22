import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ClientRepository, createDb, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { resolveTargetProjectPath } from "@ashara/delivery";
import { parseProjectId } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";

// Against the shared dev database: every row here is created under a unique name
// and deleted in afterAll.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
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
  test("mints a path under workdirBase, records it on the project, and reuses it", async () => {
    const p = await projects.create(`${PREFIX}-mint`, clientId);
    const minted = join(workdirBase, "projects", p.id);
    expect(await resolveTargetProjectPath(projects, p.id, workdirBase, recordingLogger())).toEqual({ kind: "resolved", path: minted });
    expect((await projects.get(p.id))?.workspacePath).toBe(minted);
    expect(await resolveTargetProjectPath(projects, p.id, workdirBase, recordingLogger())).toEqual({ kind: "resolved", path: minted });
  });

  test("after workdirBase moves, the stored path outside it is refused, never re-minted or overwritten", async () => {
    const p = await projects.create(`${PREFIX}-moved`, clientId);
    const minted = join(workdirBase, "projects", p.id);
    await resolveTargetProjectPath(projects, p.id, workdirBase, recordingLogger());

    const resolved = await resolveTargetProjectPath(projects, p.id, join(workdirBase, "moved"), recordingLogger());

    expect(resolved).toMatchObject({ kind: "rejected", reason: expect.stringContaining("not inside the workdir base") });
    expect((await projects.get(p.id))?.workspacePath).toBe(minted);
  });

  test("a stored path outside the workdir base, the Ashara repository's included, is refused, never reused", async () => {
    const p = await projects.create(`${PREFIX}-poisoned`, clientId);
    await projects.recordWorkspacePath(p.id, join(process.cwd(), "poisoned-target"));
    const resolved = await resolveTargetProjectPath(projects, p.id, workdirBase, recordingLogger());
    expect(resolved).toMatchObject({ kind: "rejected", reason: expect.stringContaining("not inside the workdir base") });
  });

  test("an unknown project is rejected and records nothing", async () => {
    const missing = parseProjectId(randomUUID(), "test");
    expect(await resolveTargetProjectPath(projects, missing, workdirBase, recordingLogger())).toMatchObject({ kind: "rejected" });
    expect(await projects.get(missing)).toBeNull();
  });
});
