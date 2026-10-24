import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { LlmCallRepository } from "@ashara/finance";
import { ClientAnswers, PlanReports, TenderIntake, ClientMessageRepository, createProjectWithTender } from "@ashara/engagement";
import type { AnswerStore, IntakeStore, PlanReportStore } from "@ashara/engagement";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { FirstPlanner, PlanningService, Replanner, startWorkItem, createReplanStore, adaptWorkItemRepo, createFirstPlanStore, WorkItemRowRepository } from "@ashara/delivery";
import { RosterDerivation } from "@ashara/organization";
import type { RosterStore } from "@ashara/organization";
import type { FirstPlanStore, ReplanStore } from "@ashara/delivery";
import { parseWorkItemId, type ProjectId, type StepContainment } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import { createAnswerStore } from "@ashara/server/answer-store";
import { createIntakeStore } from "@ashara/server/intake-store";
import { createRosterStore } from "@ashara/server/roster-store";
import { createPlanReportStore } from "@ashara/server/plan-report-store";
import { projectState } from "../simulator/project-state.js";
import { citingItemsToCheck } from "../simulator/stand-ins/planner.js";
import { haltReportsOf } from "./terminal-reports.js";

// The plan revision suites' shared fixture. Every row a suite writes belongs to a project it
// creates under a unique name, and its afterAll deletes exactly those rows. Each store is narrowed
// to the suite's projects. No real LLM call is made: the provider factory returns a
// MockLanguageModelV4 that answers each call by what its prompt asks.

/** A fixture step found the database without the row it was built to read. */
class ReplanSuiteFixtureError extends Error {
  constructor(readonly detail: string) {
    super(`replan suite fixture: ${detail}`);
    this.name = "ReplanSuiteFixtureError";
  }
}

/**
 * Registers the suite's database, gateway and cleanup hooks and returns its helpers. `stub` is the
 * test file's hoisted model holder, which its `@ai-sdk/deepseek` mock answers with.
 *
 * @testseam the plan revision store suites (replan-store.test.ts, replan-repair-store.test.ts, assumption-reaches-guarantees.test.ts) share it
 */
