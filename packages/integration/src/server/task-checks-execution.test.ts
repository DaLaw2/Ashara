import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClientRepository, createDb, ProjectRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { EnvironmentBuildRepository } from "@ashara/execution-infra";
import { LlmCallRepository } from "@ashara/finance";
import { CheckDisputeRepository, SCAFFOLD_PLACEHOLDER_MARKER, TaskCheckRepository } from "@ashara/quality";
import { DispatchService, FailureRouter } from "@ashara/delivery";
import type { TaskDescriptor } from "@ashara/delivery";
import { PodmanSubstrate, buildEnvironmentImage, loadBaseCell, pruneEnvironmentImages } from "@ashara/execution-infra";
import type { BaseCellReference } from "@ashara/execution-infra";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { createWorkItemId, systemClock } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import type { WorkKind } from "@ashara/organization";
import { HELD_SET_RULE, heldSetRuleText, unheldReason } from "@ashara/workplace";
import { createTaskCheckStore } from "@ashara/server/task-check-store";
import { composeDispatchService } from "@ashara/server/compose-core-loop";
import { testCellInstance } from "../test-cells.js";

// Independent verification end to end on real podman, real git, the
// real recorded gateway and the real task_checks table, with a scripted model: no real LLM call and
// no skip. A check task's checks are red-run on the plan's foundation (the product scaffold's merge
// here, which the environment builds) and stored; an implementation task is swept for delivery on main, then
// decided by them on its tentative merge.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => stub.model }));

const run = promisify(execFile);
const DATABASE_URL = resolveTestDatabaseUrl(process.env);
// Caps far above anything a stubbed call can cost: these tests are about the checks, not the cap.
const TEST_SPEND_CAPS = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };

const modelConfig: ModelConfig = {
  id: "mock-model",
  apiModelId: "mock-model-api",
  provider: "anthropic",
  capabilityLevel: "Strong", thinkingOffCapabilityLevel: "Strong",
  inputCostPer1M: 3,
  outputCostPer1M: 15,
  maxContextTokens: 100_000,
  cacheReadCostPer1M: 0.3,
  cacheWriteCostPer1M: 3.75,
  priceWindows: [], priceTiers: [], datedPrices: [],
};

function toolCallTurn(toolName: string, input: unknown) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: `tc-${randomUUID()}`, toolName, input: JSON.stringify(input) }],
    usage: {
      inputTokens: { total: 1000, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: 50, reasoning: undefined },
      raw: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
    warnings: [],
  };
}

type Db = ReturnType<typeof createDb>;
let db: Db;
let clientId = "";
let projectId: ProjectId;
let root = "";
let workdirBase = "";
let target = "";
let base: BaseCellReference;
let substrate: PodmanSubstrate;

const HELLO_CHECK = "grep hello hello.txt || exit 99\n";

/** The product scaffold on record whose merge is the plan's foundation, and that merge commit. */
let foundationTaskId: WorkItemId;
let foundation = "";

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: target });
  return stdout.trim();
}

interface CitedScope {
  readonly type: "scope";
  readonly id: string;
  readonly text: string;
  readonly side: "in";
}

/** The vision item every planned pair cites unless a test names more: its checks must decide each one. */
const CITED: CitedScope = { type: "scope", id: "S1", text: "The product writes the files its users ask for.", side: "in" };

