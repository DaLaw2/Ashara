import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { LlmCallRepository } from "@ashara/finance";
import { ProjectHaltRepository } from "@ashara/delivery";
import { ClientChanges, ClientMessageRepository, StackChoiceReports, VisionRepository, createProjectWithTender, listUnconsumedChanges } from "@ashara/engagement";
import type { ClientChangeStore, StackChoiceStore } from "@ashara/engagement";
import { DEFAULT_WORK_BUDGETS, GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { createWorkItemId, memoryStepContainment, recordingLogger } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { createClientChangeStore } from "@ashara/server/client-change-store";
import { createStackChoiceStore } from "@ashara/server/stack-choice-store";

// A client's change is read only while its reading can succeed: never under a halt on a model's or
// its provider's failure (nor a budget halt), so no attempt is charged there. Whatever ends a halt (the
// operator's unblock, a passing probe) sets the count of a change whose readings ran out back to none,
// so the resumption reads it afresh instead of halting the project again at once. Every write made on the client's behalf (a change's
// correction, the stack-choice report) checks the project's lifecycle and halt again under the
// project row's lock and writes nothing when either moved since the listing. Every row belongs to a
// project this suite creates under a unique name, and each step is narrowed to those projects. No
// real LLM call is made: the provider factory returns a MockLanguageModelV4.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `client-input-halts-test-${randomUUID().slice(0, 8)}`;
const TENDER = "Build a command that prints a greeting.";
const LEAVE_OUT_COLOUR = { ops: [{ op: "add-exclusion", text: "Coloured output.", direction: "neutral" }], confirms: [] };
const STATEMENT = "The command is a POSIX shell script tested with bats.";

let db: ReturnType<typeof createDb>;
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

/** The reading model: `reading` as its structured answer; one that never validates when `reading` is not a correction. */
function readingModel(reading: unknown): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ correction: reading }) }],
      usage: {
        inputTokens: { total: 500, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 200, text: 200, reasoning: undefined },
      },
      finishReason: { unified: "stop" as const, raw: "stop" },
      warnings: [],
    }),
  });
  stub.model = mock;
  return mock;
}

function ourChangeStore(): ClientChangeStore {
  const store = createClientChangeStore(db, DEFAULT_WORK_BUDGETS);
  return { ...store, openChanges: async () => (await store.openChanges()).filter((c) => ourProjects.has(c.projectId)) };
}

function changes(store: ClientChangeStore = ourChangeStore(), llm: GuardedModelAccess = gateway): ClientChanges {
  return new ClientChanges({ llm, store, containment: memoryStepContainment(() => true) });
}

/** A project at work with vision v1 in the guarantees form, its tender consumed. */
async function contractedProject(): Promise<ProjectId> {
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
  if (tender !== undefined) await new ClientMessageRepository(db).markConsumed(tender.id);
  return project.id;
}

async function sendChange(projectId: ProjectId): Promise<string> {
  return (await new ClientMessageRepository(db).insertInbound({ projectId, kind: "change", body: "Never colour the output.", inReplyTo: null })).id;
}

const MessageRowSchema = z.object({ attempts: z.number(), consumed: z.boolean() });

async function messageState(messageId: string): Promise<z.infer<typeof MessageRowSchema>> {
  const result = await db.execute(sql`SELECT intake_attempts AS attempts, consumed_at IS NOT NULL AS consumed FROM client_messages WHERE id = ${messageId}`);
  return z.array(MessageRowSchema).length(1).parse(result.rows)[0] ?? { attempts: -1, consumed: false };
}

async function repliesTo(messageId: string): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM client_messages WHERE in_reply_to = ${messageId} AND direction = 'outbound'`);
  return z.array(z.object({ n: z.number() })).parse(result.rows)[0]?.n ?? -1;
}

async function versionsOf(projectId: ProjectId): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM vision_documents WHERE project_id = ${projectId}`);
  return z.array(z.object({ n: z.number() })).parse(result.rows)[0]?.n ?? -1;
}

async function openHalts(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`SELECT kind FROM project_blocks WHERE project_id = ${projectId} AND ended_at IS NULL`);
  return z.array(z.object({ kind: z.string() })).parse(result.rows).map((row) => row.kind);
}

