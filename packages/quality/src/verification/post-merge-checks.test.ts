import { describe, expect, test } from "vitest";
import type { CheckoutLease } from "@ashara/execution-infra";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { notExercised, recordingLogger } from "@ashara/shared/testing";
import type { VerifiedDispatch } from "../dispatch-result.js";
import { VerificationInfrastructureFault } from "../fault-class.js";
import type { TaskChecks } from "../task-checks.js";
import { PostMergeChecks } from "./post-merge-checks.js";

const dispatch: VerifiedDispatch = {
  task: { id: createWorkItemId(), projectId: parseProjectId("22222222-2222-4222-8222-222222222222", "test"), attempt: 1 },
  targetProjectPath: "/srv/target",
  workDir: "/srv/work",
  repo: { gitDir: "/srv/target/.git/worktrees/w", workTree: "/srv/work" },
  sessionId: "session-1",
  environment: { kind: "base-cell", image: "base", digest: "sha256:0" },
};

const lease: Pick<CheckoutLease, "extend"> = { extend: notExercised("a lease extension") };
const stored: TaskChecks = { checkTaskId: "c1", revision: 2, environmentVersion: "v1", baselineCommit: "b".repeat(40), checks: [{ name: "a", command: "true", decides: ["G1"] }], files: [] };

function checks(): PostMergeChecks {
  return new PostMergeChecks({
    dispatchCells: { environmentScope: notExercised("an environment scope"), checkCells: notExercised("a check cell"), checkoutDir: notExercised("a checkout") },
    attemptPolicy: { perCommandTimeoutSeconds: 30 },
    environment: { images: { build: notExercised("an image build") }, statements: { record: notExercised("a statement") } },
    checks: { completedOf: notExercised("the stored checks") },
    logger: recordingLogger(),
  });
}

describe("PostMergeChecks", () => {
  test("a stored-checks merge with no environment to run on is no verdict: Z0's fault, nothing run", async () => {
    const run = checks().postMergeStoredChecks(dispatch, "/srv/target", stored, lease as CheckoutLease);
    await expect(run).rejects.toBeInstanceOf(VerificationInfrastructureFault);
    await expect(run).rejects.toThrow("stored-check run");
  });

  test("a product scaffold's merge with no environment is no verdict either", async () => {
    const run = checks().postMergeScaffold(dispatch, "/srv/target", lease as CheckoutLease);
    await expect(run).rejects.toBeInstanceOf(VerificationInfrastructureFault);
    await expect(run).rejects.toThrow("product scaffold build and test");
  });
});
