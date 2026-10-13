import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  ClientMessageRepository,
  ClientRepository,
  createDb,
  createProjectWithTender,
  DEFAULT_DATABASE_URL,
  LlmCallRepository,
  ProjectRepository,
  VisionRepository,
} from "@ashara/db";
import { PlanReports, TenderIntake } from "@ashara/engagement";
import type { IntakeStore, PlanReportStore } from "@ashara/engagement";
import { LlmCallLedger } from "@ashara/finance";
import { buildGateway } from "@ashara/llm-gateway";
import type { LLMGateway, ModelConfig } from "@ashara/llm-gateway";
import { FirstPlanner } from "@ashara/planning";
import type { FirstPlanStore } from "@ashara/planning";
import type { ProjectId } from "@ashara/shared";
import { createFirstPlanStore, createPlanReportStore } from "./first-plan-store.js";
import { createIntakeStore } from "./intake-store.js";

// Against the shared dev database: every row here belongs to a project this
// suite creates under a unique name, and afterAll deletes exactly those rows.
// Both stores are narrowed to this suite's projects so no other project in the
// database is planned or reported on. No real LLM call is made: the provider
// factory returns a MockLanguageModelV4.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NONCE = randomUUID().slice(0, 8);
const NAME_PREFIX = `first-plan-test-${NONCE}`;

let db: ReturnType<typeof createDb>;
let gateway: LLMGateway;
let clientId: string;
const ourProjects = new Set<string>();

function model(id: string, capabilityLevel: ModelConfig["capabilityLevel"]): ModelConfig {
  return {
    id,
    apiModelId: `${id}-api`,
    provider: "deepseek",
    capabilityLevel,
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    maxContextTokens: 100_000,
    cacheReadCostPer1M: null,
    cacheWriteCostPer1M: null,
    priceWindows: [],
  };
}

function stubModel(doGenerate: ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4(doGenerate);
  stub.model = mock;
  return mock;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    usage: {
      inputTokens: { total: 500, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 200, text: 200, reasoning: undefined },
    },
    finishReason: { unified: "stop" as const, raw: "stop" },
    warnings: [],
  };
}

const KNOWLEDGE = {
  nodes: [{ id: "lang-x", kind: "language", label: "Stated language" }],
  edges: [],
};

const CLASS_LIST = "Create the class list for both studios";
const BOOKING_FORM = "Create the booking form for a class";

const TASKS = {
  tasks: [
    { ref: "t1", title: CLASS_LIST, description: "List classes.", dependsOn: [] },
    { ref: "t2", title: BOOKING_FORM, description: "Book a seat.", dependsOn: ["t1"] },
  ],
};

/** Answers the knowledge-graph call and the task call by what each prompt asks for. */
function decompositionModel(): MockLanguageModelV4 {
  return stubModel({
    doGenerate: async (options) =>
      jsonResult(JSON.stringify(options.prompt).includes("structured knowledge graph") ? KNOWLEDGE : TASKS),
  });
}

function planner(): FirstPlanner {
  const store = createFirstPlanStore(db);
  const ours: FirstPlanStore = {
    ...store,
    projectsAwaitingPlan: async () => (await store.projectsAwaitingPlan()).filter((p) => ourProjects.has(p.projectId)),
  };
  return new FirstPlanner({ llm: gateway, store: ours });
}

function intake(): TenderIntake {
  const store = createIntakeStore(db);
  const ours: IntakeStore = {
    ...store,
    openTenders: async () => (await store.openTenders()).filter((t) => ourProjects.has(t.projectId)),
  };
  return new TenderIntake({ llm: gateway, store: ours });
}

const INTAKE = {
  summary: "A booking page for the client's two pottery studios.",
  scopeBoundaries: ["In: class booking for both studios", "Out: payments"],
  assumptions: [{ statement: "Bookings need no account.", rationale: "The tender says walk-in customers book." }],
  questions: [
    {
      text: "Which studio opens first?",
      whyItMatters: "It orders the work.",
      // The lead-in repeats the label the client reads before it; intake drops it (transcript 2, N1).
      assumption: {
        statement: "Until you answer, the harbour studio opens first.",
        rationale: "The tender names it first.",
      },
    },
    {
      text: "How many seats does a class have?",
      whyItMatters: "It sets the booking limit.",
      assumption: { statement: "A class has twelve seats.", rationale: "The tender mentions a dozen wheels." },
    },
  ],
};

