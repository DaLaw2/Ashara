import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl, type Database, type DbHandle } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import { HALT_KINDS, type HaltKind } from "@ashara/delivery/predicates";
import {
  CLOSED_LIFECYCLES,
  ClientMessageRepository,
  ClientReceipts,
  TenderIntake,
  VisionRepository,
  consumeTenderWithoutIntake,
  createProjectWithTender,
  TerminalReports,
  TERMINAL_KINDS,
  inboundDecision,
  listDueReceipts,
  listDueTerminals,
  terminalTableOf,
  listOpenAnswers,
  listUnconsumedChanges,
  listUnconsumedStops,
} from "@ashara/engagement";
import type { InboundKind, InboundState, TerminalMessage } from "@ashara/engagement";
import { readSweepOutcome } from "@ashara/quality";
import { createIntakeStore } from "@ashara/server/intake-store";
import { parseProjectId, systemClock, type ProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import { UNREAD_HALT_KINDS } from "../simulator/invariants.js";

// Every cell of Engagement's inbound-message decision (project state by message kind) against what the
// database does in that state: each reader lists a message exactly when the decision reads it now (one
// at its cap of failed readings exactly when the decision reads it at its cap), the receipt's listing
// and the halt report's listing state the state the decision was taken in, the receipt and the halt
// report word each message's fate as the decision tells it, a halt's opening resets no count and its end
// resets exactly the counts the decision resets, a tender's intake writes nothing once its project no
// longer reads it, and the simulator's own oracle of the halts that hold the reading agrees cell by
// cell. Each state is set up and rolled back inside one transaction, on a project whose tender's
// reading wrote its first vision and on one whose tender is not yet read. Every row belongs to a
// project this suite creates under a unique name.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `inbound-message-policy-test-${randomUUID().slice(0, 8)}`;
const AT_CAP = 3;

let db: Database;

/**
 * The project with a vision every message but the stop is sent to, the one with none yet (its tender
 * unread) the bare change is sent to, and the one the stop is sent to, since an open stop holds every
 * other reader.
 */
interface Fixture {
  readonly projectId: ProjectId;
  readonly bareProjectId: ProjectId;
  readonly stopProjectId: ProjectId;
  readonly tender: string;
  readonly answer: string;
  readonly answerAtCap: string;
  readonly change: string;
  readonly changeAtCap: string;
  readonly bareChange: string;
  readonly bareChangeAtCap: string;
  readonly stop: string;
}

type Message = Exclude<keyof Fixture, "projectId" | "bareProjectId" | "stopProjectId">;

/** A project state as the test sets it: the vision is the fixture project's own. */
type SetState = { readonly lifecycle: "active"; readonly halt: HaltKind | null } | { readonly lifecycle: (typeof CLOSED_LIFECYCLES)[number] };

/** The decision's state for a project in `state` whose first vision is written or not. */
function withVision(state: SetState, visionWritten: boolean): InboundState {
  return state.lifecycle === "active" ? { ...state, visionWritten } : state;
}

let fixture: Fixture;
/** The tender of the project whose first vision is not written: kept apart from the readers' cells, which list no tender of it. */
let bareTender: string;

class RolledBack<T> extends Error {
  constructor(readonly result: T) {
    super("rolled back: the state was set only to read under it");
    this.name = "RolledBack";
  }
}

/** The transaction committed a state that was set only to be rolled back. */
class StateCommitted extends Error {
  constructor(readonly state: SetState) {
    super(`the transaction setting ${JSON.stringify(state)} committed`);
    this.name = "StateCommitted";
  }
}

async function setState(tx: DbHandle, projectId: ProjectId, state: SetState): Promise<void> {
  if (state.lifecycle === "active") {
    if (state.halt === null) return;
    await tx.execute(sql`INSERT INTO project_blocks (project_id, kind, error_class, reason) VALUES (${projectId}, ${state.halt}, 'ScriptedHalt', 'opened by the test')`);
    return;
  }
  if (state.lifecycle === "accepted") {
    await tx.execute(sql`
      INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details)
      VALUES (${projectId}, ${"a".repeat(40)}, 'env-1', '[]'::jsonb, '[]'::jsonb, true, 'inbound-message-policy sweep')`);
  }
  await tx.execute(sql`UPDATE projects SET lifecycle = ${state.lifecycle} WHERE id = ${projectId}`);
}

/** `read` with every project in `state`, in a transaction rolled back after it. */
async function under<T>(state: SetState, read: (tx: DbHandle) => Promise<T>): Promise<T> {
  try {
    await db.transaction(async (tx) => {
      await setState(tx, fixture.projectId, state);
      await setState(tx, fixture.bareProjectId, state);
      await setState(tx, fixture.stopProjectId, state);
      throw new RolledBack(await read(tx));
    });
  } catch (err) {
    if (err instanceof RolledBack) return err.result as T;
    throw err;
  }
  throw new StateCommitted(state);
}

/** Which of the fixture's messages each reader lists in `state`. */
async function listedUnder(state: SetState): Promise<Record<Message, boolean>> {
  const ids = await under(state, async (tx) => [
    ...(await new ClientMessageRepository(tx).listUnconsumedTenders()).map((row) => row.id),
    ...(await listOpenAnswers(tx)).map((row) => row.id),
    ...(await listUnconsumedChanges(tx)).map((row) => row.id),
    ...(await listUnconsumedStops(tx)).map((row) => row.id),
  ]);
  return {
    tender: ids.includes(fixture.tender),
    answer: ids.includes(fixture.answer),
    answerAtCap: ids.includes(fixture.answerAtCap),
    change: ids.includes(fixture.change),
    changeAtCap: ids.includes(fixture.changeAtCap),
    bareChange: ids.includes(fixture.bareChange),
    bareChangeAtCap: ids.includes(fixture.bareChangeAtCap),
    stop: ids.includes(fixture.stop),
  };
}

/** What the decision lists in `state`: every message read now, one at its cap read at its cap. */
function decidedUnder(state: SetState): Record<Message, boolean> {
  const now = (kind: InboundKind, which: "reading" | "atCap", visionWritten = true): boolean => inboundDecision(withVision(state, visionWritten), kind)[which] === "now";
  return {
    tender: now("tender", "reading"),
    answer: now("answer", "reading"),
    answerAtCap: now("answer", "atCap"),
    change: now("change", "reading"),
    changeAtCap: now("change", "atCap"),
    bareChange: now("change", "reading", false),
    bareChangeAtCap: now("change", "atCap", false),
    stop: now("stop", "reading"),
  };
}

const StandingSchema = z.object({ kind: z.string(), halt: z.string().optional(), visionWritten: z.boolean().optional() });

/** The state the receipt's listing states for the fixture's change, and for the bare change, in `state`. */
async function receiptStandingUnder(state: SetState): Promise<{ readonly change: z.infer<typeof StandingSchema>; readonly bareChange: z.infer<typeof StandingSchema> }> {
  const due = await under(state, (tx) => listDueReceipts(tx));
  const standingOf = (messageId: string): z.infer<typeof StandingSchema> => {
    const listed = due.find((each) => "messageId" in each && each.messageId === messageId);
    if (listed === undefined || !("standing" in listed)) throw new Error(`no receipt listed for ${messageId} in ${JSON.stringify(state)}: ${JSON.stringify(due)}`);
    return StandingSchema.parse(listed.standing);
  };
  return { change: standingOf(fixture.change), bareChange: standingOf(fixture.bareChange) };
}

/** Whether the halt report listed for each project under a `halt` halt says its first vision is written. */
async function haltReportVisionUnder(halt: HaltKind): Promise<{ readonly project: boolean | undefined; readonly bare: boolean | undefined }> {
  // A halt's report is listed once its terminal sweep is on record: one that ran on no commit is recorded for each.
  const due = await under({ lifecycle: "active", halt }, async (tx) => {
    await tx.execute(sql`
      INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details, purpose, block_id)
      SELECT b.project_id, NULL, NULL, '[]'::jsonb, '[]'::jsonb, false, 'inbound-message-policy terminal sweep', 'terminal', b.id
        FROM project_blocks b WHERE b.ended_at IS NULL AND b.project_id IN (${fixture.projectId}, ${fixture.bareProjectId})`);
    return listDueTerminals(tx, { sweepOutcome: readSweepOutcome, blockingReview: async () => null }, TERMINAL_KINDS, systemClock);
  });
  const written = (projectId: ProjectId): boolean | undefined => {
    for (const each of due) {
      if ("kind" in each && each.kind === "listed" && each.event.kind === "halted" && each.event.projectId === projectId) return each.event.halt.visionWritten;
    }
    return undefined;
  };
  return { project: written(fixture.projectId), bare: written(fixture.bareProjectId) };
}

const AttemptsSchema = z.array(z.object({ id: z.string(), attempts: z.number() }));

/** Each fixture message's count of failed readings after the operator ends a `halt` halt. */
async function attemptsAfterUnblock(halt: HaltKind): Promise<Map<string, number>> {
  const rows = await under({ lifecycle: "active", halt }, async (tx) => {
    await new ProjectHaltRepository(tx).unblock(fixture.projectId, "operator-test", "ended by the test");
    await new ProjectHaltRepository(tx).unblock(fixture.bareProjectId, "operator-test", "ended by the test");
    const result = await tx.execute(
      sql`SELECT id, intake_attempts AS attempts FROM client_messages WHERE project_id IN (${fixture.projectId}, ${fixture.bareProjectId}) AND direction = 'inbound'`,
    );
    return AttemptsSchema.parse(result.rows);
  });
  return new Map(rows.map((row) => [row.id, row.attempts]));
}

async function inbound(projectId: ProjectId, kind: InboundKind, inReplyTo: string | null): Promise<string> {
  return (await new ClientMessageRepository(db).insertInbound({ projectId, kind, body: `the client's ${kind}`, inReplyTo })).id;
}

async function charge(messageId: string, attempts: number, failure: "model" | null): Promise<void> {
  await db.execute(sql`UPDATE client_messages SET intake_attempts = ${attempts}, intake_last_error = 'scripted failure', intake_last_failure = ${failure} WHERE id = ${messageId}`);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  const clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  const { project, message: tender } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-messages`, "Build a command that prints a greeting.");
  await new VisionRepository(db).create(project.id, {
    visionText: "Build a command that prints a greeting.",
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
  const [question, questionAtCap] = await new ClientMessageRepository(db).insertQuestions(project.id, tender.id, ["Which shell?", "Which colour?"]);
  if (question === undefined || questionAtCap === undefined) throw new Error("the questions were not posted");
  const answer = await inbound(project.id, "answer", question.id);
  const answerAtCap = await inbound(project.id, "answer", questionAtCap.id);
  const change = await inbound(project.id, "change", null);
  const changeAtCap = await inbound(project.id, "change", null);
  await charge(tender.id, 1, null);
  await charge(answer, 1, "model");
  await charge(answerAtCap, AT_CAP, "model");
  await charge(change, 1, "model");
  await charge(changeAtCap, AT_CAP, "model");

  const { project: bareProject, message: bareProjectTender } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-bare`, "Build a command that prints a greeting.");
  bareTender = bareProjectTender.id;
  const bareChange = await inbound(bareProject.id, "change", null);
  const bareChangeAtCap = await inbound(bareProject.id, "change", null);
  await charge(bareChange, 1, "model");
  await charge(bareChangeAtCap, AT_CAP, "model");

  const { project: stopProject, message: stopTender } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-stop`, "Build a command that prints a greeting.");
  await consumeTenderWithoutIntake(db, { id: stopTender.id, projectId: stopProject.id });
  const stop = await inbound(stopProject.id, "stop", null);
  fixture = { projectId: project.id, bareProjectId: bareProject.id, stopProjectId: stopProject.id, tender: tender.id, answer, answerAtCap, change, changeAtCap, bareChange, bareChangeAtCap, stop };
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}-%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM project_blocks WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_revisions WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${pattern}`);
  await db.$client.end();
});

