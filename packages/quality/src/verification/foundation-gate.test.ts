import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { EnvironmentCheckScope } from "@ashara/execution-infra";
import { ensureTargetGitInit } from "@ashara/execution-infra";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";
import type { CheckAuthoring, VerifiedDispatch } from "../dispatch-result.js";
import { CheckRecorder } from "../task-checks.js";
import { FoundationGate } from "./foundation-gate.js";

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

describe("FoundationGate", () => {
  test("a build that could not run at all blocks the check author: never a pass, and no build verdict is emitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "ashara-foundation-gate-"));
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
    const definition = { containerfile: "environment/Containerfile", recipe: [], inputs: [], probe: "true", build: "true", test: "true" };
    const work: CheckAuthoring = {
      kind: "check-authoring",
      checkedTaskId: "impl-1",
      environment: { version: "v1", commit: "c", imageId: "img", imageRef: "ref", reused: true, statement: "s", definition },
      prior: null,
      // A commit the target does not hold: its checkout cannot be made, so no cell ever starts.
      foundation: { taskId: "scaffold", commit: "f".repeat(40) },
      citedItems: ["G1"],
      branch: "check/impl-1",
      startCommit: "e".repeat(40),
      recorder: new CheckRecorder(["G1"]),
    };
    const scope: EnvironmentCheckScope = {
      projectId: d.task.projectId,
      taskId: d.task.id,
      workDir: d.workDir,
      repo: d.repo,
      targetProjectPath: target,
      checkoutDir: (purpose) => join(root, "checkouts", purpose),
      images: {
        build: async () => {
          throw new Error("no image build here");
        },
        prune: async () => ({ removed: [], kept: [] }),
      },
      createCell: async () => {
        throw new Error("no cell may start");
      },
      teardownCell: async () => {},
    };
    const events: Array<Record<string, unknown>> = [];
    const gate = new FoundationGate({
      dispatchCells: { environmentScope: () => scope },
      attemptPolicy: { perCommandTimeoutSeconds: 30 },
      eventSink: { emit: (event) => void events.push(event) },
      logger: recordingLogger(),
    });
    const result = await gate.foundationBuildGate(d, work);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("environment_blocked");
    expect(events.some((event) => event.event === "foundation_build")).toBe(false);
  });
});
