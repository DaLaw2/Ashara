import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ensureTargetGitInit } from "@ashara/execution-infra";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";
import type { Outcome } from "@ashara/workplace";
import type { VerifiedDispatch } from "../dispatch-result.js";
import { OwnershipGate } from "./ownership-gate.js";

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const done: Outcome = {
  kind: "finished",
  status: "done",
  summary: "wrote it",
  blockedReason: null,
  statement: null,
  turnsUsed: 1,
  cost: { measured: true, totalUsd: 0, turns: 1 },
  lastToolCall: null,
  promptDigest: "0".repeat(64),
  detail: "finished done",
};

describe("OwnershipGate", () => {
  test("a task dispatched without an environment has no recipe to fence: blocked, the store never read, nothing merged", async () => {
    const root = await mkdtemp(join(tmpdir(), "ashara-ownership-gate-"));
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
    let read = 0;
    const gate = new OwnershipGate({
      checks: {
        checkFilesOf: async () => {
          read++;
          return [];
        },
      },
      logger: recordingLogger(),
    });
    const result = await gate.ownershipGate(d, done);
    expect(result?.status).toBe("environment_blocked");
    expect(result?.status === "environment_blocked" ? result.fault : null).toBe("ashara");
    expect(result?.detail).toContain("dispatched on the BaseCell");
    expect(read).toBe(0);
  });
});