const HELD_BY_ORACLE: readonly string[] = UNREAD_HALT_KINDS;
const READING_HALTS = HALT_KINDS.filter((halt) => !HELD_BY_ORACLE.includes(halt));
const HELD_HALTS = HALT_KINDS.filter((halt) => HELD_BY_ORACLE.includes(halt));

describe("at work: every message is listed, one at its cap too, but a change before the first vision waits for the tender", () => {
  test("the readers list what the decision reads, and the receipt states the project at work", async () => {
    const state: SetState = { lifecycle: "active", halt: null };
    expect(decidedUnder(state)).toEqual({ tender: true, answer: true, answerAtCap: true, change: true, changeAtCap: true, bareChange: false, bareChangeAtCap: false, stop: true });
    expect(await listedUnder(state)).toEqual(decidedUnder(state));
    expect(await receiptStandingUnder(state)).toEqual({ change: { kind: "at-work", visionWritten: true }, bareChange: { kind: "at-work", visionWritten: false } });
  });
});

describe("under a halt that reads the client's input: answers and changes are listed, a tender, a message at its cap and a change before the first vision wait", () => {
  test.each(READING_HALTS)("%s", async (halt) => {
    const state: SetState = { lifecycle: "active", halt };
    expect(decidedUnder(state)).toEqual({ tender: false, answer: true, answerAtCap: false, change: true, changeAtCap: false, bareChange: false, bareChangeAtCap: false, stop: true });
    expect(await listedUnder(state)).toEqual(decidedUnder(state));
    expect(await receiptStandingUnder(state)).toEqual({ change: { kind: "paused", halt, visionWritten: true }, bareChange: { kind: "paused", halt, visionWritten: false } });
  });
});

