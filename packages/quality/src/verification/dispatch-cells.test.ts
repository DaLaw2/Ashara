import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Cell, CellSpec } from "@ashara/execution-infra";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { EventSubject, VerifiedDispatch } from "../dispatch-result.js";
import { DispatchCells } from "./dispatch-cells.js";

const dispatch: VerifiedDispatch = {
  task: { id: createWorkItemId(), projectId: parseProjectId("22222222-2222-4222-8222-222222222222", "test"), attempt: 3 },
  targetProjectPath: "/srv/target",
  workDir: "/srv/work",
  repo: { gitDir: "/srv/target/.git/worktrees/w", workTree: "/srv/work" },
  sessionId: "session-1",
  environment: { kind: "base-cell", image: "base", digest: "sha256:0" },
};

function cells(created: CellSpec[], tornDown: EventSubject[]): DispatchCells {
  const cell: Pick<Cell, "id"> = { id: "c1" };
  return new DispatchCells({
    config: { workdirBase: "/srv/base" },
    cells: {
      substrate: {
        probeSubstrate: async () => {
          throw new Error("no probe here");
        },
        createCell: async (spec) => {
          created.push(spec);
          return cell as Cell;
        },
      },
      instance: "instance-7",
    },
    attemptPolicy: { perCommandTimeoutSeconds: 42 },
    images: {
      build: async () => {
        throw new Error("no build here");
      },
      prune: async () => ({ removed: [], kept: [] }),
    },
    teardown: { teardownCell: async (subject) => void tornDown.push(subject) },
  });
}

describe("DispatchCells", () => {
  test("a throwaway checkout is named by its purpose, task and session under the checkouts root", () => {
    expect(cells([], []).checkoutDir(dispatch, "red-run")).toBe(join("/srv/base", "checkouts", `red-run-${dispatch.task.id}-session-1`));
  });

  test("a check cell is labelled with the dispatch, mounts its tree shared and is torn down for the attempt", async () => {
    const created: CellSpec[] = [];
    const tornDown: EventSubject[] = [];
    const checkCells = cells(created, tornDown).checkCells(dispatch);
    expect(checkCells.timeoutSeconds).toBe(42);
    expect(checkCells.targetProjectPath).toBe("/srv/target");
    const cell = await checkCells.createCell({ image: "img", role: "ci", hostPath: "/srv/base/checkouts/x" });
    await checkCells.teardownCell(cell);
    expect(created).toEqual([
      { image: "img", project: dispatch.task.projectId, task: dispatch.task.id, role: "ci", instance: "instance-7", mount: { hostPath: "/srv/base/checkouts/x", shared: true } },
    ]);
    expect(tornDown).toEqual([{ taskId: dispatch.task.id, attempt: 3 }]);
  });
});
