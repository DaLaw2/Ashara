import { randomUUID } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, EventStoreRepository, LlmCallRepository } from "@ashara/db";
import { FailedApproachRepository } from "@ashara/knowledge";
import { BlockReports, ClientAnswers, TenderIntake, ClientMessageRepository, createProjectWithTender } from "@ashara/engagement";
import type { AnswerStore, BlockReportStore, IntakeStore, LiaisonAnswers } from "@ashara/engagement";
import { GuardedModelAccess, LlmCallLedger, SpendCap, WORK_BUDGET_ERROR_CLASS } from "@ashara/finance";
import type { WorkBudgets } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import {
  CoreLoop,
  DEFAULT_CONFIG,
  FailureRouter,
  FirstPlanner,
  Replanner,
  ProjectHaltRepository,
  WorkItemRowRepository,
  adaptWorkItemRepo,
  concurrentTaskLanes,
  createFirstPlanStore,
  createReplanStore,
} from "@ashara/delivery";
import type { CoreLoopDeps, FirstPlanStore, ReplanStore } from "@ashara/delivery";
import { RosterDerivation } from "@ashara/organization";
import type { RosterStore } from "@ashara/organization";
import { memoryStepContainment, recordingLogger } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { createAnswerStore } from "@ashara/server/answer-store";
import { createBlockReportStore } from "@ashara/server/block-report-store";
import { createIntakeStore } from "@ashara/server/intake-store";
import { createRosterStore } from "@ashara/server/roster-store";
import { projectState } from "../simulator/project-state.js";
import { citingItemsToCheck } from "../simulator/scripted-models.js";

// The "moved" loops have no counter of their own: a plan revision whose write finds the project
// moved (L17) and an answer whose record finds it moved (L19) are tried again next cycle,
// uncounted. Each attempt draws from the work ledger (ADR-084 decision 1), so a project that
// keeps moving under them halts as work_budget with its report, and nothing is drawn after the
// halt. The store answers "moved" on every write, as a project that never stops moving would.
// Against Postgres; no real LLM call is made.
const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NAME_PREFIX = `moved-loops-ledger-test-${randomUUID().slice(0, 8)}`;
const AMPLE_CAPS = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };
/** Model requests the project may draw past what its setup drew: each cycle of a moved loop draws at least one. */
const HEADROOM = 3;
const MAX_CYCLES = 10;

let db: ReturnType<typeof createDb>;
let setupGateway: GuardedModelAccess;
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
    priceWindows: [], priceTiers: [],
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
  inScope: ["Class booking for both studios"],
  outOfScope: ["Payments"],
  assumptions: [{ statement: "Bookings need no account.", rationale: "The tender says walk-in customers book.", kind: "client-visible" }],
  questions: [
    {
      text: "Which studio opens first?",
      whyItMatters: "It orders the work.",
      assumption: { statement: "The harbour studio opens first.", rationale: "The tender names it first.", kind: "client-visible" },
    },
  ],
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
      endState: "Harbour classes can be booked", scope: "harbour bookings", deliverables: [{ text: "harbour booking", sources: ["S1"] }], acceptance: [{ text: "a client uses the harbour booking", sources: ["S1"] }],
      capability: "Medium", capabilityReason: "graded for the test",
    },
  ],
};

const REVISED_TASKS = {
  tasks: [
    {
      ref: "t1", title: "Open hill studio bookings", description: "Hill bookings.", dependsOn: [], goal: "",
      endState: "Hill classes can be booked", scope: "hill bookings", deliverables: [{ text: "hill booking", sources: ["S1"] }], acceptance: [{ text: "a client uses the hill booking", sources: ["S1"] }],
      capability: "Light", capabilityReason: "graded for the test",
    },
  ],
};

