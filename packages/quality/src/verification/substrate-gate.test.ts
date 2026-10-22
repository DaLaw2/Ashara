import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ensureTargetGitInit } from "@ashara/execution-infra";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";
import type { Outcome } from "@ashara/workplace";
import type { VerifiedDispatch } from "../dispatch-result.js";
import { WORK_FAILED } from "../task-verdict.js";
import { SubstrateGate } from "./substrate-gate.js";

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const done: Outcome = {
  kind: "finished",
  status: "done",
  summary: "defined the environment",
  blockedReason: null,
  statement: null,
  turnsUsed: 1,
  cost: { measured: true, totalUsd: 0, turns: 1 },
  lastToolCall: null,
  promptDigest: "0".repeat(64),
  detail: "finished done",
};

describe("SubstrateGate", () => {
  test("a done without a stack statement fails the task before the gate runs anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "ashara-substrate-gate-"));
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
    const recorded: string[] = [];
    const gate = new SubstrateGate({
      dispatchCells: {
        environmentScope: () => {
          throw new Error("no gate may run without a statement");
        },
      },
      attemptPolicy: { perCommandTimeoutSeconds: 30 },
      statements: { record: async (_taskId, statement) => void recorded.push(statement) },
      logger: recordingLogger(),
    });
    const outcome = await gate.substrateGate(d, null, done);
    expect(outcome.kind).toBe("ended");
    if (outcome.kind !== "ended") return;
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.status === "failed" ? outcome.result.verdict : null).toBe(WORK_FAILED);
    expect(outcome.result.detail).toContain("without a stack statement");
    expect(recorded).toEqual([]);
  });
});