describe("under a halt that holds the reading (the simulator oracle's set): only the stop is listed", () => {
  test.each(HELD_HALTS)("%s", async (halt) => {
    const state: SetState = { lifecycle: "active", halt };
    expect(decidedUnder(state)).toEqual({ tender: false, answer: false, answerAtCap: false, change: false, changeAtCap: false, bareChange: false, bareChangeAtCap: false, stop: true });
    expect(await listedUnder(state)).toEqual(decidedUnder(state));
    expect(await receiptStandingUnder(state)).toEqual({ change: { kind: "paused", halt, visionWritten: true }, bareChange: { kind: "paused", halt, visionWritten: false } });
  });
});

// A check_dispute, suite_review or plan_repair halt's report reads the dispute, review or abandoned
// work it was opened on, which this suite does not record, and a planning_stopped halt is first told
// by the planning-stopped report; every other halt's report is listed from the halt alone.
const REPORTED_FROM_HALT_ALONE = HALT_KINDS.filter((halt) => !["check_dispute", "suite_review", "plan_repair", "planning_stopped"].includes(halt));

describe("the halt report's listing states whether the project's first vision is written, which its change paragraph is decided by", () => {
  test.each(REPORTED_FROM_HALT_ALONE)("%s", async (halt) => {
    expect(await haltReportVisionUnder(halt)).toEqual({ project: true, bare: false });
  });
});