/** One model for every call, answering each by what its prompt asks. */
function pipelineModel(reading: unknown): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({
    doGenerate: async (call) => {
      const prompt = JSON.stringify(call.prompt);
      if (prompt.includes("Read their answer and say what it does")) return jsonResult({ reading });
      if (prompt.includes("prepare the first version of the project's vision")) return jsonResult(INTAKE);
      if (prompt.includes("client-comms")) return jsonResult(ROSTER);
      if (prompt.includes("needs the project environment changed") || prompt.includes("Work on a project stopped")) {
        return jsonResult({ environmentChange: false, reason: "Only what is booked changes." });
      }
      if (prompt.includes("changed what is built after work began")) return jsonResult(citingItemsToCheck(REVISED_TASKS, prompt));
      return jsonResult(citingItemsToCheck(FIRST_TASKS, prompt));
    },
  });
  stub.model = mock;
  return mock;
}

function ours<T extends { readonly projectId: string }>(list: () => Promise<readonly T[]>): () => Promise<T[]> {
  return async () => (await list()).filter((row) => ourProjects.has(row.projectId));
}

function gateway(spendCap: SpendCap): GuardedModelAccess {
  return new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [
        {
          name: "deepseek",
          providerType: "deepseek",
          apiKey: "test-key",
          baseUrl: "https://stub.invalid/v1",
          models: [model("moved-strong", "Strong"), model("moved-frontier", "Frontier")],
          enabled: true,
        },
      ],
      defaultProvider: "deepseek",
      contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(new LlmCallRepository(db), spendCap), recordingLogger());
}

