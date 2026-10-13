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
import { RosterDerivation } from "@ashara/organization";
import type { RosterStore } from "@ashara/organization";
import { FirstPlanner } from "@ashara/planning";
import type { FirstPlanStore } from "@ashara/planning";
import type { ProjectId } from "@ashara/shared";
import { createFirstPlanStore, createPlanReportStore } from "./first-plan-store.js";
import { createIntakeStore } from "./intake-store.js";
import { createRosterStore } from "./roster-store.js";

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
    {
      ref: "t1", title: CLASS_LIST, description: "List classes.", dependsOn: [],
      endState: "Both studios' classes are listed", scope: "class listing", deliverables: ["class list"],
    },
    {
      ref: "t2", title: BOOKING_FORM, description: "Book a seat.", dependsOn: ["t1"],
      endState: "A member books a seat", scope: "booking", deliverables: ["booking form"],
    },
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

const ROSTER = {
  roles: [
    { name: "Liaison", responsibility: "Talks to the studio owner.", capabilities: ["client-comms"] },
    { name: "Platform", responsibility: "Defines how the booking page is built and tested.", capabilities: ["write-environment"] },
    { name: "Implementer", responsibility: "Builds the booking page.", capabilities: ["write-source"] },
    { name: "Check author", responsibility: "Writes the checks the booking page must pass.", capabilities: ["author-checks"] },
  ],
};

/** One developer who also writes the checks that judge them: validateRoster rejects it. */
const SELF_JUDGING_ROSTER = {
  roles: [
    ROSTER.roles[0],
    ROSTER.roles[1],
    { name: "Developer", responsibility: "Builds and checks the page.", capabilities: ["write-source", "author-checks"] },
  ],
};

function rosterStep(): RosterDerivation {
  const store = createRosterStore(db);
  const ours: RosterStore = {
    ...store,
    projectsAwaitingRoster: async () =>
      (await store.projectsAwaitingRoster()).filter((p) => ourProjects.has(p.projectId)),
  };
  return new RosterDerivation({ llm: gateway, store: ours });
}

