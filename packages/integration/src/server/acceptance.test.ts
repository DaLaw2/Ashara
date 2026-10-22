import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, EventStoreRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { isGoalTask } from "@ashara/delivery/predicates";
import type { Database } from "@ashara/db";
import { ProjectHaltRepository, runAcceptanceSweeps, WorkItemRowRepository } from "@ashara/delivery";
import { environmentVersion } from "@ashara/execution-infra";
import type { Cell } from "@ashara/execution-infra";
import {
  BlockReports,
  ClientAnswers,
  ClientStops,
  DeliveredReports,
  ClientMessageRepository,
  createProjectWithTender,
  guaranteesInForce,
  VisionRepository,
} from "@ashara/engagement";
import type { BlockReportStore, DeliveredReportStore } from "@ashara/engagement";
import type { ContextualLlm } from "@ashara/finance";
import type { AcceptanceStore } from "@ashara/delivery";
import { AcceptanceSweeper, SCAFFOLD_PLACEHOLDER_MARKER } from "@ashara/quality";
import type { MainSweepDeps } from "@ashara/quality";
import type { ProjectId } from "@ashara/shared";
import { memoryStepContainment, notExercised, recordingLogger } from "@ashara/shared/testing";
import type { VisionSource } from "@ashara/engagement";
import { createAcceptanceStore, createDeliveredReportStore, createTerminalSweepStore } from "@ashara/server/acceptance-store";
import { createAnswerStore } from "@ashara/server/answer-store";
import { createBlockReportStore } from "@ashara/server/block-report-store";
import { createClientStopStore } from "@ashara/server/client-stop-store";
import { projectState } from "../simulator/project-state.js";

// A project whose goal tasks are
// all done is swept on main once; a pass that judges every guarantee in force pass makes it Accepted
// with one delivered report rendered from the records, a pass that leaves one unjudged accepts
// nothing and halts it, a failure is a defect repaired like any task given up. The sweep itself (cells, main)
// is Quality's and is stood in here; every record is real Postgres. Every row belongs to a
// project this suite creates under a unique name; afterAll deletes them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `acceptance-test-${randomUUID().slice(0, 8)}`;
const MERGE_A = "a1".repeat(20);
const MAIN = "c3".repeat(20);
const SCAFFOLD_MERGE = "5e".repeat(20);

let db: ReturnType<typeof createDb>;
let clientId: string;
const ourProjects = new Set<string>();

interface Delivered {
  readonly projectId: ProjectId;
  readonly goals: readonly string[];
  /** The product scaffold, Completed and checked only by the substrate: no stored check. */
  readonly scaffold: string;
  /** "Store keys", whose check task is checksOfStore. */
  readonly store: string;
  readonly checksOfStore: string;
}

/** The vision the plan was reviewed against: lines in and out of scope, and assumptions of each kind and standing. */
const VISION = {
  stored: { type: "scope", id: "S1", text: "Keys can be stored and read", side: "in" },
  deleted: { type: "scope", id: "S2", text: "Keys can be deleted", side: "in" },
  writers: { type: "scope", id: "S3", text: "Two writers never corrupt the store", side: "in" },
  network: { type: "scope", id: "S4", text: "Any network service", side: "out" },
  missing: { type: "assumption", id: "A1", text: "A missing key exits 3", status: "Stated", standing: "stated", kind: "client-visible" },
  logName: { type: "assumption", id: "A2", text: "The log file is kv.log", status: "Inferred", standing: "reported", kind: "internal-design" },
  prefix: { type: "assumption", id: "A3", text: "An empty prefix lists every key", status: "Inferred", standing: "reported", kind: "client-visible" },
} satisfies Record<string, VisionSource>;

/** A task's traced items and acceptance lines, as decomposition stores them. */
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
 * and whose stored check decides them, and a review recording the whole vision: S3 and A3 no check
 * decides, S4 is out of scope and A2 is the team's design choice. With `prefixAsked`, A3 was asked about when the plan was made, and the
 * review recorded it so.
 */
async function deliveredProject(
  options: { readonly prefixAsked?: boolean; readonly scaffoldMerged?: boolean } = {},
): Promise<Delivered & { readonly question: string | null }> {
  const { project, message } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Build a key store.");
  ourProjects.add(project.id);
  const question = await writeVision(project.id, message.id, options.prefixAsked === true);
  await db.execute(sql`WITH planned AS (INSERT INTO project_plans (project_id, first_planned_at) VALUES (${project.id}, now())) UPDATE projects SET workspace_path = ${`/tmp/${NAME_PREFIX}`} WHERE id = ${project.id}`);
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
  const all = Object.values(options.prefixAsked === true ? { ...VISION, prefix: { ...VISION.prefix, standing: "asked" } } : VISION);
  await task("Review the plan's checks", { origin: "review", visionItems: all.map((item) => item.text), sources: all });
  const workItems = new WorkItemRowRepository(db);
  await workItems.recordMergeCommit(store, MERGE_A, "merged");
  await workItems.recordMergeCommit(remove, MERGE_A, "already_delivered");
  if (options.scaffoldMerged !== false) await workItems.recordMergeCommit(scaffold, SCAFFOLD_MERGE, "merged");
  for (const [taskId, checkTaskId, decides] of [[store, checksOfStore, ["S1", "A1"]], [remove, checksOfRemove, ["S2"]]] as const) {
    await storeCheck(project.id, taskId, checkTaskId, decides);
  }
  return { projectId: project.id, goals: [store, remove], scaffold, store, checksOfStore, question };
}

/** Vision v1 in the guarantees form: G1 and G2, both observed at I1 and quoted from the tender. */
const CONTRACT_TENDER = "A key store. Clients put and get keys. A deleted key is gone.";

/**
 * A planned project in the guarantees form whose one goal task, "Store keys", is Completed and
 * merged, with one stored check ("works") that decides G1 and G2.
 */
async function contractProject(
  storedData: "with-stored-data" | "without-stored-data" = "without-stored-data",
): Promise<{ readonly projectId: ProjectId; readonly goals: readonly string[]; readonly checksOfStore: string }> {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, CONTRACT_TENDER);
  ourProjects.add(project.id);
  const quote = (text: string) => ({ kind: "tender" as const, quote: text });
  await new VisionRepository(db).create(project.id, {
    visionText: CONTRACT_TENDER,
    summary: "A key store.",
    inferences: [],
    contract: {
      interface: [{ id: "I1", text: "kv put KEY VALUE; kv get KEY; kv delete KEY", source: quote("Clients put and get keys.") }],
      guarantees: [
        { id: "G1", statement: "A get returns the value of the last put of its key.", observable: { interface: ["I1"], observation: "output" }, refutedBy: ["a get after a put prints another value"], source: quote("Clients put and get keys.") },
        { id: "G2", statement: "A deleted key is gone.", observable: { interface: ["I1"], observation: "exit-status" }, refutedBy: ["a get after a delete exits 0"], source: quote("A deleted key is gone.") },
        ...(storedData === "with-stored-data"
          ? [{ id: "G3", statement: "A put survives a restart.", observable: { interface: ["I1"], observation: "stored-data" as const }, refutedBy: ["a get after a restart misses a put"], source: quote("A key store.") }]
          : []),
      ],
      exclusions: [],
    },
  });
  await db.execute(sql`WITH planned AS (INSERT INTO project_plans (project_id, first_planned_at) VALUES (${project.id}, now())) UPDATE projects SET workspace_path = ${`/tmp/${NAME_PREFIX}`} WHERE id = ${project.id}`);
  const store = randomUUID();
  const checksOfStore = randomUUID();
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, task_spec, project_id)
    VALUES (${store}, 'Task', 'Completed', 'Store keys', ${JSON.stringify({ origin: "decomposition" })}::jsonb, ${project.id}),
           (${checksOfStore}, 'Task', 'Completed', 'Checks for Store keys', ${JSON.stringify({ origin: "check", checksFor: store })}::jsonb, ${project.id})`);
  await new WorkItemRowRepository(db).recordMergeCommit(store, MERGE_A, "merged");
  await storeCheck(project.id, store, checksOfStore, ["G1", "G2"]);
  return { projectId: project.id, goals: [store], checksOfStore };
}

/** One stored check of a task's first revision, deciding `decides` (null: a row from before checks recorded what they decide). */
async function storeCheck(projectId: string, taskId: string, checkTaskId: string, decides: readonly string[] | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version, decides)
    VALUES (${projectId}, ${taskId}, ${checkTaskId}, 1, 'works', 'sh checks/run.sh', '[]'::jsonb, ${"e".repeat(64)},
            ${decides === null ? null : JSON.stringify(decides)}::jsonb)`);
}

