import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl, type Database, type DbHandle } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import { HALT_KINDS, type HaltKind } from "@ashara/delivery/predicates";
import {
  CLOSED_LIFECYCLES,
  ClientMessageRepository,
  VisionRepository,
  createProjectWithTender,
  inboundDecision,
  listDueBlockReports,
  listDueReceipts,
  listOpenAnswers,
  listUnconsumedChanges,
  listUnconsumedStops,
} from "@ashara/engagement";
import type { InboundKind, InboundState } from "@ashara/engagement";
import type { ProjectId } from "@ashara/shared";
import { UNREAD_HALT_KINDS } from "../simulator/invariants.js";

// Every cell of Engagement's inbound-message decision (project state by message kind) against what the
// database does in that state: each reader lists a message exactly when the decision reads it now (one
// at its cap of failed readings exactly when the decision reads it at its cap), the receipt's listing
// and the halt report's listing state the state the decision was taken in, a halt's end resets exactly
// the counts the decision resets, and the simulator's own oracle of the halts that hold the reading
// agrees cell by cell. Each state is set up and rolled back inside one transaction, on a project whose
// tender's reading wrote its first vision and on one whose tender is not yet read. Every row belongs to
// a project this suite creates under a unique name.

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
  const due = await under({ lifecycle: "active", halt }, (tx) => listDueBlockReports(tx, async () => null));
  const written = (projectId: ProjectId): boolean | undefined => {
    const report = due.find((each) => "subject" in each && each.subject === "project-blocked" && each.projectId === projectId);
    return report !== undefined && "visionWritten" in report ? report.visionWritten : undefined;
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

  const { project: bareProject } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-bare`, "Build a command that prints a greeting.");
  const bareChange = await inbound(bareProject.id, "change", null);
  const bareChangeAtCap = await inbound(bareProject.id, "change", null);
  await charge(bareChange, 1, "model");
  await charge(bareChangeAtCap, AT_CAP, "model");

  const { project: stopProject, message: stopTender } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-stop`, "Build a command that prints a greeting.");
  await new ClientMessageRepository(db).markConsumed(stopTender.id);
  const stop = await inbound(stopProject.id, "stop", null);
  fixture = { projectId: project.id, bareProjectId: bareProject.id, stopProjectId: stopProject.id, tender: tender.id, answer, answerAtCap, change, changeAtCap, bareChange, bareChangeAtCap, stop };
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}-%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
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

describe("the end of every halt resets the counts the decision resets: an answer's and a change's, never a tender's", () => {
  test.each(HALT_KINDS)("%s", async (halt) => {
    const after = await attemptsAfterUnblock(halt);
    const reset = (kind: InboundKind, visionWritten: boolean): boolean => inboundDecision({ lifecycle: "active", halt, visionWritten }, kind).resetOnHaltEnd;
    expect({ answer: reset("answer", true), change: reset("change", true), tender: reset("tender", true), bareChange: reset("change", false) }).toEqual({
      answer: true,
      change: true,
      tender: false,
      bareChange: true,
    });
    expect({
      tender: after.get(fixture.tender),
      answer: after.get(fixture.answer),
      answerAtCap: after.get(fixture.answerAtCap),
      change: after.get(fixture.change),
      changeAtCap: after.get(fixture.changeAtCap),
      bareChange: after.get(fixture.bareChange),
      bareChangeAtCap: after.get(fixture.bareChangeAtCap),
    }).toEqual({ tender: 1, answer: 0, answerAtCap: 0, change: 0, changeAtCap: 0, bareChange: 0, bareChangeAtCap: 0 });
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
