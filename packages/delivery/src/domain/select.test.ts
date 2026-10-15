import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { TaskSelector } from "./select.js";
import { createPendingWorkItem } from "./work-item.js";

const PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000002", "test");

describe("TaskSelector.selectBatch", () => {
  test("items created at one instant are taken in id order, whatever order they arrive in", () => {
    const at = new Date("2026-10-14T00:00:00Z");
    const items = ["a", "b", "c"].map((title) => ({ ...createPendingWorkItem("Task", title, PROJECT_ID), createdAt: at }));
    const byId = [...items].sort((x, y) => (x.id < y.id ? -1 : 1)).map((item) => item.id);

    expect(TaskSelector.selectBatch(items, 3).map((item) => item.id)).toEqual(byId);
    expect(TaskSelector.selectBatch([...items].reverse(), 3).map((item) => item.id)).toEqual(byId);
  });
});