/** Rewrites one stored task_spec field of a work item, as a record written otherwise would hold it. */
async function setSpec(workItemId: string, field: string, value: unknown): Promise<void> {
  await db.execute(sql`
    UPDATE work_items SET task_spec = jsonb_set(task_spec, ${`{${field}}`}::text[], ${JSON.stringify(value)}::jsonb) WHERE id = ${workItemId}`);
}

function acceptanceStore(): AcceptanceStore {
  const store = createAcceptanceStore(db);
  return { ...store, readyForAcceptance: async () => (await store.readyForAcceptance()).filter((ready) => ourProjects.has(ready.projectId)) };
}

/** The Liaison's reading of this suite's answers; the model's reading is stood in: it confirms. */
function clientAnswers(): ClientAnswers {
  const store = createAnswerStore(db);
  const llm: ContextualLlm = { forCall: () => ({ generateStructured: async (request) => ({ data: request.schema.parse({ reading: { verdict: "confirms" } }), model: "stub-model", provider: "stub", grade: "Strong" }) }) };
  return new ClientAnswers({ containment: memoryStepContainment(() => true), llm, store: { ...store, openAnswers: async () => (await store.openAnswers()).filter((open) => ourProjects.has(open.projectId)) } });
}

/** Where each delivered report read the product's interface file: the project's workspace at the accepted commit. */
const interfaceReads: string[] = [];
const INTERFACE_TEXT = "Run: kv put <key> <value>\n";

/** A workspace whose git fails every read, as a checkout that is not a repository does. */
const BROKEN_WORKSPACE = `/tmp/${NAME_PREFIX}-not-a-repository`;

function deliveredReports(): DeliveredReports {
  const store = createDeliveredReportStore(db);
  const ours: DeliveredReportStore = { ...store, dueReports: async () => (await store.dueReports()).filter((due) => ourProjects.has(due.projectId)) };
  return new DeliveredReports(ours, {
    file: "PUBLIC_INTERFACE.md",
    at: async (targetProjectPath, commit) => {
      interfaceReads.push(`${targetProjectPath}@${commit}`);
      if (targetProjectPath === BROKEN_WORKSPACE) throw new Error(`git ls-tree: fatal: not a git repository: ${BROKEN_WORKSPACE}`);
      return { kind: "present", text: INTERFACE_TEXT };
    },
  });
}

/**
 * A stand-in sweep's verdict and what it ran: by default every checked task's stored check
 * ("works", as storeCheck writes it) ran and passed, deciding `decides`.
 */
function sweepDeps(
  passed: boolean,
  details: string,
  ran: { readonly checked: readonly string[]; readonly unchecked: readonly string[] } = { checked: [], unchecked: [] },
  failedChecks: ReadonlyArray<{ readonly taskId: string; readonly checkTaskId: string; readonly name: string }> = [],
  decides: readonly string[] | null = null,
) {
  const projects = new ProjectHaltRepository(db);
  // The stand-in names each checked task's stored check ("works", revision 1, as storeCheck writes it).
  const checkOutcomes = ran.checked.map((taskId) => ({ taskId, revision: 1, checkTaskId: taskId, name: "works", command: "sh checks/run.sh", decides, outcome: "passed" as const }));
  return {
    acceptance: acceptanceStore(),
    containment: memoryStepContainment(() => true),
    acceptanceSweeper: {
      sweepForAcceptance: async () => ({
        kind: "ran" as const,
        passed,
        mainCommit: MAIN,
        environmentVersion: "v1",
        checkedTasks: ran.checked,
        uncheckedTasks: ran.unchecked,
        publicInterface: { kind: "not-placeholder" as const },
        placeholder: { kind: "not-searched" as const },
        checkOutcomes,
        failedChecks,
        details,
      }),
    },
    projectRepo: { block: projects.block.bind(projects) },
    eventStore: new EventStoreRepository(db),
    logger: recordingLogger(),
  };
}

/**
 * Records the project accepted on a passed sweep as acceptance was recorded before it required every
 * guarantee judged pass: a version written before guarantees holds none a check can judge, so Quality
 * accepts none now, while the records of one accepted then are still reported on. The sweep row holds
 * every checked task's stored check ("works", as storeCheck writes it) as run and passed, each
 * guarantee in force its evidence as Quality records it (each such check deciding it by `decides`, and
 * whether a review left it undecided on that check's check task), and the project moves to accepted,
 * which the passed row admits.
 */
async function acceptedBeforeCoverage(
  projectId: ProjectId,
  ran: { readonly checked: readonly string[]; readonly unchecked: readonly string[] } = { checked: [], unchecked: [] },
  decides: readonly string[] = [],
): Promise<void> {
  const stored = ran.checked.length === 0 ? [] : z.array(z.object({ id: z.string(), taskId: z.string(), checkTaskId: z.string() })).parse(
    (await db.execute(sql`SELECT id, task_id AS "taskId", check_task_id AS "checkTaskId" FROM task_checks WHERE project_id = ${projectId} AND revision = 1 AND name = 'works'`)).rows,
  ).sort((a, b) => ran.checked.indexOf(a.taskId) - ran.checked.indexOf(b.taskId)).filter((check) => ran.checked.includes(check.taskId));
  const outcomes = stored.map((check) => ({ taskCheckId: check.id, taskId: check.taskId, name: "works", command: "sh checks/run.sh", outcome: "passed" }));
  const inserted = await db.execute(sql`
    INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details, check_outcomes, purpose)
    VALUES (${projectId}, ${MAIN}, 'v1', ${JSON.stringify(ran.checked)}::jsonb, ${JSON.stringify(ran.unchecked)}::jsonb, true, 'all suites passed',
            ${JSON.stringify(outcomes)}::jsonb, 'acceptance')
    RETURNING id`);
  const [sweep] = z.array(z.object({ id: z.string() })).parse(inserted.rows);
  if (sweep === undefined) throw new Error(`project ${projectId}: the sweep insert returned no row`);
  const inForce = await guaranteesInForce(db, projectId);
  if (inForce.kind === "version") {
    const undecided = new Set(
      z
        .array(z.object({ checkTaskId: z.string(), itemId: z.string() }))
        .parse((await db.execute(sql`SELECT check_task_id AS "checkTaskId", item_id AS "itemId" FROM undecided_items WHERE project_id = ${projectId} AND cleared_by_claim_id IS NULL`)).rows)
        .map((row) => JSON.stringify([row.checkTaskId, row.itemId])),
    );
    for (const { id } of inForce.guarantees) {
      const checks = decides.includes(id)
        ? stored.map((check) => ({ taskCheckId: check.id, outcome: "passed", class: "implementer-visible", lowered: undecided.has(JSON.stringify([check.checkTaskId, id])) }))
        : [];
      await db.execute(sql`
        INSERT INTO guarantee_evidence (project_id, sweep_id, vision_version, guarantee_id, main_commit, checks)
        VALUES (${projectId}, ${sweep.id}, ${inForce.version}, ${id}, ${MAIN}, ${JSON.stringify(checks)}::jsonb)`);
    }
  }
  await db.execute(sql`UPDATE projects SET lifecycle = 'accepted' WHERE id = ${projectId}`);
}

const run = promisify(execFile);
const workspaces: string[] = [];

/**
 * Quality's real acceptance sweep of `projectId`, whose workspace becomes a repository whose main
 * holds an environment, a public interface file and `product`. Its cells run each command on the
 * host checkout, and the one stored check of `store` ("works", as storeCheck writes it) passes there.
 */