describe("a closed project: only the stop is listed", () => {
  test.each(CLOSED_LIFECYCLES)("%s", async (lifecycle) => {
    const state: SetState = { lifecycle };
    expect(decidedUnder(state)).toEqual({ tender: false, answer: false, answerAtCap: false, change: false, changeAtCap: false, bareChange: false, bareChangeAtCap: false, stop: true });
    expect(await listedUnder(state)).toEqual(decidedUnder(state));
    expect(await receiptStandingUnder(state)).toEqual({ change: { kind: lifecycle }, bareChange: { kind: lifecycle } });
  });
});

/** Each fixture message's count of failed readings as it was charged. */
function chargedAttempts(): Map<string, number> {
  return new Map([
    [fixture.tender, 1],
    [fixture.answer, 1],
    [fixture.answerAtCap, AT_CAP],
    [fixture.change, 1],
    [fixture.changeAtCap, AT_CAP],
    [fixture.bareChange, 1],
    [fixture.bareChangeAtCap, AT_CAP],
  ]);
}

/** The count the decision leaves each fixture message with once a `halt` halt ends. */
function decidedAfterHaltEnd(halt: HaltKind): Map<string, number> {
  const reset = (kind: InboundKind, visionWritten: boolean): boolean => inboundDecision({ lifecycle: "active", halt, visionWritten }, kind).resetOnHaltEnd;
  const cells: ReadonlyArray<readonly [string, InboundKind, boolean]> = [
    [fixture.tender, "tender", true],
    [fixture.answer, "answer", true],
    [fixture.answerAtCap, "answer", true],
    [fixture.change, "change", true],
    [fixture.changeAtCap, "change", true],
    [fixture.bareChange, "change", false],
    [fixture.bareChangeAtCap, "change", false],
  ];
  const charged = chargedAttempts();
  return new Map(cells.map(([id, kind, visionWritten]) => [id, reset(kind, visionWritten) ? 0 : (charged.get(id) ?? -1)]));
}