/** An implementation task and its check task on record, as a first plan writes them after Sprint 0. */
async function plannedPair(
  title: string,
  cited: readonly CitedScope[] = [CITED],
): Promise<{ readonly implementation: TaskDescriptor; readonly check: TaskDescriptor }> {
  const implementationId = createWorkItemId();
  const checkId = createWorkItemId();
  const checkTitle = `Write the checks for "${title}"`;
  const checkSpec = {
    goal: checkTitle,
    endState: "every check is defined",
    scope: `the checks of "${title}"`,
    deliverables: [] as string[],
    origin: "check" as const,
    checksFor: implementationId,
    visionItems: cited.map((item) => item.text),
    sources: cited.map((item) => ({ ...item })),
  };
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, task_spec)
    VALUES (${implementationId}, 'Task', 'Pending', ${title}, ${projectId}, 'implementation', ${randomUUID()}, NULL),
           (${checkId}, 'Task', 'InProgress', ${checkTitle}, ${projectId}, 'check', ${randomUUID()},
            ${JSON.stringify(checkSpec)}::jsonb)`);
  await db.execute(sql`INSERT INTO dependencies (from_id, to_id) VALUES (${implementationId}, ${checkId}), (${checkId}, ${foundationTaskId})`);
  const descriptor = (id: WorkItemId, taskTitle: string, workKind: WorkKind, taskSpec?: TaskDescriptor["taskSpec"]): TaskDescriptor => ({
    id,
    projectId,
    title: taskTitle,
    taskSpec,
    epicId: null,
    dispatchCount: 0,
    attempt: 1,
    workKind,
    successCriteria: [],
    overflowedWindowTokens: null,
  });
  return {
    implementation: descriptor(implementationId, title, "implementation", { goal: title, endState: `${title} is done`, scope: title, deliverables: [] }),
    check: descriptor(checkId, checkTitle, "check", checkSpec),
  };
}

interface TaskRun {
  readonly result: Awaited<ReturnType<DispatchService["execute"]>>;
  readonly mock: MockLanguageModelV4;
  readonly events: ReadonlyArray<Record<string, unknown> & { readonly event: string }>;
}

async function runTask(task: TaskDescriptor, script: Array<ReturnType<typeof toolCallTurn>>): Promise<TaskRun> {
  const mock = new MockLanguageModelV4({
    doGenerate: async () => {
      const next = script.shift();
      if (next === undefined) throw new Error("the mock model's script is exhausted");
      return next;
    },
  });
  stub.model = mock;
  const gateway = new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [
        { name: "anthropic", providerType: "anthropic", apiKey: "test-key", baseUrl: "https://stub.invalid/v1", models: [modelConfig], enabled: true },
      ],
      defaultProvider: "anthropic",
      contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(
    new LlmCallRepository(db),
    new SpendCap({ ledger: new LlmCallRepository(db), caps: TEST_SPEND_CAPS }),
  ), recordingLogger());
  const builds = new EnvironmentBuildRepository(db);
  const events: Array<Record<string, unknown> & { readonly event: string }> = [];
  const service = composeDispatchService({
    logger: recordingLogger(),
    config: { workdirBase },
    sessionStore: { insert: async () => {}, complete: async () => {}, fail: async () => {} },
    knowledgeSink: { storeFinding: async () => {} },
    eventSink: { emit: (event) => void events.push(event) },
    intentSource: { loadIntent: async () => ({ version: 1, visionText: "A greeting page", assumptions: [], interfaceEntries: [] }) },
    cells: { substrate, baseCell: base, instance: testCellInstance(), shutdownSignal: new AbortController().signal },
    llm: gateway,
    staffing: {
      widerModel: () => null,
      staff: async (staffed) => ({
        kind: "staffed",
        staff: {
          role: staffed.workKind === "check" ? { id: "check-author", name: "Check Author" } : { id: "developer", name: "Developer" },
          model: gateway.resolveModel("Strong", "agent-runner"),
        },
      }),
    },
    attemptPolicy: { maxTurns: 6, perCommandTimeoutSeconds: 60, toolTimeoutSeconds: 30 },
    environment: {
      images: {
        build: (request) => buildEnvironmentImage(request, { substrate, recorder: builds, timeoutMs: 120_000 }),
        prune: (projectId, keepVersion) => pruneEnvironmentImages(substrate, projectId, keepVersion),
      },
      statements: {
        record: async () => {
          throw new Error("no environment statement is recorded here");
        },
        forVersion: async () => "A plain Debian shell environment: the project is text files.",
      },
    },
    checks: createTaskCheckStore(db),
    suiteReview: { review: async () => { throw new Error("no suite review runs in this test"); } },
    shutdownSignal: new AbortController().signal,
    clock: systemClock,
  });
  const result = await service.execute(task, target);
  const { stdout } = await run("podman", ["ps", "-a", "-q", "--filter", `label=ashara.task=${task.id}`]);
  expect(stdout.trim(), "every cell of the task is gone").toBe("");
  return { result, mock, events };
}

const CheckRowSchema = z.object({
  revision: z.number(),
  name: z.string(),
  command: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  environmentVersion: z.string(),
  baselineCommit: z.string().nullable(),
  checkTaskId: z.string(),
  decides: z.array(z.string()).nullable(),
});

async function checkRowsOf(taskId: WorkItemId) {
  const result = await db.execute(sql`
    SELECT revision, name, command, files, environment_version AS "environmentVersion", baseline_commit AS "baselineCommit",
           check_task_id AS "checkTaskId", decides
    FROM task_checks WHERE task_id = ${taskId} ORDER BY revision, name`);
  return z.array(CheckRowSchema).parse(result.rows);
}

function toolNames(mock: MockLanguageModelV4): string[] {
  return mock.doGenerateCalls[0]?.tools?.map((tool) => tool.name) ?? [];
}

function promptText(mock: MockLanguageModelV4): string {
  return JSON.stringify(mock.doGenerateCalls[0]?.prompt ?? null);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`task-checks-${randomUUID()}`)).id;
  projectId = (await new ProjectRepository(db).create(`task-checks-${randomUUID().slice(0, 8)}`, clientId)).id;
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-task-checks-")));
  workdirBase = join(root, "work");
  target = join(workdirBase, "projects", "p");
  await mkdir(join(target, "environment"), { recursive: true });
  base = await loadBaseCell();
  // The environment a merged Sprint 0 leaves on main: the BaseCell image, unchanged.
  await writeFile(
    join(target, "environment", "environment.toml"),
    'containerfile = "environment/Containerfile"\nrecipe = []\ninputs = []\nprobe = "echo toolchain ok"\nbuild = "true"\n' +
      'test = "test ! -e BROKEN && echo environment ok"\n',
  );
  await writeFile(join(target, "environment", "Containerfile"), `FROM ${base.image}\n`);
  await run("git", ["init", "-q", "-b", "main"], { cwd: target });
  await git("add", "environment");
  await git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "environment");
  foundation = await git("rev-parse", "main");
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, task_spec, merge_commit)
    VALUES (${createWorkItemId()}, 'Task', 'Completed', 'Set up the project environment', ${projectId},
            'environment', ${randomUUID()}, ${JSON.stringify({ goal: "Set up the project environment", origin: "sprint0", checkedBy: "substrate" })}::jsonb,
            ${foundation})`);
  // The product's layout here is the environment's own tree, whose build ("true") passes.
  foundationTaskId = createWorkItemId();
  await db.execute(sql`
    INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, task_spec, merge_commit)
    VALUES (${foundationTaskId}, 'Task', 'Completed', 'Set up the product''s layout', ${projectId},
            'implementation', ${randomUUID()}, ${JSON.stringify({ goal: "Set up the product's layout", origin: "product-scaffold", checkedBy: "substrate" })}::jsonb,
            ${foundation})`);
  substrate = new PodmanSubstrate({ logger: recordingLogger(), podmanPath: "podman", mountRoot: workdirBase });
});

