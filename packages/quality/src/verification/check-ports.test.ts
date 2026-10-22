import { describe, expect, test } from "vitest";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { notExercised, recordingLogger } from "@ashara/shared/testing";
import type { CheckAuthoring, VerifiedDispatch } from "../dispatch-result.js";
import { CheckRecorder } from "../task-checks.js";
import type { CompletedTaskChecks, TaskChecks } from "../task-checks.js";
import { CheckPorts } from "./check-ports.js";

const dispatch: VerifiedDispatch = {
  task: { id: createWorkItemId(), projectId: parseProjectId("22222222-2222-4222-8222-222222222222", "test"), attempt: 1 },
  targetProjectPath: "/srv/target",
  workDir: "/srv/work",
  repo: { gitDir: "/srv/target/.git/worktrees/w", workTree: "/srv/work" },
  sessionId: "session-1",
  environment: { kind: "base-cell", image: "base", digest: "sha256:0" },
};

function ports(events: Array<Record<string, unknown>> = []): CheckPorts {
  return new CheckPorts({
    dispatchCells: { environmentScope: notExercised("an environment scope"), checkCells: notExercised("a check cell"), checkoutDir: notExercised("a checkout") },
    eventSink: { emit: (event) => void events.push(event) },
    logger: recordingLogger(),
  });
}

describe("CheckPorts", () => {
  test("run_checks' port names the task's own checks and every merged task's, before anything runs", () => {
    const stored: TaskChecks = {
      checkTaskId: "c1",
      revision: 1,
      environmentVersion: "v1",
      baselineCommit: null,
      checks: [{ name: "greets", command: "true", decides: ["G1"] }],
      files: [],
    };
    const merged: CompletedTaskChecks[] = [{ ...stored, taskId: "earlier", checks: [{ name: "lists", command: "true", decides: null }] }];
    const port = ports().taskCheckRunPort(dispatch, stored, merged);
    expect(port.checkNames).toEqual(["greets"]);
    expect(port.mergedChecks).toEqual([{ taskId: "earlier", name: "lists" }]);
  });

  test("define_check's port refuses a check deciding an item the task does not cite, and red-runs nothing", async () => {
    const recorder = new CheckRecorder(["G1"]);
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
      branch: "check/impl-1",
      startCommit: "e".repeat(40),
      recorder,
    };
    const events: Array<Record<string, unknown>> = [];
    const port = ports(events).checkDefinitionPort(dispatch, work);
    const defined = await port.define({ name: "x", command: "true", decides: ["G9"] }, 30);
    expect(defined.kind).toBe("refused");
    expect(events).toEqual([]);
    port.fileWritten("./checks/x.sh");
    expect([...recorder.writtenFiles()]).toEqual(["checks/x.sh"]);
  });
});