async function realSweepDeps(
  projectId: ProjectId,
  store: string,
  checksOfStore: string,
  product: Readonly<Record<string, string>>,
): Promise<Parameters<typeof runAcceptanceSweeps>[0]> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `${NAME_PREFIX}-workspace-`)));
  workspaces.push(root);
  const target = join(root, "target");
  const files: Record<string, string> = {
    "environment/environment.toml":
      'containerfile = "environment/Containerfile"\nrecipe = []\ninputs = []\nprobe = "true"\nbuild = "true"\ntest = "echo tested"\n',
    "environment/Containerfile": "FROM scratch\n",
    "PUBLIC_INTERFACE.md": "kv put KEY VALUE; kv get KEY; kv delete KEY\n",
    ...product,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(target, path, ".."), { recursive: true });
    await writeFile(join(target, path), content);
  }
  const git = (...args: string[]) => run("git", ["-C", target, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args]);
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "delivered");
  await db.execute(sql`UPDATE projects SET workspace_path = ${target} WHERE id = ${projectId}`);
  const hostCell = (hostPath: string): Cell => ({
    id: "host-stand-in",
    spec: { image: "none", project: projectId, task: "acceptance", role: "ci", instance: "test", mount: { hostPath } },
    exec: async (argv) => {
      const [command, ...args] = argv;
      if (command === undefined) throw new TypeError("a cell was asked to run no command");
      const { stdout, stderr } = await run(command, args, { cwd: hostPath });
      return { exitCode: 0, stdout, stderr, timedOut: false, statusLost: false, stdoutCut: null, stderrCut: null };
    },
    teardown: async () => {},
  });
  const sweep: MainSweepDeps = {
    config: { workdirBase: join(root, "work") },
    cells: {
      substrate: { probeSubstrate: async () => ({ version: "5", rootless: true }), createCell: async (spec) => hostCell(spec.mount.hostPath) },
      instance: "test",
    },
    attemptPolicy: { perCommandTimeoutSeconds: 30 },
    environment: {
      images: {
        build: async (request) => ({
          ...(await environmentVersion(request.repoGitDir, request.commit, request.definition)),
          projectId: request.projectId,
          imageRef: "ashara/test",
          network: "none",
          imageId: "image-1",
          reused: true,
        }),
        prune: notExercised("an image prune"),
      },
      statements: { record: notExercised("a statement"), forVersion: async () => "a shell environment" },
    },
    checks: {
      completedOf: async () => ({
        checked: [{
          taskId: store,
          checkTaskId: checksOfStore,
          revision: 1,
          environmentVersion: "e".repeat(64),
          baselineCommit: null,
          checks: [{ name: "works", command: "echo works", decides: ["G1", "G2"] }],
          files: [],
        }],
        unchecked: [],
      }),
    },
    teardown: { teardownCell: async () => {} },
  };
  return { ...sweepDeps(true, "unused"), acceptanceSweeper: new AcceptanceSweeper(sweep) };
}

/** The project's lifecycle and the kind and error class of its open halt, null when none is open. */
async function haltOf(
  projectId: ProjectId,
): Promise<{ readonly lifecycle: string; readonly kind: string | null; readonly errorClass: string | null; readonly reason: string | null }> {
  const result = await db.execute(sql`
    SELECT p.lifecycle, b.kind, b.error_class AS "errorClass", b.reason AS "reason"
    FROM projects p LEFT JOIN project_blocks b ON b.project_id = p.id AND b.ended_at IS NULL WHERE p.id = ${projectId}`);
  const [row] = z
    .array(z.object({ lifecycle: z.string(), kind: z.string().nullable(), errorClass: z.string().nullable(), reason: z.string().nullable() }))
    .parse(result.rows);
  if (row === undefined) throw new Error(`project ${projectId} has no row`);
  return row;
}

async function statusOf(projectId: ProjectId): Promise<string> {
  const result = await db.execute(sql`SELECT ${projectState} AS status FROM projects WHERE id = ${projectId}`);
  return z.array(z.object({ status: z.string() })).parse(result.rows)[0]?.status ?? "(none)";
}

/** The failed attempts recorded for the project's passed sweep's report, and whether it is waiting out a backoff. */
async function reportAttempts(projectId: ProjectId): Promise<{ failures: number; interfaceReadFailures: number; lastError: string | null; waiting: boolean }> {
  const result = await db.execute(sql`
    SELECT COALESCE(a.failures, 0) AS failures, COALESCE(a.interface_read_failures, 0) AS "interfaceReadFailures", a.last_error AS "lastError",
      COALESCE(a.retry_at > now(), false) AS waiting
    FROM acceptance_sweeps s LEFT JOIN delivered_report_attempts a ON a.sweep_id = s.id
    WHERE s.project_id = ${projectId} AND s.passed`);
  const [row] = z
    .array(z.object({ failures: z.number(), interfaceReadFailures: z.number(), lastError: z.string().nullable(), waiting: z.boolean() }))
    .parse(result.rows);
  if (row === undefined) throw new Error(`project ${projectId} has no passed sweep`);
  return row;
}

/** Stands in for the backoff passing: the sweep's retry time is now. */
async function endBackoff(projectId: ProjectId): Promise<void> {
  await db.execute(sql`UPDATE delivered_report_attempts SET retry_at = now() WHERE project_id = ${projectId}`);
}

const verdictRow = z.object({ guaranteeId: z.string(), verdict: z.string(), reason: z.string().nullable(), basis: z.string(), evidenceClass: z.string() });

/** The verdicts stored beside the project's reports, oldest report first, by guarantee id. */
async function verdictsOf(projectId: ProjectId): Promise<Array<z.infer<typeof verdictRow>>> {
  const result = await db.execute(sql`
    SELECT guarantee_id AS "guaranteeId", verdict, reason, basis, evidence_class AS "evidenceClass"
    FROM guarantee_verdicts WHERE project_id = ${projectId} ORDER BY created_at, guarantee_id`);
  return z.array(verdictRow).parse(result.rows);
}

