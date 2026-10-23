import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import { ClientMessageRepository, ClientStops, TERMINAL_KINDS, TerminalMessage, VisionRepository, terminalTableOf } from "@ashara/engagement";
import type { ClientStopStore, TerminalReportStore } from "@ashara/engagement";
import { UnreadSubject, systemClock } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import { createClientStopStore } from "@ashara/server/client-stop-store";
import { createTerminalReportStore } from "@ashara/server/terminal-report-store";
import { dueProjectOf, terminalReportsOf } from "./terminal-reports.js";
import { sweepTerminalsOf } from "./terminal-sweeps.js";

// Every terminal message goes through one path: the terminal step lists each one owed once, builds
// its guarantee table with the one builder, and posts it with its verdicts in the transaction that
// records it told. Each kind (a delivered report, a stop's, an accepted project's stop's, a halt's,
// a stopped first planning's, a declined contract's) reaches the client as exactly one message
// carrying the table; a restart between the listing and the post neither sends one twice nor drops
// it. Every row belongs to a project this suite creates under a unique name; afterAll deletes them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `terminal-messages-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<string>();
const ours = (projectId: string): boolean => ourProjects.has(projectId);

async function newProject(): Promise<ProjectId> {
  const project = await new ProjectHaltRepository(db).create(`${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, clientId);
  ourProjects.add(project.id);
  return project.id;
}

/** Vision v1 in the guarantees form, G1 and G2: observed in its output, or seen only in stored data and marked not verifiable by Ashara when `declined`, so Ashara declines it. */
async function writeContract(projectId: ProjectId, declined = false): Promise<void> {
  const quote = (text: string) => ({ kind: "tender" as const, quote: text });
  const verification = declined ? { verification: "not-by-ashara" as const } : {};
  const observation = declined ? ("stored-data" as const) : ("output" as const);
  await new VisionRepository(db).create(projectId, {
    visionText: "A key store. Clients put and get keys. A put survives a crash.",
    summary: "A key store.",
    inferences: [],
    contract: {
      interface: [{ id: "I1", text: "kv put KEY VALUE; kv get KEY", source: quote("Clients put and get keys.") }],
      guarantees: [
        { id: "G1", statement: "A put survives a crash.", observable: { interface: ["I1"], observation }, refutedBy: ["a get misses a put after a kill"], source: quote("A put survives a crash."), ...verification },
        { id: "G2", statement: "A put is kept on disk.", observable: { interface: ["I1"], observation }, refutedBy: ["the data file lacks a put"], source: quote("A put survives a crash."), ...verification },
      ],
      exclusions: [],
    },
  });
}

/** A passed acceptance sweep on main and the project accepted on it, as Quality's acceptance records them. */
async function accept(projectId: ProjectId): Promise<void> {
  await db.execute(sql`
    INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details)
    VALUES (${projectId}, ${"c".repeat(40)}, 'env-1', '[]'::jsonb, '[]'::jsonb, true, 'terminal-messages sweep')`);
  await db.execute(sql`UPDATE projects SET lifecycle = 'accepted', workspace_path = '/nonexistent/terminal-messages' WHERE id = ${projectId}`);
}

/** The client's stop, taken by the Liaison's stop step as the top of a cycle takes it. */
async function stop(projectId: ProjectId): Promise<void> {
  await new ClientMessageRepository(db).insertInbound({ projectId, kind: "stop", body: "Stop, please.", inReplyTo: null });
  const store = createClientStopStore(db);
  const scoped: ClientStopStore = { ...store, openStops: async () => (await store.openStops()).filter((open) => open.projectId === projectId) };
  expect(await new ClientStops(scoped, memoryStepContainment(() => true)).runPending()).toEqual([expect.objectContaining({ kind: "stopped", projectId })]);
}

/** First planning giving up, as stopFirstPlanning writes it: planning stopped and the halt's episode together. */
async function stopPlanning(projectId: ProjectId): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO project_plans (project_id, plan_stopped_at, plan_attempts, plan_last_error) VALUES (${projectId}, now(), 3, 'x')`);
    await tx.execute(sql`INSERT INTO project_blocks (project_id, kind, reason) VALUES (${projectId}, 'planning_stopped', 'x')`);
  });
}

const MessageRows = z.array(z.object({ body: z.string(), verdicts: z.array(z.object({ guaranteeId: z.string(), verdict: z.string(), reason: z.string().nullable() })) }));