function reports(): PlanReports {
  const store = createPlanReportStore(db);
  const ours: PlanReportStore = {
    ...store,
    dueReports: async () => (await store.dueReports()).filter((r) => ourProjects.has(r.projectId)),
  };
  return new PlanReports(ours);
}

async function projectWithVision(userAnswers: unknown[] = []): Promise<ProjectId> {
  const project = await new ProjectRepository(db).create(`${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, clientId);
  ourProjects.add(project.id);
  await new VisionRepository(db).create(project.id, {
    visionText: "Booking page for my two pottery studios.",
    summary: "A booking page for two pottery studios.",
    scopeBoundaries: ["In: class booking", "Out: payments"],
    inferences: [{ statement: "Bookings need no account.", rationale: "Walk-in customers book.", status: "Inferred" }],
    userAnswers,
  });
  return project.id;
}

const WorkItemRowSchema = z.object({ id: z.string(), level: z.string(), parentId: z.string().nullable() });

async function workItemsOf(projectId: ProjectId) {
  const result = await db.execute(
    sql`SELECT id, level, parent_id AS "parentId" FROM work_items WHERE project_id = ${projectId}`,
  );
  return z.array(WorkItemRowSchema).parse(result.rows);
}

/** Every dependency edge among the project's work items, as "from title -> to title", sorted. */
async function edgesOf(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT f.title AS "from", t.title AS "to"
    FROM dependencies d
    JOIN work_items f ON f.id = d.from_id
    JOIN work_items t ON t.id = d.to_id
    WHERE f.project_id = ${projectId} OR t.project_id = ${projectId}`);
  return z
    .array(z.object({ from: z.string(), to: z.string() }))
    .parse(result.rows)
    .map((e) => `${e.from} -> ${e.to}`)
    .sort();
}

const SCAFFOLD_TITLE = "Create project scaffold: manifest, entry point, directory structure";

/** t2 depends on t1, and every decomposed task depends on the scaffold decomposition adds. */
const EXPECTED_EDGES = [
  `${BOOKING_FORM} -> ${CLASS_LIST}`,
  `${BOOKING_FORM} -> ${SCAFFOLD_TITLE}`,
  `${CLASS_LIST} -> ${SCAFFOLD_TITLE}`,
].sort();

async function callSitesOf(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`SELECT call_site AS "callSite" FROM llm_calls WHERE project_id = ${projectId}`);
  return z.array(z.object({ callSite: z.string() })).parse(result.rows).map((r) => r.callSite);
}

