import { describe, expect, test } from "vitest";
import { createWorkItemId, parseProjectId, recordingLogger } from "@ashara/shared";
import type { VerifiedDispatch } from "../dispatch-result.js";
import type { TaskChecks } from "../task-checks.js";
import { BaselineRevalidation } from "./baseline-revalidation.js";

const dispatch: VerifiedDispatch = {
  task: { id: createWorkItemId(), projectId: parseProjectId("22222222-2222-4222-8222-222222222222", "test"), attempt: 1 },
  targetProjectPath: "/srv/target",
  workDir: "/srv/work",
  repo: { gitDir: "/srv/target/.git/worktrees/w", workTree: "/srv/work" },
  sessionId: "session-1",
  environment: {
    kind: "environment",
    version: "v1",
    commit: "c",
    imageId: "img",
    imageRef: "ref",
    reused: true,
    statement: "s",
    definition: { containerfile: "environment/Containerfile", recipe: [], inputs: [], probe: "true", build: "true", test: "true" },
  },
};

function unreachable(what: string): () => never {
  return () => {
    throw new Error(`${what} must not be reached`);
  };
}

describe("BaselineRevalidation", () => {
  test("checks red-run in the dispatch's own environment version are trusted as they are: nothing runs", async () => {
    const events: unknown[] = [];
    const job = new BaselineRevalidation({
      dispatchCells: { environmentScope: unreachable("an environment scope"), checkCells: unreachable("a check cell"), checkoutDir: unreachable("a checkout") },
      attemptPolicy: { perCommandTimeoutSeconds: 30 },
      eventSink: { emit: (event) => void events.push(event) },
      logger: recordingLogger(),
    });
    const stored: TaskChecks = { checkTaskId: "c1", revision: 1, environmentVersion: "v1", baselineCommit: null, checks: [], files: [] };
    expect(await job.revalidateOnBaseline(dispatch, stored)).toBeNull();
    expect(events).toEqual([]);
  });
});