/** The halts under which the client's changes are still read: none of them is on the project's model work. */
type ReadAllowedHalt = "plan_repair" | "check_dispute" | "suite_review" | "fault" | "infrastructure";

function halt(projectId: ProjectId, category: "model_failed" | "provider_failed" | "replan_stopped" | "replan_provider_failed" | ReadAllowedHalt) {
  return new ProjectHaltRepository(db).block(projectId, { category, errorClass: "ScriptedHalt", reason: `halted on ${category} by the test` });
}

/** Model access through the stub provider, each project's spend capped at `perProjectUsd`. */
function modelAccess(perProjectUsd: number): GuardedModelAccess {
  return new GuardedModelAccess(
    buildGateway({
      models: sdkLanguageModels,
      config: {
        providers: [
          {
            name: "deepseek",
            providerType: "deepseek",
            apiKey: "test-key",
            baseUrl: "https://stub.invalid/v1",
            models: [model("halts-strong", "Strong"), model("halts-frontier", "Frontier")],
            enabled: true,
          },
        ],
        defaultProvider: "deepseek",
        contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
      },
      checkedSources: ["test"],
      clock: () => new Date(),
    }),
    new LlmCallLedger(new LlmCallRepository(db), new SpendCap({ ledger: new LlmCallRepository(db), caps: { deploymentUsd: 1_000_000, perProjectUsd } })),
    recordingLogger(),
  );
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  gateway = modelAccess(1_000_000);
});

