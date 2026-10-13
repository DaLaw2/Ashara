import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { createDb, DEFAULT_DATABASE_URL, type Database } from "../connection.js";
import { ClientRepository } from "./client.js";
import { ProjectRepository } from "./project.js";
import { VisionRepository } from "./vision.js";

// Against the shared dev database: every row here is created by this suite under
// a unique name and deleted in afterAll; nothing else is read or written.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NONCE = randomUUID().slice(0, 8);

let db: Database;
let projects: ProjectRepository;
let visions: VisionRepository;
let clientId: string;
let otherClientId: string;

/** The message of `err` and of every error in its `cause` chain, joined. */
function messageChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return messageChain(e);
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

function vision(text: string) {
  return { visionText: text, summary: `summary of ${text}` };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  projects = new ProjectRepository(db);
  visions = new VisionRepository(db);
  clientId = (await new ClientRepository(db).create(`project-test-${NONCE}-client`)).id;
  otherClientId = (await new ClientRepository(db).create(`project-test-${NONCE}-other`)).id;
});

afterAll(async () => {
  const pattern = `project-test-${NONCE}-%`;
  await db.execute(
    sql`DELETE FROM vision_documents WHERE project_id IN (SELECT id FROM projects WHERE name LIKE ${pattern})`,
  );
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${pattern}`);
  await db.$client.end();
});

describe("Project Record vision versions", () => {
  let a: ProjectId;
  let b: ProjectId;

  beforeAll(async () => {
    a = (await projects.create(`project-test-${NONCE}-a`, clientId)).id;
    b = (await projects.create(`project-test-${NONCE}-b`, clientId)).id;
    await visions.create(a, vision("vision A1"));
    await visions.create(b, vision("vision B1"));
  });

  test("each project's first vision is version 1", async () => {
    expect((await visions.getCurrent(a))?.version).toBe(1);
    expect((await visions.getCurrent(b))?.version).toBe(1);
  });

  test("a second vision of one project is version 2 and leaves the other at 1", async () => {
    const second = await visions.create(a, vision("vision A2"));
    expect(second.version).toBe(2);
    expect((await visions.getCurrent(a))?.visionText).toBe("vision A2");
    expect((await visions.getCurrent(b))?.version).toBe(1);
  });

  test("reading one project never returns another project's vision", async () => {
    const readB = await visions.getCurrent(b);
    expect(readB?.projectId).toBe(b);
    expect(readB?.visionText).toBe("vision B1");
  });

  test("a project with no vision reads as null", async () => {
    const empty = await projects.create(`project-test-${NONCE}-empty`, clientId);
    expect(await visions.getCurrent(empty.id)).toBeNull();
    expect((await projects.get(empty.id))?.status).toBe("active");
  });
});

describe("project_id is required", () => {
  test("a work item insert without project_id fails", async () => {
    const message = await failureOf(() =>
      db.execute(
        sql`INSERT INTO work_items (id, level, status, title, run_scope) VALUES (${randomUUID()}, 'Task', 'Pending', 'no project', 'test-run')`,
      ),
    );
    expect(message).toMatch(/null value in column "project_id"/);
  });

  test("a vision insert without project_id fails", async () => {
    const message = await failureOf(() =>
      db.execute(
        sql`INSERT INTO vision_documents (version, vision_text, summary) VALUES (1, 'no project', 'no project')`,
      ),
    );
    expect(message).toMatch(/null value in column "project_id"/);
  });
});

describe("Project workspace path (migration 024)", () => {
  test("a new project has no workspace path; the first recorded path wins and is never rewritten", async () => {
    const p = await projects.create(`project-test-${NONCE}-ws`, clientId);
    expect(p.workspacePath).toBeNull();
    expect(await projects.recordWorkspacePath(p.id, "/srv/first")).toBe("/srv/first");
    expect(await projects.recordWorkspacePath(p.id, "/srv/second")).toBe("/srv/first");
    expect((await projects.get(p.id))?.workspacePath).toBe("/srv/first");
  });

  test("two racing writers agree on one stored path", async () => {
    const p = await projects.create(`project-test-${NONCE}-ws-race`, clientId);
    const [x, y] = await Promise.all([
      projects.recordWorkspacePath(p.id, "/srv/x"),
      projects.recordWorkspacePath(p.id, "/srv/y"),
    ]);
    expect(x).toBe(y);
    expect((await projects.get(p.id))?.workspacePath).toBe(x);
  });

  test("recording on a missing project throws", async () => {
    const missing = parseProjectId(randomUUID());
    const message = await failureOf(() => projects.recordWorkspacePath(missing, "/srv/none"));
    expect(message).toMatch(/does not exist/);
  });

  test("vision_documents no longer carries a project path", async () => {
    const rows = await db.execute(
      sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'vision_documents' AND column_name = 'project_path'`,
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe("Project ownership", () => {
  test("listByClient returns only that client's projects", async () => {
    const mine = await projects.create(`project-test-${NONCE}-mine`, clientId);
    const theirs = await projects.create(`project-test-${NONCE}-theirs`, otherClientId);
    const listed = (await projects.listByClient(clientId)).map((p) => p.id);
    expect(listed).toContain(mine.id);
    expect(listed).not.toContain(theirs.id);
    expect((await projects.get(theirs.id))?.clientId).toBe(otherClientId);
  });

  test("a project for no existing client is refused by the foreign key", async () => {
    const message = await failureOf(() => projects.create(`project-test-${NONCE}-orphan`, randomUUID()));
    expect(message).toMatch(/foreign key/);
  });
});