afterAll(async () => {
  await substrate.teardownAll();
  const { stdout } = await run("podman", ["images", "-q", "--filter", `label=ashara.project=${projectId}`]);
  const images = [...new Set(stdout.split("\n").filter((id) => id !== ""))];
  if (images.length > 0) await run("podman", ["rmi", "-f", ...images]);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM check_disputes WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM environment_builds WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id = ${projectId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
});

/** "Write hello.txt" and its check task: stored and merged by the first describe, a regression set for the second. */
let hello: { readonly implementation: TaskDescriptor; readonly check: TaskDescriptor };

describe("independent verification", () => {

  it("a check task's check that fails on the foundation is stored with it as baseline; nothing of the check task reaches main", async () => {
    hello = await plannedPair("Write hello.txt");
    const mainBefore = await git("rev-parse", "main");
    const helloSh = `checks/${hello.implementation.id}/hello.sh`;

    // The author also writes the product beside its checks; it is discarded, so the
    // red run still fails on the foundation and the stored set holds the check file only.
    const { result, mock, events } = await runTask(hello.check, [
      toolCallTurn("write_file", { path: helloSh, content: HELLO_CHECK }),
      toolCallTurn("write_file", { path: "hello.txt", content: "hello\n" }),
      toolCallTurn("define_check", { name: "says hello", command: `sh ${helloSh}`, decides: ["S1"] }),
      toolCallTurn("finish", { status: "done", summary: "One check: hello.txt says hello." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    expect(toolNames(mock)).toContain("define_check");
    expect(toolNames(mock)).not.toContain("build_environment");
    expect(events.find((e) => e.event === "check_red_run")).toMatchObject({ rejected: [], baselineCommit: foundation, foundationTaskId });
    expect(events.find((e) => e.event === "check_files_discarded")).toMatchObject({ paths: ["hello.txt"] });
    expect(JSON.stringify(mock.doGenerateCalls[3]?.prompt ?? null)).toContain("Discarded, outside your checks directory");
    // The foundation is named by its task, never by a commit the cell cannot reach.
    expect(promptText(mock)).toContain(`the merge of task ${foundationTaskId}`);
    expect(promptText(mock)).toContain(`under checks/${hello.implementation.id}/ and nowhere else`);
    expect(promptText(mock)).not.toContain(foundation);
    const rows = await checkRowsOf(hello.implementation.id);
    expect(rows).toEqual([
      {
        revision: 1,
        name: "says hello",
        command: `sh ${helloSh}`,
        files: [{ path: helloSh, content: HELLO_CHECK }],
        environmentVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
        baselineCommit: foundation,
        checkTaskId: hello.check.id,
        decides: ["S1"],
      },
    ]);
    // Discarded: main is where it was, the throwaway branch and its worktree are gone.
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(await git("branch", "--list", `check/${hello.check.id}`)).toBe("");
    expect(existsSync(join(target, "checks"))).toBe(false);
    expect(await git("worktree", "list", "--porcelain")).not.toContain("checkouts");
  });

  // A check in bash-only syntax fails under dash with a syntax error, which the red
  // run would accept, so the author sees why at once and can replace it.
  it("define_check red-runs the check at once and shows why it fails; a redefinition replaces it", async () => {
    const greeting = await plannedPair("Write hi.txt");
    const hiSh = `checks/${greeting.implementation.id}/hi.sh`;
    const helloSh = `checks/${hello.implementation.id}/hello.sh`;

    const { result, mock, events } = await runTask(greeting.check, [
      toolCallTurn("define_check", { name: "says hi", command: "words=(hi); grep -q hi hi.txt && cat hi.txt", decides: ["S1"] }),
      toolCallTurn("write_file", { path: hiSh, content: "grep hi hi.txt || exit 99\n" }),
      toolCallTurn("define_check", { name: "says hi", command: `sh ${hiSh}`, decides: ["S1"] }),
      toolCallTurn("finish", { status: "done", summary: "One check: hi.txt says hi." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    // The author sees the project's stored checks, the earlier task's included.
    expect(promptText(mock)).toContain("Checks already stored in this project");
    expect(promptText(mock)).toContain('### Task \\"Write hello.txt\\"');
    expect(promptText(mock)).toContain(`- says hello: \`sh ${helloSh}\``);
    expect(promptText(mock)).toContain(`#### ${helloSh}`);
    const afterFirst = JSON.stringify(mock.doGenerateCalls[1]?.prompt ?? null);
    expect(afterFirst).toContain('Defined check \\"says hi\\"');
    expect(afterFirst).toContain("exit code: 2");
    expect(afterFirst).toMatch(/Syntax error|unexpected/);
    const afterRedefine = JSON.stringify(mock.doGenerateCalls[3]?.prompt ?? null);
    expect(afterRedefine).toContain('Replaced check \\"says hi\\" (1 defined so far)');
    expect(afterRedefine).toContain("hi.txt: No such file");
    expect(events.filter((e) => e.event === "check_defined")).toMatchObject([
      // A check that fails on its own syntax never reached its verdict, and is rejected at once.
      { name: "says hi", replaced: false, exitCode: 2, rejection: expect.stringContaining("it exited 2 on the foundation, not 99") },
      { name: "says hi", replaced: true, exitCode: 99, rejection: null },
    ]);
    expect(await checkRowsOf(greeting.implementation.id)).toEqual([
      expect.objectContaining({ name: "says hi", command: `sh ${hiSh}`, files: [{ path: hiSh, content: "grep hi hi.txt || exit 99\n" }] }),
    ]);
    expect(await git("worktree", "list", "--porcelain")).not.toContain("checkouts");
  });

  // A look around the foundation is never stored as an acceptance check.
  it("probe_foundation shows the foundation and stores nothing; only the checks defined reach the set", async () => {
    const greeting = await plannedPair("Write hey.txt");

    const { result, mock, events } = await runTask(greeting.check, [
      toolCallTurn("probe_foundation", { command: "ls environment" }),
      toolCallTurn("define_check", { name: "says hey", command: "grep hey hey.txt || exit 99", decides: ["S1"] }),
      toolCallTurn("finish", { status: "done", summary: "One check: hey.txt says hey." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    const afterProbe = JSON.stringify(mock.doGenerateCalls[1]?.prompt ?? null);
    expect(afterProbe).toContain("no check was defined");
    expect(afterProbe).toContain("environment.toml");
    expect(events.filter((e) => e.event === "foundation_probed")).toMatchObject([{ command: "ls environment", exitCode: 0 }]);
    expect(events.filter((e) => e.event === "check_defined").map((e) => e["name"])).toEqual(["says hey"]);
    expect((await checkRowsOf(greeting.implementation.id)).map((row) => row.name)).toEqual(["says hey"]);
    expect(await git("worktree", "list", "--porcelain")).not.toContain("checkouts");
  });

  it("a vacuous set, none of whose checks fails on the foundation, is rejected and nothing is stored", async () => {
    const vacuous = await plannedPair("Write a page");
    const uncited = { kind: "uncited", taskId: vacuous.implementation.id } as const;

    const { result, events } = await runTask(vacuous.check, [
      toolCallTurn("define_check", { name: "always", command: "echo fine", decides: ["S1"] }),
      toolCallTurn("finish", { status: "done", summary: "One check." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain(`REJECTED, the set: every check passes on the foundation, and ${unheldReason(uncited)}`);
    expect(result.detail).toContain(heldSetRuleText(HELD_SET_RULE));
    // The detail and the chain are the next check attempt's brief: no commit the cell cannot reach;
    // the operator's copy is in the task_failed event alone.
    expect(result.detail).not.toContain(foundation);
    expect(JSON.stringify(result.errorEnvelope)).not.toContain(foundation);
    expect(events.find((e) => e.event === "task_failed")).toMatchObject({ baselineCommit: foundation, foundationTaskId });
    expect(await checkRowsOf(vacuous.implementation.id)).toEqual([]);
    expect(await git("branch", "--list", `check/${vacuous.check.id}`)).toBe("");

    // The retry's actual brief, from the envelope as the orchestrator stores it for a replan
    // (dispatch-run.ts raw, failure-recovery.ts replanContext): it renders the chain, and names no commit.
    const retry = await runTask(
      {
        ...vacuous.check,
        attempt: 2,
        dispatchCount: 1,
        blockedReason: { source: "replan", replanContext: { attempt: 1, detail: result.detail, raw: { ...result.errorEnvelope } } },
      },
      [toolCallTurn("finish", { status: "done", summary: "No check." })],
    );
    const brief = promptText(retry.mock);
    expect(brief).toContain("Previous attempt FAILED");
    expect(brief).toContain("# Error Chain");
    expect(brief).toContain(unheldReason(uncited));
    expect(brief).toContain(heldSetRuleText(HELD_SET_RULE));
    expect(brief.match(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g)).toBeNull();
    // The only 64-hex string a brief may hold is the environment's version, a content hash, never a commit.
    const withoutVersion = brief.replace(/environment, version [0-9a-f]{64}\b/g, "environment, version <v>");
    expect(withoutVersion.match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g)).toBeNull();
  });

  // A cited item no stored check decides would be accepted unchecked, whatever line cites it.
  it("a set that leaves one cited item decided by no check is rejected before its red run, and nothing is stored", async () => {
    const pair = await plannedPair("Write two notes", [CITED, { type: "scope", id: "S2", text: "The product keeps every note it is given.", side: "in" }]);

    const { result, mock, events } = await runTask(pair.check, [
      toolCallTurn("define_check", { name: "first note", command: "grep one one.txt || exit 99", decides: ["S1"] }),
      toolCallTurn("define_check", { name: "uncited", command: "grep two two.txt || exit 99", decides: ["S9"] }),
      toolCallTurn("finish", { status: "done", summary: "One check." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("the task cites S2, which no check decides");
    expect(JSON.stringify(mock.doGenerateCalls[1]?.prompt ?? null)).toContain("Cited items no check defined so far decides (the checks are not kept until each has one): S2");
    expect(JSON.stringify(mock.doGenerateCalls[2]?.prompt ?? null)).toContain("decides names [S9], which the task does not cite");
    expect(events.find((e) => e.event === "check_red_run")).toBeUndefined();
    expect(await checkRowsOf(pair.implementation.id)).toEqual([]);
  });

  it("a check whose command the environment cannot run is rejected, though it fails on main", async () => {
    const unrunnable = await plannedPair("Write a form");

    const { result } = await runTask(unrunnable.check, [
      toolCallTurn("define_check", { name: "form", command: "no-such-tool-in-this-environment --check", decides: ["S1"] }),
      toolCallTurn("finish", { status: "done", summary: "One check." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("cannot be run in the project environment (exit 127)");
    expect(await checkRowsOf(unrunnable.implementation.id)).toEqual([]);
  });

  // One set rule for every authoring. A check that passes on the foundation
  // guards behaviour that already holds; the set is kept when another fails there.
  it("keeps a set where one check passes on the foundation and another fails there, and tells the author so", async () => {
    const pair = await plannedPair("Write bye.txt");

    const { result, mock, events } = await runTask(pair.check, [
      toolCallTurn("define_check", { name: "already there", command: "test -f environment/environment.toml", decides: ["S1"] }),
      toolCallTurn("define_check", { name: "says bye", command: "grep bye bye.txt || exit 99", decides: ["S1"] }),
      toolCallTurn("finish", { status: "done", summary: "Two checks." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    expect(promptText(mock)).toContain("Red run on the foundation");
    expect(JSON.stringify(mock.doGenerateCalls[1]?.prompt ?? null)).toContain("kept as a guard of behaviour that already holds");
    expect(events.find((e) => e.event === "check_red_run")).toMatchObject({ rejected: [], holdsAlready: ["already there"], setRejected: false });
    expect((await checkRowsOf(pair.implementation.id)).map((row) => row.name)).toEqual(["already there", "says bye"]);
  });

  it("an implementation task whose stored check passes on its merge completes, and the check files are not merged", async () => {
    const { result, mock, events } = await runTask(hello.implementation, [
      toolCallTurn("write_file", { path: "hello.txt", content: "hello\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote hello.txt." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    expect(toolNames(mock)).not.toContain("define_check");
    expect(promptText(mock)).toContain("Checks that decide this task");
    expect(promptText(mock)).toContain(`sh checks/${hello.implementation.id}/hello.sh`);
    expect(promptText(mock)).toContain(`#### checks/${hello.implementation.id}/hello.sh`);
    expect(promptText(mock)).toContain(HELLO_CHECK.trim());
    expect(events.find((e) => e.event === "post_merge_verify")).toMatchObject({
      verdict: "passed",
      revision: 1,
      details: expect.stringContaining('Check "says hello": PASSED'),
    });
    expect(await readFile(join(target, "hello.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(target, "checks"))).toBe(false);
  });

  it("an implementation that rewrites its check file to pass is refused by the ownership gate before the merge", async () => {
    const goodbye = await plannedPair("Write bye.txt");
    const original = "grep goodbye bye.txt || exit 99\n";
    await new TaskCheckRepository(db).append({
      projectId,
      taskId: goodbye.implementation.id,
      checkTaskId: goodbye.check.id,
      environmentVersion: "e".repeat(64),
      baselineCommit: foundation,
      checks: [{ name: "says goodbye", command: "sh checks/bye.sh", decides: ["S1"] }],
      files: [{ path: "checks/bye.sh", content: original }],
    });
    const mainBefore = await git("rev-parse", "main");

    const { result } = await runTask(goodbye.implementation, [
      toolCallTurn("write_file", { path: "checks/bye.sh", content: "echo goodbye\nexit 0\n" }),
      toolCallTurn("write_file", { path: "bye.txt", content: "see you\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote bye.txt." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain(`checks/bye.sh (checks of task ${goodbye.implementation.id})`);
    expect(result.detail).toContain("check files belong to the check author");
    if (result.errorEnvelope === undefined) throw new Error("a failed task must carry its error envelope");
    expect(result.errorEnvelope.chain.operation).toBe("ownershipGate");
    if (result.status !== "failed") throw new Error("expected a failed result");
    expect(result.verdict).toEqual({ kind: "retryable", ground: "work" });
    expect(new FailureRouter(2).route({
      item: { id: goodbye.implementation.id },
      failure: { detail: result.detail, raw: {} },
      priorAttempts: 1,
      verdict: result.verdict,
    })).toMatchObject({ action: "replan", attempt: 2 });
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(await git("branch", "--list", `task/${goodbye.implementation.id}`)).not.toBe("");
  });

  it("an implementation task with no stored checks fails before any model call", async () => {
    const unchecked = await plannedPair("Write nothing.txt");

    const { result, mock } = await runTask(unchecked.implementation, []);

    expect(result.status).toBe("failed");
    expect(result.errorEnvelope?.chain.operation).toBe("loadTaskChecks");
    expect(mock.doGenerateCalls).toHaveLength(0);
  });
});

// A merge is checked against every stored suite, not only its own task's checks.
describe("post-merge regression suite", () => {
  /** What the orchestrator does on a completed result. */
  async function markCompleted(taskId: WorkItemId): Promise<void> {
    await db.execute(sql`UPDATE work_items SET status = 'Completed', updated_at = now() WHERE id = ${taskId}`);
  }

  /** A pair whose check, stored on the current environment version, is one command with no file. */
  async function checkedPair(title: string, check: { readonly name: string; readonly command: string }) {
    const pair = await plannedPair(title);
    const [helloRow] = await checkRowsOf(hello.implementation.id);
    if (helloRow === undefined) throw new Error("the first describe's hello checks are not on record");
    await new TaskCheckRepository(db).append({
      projectId,
      taskId: pair.implementation.id,
      checkTaskId: pair.check.id,
      environmentVersion: helloRow.environmentVersion,
      baselineCommit: foundation,
      checks: [{ ...check, decides: ["S1"] }],
      files: [],
    });
    return pair;
  }

  beforeAll(async () => {
    // The first describe merged "Write hello.txt", decided by its stored "says hello" check.
    await markCompleted(hello.implementation.id);
  });

  it("a merge that breaks an earlier task's stored check fails naming that task and check, as this task's regression; nothing merged", async () => {
    const greet = await checkedPair("Write greet.txt", { name: "greets", command: "grep hi greet.txt || exit 99" });
    const mainBefore = await git("rev-parse", "main");

    const { result, events } = await runTask(greet.implementation, [
      toolCallTurn("write_file", { path: "greet.txt", content: "hi\n" }),
      toolCallTurn("write_file", { path: "hello.txt", content: "bye\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote greet.txt." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain(`REGRESSION: earlier task ${hello.implementation.id}'s checks revision 1`);
    expect(result.detail).toContain('check "says hello" FAILED: exited 99');
    expect(result.detail).toContain("the regression is this task's");
    // Its own check and the environment's test passed: only the regression failed it.
    expect(result.detail).toContain('Check "greets": PASSED');
    expect(result.detail).toContain('Check "environment test": PASSED');
    expect(events.find((e) => e.event === "post_merge_verify")).toMatchObject({ verdict: "failed", regressionTasks: [hello.implementation.id] });
    if (result.errorEnvelope === undefined) throw new Error("a failed task must carry its error envelope");
    if (result.status !== "failed") throw new Error("expected a failed result");
    expect(result.verdict).toEqual({ kind: "retryable", ground: "work" });
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(await readFile(join(target, "hello.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(target, "greet.txt"))).toBe(false);
  });

  it("a merge that fails the environment's test fails naming it; nothing merged", async () => {
    const notes = await checkedPair("Write notes.txt", { name: "notes", command: "grep note notes.txt || exit 99" });
    const mainBefore = await git("rev-parse", "main");

    const { result } = await runTask(notes.implementation, [
      toolCallTurn("write_file", { path: "notes.txt", content: "a note\n" }),
      toolCallTurn("write_file", { path: "BROKEN", content: "breaks the environment's test\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote notes.txt." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain(`the environment's test (version `);
    expect(result.detail).toContain('check "environment test" FAILED: exited 1');
    expect(result.detail).not.toContain("REGRESSION");
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(existsSync(join(target, "BROKEN"))).toBe(false);
  });

  // The task's own stored check failing on its merge fails it; Z0 merges nothing.
  it("a merge on which the task's own stored check fails fails the task, not as a regression; nothing merged", async () => {
    const sun = await checkedPair("Write sun.txt", { name: "shines", command: "grep sun sun.txt || exit 99" });
    const mainBefore = await git("rev-parse", "main");

    const { result, events } = await runTask(sun.implementation, [
      toolCallTurn("write_file", { path: "sun.txt", content: "moon\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote sun.txt." }),
    ]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain('check "shines" FAILED: exited 99');
    expect(result.detail).not.toContain("REGRESSION");
    expect(events.find((e) => e.event === "post_merge_verify")).toMatchObject({ verdict: "failed" });
    expect(events.some((e) => e.event === "task_completed")).toBe(false);
    if (result.errorEnvelope === undefined) throw new Error("a failed task must carry its error envelope");
    expect(result.errorEnvelope.chain.operation).toBe("postMergeTaskChecks");
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(await git("status", "--porcelain")).toBe("");
    expect(existsSync(join(target, "sun.txt"))).toBe(false);
  });

  it("a merge that passes the environment's test, every earlier task's checks and its own is merged", async () => {
    const wave = await checkedPair("Write wave.txt", { name: "waves", command: "grep wave wave.txt || exit 99" });

    const { result, events } = await runTask(wave.implementation, [
      toolCallTurn("write_file", { path: "wave.txt", content: "wave\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote wave.txt." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    const verify = events.find((e) => e.event === "post_merge_verify");
    expect(verify).toMatchObject({ verdict: "passed", regressionTasks: [hello.implementation.id], boundSeconds: 3 * 60 });
    expect(verify?.["details"]).toContain('Check "environment test": PASSED');
    expect(verify?.["details"]).toContain('Check "says hello": PASSED');
    expect(verify?.["details"]).toContain('Check "waves": PASSED');
    expect(await readFile(join(target, "wave.txt"), "utf8")).toBe("wave\n");
    // The earlier task's check file was written over the checkout, never merged.
    expect(existsSync(join(target, "checks"))).toBe(false);
  });

  // A completed task with no stored check must never block every later merge with no exit.
  it("an earlier task Completed with no stored check is named as not re-run, never a block; the merge is decided by the rest", async () => {
    const legacy = await plannedPair("Write legacy.txt");
    await markCompleted(legacy.implementation.id);
    const tide = await checkedPair("Write tide.txt", { name: "tides", command: "grep tide tide.txt || exit 99" });

    const { result, events } = await runTask(tide.implementation, [
      toolCallTurn("write_file", { path: "tide.txt", content: "tide\n" }),
      toolCallTurn("finish", { status: "done", summary: "Wrote tide.txt." }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    const verify = events.find((e) => e.event === "post_merge_verify");
    // The product scaffold is a Completed implementation task with no stored check too (its gate is
    // the environment's build and test), so it is named beside the legacy task.
    expect(verify).toMatchObject({ verdict: "passed", uncheckedTasks: [foundationTaskId, legacy.implementation.id] });
    expect(verify?.["regressionTasks"]).not.toContain(legacy.implementation.id);
    expect(verify?.["details"]).toContain(
      `Not re-run, no check is stored for them (completed before checks existed): ${foundationTaskId}, ${legacy.implementation.id}`,
    );
  });

  // A wrong check has an exit (a dispute), and a retry is never judged only on its own uncommitted diff.
  it("a disputed check ends the attempt as disputed with the work kept; a re-dispatch that finds it done on the branch runs the gates", async () => {
    const reef = await checkedPair("Write reef.txt", { name: "reefs", command: "grep reef reef.txt || exit 99" });
    const mainBefore = await git("rev-parse", "main");

    const first = await runTask(reef.implementation, [
      toolCallTurn("write_file", { path: "reef.txt", content: "reef\n" }),
      toolCallTurn("run_checks", {}),
      toolCallTurn("dispute_check", { name: "reefs", reason: "the check reads the wrong file" }),
    ]);

    expect(toolNames(first.mock)).toContain("dispute_check");
    expect(first.result.status, first.result.detail).toBe("disputed");
    if (first.result.status !== "disputed") return;
    expect(first.result).toMatchObject({
      checksOf: reef.implementation.id,
      checkTaskId: reef.check.id,
      revision: 1,
      check: { name: "reefs", command: "grep reef reef.txt || exit 99" },
      reason: "the check reads the wrong file",
    });
    expect(first.result.evidence).toContain('Check "reefs"');
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(await git("log", "-1", "--format=%s", `task/${reef.implementation.id}`)).toContain("partial work for retry");

    const second = await runTask({ ...reef.implementation, attempt: 2, dispatchCount: 1 }, [
      toolCallTurn("finish", { status: "done", summary: "reef.txt is already on the task branch." }),
    ]);

    expect(second.result.status, second.result.detail).toBe("completed");
    expect(second.events.find((e) => e.event === "branch_work_found")).toMatchObject({ paths: ["reef.txt"] });
    expect(second.events.find((e) => e.event === "post_merge_verify")).toMatchObject({
      verdict: "passed",
      details: expect.stringContaining('Check "reefs": PASSED'),
    });
    expect(await readFile(join(target, "reef.txt"), "utf8")).toBe("reef\n");
  });

  it("a re-dispatch whose branch holds no change against main and that edits nothing still fails as no changes", async () => {
    const empty = await checkedPair("Write empty.txt", { name: "empties", command: "grep empty empty.txt || exit 99" });

    const { result } = await runTask(empty.implementation, [toolCallTurn("finish", { status: "done", summary: "Nothing to do." })]);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("the task branch holds no change against main");
    expect(result.detail).toContain('check "empties" FAILED: exited 99');
  });

  // When an earlier task delivered beyond its scope, the sweep
  // before dispatch closes the later task with no implementer, never parking it for the operator.
  it("its checks and the regression suite pass on main itself: completed as already delivered at main before any model call, nothing merged", async () => {
    const again = await checkedPair("Write wave.txt again", { name: "waves again", command: "grep wave wave.txt || exit 99" });
    const mainBefore = await git("rev-parse", "main");

    const { result, events, mock } = await runTask(again.implementation, []);

    expect(result.status, result.detail).toBe("completed");
    if (result.status !== "completed") return;
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(result.delivered).toEqual({ kind: "already-delivered", mainCommit: mainBefore });
    expect(events.find((e) => e.event === "delivered_sweep")).toMatchObject({ allPass: true, mainCommit: mainBefore });
    const verify = events.find((e) => e.event === "delivered_on_main_verify");
    expect(verify).toMatchObject({ verdict: "passed", mainCommit: mainBefore, regressionTasks: [hello.implementation.id] });
    expect(verify?.["details"]).toContain('Check "environment test": PASSED');
    expect(verify?.["details"]).toContain('Check "says hello": PASSED');
    expect(verify?.["details"]).toContain('Check "waves again": PASSED');
    expect(await git("rev-parse", "main")).toBe(mainBefore);
    expect(await git("branch", "--list", `task/${again.implementation.id}`)).toBe("");
  });

  // Checks re-authored for work an earlier task already delivered
  // would all pass on main, so they are red-run on the foundation, where they fail; the set is kept,
  // and the sweep closes the task as already delivered with no implementer dispatched.
  it("a re-authored set is red-run on the foundation, not main; the task it decides is then closed already delivered with no model call", async () => {
    const later = await plannedPair("Greet the user with hello");
    await new TaskCheckRepository(db).append({
      projectId,
      taskId: later.implementation.id,
      checkTaskId: later.check.id,
      environmentVersion: "f".repeat(64),
      baselineCommit: foundation,
      checks: [{ name: "old", command: "false", decides: ["S1"] }],
      files: [],
    });
    const mainBefore = await git("rev-parse", "main");
    expect(await git("show", `${mainBefore}:hello.txt`)).toBe("hello");

    const authored = await runTask({ ...later.check, attempt: 2, dispatchCount: 1 }, [
      toolCallTurn("define_check", { name: "says hello", command: "grep hello hello.txt || exit 99", decides: ["S1"] }),
      toolCallTurn("finish", { status: "done", summary: "One check: hello.txt says hello." }),
    ]);

    expect(authored.result.status, authored.result.detail).toBe("completed");
    expect(authored.events.find((e) => e.event === "check_red_run")).toMatchObject({ baselineCommit: foundation, rejected: [], setRejected: false });
    const revision2 = (await checkRowsOf(later.implementation.id)).filter((row) => row.revision === 2);
    expect(revision2).toEqual([expect.objectContaining({ name: "says hello", baselineCommit: foundation })]);

    const implemented = await runTask(later.implementation, []);

    expect(implemented.result.status, implemented.result.detail).toBe("completed");
    expect(implemented.mock.doGenerateCalls).toHaveLength(0);
    if (implemented.result.status !== "completed") return;
    expect(implemented.result.delivered).toEqual({ kind: "already-delivered", mainCommit: mainBefore });
    expect(await git("rev-parse", "main")).toBe(mainBefore);
  });

  it("a check author finishing blocked because its task is delivered completes when Z0 finds that task's checks and every suite pass on main", async () => {
    const delivered = await checkedPair("Say hello", { name: "hello again", command: "grep hello hello.txt || exit 99" });
    const mainBefore = await git("rev-parse", "main");

    const { result, events } = await runTask({ ...delivered.check, attempt: 2, dispatchCount: 1 }, [
      toolCallTurn("finish", { status: "blocked", summary: "hello.txt already says hello on main.", blockedReason: "The task is already delivered.", blockedOn: { kind: "other" } }),
    ]);

    expect(result.status, result.detail).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.delivered).toEqual({ kind: "checked-task-delivered", checkedTaskId: delivered.implementation.id, mainCommit: mainBefore, revision: 1 });
    expect(events.find((e) => e.event === "delivered_on_main_verify")).toMatchObject({ verdict: "passed", checkedTaskId: delivered.implementation.id });
    expect((await checkRowsOf(delivered.implementation.id)).map((row) => row.revision)).toEqual([1]);
  });

  it("a check author finishing blocked whose task is not on main stays blocked, with what Z0 found", async () => {
    const missing = await checkedPair("Write missing.txt", { name: "missing", command: "grep missing missing.txt || exit 99" });

    const { result } = await runTask({ ...missing.check, attempt: 2, dispatchCount: 1 }, [
      toolCallTurn("finish", { status: "blocked", summary: "It is already there.", blockedReason: "The task is already delivered.", blockedOn: { kind: "other" } }),
    ]);

    expect(result.status).toBe("blocked");
    expect(result.detail).toContain("Z0 does not find it delivered");
    expect(result.detail).toContain('check "missing" FAILED');
  });

  // A merged task's check blocking this merge is not read only as this
  // task's regression: the implementer may dispute it, which reopens that check's own check task.
  it("an implementer disputes a merged task's check by that task's id: the dispute names that task's check task", async () => {
    const echo = await checkedPair("Write echo.txt", { name: "echoes", command: "grep echo echo.txt || exit 99" });

    const { result, mock } = await runTask(echo.implementation, [
      toolCallTurn("dispute_check", { name: "says hello", task: hello.implementation.id, reason: "echo.txt must replace hello.txt, as the vision says" }),
    ]);

    expect(promptText(mock)).toContain("dispute");
    expect(result.status, result.detail).toBe("disputed");
    if (result.status !== "disputed") return;
    expect(result).toMatchObject({
      checksOf: hello.implementation.id,
      checkTaskId: hello.check.id,
      revision: 1,
      check: { name: "says hello", command: `sh checks/${hello.implementation.id}/hello.sh` },
    });
  });

  // The scaffold's own build and test failing on its merge is no tree regression to abandon
  // at once: it is the scaffold's own work, retried.
  it("a product scaffold whose merge fails the build and test is a verification gap the router retries, never a tree regression", async () => {
    const scaffoldId = createWorkItemId();
    const taskSpec = {
      goal: "Set up the product's layout",
      endState: "the environment's build and test pass",
      scope: "the product's module root",
      deliverables: [] as string[],
      origin: "product-scaffold",
      checkedBy: "substrate",
    } as const;
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, task_spec)
      VALUES (${scaffoldId}, 'Task', 'InProgress', 'Set up the product layout', ${projectId}, 'implementation',
              ${randomUUID()}, ${JSON.stringify(taskSpec)}::jsonb)`);
    const mainBefore = await git("rev-parse", "main");

    const { result } = await runTask(
      { id: scaffoldId, projectId, title: "Set up the product layout", taskSpec, epicId: null, overflowedWindowTokens: null, dispatchCount: 0, attempt: 1, workKind: "implementation", successCriteria: [] },
      [
        toolCallTurn("write_file", { path: "placeholder.sh", content: `echo "${SCAFFOLD_PLACEHOLDER_MARKER}: not done yet"; exit 1\n` }),
        toolCallTurn("write_file", { path: "BROKEN", content: "a layout whose test fails\n" }),
        toolCallTurn("finish", { status: "done", summary: "Layout set up." }),
      ],
    );
    expect(result.detail).toContain("the product's build and test");

    expect(result.status).toBe("failed");
    if (result.errorEnvelope === undefined) throw new Error("a failed task must carry its error envelope");
    expect(result.errorEnvelope.chain.operation).toBe("postMergeScaffold");
    if (result.status !== "failed") throw new Error("expected a failed result");
    expect(result.verdict).toEqual({ kind: "retryable", ground: "work" });
    expect(new FailureRouter(3).route({ item: { id: scaffoldId }, failure: { detail: result.detail, raw: {} }, priorAttempts: 1, verdict: result.verdict })).toMatchObject({
      action: "replan",
      attempt: 2,
    });
    expect(await git("rev-parse", "main")).toBe(mainBefore);
  });

  // A scaffold whose refusals carry no marker would leave every later sweep blind to its
  // placeholder: its merge is refused before any build runs, however well the product builds.
  it("a product scaffold whose merge holds no marked placeholder refusal fails and is retried, main untouched", async () => {
    const scaffoldId = createWorkItemId();
    const taskSpec = {
      goal: "Set up the product's layout",
      endState: "the environment's build and test pass",
      scope: "the product's module root",
      deliverables: [] as string[],
      origin: "product-scaffold",
      checkedBy: "substrate",
    } as const;
    await db.execute(sql`
      INSERT INTO work_items (id, level, status, title, project_id, work_kind, owner_role_id, task_spec)
      VALUES (${scaffoldId}, 'Task', 'InProgress', 'Set up the product layout', ${projectId}, 'implementation',
              ${randomUUID()}, ${JSON.stringify(taskSpec)}::jsonb)`);
    const mainBefore = await git("rev-parse", "main");

    const { result } = await runTask(
      { id: scaffoldId, projectId, title: "Set up the product layout", taskSpec, epicId: null, overflowedWindowTokens: null, dispatchCount: 0, attempt: 1, workKind: "implementation", successCriteria: [] },
      [
        toolCallTurn("write_file", { path: "placeholder.sh", content: 'echo "not done yet"; exit 1\n' }),
        toolCallTurn("write_file", { path: "PUBLIC_INTERFACE.md", content: `Every entry answers ${SCAFFOLD_PLACEHOLDER_MARKER} until it is built.\n` }),
        toolCallTurn("finish", { status: "done", summary: "Layout set up." }),
      ],
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected a failed result");
    expect(result.errorEnvelope?.chain.operation).toBe("postMergeScaffold");
    expect(result.detail).toContain(`holds no placeholder refusal marked ${SCAFFOLD_PLACEHOLDER_MARKER}`);
    expect(result.detail).not.toContain("the product's build and test");
    expect(result.verdict).toEqual({ kind: "retryable", ground: "work" });
    expect(await git("rev-parse", "main")).toBe(mainBefore);
  });
});

// Quality's dispute record: the count per check task survives in the table; past
// the bound the disputing task is given up.
describe("check disputes on record", () => {
  it("counts each check task's disputes", async () => {
    const pair = await plannedPair("Write disputed.txt");
    const other = await plannedPair("Write undisputed.txt");
    const disputes = new CheckDisputeRepository(db);
    const dispute = { projectId, taskId: pair.implementation.id, checkTaskId: pair.check.id, revision: 1, checkName: "c", reason: "r", evidence: null };

    expect(await disputes.record(dispute)).toBe(1);
    expect(await disputes.record({ ...dispute, evidence: "the last run" })).toBe(2);
    expect(await disputes.record({ ...dispute, taskId: other.implementation.id, checkTaskId: other.check.id })).toBe(1);
    expect(await disputes.record(dispute)).toBe(3);
  });
});
