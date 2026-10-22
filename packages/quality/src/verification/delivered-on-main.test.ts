import { describe, expect, test } from "vitest";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { notExercised, recordingLogger } from "@ashara/shared/testing";
import type { Outcome } from "@ashara/workplace";
import type { CheckAuthoring, VerifiedDispatch } from "../dispatch-result.js";
import { CheckRecorder } from "../task-checks.js";
import { DeliveredOnMain } from "./delivered-on-main.js";

const dispatch: VerifiedDispatch = {
  task: { id: createWorkItemId(), projectId: parseProjectId("22222222-2222-4222-8222-222222222222", "test"), attempt: 1 },
  targetProjectPath: "/srv/target",
  workDir: "/srv/work",
  repo: { gitDir: "/srv/target/.git/worktrees/w", workTree: "/srv/work" },
  sessionId: "session-1",
  environment: { kind: "base-cell", image: "base", digest: "sha256:0" },
};

const blocked: Outcome = {
  kind: "finished",
  status: "blocked",
  summary: "already on main",
  blockedReason: "already on main",
  statement: null,
  turnsUsed: 1,
  cost: { measured: true, totalUsd: 0, turns: 1 },
  lastToolCall: null,
  promptDigest: "0".repeat(64),
  detail: "finished blocked",
};

describe("DeliveredOnMain", () => {
  test("a check author's word that its task is delivered is not taken when the task has no stored checks", async () => {
    const job = new DeliveredOnMain({
      dispatchCells: { checkCells: notExercised("a check cell"), checkoutDir: notExercised("a checkout") },
      checks: { completedOf: notExercised("the stored checks") },
      logger: recordingLogger(),
    });
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
      citedItems: ["G1"],
      branch: "check/x",
      startCommit: "s".repeat(40),
      recorder: new CheckRecorder(["G1"]),
    };
    const evaluated = await job.checkedTaskOnMain(dispatch, work, blocked);
    expect(evaluated).toEqual({ kind: "not-delivered", why: "task impl-1 has no stored checks to run on main, so nothing shows it is delivered" });
  });
});
