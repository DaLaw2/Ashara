import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { createWorkdir, ensureTargetGitInit, runHostGit, targetRepo } from "@ashara/execution-infra";
import type { Cell } from "@ashara/execution-infra";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { WorkItemId } from "@ashara/shared";
import { notExercised, recordingLogger } from "@ashara/shared/testing";
import { HELD_SET_RULE } from "@ashara/workplace";
import type { HoldEvidence, Outcome } from "@ashara/workplace";
import type { CheckAuthoring, ExecutionResult, VerifiedDispatch } from "../dispatch-result.js";
import { CheckRecorder, checkBranchName } from "../task-checks.js";
import type { CheckCells, SetRejection } from "../task-checks.js";
import { HELD_SET_GIVEN_UP, WORK_FAILED } from "../task-verdict.js";
import { CheckHarvest } from "./check-harvest.js";

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const done: Outcome = {
  kind: "finished",
  status: "done",
  summary: "wrote the checks",
  blockedReason: null,
  blockedOn: null,
  statement: null,
  turnsUsed: 1,
  cost: { measured: true, totalUsd: 0, turns: 1 },
  lastToolCall: null,
  promptDigest: "0".repeat(64),
  detail: "finished done",
};

async function authoring(recorder: CheckRecorder): Promise<{ readonly d: VerifiedDispatch; readonly work: CheckAuthoring }> {
  const root = await mkdtemp(join(tmpdir(), "ashara-check-harvest-"));
  scratch.push(root);
  const target = join(root, "project");
  await ensureTargetGitInit(target, root);
  const d: VerifiedDispatch = {
    task: { id: createWorkItemId(), projectId: parseProjectId("22222222-2222-4222-8222-222222222222", "test"), attempt: 1 },
    targetProjectPath: target,
    workDir: join(root, "gone"),
    repo: { gitDir: join(target, ".git"), workTree: join(root, "gone") },
    sessionId: "session-1",
    environment: { kind: "base-cell", image: "base", digest: "sha256:0" },
  };
  const work: CheckAuthoring = {
    kind: "check-authoring",
    checkedTaskId: "impl-1",
    environment: {
      version: "v1",
      commit: "c",
      imageId: "img",
      imageRef: "ref",
      reused: true,
      statement: "s",
      definition: { containerfile: "environment/Containerfile", recipe: [], inputs: [], probe: "true", build: "true", test: "true" },
    },
    prior: null,
    foundation: { taskId: "scaffold", commit: "f".repeat(40) },
    citedItems: ["G1", "G2"],
    branch: "check/impl-1",
    startCommit: "e".repeat(40),
    recorder,
  };
  return { d, work };
}

function harvest(events: Array<Record<string, unknown>>): CheckHarvest {
  return new CheckHarvest({
    dispatchCells: { checkCells: notExercised("a check cell"), checkoutDir: notExercised("a checkout") },
    checks: { append: notExercised("a stored revision"), holdEvidenceOf: notExercised("the hold evidence"), recordSetRejection: notExercised("a set rejection") },
    eventSink: { emit: (event) => void events.push(event) },
    logger: recordingLogger(),
  });
}

describe("CheckHarvest", () => {
  test("an attempt that defined no check is rejected: nothing stored, nothing red-run", async () => {
    const { d, work } = await authoring(new CheckRecorder(["G1"]));
    const events: Array<Record<string, unknown>> = [];
    const result = await harvest(events).keepChecks(d, work, done);
    expect(result.status).toBe("failed");
    expect(result.status === "failed" ? result.verdict : null).toBe(WORK_FAILED);
    expect(result.detail).toContain("no check was defined with define_check");
    expect(events.map((event) => event.event)).toEqual(["task_failed"]);
  });

  test("a cited item no check decides rejects the set before any file is harvested", async () => {
    const recorder = new CheckRecorder(["G1", "G2"]);
    recorder.record({ name: "greets", command: "true", decides: ["G1"] });
    const { d, work } = await authoring(recorder);
    const result = await harvest([]).keepChecks(d, work, done);
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("the task cites G2, which no check decides");
  });
});

