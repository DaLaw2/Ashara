import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, EventStoreRepository, ProjectRepository } from "@ashara/db";
import { ProjectHaltRepository, runAcceptanceSweeps, WorkItemRowRepository } from "@ashara/delivery";
import {
  ClientAnswers,
  ClientStops,
  DeliveredReports,
  ClientMessageRepository,
  createProjectWithTender,
  VisionRepository,
} from "@ashara/engagement";
import type { DeliveredReportStore } from "@ashara/engagement";
import type { ContextualLlm } from "@ashara/finance";
import type { AcceptanceStore } from "@ashara/delivery";
import type { ProjectId } from "@ashara/shared";
import type { VisionSource } from "@ashara/engagement";
import { createAcceptanceStore, createDeliveredReportStore } from "@ashara/server/acceptance-store";
import { createAnswerStore } from "@ashara/server/answer-store";
import { createClientStopStore } from "@ashara/server/client-stop-store";

// Story s-independent-verify-m1 W7 (design P11, §2.8; eighth run E3): a project whose goal tasks are
// all done is swept on main once; a pass makes it Accepted with one delivered report rendered from
// the records, a failure is a defect repaired like any task given up. The sweep itself (cells, main)
// is Quality's and is stood in here; every record is real Postgres. Every row belongs to a
// project this suite creates under a unique name; afterAll deletes them.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NAME_PREFIX = `acceptance-test-${randomUUID().slice(0, 8)}`;
const MERGE_A = "a1".repeat(20);
const MAIN = "c3".repeat(20);

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<string>();

interface Delivered {
  readonly projectId: ProjectId;
  readonly goals: readonly string[];
  /** The product scaffold, Completed and checked only by the substrate: no stored check. */
  readonly scaffold: string;
  readonly checksOfStore: string;
}

/** The vision the plan was reviewed against, in the W11c shape: lines in and out of scope, and assumptions of each kind and standing. */
const VISION = {
  stored: { type: "scope", id: "S1", text: "Keys can be stored and read", side: "in" },
  deleted: { type: "scope", id: "S2", text: "Keys can be deleted", side: "in" },
  writers: { type: "scope", id: "S3", text: "Two writers never corrupt the store", side: "in" },
  network: { type: "scope", id: "S4", text: "Any network service", side: "out" },
  missing: { type: "assumption", id: "A1", text: "A missing key exits 3", status: "Stated", standing: "stated", kind: "client-visible" },
  logName: { type: "assumption", id: "A2", text: "The log file is kv.log", status: "Inferred", standing: "reported", kind: "internal-design" },
  prefix: { type: "assumption", id: "A3", text: "An empty prefix lists every key", status: "Inferred", standing: "reported", kind: "client-visible" },
} satisfies Record<string, VisionSource>;

/** A task's traced items and acceptance lines (d89 A), as decomposition stores them. */
function traced(sources: readonly VisionSource[], acceptance: ReadonlyArray<{ readonly line: string; readonly sources: readonly string[] }>) {
  return { visionItems: sources.map((source) => source.text), sources, acceptance };
}

/**
 * The project's vision v1 as intake and an earlier answer left it, matching VISION: A1 Stated by an
 * answer recorded before its effect was, A2 and A3 Inferred and reported; or, with `prefixAsked`, A3
 * asked by a question still open. Returns that question's id, or null.
 */
async function writeVision(projectId: ProjectId, tenderId: string, prefixAsked: boolean): Promise<string | null> {
  const [question] = prefixAsked ? await new ClientMessageRepository(db).insertQuestions(projectId, tenderId, ["Does an empty prefix list every key?"]) : [];
  const record = (source: Extract<VisionSource, { type: "assumption" }>, disclosed: "asked" | "reported") => ({
    key: source.id,
    statement: source.text,
    rationale: "The tender implies it.",
    status: "Inferred",
    kind: source.kind,
    disclosed,
  });
  await new VisionRepository(db).create(projectId, {
    visionText: "Build a key store.",
    summary: "A key store.",
    scopeBoundaries: [VISION.stored, VISION.deleted, VISION.writers, VISION.network].map((line) => ({ text: line.text, side: line.side })),
    inferences: [
      {
        ...record(VISION.missing, "asked"),
        status: "Stated",
        clientAnswer: { messageId: randomUUID(), questionMessageId: randomUUID(), question: "What does a missing key do?", answer: "Exit 3." },
      },
      record(VISION.logName, "reported"),
      record(VISION.prefix, prefixAsked ? "asked" : "reported"),
    ],
    openQuestions: question === undefined ? [] : [{ messageId: question.id, text: question.body, assumptionKey: VISION.prefix.id }],
  });
  return question?.id ?? null;
}