async function outboundOf(projectId: ProjectId) {
  return (await new ClientMessageRepository(db).listByProject(projectId)).filter((m) => m.direction === "outbound");
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  const config: Parameters<typeof buildGateway>[0]["config"] = {
    providers: [
      {
        name: "deepseek",
        apiKey: "test-key",
        baseUrl: "https://stub.invalid/v1",
        models: [model("plan-strong", "Strong"), model("plan-frontier", "Frontier")],
        enabled: true,
      },
    ],
    defaultProvider: "deepseek",
  };
  gateway = buildGateway({
    config,
    checkedSources: ["test"],
    recording: { kind: "recorded", recorder: new LlmCallLedger(new LlmCallRepository(db), () => new Date()) },
  });
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ourProjects.clear();
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM project_contracts WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE in_reply_to IS NOT NULL AND project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("first plan", () => {
  test("vision v1 becomes an Epic -> Task plan with recorded calls, and the Liaison reports it once", async () => {
    decompositionModel();
    const projectId = await projectWithVision();

    const outcomes = await planner().runPending();

    // Two decomposed tasks plus the scaffold task decomposition always adds.
    expect(outcomes).toEqual([{ kind: "planned", projectId, epics: 1, tasks: 3 }]);
    const items = await workItemsOf(projectId);
    const epics = items.filter((i) => i.level === "Epic");
    expect(epics).toHaveLength(1);
    const tasks = items.filter((i) => i.level === "Task");
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.parentId === epics[0]?.id)).toBe(true);
    expect(await edgesOf(projectId)).toEqual(EXPECTED_EDGES);
    const sites = await callSitesOf(projectId);
    expect(sites).toHaveLength(2);
    expect(new Set(sites)).toEqual(new Set(["decomposition"]));
    expect((await new ProjectRepository(db).get(projectId))?.status).toBe("active");

    expect(await reports().runPending()).toEqual([{ kind: "posted", projectId, subject: "first-plan" }]);
    expect(await reports().runPending()).toEqual([]);
    const outbound = await outboundOf(projectId);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.kind).toBe("report");
    // The generic scaffold is stated apart, not counted toward the client's goal.
    expect(outbound[0]?.body).toMatch(/1 epic \(".*"\), split into 2 tasks for what you asked for\./);
    expect(outbound[0]?.body).toContain("Before those, 1 standard setup task prepares the project's basic structure");
  });

  test("each task records which producer wrote it, and no decomposition temp id is stored", async () => {
    decompositionModel();
    const projectId = await projectWithVision();
    await planner().runPending();

    const specs = await db.execute(
      sql`SELECT title, task_spec AS "taskSpec" FROM work_items WHERE project_id = ${projectId} AND level = 'Task'`,
    );
    const rows = z.array(z.object({ title: z.string(), taskSpec: z.record(z.string(), z.unknown()) })).parse(specs.rows);
    expect(rows.map((r) => `${r.title}: ${String(r.taskSpec["origin"])}`).sort()).toEqual(
      [`${CLASS_LIST}: decomposition`, `${BOOKING_FORM}: decomposition`, `${SCAFFOLD_TITLE}: scaffold`].sort(),
    );
    expect(rows.every((r) => !("priorWorkPointers" in r.taskSpec))).toBe(true);
  });

  test("a planned project is never planned again", async () => {
    decompositionModel();
    const projectId = await projectWithVision();
    await planner().runPending();
    const mock = decompositionModel();

    expect(await planner().runPending()).toEqual([]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await workItemsOf(projectId)).toHaveLength(4);
  });

  test("the client's answers reach decomposition and the knowledge graph reaches the persisted contract", async () => {
    const mock = decompositionModel();
    const projectId = await projectWithVision([
      { question: "Which studio opens first?", answer: "The harbour studio", answeredAt: "2026-10-13T00:00:00Z" },
    ]);

    expect(await planner().runPending()).toEqual([{ kind: "planned", projectId, epics: 1, tasks: 3 }]);

    expect(mock.doGenerateCalls.some((call) => JSON.stringify(call.prompt).includes("The harbour studio"))).toBe(true);
    const contract = await db.execute(
      sql`SELECT contract FROM project_contracts WHERE project_id = ${projectId} ORDER BY version DESC LIMIT 1`,
    );
    const [row] = z
      .array(z.object({ contract: z.object({ knowledge: z.object({ nodes: z.array(z.object({ label: z.string() })) }) }) }))
      .parse(contract.rows);
    expect(row?.contract.knowledge.nodes.map((n) => n.label)).toContain("Stated language");
  });

  test("a plan with an unresolved edge writes nothing and the project still awaits its first plan", async () => {
    const projectId = await projectWithVision();
    const store = createFirstPlanStore(db);

    const write = store.writeFirstPlan({
      projectId,
      items: [
        { tempId: "epic-1", level: "Epic", title: "Epic" },
        { tempId: "task-1", level: "Task", title: "Task", parentId: "epic-1" },
      ],
      edges: [{ from: "task-1", to: "ghost" }],
      knowledge: KNOWLEDGE,
    });

    await expect(write).rejects.toMatchObject({ name: "BulkReferenceError", reference: "ghost" });
    expect(await workItemsOf(projectId)).toHaveLength(0);
    expect((await store.projectsAwaitingPlan()).map((p) => p.projectId)).toContain(projectId);
  });

  test("an invalid model response three times writes no plan, blocks the project and reports once", async () => {
    stubModel({ doGenerate: jsonResult({ nodes: "not a graph" }) });
    const projectId = await projectWithVision();
    const delivery = planner();

    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) {
      for (const outcome of await delivery.runPending()) kinds.push(outcome.kind);
    }
    expect(kinds).toEqual(["failed", "failed", "stopped"]);
    expect(await delivery.runPending()).toEqual([]);

    expect(await workItemsOf(projectId)).toHaveLength(0);
    const project = await new ProjectRepository(db).get(projectId);
    expect(project?.status).toBe("blocked");
    const row = await db.execute(
      sql`SELECT plan_attempts AS "attempts", plan_last_error AS "error" FROM projects WHERE id = ${projectId}`,
    );
    const [recorded] = z.array(z.object({ attempts: z.number(), error: z.string() })).parse(row.rows);
    expect(recorded?.attempts).toBe(3);
    expect(recorded?.error).toMatch(/StructuredOutputExhausted/);
    expect(new Set(await callSitesOf(projectId))).toEqual(new Set(["decomposition"]));

    expect(await reports().runPending()).toEqual([{ kind: "posted", projectId, subject: "planning-stopped" }]);
    expect(await reports().runPending()).toEqual([]);
    const outbound = await outboundOf(projectId);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.body).toMatch(/could not turn this project's vision into a plan after 3 attempts/);
    expect(outbound[0]?.body).not.toMatch(/StructuredOutputExhausted|caused by|Error:/);
  });
});