const ofFixture = (attempts: Map<string, number>): Map<string, number | undefined> => new Map([...chargedAttempts().keys()].map((id) => [id, attempts.get(id)]));

describe("the end of every halt resets the counts the decision resets: a tender's, an answer's and a change's", () => {
  test.each(HALT_KINDS)("%s", async (halt) => {
    const reset = (kind: InboundKind, visionWritten: boolean): boolean => inboundDecision({ lifecycle: "active", halt, visionWritten }, kind).resetOnHaltEnd;
    expect({ answer: reset("answer", true), change: reset("change", true), tender: reset("tender", true), bareChange: reset("change", false) }).toEqual({
      answer: true,
      change: true,
      tender: true,
      bareChange: true,
    });
    expect(ofFixture(await attemptsAfterUnblock(halt))).toEqual(decidedAfterHaltEnd(halt));
  });
});

type BlockCause = Parameters<ProjectHaltRepository["block"]>[1];

/** The cause Delivery's block records a `halt` halt with; a planning_stopped halt is opened by first planning alone, never by a block. */
function blockCauseOf(halt: HaltKind): BlockCause | null {
  const errorClass = "ScriptedHalt";
  const reason = "opened by the test";
  if (halt === "planning_stopped") return null;
  if (halt === "budget_cap") return { category: halt, errorClass, reason, spend: { capUsd: 1, spentUsd: 1, inFlightUsd: 0, nextCallUsd: null } };
  if (halt === "work_budget") {
    return {
      category: halt,
      errorClass,
      reason,
      work: { scope: "project", budgetRequests: 1, grantedRequests: 0, reserveRequests: 0, reserveProtected: false, spentRequests: 1, inFlightRequests: 0, bySite: [] },
    };
  }
  return { category: halt, errorClass, reason };
}

/** Each fixture message's count of failed readings once Delivery's block opens a `halt` halt on both projects. */
async function attemptsAfterBlock(cause: BlockCause): Promise<Map<string, number>> {
  const rows = await under({ lifecycle: "active", halt: null }, async (tx) => {
    expect(await new ProjectHaltRepository(tx).block(fixture.projectId, cause)).toBe("blocked");
    expect(await new ProjectHaltRepository(tx).block(fixture.bareProjectId, cause)).toBe("blocked");
    const result = await tx.execute(
      sql`SELECT id, intake_attempts AS attempts FROM client_messages WHERE project_id IN (${fixture.projectId}, ${fixture.bareProjectId}) AND direction = 'inbound'`,
    );
    return AttemptsSchema.parse(result.rows);
  });
  return new Map(rows.map((row) => [row.id, row.attempts]));
}

