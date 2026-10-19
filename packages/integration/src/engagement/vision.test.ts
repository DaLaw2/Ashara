import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { ProjectId } from "@ashara/shared";
import { ClientRepository, ProjectRepository, createDb, type Database, resolveTestDatabaseUrl } from "@ashara/db";
import { VisionRepository, readVisionVersion } from "@ashara/engagement";

// Against the test database: every row here belongs to a project this suite creates under a
// unique name, and is deleted in afterAll.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NONCE = randomUUID().slice(0, 8);

let db: Database;
let visions: VisionRepository;
let projects: ProjectRepository;
let clientId: string;
let a: ProjectId;
let b: ProjectId;

const vision = (text: string) => ({ visionText: text, summary: `summary of ${text}` });
const asked = { key: "A1", statement: "Commands wait for the lock.", rationale: "tender", status: "Inferred", kind: "client-visible", disclosed: "asked" };

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  visions = new VisionRepository(db);
  projects = new ProjectRepository(db);
  clientId = (await new ClientRepository(db).create(`vision-test-${NONCE}-client`)).id;
  a = (await projects.create(`vision-test-${NONCE}-a`, clientId)).id;
  b = (await projects.create(`vision-test-${NONCE}-b`, clientId)).id;
  await visions.create(a, { ...vision("vision A1"), inferences: [asked], openQuestions: [{ messageId: "q1", text: "Wait?", assumptionKey: "A1" }] });
  await visions.create(b, vision("vision B1"));
});

afterAll(async () => {
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${`vision-test-${NONCE}%`}`;
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${`vision-test-${NONCE}%`}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("VisionRepository: versions per project", () => {
  test("each project's first vision is version 1, read whole by the published reader", async () => {
    const current = await visions.getCurrent(a);
    expect(current?.version).toBe(1);
    expect((await visions.getCurrent(b))?.version).toBe(1);
    expect(current === null ? null : readVisionVersion(current).assumptions.map((x) => [x.id, x.standing])).toEqual([["A1", "asked"]]);
  });

  test("reading one project never returns another project's vision; one with none reads as null", async () => {
    expect((await visions.getCurrent(b))?.visionText).toBe("vision B1");
    const empty = await projects.create(`vision-test-${NONCE}-empty`, clientId);
    expect(await visions.getCurrent(empty.id)).toBeNull();
  });

  test("a version whose jsonb would not read back is refused and nothing is written", async () => {
    await expect(visions.create(b, { ...vision("bad"), inferences: [{ key: "A1", statement: "x", status: "Guessed" }] })).rejects.toThrow(
      /inferences that would not read back/,
    );
    expect((await visions.getCurrent(b))?.version).toBe(1);
  });

  test("append writes the next version over the base it was composed on, and reports a moved base without writing", async () => {
    const change = { basedOnVersion: 1, inferences: [{ ...asked, status: "Inferred" as const, kind: "client-visible" as const, disclosed: "reported" as const }], openQuestions: [], changeReason: "reported" };
    expect(await visions.append(a, change)).toEqual({ kind: "appended" });
    const second = await visions.getCurrent(a);
    expect([second?.version, second?.visionText, second?.changeReason]).toEqual([2, "vision A1", "reported"]);
    expect(await visions.append(a, change)).toEqual({ kind: "moved", current: 2 });
    expect((await visions.getCurrent(b))?.version).toBe(1);
  });
});