/** The project's outbound messages, oldest first, each with the verdicts stored beside it. */
async function messagesOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT m.body, COALESCE((SELECT jsonb_agg(jsonb_build_object('guaranteeId', v.guarantee_id, 'verdict', v.verdict, 'reason', v.reason) ORDER BY v.guarantee_id)
      FROM guarantee_verdicts v WHERE v.report_id = m.id), '[]'::jsonb) AS verdicts
    FROM client_messages m WHERE m.project_id = ${projectId} AND m.direction = 'outbound' ORDER BY m.created_at, m.id`);
  return MessageRows.parse(result.rows);
}

/** Every guarantee of the contract is in the message's table once, and its verdict is stored beside it. */
function carriesTheTable(message: z.infer<typeof MessageRows>[number]): void {
  for (const id of ["G1", "G2"]) {
    expect(message.body.split("\n").filter((line) => line.startsWith(`- ${id}: `) && line.includes(" | verdict: ")), message.body).toHaveLength(1);
  }
  expect(message.verdicts.map((verdict) => verdict.guaranteeId)).toEqual(["G1", "G2"]);
}

/** One run of the terminal step over this suite's projects, each terminal's sweep recorded first. */
async function terminalStep() {
  return terminalReportsOf(db, ours).runPending(TERMINAL_KINDS);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  for (const id of ourProjects) {
    for (const table of ["guarantee_verdicts", "told_reports", "delivered_report_attempts", "guarantee_evidence", "acceptance_sweeps"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE project_id = ${id}`);
    }
    await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${id} AND in_reply_to IS NOT NULL`);
    await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${id}`);
    for (const table of ["project_blocks", "project_plans", "vision_documents"]) await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE project_id = ${id}`);
    await db.execute(sql`DELETE FROM projects WHERE id = ${id}`);
  }
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("every kind of terminal reaches the client as exactly one message carrying the table", () => {
  test("a delivered report", async () => {
    const projectId = await newProject();
    await writeContract(projectId);
    await accept(projectId);

    expect((await terminalStep()).filter((outcome) => outcome.projectId === projectId)).toEqual([{ kind: "posted", projectId, terminal: "delivered" }]);
    expect(await terminalStep()).toEqual([]);
    const messages = await messagesOf(projectId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toMatch(/^Your project is delivered\./);
    carriesTheTable(messages[0] ?? expect.unreachable("one message"));
  });

  test("a stop", async () => {
    const projectId = await newProject();
    await writeContract(projectId);
    await stop(projectId);

    expect(await terminalStep()).toEqual([{ kind: "posted", projectId, terminal: "stopped" }]);
    expect(await terminalStep()).toEqual([]);
    const messages = await messagesOf(projectId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toMatch(/^Work on this project has stopped at your request\./);
    expect(messages[0]?.body).not.toContain("already been accepted");
    carriesTheTable(messages[0] ?? expect.unreachable("one message"));
  });

  test("a stop of a project already accepted: its delivered report, then one stop message saying the acceptance stands", async () => {
    const projectId = await newProject();
    await writeContract(projectId);
    await accept(projectId);
    expect(await terminalStep()).toEqual([{ kind: "posted", projectId, terminal: "delivered" }]);
    await stop(projectId);

    expect(await terminalStep()).toEqual([{ kind: "posted", projectId, terminal: "stopped" }]);
    expect(await terminalStep()).toEqual([]);
    const [delivered, stopped, ...rest] = await messagesOf(projectId);
    expect(rest).toEqual([]);
    expect(delivered?.body).toMatch(/^Your project is delivered\./);
    expect(stopped?.body).toMatch(/^Work on this project has stopped at your request\./);
    expect(stopped?.body).toContain("This project had already been accepted when your request arrived: its acceptance stands");
    carriesTheTable(stopped ?? expect.unreachable("the stop message"));
  });

  test("a stop of a project accepted and never yet told so: the stop message alone, saying the acceptance stands", async () => {
    const projectId = await newProject();
    await writeContract(projectId);
    await accept(projectId);
    await stop(projectId);

    expect(await terminalStep()).toEqual([{ kind: "posted", projectId, terminal: "stopped" }]);
    expect(await terminalStep()).toEqual([]);
    const messages = await messagesOf(projectId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain("its acceptance stands");
    carriesTheTable(messages[0] ?? expect.unreachable("one message"));
  });

  test("a halt", async () => {
    const projectId = await newProject();
    await writeContract(projectId);
    await new ProjectHaltRepository(db).block(projectId, { category: "fault", errorClass: "TerminalMessagesFault", reason: "halted by the test" });

    expect(await terminalStep()).toEqual([{ kind: "posted", projectId, terminal: "halted" }]);
    expect(await terminalStep()).toEqual([]);
    const messages = await messagesOf(projectId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toMatch(/^Work on this project is paused\./);
    carriesTheTable(messages[0] ?? expect.unreachable("one message"));
  });

  test("a first planning that stopped, told by its own message and not again as a halt", async () => {
    const projectId = await newProject();
    await writeContract(projectId);
    await stopPlanning(projectId);

    expect(await terminalStep()).toEqual([{ kind: "posted", projectId, terminal: "planning-stopped" }]);
    expect(await terminalStep()).toEqual([]);
    const messages = await messagesOf(projectId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain("could not turn this project's vision into a plan after 3 attempts");
    carriesTheTable(messages[0] ?? expect.unreachable("one message"));
  });

  test("a declined contract: every guarantee it marks not verifiable by Ashara listed as not verified", async () => {
    const projectId = await newProject();
    await writeContract(projectId, true);

    expect(await terminalStep()).toEqual([{ kind: "posted", projectId, terminal: "declined" }]);
    expect(await terminalStep()).toEqual([]);
    const messages = await messagesOf(projectId);
    expect(messages).toHaveLength(1);
    const [declined] = messages;
    expect(declined?.body).toMatch(/^Ashara declines the contract drafted from your tender as written\./);
    carriesTheTable(declined ?? expect.unreachable("one message"));
    for (const id of ["G1", "G2"]) expect(declined?.body).toMatch(new RegExp(`^- ${id}: .* \\| verdict: not verified, `, "m"));
    expect(declined?.verdicts).toEqual([
      { guaranteeId: "G1", verdict: "unjudged", reason: "not-verifiable-by-ashara" },
      { guaranteeId: "G2", verdict: "unjudged", reason: "not-verifiable-by-ashara" },
    ]);
  });
});

/**
 * Appends vision v`version` to `projectId`, a copy of its declined v1 as a restatement by the client
 * writes it: still declined when `declined`, else with every guarantee observed in its output and
 * unmarked, so Ashara can verify it.
 */
async function restate(projectId: ProjectId, version: number, declined: boolean): Promise<void> {
  const guarantees = declined
    ? sql`guarantees`
    : sql`(SELECT jsonb_agg(jsonb_set(g - 'verification' - 'unverifiableBecause', '{observable,observation}', '"output"')) FROM jsonb_array_elements(guarantees) g)`;
  await db.execute(sql`
    INSERT INTO vision_documents (project_id, version, vision_text, summary, inferences, contract_form, interface, guarantees, exclusions, change_reason)
    SELECT project_id, ${version}, vision_text, summary, inferences, contract_form, interface, ${guarantees}, exclusions, 'restated by the test'
    FROM vision_documents WHERE project_id = ${projectId} AND version = 1`);
}

const DeclineRows = z.array(z.object({ version: z.number() }));

describe("a decline is told once per vision version", () => {
  test("declined, restated into a contract Ashara can verify, then declined again: two declines, one per version, each with its table", async () => {
    const projectId = await newProject();
    await writeContract(projectId, true);
    expect(await terminalStep()).toEqual([{ kind: "posted", projectId, terminal: "declined" }]);

    await restate(projectId, 2, false);
    expect(await terminalStep()).toEqual([]);

    await restate(projectId, 3, true);
    expect(await terminalStep()).toEqual([{ kind: "posted", projectId, terminal: "declined" }]);
    expect(await terminalStep()).toEqual([]);

    const [first, second, ...rest] = await messagesOf(projectId);
    expect(rest).toEqual([]);
    expect(first?.body).toMatch(/^Ashara declines the contract drafted from your tender as written\./);
    expect(second?.body).toMatch(/^Ashara declines your contract as it stands in vision v3\./);
    for (const message of [first, second]) carriesTheTable(message ?? expect.unreachable("two declines"));
    const versions = await db.execute(sql`SELECT reports_on_version AS version FROM client_messages
      WHERE project_id = ${projectId} AND reports_on = 'declined' ORDER BY created_at, id`);
    expect(DeclineRows.parse(versions.rows).map((row) => row.version)).toEqual([1, 3]);
  });

  test("a second decline of one version is refused by the unique index on the project's declines", async () => {
    const projectId = await newProject();
    await writeContract(projectId, true);
    expect(await terminalStep()).toEqual([{ kind: "posted", projectId, terminal: "declined" }]);
    const again = sql`INSERT INTO client_messages (project_id, direction, kind, body, reports_on, reports_on_version)
      VALUES (${projectId}, 'outbound', 'report', 'Declined again.', 'declined', 1)`;
    await expect(db.execute(again)).rejects.toThrow();
    const unversioned = sql`INSERT INTO client_messages (project_id, direction, kind, body, reports_on)
      VALUES (${projectId}, 'outbound', 'report', 'Declined, no version.', 'declined')`;
    await expect(db.execute(unversioned)).rejects.toThrow();
    expect(await messagesOf(projectId)).toHaveLength(1);
  });
});

describe("a guarantee table is built only by Engagement's records reader", () => {
  test("Engagement exports no other builder of a table, and a hand-made table is refused by the type of every terminal message", async () => {
    const engagement = await import("@ashara/engagement");
    expect(Object.keys(engagement)).not.toContain("guaranteeTableOf");
    const projectId = await newProject();
    const event = { kind: "declined", projectId, visionVersion: 1 } as const;
    // @ts-expect-error a table no records reader built carries no brand, so no terminal message takes it
    const handMade: Parameters<typeof TerminalMessage.of>[1] = { kind: "unreadable", sweepId: null };
    expect(TerminalMessage.of(event, await terminalTableOf(db, { kind: "no-sweep", projectId })).body).toContain("No contract is on record for this project");
    expect(handMade.kind).toBe("unreadable");
  });
});

type Due = Awaited<ReturnType<TerminalReportStore["dueTerminals"]>>[number];

/** The message the step would post for a listed terminal, built from the listing alone. */
function messageOf(due: Due): TerminalMessage {
  if (due instanceof UnreadSubject) throw new Error(`terminal ${due.id} did not read`, { cause: due });
  if (due.kind === "listed") return TerminalMessage.of(due.event, due.table);
  if (due.kind === "delivered-unread") throw new Error(`the delivered report of sweep ${due.report.sweepId} did not read`);
  return TerminalMessage.of({ kind: "delivered", projectId: due.report.projectId, report: due.report, interfaceFile: "PUBLIC_INTERFACE.md", productInterface: { kind: "absent" } }, due.table);
}

/** The terminals one connection lists of `projects`, each terminal's sweep recorded first. */
async function dueOn(handle: ReturnType<typeof createDb>, projects: ReadonlySet<string>): Promise<Due[]> {
  await sweepTerminalsOf(handle, (id) => projects.has(id));
  return (await createTerminalReportStore(handle, systemClock).dueTerminals(TERMINAL_KINDS)).filter((due) => projects.has(dueProjectOf(due)));
}

describe("the one due listing", () => {
  test("lists each project's owed terminal once, and none once it is posted", async () => {
    const delivered = await newProject();
    const halted = await newProject();
    const declined = await newProject();
    await writeContract(delivered);
    await accept(delivered);
    await writeContract(halted);
    await new ProjectHaltRepository(db).block(halted, { category: "fault", errorClass: "TerminalMessagesFault", reason: "halted by the test" });
    await writeContract(declined, true);
    const projects = new Set<string>([delivered, halted, declined]);

    const due = await dueOn(db, projects);
    expect(due.map(dueProjectOf).sort()).toEqual([...projects].sort());
    const store = createTerminalReportStore(db, systemClock);
    for (const each of due) expect(await store.postTerminal(messageOf(each))).toBe("posted");
    expect(await dueOn(db, projects)).toEqual([]);
  });

  test("a restart between the listing and the post neither sends a message twice nor drops one", async () => {
    const projectIds = [await newProject(), await newProject(), await newProject(), await newProject()];
    const [delivered, stopped, halted, declined] = projectIds;
    if (delivered === undefined || stopped === undefined || halted === undefined || declined === undefined) throw new Error("four projects were made");
    for (const id of [delivered, stopped, halted]) await writeContract(id);
    await writeContract(declined, true);
    await accept(delivered);
    await stop(stopped);
    await new ProjectHaltRepository(db).block(halted, { category: "fault", errorClass: "TerminalMessagesFault", reason: "halted by the test" });
    const projects = new Set<string>(projectIds);

    // Listed, then the process ends before any post.
    const before = createDb(DATABASE_URL);
    const listed = (await dueOn(before, projects)).map(messageOf);
    await before.$client.end();
    expect(listed.map((message) => message.projectId).sort()).toEqual([...projectIds].sort());

    // After the restart every one is still due: nothing was dropped.
    const after = createDb(DATABASE_URL);
    try {
      expect((await dueOn(after, projects)).map(dueProjectOf).sort()).toEqual([...projectIds].sort());
      // The restarted process posts each once; the message the ended process listed is told already.
      expect((await terminalReportsOf(after, (id) => projects.has(id)).runPending(TERMINAL_KINDS)).map((outcome) => outcome.kind)).toEqual(["posted", "posted", "posted", "posted"]);
      const store = createTerminalReportStore(after, systemClock);
      for (const message of listed) expect(await store.postTerminal(message)).toBe("already-posted");
      expect(await dueOn(after, projects)).toEqual([]);
    } finally {
      await after.$client.end();
    }
    for (const id of projectIds) expect(await messagesOf(id)).toHaveLength(1);
  });
});
