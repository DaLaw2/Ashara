import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, createPgPool, resolveTestDatabaseUrl } from "@ashara/db";
import type { PoolFactory } from "@ashara/db";
import { ClientMessageRepository, StackChoiceReports, VisionRepository, consumeTenderWithoutIntake, createProjectWithTender } from "@ashara/engagement";
import type { StackChoiceStore } from "@ashara/engagement";
import { createWorkItemId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import type { ProjectId } from "@ashara/shared";
import { createStackChoiceStore } from "@ashara/server/stack-choice-store";

// The stack-choice step lists every project due a stack-choice report and reads each one's rows on
// its own: one project whose rows cannot be read is that project's fault, logged at warn with its
// project id, and every other project is still reported on in the same cycle. Every row belongs to a
// project this suite creates under a unique name, and the step is narrowed to those projects. The
// unreadable row is a statement the pool refuses: a read of one project's vision.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `stack-choice-listing-test-${randomUUID().slice(0, 8)}`;
const TENDER = "Build a command that prints a greeting.";
const STATEMENT = "The command is a POSIX shell script tested with bats.";

/** The projects whose vision reads the pool refuses. */
const unreadable = new Set<string>();

/** A statement reading the vision of a project in `unreadable`. */
function readsUnreadableVision(args: readonly unknown[]): boolean {
  const [query, params] = args;
  const parsed = z.object({ text: z.string(), values: z.array(z.unknown()).optional() }).safeParse(query);
  const text = typeof query === "string" ? query : parsed.success ? parsed.data.text : "";
  const values = Array.isArray(params) ? params : parsed.success ? (parsed.data.values ?? []) : [];
  return text.includes(`"vision_documents"`) && text.trimStart().startsWith("select") && values.some((value) => typeof value === "string" && unreadable.has(value));
}

const refusingVisionReads: PoolFactory = (config) => {
  const pool = createPgPool(config);
  return new Proxy(pool, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== "query") return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]): unknown => {
        if (readsUnreadableVision(args)) return Promise.reject(new Error("the project's vision row cannot be read"));
        return Reflect.apply(target.query, target, args);
      };
    },
  });
};

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<string>();

/** A project at work with vision v1, its tender consumed, whose Sprint 0 environment task merged with a statement. */
async function projectWithStackChoice(): Promise<ProjectId> {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, TENDER);
  ourProjects.add(project.id);
  await new VisionRepository(db).create(project.id, {
    visionText: TENDER,
    summary: "A greeting command.",
    contract: {
      interface: [{ id: "I1", text: "The command.", source: { kind: "tender", quote: "Build a command" } }],
      guarantees: [
        {
          id: "G1",
          statement: "The command prints a greeting.",
          observable: { interface: ["I1"], observation: "output" },
          refutedBy: ["The command prints no greeting."],
          source: { kind: "tender", quote: "prints a greeting" },
        },
      ],
      exclusions: [],
    },
  });
  const [tender] = await new ClientMessageRepository(db).listByProject(project.id);
  if (tender !== undefined) await consumeTenderWithoutIntake(db, { id: tender.id, projectId: project.id });
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, environment_statement, merge_commit)
    VALUES (${createWorkItemId()}, 'Task', 'Completed', 'Define the environment', ${project.id}, 'environment', ${randomUUID()}, ${STATEMENT}, ${"c".repeat(40)})`);
  return project.id;
}

function stackChoices(): StackChoiceReports {
  const store = createStackChoiceStore(db);
  const ours: StackChoiceStore = { ...store, dueStackChoices: async () => (await store.dueStackChoices()).filter((due) => ourProjects.has(due.projectId)) };
  return new StackChoiceReports(ours, memoryStepContainment(() => false));
}

async function stackReports(projectId: ProjectId): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM client_messages WHERE project_id = ${projectId} AND reports_on = 'stack-choice'`);
  return z.array(z.object({ n: z.number() })).length(1).parse(result.rows)[0]?.n ?? -1;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL, refusingVisionReads);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
});

beforeEach(() => {
  ourProjects.clear();
  unreadable.clear();
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM vision_revisions WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("the stack-choice listing reads each project on its own", () => {
  test("one project whose rows cannot be read is its fault, logged at warn with its project id, and the other project is reported on", async () => {
    const bad = await projectWithStackChoice();
    const good = await projectWithStackChoice();
    unreadable.add(bad);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcomes = await stackChoices().runPending();

    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "step-faulted", step: "stack-choice", subjectId: bad, projectId: bad, faults: 1, error: expect.stringContaining("cannot be read") }),
      { kind: "recorded", projectId: good, visionVersion: 2 },
    ]);
    expect(warn.mock.calls.some(([line]) => typeof line === "string" && line.includes(`(project ${bad})`) && line.includes("[stack-choice]"))).toBe(true);
    expect(await stackReports(good)).toBe(1);
    expect(await stackReports(bad)).toBe(0);
    warn.mockRestore();
  });
});