/**
 * A planned project whose every task is Completed: "Store keys" merged as MERGE_A, "Delete keys"
 * already delivered on MERGE_A, each with a check set whose acceptance lines cite S1 and A1, and S2,
 * and a review recording the whole vision: S3 and A3 no line cites, S4 is out of scope and A2 is the
 * team's design choice. With `prefixAsked`, A3 was asked about when the plan was made, and the
 * review recorded it so.
 */
async function deliveredProject(options: { readonly prefixAsked: boolean } = { prefixAsked: false }): Promise<Delivered & { readonly question: string | null }> {
  const { project, message } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Build a key store.");
  ourProjects.add(project.id);
  const question = await writeVision(project.id, message.id, options.prefixAsked);
  await db.execute(sql`UPDATE projects SET first_planned_at = now(), workspace_path = ${`/tmp/${NAME_PREFIX}`} WHERE id = ${project.id}`);
  const task = async (title: string, spec: unknown): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, task_spec, project_id)
      VALUES (${id}, 'Task', 'Completed', ${title}, ${JSON.stringify(spec)}::jsonb, ${project.id})`);
    return id;
  };
  const scaffold = await task("Set up the module root", { origin: "product-scaffold", checkedBy: "substrate" });
  const storeSpec = traced([VISION.stored, VISION.missing], [
    { line: "put then get prints the value", sources: ["S1"] },
    { line: "get of a missing key exits 3", sources: ["A1"] },
  ]);
  const removeSpec = traced([VISION.deleted], [{ line: "delete removes the key", sources: ["S2"] }]);
  const store = await task("Store keys", { origin: "decomposition", ...storeSpec });
  const remove = await task("Delete keys", { origin: "decomposition", ...removeSpec });
  const checksOfStore = await task("Checks for Store keys", { origin: "check", checksFor: store, ...storeSpec });
  const checksOfRemove = await task("Checks for Delete keys", { origin: "check", checksFor: remove, ...removeSpec });
  const all = Object.values(options.prefixAsked ? { ...VISION, prefix: { ...VISION.prefix, standing: "asked" } } : VISION);
  await task("Review the plan's checks", { origin: "review", visionItems: all.map((item) => item.text), sources: all });
  const workItems = new WorkItemRowRepository(db);
  await workItems.recordMergeCommit(store, MERGE_A, "merged");
  await workItems.recordMergeCommit(remove, MERGE_A, "already_delivered");
  for (const [taskId, checkTaskId] of [[store, checksOfStore], [remove, checksOfRemove]] as const) {
    await db.execute(sql`
      INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version)
      VALUES (${project.id}, ${taskId}, ${checkTaskId}, 1, 'works', 'sh checks/run.sh', '[]'::jsonb, ${"e".repeat(64)})`);
  }
  return { projectId: project.id, goals: [store, remove], scaffold, checksOfStore, question };
}

/** Rewrites one stored task_spec field of a work item, as a record written otherwise would hold it. */
async function setSpec(workItemId: string, field: string, value: unknown): Promise<void> {
  await db.execute(sql`
    UPDATE work_items SET task_spec = jsonb_set(task_spec, ${`{${field}}`}::text[], ${JSON.stringify(value)}::jsonb) WHERE id = ${workItemId}`);
}

async function removeSpec(workItemId: string, field: string): Promise<void> {
  await db.execute(sql`UPDATE work_items SET task_spec = task_spec - ${field} WHERE id = ${workItemId}`);
}

function acceptanceStore(): AcceptanceStore {
  const store = createAcceptanceStore(db);
  return { ...store, readyForAcceptance: async () => (await store.readyForAcceptance()).filter((ready) => ourProjects.has(ready.projectId)) };
}

/** The Liaison's reading of this suite's answers; the model's reading is stood in: it confirms. */
function clientAnswers(): ClientAnswers {
  const store = createAnswerStore(db);
  const llm: ContextualLlm = { forCall: () => ({ generateStructured: async (request) => ({ data: request.schema.parse({ verdict: "confirms" }), model: "stub-model", provider: "stub" }) }) };
  return new ClientAnswers({ llm, store: { ...store, openAnswers: async () => (await store.openAnswers()).filter((open) => ourProjects.has(open.projectId)) } });
}

function deliveredReports(): DeliveredReports {
  const store = createDeliveredReportStore(db);
  const ours: DeliveredReportStore = { ...store, dueReports: async () => (await store.dueReports()).filter((due) => ourProjects.has(due.projectId)) };
  return new DeliveredReports(ours);
}

function sweepDeps(passed: boolean, details: string, ran: { readonly checked: readonly string[]; readonly unchecked: readonly string[] } = { checked: [], unchecked: [] }) {
  const projects = new ProjectHaltRepository(db);
  return {
    acceptance: acceptanceStore(),
    acceptanceSweeper: {
      sweepForAcceptance: async () => ({
        kind: "ran" as const,
        passed,
        mainCommit: MAIN,
        environmentVersion: "v1",
        checkedTasks: ran.checked,
        uncheckedTasks: ran.unchecked,
        details,
      }),
    },
    projectRepo: { block: projects.block.bind(projects) },
    eventStore: new EventStoreRepository(db),
  };
}

async function statusOf(projectId: ProjectId): Promise<string> {
  const result = await db.execute(sql`SELECT status FROM projects WHERE id = ${projectId}`);
  return z.array(z.object({ status: z.string() })).parse(result.rows)[0]?.status ?? "(none)";
}

async function reportsOf(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT body FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound' AND kind = 'report' ORDER BY created_at, id`);
  return z.array(z.object({ body: z.string() })).parse(result.rows).map((row) => row.body);
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
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM acceptance_sweeps WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM plan_repairs WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("acceptance on main", () => {
  test("a passing sweep makes the project accepted, stops its dispatch, and posts one delivered report from the records", async () => {
    const { projectId, goals, scaffold } = await deliveredProject();
    const projects = new ProjectHaltRepository(db);
    expect(await acceptanceStore().readyForAcceptance()).toEqual([{ projectId, workspacePath: `/tmp/${NAME_PREFIX}`, goalTaskIds: goals }]);

    expect(await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: goals, unchecked: [scaffold] }))).toBe(1);

    expect(await statusOf(projectId)).toBe("accepted");
    expect(await projects.listActiveIds()).not.toContain(projectId);
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);

    expect(await deliveredReports().runPending()).toEqual([{ kind: "posted", projectId }]);
    expect(await deliveredReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(1);
    const [body] = reports;
    expect(body.split("\n\n")[0]).toContain(`the environment's test and the stored checks of 2 completed tasks passed together on main, commit ${MAIN}`);
    // The scaffold, checked only by the substrate, is done but listed apart from what passed.
    expect(body).toContain(`not checked by a stored check: none was written for them, so nothing in the run above confirms them:\n- "Set up the module root"`);
    expect(body).toContain(`"Store keys": built and merged, commit ${MERGE_A}.`);
    expect(body).toContain(`"Delete keys": already delivered when its turn came; nothing of its own was merged.`);
    expect(body).toContain(`the merge of "Store keys".`);
    // W11c D3: the items of what the client asked for that no acceptance line of a passing check task
    // cites, and only those; the exclusion and the team's design choice are never listed.
    expect(body).toContain(
      "These items of what you asked for are named by no acceptance criterion of a task whose stored checks passed on main, " +
        "so nothing confirms them either way:\n- Two writers never corrupt the store\n" +
        "- Ashara's assumption, which was reported to you: An empty prefix lists every key\n\n",
    );
    for (const absent of ["- Keys can be deleted", "A missing key exits 3", "Any network service", "kv.log"]) expect(body).not.toContain(absent);
  });

  // w12b D4: a goal task a plan revision replaced while it was open was set aside, never given up.
  test("the delivered report's given-up tasks are the goal tasks given up, never one a plan revision set aside", async () => {
    const { projectId, goals, scaffold } = await deliveredProject();
    expect(await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: goals, unchecked: [scaffold] }))).toBe(1);
    const abandoned = async (title: string, reason: unknown): Promise<void> => {
      await db.execute(sql`
        INSERT INTO work_items (id, level, status, title, task_spec, blocked_reason, project_id)
        VALUES (${randomUUID()}, 'Task', 'Abandoned', ${title}, ${JSON.stringify({ origin: "decomposition" })}::jsonb,
                ${JSON.stringify(reason)}::jsonb, ${projectId})`);
    };
    await abandoned("List keys", { source: "failure_given_up", reason: "exhausted 2 replan attempt(s) without success", attempts: 2 });
    await abandoned("Watch keys", { source: "superseded", planRevision: 2, requestedBy: null, repairOf: ["x"], reason: "replaced by the repaired plan" });
    const due = (await createDeliveredReportStore(db).dueReports()).find((row) => row.projectId === projectId);
    expect(due?.givenUp).toEqual(["List keys"]);
    expect(await deliveredReports().runPending()).toEqual([{ kind: "posted", projectId }]);
    const [body] = await reportsOf(projectId);
    expect(body).toContain(`These tasks were given up, and the plan was revised around them:\n- "List keys"`);
    expect(body).not.toContain("Watch keys");
  });

  test("coverage follows the trace: an item is checked only by a cited source of the same text, and a broken or missing trace is never read as covered", async () => {
    const due = async (projectId: ProjectId) => {
      const store = createDeliveredReportStore(db);
      return (await store.dueReports()).find((row) => row.projectId === projectId);
    };
    const accepted = async (): Promise<Delivered> => {
      const delivered = await deliveredProject();
      await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: delivered.goals, unchecked: [delivered.scaffold] }));
      return delivered;
    };

    // The answer behind A1 changed after its checks were written: the cited text is not the reviewed one.
    const drifted = await accepted();
    await setSpec(drifted.checksOfStore, "sources", [VISION.stored, { ...VISION.missing, text: "A missing key exits 1" }]);
    const driftedRow = await due(drifted.projectId);
    expect(driftedRow?.vision.kind === "recorded" && driftedRow.vision.items.filter((item) => item.checked).map((item) => item.source.id)).toEqual([
      "S1",
      "S2",
    ]);

    // A line citing an id its own task does not hold is a broken record, refused by name.
    const broken = await accepted();
    await setSpec(broken.checksOfStore, "acceptance", [{ line: "get works", sources: ["A9"] }]);
    await expect(due(broken.projectId)).rejects.toThrow(/acceptance line "get works" cites A9, which its task_spec.sources does not hold/);
    await removeSpec(broken.checksOfStore, "acceptance");

    // A check task written before acceptance lines were traced: coverage is not on record.
    expect((await due(broken.projectId))?.vision).toEqual({ kind: "unrecorded" });
    const posted = await deliveredReports().runPending();
    expect(posted.map((outcome) => outcome.projectId).sort()).toEqual([drifted.projectId, broken.projectId].sort());
    expect((await reportsOf(broken.projectId))[0]).toContain("is not on record for this plan, so none of it is stated as checked");
  });

  // smoke2 D1 (ADR-074 d95 a): the plan was made, then a confirming answer was read (no replan), then
  // the project was accepted. The review's copy of the vision still says the item was asked about.
  test("an answer confirming an assumption after the plan was made is reported as confirmed, and an unreadable standing is refused", async () => {
    const { projectId, goals, scaffold, question } = await deliveredProject({ prefixAsked: true });
    if (question === null) throw new Error("the fixture posted no question");
    const answerId = (await new ClientMessageRepository(db).insertInbound({ projectId, kind: "answer", body: "Yes, every key.", inReplyTo: question })).id;
    expect(await clientAnswers().runPending()).toEqual([
      { kind: "stated", answerId, projectId, assumptionKey: "A3", verdict: "confirms", visionVersion: 2, replanRequested: false },
    ]);
    expect(await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: goals, unchecked: [scaffold] }))).toBe(1);

    // The standing is read from the vision at acceptance: one it cannot read fails closed, never the review's copy.
    const saved = await db.execute(sql`SELECT inferences FROM vision_documents WHERE project_id = ${projectId} AND version = 2`);
    const inferences = z.array(z.object({ inferences: z.unknown() })).parse(saved.rows)[0]?.inferences;
    await db.execute(sql`UPDATE vision_documents SET inferences = inferences #- '{2,clientAnswer}' WHERE project_id = ${projectId} AND version = 2`);
    await expect(deliveredReports().runPending()).rejects.toThrow(/a Stated assumption carries the client answer that stated it/);
    await db.execute(sql`UPDATE vision_documents SET inferences = ${JSON.stringify(inferences)}::jsonb WHERE project_id = ${projectId} AND version = 2`);

    expect(await deliveredReports().runPending()).toContainEqual({ kind: "posted", projectId });
    const [body] = await reportsOf(projectId);
    expect(body).toContain("- An empty prefix lists every key (you confirmed this when asked)\n");
    expect(body).not.toContain("have not answered");
  });

  test("only a passed sweep makes a project accepted, and only the client's stop ends it, with the merges named", async () => {
    const { projectId } = await deliveredProject();
    await expect(db.execute(sql`UPDATE projects SET status = 'accepted' WHERE id = ${projectId}`)).rejects.toThrow();
    await runAcceptanceSweeps(sweepDeps(true, "all suites passed"));
    await expect(db.execute(sql`UPDATE projects SET status = 'active' WHERE id = ${projectId}`)).rejects.toThrow();
    expect(await statusOf(projectId)).toBe("accepted");

    await new ClientMessageRepository(db).insertInbound({ projectId, kind: "stop", body: "Thanks, done.", inReplyTo: null });
    const store = createClientStopStore(db);
    const outcomes = await new ClientStops({ ...store, openStops: async () => (await store.openStops()).filter((stop) => stop.projectId === projectId) }).runPending();
    expect(outcomes).toEqual([expect.objectContaining({ kind: "stopped", reported: true, merged: 2 })]);
    expect(await statusOf(projectId)).toBe("stopped");
    const stopReport = (await reportsOf(projectId)).find((body) => body.includes("stopped at your request"));
    expect(stopReport).toContain(`- "Store keys": merged, commit ${MERGE_A}`);
    expect(stopReport).toContain(`- "Delete keys": already delivered on commit ${MERGE_A}, nothing of its own merged`);
  });

  test("a failing sweep is never accepted: it opens a defect given up with the run, whose repair the plan awaits", async () => {
    const { projectId } = await deliveredProject();
    const details = `1 failure(s) on main:\n- task x's checks: check "delete" exited 1`;

    expect(await runAcceptanceSweeps(sweepDeps(false, details))).toBe(0);

    expect(await statusOf(projectId)).toBe("active");
    const defects = await db.execute(sql`
      SELECT w.status, w.blocked_reason->>'source' AS source, w.blocked_reason->>'reason' AS reason, w.blocked_reason->>'mainCommit' AS "mainCommit",
             w.task_spec->>'origin' AS origin, r.plan_revision_id IS NULL AS awaited, s.passed
      FROM acceptance_sweeps s JOIN work_items w ON w.id = s.defect_item_id JOIN plan_repairs r ON r.work_item_id = w.id
      WHERE s.project_id = ${projectId}`);
    expect(defects.rows).toEqual([
      { status: "Abandoned", source: "acceptance_failed", reason: details, mainCommit: MAIN, origin: "acceptance", awaited: true, passed: false },
    ]);
    // The repair holds dispatch and readiness; nothing is reported as delivered.
    expect(await new ProjectRepository(db).listActiveIds()).not.toContain(projectId);
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);
    expect(await deliveredReports().runPending()).toEqual([]);
  });

  test("a sweep that keeps faulting is counted on the project, durably, and halts it as undeliverable past the budget", async () => {
    const { projectId } = await deliveredProject();
    const projects = new ProjectHaltRepository(db);
    const fault = Object.assign(new Error("the acceptance sweep could not run: read main failed: fatal: bad object HEAD"), {
      name: "AcceptanceSweepFault",
      projectId,
      step: "read main",
    });
    const deps = {
      ...sweepDeps(false, "unused"),
      acceptanceSweeper: { sweepForAcceptance: async () => ({ kind: "faulted" as const, mainCommit: null, error: fault }) },
    };
    await runAcceptanceSweeps(deps);
    // A fault that is not the substrate's is a defect given up with the recorded fault, main unread.
    const first = await db.execute(sql`
      SELECT p.acceptance_faults AS faults, s.main_commit AS "mainCommit", w.blocked_reason->>'reason' AS reason
      FROM projects p JOIN acceptance_sweeps s ON s.project_id = p.id JOIN work_items w ON w.id = s.defect_item_id
      WHERE p.id = ${projectId}`);
    expect(first.rows).toEqual([{ faults: 1, mainCommit: null, reason: expect.stringContaining("fatal: bad object HEAD") }]);
    // Each later round finds the project ready again (its repair done); past the budget it halts.
    for (let round = 2; round <= 4; round++) {
      await db.execute(sql`DELETE FROM plan_repairs WHERE project_id = ${projectId}`);
      await runAcceptanceSweeps(deps);
    }
    expect(await statusOf(projectId)).toBe("blocked");
    const block = await db.execute(sql`
      SELECT p.acceptance_faults AS faults, p.blocked_category AS category, b.error_class AS "errorClass"
      FROM projects p JOIN project_blocks b ON b.project_id = p.id WHERE p.id = ${projectId} ORDER BY b.blocked_at DESC LIMIT 1`);
    expect(block.rows).toEqual([{ faults: 4, category: "fault", errorClass: "AcceptanceFaultBudgetSpent" }]);
    expect(await projects.listActiveIds()).not.toContain(projectId);
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);
  });
});