/** A tender taken in, its roster derived and its first plan written: Sprint 0, a check task and one task. */
async function plannedProject(): Promise<{ projectId: ProjectId; questionId: string }> {
  const created = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Booking page for my two pottery studios.");
  const projectId = created.project.id;
  ourProjects.add(projectId);
  pipelineModel({ verdict: "confirms" });
  const containment = memoryStepContainment(() => true);
  const intakeStore = createIntakeStore(db);
  const intake: IntakeStore = { ...intakeStore, openTenders: ours(() => intakeStore.openTenders()) };
  expect((await new TenderIntake({ containment, llm: setupGateway, store: intake }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
  const rosterStore = createRosterStore(db);
  const roster: RosterStore = { ...rosterStore, projectsAwaitingRoster: ours(() => rosterStore.projectsAwaitingRoster()) };
  expect((await new RosterDerivation({ containment, llm: setupGateway, store: roster }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
  const planStore = createFirstPlanStore(db);
  const plan: FirstPlanStore = { ...planStore, projectsAwaitingPlan: ours(() => planStore.projectsAwaitingPlan()) };
  expect((await new FirstPlanner({ containment, llm: setupGateway, store: plan }).runPending()).map((o) => o.kind)).toEqual(["planned"]);
  const [question] = (await new ClientMessageRepository(db).listByProject(projectId)).filter((m) => m.kind === "question");
  if (question === undefined) throw new Error("intake posted no question");
  return { projectId, questionId: question.id };
}

/** The client's answer to the question: open, for the Liaison to read. */
async function answer(projectId: ProjectId, questionId: string): Promise<string> {
  const row = await new ClientMessageRepository(db).insertInbound({ projectId, kind: "answer", body: "No, the hill studio opens first.", inReplyTo: questionId });
  return row.id;
}

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

/**
 * The loop over the suite's projects, with `budgets` as its work ledger: the step under test and
 * the block reports run for real, every other step finds nothing, and no task is dispatched.
 */
function loopWith(
  spendCap: SpendCap,
  steps: Pick<CoreLoopDeps, "replanning" | "liaisonAnswers"> & { readonly containment: CoreLoopDeps["containment"] },
): CoreLoop {
  const projects = new ProjectHaltRepository(db);
  const blockReportStore = createBlockReportStore(db);
  const reports: BlockReportStore = { ...blockReportStore, dueReports: ours(() => blockReportStore.dueReports()) };
  const deps: CoreLoopDeps = {
    config: { ...DEFAULT_CONFIG, workdirBase: "/nonexistent-moved-loops" },
    cycleLog: { emit: () => {} },
    logger: recordingLogger(),
    containment: steps.containment,
    workItemRepo: adaptWorkItemRepo(new WorkItemRowRepository(db)),
    eventStore: new EventStoreRepository(db),
    failedApproachRepo: new FailedApproachRepository(db),
    projectRepo: {
      get: (id) => projects.get(id),
      recordWorkspacePath: notExercised("recordWorkspacePath"),
      listActiveIds: async () => [],
      listWithWorkspace: async () => [],
      block: (id, cause) => projects.block(id, cause),
      listInfrastructureHalted: async () => [],
      resumeFromInfrastructureHalt: notExercised("resumeFromInfrastructureHalt"),
      blockAllActive: async () => [],
    },
    dispatchService: { execute: notExercised("execute") },
    failureRouter: new FailureRouter(),
    clientStops: { runPending: async () => [] },
    clientChanges: { runPending: async () => [] },
    stackChoices: { runPending: async () => [] },
    liaisonIntake: { runPending: async () => [] },
    liaisonAnswers: steps.liaisonAnswers,
    rosterDerivation: { runPending: async () => [] },
    firstPlanning: { runPending: async () => [] },
    replanning: steps.replanning,
    planReports: { runPending: async () => [] },
    checkDisputes: { record: notExercised("checkDisputes") },
    suiteReviewFindings: { record: notExercised("suiteReviewFindings") },
    checkSetFreeze: { freezeFor: async () => [] },
    burnWarnings: { runPending: async () => [] },
    blockReports: new BlockReports(reports, memoryStepContainment(() => false)),
    infrastructureProbe: { probe: notExercised("infrastructureProbe") },
    heldCells: { release: async () => {} },
    environmentOwner: notExercised("environmentOwner"),
    taskLanes: concurrentTaskLanes,
    acceptanceSweeper: { sweepForAcceptance: notExercised("sweepForAcceptance") },
    acceptance: { readyForAcceptance: async () => [], recordAccepted: notExercised("recordAccepted"), recordSweepFault: notExercised("recordSweepFault"), recordDefect: notExercised("recordDefect") },
    deliveredReports: { runPending: async () => [] },
    spendCap,
  };
  return new CoreLoop(deps);
}

/** A work ledger holding HEADROOM requests more than the project has drawn so far. */
async function tightLedger(projectId: ProjectId): Promise<{ readonly spendCap: SpendCap; readonly budget: number }> {
  const budget = (await requestsOf(projectId)) + HEADROOM;
  const budgets: WorkBudgets = { perTaskRequests: 60, perProjectRequests: budget, verificationReservePercent: 0 };
  return { spendCap: new SpendCap({ ledger: new LlmCallRepository(db), caps: AMPLE_CAPS, workBudgets: budgets }), budget };
}

async function requestsOf(projectId: ProjectId): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM llm_calls WHERE project_id = ${projectId}`);
  return z.object({ n: z.number() }).parse(result.rows[0]).n;
}

const ProjectRow = z.object({ status: z.string(), category: z.string().nullable(), errorClass: z.string().nullable() });

async function projectOf(projectId: ProjectId): Promise<z.infer<typeof ProjectRow>> {
  const result = await db.execute(sql`
    SELECT ${projectState} AS status, blocked_category AS category, blocked_error_class AS "errorClass" FROM projects WHERE id = ${projectId}`);
  return ProjectRow.parse(result.rows[0]);
}

/** Runs cycles until the project is no longer active, at most MAX_CYCLES; returns the cycles run. */
async function cyclesUntilHalted(loop: CoreLoop, projectId: ProjectId): Promise<number> {
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    await loop.runCycle();
    if ((await projectOf(projectId)).status !== "active") return cycle;
  }
  return Infinity;
}

/** The project halted as work_budget at exactly its budget, its report posted, and nothing drawn after the halt. */
async function expectWorkBudgetHalt(loop: CoreLoop, projectId: ProjectId, budget: number): Promise<void> {
  expect(await projectOf(projectId)).toEqual({ status: "blocked", category: "work_budget", errorClass: WORK_BUDGET_ERROR_CLASS });
  expect(await requestsOf(projectId)).toBe(budget);
  await loop.runCycle();
  await loop.runCycle();
  expect(await requestsOf(projectId)).toBe(budget);
  const reports = await db.execute(sql`SELECT body FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound' AND kind = 'report'`);
  const bodies = z.array(z.object({ body: z.string() })).parse(reports.rows).map((row) => row.body);
  expect(bodies.filter((body) => body.includes("the budget of model requests set for this project was used up"))).toHaveLength(1);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  setupGateway = gateway(new SpendCap({ ledger: new LlmCallRepository(db), caps: AMPLE_CAPS }));
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  ourProjects.clear();
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const projects = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM replan_requests WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM plan_revisions WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM project_blocks WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id IN (${projects})`);
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

// L17: Replanner.revise returns "moved" when its write finds the project changed; the next cycle decomposes again.
describe("a plan revision whose write finds the project moved every cycle", () => {
  test("halts the project as work_budget with its report once the revisions drew the project's budget", async () => {
    const { projectId, questionId } = await plannedProject();
    await answer(projectId, questionId);
    pipelineModel({ verdict: "changes", statement: "The hill studio opens first.", kind: "client-visible" });
    const answerStore = createAnswerStore(db);
    const narrowedAnswers: AnswerStore = { ...answerStore, openAnswers: ours(() => answerStore.openAnswers()) };
    const read = await new ClientAnswers({ containment: memoryStepContainment(() => true), llm: setupGateway, store: narrowedAnswers }).runPending();
    expect(read.map((o) => o.kind === "stated" && o.replanRequested)).toEqual([true]);

    const { spendCap, budget } = await tightLedger(projectId);
    const containment = memoryStepContainment((error) => spendCap.refusalOf(error) !== null);
    const replanStore = createReplanStore(db);
    let moved = 0;
    const alwaysMoved: ReplanStore = {
      ...replanStore,
      projectsAwaitingReplan: ours(() => replanStore.projectsAwaitingReplan()),
      writeRevision: async () => {
        moved += 1;
        return "moved";
      },
    };
    const loop = loopWith(spendCap, {
      containment,
      replanning: new Replanner({ containment, llm: gateway(spendCap), store: alwaysMoved }),
      liaisonAnswers: { runPending: async () => [] },
    });

    expect(await cyclesUntilHalted(loop, projectId)).toBeLessThanOrEqual(HEADROOM + 1);
    expect(moved).toBeGreaterThanOrEqual(1);
    await expectWorkBudgetHalt(loop, projectId, budget);
  }, 120_000);
});

// L19: ClientAnswers.read returns "moved" past MAX_ANSWER_WRITES; the answer stays open and is read again next cycle.
describe("an answer whose record finds the project moved every cycle", () => {
  test("halts the project as work_budget with its report once the re-reads drew the project's budget", async () => {
    const { projectId, questionId } = await plannedProject();
    const answerId = await answer(projectId, questionId);
    pipelineModel({ verdict: "confirms" });

    const { spendCap, budget } = await tightLedger(projectId);
    const containment = memoryStepContainment((error) => spendCap.refusalOf(error) !== null);
    const answerStore = createAnswerStore(db);
    let moved = 0;
    const alwaysMoved: AnswerStore = {
      ...answerStore,
      openAnswers: ours(() => answerStore.openAnswers()),
      recordAnswer: async () => {
        moved += 1;
        return { kind: "moved", detail: "the project's vision moved under the write" };
      },
    };
    const answers: LiaisonAnswers = new ClientAnswers({ containment, llm: gateway(spendCap), store: alwaysMoved });
    const loop = loopWith(spendCap, { containment, replanning: { runPending: async () => [] }, liaisonAnswers: answers });

    expect(await cyclesUntilHalted(loop, projectId)).toBeLessThanOrEqual(HEADROOM + 1);
    expect(moved).toBeGreaterThanOrEqual(2);
    await expectWorkBudgetHalt(loop, projectId, budget);
    // The answer is never consumed: only the ledger ended its re-reads.
    const open = await db.execute(sql`SELECT consumed_at IS NULL AS open FROM client_messages WHERE id = ${answerId}`);
    expect(open.rows).toEqual([{ open: true }]);
  }, 120_000);
});
