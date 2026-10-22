import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ensureTargetGitInit } from "@ashara/execution-infra";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { notExercised, recordingLogger } from "@ashara/shared/testing";
import type { Outcome } from "@ashara/workplace";
import type { CheckAuthoring, VerifiedDispatch } from "../dispatch-result.js";
import { CheckRecorder } from "../task-checks.js";
import { WORK_FAILED } from "../task-verdict.js";
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
    checks: { append: notExercised("a stored revision") },
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