beforeEach(() => {
  ourProjects.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  readingModel(LEAVE_OUT_COLOUR);
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM correction_holds WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_revisions WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM project_blocks WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a change is read only while its reading can succeed", () => {
  test.each(["model_failed", "provider_failed", "replan_stopped", "replan_provider_failed"] as const)(
    "under a %s halt it is not read and not charged through many cycles, and after the operator's unblock it is read once and the project not halted again",
    async (category) => {
      const projectId = await contractedProject();
      expect(await halt(projectId, category)).toBe("blocked");
      const changeId = await sendChange(projectId);
      // A reading that never validates: any reading under the halt would be charged an attempt.
      const failing = readingModel({ unreadable: true });

      for (let cycle = 0; cycle < 5; cycle++) expect(await changes().runPending()).toEqual([]);

      expect(failing.doGenerateCalls).toHaveLength(0);
      expect(await messageState(changeId)).toEqual({ attempts: 0, consumed: false });
      expect(await openHalts(projectId)).toEqual([category]);

      await new ProjectHaltRepository(db).unblock(projectId, "operator-a", "the model answers again");
      readingModel(LEAVE_OUT_COLOUR);
      expect((await changes().runPending()).map((outcome) => outcome.kind)).toEqual(["recorded"]);
      expect(await messageState(changeId)).toEqual({ attempts: 0, consumed: true });
      expect(await openHalts(projectId)).toEqual([]);
    },
  );

  test("a reading exhausted on a project at work halts it, keeping its count while the halt lasts, and the unblock sets it back to none and reads it afresh", async () => {
    const projectId = await contractedProject();
    const changeId = await sendChange(projectId);
    const failing = readingModel({ unreadable: true });
    const kinds: string[] = [];
    for (let cycle = 0; cycle < 3; cycle++) for (const outcome of await changes().runPending()) kinds.push(outcome.kind);
    expect(kinds).toEqual(["failed", "failed", "project-blocked"]);
    expect(await openHalts(projectId)).toEqual(["model_failed"]);
    expect(await messageState(changeId)).toEqual({ attempts: 3, consumed: false });

    const calls = failing.doGenerateCalls.length;
    for (let cycle = 0; cycle < 3; cycle++) expect(await changes().runPending()).toEqual([]);
    expect(failing.doGenerateCalls).toHaveLength(calls);

    await new ProjectHaltRepository(db).unblock(projectId, "operator-a", "the model answers again");
    expect(await messageState(changeId)).toEqual({ attempts: 0, consumed: false });
    readingModel(LEAVE_OUT_COLOUR);
    expect((await changes().runPending()).map((outcome) => outcome.kind)).toEqual(["recorded"]);
    expect(await openHalts(projectId)).toEqual([]);
  });

  /** Ends the project's open halt the way its kind is ended: the substrate probe for infrastructure, the operator's unblock for any other. */
  async function endHalt(projectId: ProjectId, category: ReadAllowedHalt): Promise<void> {
    const projects = new ProjectHaltRepository(db);
    if (category !== "infrastructure") {
      await projects.unblock(projectId, "operator-a", "repaired the cause");
      return;
    }
    // The probe ends only a halt whose report the client has been told.
    const report = await new ClientMessageRepository(db).insertOutbound({ projectId, kind: "report", body: "Work on this project is paused.", inReplyTo: null });
    await db.execute(sql`INSERT INTO told_reports (subject_kind, subject_id, project_id, report_id)
      SELECT 'project-blocked', b.id, b.project_id, ${report.id} FROM project_blocks b WHERE b.project_id = ${projectId} AND b.ended_at IS NULL`);
    expect(await projects.resumeFromInfrastructureHalt(projectId, "the substrate answered")).toBe("resumed");
  }

  test.each(["plan_repair", "check_dispute", "suite_review", "fault", "infrastructure"] as const)(
    "a reading exhausted under a %s halt keeps its count while that halt lasts, unread; the halt's end sets it back to none, and the next cycle reads it with the model before any halt of its own",
    async (category) => {
      const projectId = await contractedProject();
      expect(await halt(projectId, category)).toBe("blocked");
      const changeId = await sendChange(projectId);
      const failing = readingModel({ unreadable: true });
      const kinds: string[] = [];
      for (let cycle = 0; cycle < 3; cycle++) for (const outcome of await changes().runPending()) kinds.push(outcome.kind);
      expect(kinds).toEqual(["failed", "failed", "project-blocked"]);
      expect(await openHalts(projectId)).toEqual([category]);
      expect(await messageState(changeId)).toEqual({ attempts: 3, consumed: false });

      // Not listed while that halt stays open: no paid reading and no block found already open, cycle after cycle.
      const calls = failing.doGenerateCalls.length;
      for (let cycle = 0; cycle < 3; cycle++) expect(await changes().runPending()).toEqual([]);
      expect(failing.doGenerateCalls).toHaveLength(calls);

      await endHalt(projectId, category);
      expect(await messageState(changeId)).toEqual({ attempts: 0, consumed: false });
      const outcomes = await changes().runPending();
      expect(outcomes.map((outcome) => [outcome.kind, "attempt" in outcome ? outcome.attempt : null])).toEqual([["failed", 1]]);
      expect(failing.doGenerateCalls.length).toBeGreaterThan(calls);
      expect(await openHalts(projectId)).toEqual([]);
    },
  );

  /** A call of `projectId` in flight at `usd`, which counts against its spend cap as a recorded one does. */
  async function spent(projectId: ProjectId, usd: number): Promise<void> {
    await db.execute(sql`INSERT INTO llm_calls (project_id, call_site, provider, model, estimated_cost_usd, state)
      VALUES (${projectId}, 'liaison-intake', 'deepseek', 'halts-strong', ${usd}, 'pending')`);
  }

  test("a paused project at its own spend cap waits for it uncharged, and a later paused project's change is read in the same cycle", async () => {
    const capped = modelAccess(5);
    const atCap = await contractedProject();
    const other = await contractedProject();
    expect(await halt(atCap, "plan_repair")).toBe("blocked");
    expect(await halt(other, "check_dispute")).toBe("blocked");
    await spent(atCap, 5);
    const waiting = await sendChange(atCap);
    const read = await sendChange(other);

    for (let cycle = 0; cycle < 3; cycle++) {
      const outcomes = await changes(ourChangeStore(), capped).runPending();
      expect(outcomes.map((outcome) => [outcome.kind, "changeId" in outcome ? outcome.changeId : null])).toEqual(
        cycle === 0 ? [["waits-for-limit", waiting], ["recorded", read]] : [["waits-for-limit", waiting]],
      );
    }
    expect(await messageState(waiting)).toEqual({ attempts: 0, consumed: false });
    expect(await messageState(read)).toEqual({ attempts: 0, consumed: true });
    expect(await openHalts(atCap)).toEqual(["plan_repair"]);
  });

  test("a project at work at its own spend cap still throws the refusal to the core loop, which halts it", async () => {
    const projectId = await contractedProject();
    await spent(projectId, 5);
    const changeId = await sendChange(projectId);
    await expect(changes(ourChangeStore(), modelAccess(5)).runPending()).rejects.toThrow(/budget_cap: the spend cap of project/);
    expect(await messageState(changeId)).toEqual({ attempts: 0, consumed: false });
  });

  test("a change sent before the project's tender is read waits for its vision, unread and uncharged, and blames nothing", async () => {
    const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, TENDER);
    ourProjects.add(project.id);
    const changeId = await sendChange(project.id);
    for (let cycle = 0; cycle < 3; cycle++) expect(await changes().runPending()).toEqual([]);
    expect(await openHalts(project.id)).toEqual([]);
    expect(await messageState(changeId)).toEqual({ attempts: 0, consumed: false });
  });

  test("a change no record can take, under a halt already open, writes no block each cycle, and halts the project under its own cause once the halt ends", async () => {
    const projectId = await contractedProject();
    // A proposal whose operations do not read: no change of the project can be read against its record.
    await db.execute(sql`INSERT INTO vision_revisions (project_id, based_on_version, author, direction, cause, ops, status)
      VALUES (${projectId}, 1, 'ashara', 'neutral', 'ashara-decision', '[{"nonsense": true}]'::jsonb, 'proposed')`);
    expect(await halt(projectId, "plan_repair")).toBe("blocked");
    const changeId = await sendChange(projectId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();

    for (let cycle = 0; cycle < 3; cycle++) expect((await changes().runPending()).map((outcome) => outcome.kind)).toEqual(["waits-for-halt"]);
    expect(warn).not.toHaveBeenCalled();
    expect(await openHalts(projectId)).toEqual(["plan_repair"]);

    await new ProjectHaltRepository(db).unblock(projectId, "operator-a", "repaired the plan");
    expect((await changes().runPending()).map((outcome) => outcome.kind)).toEqual(["project-blocked"]);
    const blocks = await db.execute(sql`SELECT kind, error_class AS "errorClass" FROM project_blocks WHERE project_id = ${projectId} AND ended_at IS NULL`);
    expect(blocks.rows).toEqual([{ kind: "fault", errorClass: "ChangeVisionUnusable" }]);
    expect(await messageState(changeId)).toEqual({ attempts: 0, consumed: false });
  });

  // The block reports of these halts tell the client a change sent meanwhile is read during the pause
  // (inboundDecision's read-during-pause): each is a halt under which the change reader lists it.
  test.each(["plan_repair", "check_dispute", "suite_review"] as const)("a change sent during a %s halt, whose report says it is read during the pause, is listed for reading", async (category) => {
    const projectId = await contractedProject();
    expect(await halt(projectId, category)).toBe("blocked");
    const changeId = await sendChange(projectId);
    const listed = (await listUnconsumedChanges(db)).filter((change) => change.projectId === projectId);
    expect(listed.map((change) => [change.id, change.paused])).toEqual([[changeId, true]]);
  });
});