describe("tender to first plan", () => {
  test("a tender taken in by the Liaison is planned by Delivery and reported to the client", async () => {
    const tenderBody = "Booking page for my two pottery studios.";
    const created = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, tenderBody);
    const projectId = created.project.id;
    ourProjects.add(projectId);

    stubModel({ doGenerate: jsonResult(INTAKE) });
    expect(await intake().runPending()).toEqual([
      { kind: "recorded", tenderId: created.message.id, projectId, questions: 2 },
    ]);
    const visions = await db.execute(
      sql`SELECT version, vision_text AS "visionText" FROM vision_documents WHERE project_id = ${projectId}`,
    );
    expect(z.array(z.object({ version: z.number(), visionText: z.string() })).parse(visions.rows)).toEqual([
      { version: 1, visionText: tenderBody },
    ]);

    const decomposition = decompositionModel();
    expect(await planner().runPending()).toEqual([{ kind: "planned", projectId, epics: 1, tasks: 3 }]);
    // Delivery plans on the assumptions the open questions adopted, not only the unasked one.
    const prompts = decomposition.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    for (const adopted of ["The harbour studio opens first.", "A class has twelve seats.", "Bookings need no account."]) {
      expect(prompts.some((p) => p.includes(adopted))).toBe(true);
    }
    const items = await workItemsOf(projectId);
    expect(items.filter((i) => i.level === "Epic")).toHaveLength(1);
    expect(items.filter((i) => i.level === "Task")).toHaveLength(3);
    expect(await edgesOf(projectId)).toEqual(EXPECTED_EDGES);
    expect(new Set(await callSitesOf(projectId))).toEqual(new Set(["liaison-intake", "decomposition"]));

    expect(await reports().runPending()).toEqual([{ kind: "posted", projectId, subject: "first-plan" }]);
    const outbound = await outboundOf(projectId);
    const questions = outbound.filter((m) => m.kind === "question" && m.inReplyTo === created.message.id);
    expect(questions.map((q) => q.body.split("\n")[0])).toEqual(INTAKE.questions.map((q) => q.text));
    for (const question of questions) {
      expect(question.body.match(/until you answer/gi)).toHaveLength(1);
    }
    expect(questions[0]?.body).toContain("Until you answer, we proceed on this assumption: The harbour studio opens first.");
    const report = outbound.filter((m) => m.kind === "report");
    expect(report).toHaveLength(1);
    expect(report[0]?.body).toMatch(/split into 2 tasks for what you asked for\./);
    expect(outbound).toHaveLength(3);
  });
});