/** The id at the head of each line of the report's table paragraph. */
function tableIds(body: string): string[] {
  const table = body.split("\n\n").find((part) => part.startsWith("Each guarantee of your contract"));
  return (table ?? "").split("\n").flatMap((line) => {
    const id = /^- ([A-Z]\d+): /.exec(line)?.[1];
    return id === undefined ? [] : [id];
  });
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
  await db.execute(sql`DELETE FROM undecided_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM suite_review_claims WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM suite_review_judgements WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
  for (const dir of workspaces) await rm(dir, { recursive: true, force: true });
});

describe("acceptance on main", () => {
  test("a project accepted before every guarantee had to be judged posts one delivered report from the records", async () => {
    const { projectId, goals, scaffold } = await deliveredProject();
    // The readiness row names the scaffold with its recorded merge, which Quality's sweep compares main's interface file with.
    expect(await acceptanceStore().readyForAcceptance()).toEqual([
      { projectId, workspacePath: `/tmp/${NAME_PREFIX}`, goalTaskIds: goals, scaffoldMerges: [{ taskId: scaffold, mergeCommit: SCAFFOLD_MERGE }] },
    ]);

    await acceptedBeforeCoverage(projectId, { checked: goals, unchecked: [scaffold] });
    expect(await statusOf(projectId)).toBe("accepted");
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);

    interfaceReads.length = 0;
    expect(await deliveredReports().runPending()).toEqual([{ kind: "posted", projectId }]);
    expect(await deliveredReports().runPending()).toEqual([]);
    expect(interfaceReads).toEqual([`/tmp/${NAME_PREFIX}@${MAIN}`]);
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(1);
    const [body] = reports;
    // Presented as verified: only the commands the sweep recorded it ran and saw pass, by task.
    expect(body).toContain(
      `How the product was run in acceptance: each command below is a stored check that ran from the repository root of main at commit ${MAIN}, ` +
        `inside the project environment, and passed. These are the only ways of running the product Ashara verified.\n` +
        `- "Store keys", check "works":\n\`\`\`\nsh checks/run.sh\n\`\`\`\n- "Delete keys", check "works":\n\`\`\`\nsh checks/run.sh\n\`\`\`\n\n`,
    );
    expect(body).toContain(`Public interface (from PUBLIC_INTERFACE.md on main at commit ${MAIN}), quoted as the file reads. Acceptance ran none of what this file documents`);
    expect(body).toContain(`Ashara has not verified that it describes the delivered product. Where it differs from the commands acceptance ran, only those commands are verified.\n\`\`\`\n${INTERFACE_TEXT}\`\`\``);
    expect(body.split("\n\n")[0]).toContain(`the environment's test and the stored checks of 2 completed tasks passed together on main, commit ${MAIN}`);
    // The scaffold, checked only by the substrate, is done but listed apart from what passed.
    expect(body).toContain(`not checked by a stored check: none was written for them, so nothing in the run above confirms them:\n- "Set up the module root"`);
    expect(body).toContain(`"Store keys": built and merged, commit ${MERGE_A}.`);
    expect(body).toContain(`"Delete keys": already delivered when its turn came; nothing of its own was merged.`);
    expect(body).toContain(`the merge of "Store keys".`);
    // The guarantee table: every guarantee of the version in force once. A version written before
    // guarantees reads its scope lines and the assumptions a client could observe as guarantees that
    // name nothing that would refute them, so each is unjudged, and a review never makes one pass.
    expect(tableIds(body)).toEqual(["S1", "S2", "S3", "A1", "A3"]);
    for (const line of body.split("\n").filter((each) => each.includes(" | verdict: "))) {
      expect(line).toContain("| verdict: unjudged, as written it names nothing that would show it broken, so no check can decide it |");
    }
    expect(body).toContain("What is left out, so that silence is never read as a promise:\n- S4: Any network service");
    expect(body).toContain("which your acceptance does not depend on:\n- A2: The log file is kv.log");
    expect(body).not.toContain("second review");
    expect(await verdictsOf(projectId)).toEqual(
      ["A1", "A3", "S1", "S2", "S3"].map((guaranteeId) => ({
        guaranteeId,
        verdict: "unjudged",
        reason: "not-checkable-as-written",
        basis: guaranteeId === "A3" ? "assumed-unconfirmed" : guaranteeId === "A1" ? "client-stated" : "derived",
        evidenceClass: "none",
      })),
    );
  });

  test("a passing sweep that judges every guarantee pass makes the project accepted, stops its dispatch, and its report renders Quality's verdicts", async () => {
    const { projectId, goals } = await contractProject();
    const projects = new ProjectHaltRepository(db);
    expect(await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: goals, unchecked: [] }, [], ["G1", "G2"]))).toBe(1);
    expect(await statusOf(projectId)).toBe("accepted");
    expect(await projects.listActiveIds()).not.toContain(projectId);
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);

    expect(await deliveredReports().runPending()).toEqual([{ kind: "posted", projectId }]);
    const [body = ""] = await reportsOf(projectId);
    expect(tableIds(body)).toEqual(["G1", "G2"]);
    expect(body).toContain("The punch list is empty");
    expect(await verdictsOf(projectId)).toEqual([
      { guaranteeId: "G1", verdict: "pass", reason: null, basis: "client-stated", evidenceClass: "implementer-visible" },
      { guaranteeId: "G2", verdict: "pass", reason: null, basis: "client-stated", evidenceClass: "implementer-visible" },
    ]);
  });

  // A guarantee Ashara cannot verify with the checks it runs (stored data, while no fault set runs) is
  // marked so in the contract when it is written, outside coverage: the project is accepted on the
  // rest, and the report lists it as not verified, never as passed.
  test("a guarantee the contract marks not verifiable by Ashara is outside coverage and reported not verified", async () => {
    const { projectId, goals } = await contractProject("with-stored-data");
    expect(await guaranteesInForce(db, projectId)).toMatchObject({
      kind: "version",
      guarantees: [{ id: "G1", verification: "by-ashara" }, { id: "G2", verification: "by-ashara" }, { id: "G3", verification: "not-by-ashara" }],
    });
    expect(await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: goals, unchecked: [] }, [], ["G1", "G2", "G3"]))).toBe(1);
    expect(await statusOf(projectId)).toBe("accepted");

    expect(await deliveredReports().runPending()).toEqual([{ kind: "posted", projectId }]);
    const [body = ""] = await reportsOf(projectId);
    expect(tableIds(body)).toEqual(["G1", "G2", "G3"]);
    expect(body).toContain("- G3: A put survives a restart. | verdict: not verified, Ashara cannot verify it");
    expect(body).not.toMatch(/G3[^\n]*verdict: pass/);
    expect(await verdictsOf(projectId)).toEqual([
      { guaranteeId: "G1", verdict: "pass", reason: null, basis: "client-stated", evidenceClass: "implementer-visible" },
      { guaranteeId: "G2", verdict: "pass", reason: null, basis: "client-stated", evidenceClass: "implementer-visible" },
      { guaranteeId: "G3", verdict: "unjudged", reason: "not-verifiable-by-ashara", basis: "client-stated", evidenceClass: "implementer-visible" },
    ]);
  });

  // Acceptance is a passed sweep and every guarantee in force judged: a sweep whose every check passed
  // but on which a guarantee has no executed evidence accepts nothing, records no passed sweep, and
  // halts the project, still active, on its own kind (never as Ashara's fault), with the guarantee
  // and why named in its recorded cause.
  test("a sweep whose every check passed but leaves a guarantee with no executed evidence does not accept the project", async () => {
    const { projectId, goals } = await contractProject();
    expect(await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: goals, unchecked: [] }, [], ["G1"]))).toBe(0);
    const halt = await haltOf(projectId);
    expect(halt).toEqual({
      lifecycle: "active",
      kind: "acceptance_uncovered",
      errorClass: "AcceptanceSweepUncovered",
      reason: expect.stringContaining("G2 (unjudged, no-executed-evidence)"),
    });
        expect(halt.reason).not.toContain("G1 (");
    const passed = await db.execute(sql`SELECT count(*)::int AS n FROM acceptance_sweeps WHERE project_id = ${projectId} AND passed`);
    expect(z.array(z.object({ n: z.number() })).parse(passed.rows)[0]?.n).toBe(0);
    await expect(db.execute(sql`UPDATE projects SET lifecycle = 'accepted' WHERE id = ${projectId}`)).rejects.toThrow();
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);
  });

  // A contract recorded before guarantees carried the "not verifiable by Ashara" mark was never told
  // so, and fails closed: its guarantees read unmarked and stay in coverage, so a stored-data one halts
  // acceptance. The halt's report names each guarantee Ashara could not show to hold and why, and how
  // many Ashara can verify, so the client is not left with a bare "cannot be accepted".
  test("an acceptance_uncovered halt on a contract recorded before the mark names each guarantee Ashara could not verify and why", async () => {
    const { projectId, goals } = await contractProject("with-stored-data");
    await db.execute(sql`
      UPDATE vision_documents SET guarantees = (
        SELECT jsonb_agg(g - 'verification' - 'unverifiableBecause' ORDER BY i) FROM jsonb_array_elements(guarantees) WITH ORDINALITY AS t(g, i))
      WHERE project_id = ${projectId}`);
    expect(await guaranteesInForce(db, projectId)).toMatchObject({
      kind: "version",
      guarantees: [{ id: "G1", verification: "unmarked" }, { id: "G2", verification: "unmarked" }, { id: "G3", verification: "unmarked" }],
    });
    expect(await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: goals, unchecked: [] }, [], ["G1", "G2", "G3"]))).toBe(0);
    expect(await haltOf(projectId)).toMatchObject({ kind: "acceptance_uncovered", reason: expect.stringContaining("G3 (unjudged, stored-data-unjudged)") });

    // The halt's terminal sweep runs the same checks on main, as the core loop's terminal-sweep step records it before the report.
    const terminals = createTerminalSweepStore(db);
    const [due] = (await terminals.dueTerminalSweeps()).filter((each) => each.projectId === projectId);
    if (due === undefined) throw new Error(`project ${projectId} owes no terminal sweep`);
    const checkOutcomes = goals.map((taskId) => ({ taskId, revision: 1, checkTaskId: taskId, name: "works", command: "sh checks/run.sh", decides: ["G1", "G2", "G3"], outcome: "passed" as const }));
    expect(
      await terminals.recordTerminalSweep({ projectId, terminal: due.terminal, mainCommit: MAIN, environmentVersion: "v1", checkedTasks: goals, uncheckedTasks: [], checkOutcomes, details: "all suites passed" }),
    ).toBe("recorded");
    const store = createBlockReportStore(db);
    const ours: BlockReportStore = { ...store, dueReports: async () => (await store.dueReports()).filter((report) => report.projectId === projectId) };
    expect(await new BlockReports(ours, memoryStepContainment(() => true)).runPending()).toEqual([{ kind: "posted", projectId, subject: "project-blocked" }]);

    const [body = ""] = await reportsOf(projectId);
    expect(body).toContain(
      "The guarantees of your contract (vision v1) that Ashara could not show to hold, and why:\n" +
        "- G3 (A put survives a restart.): unjudged, it is seen only outside what the product's interface shows, and no check Ashara runs reads stored data directly or injects the faults that would show it; " +
        "Ashara cannot verify it as written, so only you can settle it, by restating it or removing it\n" +
        "Ashara can verify 2 of the 3 guarantees of this contract with the checks it can run today.",
    );
    expect(body).not.toMatch(/could not show to hold, and why:[^]*- G[12] \(/);
    // The cause and the next step agree with that list: no claim that the unshown guarantee is one Ashara
    // can verify, and the remedy for one it cannot verify as written is the client's restatement, not the team's look.
    expect(body).toContain("those checks do not show every guarantee of your contract to hold, so the project cannot be accepted");
    expect(body).not.toContain("a guarantee of your contract that Ashara can verify");
    expect(body).toContain("One Ashara cannot verify as written is settled only by you, with a change that restates it as something Ashara can check or removes it");
    expect(body).not.toContain("went unchecked");
  });

  // A guarantee stands on the evidence the sweep recorded: one a suite review left undecided reads
  // unjudged though its check passed, so the sweep does not cover the contract and accepts nothing.
  test("a guarantee a review left undecided is unjudged though its check passed on main, and the project is not accepted", async () => {
    /** A contract project whose check decides G1 and G2, with G2 left undecided by a suite review. */
    const reviewed = async () => {
      const project = await contractProject();
      const finding = JSON.stringify({ checkTasks: [project.checksOfStore], kind: "undecided-item", item: "G2", problem: "no check deletes a key", evidence: "sh checks/run.sh" });
      const judged = await db.execute(sql`
        INSERT INTO suite_review_judgements (project_id, review_task_id, check_task_id, check_name, outcome, basis, first_finding, second_findings, first_model, second_model, second_strength, passed_over, judge_tier, judged_tier, tier_relation, first_tier, second_tier)
        VALUES (${project.projectId}, ${project.checksOfStore}, ${project.checksOfStore}, NULL, 'advisory', 'second-opinion-disagreed', ${finding}::jsonb, '[]'::jsonb, 'p/m', 'p/m', 'same-model', '[]'::jsonb, 'Strong', 'Strong', 'equal', 'Strong', 'Strong')
        RETURNING id`);
      const [judgement] = z.array(z.object({ id: z.string() })).parse(judged.rows);
      await db.execute(sql`
        INSERT INTO undecided_items (project_id, review_task_id, check_task_id, item_id, item_text, judgement_id)
        VALUES (${project.projectId}, ${project.checksOfStore}, ${project.checksOfStore}, 'G2', 'A deleted key is gone.', ${judgement?.id})`);
      return project;
    };
    const swept = await reviewed();
    expect(await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: swept.goals, unchecked: [] }, [], ["G1", "G2"]))).toBe(0);
    expect(await haltOf(swept.projectId)).toEqual({
      lifecycle: "active",
      kind: "acceptance_uncovered",
      errorClass: "AcceptanceSweepUncovered",
      reason: expect.stringContaining("G2 (unjudged, lowered-by-review)"),
    });

    // The records of a project accepted before every guarantee had to be judged are still reported on, as Quality judges them.
    const { projectId, goals } = await reviewed();
    await acceptedBeforeCoverage(projectId, { checked: goals, unchecked: [] }, ["G1", "G2"]);
    expect(await deliveredReports().runPending()).toEqual([{ kind: "posted", projectId }]);
    const [body = ""] = await reportsOf(projectId);
    expect(tableIds(body)).toEqual(["G1", "G2"]);
    expect(body).toContain("- G1: A get returns the value of the last put of its key. | verdict: pass | basis: what your tender states | evidence: checked by a check its implementer could see");
    expect(body).toContain("- G2: A deleted key is gone. | verdict: unjudged, a review of the checks found they may not decide it |");
    expect(body).toContain("The punch list, what is not shown to hold, failures first:\n- G2: unjudged, a review of the checks found they may not decide it");
    expect(await verdictsOf(projectId)).toEqual([
      { guaranteeId: "G1", verdict: "pass", reason: null, basis: "client-stated", evidenceClass: "implementer-visible" },
      { guaranteeId: "G2", verdict: "unjudged", reason: "lowered-by-review", basis: "client-stated", evidenceClass: "implementer-visible" },
    ]);
  });

  test("a contract revision naming a guarantee its version does not hold posts the delivered report once, its table told as unreadable, never retried", async () => {
    const { projectId, goals } = await contractProject();
    await new VisionRepository(db).propose(projectId, 1, {
      author: "ashara",
      sourceMessageId: null,
      approver: null,
      direction: "narrows",
      cause: "ashara-decision",
      ops: [{ target: "guarantee", action: "amend", key: "G9", direction: "narrows", labelled: null, read: null, statement: "A key lives for ever." }],
      pushback: null,
    });
    expect(await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: goals, unchecked: [] }, [], ["G1", "G2"]))).toBe(1);

    const due = (await createDeliveredReportStore(db).dueReports()).find((row) => row.projectId === projectId);
    expect(due).toMatchObject({ kind: "due", guarantees: { kind: "unreadable" } });
    expect(await deliveredReports().runPending()).toEqual([{ kind: "posted", projectId }]);
    expect(await deliveredReports().runPending()).toEqual([]);
    const posted = await reportsOf(projectId);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatch(/Ashara's records of this project's guarantees at sweep [0-9a-f-]{36} do not hold together, so no guarantee is judged in this message/);
    expect(await verdictsOf(projectId)).toEqual([]);
  });

  // A goal task a plan revision replaced while it was open is set aside, never given up.
  test("the delivered report's given-up tasks are the goal tasks given up, never one a plan revision set aside", async () => {
    const { projectId, goals, scaffold } = await deliveredProject();
    await acceptedBeforeCoverage(projectId, { checked: goals, unchecked: [scaffold] });
    const abandoned = async (title: string, reason: unknown): Promise<void> => {
      await db.execute(sql`
        INSERT INTO work_items (id, level, status, title, task_spec, blocked_reason, project_id)
        VALUES (${randomUUID()}, 'Task', 'Abandoned', ${title}, ${JSON.stringify({ origin: "decomposition" })}::jsonb,
                ${JSON.stringify(reason)}::jsonb, ${projectId})`);
    };
    await abandoned("List keys", { source: "failure_given_up", reason: "exhausted 2 replan attempt(s) without success", attempts: 2 });
    await abandoned("Watch keys", { source: "superseded", planRevision: 2, requestedBy: null, repairOf: ["x"], reason: "replaced by the repaired plan" });
    const due = (await createDeliveredReportStore(db).dueReports()).find((row) => row.projectId === projectId);
    expect(due?.kind === "due" ? due.givenUp : due).toEqual(["List keys"]);
    expect(await deliveredReports().runPending()).toEqual([{ kind: "posted", projectId }]);
    const [body] = await reportsOf(projectId);
    expect(body).toContain(`These tasks were given up, and the plan was revised around them:\n- "List keys"`);
    expect(body).not.toContain("Watch keys");
  });

  // One definition of a goal task (isGoalTask): Quality's readiness and Engagement's given-up list
  // read it in SQL, and each must select the rows the in-memory definition names.
  test("acceptance readiness and the given-up list select the goal tasks isGoalTask names, never a task of another origin or level", async () => {
    const { projectId, goals, scaffold } = await deliveredProject();
    const insert = async (level: string, status: string, title: string, spec: unknown, reason: unknown = null): Promise<void> => {
      await db.execute(sql`
        INSERT INTO work_items (id, level, status, title, task_spec, blocked_reason, project_id)
        VALUES (${randomUUID()}, ${level}, ${status}, ${title}, ${JSON.stringify(spec)}::jsonb, ${reason === null ? null : JSON.stringify(reason)}::jsonb, ${projectId})`);
    };
    const rowsOf = async () =>
      z
        .array(z.object({ id: z.string(), level: z.string(), status: z.string(), title: z.string(), origin: z.string().nullable(), source: z.string().nullable() }))
        .parse((await db.execute(sql`
          SELECT id, level, status, title, task_spec->>'origin' AS origin, blocked_reason->>'source' AS source
          FROM work_items WHERE project_id = ${projectId} ORDER BY updated_at, id`)).rows);
    const ready = async () => (await acceptanceStore().readyForAcceptance()).some((row) => row.projectId === projectId);

    // No Completed goal task: the decomposed ones are re-recorded as another origin, beside an Epic
    // the decomposition wrote and a Task whose origin was never recorded.
    for (const goal of goals) await setSpec(goal, "origin", "review");
    await insert("Epic", "Completed", "The decomposed epic", { origin: "decomposition" });
    await insert("Task", "Completed", "A task planned before its origin was recorded", {});
    expect((await rowsOf()).filter((row) => row.status === "Completed" && isGoalTask(row))).toEqual([]);
    expect(await ready()).toBe(false);

    for (const goal of goals) await setSpec(goal, "origin", "decomposition");
    expect(await ready()).toBe(true);
    await acceptedBeforeCoverage(projectId, { checked: goals, unchecked: [scaffold] });

    const givenUp = { source: "failure_given_up", reason: "exhausted 2 replan attempt(s) without success", attempts: 2 };
    await insert("Task", "Abandoned", "List keys", { origin: "decomposition" }, givenUp);
    await insert("Task", "Abandoned", "Review again", { origin: "review" }, givenUp);
    await insert("Task", "Abandoned", "Change the environment", { origin: "environment-change" }, givenUp);
    await insert("Task", "Abandoned", "An old task", {}, givenUp);
    await insert("Epic", "Abandoned", "An abandoned epic", { origin: "decomposition" }, givenUp);
    const expected = (await rowsOf()).filter((row) => row.status === "Abandoned" && row.source !== "superseded" && isGoalTask(row)).map((row) => row.title);
    expect(expected).toEqual(["List keys"]);
    const due = (await createDeliveredReportStore(db).dueReports()).find((row) => row.projectId === projectId);
    expect(due?.kind === "due" ? due.givenUp : due).toEqual(expected);
  });

  test("a sweep recorded without what it ran states no way of running the product as verified, and one whose record does not parse is refused", async () => {
    const due = async (projectId: ProjectId) => (await createDeliveredReportStore(db).dueReports()).find((row) => row.projectId === projectId);
    const unrecorded = await deliveredProject();
    await acceptedBeforeCoverage(unrecorded.projectId, { checked: unrecorded.goals, unchecked: [unrecorded.scaffold] });
    await db.execute(sql`UPDATE acceptance_sweeps SET check_outcomes = NULL WHERE project_id = ${unrecorded.projectId}`);
    expect(await due(unrecorded.projectId)).toMatchObject({ kind: "due", executed: { kind: "unrecorded" } });

    const malformed = await deliveredProject();
    await acceptedBeforeCoverage(malformed.projectId, { checked: malformed.goals, unchecked: [malformed.scaffold] });
    await db.execute(sql`UPDATE acceptance_sweeps SET check_outcomes = '[{"taskId": "x"}]'::jsonb WHERE project_id = ${malformed.projectId}`);
    expect(await due(malformed.projectId)).toMatchObject({ kind: "unread", cause: "record", error: expect.objectContaining({ name: "SweepOutcomeUnreadable", column: "check_outcomes" }) });

    await deliveredReports().runPending();
    const [body] = await reportsOf(unrecorded.projectId);
    expect(body).toContain("Which commands acceptance ran is not on record for this delivery, so no way of running the product is stated as verified.");
    expect(body).not.toContain("How the product was run in acceptance");
  });

  // Evidence that misses a guarantee is a record that does not hold together: that report alone tells its table as unreadable.
  test("a sweep whose evidence misses a guarantee posts its report with the table told as unreadable, never read as no evidence", async () => {
    const due = async (projectId: ProjectId) => (await createDeliveredReportStore(db).dueReports()).find((row) => row.projectId === projectId);
    const accepted = async (): Promise<Delivered> => {
      const delivered = await deliveredProject();
      await acceptedBeforeCoverage(delivered.projectId, { checked: delivered.goals, unchecked: [delivered.scaffold] });
      return delivered;
    };
    const whole = await accepted();
    const torn = await accepted();
    await db.execute(sql`DELETE FROM guarantee_evidence WHERE project_id = ${torn.projectId} AND guarantee_id = 'S3'`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await due(torn.projectId)).toMatchObject({ kind: "due", guarantees: { kind: "unreadable" } });
      expect(warn.mock.calls.flat().join("\n")).toMatch(/records evidence for some guarantees of vision v1 but none for S3/);
    } finally {
      warn.mockRestore();
    }
    expect(await due(whole.projectId)).toMatchObject({ kind: "due", guarantees: { kind: "table" } });
    expect(new Map((await deliveredReports().runPending()).map((outcome) => [outcome.projectId, outcome.kind]))).toEqual(
      new Map([
        [whole.projectId, "posted"],
        [torn.projectId, "posted"],
      ]),
    );
    const [tornBody = ""] = await reportsOf(torn.projectId);
    expect(tornBody).toMatch(/Ashara's records of this project's guarantees at sweep [0-9a-f-]{36} do not hold together, so no guarantee is judged in this message/);
    expect(await verdictsOf(torn.projectId)).toEqual([]);
  });

  test("only an unreachable database is retried uncounted: an error nothing names counts toward the notice sent in the report's place", async () => {
    const { projectId, goals, scaffold } = await deliveredProject();
    await acceptedBeforeCoverage(projectId, { checked: goals, unchecked: [scaffold] });
    const unreachable = createDb(Object.assign(new URL(DATABASE_URL), { port: "1" }).toString());
    try {
      const listedThenFailing = (failing: Database): Database => {
        let listed = false;
        return new Proxy(db, {
          get(target, prop) {
            const source = listed ? failing : target;
            if (prop === "select") listed = true;
            const value: unknown = Reflect.get(source, prop);
            return typeof value === "function" ? value.bind(source) : value;
          },
        });
      };
      const unnamed = new Proxy(db, {
        get(target, prop) {
          if (prop === "select" || prop === "execute") return () => { throw new TypeError("cannot read properties of undefined (reading 'rows')"); };
          const value: unknown = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const ours = async (handle: Database) => (await createDeliveredReportStore(handle).dueReports()).find((due) => due.projectId === projectId);
      const recordFailures = async () =>
        z.array(z.object({ n: z.number() })).parse((await db.execute(sql`SELECT COALESCE(a.record_failures, 0) AS n FROM acceptance_sweeps s LEFT JOIN delivered_report_attempts a ON a.sweep_id = s.id WHERE s.project_id = ${projectId} AND s.passed`)).rows)[0]?.n;

      expect(await ours(listedThenFailing(unreachable))).toMatchObject({ kind: "unread", cause: "connection" });
      expect(await ours(listedThenFailing(unnamed))).toMatchObject({ kind: "unread", cause: "record", error: expect.objectContaining({ name: "TypeError" }) });

      const reports = (handle: Database) => {
        const store = createDeliveredReportStore(handle);
        return new DeliveredReports(
          { ...store, recordReportFailure: createDeliveredReportStore(db).recordReportFailure, dueReports: async () => (await store.dueReports()).filter((due) => due.projectId === projectId) },
          { file: "PUBLIC_INTERFACE.md", at: async () => ({ kind: "absent" }) },
        );
      };
      expect(await reports(listedThenFailing(unreachable)).runPending()).toEqual([expect.objectContaining({ kind: "failed", projectId })]);
      expect(await recordFailures()).toBe(0);
      await endBackoff(projectId);
      expect(await reports(listedThenFailing(unnamed)).runPending()).toEqual([expect.objectContaining({ kind: "failed", projectId })]);
      expect(await recordFailures()).toBe(1);
    } finally {
      await unreachable.$client.end();
    }
  });

  // A confirming answer read after the plan was made asks for no replan, so the
  // review's copy of the vision can still say the item was asked about when the project is accepted.
  test("an answer confirming an assumption after the plan was made is reported as confirmed, and an unreadable standing posts the table as unreadable", async () => {
    const { projectId, goals, scaffold, question } = await deliveredProject({ prefixAsked: true });
    if (question === null) throw new Error("the fixture posted no question");
    const answerId = (await new ClientMessageRepository(db).insertInbound({ projectId, kind: "answer", body: "Yes, every key.", inReplyTo: question })).id;
    expect(await clientAnswers().runPending()).toEqual([
      { kind: "stated", answerId, projectId, assumptionKey: "A3", verdict: "confirms", visionVersion: 2, replanRequested: false },
    ]);
    await acceptedBeforeCoverage(projectId, { checked: goals, unchecked: [scaffold] });

    expect(await deliveredReports().runPending()).toContainEqual({ kind: "posted", projectId });
    const [body] = await reportsOf(projectId);
    expect(body).toContain("- A3: An empty prefix lists every key (stated by you)\n");
    expect(body).not.toContain("not confirmed by you");

    // The standing is read from the vision at acceptance: one it cannot read judges nothing, never the review's copy.
    const torn = await deliveredProject({ prefixAsked: true });
    if (torn.question === null) throw new Error("the fixture posted no question");
    const tornAnswer = (await new ClientMessageRepository(db).insertInbound({ projectId: torn.projectId, kind: "answer", body: "Yes, every key.", inReplyTo: torn.question })).id;
    expect(await clientAnswers().runPending()).toEqual([
      { kind: "stated", answerId: tornAnswer, projectId: torn.projectId, assumptionKey: "A3", verdict: "confirms", visionVersion: 2, replanRequested: false },
    ]);
    await acceptedBeforeCoverage(torn.projectId, { checked: torn.goals, unchecked: [torn.scaffold] });
    await db.execute(sql`UPDATE vision_documents SET inferences = inferences #- '{2,clientAnswer}' WHERE project_id = ${torn.projectId} AND version = 2`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await deliveredReports().runPending()).toEqual([{ kind: "posted", projectId: torn.projectId }]);
      expect(warn.mock.calls.flat().join("\n")).toMatch(/a Stated assumption carries the client answer that stated it/);
    } finally {
      warn.mockRestore();
    }
    const [tornBody = ""] = await reportsOf(torn.projectId);
    expect(tornBody).toMatch(/Ashara's records of this project's guarantees at sweep [0-9a-f-]{36} do not hold together, so no guarantee is judged in this message/);
    expect(tornBody).not.toContain("stated by you");
  });

  test("one project's report failing (no workspace on record, git unable to read main) never stops another's: each failure is recorded and retried", async () => {
    const accepted = async (): Promise<ProjectId> => {
      const { projectId, goals, scaffold } = await deliveredProject();
      await acceptedBeforeCoverage(projectId, { checked: goals, unchecked: [scaffold] });
      return projectId;
    };
    const healthy = await accepted();
    const noWorkspace = await accepted();
    const unreadable = await accepted();
    await db.execute(sql`UPDATE projects SET workspace_path = NULL WHERE id = ${noWorkspace}`);
    await db.execute(sql`UPDATE projects SET workspace_path = ${BROKEN_WORKSPACE} WHERE id = ${unreadable}`);

    const outcomes = await deliveredReports().runPending();
    expect(new Map(outcomes.map((outcome) => [outcome.projectId, outcome.kind]))).toEqual(
      new Map([
        [healthy, "posted"],
        [noWorkspace, "failed"],
        [unreadable, "failed"],
      ]),
    );
    expect(await reportsOf(healthy)).toHaveLength(1);
    expect(await reportAttempts(noWorkspace)).toEqual({ failures: 1, interfaceReadFailures: 0, lastError: expect.stringMatching(/records no workspace_path/), waiting: true });
    expect(await reportAttempts(unreadable)).toEqual({ failures: 1, interfaceReadFailures: 1, lastError: expect.stringMatching(/not a git repository/), waiting: true });
    expect(await deliveredReports().runPending()).toEqual([]);

    // Past its bound of reads, the report is posted saying the file could not be read; the record keeps
    // why. The posting attempt is no failed attempt. Past its bound of unread attempts, the project
    // whose records cannot be read is sent an acceptance notice saying so.
    for (const attempt of [2, 3, 4, 5]) {
      await endBackoff(unreadable);
      await endBackoff(noWorkspace);
      const kinds = new Map((await deliveredReports().runPending()).map((outcome) => [outcome.projectId, outcome.kind]));
      expect(kinds.get(unreadable)).toBe(attempt === 2 ? "failed" : attempt === 3 ? "posted" : undefined);
      expect(kinds.get(noWorkspace)).toBe(attempt === 5 ? "posted" : "failed");
      if (attempt === 4) expect((await reportAttempts(noWorkspace)).failures).toBe(4);
    }
    const [body] = await reportsOf(unreadable);
    expect(body).toContain(`PUBLIC_INTERFACE.md on main at commit ${MAIN} could not be read in 3 attempts.`);
    expect(body).not.toContain("not a git repository");
    expect(await reportAttempts(unreadable)).toMatchObject({ failures: 2, interfaceReadFailures: 3, lastError: expect.stringMatching(/not a git repository/) });
    const [notice] = await reportsOf(noWorkspace);
    expect(notice).toContain("Your project is accepted: its acceptance sweep passed on main.");
    expect(notice).toContain("could not be written from Ashara's records in 5 attempts.");
    expect(notice).not.toContain("workspace_path");
    expect(await reportAttempts(noWorkspace)).toMatchObject({ failures: 4, interfaceReadFailures: 0, lastError: expect.stringMatching(/records no workspace_path/) });
  });

  // The notice sent in the report's place is the project's terminal message: it carries the sweep's
  // guarantee table, read on its own, and stores its verdicts beside it.
  test("the acceptance notice sent in place of an unreadable report carries the sweep's guarantee table and stores its verdicts", async () => {
    const { projectId, goals } = await contractProject();
    expect(await runAcceptanceSweeps(sweepDeps(true, "all suites passed", { checked: goals, unchecked: [] }, [], ["G1", "G2"]))).toBe(1);
    await db.execute(sql`UPDATE projects SET workspace_path = NULL WHERE id = ${projectId}`);
    for (const attempt of [1, 2, 3, 4, 5]) {
      await endBackoff(projectId);
      expect(await deliveredReports().runPending()).toContainEqual(expect.objectContaining({ kind: attempt === 5 ? "posted" : "failed", projectId }));
    }
    const [notice = ""] = await reportsOf(projectId);
    expect(notice).toContain("Your project is accepted: its acceptance sweep passed on main.");
    expect(notice).toContain("could not be written from Ashara's records in 5 attempts.");
    expect(tableIds(notice)).toEqual(["G1", "G2"]);
    expect(notice).toContain("- G1: A get returns the value of the last put of its key. | verdict: pass |");
    expect(notice).toContain("The punch list is empty");
    expect(await verdictsOf(projectId)).toEqual([
      { guaranteeId: "G1", verdict: "pass", reason: null, basis: "client-stated", evidenceClass: "implementer-visible" },
      { guaranteeId: "G2", verdict: "pass", reason: null, basis: "client-stated", evidenceClass: "implementer-visible" },
    ]);
  });

  test("only a passed sweep makes a project accepted, and only the client's stop ends it, with the merges named", async () => {
    const { projectId } = await deliveredProject();
    await expect(db.execute(sql`UPDATE projects SET lifecycle = 'accepted' WHERE id = ${projectId}`)).rejects.toThrow();
    await acceptedBeforeCoverage(projectId);
    await expect(db.execute(sql`UPDATE projects SET lifecycle = 'active' WHERE id = ${projectId}`)).rejects.toThrow();
    expect(await statusOf(projectId)).toBe("accepted");

    const stop = await new ClientMessageRepository(db).insertInbound({ projectId, kind: "stop", body: "Thanks, done.", inReplyTo: null });
    const store = createClientStopStore(db);
    const ours: typeof store = {
      ...store,
      openStops: async () => (await store.openStops()).filter((open) => open.projectId === projectId),
      dueStopReports: async () => (await store.dueStopReports()).filter((due) => due.projectId === projectId),
    };
    const stops = new ClientStops(ours, memoryStepContainment(() => true));
    expect(await stops.runPending()).toEqual([expect.objectContaining({ kind: "stopped", reportDue: true })]);
    expect(await statusOf(projectId)).toBe("stopped");
    // The stop's report is posted after the cycle's terminal sweep, and carries that sweep's table.
    expect(await stops.runPending()).toEqual([]);
    expect(
      await createTerminalSweepStore(db).recordTerminalSweep({
        projectId,
        terminal: { kind: "stop", stopId: stop.id },
        mainCommit: MAIN,
        environmentVersion: "v1",
        checkedTasks: [],
        uncheckedTasks: [],
        checkOutcomes: [],
        details: "no stored check to run",
      }),
    ).toBe("recorded");
    expect(await stops.reportPending()).toEqual([{ kind: "posted", stopId: stop.id, projectId }]);
    expect(await stops.reportPending()).toEqual([]);
    const stopReport = (await reportsOf(projectId)).find((body) => body.includes("stopped at your request"));
    expect(tableIds(stopReport ?? "")).toEqual(["S1", "S2", "S3", "A1", "A3"]);
    expect(stopReport).toContain(`- "Set up the module root": merged, commit ${SCAFFOLD_MERGE}`);
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
    expect(await new ProjectHaltRepository(db).listActiveIds()).not.toContain(projectId);
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);
    expect(await deliveredReports().runPending()).toEqual([]);
  });

  test("Quality's sweep of a main that still holds the scaffold placeholder's marker fails, and the defect names its file:line for repair", async () => {
    const { projectId, goals, checksOfStore } = await contractProject();
    const [store = ""] = goals;
    const deps = await realSweepDeps(projectId, store, checksOfStore, {
      "public/index.php": `<?php\nif (ctype_digit($key)) { get($key); }\nhttp_response_code(501); echo '{"error":"${SCAFFOLD_PLACEHOLDER_MARKER}"}';\n`,
    });

    expect(await runAcceptanceSweeps(deps)).toBe(0);

    expect(await statusOf(projectId)).toBe("active");
    const defects = z.array(z.object({ status: z.string(), source: z.string(), reason: z.string(), origin: z.string(), passed: z.boolean() })).parse((await db.execute(sql`
      SELECT w.status, w.blocked_reason->>'source' AS source, w.blocked_reason->>'reason' AS reason, w.task_spec->>'origin' AS origin, s.passed
      FROM acceptance_sweeps s JOIN work_items w ON w.id = s.defect_item_id JOIN plan_repairs r ON r.work_item_id = w.id
      WHERE s.project_id = ${projectId}`)).rows);
    expect(defects).toEqual([{ status: "Abandoned", source: "acceptance_failed", reason: expect.any(String), origin: "acceptance", passed: false }]);
    expect(defects[0]?.reason.split("\n")[0]).toContain("still on main at public/index.php:3");
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);
  });

  test("Quality's sweep of the same main with the marker gone accepts the project", async () => {
    const { projectId, goals, checksOfStore } = await contractProject();
    const [store = ""] = goals;
    const deps = await realSweepDeps(projectId, store, checksOfStore, { "public/index.php": "<?php\nget($key);\n" });

    expect(await runAcceptanceSweeps(deps)).toBe(1);

    expect(await statusOf(projectId)).toBe("accepted");
  });

  test("a failing sweep contradicts the pass of the claim covering the failed check's check task, beside the sweep, in its transaction", async () => {
    const { projectId, store, checksOfStore } = await deliveredProject();
    const claimId = randomUUID();
    await db.execute(sql`
      INSERT INTO suite_review_claims (id, project_id, review_task_id, basis, covered, first_model, second_model, second_strength, passed_over, second_findings, judge_tier, judged_tier, tier_relation, first_tier, second_tier)
      SELECT ${claimId}, ${projectId}, w.id, 'second-opinion-clean', ${JSON.stringify([checksOfStore])}::jsonb, 'first/judge-a', 'second/judge-b', 'other-family', '[]'::jsonb, '[]'::jsonb, 'Frontier', 'Strong', 'above', 'Frontier', 'Frontier'
      FROM work_items w WHERE w.project_id = ${projectId} AND w.task_spec->>'origin' = 'review'`);

    expect(await runAcceptanceSweeps(sweepDeps(false, `1 failure(s) on main:\n- task ${store}'s checks: check "works" exited 1`, undefined, [{ taskId: store, checkTaskId: checksOfStore, name: "works" }]))).toBe(0);

    const outcomes = await db.execute(sql`
      SELECT o.verdict_id AS "verdictId", o.reviewer_role AS role, o.outcome, o.evidence_kind AS "evidenceKind", o.evidence_ref = s.id::text AS "ofTheSweep"
      FROM reviewer_outcomes o JOIN acceptance_sweeps s ON s.project_id = o.project_id AND NOT s.passed
      WHERE o.project_id = ${projectId} ORDER BY o.reviewer_role`);
    expect(outcomes.rows).toEqual([
      { verdictId: claimId, role: "first", outcome: "pass-contradicted", evidenceKind: "acceptance-failed", ofTheSweep: true },
      { verdictId: claimId, role: "second", outcome: "pass-contradicted", evidenceKind: "acceptance-failed", ofTheSweep: true },
    ]);
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
      SELECT coalesce((SELECT f.faults FROM acceptance_sweep_faults f WHERE f.project_id = p.id), 0) AS faults, s.main_commit AS "mainCommit", w.blocked_reason->>'reason' AS reason
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
      SELECT coalesce((SELECT f.faults FROM acceptance_sweep_faults f WHERE f.project_id = p.id), 0) AS faults, b.kind AS category, b.error_class AS "errorClass"
      FROM projects p JOIN project_blocks b ON b.project_id = p.id WHERE p.id = ${projectId} ORDER BY b.blocked_at DESC LIMIT 1`);
    expect(block.rows).toEqual([{ faults: 4, category: "fault", errorClass: "AcceptanceFaultBudgetSpent" }]);
    expect(await projects.listActiveIds()).not.toContain(projectId);
    expect(await acceptanceStore().readyForAcceptance()).toEqual([]);
  });

  test("a Completed scaffold with no recorded merge halts the project once, as a fault, before any sweep", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { projectId, scaffold } = await deliveredProject({ scaffoldMerged: false });
    let swept = 0;
    const deps = {
      ...sweepDeps(true, "unused"),
      acceptanceSweeper: {
        sweepForAcceptance: async () => {
          swept++;
          throw new Error("a project with an unrecorded scaffold merge is never swept");
        },
      },
    };
    for (let round = 0; round < 3; round++) expect(await runAcceptanceSweeps(deps)).toBe(0);
    expect(swept).toBe(0);
    expect(await statusOf(projectId)).toBe("blocked");
    const blocks = await db.execute(sql`
      SELECT coalesce((SELECT f.faults FROM acceptance_sweep_faults f WHERE f.project_id = p.id), 0) AS faults, b.kind AS category, b.error_class AS "errorClass", b.reason
      FROM projects p JOIN project_blocks b ON b.project_id = p.id WHERE p.id = ${projectId}`);
    expect(blocks.rows).toEqual([{ faults: 0, category: "fault", errorClass: "ScaffoldMergeUnrecorded", reason: expect.stringContaining(scaffold) }]);
  });
});