describe("a write on the client's behalf checks the lifecycle and the halt again under the project row's lock", () => {
  /** A change store whose correction write first lets `meanwhile` move the project, as a concurrent writer would between the listing and the write. */
  function racingStore(meanwhile: () => Promise<unknown>): ClientChangeStore {
    const store = ourChangeStore();
    let raced = false;
    return {
      ...store,
      recordCorrection: async (write) => {
        if (!raced) {
          raced = true;
          await meanwhile();
        }
        return store.recordCorrection(write);
      },
    };
  }

  test("a change composed while at work, the project halted before its write: nothing is applied or posted, and it is read again under the halt", async () => {
    const projectId = await contractedProject();
    const changeId = await sendChange(projectId);
    const outcomes = await changes(racingStore(() => halt(projectId, "plan_repair"))).runPending();

    expect(outcomes).toEqual([{ kind: "moved", changeId, projectId, detail: expect.stringContaining("composed while the project was at work, but it is now halted") }]);
    expect(await messageState(changeId)).toEqual({ attempts: 0, consumed: false });
    expect(await repliesTo(changeId)).toBe(0);
    expect(await versionsOf(projectId)).toBe(1);

    // Read again as the halted project's: its note says the pause holds the work.
    expect((await changes().runPending()).map((outcome) => outcome.kind)).toEqual(["recorded"]);
    const note = await db.execute(sql`SELECT body FROM client_messages WHERE in_reply_to = ${changeId} AND direction = 'outbound'`);
    expect(z.array(z.object({ body: z.string() })).parse(note.rows)).toEqual([{ body: expect.stringContaining("this message does not end the pause") }]);
  });

  test.each(["model_failed", "stopped"] as const)("a change composed while at work, the project %s before its write: nothing is applied or posted, and it is not read again", async (move) => {
    const projectId = await contractedProject();
    const changeId = await sendChange(projectId);
    const meanwhile = move === "stopped" ? () => db.execute(sql`UPDATE projects SET lifecycle = 'stopped' WHERE id = ${projectId}`) : () => halt(projectId, move);
    const outcomes = await changes(racingStore(meanwhile)).runPending();

    expect(outcomes).toEqual([{ kind: "moved", changeId, projectId, detail: expect.stringContaining("no longer reads the client's input") }]);
    expect(await messageState(changeId)).toEqual({ attempts: 0, consumed: false });
    expect(await repliesTo(changeId)).toBe(0);
    expect(await versionsOf(projectId)).toBe(1);
    expect(await changes().runPending()).toEqual([]);
  });

  test("a change composed while halted, the project resumed before its write: the note saying the pause holds the work is not posted", async () => {
    const projectId = await contractedProject();
    expect(await halt(projectId, "plan_repair")).toBe("blocked");
    const changeId = await sendChange(projectId);
    const outcomes = await changes(racingStore(() => new ProjectHaltRepository(db).unblock(projectId, "operator-a", "resumed"))).runPending();

    expect(outcomes).toEqual([{ kind: "moved", changeId, projectId, detail: expect.stringContaining("composed while the project was halted, but it is now at work") }]);
    expect(await repliesTo(changeId)).toBe(0);
    expect(await versionsOf(projectId)).toBe(1);
  });

  /** A project at work whose Sprint 0 environment task merged with a statement: its stack choice is due. */
  async function projectWithStackChoice(): Promise<ProjectId> {
    const projectId = await contractedProject();
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, environment_statement, merge_commit)
      VALUES (${createWorkItemId()}, 'Task', 'Completed', 'Define the environment', ${projectId}, 'environment', ${randomUUID()}, ${STATEMENT}, ${"c".repeat(40)})`);
    return projectId;
  }

  function stackChoices(meanwhile: (projectId: ProjectId) => Promise<unknown>): StackChoiceReports {
    const store = createStackChoiceStore(db);
    const racing: StackChoiceStore = {
      ...store,
      dueStackChoices: async () => (await store.dueStackChoices()).filter((due) => ourProjects.has(due.projectId)),
      recordStackChoice: async (write) => {
        await meanwhile(write.projectId);
        return store.recordStackChoice(write);
      },
    };
    return new StackChoiceReports(racing, memoryStepContainment(() => true));
  }

  async function stackReports(projectId: ProjectId): Promise<number> {
    const result = await db.execute(sql`SELECT count(*)::int AS n FROM client_messages WHERE project_id = ${projectId} AND reports_on = 'stack-choice'`);
    return z.array(z.object({ n: z.number() })).parse(result.rows)[0]?.n ?? -1;
  }

  test.each(["halted", "stopped"] as const)("a stack choice listed while at work, the project %s before its write: no report saying work proceeds is posted and no version appended", async (move) => {
    const projectId = await projectWithStackChoice();
    const meanwhile = move === "stopped" ? () => db.execute(sql`UPDATE projects SET lifecycle = 'stopped' WHERE id = ${projectId}`) : () => halt(projectId, "plan_repair");
    const outcomes = await stackChoices(meanwhile).runPending();

    expect(outcomes).toEqual([{ kind: "not-due", projectId }]);
    expect(await stackReports(projectId)).toBe(0);
    expect(await versionsOf(projectId)).toBe(1);
  });

  test("a stack choice of a project still at work is posted once with its version", async () => {
    const projectId = await projectWithStackChoice();
    expect(await stackChoices(async () => undefined).runPending()).toEqual([{ kind: "recorded", projectId, visionVersion: 2 }]);
    expect(await stackReports(projectId)).toBe(1);
    expect(await versionsOf(projectId)).toBe(2);
  });
});