// The decision resets a count only at a halt's end (resetOnHaltEnd): opening a halt resets none.
describe("the opening of every halt resets no count: the decision resets one only at the halt's end", () => {
  test.each(HALT_KINDS.filter((halt) => blockCauseOf(halt) !== null))("%s", async (halt) => {
    const cause = blockCauseOf(halt);
    if (cause === null) throw new Error(`no block opens a ${halt} halt`);
    expect(ofFixture(await attemptsAfterBlock(cause))).toEqual(ofFixture(chargedAttempts()));
  });

  test("a tender whose readings ran out halts its project at its count, which only the halt's end sets back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-exhausted-client`)).id;
    const { project, message: tender } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-exhausted`, "Build a command that prints a greeting.");
    await charge(tender.id, AT_CAP, null);
    const llm = {
      forCall: () => ({
        generateStructured: async (): Promise<never> => {
          throw new UnexpectedRead();
        },
      }),
    };
    const store = createIntakeStore(db);
    const ours = { ...store, openTenders: async () => (await store.openTenders()).filter((open) => open.id === tender.id) };

    const outcomes = await new TenderIntake({ shutdownSignal: new AbortController().signal, containment: memoryStepContainment(() => false), llm, store: ours }).runPending();

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["project-blocked"]);
    const open = await openHaltOf(project.id);
    expect(open).not.toBeNull();
    const decided = (halt: HaltKind): number => (inboundDecision({ lifecycle: "active", halt, visionWritten: false }, "tender").resetOnHaltEnd ? 0 : AT_CAP);
    expect(await attemptsOf(tender.id)).toBe(AT_CAP);
    await new ProjectHaltRepository(db).unblock(project.id, "operator-test", "ended by the test");
    expect(await attemptsOf(tender.id)).toBe(decided(open ?? "fault"));
  });
});

class UnexpectedRead extends Error {
  constructor() {
    super("a tender at its cap was read; it must halt its project unread");
    this.name = "UnexpectedRead";
  }
}

async function attemptsOf(messageId: string): Promise<number | undefined> {
  const result = await db.execute(sql`SELECT id, intake_attempts AS attempts FROM client_messages WHERE id = ${messageId}`);
  return AttemptsSchema.parse(result.rows)[0]?.attempts;
}

const OpenHaltSchema = z.array(z.object({ kind: z.enum(HALT_KINDS) }));

async function openHaltOf(projectId: ProjectId): Promise<HaltKind | null> {
  const result = await db.execute(sql`SELECT kind FROM project_blocks WHERE project_id = ${projectId} AND ended_at IS NULL`);
  return OpenHaltSchema.parse(result.rows)[0]?.kind ?? null;
}

type Told = ReturnType<typeof inboundDecision>["told"];

/**
 * The receipt's words for each fate the decision tells, spelled here on their own: a receipt whose
 * fate paragraph carries the words of any fate but the one decided for its cell, or none, fails.
 */
const RECEIPT_WORDS: Readonly<Record<Exclude<Told, "stop">, (fate: string) => boolean>> = {
  "read-at-work": (fate) => fate.startsWith("Ashara reads it in this or the next round of work"),
  "waits-for-tender": (fate) => fate.startsWith("Ashara reads it once it has read the tender this project began with"),
  "read-during-pause": (fate) => fate.startsWith("Ashara reads it all the same"),
  "waits-for-pause": (fate) => fate === "Ashara reads it once the pause ends.",
  "waits-for-budget": (fate) => fate.includes("which the budget that paused this project does not allow"),
  "waits-for-model-work": (fate) => fate.includes("what paused this project is model work failing"),
  closed: (fate) => fate.startsWith("It is recorded, but not acted on"),
};

function toldIn(words: Readonly<Partial<Record<Told, (fate: string) => boolean>>>, fate: string): Told[] {
  return Object.entries(words).flatMap(([told, says]) => (says?.(fate) === true ? [told as Told] : []));
}

/** Each message's receipt body as the Liaison words it from the receipt listing in `state`. */
async function receiptsUnder(state: SetState): Promise<Map<string, string>> {
  const due = await under(state, (tx) => listDueReceipts(tx));
  const bodies = new Map<string, string>();
  const receipts = new ClientReceipts(
    {
      dueReceipts: async () => due,
      postReceipt: async (write) => {
        bodies.set(write.due.messageId, write.body);
        return "posted";
      },
    },
    memoryStepContainment(() => false),
  );
  await receipts.runPending({ kind: "running" });
  return bodies;
}

const RECEIPT_STATES: readonly SetState[] = [
  { lifecycle: "active", halt: null },
  ...HALT_KINDS.map((halt): SetState => ({ lifecycle: "active", halt })),
  ...CLOSED_LIFECYCLES.map((lifecycle): SetState => ({ lifecycle })),
];

describe("every receipt tells its message's fate as the decision tells it, in every state, for a tender, an answer and a change", () => {
  test.each(RECEIPT_STATES.map((state) => [JSON.stringify(state), state] as const))("%s", async (_name, state) => {
    const bodies = await receiptsUnder(state);
    const cells: ReadonlyArray<readonly [string, string, Exclude<InboundKind, "stop">, boolean]> = [
      ["tender", fixture.tender, "tender", true],
      ["bareTender", bareTender, "tender", false],
      ["answer", fixture.answer, "answer", true],
      ["change", fixture.change, "change", true],
      ["bareChange", fixture.bareChange, "change", false],
    ];
    const told = (id: string): Told[] => {
      const fate = (bodies.get(id) ?? "").split("\n\n")[2] ?? "";
      return toldIn(RECEIPT_WORDS, fate);
    };
    expect(Object.fromEntries(cells.map(([name, id]) => [name, told(id)]))).toEqual(
      Object.fromEntries(cells.map(([name, , kind, visionWritten]) => [name, [inboundDecision(withVision(state, visionWritten), kind).told]])),
    );
  });
});

/** The halt report's words for each fate the decision can tell a change under a halt, spelled here on their own. */
const HALT_REPORT_WORDS: Readonly<Partial<Record<Told, (paragraph: string) => boolean>>> = {
  "read-during-pause": (paragraph) => paragraph.includes("Ashara reads it and records it during the pause"),
  "waits-for-pause": (paragraph) => paragraph.includes("Ashara has not yet read the tender this project began with, and reads it once the pause ends"),
  "waits-for-budget": (paragraph) => paragraph.includes("which the budget that paused this project does not allow"),
  "waits-for-model-work": (paragraph) => paragraph.includes("what paused this project is model work failing"),
};

type DueHalt = Extract<Parameters<typeof TerminalMessage.of>[0], { readonly kind: "halted" }>["halt"];

/** A due report on a `halt` halt of a project whose first vision is written or not, with the detail its kind's report reads. */
function dueHalt(halt: HaltKind, visionWritten: boolean): DueHalt {
  const base = { episodeId: `e-${halt}`, projectId: parseProjectId(fixture.projectId, "fixture"), visionWritten } as const;
  switch (halt) {
    case "check_dispute":
      return { ...base, kind: halt, dispute: { taskTitle: "Port", checkName: "imports", reason: "the check cannot pass", disputes: 3 } };
    case "suite_review":
      return { ...base, kind: halt, review: { times: 3, problems: ["two checks contradict"] } };
    case "plan_repair":
      return { ...base, kind: halt, abandoned: [{ workItemId: "w1", title: "Port", attempts: 2, cause: { source: "api", reason: "moved by hand" } }] };
    default:
      return { ...base, kind: halt, cause: { errorClass: "ScriptedHalt", reason: "opened by the test", spend: null, work: null } };
  }
}

async function haltReportBody(due: DueHalt): Promise<string> {
  const bodies: string[] = [];
  const risk = { kind: "read", version: { guarantees: [], assumptions: [] }, standing: { tasks: [], decided: [], burnZone: null } } as const;
  const table = await terminalTableOf(db, { kind: "no-sweep", projectId: randomUUID() });
  await new TerminalReports(
    {
      dueTerminals: async () => [{ kind: "listed", event: { kind: "halted", projectId: due.projectId, halt: due, risk }, table }],
      postTerminal: async ({ body }) => {
        bodies.push(body);
        return "posted";
      },
      recordDeliveredFailure: async () => expect.unreachable("no delivered report is due"),
    },
    { file: "PUBLIC_INTERFACE.md", at: async () => ({ kind: "absent" }) },
    memoryStepContainment(() => false),
  ).runPending(TERMINAL_KINDS);
  return bodies[0] ?? "";
}

describe("every halt's report tells a change sent during it the fate the decision tells it", () => {
  test.each(HALT_KINDS.flatMap((halt) => [true, false].map((visionWritten) => [halt, visionWritten] as const)))("%s, the first vision written %s", async (halt, visionWritten) => {
    const body = await haltReportBody(dueHalt(halt, visionWritten));
    const paragraph = body.split("\n\n").find((each) => each.startsWith("A change you send meanwhile")) ?? "";
    expect(toldIn(HALT_REPORT_WORDS, paragraph)).toEqual([inboundDecision({ lifecycle: "active", halt, visionWritten }, "change").told]);
  });
});

// A tender is read while its project is at work; its intake commits only while the project still reads
// it under the project's row lock, as an answer's and a change's writes do.
describe("a tender's intake composed while its project was at work writes nothing once the project is halted or closed", () => {
  test.each(["halted", "stopped"] as const)("%s between the reading and the write", async (moved) => {
    const clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-race-${moved}-client`)).id;
    const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-race-${moved}`, "Build a command that prints a greeting.");
    const store = createIntakeStore(db);
    const tender = (await store.openTenders()).find((open) => open.projectId === project.id);
    if (tender === undefined) throw new Error(`no open tender for project ${project.id}`);

    if (moved === "halted") expect(await new ProjectHaltRepository(db).block(project.id, { category: "fault", errorClass: "ScriptedHalt", reason: "opened by the test" })).toBe("blocked");
    else await db.execute(sql`UPDATE projects SET lifecycle = 'stopped' WHERE id = ${project.id}`);

    const commit = await store.recordIntake({
      tender,
      questions: [],
      contractDraft: "This is the contract we are working to, drafted from your tender.",
      readingReport: null,
      reading: {
        first: { provider: "stub", model: "stub-model", grade: "Strong" },
        firstQuestions: 0,
        confirmation: {
          kind: "unconfirmed",
          passedOver: [
            { strength: "other-family", outcome: "unavailable", reason: "no second reading in the test" },
            { strength: "same-family-other-model", outcome: "unavailable", reason: "no second reading in the test" },
            { strength: "same-model", outcome: "unavailable", reason: "no second reading in the test" },
          ],
        },
      },
      vision: () => ({
        visionText: "Build a command that prints a greeting.",
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
        inferences: [],
        openQuestions: [],
      }),
    });

    expect(commit.kind).toBe("moved");
    expect((await new ClientMessageRepository(db).findById(tender.id))?.consumedAt).toBeNull();
    expect(await new VisionRepository(db).getCurrent(project.id)).toBeNull();
    expect((await new ClientMessageRepository(db).listByProject(project.id)).filter((message) => message.direction === "outbound")).toEqual([]);
  });
});

// A tender of a project that already has a vision is consumed with nothing else written, under the
// same row lock and decision as its intake.
describe("a tender listed while its project was at work is not consumed on the vision-exists path once the project is halted or closed", () => {
  test.each(["halted", "stopped"] as const)("%s between the listing and the consumption", async (moved) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-seeded-${moved}-client`)).id;
    const { project, message } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-seeded-${moved}`, "Build a command that prints a greeting.");
    await new VisionRepository(db).create(project.id, {
      visionText: "Build a command that prints a greeting.",
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
    const llm = {
      forCall: () => ({
        generateStructured: async (): Promise<never> => {
          throw new UnexpectedRead();
        },
      }),
    };
    const store = createIntakeStore(db);
    const ours = {
      ...store,
      openTenders: async () => (await store.openTenders()).filter((open) => open.id === message.id),
      currentVisionVersion: async (projectId: ProjectId) => {
        const version = await store.currentVisionVersion(projectId);
        if (moved === "halted") await new ProjectHaltRepository(db).block(project.id, { category: "fault", errorClass: "ScriptedHalt", reason: "opened by the test" });
        else await db.execute(sql`UPDATE projects SET lifecycle = 'stopped' WHERE id = ${project.id}`);
        return version;
      },
    };

    const outcomes = await new TenderIntake({ shutdownSignal: new AbortController().signal, containment: memoryStepContainment(() => false), llm, store: ours }).runPending();

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["moved"]);
    expect((await new ClientMessageRepository(db).findById(message.id))?.consumedAt).toBeNull();
  });
});

describe("the simulator's oracle of the halts that hold the reading agrees with the decision, cell by cell", () => {
  test.each(HALT_KINDS.flatMap((halt) => (["answer", "change"] as const).map((kind) => [halt, kind] as const)))("%s, a %s", (halt, kind) => {
    expect({ halt, kind, held: inboundDecision({ lifecycle: "active", halt, visionWritten: true }, kind).reading !== "now" }).toEqual({
      halt,
      kind,
      held: HELD_BY_ORACLE.includes(halt),
    });
  });
});
