import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { TaskSelector } from "./select.js";
import { createPendingWorkItem } from "./work-item.js";

const PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000002", "test");

/** Every task TaskSelector.next hands out in turn, each taken before the next is asked for. */
function inTurn(items: Parameters<typeof TaskSelector.next>[0], unlockWeights?: Map<string, number>): string[] {
  const taken = new Set<string>();
  for (let item = TaskSelector.next(items, taken, unlockWeights); item !== null; item = TaskSelector.next(items, taken, unlockWeights)) {
    taken.add(item.id);
  }
  return [...taken];
}

describe("TaskSelector.next", () => {
  test("items created at one instant are taken in id order, whatever order they arrive in", () => {
    const at = new Date("2026-10-14T00:00:00Z");
    const items = ["a", "b", "c"].map((title) => ({ ...createPendingWorkItem({ level: "Task", title, projectId: PROJECT_ID }), createdAt: at }));
    const byId = [...items].sort((x, y) => (x.id < y.id ? -1 : 1)).map((item) => item.id);

    expect(inTurn(items)).toEqual(byId);
    expect(inTurn([...items].reverse())).toEqual(byId);
  });

  test("the task that unlocks the most goes first, and a taken task is never handed out again", () => {
    const at = new Date("2026-10-14T00:00:00Z");
    const [a, b] = ["a", "b"].map((title) => ({ ...createPendingWorkItem({ level: "Task", title, projectId: PROJECT_ID }), createdAt: at }));
    const weights = new Map([[b.id, 3]]);

    expect(TaskSelector.next([a, b], new Set(), weights)?.id).toBe(b.id);
    expect(TaskSelector.next([a, b], new Set([b.id]), weights)?.id).toBe(a.id);
    expect(TaskSelector.next([a, b], new Set([a.id, b.id]), weights)).toBeNull();
  });
});