export function replanStoreSuite(stub: { model: unknown }) {
  const DATABASE_URL = resolveTestDatabaseUrl(process.env);
  const TEST_SPEND_CAPS = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };
  const NAME_PREFIX = `replan-test-${randomUUID().slice(0, 8)}`;
  const MERGE_COMMIT = "a".repeat(40);

  let db: Database;
  let gateway: GuardedModelAccess;
  let clientId: string;
  const ourProjects = new Set<string>();

  function model(id: string, capabilityLevel: ModelConfig["capabilityLevel"]): ModelConfig {
    return {
      id,
      apiModelId: `${id}-api`,
      provider: "deepseek",
      capabilityLevel,
      thinkingOffCapabilityLevel: capabilityLevel,
      inputCostPer1M: 1,
      outputCostPer1M: 2,
      maxContextTokens: 100_000,
      cacheReadCostPer1M: null,
      cacheWriteCostPer1M: null,
      priceWindows: [], priceTiers: [], datedPrices: [],
    };
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

  const INTAKE = {
    summary: "A booking page for the client's two pottery studios.",
    interface: [{ id: "I1", text: "The booking page.", source: { kind: "tender", quote: "Booking page" } }],
    guarantees: [
      {
        id: "G1",
        statement: "A client books a class at either studio.",
        observable: { interface: ["I1"], observation: "output" },
        refutedBy: ["A booking at either studio is refused."],
        source: { kind: "tender", quote: "Booking page for my two pottery studios." },
      },
    ],
    assumptions: [{ id: "A2", statement: "Bookings need no account.", rationale: "The tender says walk-in customers book.", kind: "client-visible", underpins: ["G1"] }],
    questions: [
      {
        text: "Which studio opens first?",
        whyItMatters: "It orders the work.",
        assumption: { id: "A1", statement: "The harbour studio opens first.", rationale: "The tender names it first.", kind: "client-visible", underpins: ["G1"] },
      },
    ],
    exclusions: [],
  };

  const ROSTER = {
    roles: [
      { name: "Liaison", responsibility: "Talks to the studio owner.", capabilities: ["client-comms"] },
      { name: "Platform", responsibility: "Defines how the page is built and tested.", capabilities: ["write-environment"] },
      { name: "Implementer", responsibility: "Builds the booking page.", capabilities: ["write-source"] },
      { name: "Check author", responsibility: "Writes the checks the page must pass.", capabilities: ["author-checks"] },
    ],
  };

  const FIRST_TASKS = {
    tasks: [
      {
        ref: "t1", title: "Open harbour studio bookings", description: "Harbour bookings.", dependsOn: [], goal: "",
        endState: "Harbour classes can be booked", scope: "harbour bookings", deliverables: [{ text: "harbour booking", sources: ["G1", "A1"] }], acceptance: [{ text: "a client uses the harbour booking", sources: ["G1"] }],
        capability: "Medium", capabilityReason: "graded for the test",
      },
    ],
  };
  const REVISED_TASKS = {
    tasks: [
      {
        ref: "t1", title: "Open hill studio bookings", description: "Hill bookings.", dependsOn: [], goal: "",
        endState: "Hill classes can be booked", scope: "hill bookings", deliverables: [{ text: "hill booking", sources: ["G1"] }], acceptance: [{ text: "a client uses the hill booking", sources: ["G1"] }],
        capability: "Light", capabilityReason: "graded for the test",
      },
    ],
  };

  const REPAIRED_TASKS = {
    tasks: [
      {
        ref: "t1", title: "Book a harbour class by its date", description: "Harbour bookings, smaller.", dependsOn: [], goal: "",
        endState: "A harbour class can be booked by its date", scope: "harbour bookings by date", deliverables: [{ text: "harbour booking", sources: ["G1"] }], acceptance: [{ text: "a client uses the harbour booking", sources: ["G1"] }],
        capability: "Medium", capabilityReason: "graded for the test",
      },
    ],
  };

  /** The intake of INTAKE with a second question, whose assumption a second answer can change. */
  const TWO_QUESTION_INTAKE = {
    ...INTAKE,
    questions: [
      ...INTAKE.questions,
      {
        text: "Do classes need a teacher named?",
        whyItMatters: "It decides what a booking shows.",
        assumption: { id: "A3", statement: "A class shows no teacher.", rationale: "The tender names none.", kind: "client-visible", underpins: ["G1"] },
      },
    ],
  };

  /** One model for every call, answering each by what its prompt asks. */
  function pipelineModel(
    options: {
      readonly reading?: unknown;
      readonly environmentChange?: boolean;
      readonly intake?: unknown;
      readonly revision?: unknown;
      readonly repaired?: Parameters<typeof citingItemsToCheck>[0];
      readonly firstTasks?: Parameters<typeof citingItemsToCheck>[0];
    } = {},
  ): MockLanguageModelV4 {
    const mock = new MockLanguageModelV4({
      doGenerate: async (call) => {
        const prompt = JSON.stringify(call.prompt);
        if (prompt.includes("Read their answer and say what it does")) return jsonResult({ reading: options.reading ?? { verdict: "confirms", amends: [] } });
        if (prompt.includes("prepare the first version of the project's vision")) return jsonResult(options.intake ?? INTAKE);
        if (prompt.includes("client-comms")) return jsonResult(ROSTER);
        if (prompt.includes("needs the project environment changed") || prompt.includes("Work on a project stopped")) {
          // eslint-disable-next-line no-restricted-syntax -- policy default: a scripted planner told nothing else judges no environment change needed
          return jsonResult({ environmentChange: options.environmentChange ?? false, reason: "Only what is booked changes." });
        }
        if (prompt.includes("changed what is built after work began")) return jsonResult(options.revision ?? citingItemsToCheck(REVISED_TASKS, prompt));
        if (prompt.includes("Plan the work still to do again")) return jsonResult(citingItemsToCheck(options.repaired ?? REPAIRED_TASKS, prompt));
        return jsonResult(citingItemsToCheck(options.firstTasks ?? FIRST_TASKS, prompt));
      },
    });
    stub.model = mock;
    return mock;
  }

  function ours<T extends { readonly projectId: string }>(list: () => Promise<readonly T[]>): () => Promise<T[]> {
    return async () => (await list()).filter((row) => ourProjects.has(row.projectId));
  }

  function replanner(containment: StepContainment = memoryStepContainment(() => true)): Replanner {
    const store = createReplanStore(db, recordingLogger());
    const narrowed: ReplanStore = { ...store, projectsAwaitingReplan: ours(() => store.projectsAwaitingReplan()) };
    return new Replanner({ shutdownSignal: new AbortController().signal, logger: recordingLogger(), containment, llm: gateway, store: narrowed });
  }

  function planReports(): PlanReports {
    const store = createPlanReportStore(db);
    const narrowed: PlanReportStore = {
      ...store,
      dueReports: ours(() => store.dueReports()),
      dueRevisionReports: ours(() => store.dueRevisionReports()),
    };
    return new PlanReports(narrowed, memoryStepContainment(() => true));
  }

  /** The Liaison's halt and resumption reports over this suite's projects, each halt's terminal sweep recorded first, as the core loop orders them. */
  function blockReports(): ReturnType<typeof haltReportsOf> {
    return haltReportsOf(db, (projectId) => ourProjects.has(projectId));
  }

  /** A tender taken in, its roster derived and its first plan written: Sprint 0, a check task and one task. */
  async function plannedProject(
    options: { readonly reported: boolean; readonly intake?: unknown; readonly firstTasks?: Parameters<typeof citingItemsToCheck>[0] } = { reported: true },
  ): Promise<{ projectId: ProjectId; questionId: string; questionIds: string[] }> {
    const created = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Booking page for my two pottery studios.");
    const projectId = created.project.id;
    ourProjects.add(projectId);
    pipelineModel({ intake: options.intake, firstTasks: options.firstTasks });
    const intakeStore = createIntakeStore(db);
    const intake: IntakeStore = { ...intakeStore, openTenders: ours(() => intakeStore.openTenders()) };
    expect((await new TenderIntake({ shutdownSignal: new AbortController().signal, containment: memoryStepContainment(() => true), llm: gateway, store: intake }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
    const rosterStore = createRosterStore(db);
    const roster: RosterStore = { ...rosterStore, projectsAwaitingRoster: ours(() => rosterStore.projectsAwaitingRoster()) };
    expect((await new RosterDerivation({ shutdownSignal: new AbortController().signal, containment: memoryStepContainment(() => true), llm: gateway, store: roster }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
    const planStore = createFirstPlanStore(db);
    const plan: FirstPlanStore = { ...planStore, projectsAwaitingPlan: ours(() => planStore.projectsAwaitingPlan()) };
    expect((await new FirstPlanner({ shutdownSignal: new AbortController().signal, logger: recordingLogger(), containment: memoryStepContainment(() => true), llm: gateway, store: plan }).runPending()).map((o) => o.kind)).toEqual(["planned"]);
    if (options.reported) expect((await planReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    const questions = (await new ClientMessageRepository(db).listByProject(projectId)).filter((m) => m.kind === "question");
    const [question] = questions;
    if (question === undefined) throw new ReplanSuiteFixtureError(`project ${projectId}: intake posted no question`);
    return { projectId, questionId: question.id, questionIds: questions.map((q) => q.id) };
  }

  const HILL_FIRST = { body: "No, the hill studio opens first.", statement: "The hill studio opens first.", amends: [] };

  /**
   * The client's answer changing the plan's assumption, or confirming it as `verdict` "confirms" says while it
   * restates other records, read by the Liaison: the project awaits a revision for it.
   */
  async function contradict(
    projectId: ProjectId,
    questionId: string,
    change: { readonly body: string; readonly statement: string; readonly amends: readonly unknown[]; readonly verdict?: "confirms" } = HILL_FIRST,
  ): Promise<string> {
    const row = await new ClientMessageRepository(db).insertInbound({
      projectId,
      kind: "answer",
      body: change.body,
      inReplyTo: questionId,
    });
    pipelineModel({
      reading:
        change.verdict === "confirms"
          ? { verdict: "confirms", amends: change.amends }
          : { verdict: "changes", statement: change.statement, kind: "client-visible", amends: change.amends },
    });
    const answerStore = createAnswerStore(db);
    const narrowed: AnswerStore = { ...answerStore, openAnswers: ours(() => answerStore.openAnswers()) };
    const outcomes = await new ClientAnswers({ shutdownSignal: new AbortController().signal, containment: memoryStepContainment(() => true), llm: gateway, store: narrowed }).runPending();
    expect(outcomes.map((o) => o.kind === "stated" && o.replanRequested)).toEqual([true]);
    return row.id;
  }

  const ItemRowSchema = z.object({
    id: z.string(),
    title: z.string(),
    level: z.string(),
    status: z.string(),
    origin: z.string().nullable(),
    reason: z.unknown(),
  });

  async function itemsOf(projectId: ProjectId) {
    const result = await db.execute(sql`
      SELECT id, title, level, status, task_spec->>'origin' AS origin, blocked_reason AS reason
      FROM work_items WHERE project_id = ${projectId} ORDER BY created_at, id`);
    return z.array(ItemRowSchema).parse(result.rows);
  }

  /** Starts a task as dispatch does: the task and every Pending ancestor, its Epic, go InProgress. */
  async function startTask(id: string): Promise<void> {
    const repo = adaptWorkItemRepo(new WorkItemRowRepository(db));
    const task = await PlanningService.findWorkItem(repo, parseWorkItemId(id, "test"));
    if (task === null) throw new ReplanSuiteFixtureError(`task ${id} not found`);
    startWorkItem(task);
    await PlanningService.saveWorkItem(repo, task, "Pending");
    await PlanningService.activateAncestors(repo, task.parentId);
  }

  /** Completes a started task as its routed success does, settling its Epic when every child is done. */
  async function completeTask(id: string): Promise<void> {
    await PlanningService.route(adaptWorkItemRepo(new WorkItemRowRepository(db)), parseWorkItemId(id, "test"), "passed");
  }

  async function dependenciesOf(id: string): Promise<string[]> {
    const result = await db.execute(sql`SELECT to_id AS "to" FROM dependencies WHERE from_id = ${id}`);
    return z.array(z.object({ to: z.string() })).parse(result.rows).map((row) => row.to);
  }

  /** The project's status and category, and the client messages whose correction's revision it awaits (correction_holds), oldest first. */
  async function projectRow(projectId: ProjectId) {
    const result = await db.execute(sql`
      SELECT ${projectState} AS status, (SELECT b.kind FROM project_blocks b WHERE b.project_id = projects.id AND b.ended_at IS NULL) AS "category",
        COALESCE((SELECT json_agg(ch.requested_by ORDER BY ch.created_at) FROM correction_holds ch
          WHERE ch.project_id = projects.id AND ch.plan_revision_id IS NULL), '[]'::json) AS "awaiting"
      FROM projects WHERE id = ${projectId}`);
    const [row] = z
      .array(z.object({ status: z.string(), awaiting: z.array(z.string()), category: z.string().nullable() }))
      .parse(result.rows);
    if (row === undefined) throw new ReplanSuiteFixtureError(`project ${projectId} not found`);
    return row;
  }

  async function reportsOf(projectId: ProjectId) {
    return (await new ClientMessageRepository(db).listByProject(projectId)).filter((m) => m.kind === "report");
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
    gateway = new GuardedModelAccess(buildGateway({
      models: sdkLanguageModels,
      config: {
        providers: [
          {
            name: "deepseek",
            providerType: "deepseek",
            apiKey: "test-key",
            baseUrl: "https://stub.invalid/v1",
            models: [model("replan-strong", "Strong"), model("replan-frontier", "Frontier")],
            enabled: true,
          },
        ],
        defaultProvider: "deepseek",
        contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
      },
      checkedSources: ["test"],
      clock: () => new Date(),
    }), new LlmCallLedger(
      new LlmCallRepository(db),
      new SpendCap({ ledger: new LlmCallRepository(db), caps: TEST_SPEND_CAPS }),
    ), recordingLogger());
  });

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    ourProjects.clear();
  });

  afterAll(async () => {
    const pattern = `${NAME_PREFIX}%`;
    const projects = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
    await db.execute(sql`DELETE FROM correction_holds WHERE project_id IN (${projects})`);
    await db.execute(sql`DELETE FROM plan_revisions WHERE project_id IN (${projects})`);
    await db.execute(sql`DELETE FROM project_blocks WHERE project_id IN (${projects})`);
    await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${projects})`);
    await db.execute(sql`DELETE FROM task_checks WHERE project_id IN (${projects})`);
    await db.execute(sql`DELETE FROM dev_sessions WHERE task_id IN (SELECT id FROM work_items WHERE project_id IN (${projects}))`);
    await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${projects})`);
    await db.execute(sql`DELETE FROM roster_roles WHERE project_id IN (${projects})`);
    await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${projects})`);
    // Replies before what they reply to: a report replies to an answer, which replies to a question.
    await db.execute(sql`DELETE FROM client_messages WHERE direction = 'outbound' AND kind = 'report' AND project_id IN (${projects})`);
    await db.execute(sql`DELETE FROM client_messages WHERE kind = 'answer' AND project_id IN (${projects})`);
    await db.execute(sql`DELETE FROM client_messages WHERE in_reply_to IS NOT NULL AND project_id IN (${projects})`);
    await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${projects})`);
    await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
    await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
    await db.$client.end();
  });

  return {
    get db(): Database {
      return db;
    },
    get gateway(): GuardedModelAccess {
      return gateway;
    },
    ourProjects,
    MERGE_COMMIT,
    TWO_QUESTION_INTAKE,
    pipelineModel,
    replanner,
    planReports,
    blockReports,
    plannedProject,
    contradict,
    itemsOf,
    startTask,
    completeTask,
    dependenciesOf,
    projectRow,
    reportsOf,
  };
}