// A check attempt that reaches the red run: a real target and worktree, and a cell that runs each
// check's command on the host checkout, so the set's verdict and what it reads are the harvest's own.
describe("CheckHarvest, a set red-run on its foundation", () => {
  const hostCell = (hostPath: string): Cell => ({
    id: "host-stand-in",
    spec: { image: "none", project: "p", task: "t", role: "ci", instance: "test", mount: { hostPath } },
    exec: async (argv) => {
      try {
        const { stdout, stderr } = await promisify(execFile)(argv[0] ?? "sh", argv.slice(1), { cwd: hostPath });
        return { exitCode: 0, stdout, stderr, timedOut: false, statusLost: false, stdoutCut: null, stderrCut: null };
      } catch (err) {
        const code = typeof err === "object" && err !== null && "code" in err && typeof err.code === "number" ? err.code : 1;
        return { exitCode: code, stdout: "", stderr: String(err), timedOut: false, statusLost: false, stdoutCut: null, stderrCut: null };
      }
    },
    teardown: async () => {},
  });

  /** One check attempt of check task `checkTaskId` (attempt `attempt`) for `checkedTaskId`, its checks defined by `commands`. */
  async function redRunAttempt(
    checkTaskId: WorkItemId,
    checkedTaskId: WorkItemId,
    attempt: number,
    commands: readonly string[],
  ): Promise<{ readonly d: VerifiedDispatch; readonly work: CheckAuthoring; readonly cells: CheckCells; readonly checkout: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ashara-check-redrun-")));
    scratch.push(root);
    const target = join(root, "project");
    await ensureTargetGitInit(target, root);
    const foundation = (await runHostGit(targetRepo(target), ["rev-parse", "HEAD"])).stdout.trim();
    const branch = checkBranchName(checkTaskId);
    const { workDir, repo } = await createWorkdir(root, target, branch);
    const recorder = new CheckRecorder(["G1"]);
    commands.forEach((command, i) => recorder.record({ name: `c${i}`, command, decides: ["G1"] }));
    const d: VerifiedDispatch = {
      task: { id: checkTaskId, projectId: parseProjectId("22222222-2222-4222-8222-222222222222", "test"), attempt },
      targetProjectPath: target,
      workDir,
      repo,
      sessionId: "session-1",
      environment: { kind: "base-cell", image: "base", digest: "sha256:0" },
    };
    const work: CheckAuthoring = {
      kind: "check-authoring",
      checkedTaskId,
      environment: {
        version: "v1",
        commit: "c",
        imageId: "img",
        imageRef: "ref",
        reused: true,
        statement: "s",
        definition: { containerfile: "environment/Containerfile", recipe: [], inputs: [], probe: "true", build: "true", test: "true" },
      },
      prior: null,
      foundation: { taskId: "scaffold", commit: foundation },
      citedItems: ["G1"],
      branch,
      startCommit: foundation,
      recorder,
    };
    const cells: CheckCells = {
      targetProjectPath: target,
      createCell: async (spec) => hostCell(spec.hostPath),
      teardownCell: async () => {},
      timeoutSeconds: 30,
      signal: new AbortController().signal,
    };
    return { d, work, cells, checkout: join(root, "checkouts", `red-run-${attempt}`) };
  }

  /** The records' side of a harvest: the evidence it reads and the rejections it records, counted as the repository counts them. */
  function records(evidence: HoldEvidence): { readonly read: () => number; readonly rejections: SetRejection[]; readonly store: CheckHarvestStore } {
    let reads = 0;
    const rejections: SetRejection[] = [];
    const key = (r: SetRejection) => `${r.evidence.kind}:${JSON.stringify(r.evidence)}`;
    return {
      read: () => reads,
      rejections,
      store: {
        append: notExercised("a stored revision"),
        holdEvidenceOf: async () => {
          reads += 1;
          return evidence;
        },
        recordSetRejection: async (rejection) => {
          rejections.push(rejection);
          return rejections.filter((r) => key(r) === key(rejection)).length;
        },
      },
    };
  }

  type CheckHarvestStore = ConstructorParameters<typeof CheckHarvest>[0]["checks"];

  async function keep(
    attempt: Awaited<ReturnType<typeof redRunAttempt>>,
    store: CheckHarvestStore,
  ): Promise<ExecutionResult> {
    const logger = recordingLogger();
    return new CheckHarvest({
      dispatchCells: { checkCells: () => attempt.cells, checkoutDir: () => attempt.checkout },
      checks: store,
      logger,
    }).keepChecks(attempt.d, attempt.work, done);
  }

  const failedVerdict = (result: ExecutionResult) => (result.status === "failed" ? result.verdict : null);

  // The records are read only when the set holds whole: a check that reached no verdict rejects it first.
  test("a set that does not hold whole reads no hold evidence and records no held-set rejection", async () => {
    const { read, rejections, store } = records({ kind: "uncorrected", items: ["G1"] });
    const result = await keep(await redRunAttempt(createWorkItemId(), createWorkItemId(), 1, ["echo ok", "exit 3"]), store);
    expect(failedVerdict(result)).toBe(WORK_FAILED);
    expect(read()).toBe(0);
    expect(rejections).toEqual([]);
  });

  // The held-set rule bounds identical rejections by a retry budget.
  test.each<[string, HoldEvidence]>([
    ["an add-guarantee correction's item", { kind: "undelivered", items: ["G1"] }],
    ["an amended assumption no earlier check decided", { kind: "assumption-undecided", items: ["G1"] }],
    ["a first plan's task", { kind: "uncorrected", items: ["G1"] }],
  ])("a set holding whole for %s is retried, then given up at the rule's bound of identical rejections", async (_case, evidence) => {
    const { read, rejections, store } = records(evidence);
    const checkTaskId = createWorkItemId();
    const checkedTaskId = createWorkItemId();
    const results: ExecutionResult[] = [];
    for (let attempt = 1; attempt <= HELD_SET_RULE.giveUpAfter; attempt += 1) {
      results.push(await keep(await redRunAttempt(checkTaskId, checkedTaskId, attempt, ["echo ok"]), store));
    }
    expect(results.slice(0, -1).map(failedVerdict)).toEqual(Array.from({ length: HELD_SET_RULE.giveUpAfter - 1 }, () => WORK_FAILED));
    const last = results.at(-1);
    expect(last === undefined ? null : failedVerdict(last)).toEqual(HELD_SET_GIVEN_UP);
    expect(last?.detail).toContain("the task is given up");
    expect(read()).toBe(HELD_SET_RULE.giveUpAfter);
    expect(rejections.map((r) => [r.checkTaskId, r.checkedTaskId, r.attempt, r.evidence])).toEqual(
      Array.from({ length: HELD_SET_RULE.giveUpAfter }, (_, i) => [checkTaskId, checkedTaskId, i + 1, evidence]),
    );
  });

  // A set holding whole for items that held before the correction is kept, and nothing is recorded as rejected.
  test("a held set is kept and records no rejection", async () => {
    const { rejections, store } = records({ kind: "still-holds", items: ["G1"] });
    let appended = 0;
    const result = await keep(await redRunAttempt(createWorkItemId(), createWorkItemId(), 1, ["echo ok"]), {
      ...store,
      append: async () => {
        appended += 1;
        return 1;
      },
    });
    expect(result.status).toBe("completed");
    expect(appended).toBe(1);
    expect(rejections).toEqual([]);
  });
});