/** A project with vision v1 and, unless told otherwise, a roster recorded without a model call. */
async function projectWithVision(userAnswers: unknown[] = [], withRoster = true): Promise<ProjectId> {
  const project = await new ProjectRepository(db).create(`${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, clientId);
  ourProjects.add(project.id);
  await new VisionRepository(db).create(project.id, {
    visionText: "Booking page for my two pottery studios.",
    summary: "A booking page for two pottery studios.",
    scopeBoundaries: ["In: class booking", "Out: payments"],
    inferences: [{ statement: "Bookings need no account.", rationale: "Walk-in customers book.", status: "Inferred" }],
    userAnswers,
  });
  if (withRoster) {
    const [first, ...rest] = ROSTER.roles.map((role) => ({
      id: randomUUID(),
      name: role.name,
      responsibility: role.responsibility,
      capabilities: z.tuple([z.enum(["client-comms", "write-source", "author-checks", "write-environment"])]).parse(role.capabilities),
    }));
    if (first === undefined) throw new Error("ROSTER has no roles");
    const recorded = await createRosterStore(db).recordRoster({
      projectId: project.id,
      visionVersion: 1,
      revision: 1,
      roles: [first, ...rest],
    });
    expect(recorded).toBe("recorded");
  }
  return project.id;
}

const RosterRowSchema = z.object({ roleId: z.string(), name: z.string(), capabilities: z.array(z.string()), revision: z.number() });

async function rosterOf(projectId: ProjectId) {
  const result = await db.execute(
    sql`SELECT role_id AS "roleId", name, capabilities, revision FROM roster_roles WHERE project_id = ${projectId} ORDER BY name`,
  );
  return z.array(RosterRowSchema).parse(result.rows);
}

/** Each task's title with its work kind and the name of the role that owns it; an epic shows none. */
async function ownersOf(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT w.level, w.title, w.work_kind AS "workKind", r.name AS "owner"
    FROM work_items w
    LEFT JOIN roster_roles r ON r.project_id = w.project_id AND r.role_id = w.owner_role_id
    WHERE w.project_id = ${projectId}`);
  return z
    .array(z.object({ level: z.string(), title: z.string(), workKind: z.string().nullable(), owner: z.string().nullable() }))
    .parse(result.rows)
    .map((row) => `${row.level} ${row.title}: ${row.workKind ?? "-"} / ${row.owner ?? "-"}`)
    .sort();
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

const SPRINT0_TITLE = "Define and commit the project environment";

/** t2 depends on t1, and every decomposed task depends on the Sprint 0 task decomposition adds. */
const EXPECTED_EDGES = [
  `${BOOKING_FORM} -> ${CLASS_LIST}`,
  `${BOOKING_FORM} -> ${SPRINT0_TITLE}`,
  `${CLASS_LIST} -> ${SPRINT0_TITLE}`,
].sort();

/** The ordering hints recorded as dropped with the project's first plan. */
async function droppedOf(projectId: ProjectId) {
  const result = await db.execute(
    sql`SELECT plan_dropped_dependencies AS "dropped" FROM projects WHERE id = ${projectId}`,
  );
  const [row] = z
    .array(z.object({ dropped: z.array(z.object({ dependentTaskTitle: z.string(), unresolvedRef: z.string() })) }))
    .parse(result.rows);
  return row?.dropped;
}

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
        providerType: "deepseek",
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
    recording: { kind: "recorded", recorder: new LlmCallLedger(new LlmCallRepository(db)) },
    clock: () => new Date(),
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
  await db.execute(sql`DELETE FROM roster_roles WHERE project_id IN (${ours})`);
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

    // Two decomposed tasks plus the Sprint 0 task decomposition always adds.
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
    // Sprint 0 is stated apart, not counted toward the client's goal.
    expect(outbound[0]?.body).toMatch(/1 epic \(".*"\), split into 2 tasks for what you asked for\./);
    expect(outbound[0]?.body).toContain("First, the team sets up the project environment");
    expect(outbound[0]?.body).not.toContain("ordering hint");
    expect(await droppedOf(projectId)).toEqual([]);
  });

  test("an ordering hint the re-ask drops is recorded with the plan and stated in its report", async () => {
    let taskCalls = 0;
    stubModel({
      doGenerate: async (options) => {
        if (JSON.stringify(options.prompt).includes("structured knowledge graph")) return jsonResult(KNOWLEDGE);
        taskCalls += 1;
        const [classList, bookingForm] = TASKS.tasks;
        // First answer names a task it never wrote; the corrected one drops that edge.
        return jsonResult(taskCalls === 1 ? { tasks: [classList, { ...bookingForm, dependsOn: ["t1", "payments"] }] } : TASKS);
      },
    });
    const projectId = await projectWithVision();

    expect(await planner().runPending()).toEqual([{ kind: "planned", projectId, epics: 1, tasks: 3 }]);

    expect(await droppedOf(projectId)).toEqual([{ dependentTaskTitle: BOOKING_FORM, unresolvedRef: "payments" }]);
    expect(await edgesOf(projectId)).toEqual(EXPECTED_EDGES);
    expect(await reports().runPending()).toEqual([{ kind: "posted", projectId, subject: "first-plan" }]);
    expect((await outboundOf(projectId))[0]?.body).toContain("1 ordering hint was dropped while planning");
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
      [`${CLASS_LIST}: decomposition`, `${BOOKING_FORM}: decomposition`, `${SPRINT0_TITLE}: sprint0`].sort(),
    );
    expect(rows.every((r) => !("priorWorkPointers" in r.taskSpec))).toBe(true);
  });

  test("each task is owned by the role holding the capability its kind of work needs", async () => {
    decompositionModel();
    const projectId = await projectWithVision();

    await planner().runPending();

    const epicTitle = (await ownersOf(projectId)).find((row) => row.startsWith("Epic "));
    expect(epicTitle).toMatch(/: - \/ -$/);
    expect((await ownersOf(projectId)).filter((row) => row.startsWith("Task "))).toEqual(
      [
        `Task ${CLASS_LIST}: implementation / Implementer`,
        `Task ${BOOKING_FORM}: implementation / Implementer`,
        `Task ${SPRINT0_TITLE}: environment / Platform`,
      ].sort(),
    );
  });

  test("a plan that would leave a task without an owner writes nothing", async () => {
    const projectId = await projectWithVision();
    const store = createFirstPlanStore(db);

    const write = store.writeFirstPlan({
      projectId,
      items: [
        { tempId: "epic-1", level: "Epic", title: "Epic" },
        { tempId: "task-1", level: "Task", title: "Task", parentId: "epic-1" },
      ],
      edges: [],
      knowledge: KNOWLEDGE,
      owners: [],
      droppedDependencies: [],
    });

    await expect(write).rejects.toMatchObject({ name: "FirstPlanTaskUnowned" });
    expect(await workItemsOf(projectId)).toHaveLength(0);
  });

  test("a project with a vision and no roster is not planned", async () => {
    const mock = decompositionModel();
    const projectId = await projectWithVision([], false);

    expect(await planner().runPending()).toEqual([]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await workItemsOf(projectId)).toHaveLength(0);
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
      owners: [],
      droppedDependencies: [],
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

describe("roster", () => {
  test("a valid roster from vision v1 is recorded with its four capability holders", async () => {
    stubModel({ doGenerate: jsonResult(ROSTER) });
    const projectId = await projectWithVision([], false);

    const outcomes = await rosterStep().runPending();

    expect(outcomes).toEqual([
      { kind: "recorded", projectId, revision: 1, roles: ROSTER.roles.map((r) => r.name) },
    ]);
    const rows = await rosterOf(projectId);
    expect(rows.map((r) => `${r.name}: ${r.capabilities.join(",")}`)).toEqual([
      "Check author: author-checks",
      "Implementer: write-source",
      "Liaison: client-comms",
      "Platform: write-environment",
    ]);
    expect(new Set(rows.map((r) => r.revision))).toEqual(new Set([1]));
    expect(await callSitesOf(projectId)).toEqual(["roster"]);
    // A project with a roster is not derived again.
    expect(await rosterStep().runPending()).toEqual([]);
  });

  test("a roster that breaks a rule is re-asked with the violation named, and the valid one recorded", async () => {
    let calls = 0;
    const mock = stubModel({ doGenerate: async () => jsonResult(calls++ === 0 ? SELF_JUDGING_ROSTER : ROSTER) });
    const projectId = await projectWithVision([], false);

    expect((await rosterStep().runPending()).map((o) => o.kind)).toEqual(["recorded"]);

    expect(mock.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(mock.doGenerateCalls[1]?.prompt)).toContain(
      'Role \\"Developer\\" holds both \\"write-source\\" and \\"author-checks\\"',
    );
    expect((await rosterOf(projectId)).map((r) => r.name)).toEqual(["Check author", "Implementer", "Liaison", "Platform"]);
  });

  test("a model that never gives a valid roster blocks the project with the violations, and nothing is planned", async () => {
    stubModel({ doGenerate: jsonResult(SELF_JUDGING_ROSTER) });
    const projectId = await projectWithVision([], false);

    const outcomes = await rosterStep().runPending();

    expect(outcomes.map((o) => o.kind)).toEqual(["project-blocked"]);
    expect(await rosterOf(projectId)).toEqual([]);
    const row = await db.execute(
      sql`SELECT status, blocked_error_class AS "errorClass", blocked_reason AS "reason" FROM projects WHERE id = ${projectId}`,
    );
    const [blocked] = z.array(z.object({ status: z.string(), errorClass: z.string(), reason: z.string() })).parse(row.rows);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.errorClass).toBe("RosterDerivationExhausted");
    expect(blocked?.reason).toContain('Role "Developer" holds both "write-source" and "author-checks"');
    expect(await rosterStep().runPending()).toEqual([]);
    expect(await planner().runPending()).toEqual([]);
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

    // Delivery does not plan a project Organization has not staffed.
    decompositionModel();
    expect(await planner().runPending()).toEqual([]);

    const rosterModel = stubModel({ doGenerate: jsonResult(ROSTER) });
    expect((await rosterStep().runPending()).map((o) => o.kind)).toEqual(["recorded"]);
    // The roster is derived from vision v1: the tender and the assumptions intake recorded.
    const rosterPrompt = JSON.stringify(rosterModel.doGenerateCalls[0]?.prompt);
    expect(rosterPrompt).toContain(tenderBody);
    expect(rosterPrompt).toContain("A class has twelve seats.");

    const decomposition = decompositionModel();
    expect(await planner().runPending()).toEqual([{ kind: "planned", projectId, epics: 1, tasks: 3 }]);
    expect((await ownersOf(projectId)).filter((row) => row.startsWith("Task "))).toEqual(
      [
        `Task ${CLASS_LIST}: implementation / Implementer`,
        `Task ${BOOKING_FORM}: implementation / Implementer`,
        `Task ${SPRINT0_TITLE}: environment / Platform`,
      ].sort(),
    );
    // Delivery plans on the assumptions the open questions adopted, not only the unasked one.
    const prompts = decomposition.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    for (const adopted of ["The harbour studio opens first.", "A class has twelve seats.", "Bookings need no account."]) {
      expect(prompts.some((p) => p.includes(adopted))).toBe(true);
    }
    const items = await workItemsOf(projectId);
    expect(items.filter((i) => i.level === "Epic")).toHaveLength(1);
    expect(items.filter((i) => i.level === "Task")).toHaveLength(3);
    expect(await edgesOf(projectId)).toEqual(EXPECTED_EDGES);
    expect(new Set(await callSitesOf(projectId))).toEqual(new Set(["liaison-intake", "roster", "decomposition"]));

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
    expect(report[0]?.body).toContain("First, the team sets up the project environment");
    expect(outbound).toHaveLength(3);
  });
});
